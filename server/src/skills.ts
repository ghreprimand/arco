// Archon-managed operator skills. Distinct from `toolbox.ts`, which scans the
// Claude CLI's plugin/user skill caches for the toolbox-menu chips. These
// skills live under `<cwd>/.archon/skills/` (project) and `~/.archon/skills/`
// (global) and are injected into every primary turn's system prompt as an
// XML manifest — name + description only — so the agent learns *what*
// skills exist. The full SKILL.md body is read on demand via the Read tool
// (Pi's progressive-disclosure model).
//
// Frontmatter shape:
//   ---
//   name: <operator-facing name>
//   description: <one-line>
//   ---
//   <body>
//
// Each skill lives in its own directory: <root>/<slug>/SKILL.md. The slug
// is the directory name and is the stable identifier across edits — name
// can change without renaming the directory.

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { homedir } from 'os';
import path from 'path';

import { canonicalSkillKey, readSkillUsage } from './skillUsage.js';
import { archonHome } from './archonHome.js';

export type SkillScope = 'project' | 'global';
export interface SkillRef { scope: SkillScope; slug: string }

// Persistent pins are intentionally bounded. Eight full 64 KiB skills would
// be pathological prompt bloat, so the aggregate block has its own tighter
// cap while still leaving ample room for normal playbooks.
export const MAX_PINNED_SKILLS = 12;
export const MAX_PINNED_SKILLS_BYTES = 64 * 1024;

export interface SkillSummary {
  slug: string;
  name: string;
  description: string;
  scope: SkillScope;
  // Absolute path to the SKILL.md — given to the agent in the manifest so
  // it can Read the full body on demand. Also returned to the client so
  // the editor / delete flow can address skills unambiguously.
  path: string;
  // §5.2 — read-only usage telemetry from the skill-usage sidecar (attached in
  // listSkills, never injected into the model manifest). Absent ⇒ never used.
  useCount?: number;
  lastUsed?: number;
  // DD8 — `operator-only: true` frontmatter. Such a skill is OMITTED from the
  // model-facing manifest (the model is never told it exists, removing model
  // authority over it) but is still listed in the UI and pickable by the
  // operator, who inlines its full body into a turn (no Read round-trip).
  operatorOnly?: boolean;
}

export interface SkillFull extends SkillSummary {
  body: string;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NAME_MAX = 80;
const DESCRIPTION_MAX = 240;
const BODY_MAX = 64 * 1024;

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

function projectSkillsRoot(cwd: string): string {
  return path.join(cwd, '.archon', 'skills');
}

function globalSkillsRoot(): string {
  return path.join(archonHome(), 'skills');
}

function rootForScope(scope: SkillScope, cwd: string): string {
  if (scope === 'global') return globalSkillsRoot();
  if (!cwd) throw new Error('project scope requires cwd');
  return projectSkillsRoot(cwd);
}

// Slug derived from a free-form name. Lowercase, ASCII-only, dashes, capped
// at 64. Empty result falls back to `skill`. Caller is expected to dedupe
// against existing slugs in the same scope.
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return base || 'skill';
}

// Resolve the SKILL.md path for a (scope, slug) pair and verify the
// resolved path stays under the scope's root. Caller passes a known-valid
// slug; the resolve step is the second line of defence against weird
// platform path quirks.
function skillFilePath(scope: SkillScope, slug: string, cwd: string): string {
  if (!isValidSlug(slug)) throw new Error(`invalid skill slug: ${slug}`);
  const root = rootForScope(scope, cwd);
  const candidate = path.resolve(root, slug, 'SKILL.md');
  const rootResolved = path.resolve(root);
  if (!candidate.startsWith(rootResolved + path.sep)) {
    throw new Error('skill path escapes scope root');
  }
  return candidate;
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  body: string;
  operatorOnly?: boolean;
}

function parseSkillFile(text: string): ParsedFrontmatter {
  if (!text.startsWith('---')) return { body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { body: text };
  const block = text.slice(3, end);
  const out: Record<string, string> = {};
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  // Skip the closing `---` and any blank lines between it and the body —
  // renderSkillFile inserts one for readability. Without this strip the
  // leading newline would re-accumulate across edit cycles.
  const afterClose = text.indexOf('\n', end + 1);
  const raw = afterClose === -1 ? '' : text.slice(afterClose + 1);
  const body = raw.replace(/^\n+/, '');
  // DD8 — `operator-only: true` (case-insensitive value). Any other value, or
  // the key's absence, leaves operatorOnly undefined (model-visible default).
  const ooRaw = (out['operator-only'] ?? '').trim().toLowerCase();
  const operatorOnly = ooRaw === 'true' ? true : undefined;
  return { name: out.name, description: out.description, body, operatorOnly };
}

function escapeYamlValue(value: string): string {
  // Quote the value and escape backslashes + double-quotes. Keeps the
  // manifest deterministic and avoids accidental YAML structural chars.
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function renderSkillFile(name: string, description: string, body: string, operatorOnly?: boolean): string {
  // DD8 — persist the operator-only flag so editing a skill via the UI doesn't
  // silently strip it. Only written when true (absence == model-visible default).
  const ooLine = operatorOnly ? 'operator-only: true\n' : '';
  const fm = `---\nname: ${escapeYamlValue(name)}\ndescription: ${escapeYamlValue(description)}\n${ooLine}---\n`;
  // Keep a single blank line between frontmatter and body for readability.
  const trimmed = body.startsWith('\n') ? body.slice(1) : body;
  return `${fm}\n${trimmed}`;
}

async function scanScope(scope: SkillScope, cwd: string): Promise<SkillSummary[]> {
  let root: string;
  try {
    root = rootForScope(scope, cwd);
  } catch {
    return [];
  }
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const results: SkillSummary[] = [];
  for (const slug of entries) {
    if (!isValidSlug(slug)) continue;
    const dir = path.join(root, slug);
    try {
      const st = await stat(dir);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    const skillPath = path.join(dir, 'SKILL.md');
    let text: string;
    try {
      text = await readFile(skillPath, 'utf8');
    } catch {
      continue; // no SKILL.md (or unreadable) — skipped per the plan
    }
    const parsed = parseSkillFile(text);
    if (!parsed.name) continue; // missing frontmatter — skipped per the plan
    results.push({
      slug,
      name: parsed.name,
      description: parsed.description ?? '',
      scope,
      path: skillPath,
      ...(parsed.operatorOnly ? { operatorOnly: true } : {}),
    });
  }
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

// Catalog used by both the manifest injection and the Settings UI list.
// Project skills come first (matching the operator's mental model — local
// before global); global skills are returned as a separate group so the UI
// can render them under a `(global)` header without re-scanning.
export async function listSkills(
  cwd: string,
  opts?: { includeProject?: boolean },
): Promise<{
  project: SkillSummary[];
  global: SkillSummary[];
}> {
  // DD7 — an untrusted repo's project skills are suppressed from the turn (a
  // cloned repo could ship a SKILL.md the model would otherwise be told to read).
  // Global skills (~/.archon/skills) are the operator's own — never gated.
  const includeProject = opts?.includeProject !== false;
  const [project, global, usage] = await Promise.all([
    includeProject ? scanScope('project', cwd) : Promise.resolve([] as SkillSummary[]),
    scanScope('global', cwd),
    readSkillUsage(),
  ]);
  // §5.2 — attach usage telemetry by canonical SKILL.md path. Diagnostic-only;
  // never folded into the model manifest (buildSkillsManifest ignores it).
  const attach = (s: SkillSummary): SkillSummary => {
    const u = usage[canonicalSkillKey(s.path)];
    return u ? { ...s, useCount: u.count, lastUsed: u.lastUsed } : s;
  };
  return { project: project.map(attach), global: global.map(attach) };
}

export async function readSkillBody(
  scope: SkillScope,
  slug: string,
  cwd: string,
): Promise<SkillFull | null> {
  const filePath = skillFilePath(scope, slug, cwd);
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = parseSkillFile(text);
  if (!parsed.name) return null;
  return {
    slug,
    name: parsed.name,
    description: parsed.description ?? '',
    scope,
    path: filePath,
    body: parsed.body,
    ...(parsed.operatorOnly ? { operatorOnly: true } : {}),
  };
}

export interface WriteSkillInput {
  scope: SkillScope;
  // Required on update; ignored on create (server slugifies name and dedupes).
  slug?: string;
  name: string;
  description: string;
  body: string;
  // DD8 — when true, write `operator-only: true` into the frontmatter.
  operatorOnly?: boolean;
}

export async function writeSkill(
  input: WriteSkillInput,
  cwd: string,
): Promise<SkillSummary> {
  const name = (input.name ?? '').trim();
  if (!name) throw new Error('name required');
  if (name.length > NAME_MAX) throw new Error(`name too long (>${NAME_MAX})`);
  const description = (input.description ?? '').trim();
  if (description.length > DESCRIPTION_MAX) {
    throw new Error(`description too long (>${DESCRIPTION_MAX})`);
  }
  const body = input.body ?? '';
  if (body.length > BODY_MAX) throw new Error(`body too long (>${BODY_MAX})`);

  let slug = input.slug;
  if (slug !== undefined && !isValidSlug(slug)) {
    throw new Error(`invalid skill slug: ${slug}`);
  }
  if (!slug) {
    // Create — derive a fresh unique slug from the name.
    const base = slugify(name);
    let candidate = base;
    let n = 2;
    const root = rootForScope(input.scope, cwd);
    // Loop until we find a free directory name. Bounded — slug pool is
    // effectively unlimited and disk lookups are cheap.
    while (true) {
      try {
        await stat(path.join(root, candidate));
        candidate = `${base}-${n++}`;
      } catch {
        break;
      }
    }
    slug = candidate;
  }

  const filePath = skillFilePath(input.scope, slug, cwd);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, renderSkillFile(name, description, body, input.operatorOnly), 'utf8');
  return {
    slug,
    name,
    description,
    scope: input.scope,
    path: filePath,
    ...(input.operatorOnly ? { operatorOnly: true } : {}),
  };
}

export async function deleteSkill(
  scope: SkillScope,
  slug: string,
  cwd: string,
): Promise<boolean> {
  const filePath = skillFilePath(scope, slug, cwd);
  const dir = path.dirname(filePath);
  try {
    await rm(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

// Manifest text injected into the primary's system prompt. Only name +
// description go into the prompt; the agent reads the full SKILL.md via
// its Read tool when it picks a skill. Static-shaped so prefix caches
// keep hitting across turns; content varies by skill set, which would
// invalidate any cache that already crossed the manifest boundary, but
// the manifest sits at the top of the system prompt where invalidation
// is rare in practice.
export function buildSkillsManifest(
  catalog: { project: SkillSummary[]; global: SkillSummary[] },
): string {
  // DD8 — operator-only skills are withheld from the model manifest entirely.
  // The model is never told they exist; the operator inlines them on pick.
  const all = [...catalog.project, ...catalog.global].filter((s) => !s.operatorOnly);
  if (all.length === 0) return '';
  const lines: string[] = [];
  lines.push('You have access to operator-defined skills — short reusable playbooks for recurring tasks. Each entry below lists a skill\'s name, scope, and a one-line description. To apply a skill, use your Read tool on its `path` attribute to load the full SKILL.md, then follow it.');
  lines.push('');
  lines.push('<archon-skills>');
  for (const s of all) {
    const desc = s.description.replace(/[\r\n]+/g, ' ').trim();
    const escapedDesc = desc.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const escapedName = s.name.replace(/"/g, '&quot;');
    const escapedPath = s.path.replace(/"/g, '&quot;');
    lines.push(`  <skill name="${escapedName}" scope="${s.scope}" path="${escapedPath}">${escapedDesc}</skill>`);
  }
  lines.push('</archon-skills>');
  return lines.join('\n');
}

// DD8 — build the inline block for operator-picked skills. Unlike the manifest
// (name + description only, model reads the body on demand), a picked skill has
// its FULL body inlined directly into the turn prompt — no Read round-trip, and
// it works for operator-only skills the model was never told exist. Returns the
// block text plus its byte size so the caller can log the delta (fence: visible
// cost). Empty input ⇒ empty string (caller skips).
export function buildPickedSkillsBlock(
  skills: Array<{ name: string; scope: SkillScope; body: string }>,
): { text: string; bytes: number } {
  if (skills.length === 0) return { text: '', bytes: 0 };
  const lines: string[] = [];
  lines.push('The operator attached the following skill(s) to this turn — apply them directly. The full playbook body is inlined below; you do not need to Read anything.');
  lines.push('');
  for (const s of skills) {
    const escapedName = s.name.replace(/"/g, '&quot;');
    lines.push(`<archon-skill name="${escapedName}" scope="${s.scope}">`);
    lines.push(s.body.trim());
    lines.push('</archon-skill>');
    lines.push('');
  }
  const text = lines.join('\n').trimEnd();
  return { text, bytes: Buffer.byteLength(text, 'utf8') };
}

export interface ResolvedPinnedSkills {
  skills: Array<{ slug: string; name: string; scope: SkillScope; body: string }>;
  missing: string[];
  truncated: string[];
}

// Resolve a complete replacement set for a tab pin. De-dupes stable refs,
// skips malformed / missing entries, and caps the aggregate body size before
// it can become standing per-turn prompt bloat. Project pins are an explicit
// operator action, so callers intentionally do not apply the project-trust
// discovery gate (same rule as one-shot +SKILL picks).
export async function resolvePinnedSkills(
  refs: SkillRef[],
  cwd: string,
): Promise<ResolvedPinnedSkills> {
  const skills: ResolvedPinnedSkills['skills'] = [];
  const missing: string[] = [];
  const truncated: string[] = [];
  const seen = new Set<string>();
  let bodyBytes = 0;

  for (const ref of refs.slice(0, MAX_PINNED_SKILLS)) {
    if ((ref.scope !== 'project' && ref.scope !== 'global') || !isValidSlug(ref.slug)) {
      missing.push(`${String(ref.scope)}:${String(ref.slug)}`);
      continue;
    }
    const key = `${ref.scope}:${ref.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let full: SkillFull | null = null;
    try {
      full = await readSkillBody(ref.scope, ref.slug, cwd);
    } catch {
      // Treat unreadable exactly like missing; pinning remains fail-safe and
      // the persisted acknowledgement tells the operator what was skipped.
    }
    if (!full) {
      missing.push(key);
      continue;
    }
    const bytes = Buffer.byteLength(full.body, 'utf8');
    if (bodyBytes + bytes > MAX_PINNED_SKILLS_BYTES) {
      truncated.push(key);
      continue;
    }
    bodyBytes += bytes;
    skills.push({ slug: full.slug, name: full.name, scope: full.scope, body: full.body });
  }
  for (const ref of refs.slice(MAX_PINNED_SKILLS)) {
    truncated.push(`${String(ref.scope)}:${String(ref.slug)}`);
  }
  return { skills, missing, truncated };
}

// Standing variant of the one-shot block. This lives in the system-prompt
// path and is rebuilt every turn; the explicit wording prevents the agent
// from treating a pin as a single-task suggestion after compaction.
export function buildPinnedSkillsBlock(
  skills: Array<{ name: string; scope: SkillScope; body: string }>,
): { text: string; bytes: number } {
  if (skills.length === 0) return { text: '', bytes: 0 };
  const lines: string[] = [
    'The operator pinned the following standing skill(s) to this workflow. Apply them on every turn until the operator removes the pin. When a pinned playbook conflicts with the operator\'s current explicit request, follow the current request and call out the conflict.',
    '',
  ];
  for (const skill of skills) {
    const escapedName = skill.name.replace(/"/g, '&quot;');
    lines.push(`<archon-pinned-skill name="${escapedName}" scope="${skill.scope}">`);
    lines.push(skill.body.trim());
    lines.push('</archon-pinned-skill>', '');
  }
  const text = lines.join('\n').trimEnd();
  return { text, bytes: Buffer.byteLength(text, 'utf8') };
}
