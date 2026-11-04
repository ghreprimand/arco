// docs/PROVIDERS.md - pre-tool-use guards.
//
// Two stacked rules today. Dispatch order is deliberate (cheap path check
// before state check) and documented in `docs/GOTCHAS.md § Efficiency`:
//
//   1. checkConfigProtection — block edits to lint/format/type-check config
//      files so the model fixes the code instead of weakening the gate.
//      Common failure mode: Claude hits a strict-equality lint rule, can't
//      make the type check pass, and "fixes" it by editing tsconfig.json or
//      .eslintrc.json. The synthetic tool_result nudges the model back to
//      fixing the actual issue. Default ON.
//
//   2. checkFactForceFirstEdit — Phase D §8a. The first `Edit`/`Write`/
//      `MultiEdit` of a turn targeting a path not yet edited returns a
//      synthetic tool_result asking the model to state importers + API
//      surface + the operator instruction before re-issuing the edit. We
//      don't parse the facts — the goal is committing them to context so
//      a subsequent turn-review can audit the reasoning. State lives on the
//      worker (`filesEditedThisTurn: Set<string>`), reset on
//      `primary_turn_started`. Native-only at first ship; CLI parity is
//      deferred (master refactor §3.3 F4).
//
// Both rules emit `tool_gate_triggered` events with distinct `gate` values
// (`config-protection` / `fact-force-first-edit`) so transcript review can
// distinguish them.

import { resolve, basename, parse, sep } from 'node:path';

// Paths considered config that the model should not edit. Matched on the
// resolved absolute path's basename — so any depth in the tree counts (a
// nested package's tsconfig.json is just as protected as the root one).
// `.arco/` config under cwd is NOT covered here on purpose: those are
// Arco's own per-workflow config files, which the operator may want the
// model to read but not write — protect them at a higher layer if needed.
const PROTECTED_BASENAMES = new Set<string>([
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  '.prettierrc',
  '.prettierrc.js',
  '.prettierrc.json',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  'prettier.config.js',
  'prettier.config.cjs',
  '.ruff.toml',
  'ruff.toml',
  'tsconfig.json',
  '.editorconfig',
]);

// `tsconfig.*.json` (tsconfig.build.json, tsconfig.test.json, …) gets a
// regex match on top of the basename set. Same rationale.
const PROTECTED_PATTERNS: RegExp[] = [
  /^tsconfig\.[a-z0-9_-]+\.json$/i,
];

// Tools that mutate files. Read-only tools (Read, Glob, Grep) are not
// gated — the model needs to be able to inspect the config to understand
// what's blocking it.
const MUTATING_TOOLS = new Set<string>(['Edit', 'Write', 'MultiEdit']);

export interface ConfigProtectionDecision {
  blocked: true;
  reason: string;
  syntheticResult: string;
}

export interface ConfigProtectionAllowed {
  blocked: false;
}

export type ConfigProtectionResult = ConfigProtectionDecision | ConfigProtectionAllowed;

function pathFromInput(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'Edit' || toolName === 'Write') {
    const p = input.file_path;
    return typeof p === 'string' ? p : null;
  }
  if (toolName === 'MultiEdit') {
    // MultiEdit takes a single file_path with multiple edits.
    const p = input.file_path;
    return typeof p === 'string' ? p : null;
  }
  return null;
}

function isProtectedPath(absPath: string): boolean {
  const name = basename(absPath);
  if (PROTECTED_BASENAMES.has(name)) return true;
  for (const re of PROTECTED_PATTERNS) {
    if (re.test(name)) return true;
  }
  return false;
}

// Inspect the tool input and return a decision. Caller is expected to
// short-circuit dispatch and return the synthetic result when blocked.
// `cwd` is used to resolve relative paths into something matchable.
export function checkConfigProtection(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): ConfigProtectionResult {
  if (!MUTATING_TOOLS.has(toolName)) return { blocked: false };
  const path = pathFromInput(toolName, input);
  if (!path) return { blocked: false };
  const absPath = resolve(cwd, path);
  if (!isProtectedPath(absPath)) return { blocked: false };
  const reason = `Edits to ${basename(absPath)} are gated by config-protection.`;
  const syntheticResult = `[blocked by config-protection] ${reason}\n\nFix the code instead of weakening lint/type-check config. If you genuinely need to edit ${basename(absPath)} (e.g. adding a new path mapping, not relaxing strictness), explain why and the operator can disable the gate.`;
  return { blocked: true, reason, syntheticResult };
}

export interface FactForceDecision {
  blocked: true;
  reason: string;
  syntheticResult: string;
  resolvedPath: string;
}

export interface FactForceAllowed {
  blocked: false;
  resolvedPath: string | null;
}

export type FactForceResult = FactForceDecision | FactForceAllowed;

// docs/PROVIDERS.md - first-edit fact-force gate. Returns
// `blocked` for the very first `Edit`/`Write`/`MultiEdit` of a turn whose
// resolved path is not yet in `filesEditedThisTurn`. The caller is expected
// to (a) short-circuit dispatch and return the synthetic tool_result when
// blocked, then (b) regardless of decision, add the resolved path to the
// set so the next edit to the SAME path inside the same turn passes through
// silently (the model only emits facts once per file per turn). Read-only
// tools (Glob, Grep, Read, Bash) are not gated — the model needs to inspect
// the file to enumerate importers.
export function checkFactForceFirstEdit(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  filesEditedThisTurn: Set<string>,
): FactForceResult {
  if (!MUTATING_TOOLS.has(toolName)) return { blocked: false, resolvedPath: null };
  const path = pathFromInput(toolName, input);
  if (!path) return { blocked: false, resolvedPath: null };
  const absPath = resolve(cwd, path);
  if (filesEditedThisTurn.has(absPath)) {
    // Second-or-later edit to a known file this turn — silent passthrough.
    return { blocked: false, resolvedPath: absPath };
  }
  const reason = `First edit to ${basename(absPath)} this turn — fact-force gate engaged.`;
  const syntheticResult =
    `[blocked by fact-force-first-edit] Before editing ${basename(absPath)}, briefly state:\n` +
    `  1. Other files importing or calling this code (importers).\n` +
    `  2. The public API surface this change affects (exports, types, signatures).\n` +
    `  3. The operator instruction this change satisfies (quote it).\n` +
    `Then re-issue the edit. Subsequent edits to ${basename(absPath)} this turn will pass through without re-asking.`;
  return { blocked: true, reason, syntheticResult, resolvedPath: absPath };
}

// H62 (Phase 3 — cluster correctness) — partial-read → full-write warning.
//
// A `Write` REPLACES the whole file. If the model only Read a SLICE of that
// file this turn (offset>1 or a limit — so it never saw the tail) and then
// Writes it, every line it didn't see is silently destroyed: the write
// "succeeds", the byte count looks plausible, and the mtime updates — there's no
// error to notice. In a cluster this is doubly dangerous (a member nukes work it
// never loaded). This is a NON-BLOCKING warning, NOT a gate: a wholesale
// rewrite is sometimes intended, so we let the write proceed and surface a note
// on the result + a `tool_gate_triggered` event for transcript review. Only
// `Write` is covered — `Edit` is a targeted splice that leaves the rest intact.
//
// State: the worker's `partialReadSet` holds paths Read with offset/limit this
// turn; a subsequent FULL Read of the same path removes it (the model has now
// seen everything, so a Write is safe). Reset per turn alongside `readSet`.
export interface PartialReadWriteWarn {
  warn: true;
  reason: string;
  note: string;
  resolvedPath: string;
}

export interface PartialReadWriteOk {
  warn: false;
}

export type PartialReadWriteResult = PartialReadWriteWarn | PartialReadWriteOk;

export function checkPartialReadFullWrite(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  partialReadSet: Set<string>,
): PartialReadWriteResult {
  if (toolName !== 'Write') return { warn: false };
  const p = typeof input.file_path === 'string' ? input.file_path : null;
  if (!p) return { warn: false };
  const absPath = resolve(cwd, p);
  if (!partialReadSet.has(absPath)) return { warn: false };
  const name = basename(absPath);
  const reason = `Write to ${name} after only a partial Read of it this turn.`;
  const note =
    `[warning: partial-read-then-full-write] You Read only a slice of ${name} this turn ` +
    `(with offset/limit), then Wrote the whole file. A Write REPLACES all contents — any ` +
    `lines you did not load are now gone. If you intended to preserve the rest, Read ${name} ` +
    `fully (no offset/limit) and re-issue the Write. If a wholesale replacement was intended, ignore this.`;
  return { warn: true, reason, note, resolvedPath: absPath };
}

// ── H17 — hardline command floor (Native Bash) ───────────────────────────────
//
// A small, ALWAYS-ON denylist of Bash commands a cooperating agent should never
// run because they take Arco (or its repo) down with the turn that issued them:
//   • Arco service self-termination — `systemctl --user restart/stop arco…`
//   • Arco process self-kill        — `pkill -f arco` / `killall … arco`
//   • Catastrophic recursive delete   — `rm -rf` of `/`, `~`, `$HOME`, `*`, or
//     the repo root (cwd) / an ancestor of it.
//
// This is a FLOOR, not a sandbox: it catches the cooperative-mode self-restart
// mistake (the model "helpfully" restarting the service it runs inside, killing
// every other tab's turn), NOT a determined adversary — trivial obfuscation
// (base64, `$(echo r)m`) slips through and that's accepted. Unlike
// config-protection it is not operator-disablable; nothing legitimate the model
// does from a turn needs to restart Arco or rm -rf the repo.

export interface HardlineDecision {
  blocked: true;
  reason: string;
  syntheticResult: string;
}
export interface HardlineAllowed { blocked: false; }
export type HardlineResult = HardlineDecision | HardlineAllowed;

// Catastrophic literal targets for `rm -rf`, independent of cwd.
const CATASTROPHIC_RM_TARGETS = new Set<string>(['/', '~', '~/', '.', './', '*', '$HOME', '${HOME}', '$PWD', '${PWD}']);

// Split a shell command into segments on the top-level separators we care about
// (no quote-awareness needed — this is a coarse floor, not a parser).
function shellSegments(command: string): string[] {
  return command.split(/(?:&&|\|\||[;|&\n])+/).map((s) => s.trim()).filter(Boolean);
}

// Does this segment recursively+force delete a catastrophic target?
function isCatastrophicRm(segment: string, cwd: string): boolean {
  const tokens = segment.split(/\s+/);
  const rmIdx = tokens.findIndex((t) => t === 'rm' || t.endsWith('/rm'));
  if (rmIdx === -1) return false;
  const rest = tokens.slice(rmIdx + 1);
  let flags = '';
  const targets: string[] = [];
  for (const t of rest) {
    if (t.startsWith('--')) continue; // long opts (--no-preserve-root etc.) ignored
    if (t.startsWith('-')) { flags += t.slice(1); continue; }
    targets.push(t);
  }
  const recursive = flags.includes('r') || flags.includes('R');
  const force = flags.includes('f');
  if (!recursive || !force) return false;
  for (const raw of targets) {
    const t = raw.replace(/^["']|["']$/g, ''); // strip surrounding quotes
    if (!t) continue;
    if (CATASTROPHIC_RM_TARGETS.has(t)) return true;
    // Resolve relative to cwd; block when the target is the repo root (cwd) or
    // an ancestor of it (so `rm -rf ..`, `rm -rf $cwd`, `rm -rf /` all catch).
    let abs: string;
    try { abs = resolve(cwd, t); } catch { continue; }
    // parse().root and sep keep the ancestor test right on Windows drive paths.
    if (abs === '/' || abs === parse(abs).root || abs === resolve(cwd) || (resolve(cwd) + sep).startsWith(abs + sep)) return true;
  }
  return false;
}

// Pure detector — returns a human reason when the command hits the floor, else
// null. Exported for the unit test.
export function detectHardlineCommand(command: string, cwd: string): string | null {
  if (!command || !command.trim()) return null;
  const c = command;
  if (/\bsystemctl\b[^\n]*\barco(?:\.service)?\b/i.test(c)) {
    return 'restarting/stopping the Arco service would kill this turn and every other tab';
  }
  if (/\b(?:pkill|killall)\b[^\n]*\barco\b/i.test(c)) {
    return 'killing the Arco process would terminate this turn and every other tab';
  }
  for (const seg of shellSegments(c)) {
    if (isCatastrophicRm(seg, cwd)) {
      return 'a recursive force-delete of the repo root / home / filesystem root is irreversible';
    }
  }
  return null;
}

// Inspect a Bash tool_use; block when it trips the hardline floor. Other tools
// pass through (the floor is about shell commands).
export function checkHardlineCommand(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): HardlineResult {
  if (toolName !== 'Bash') return { blocked: false };
  const command = typeof input.command === 'string' ? input.command : '';
  const reason = detectHardlineCommand(command, cwd);
  if (!reason) return { blocked: false };
  const syntheticResult =
    `[blocked by hardline-command-floor] Refused: ${reason}. This command is on Arco's always-on safety floor ` +
    `(Arco self-restart/self-kill, or rm -rf of the repo/home/root) — it is not run from an agent turn. ` +
    `If you genuinely need this, ask the operator to do it from a terminal outside Arco.`;
  return { blocked: true, reason, syntheticResult };
}
