// The checks around a Claude Native tool call, as ordered lists. The order is
// the safety property: the hardline floor refuses before anything else can
// let a command through, config protection comes before fact-force (which
// records the path it sees), and after the tool the output filter runs before
// the notes and hook text are added. dispatchTool in worker.ts runs these
// lists around the PreToolUse hooks, the review gate and the tool itself.
// Pinned by toolChecks.test.ts.

import { checkConfigProtection, checkFactForceFirstEdit, checkHardlineCommand } from './pretoolGuards.js';
import { parseHookOutput, type HookFireResult } from './hooks.js';

export type GuardGate = 'hardline-command-floor' | 'config-protection' | 'fact-force-first-edit';
export interface GuardBlock { gate: GuardGate; reason: string; syntheticResult: string }

export interface GuardInput {
  name: string;
  // The effective input, after PreToolUse hook rewrites.
  input: Record<string, unknown>;
  cwd: string;
  configProtection: boolean;
  factForce: boolean;
  // Paths already edited this turn; fact-force adds the path it sees.
  filesEditedThisTurn: Set<string>;
}

export interface PreToolGuard { gate: GuardGate; check: (x: GuardInput) => GuardBlock | null }

export const PRE_TOOL_GUARDS: readonly PreToolGuard[] = [
  // Always on and first: a self-restart, self-kill or rm -rf of the repo would
  // end this turn and every other tab.
  { gate: 'hardline-command-floor', check: (x) => {
    const r = checkHardlineCommand(x.name, x.input, x.cwd);
    return r.blocked ? { gate: 'hardline-command-floor', reason: r.reason, syntheticResult: r.syntheticResult } : null;
  } },
  // On unless the tab opted out; a cheap path-shape check.
  { gate: 'config-protection', check: (x) => {
    if (!x.configProtection) return null;
    const r = checkConfigProtection(x.name, x.input, x.cwd);
    return r.blocked ? { gate: 'config-protection', reason: r.reason, syntheticResult: r.syntheticResult } : null;
  } },
  // Operator opt-in. The path is recorded whether or not this call is blocked,
  // so a re-issued edit of the same file passes.
  { gate: 'fact-force-first-edit', check: (x) => {
    if (!x.factForce) return null;
    const r = checkFactForceFirstEdit(x.name, x.input, x.cwd, x.filesEditedThisTurn);
    if (r.resolvedPath !== null) x.filesEditedThisTurn.add(r.resolvedPath);
    return r.blocked ? { gate: 'fact-force-first-edit', reason: r.reason, syntheticResult: r.syntheticResult } : null;
  } },
];

// The first guard that refuses the call, in list order; later guards do not run.
export function firstBlockingGuard(x: GuardInput, guards: readonly PreToolGuard[] = PRE_TOOL_GUARDS): GuardBlock | null {
  for (const g of guards) {
    const block = g.check(x);
    if (block) return block;
  }
  return null;
}

export interface ToolOutcome { text: string; isError: boolean; final?: boolean }
export type PostToolStep = (o: ToolOutcome) => Promise<ToolOutcome>;

export interface PostToolDeps {
  // The output filter: returns the text to keep (the same text when no filter
  // applies). Reporting and raw-output storage are the caller's.
  filter: (text: string, isError: boolean) => Promise<string>;
  // The partial-read warning for this call, if any.
  partialNote: string | null;
  // Runs the PostToolUse hooks with the result so far.
  postHooks: (text: string) => Promise<HookFireResult[]>;
}

export function postToolSteps(deps: PostToolDeps): PostToolStep[] {
  return [
    // Before anything is appended, so hook text is never filtered away.
    async (o) => ({ ...o, text: await deps.filter(o.text, o.isError) }),
    // Only on success: a failed write already told the model something is wrong.
    async (o) => (deps.partialNote && !o.isError ? { ...o, text: `${o.text}\n\n${deps.partialNote}` } : o),
    // stderr and additionalContext are appended; a "block" decision replaces
    // the result with an error so the model retries.
    async (o) => {
      let text = o.text;
      for (const r of await deps.postHooks(text)) {
        const stderr = r.stderr.trim();
        if (stderr) text += `\n\n[PostToolUse hook stderr] ${stderr.slice(0, 500)}`;
        const parsed = parseHookOutput(r.stdout);
        const extra = parsed.hookSpecificOutput?.additionalContext;
        if (typeof extra === 'string' && extra.length > 0) text += `\n\n${extra}`;
        if (parsed.decision === 'block') return { text: `[PostToolUse hook blocked] ${parsed.reason ?? 'PostToolUse hook requested retry'}`, isError: true, final: true };
      }
      return { ...o, text };
    },
  ];
}

// Runs the steps in order; a step that returns `final` ends the list.
export async function runPostToolSteps(steps: readonly PostToolStep[], start: ToolOutcome): Promise<ToolOutcome> {
  let o = start;
  for (const step of steps) {
    o = await step(o);
    if (o.final) break;
  }
  return o;
}
