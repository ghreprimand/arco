// Cluster presets — operator-saved cluster member templates.
//
// Layout: ~/.archon/cluster-presets.json — flat array of presets, each a
// snapshot of the per-member configs + optional cluster-name template. Cwd is
// intentionally NOT persisted (presets are project-agnostic by design;
// operators apply the same shape to whatever working directory they pick).
//
// Atomic write pattern mirrors planStore.ts (tmp + rename). File is small
// (cap 50 presets × ~20 members × small JSON) so we read+rewrite whole.

import { promises as fs } from 'fs';
import path from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import type { ClusterMemberProvider, ClusterPreset, ClusterPresetMember, MemberTier } from '@archon/shared';
import { MEMBER_TIERS, MEMBER_FOCUS_MAX, isClusterMemberAccessMode } from '@archon/shared';
import { atomicWriteFile } from './atomicFile.js';
import { archonHome } from './archonHome.js';

const NAME_MAX = 64;
const MAX_PRESETS = 50;
const MEMBER_MAX = 32;        // matches the cluster fence on member count
const CLUSTER_NAME_MAX = 64;  // matches ClusterCreateFromScratch's name cap
const ROLE_MAX = 120;
const DISPLAY_NAME_MAX = 80;

function presetsPath(): string {
  return path.join(archonHome(), 'cluster-presets.json');
}

interface PresetsFile {
  version: 1;
  presets: ClusterPreset[];
}

async function readFileSafe(): Promise<PresetsFile> {
  try {
    const raw = await fs.readFile(presetsPath(), 'utf8');
    const parsed = JSON.parse(raw) as PresetsFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.presets)) {
      return { version: 1, presets: [] };
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, presets: [] };
    }
    throw err;
  }
}

async function writeFileAtomic(file: PresetsFile): Promise<void> {
  await atomicWriteFile(presetsPath(), JSON.stringify(file, null, 2) + '\n');
}

// Sort newest-first for the API surface. Mutates input — callers pass copies.
function sorted(list: ClusterPreset[]): ClusterPreset[] {
  return [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export async function listPresets(): Promise<ClusterPreset[]> {
  const { presets } = await readFileSafe();
  return sorted(presets);
}

export interface PresetSaveInput {
  name: string;
  clusterNameTemplate?: string;
  members: ClusterPresetMember[];
}

export class PresetValidationError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function isMemberTier(v: unknown): v is MemberTier {
  return typeof v === 'string' && (MEMBER_TIERS as readonly string[]).includes(v);
}

function isClusterMemberProvider(v: unknown): v is ClusterMemberProvider {
  return v === 'claude' || v === 'codex' || v === 'ollama' || v === 'llamacpp' || v === 'cursor';
}

// Validate + normalize a single member entry. Throws on hard reject; returns
// a clean object with only the fields we want to persist (drops unknown keys
// so the on-disk shape stays predictable).
function normalizeMember(raw: unknown, idx: number): ClusterPresetMember {
  if (!raw || typeof raw !== 'object') {
    throw new PresetValidationError(400, `members[${idx}] must be an object`);
  }
  const r = raw as Record<string, unknown>;
  const provider = r.provider;
  if (!isClusterMemberProvider(provider)) {
    throw new PresetValidationError(400, `members[${idx}].provider must be claude/codex/ollama/llamacpp/cursor`);
  }
  const model = typeof r.model === 'string' ? r.model.trim() : '';
  if (!model) {
    throw new PresetValidationError(400, `members[${idx}].model must be a non-empty string`);
  }
  const out: ClusterPresetMember = { provider, model };
  if (typeof r.effort === 'string' && r.effort.trim().length > 0) out.effort = r.effort.trim();
  if (provider === 'codex' && typeof r.providerAccountRef === 'string' && r.providerAccountRef.trim().length > 0) {
    out.providerAccountRef = r.providerAccountRef.trim();
  }
  if (typeof r.role === 'string') {
    const role = r.role.trim();
    if (role.length > ROLE_MAX) {
      throw new PresetValidationError(400, `members[${idx}].role exceeds ${ROLE_MAX} chars`);
    }
    if (role.length > 0) out.role = role;
  }
  if (r.tier !== undefined && r.tier !== null && r.tier !== '') {
    if (!isMemberTier(r.tier)) {
      throw new PresetValidationError(400, `members[${idx}].tier must be one of ${MEMBER_TIERS.join('/')}`);
    }
    out.tier = r.tier;
  }
  if (typeof r.focus === 'string') {
    const focus = r.focus.trim();
    if (focus.length > MEMBER_FOCUS_MAX) {
      throw new PresetValidationError(400, `members[${idx}].focus exceeds ${MEMBER_FOCUS_MAX} chars`);
    }
    if (focus.length > 0) out.focus = focus;
  }
  if (typeof r.displayName === 'string') {
    const dn = r.displayName.trim();
    if (dn.length > DISPLAY_NAME_MAX) {
      throw new PresetValidationError(400, `members[${idx}].displayName exceeds ${DISPLAY_NAME_MAX} chars`);
    }
    if (dn.length > 0) out.displayName = dn;
  }
  if (typeof r.skipPermissions === 'boolean') out.skipPermissions = r.skipPermissions;
  if (r.fastMode === true) out.fastMode = true;
  if (r.efficiencyToolFilter === 'conservative' || r.efficiencyToolFilter === 'aggressive' || r.efficiencyToolFilter === 'off') {
    out.efficiencyToolFilter = r.efficiencyToolFilter;
  }
  if (r.outputStyle === 'lite' || r.outputStyle === 'terse' || r.outputStyle === 'normal') {
    out.outputStyle = r.outputStyle;
  }
  if (r.accessMode !== undefined) {
    if (!isClusterMemberAccessMode(r.accessMode)) {
      throw new PresetValidationError(400, `members[${idx}].accessMode must be standard/blind/isolated`);
    }
    if (r.accessMode === 'isolated' && provider !== 'claude') {
      throw new PresetValidationError(400, `members[${idx}].accessMode isolated requires provider claude`);
    }
    if (r.accessMode !== 'standard') out.accessMode = r.accessMode;
  }
  return out;
}

export async function savePreset(input: PresetSaveInput): Promise<ClusterPreset> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new PresetValidationError(400, 'name must be non-empty after trim');
  if (name.length > NAME_MAX) throw new PresetValidationError(400, `name exceeds ${NAME_MAX} chars`);

  const tmpl = typeof input.clusterNameTemplate === 'string' ? input.clusterNameTemplate.trim() : '';
  if (tmpl.length > CLUSTER_NAME_MAX) {
    throw new PresetValidationError(400, `clusterNameTemplate exceeds ${CLUSTER_NAME_MAX} chars`);
  }

  if (!Array.isArray(input.members)) {
    throw new PresetValidationError(400, 'members must be an array');
  }
  if (input.members.length < 2) {
    throw new PresetValidationError(400, 'members must contain at least 2 entries');
  }
  if (input.members.length > MEMBER_MAX) {
    throw new PresetValidationError(400, `members exceeds ${MEMBER_MAX} entries`);
  }
  const normalized: ClusterPresetMember[] = input.members.map((m, i) => normalizeMember(m, i));

  const file = await readFileSafe();

  // Case-insensitive duplicate-name fence. Lowercase compare on trimmed name.
  const lower = name.toLowerCase();
  if (file.presets.some((p) => p.name.trim().toLowerCase() === lower)) {
    throw new PresetValidationError(409, `preset named "${name}" already exists`);
  }

  if (file.presets.length >= MAX_PRESETS) {
    throw new PresetValidationError(400, `preset count exceeds cap of ${MAX_PRESETS}`);
  }

  const preset: ClusterPreset = {
    id: randomUUID(),
    name,
    createdAt: new Date().toISOString(),
    ...(tmpl ? { clusterNameTemplate: tmpl } : {}),
    members: normalized,
  };
  file.presets.push(preset);
  await writeFileAtomic(file);
  return preset;
}

// Returns true if a preset was found and removed; false when no match.
export async function deletePreset(id: string): Promise<boolean> {
  if (!id || typeof id !== 'string') return false;
  const file = await readFileSafe();
  const before = file.presets.length;
  file.presets = file.presets.filter((p) => p.id !== id);
  if (file.presets.length === before) return false;
  await writeFileAtomic(file);
  return true;
}
