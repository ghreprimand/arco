// Server-side expansion for the composer's `@`-context-refs
// (WORKBENCH_EXPANSION_PLAN.md §D1). The client parses `@file:`, `@diff`,
// `@staged`, `@git:N`, `@url:` into chips; at send time the server expands
// each ref into the turn's context.
//
// SEAM: expansion runs once, early, in turnEngine.handleUserMessage (before the
// busy/queue split) so queued AND immediate sends both carry the expanded
// context. The operator's chat ECHO stays compact (the raw `@file:x.ts` text
// they typed); only the MODEL prompt gets the expanded blocks appended under a
// clearly-delimited `--- Context (...) ---` section. A `system_notice` summary
// is emitted so the expansion is visible + reviewable in events.jsonl (the
// four-question test) — see turnEngine for the emit.
//
// PARSER DUPLICATION: the regex/classification mirrors
// client/src/components/composer/contextRefs.ts. They can't share a module —
// the client file lives outside the server tsconfig rootDir — so the grammar
// is intentionally duplicated and kept in lockstep by hand. The smoke unit-
// tests the client parser; this expander is exercised against the real repo.
//
// SECURITY (director-checked invariants):
//   1. `@file:` resolves strictly inside cwd via resolveWithinCwd, AND the
//      realpath is re-checked so a symlink can't escape. `../` / absolute-
//      outside → a "path not allowed" notice, never a read.
//   2. `@file:` contents are byte-capped (MAX_CONTEXT_REF_BYTES) and truncated
//      with an explicit "[truncated N bytes]" notice.
//   3. git refs go through git.ts (execFile argv only); `@git:N` validates +
//      caps N.
//   4. Any ref that fails expands to a readable notice — never throws.
//   5. The expansion is logged to events.jsonl (system_notice, emitted by the
//      caller).

import { promises as fs } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { relative, resolve, isAbsolute } from 'node:path';
import { gitDiff, gitLog } from './git.js';
import { resolveWithinCwd } from './providers/ollamaTools.js';

// Per-ref byte cap for `@file:`. Matches the Native tool surface's
// MAX_TOOL_OUTPUT_BYTES (64 KB) — large enough for any single source file,
// small enough not to blow the turn's input budget on one ref.
export const MAX_CONTEXT_REF_BYTES = 64 * 1024;

// Hard cap on `@git:N`, mirrored from the client parser + git.ts.
export const MAX_GIT_COUNT = 50;

// H8 — aggregate `@`-ref budget gate. The per-ref 64 KB cap bounds ONE ref, but
// nothing stopped an operator from stacking ten `@file:`s and burying the actual
// instruction in 600 KB of pasted source. So sum the estimated tokens across all
// refs in a turn and gate on a fraction of the model's context window:
//   • soft-warn once the aggregate crosses ~25% (still expands — just flags it);
//   • hard-refuse any ref that would push the aggregate past ~50% (and every
//     ref after — once we're over the ceiling, nothing more is pasted).
// Conservative default window for non-Claude / unknown models so the gate still
// bites rather than silently disabling itself.
export const CONTEXT_REF_SOFT_WARN_FRACTION = 0.25;
export const CONTEXT_REF_HARD_REFUSE_FRACTION = 0.5;
export const DEFAULT_CONTEXT_REF_WINDOW = 200_000;

// Coarse, deterministic token estimate: UTF-8 bytes / 4 (matches the other
// budget estimators in the tree — a slight over-count so a big paste can't
// sneak past the gate).
export function estimateRefTokens(body: string): number {
  return Math.ceil(Buffer.byteLength(body, 'utf8') / 4);
}

type RefKind = 'file' | 'diff' | 'staged' | 'git' | 'url';

interface ParsedRef {
  kind: RefKind;
  raw: string;
  arg?: string;
  count?: number;
}

// Mirror of client/src/components/composer/contextRefs.ts REF_RE — keep in sync.
const REF_RE =
  /(^|\s)@(?:(file):(\S+)|(diff)\b|(staged)\b|(git):(\d+)\b|(url):(\S+))/g;

function parseRefs(text: string): ParsedRef[] {
  const refs: ParsedRef[] = [];
  if (typeof text !== 'string' || text.length === 0) return refs;
  REF_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REF_RE.exec(text))) {
    const lead = m[1] ?? '';
    const raw = m[0].slice(lead.length);
    if (m[2] === 'file') refs.push({ kind: 'file', raw, arg: m[3] });
    else if (m[4] === 'diff') refs.push({ kind: 'diff', raw });
    else if (m[5] === 'staged') refs.push({ kind: 'staged', raw });
    else if (m[6] === 'git') {
      const n = Number(m[7]);
      refs.push({ kind: 'git', raw, count: Number.isInteger(n) ? n : undefined });
    } else if (m[8] === 'url') refs.push({ kind: 'url', raw, arg: m[9] });
  }
  return refs;
}

export interface ContextExpansion {
  // The expanded context block to append to the MODEL prompt (NOT the echo).
  // Empty string when there were no refs to expand.
  block: string;
  // One short line per ref describing what happened (expanded / truncated /
  // refused / failed). Joined into the system_notice the caller emits.
  notices: string[];
  // Count of refs that produced a context block (for the notice header).
  expandedCount: number;
}

// Confine + read a `@file:` target. Two-layer check: resolveWithinCwd catches
// lexical `../` and absolute-outside paths; the realpath re-check catches a
// symlink whose target escapes cwd (resolveWithinCwd validates the link path,
// not its destination). Bounded read with an explicit truncation notice.
async function expandFile(cwd: string, arg: string | undefined): Promise<{ body: string; notice: string }> {
  if (!arg) {
    return { body: '', notice: '@file: ignored — no path given' };
  }
  let abs: string;
  try {
    abs = resolveWithinCwd(cwd, arg);
  } catch {
    return { body: '', notice: `@file:${arg} refused — path not allowed (escapes workflow directory)` };
  }
  // Symlink escape guard: resolve the realpath and re-confirm it's under cwd.
  // A missing file makes realpath throw ENOENT — surface as a readable notice.
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    return { body: '', notice: `@file:${arg} skipped — file not found` };
  }
  const rel = relative(resolve(cwd), real);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { body: '', notice: `@file:${arg} refused — path not allowed (symlink escapes workflow directory)` };
  }
  // Stat to reject directories early (reading a dir throws EISDIR).
  let stat;
  try {
    stat = await fs.stat(real);
  } catch (err) {
    return { body: '', notice: `@file:${arg} failed — ${(err as Error).message}` };
  }
  if (stat.isDirectory()) {
    return { body: '', notice: `@file:${arg} skipped — is a directory, not a file` };
  }
  let buf: Buffer;
  try {
    buf = await fs.readFile(real);
  } catch (err) {
    return { body: '', notice: `@file:${arg} failed — ${(err as Error).message}` };
  }
  let text: string;
  let notice: string;
  if (buf.byteLength > MAX_CONTEXT_REF_BYTES) {
    const dropped = buf.byteLength - MAX_CONTEXT_REF_BYTES;
    text = buf.subarray(0, MAX_CONTEXT_REF_BYTES).toString('utf8') +
      `\n\n… [truncated ${dropped} bytes]`;
    notice = `@file:${arg} expanded (truncated — ${dropped} bytes over the ${MAX_CONTEXT_REF_BYTES}-byte cap)`;
  } else {
    text = buf.toString('utf8');
    notice = `@file:${arg} expanded (${buf.byteLength} bytes)`;
  }
  return { body: `--- Context (@file:${arg}) ---\n${text}`, notice };
}

async function expandDiff(cwd: string, staged: boolean): Promise<{ body: string; notice: string }> {
  const label = staged ? '@staged' : '@diff';
  const res = await gitDiff(cwd, staged);
  if (!res.ok) {
    return { body: '', notice: `${label} skipped — ${res.error}` };
  }
  if (res.text.trim().length === 0) {
    return { body: `--- Context (${label}) ---\n(no ${staged ? 'staged ' : ''}changes)`, notice: `${label} expanded (no changes)` };
  }
  let text = res.text;
  let notice = `${label} expanded`;
  if (Buffer.byteLength(text, 'utf8') > MAX_CONTEXT_REF_BYTES) {
    const full = Buffer.from(text, 'utf8');
    const dropped = full.byteLength - MAX_CONTEXT_REF_BYTES;
    text = full.subarray(0, MAX_CONTEXT_REF_BYTES).toString('utf8') + `\n\n… [truncated ${dropped} bytes]`;
    notice = `${label} expanded (truncated — ${dropped} bytes over the ${MAX_CONTEXT_REF_BYTES}-byte cap)`;
  }
  return { body: `--- Context (${label}) ---\n${text}`, notice };
}

async function expandGit(cwd: string, count: number | undefined): Promise<{ body: string; notice: string }> {
  if (count === undefined || !Number.isInteger(count) || count < 1) {
    return { body: '', notice: '@git: skipped — count must be a positive integer (e.g. @git:3)' };
  }
  const capped = Math.min(count, MAX_GIT_COUNT);
  const res = await gitLog(cwd, capped);
  if (!res.ok) {
    return { body: '', notice: `@git:${count} skipped — ${res.error}` };
  }
  const note = capped < count
    ? `@git:${count} expanded (capped to last ${capped} commits)`
    : `@git:${count} expanded (last ${capped} commits)`;
  return { body: `--- Context (@git:${capped} — last ${capped} commits) ---\n${res.text}`, notice: note };
}

// `@url:` is a recognized-but-deferred ref (director decision §D1). It expands
// to a clear notice rather than fetching — a safe SSRF-guarded fetch is a
// security-sensitive sub-phase of its own. NOT an error, NOT a silent drop.
function expandUrl(arg: string | undefined): { body: string; notice: string } {
  const target = arg ? `@url:${arg}` : '@url:';
  return {
    body: `--- Context (${target}) ---\n[@url: is not yet supported — URL fetching is deferred pending an SSRF-guarded fetch. Paste the relevant text directly, or use a fetch tool in-turn.]`,
    notice: `${target} not yet supported (deferred)`,
  };
}

// Expand all `@`-refs in `content` against `cwd`. Never throws — every failure
// path is converted to a notice. Returns the block to append to the model
// prompt + the per-ref notices. When there are no refs, returns an empty block
// and no notices (zero overhead for the common case).
export async function expandContextRefs(
  cwd: string,
  content: string,
  opts?: { windowSize?: number },
): Promise<ContextExpansion> {
  const refs = parseRefs(content);
  if (refs.length === 0) {
    return { block: '', notices: [], expandedCount: 0 };
  }
  // H8 — aggregate budget thresholds, derived from the model's window.
  const window = opts?.windowSize && opts.windowSize > 0 ? opts.windowSize : DEFAULT_CONTEXT_REF_WINDOW;
  const softWarnAt = Math.round(window * CONTEXT_REF_SOFT_WARN_FRACTION);
  const hardRefuseAt = Math.round(window * CONTEXT_REF_HARD_REFUSE_FRACTION);
  const pct = (tok: number): number => Math.round((tok / window) * 100);

  const blocks: string[] = [];
  const notices: string[] = [];
  let expandedCount = 0;
  let accumTokens = 0;
  let softWarned = false;
  for (const ref of refs) {
    let result: { body: string; notice: string };
    try {
      switch (ref.kind) {
        case 'file':
          result = await expandFile(cwd, ref.arg);
          break;
        case 'diff':
          result = await expandDiff(cwd, false);
          break;
        case 'staged':
          result = await expandDiff(cwd, true);
          break;
        case 'git':
          result = await expandGit(cwd, ref.count);
          break;
        case 'url':
          result = expandUrl(ref.arg);
          break;
      }
    } catch (err) {
      // Defensive: nothing above should throw, but a ref that fails must never
      // crash the send.
      result = { body: '', notice: `${ref.raw} failed — ${(err as Error).message}` };
    }
    if (result.body) {
      // H8 — gate BEFORE adding the block. A ref that would push the aggregate
      // past the hard ceiling is refused (and so is everything after it, since
      // we're already over budget) — the operator's actual instruction must not
      // be buried under stacked pastes.
      const refTokens = estimateRefTokens(result.body);
      if (accumTokens + refTokens > hardRefuseAt) {
        notices.push(
          `${ref.raw} refused — would push @-ref context to ${pct(accumTokens + refTokens)}% of the ${window.toLocaleString()}-token window ` +
          `(aggregate @-ref budget is ${Math.round(CONTEXT_REF_HARD_REFUSE_FRACTION * 100)}%). Drop a ref or send fewer files.`,
        );
        continue;
      }
      blocks.push(result.body);
      accumTokens += refTokens;
      expandedCount++;
      if (!softWarned && accumTokens > softWarnAt) {
        softWarned = true;
        notices.push(
          `[budget] @-ref context now ~${pct(accumTokens)}% of the context window — approaching the ` +
          `${Math.round(CONTEXT_REF_HARD_REFUSE_FRACTION * 100)}% aggregate ceiling; further refs may be refused.`,
        );
      }
      // Re-state the ref's own expansion notice after the budget bookkeeping.
      notices.push(result.notice);
    } else {
      notices.push(result.notice);
    }
  }
  return {
    block: blocks.length > 0 ? '\n\n' + blocks.join('\n\n') : '',
    notices,
    expandedCount,
  };
}
