// Workbench Expansion §D4 — project / session template store.
//
// Single-tab analogue of clusterPresets.ts. Layout: ~/.arco/templates.json —
// a flat array of WorkflowTemplate, each a snapshot of a creator's config plus
// optional seedPrompt + plan body. Atomic write (tmp + rename) mirrors
// clusterPresets.ts / planStore.ts; the file is small (cap 50) so we
// read+rewrite whole.
//
// Validation mirrors clusterPresets: name trimmed / ≤64 / unique
// case-insensitive, id = crypto.randomUUID(), createdAt ISO. The persisted
// `config.primaryModel` is NOT validated against the catalog here — that
// happens at APPLY time on the client (mirrors cluster-preset apply), so a
// recipe survives a model rename and fails loud only on instantiate.
//
// normalizeConfig drops unknown keys so the on-disk shape stays predictable
// (same discipline as clusterPresets.normalizeMember).

import { promises as fs } from 'fs';
import path from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import type {
  EffortLevel,
  ModelName,
  ProviderName,
  WorkflowTemplate,
  WorkflowTemplateConfig,
} from '@arco/shared';
import { atomicWriteFile } from '../atomicFile.js';
import { arcoHome } from '../arcoHome.js';

const NAME_MAX = 64;
const MAX_TEMPLATES = 50;
const SEED_PROMPT_MAX = 16384;
const PLAN_MAX = 32768; // matches the cluster-plan body cap
const PROVIDER_ACCOUNT_MAX = 200;

function templatesPath(): string {
  return path.join(arcoHome(), 'templates.json');
}

interface TemplatesFile {
  version: 1;
  templates: WorkflowTemplate[];
}

async function readFileSafe(): Promise<TemplatesFile> {
  try {
    const raw = await fs.readFile(templatesPath(), 'utf8');
    const parsed = JSON.parse(raw) as TemplatesFile;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.templates)) {
      return { version: 1, templates: [] };
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, templates: [] };
    }
    throw err;
  }
}

async function writeFileAtomic(file: TemplatesFile): Promise<void> {
  await atomicWriteFile(templatesPath(), JSON.stringify(file, null, 2) + '\n');
}

// Sort newest-first for the API surface.
function sorted(list: WorkflowTemplate[]): WorkflowTemplate[] {
  return [...list].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

export async function listTemplates(): Promise<WorkflowTemplate[]> {
  const { templates } = await readFileSafe();
  return sorted(templates);
}

export interface TemplateSaveInput {
  name: string;
  config: unknown;
  seedPrompt?: string;
  plan?: string;
}

export class TemplateValidationError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const PROVIDERS: ReadonlySet<ProviderName> = new Set([
  'claude', 'gemini', 'ollama', 'codex',  'llamacpp', 'lmstudio', 'strata', 'deepseek',
]);
const EFFORTS: ReadonlySet<EffortLevel> = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

// Whitelist + normalize the config snapshot. Drops unknown keys so the on-disk
// shape stays predictable. `name` / `kind` / the transient resume+spawn fields
// are intentionally never persisted (see WorkflowTemplateConfig). Model is kept
// verbatim — catalog validation is deferred to apply time.
function normalizeConfig(raw: unknown): WorkflowTemplateConfig {
  if (!raw || typeof raw !== 'object') {
    throw new TemplateValidationError(400, 'config must be an object');
  }
  const r = raw as Record<string, unknown>;

  const model = typeof r.primaryModel === 'string' ? r.primaryModel.trim() : '';
  if (!model) throw new TemplateValidationError(400, 'config.primaryModel must be a non-empty string');

  const effort = r.primaryEffort;
  if (typeof effort !== 'string' || !EFFORTS.has(effort as EffortLevel)) {
    throw new TemplateValidationError(400, `config.primaryEffort must be one of ${[...EFFORTS].join('/')}`);
  }

  if (typeof r.skipPermissions !== 'boolean') {
    throw new TemplateValidationError(400, 'config.skipPermissions must be a boolean');
  }

  const out: WorkflowTemplateConfig = {
    primaryModel: model as ModelName,
    primaryEffort: effort as EffortLevel,
    skipPermissions: r.skipPermissions,
  };

  if (r.primaryProvider !== undefined) {
    if (typeof r.primaryProvider !== 'string' || !PROVIDERS.has(r.primaryProvider as ProviderName)) {
      throw new TemplateValidationError(400, `config.primaryProvider must be one of ${[...PROVIDERS].join('/')}`);
    }
    out.primaryProvider = r.primaryProvider as ProviderName;
  }

  // cwd is optional (portable vs project-pinned recipe — §D4 decision 1).
  if (typeof r.workingDirectory === 'string' && r.workingDirectory.trim().length > 0) {
    out.workingDirectory = r.workingDirectory.trim();
  }

  if (typeof r.providerAccountRef === 'string' && r.providerAccountRef.trim().length > 0) {
    const ref = r.providerAccountRef.trim();
    if (ref.length > PROVIDER_ACCOUNT_MAX) {
      throw new TemplateValidationError(400, `config.providerAccountRef exceeds ${PROVIDER_ACCOUNT_MAX} chars`);
    }
    out.providerAccountRef = ref;
  }

  if (r.fastMode === true) out.fastMode = true;

  if (r.efficiencyToolFilter === 'off' || r.efficiencyToolFilter === 'conservative' || r.efficiencyToolFilter === 'aggressive') {
    out.efficiencyToolFilter = r.efficiencyToolFilter;
  }
  if (r.outputStyle === 'normal' || r.outputStyle === 'lite' || r.outputStyle === 'terse') {
    out.outputStyle = r.outputStyle;
  }
  if (r.codexTransport === 'exec' || r.codexTransport === 'appserver') out.codexTransport = r.codexTransport;
  if (r.claudeTransport === 'cli' || r.claudeTransport === 'native') out.claudeTransport = r.claudeTransport;

  if (Array.isArray(r.allowedProviders)) {
    const allowed = r.allowedProviders.filter(
      (p): p is ProviderName => typeof p === 'string' && PROVIDERS.has(p as ProviderName),
    );
    if (allowed.length > 0) out.allowedProviders = allowed;
  }

  return out;
}

export async function saveTemplate(input: TemplateSaveInput): Promise<WorkflowTemplate> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) throw new TemplateValidationError(400, 'name must be non-empty after trim');
  if (name.length > NAME_MAX) throw new TemplateValidationError(400, `name exceeds ${NAME_MAX} chars`);

  const config = normalizeConfig(input.config);

  let seedPrompt: string | undefined;
  if (input.seedPrompt !== undefined) {
    if (typeof input.seedPrompt !== 'string') {
      throw new TemplateValidationError(400, 'seedPrompt must be a string');
    }
    const trimmed = input.seedPrompt.trim();
    if (trimmed.length > SEED_PROMPT_MAX) {
      throw new TemplateValidationError(400, `seedPrompt exceeds ${SEED_PROMPT_MAX} chars`);
    }
    if (trimmed.length > 0) seedPrompt = trimmed;
  }

  let plan: string | undefined;
  if (input.plan !== undefined) {
    if (typeof input.plan !== 'string') {
      throw new TemplateValidationError(400, 'plan must be a string');
    }
    if (input.plan.length > PLAN_MAX) {
      throw new TemplateValidationError(400, `plan exceeds ${PLAN_MAX} chars`);
    }
    if (input.plan.trim().length > 0) plan = input.plan;
  }

  const file = await readFileSafe();

  // Case-insensitive duplicate-name fence (mirrors clusterPresets).
  const lower = name.toLowerCase();
  if (file.templates.some((t) => t.name.trim().toLowerCase() === lower)) {
    throw new TemplateValidationError(409, `template named "${name}" already exists`);
  }
  if (file.templates.length >= MAX_TEMPLATES) {
    throw new TemplateValidationError(400, `template count exceeds cap of ${MAX_TEMPLATES}`);
  }

  const template: WorkflowTemplate = {
    id: randomUUID(),
    name,
    createdAt: new Date().toISOString(),
    config,
    ...(seedPrompt ? { seedPrompt } : {}),
    ...(plan ? { plan } : {}),
  };
  file.templates.push(template);
  await writeFileAtomic(file);
  return template;
}

// Returns true if a template was found and removed; false when no match.
export async function deleteTemplate(id: string): Promise<boolean> {
  if (!id || typeof id !== 'string') return false;
  const file = await readFileSafe();
  const before = file.templates.length;
  file.templates = file.templates.filter((t) => t.id !== id);
  if (file.templates.length === before) return false;
  await writeFileAtomic(file);
  return true;
}
