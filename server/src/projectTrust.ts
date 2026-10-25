// DD7 — project-trust gate. Closes the cloned-repo prompt-injection vector:
// a repo you clone and open in Archon ships a `CLAUDE.md`, project skills, and
// `.archon/settings.json` that Archon would otherwise fold into the model's
// system prompt UNREAD by the operator. A hostile repo can therefore inject
// instructions into your agent the moment you point a tab at it. This module
// gates those three project-local surfaces behind an explicit trust decision.
//
// Posture (matches the cluster idle-nudger / efficiency-level discipline):
//   • Operator-initiated  — the operator grants trust via a one-time prompt; the
//                           gate NEVER auto-trusts a repo.
//   • Deterministic       — a pure `decideTrust()` over a flat trust.json the
//                           operator can read; nearest-ancestor wins.
//   • Visible             — the gate logs its decision + the suppressed-resource
//                           list to events.jsonl (caller's system_notice).
//   • Reversible          — a recorded decision is a single line in trust.json
//                           the operator can flip or delete by hand.
//
// Two-pass bootstrap: trust is resolved from USER/GLOBAL scope only (trust.json
// + the global settings.json's `defaultProjectTrust`) BEFORE any project-local
// surface is read, so a cloned repo cannot self-grant trust by shipping a
// settings.json that sets defaultProjectTrust='always'.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

import { readSettings } from './settings.js';
import { isValidSlug } from './skills.js';
import { atomicWriteFile, withFileLock } from './atomicFile.js';

const TRUST_FILE = path.join(homedir(), '.archon', 'trust.json');

export type TrustDecision = 'always' | 'never';
export type TrustStatus = TrustDecision | 'ask';
export type DefaultProjectTrust = 'ask' | 'always' | 'never';

export interface TrustEntry {
  decision: TrustDecision;
  at: number;
}

// On-disk shape. A flat map keyed by canonical absolute path → entry. Versioned
// so a future migration is unambiguous.
export interface TrustFile {
  version: 1;
  entries: Record<string, TrustEntry>;
}

// ── Pure core (unit-tested without fs) ──

// Canonicalize a path for keying / ancestor matching: resolve to absolute and
// strip a trailing separator (so `/a/b` and `/a/b/` collide). We deliberately
// do NOT resolve symlinks here — that needs fs and the operator reads the keys
// as the paths they typed. Callers pass real cwds, which are already absolute.
export function canonicalizePath(p: string): string {
  const resolved = path.resolve(p);
  if (resolved.length > 1 && resolved.endsWith(path.sep)) return resolved.slice(0, -1);
  return resolved;
}

// True if `ancestor` is `cwd` itself or a parent directory of it. Segment-aware
// so `/a/bc` is NOT treated as an ancestor of `/a/bcd`.
export function isAncestorOrSelf(ancestor: string, cwd: string): boolean {
  if (ancestor === cwd) return true;
  const withSep = ancestor.endsWith(path.sep) ? ancestor : ancestor + path.sep;
  return cwd.startsWith(withSep);
}

// Resolve the effective trust for `cwd`: the deepest recorded ancestor wins;
// absent any match, fall back to the user-scope default. Pure — the caller
// supplies the trust map + default. Returns the status AND the matched key (if
// any) so the caller can log attribution.
export function decideTrust(
  entries: Record<string, TrustEntry>,
  cwd: string,
  defaultTrust: DefaultProjectTrust,
): { status: TrustStatus; matchedPath?: string } {
  const target = canonicalizePath(cwd);
  let best: { path: string; entry: TrustEntry } | undefined;
  for (const [key, entry] of Object.entries(entries)) {
    const canon = canonicalizePath(key);
    if (!isAncestorOrSelf(canon, target)) continue;
    // Deepest (longest) ancestor wins — a `never` on a subdir overrides an
    // `always` on its parent and vice versa.
    if (!best || canon.length > canonicalizePath(best.path).length) {
      best = { path: key, entry };
    }
  }
  if (best) return { status: best.entry.decision, matchedPath: best.path };
  return { status: defaultTrust };
}

// ── fs-backed wrappers ──

export async function readTrustFile(): Promise<TrustFile> {
  try {
    const raw = await fs.readFile(TRUST_FILE, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const obj = parsed as { entries?: unknown };
      const entries: Record<string, TrustEntry> = {};
      if (obj.entries && typeof obj.entries === 'object') {
        for (const [k, v] of Object.entries(obj.entries as Record<string, unknown>)) {
          if (!v || typeof v !== 'object') continue;
          const e = v as { decision?: unknown; at?: unknown };
          if (e.decision !== 'always' && e.decision !== 'never') continue;
          entries[k] = { decision: e.decision, at: typeof e.at === 'number' ? e.at : 0 };
        }
      }
      return { version: 1, entries };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[archon] trust.json malformed; treating as empty:', err instanceof Error ? err.message : err);
    }
  }
  return { version: 1, entries: {} };
}

// Record a decision for a cwd (canonicalized key). Atomic write. Returns the
// canonical key actually written so the caller can log it.
export function writeTrustDecision(cwd: string, decision: TrustDecision, now: number): Promise<string> {
  // Serialized: read-modify-write over one shared file. Two operators vouching
  // for different repos concurrently would otherwise race, and the loser's
  // decision would vanish — re-prompting on a repo they already trusted.
  return withFileLock(TRUST_FILE, async () => {
    const file = await readTrustFile();
    const key = canonicalizePath(cwd);
    file.entries[key] = { decision, at: now };
    await atomicWriteFile(TRUST_FILE, JSON.stringify(file, null, 2) + '\n');
    return key;
  });
}

// Drop a recorded decision, returning the canonical key removed (or undefined
// if nothing matched). Re-arms the 'ask' path for that cwd: the operator gets a
// fresh prompt on the next turn instead of having to hand-edit trust.json.
export function removeTrustDecision(cwd: string): Promise<string | undefined> {
  return withFileLock(TRUST_FILE, async () => {
    const file = await readTrustFile();
    const key = canonicalizePath(cwd);
    if (!(key in file.entries)) return undefined;
    delete file.entries[key];
    await atomicWriteFile(TRUST_FILE, JSON.stringify(file, null, 2) + '\n');
    return key;
  });
}

// Read the user-scope default. GLOBAL settings only — `readSettings()` with no
// cwd never touches a project layer, so a cloned repo cannot self-grant.
export async function readDefaultProjectTrust(): Promise<DefaultProjectTrust> {
  try {
    const global = await readSettings();
    const v = global.defaultProjectTrust;
    if (v === 'always' || v === 'never' || v === 'ask') return v;
  } catch {
    /* fall through to the safe default */
  }
  return 'ask';
}

// Does `cwd` actually ship any of the three gated project-local surfaces? If
// not, the gate is a no-op and we NEVER prompt (acceptance: a repo with no
// project resources never prompts). Returns the human-readable list for the
// prompt body / log line.
export async function hasTrustRequiringProjectResources(cwd: string): Promise<string[]> {
  const found: string[] = [];
  // Archon's own CLAUDE.md is repo-root; a cloned repo's is the injection risk.
  try {
    const st = await fs.stat(path.join(cwd, 'CLAUDE.md'));
    if (st.isFile()) found.push('CLAUDE.md');
  } catch { /* absent */ }
  // Project settings layer.
  try {
    const st = await fs.stat(path.join(cwd, '.archon', 'settings.json'));
    if (st.isFile()) found.push('.archon/settings.json');
  } catch { /* absent */ }
  // Project skills — at least one valid-slug subdir with a SKILL.md.
  try {
    const skillsRoot = path.join(cwd, '.archon', 'skills');
    const slugs = await fs.readdir(skillsRoot);
    for (const slug of slugs) {
      if (!isValidSlug(slug)) continue;
      try {
        const st = await fs.stat(path.join(skillsRoot, slug, 'SKILL.md'));
        if (st.isFile()) { found.push('.archon/skills'); break; }
      } catch { /* not a skill dir */ }
    }
  } catch { /* no skills dir */ }
  return found;
}

export interface ProjectTrustGate {
  // Whether the turn may fold project-local CLAUDE.md / skills / settings.
  includeProject: boolean;
  // Raise the operator prompt this turn (only when status is 'ask' AND there
  // are resources to suppress).
  needsPrompt: boolean;
  status: TrustStatus;
  // Suppressed (or, when trusted, would-be-included) project resources.
  resources: string[];
}

// Per-cwd prompt dedup. An 'ask' repo re-evaluates the gate every turn, but we
// only raise ONE prompt per cwd per server lifetime (and one across all cluster
// peers sharing the cwd) so an undecided operator isn't nagged each turn. Cleared
// when a decision is recorded so a later `never`→`always` reconsideration can
// re-prompt if the operator deletes the entry by hand and reopens.
const pendingPrompts = new Set<string>();

export function markPromptPending(cwd: string): boolean {
  const key = canonicalizePath(cwd);
  if (pendingPrompts.has(key)) return false;
  pendingPrompts.add(key);
  return true;
}

export function clearPromptPending(cwd: string): void {
  pendingPrompts.delete(canonicalizePath(cwd));
}

// Resolve the trust DECISION for a cwd, independent of whether it ships any of
// the gateProjectResources surfaces. Side-effect-free (no prompt/notice). Used by
// DD10: a project-scoped `/prompt` command must require an explicit 'always'
// decision — a cloned repo can ship a hostile `.archon/prompts/deploy.md`, and
// the presence of a prompts dir alone is NOT one of the gate's resource triggers,
// so we key on the raw decision here rather than on `includeProject`.
export async function resolveTrustStatus(cwd: string): Promise<TrustStatus> {
  if (!cwd) return 'always';
  const [file, defaultTrust] = await Promise.all([readTrustFile(), readDefaultProjectTrust()]);
  return decideTrust(file.entries, cwd, defaultTrust).status;
}

// The turn-time gate. Resolves trust from user/global scope, detects project
// resources, and returns the include/prompt decision. Two-pass: trust resolution
// reads only trust.json + global settings; project surfaces are read by the
// CALLER afterward, gated on `includeProject`.
export async function gateProjectResources(cwd: string): Promise<ProjectTrustGate> {
  if (!cwd) return { includeProject: true, needsPrompt: false, status: 'always', resources: [] };
  const resources = await hasTrustRequiringProjectResources(cwd);
  // No gated surface ⇒ nothing to suppress, never prompt. (includeProject is
  // moot — the caller's reads return empty regardless — but report `true` so a
  // resource appearing later this session isn't silently blocked without a
  // fresh gate evaluation.)
  if (resources.length === 0) {
    return { includeProject: true, needsPrompt: false, status: 'always', resources: [] };
  }
  const [file, defaultTrust] = await Promise.all([readTrustFile(), readDefaultProjectTrust()]);
  const { status } = decideTrust(file.entries, cwd, defaultTrust);
  if (status === 'always') return { includeProject: true, needsPrompt: false, status, resources };
  if (status === 'never') return { includeProject: false, needsPrompt: false, status, resources };
  // 'ask' — suppress and prompt.
  return { includeProject: false, needsPrompt: true, status, resources };
}

// Managed git worktrees are a second checkout of an operator-opened source
// repository, not a newly discovered project. Discover resources in the
// worktree (the files the attempt will actually execute against), but resolve
// the operator's existing trust decision from the source checkout. No trust
// entry is written or broadened; ask/never remain suppressive.
export async function gateManagedWorktreeResources(
  cwd: string,
  sourceCwd: string,
): Promise<ProjectTrustGate> {
  const resources = await hasTrustRequiringProjectResources(cwd);
  if (resources.length === 0) {
    return { includeProject: true, needsPrompt: false, status: 'always', resources: [] };
  }
  const [file, defaultTrust] = await Promise.all([readTrustFile(), readDefaultProjectTrust()]);
  const { status } = decideTrust(file.entries, sourceCwd, defaultTrust);
  if (status === 'always') return { includeProject: true, needsPrompt: false, status, resources };
  if (status === 'never') return { includeProject: false, needsPrompt: false, status, resources };
  return { includeProject: false, needsPrompt: true, status, resources };
}
