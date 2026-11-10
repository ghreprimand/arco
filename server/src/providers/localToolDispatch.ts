// One decision for every tool call a local model makes (Ollama, llama.cpp,
// LM Studio and the OpenAI-compatible connections built on it: Strata,
// DeepSeek). Each provider keeps what is really its own: how arguments arrive,
// the events it shows and how results are stored. The checks, their order and
// the text the model gets back live here. Pinned by localToolDispatch.test.ts.

import { isKnownOllamaTool, type ToolLoopDetector } from './ollamaTools.js';

export interface ParsedToolArguments { args: Record<string, unknown>; argError?: string }

// JSON text from an OpenAI-shaped tool call. Empty text means no arguments; a
// parse failure or a non-object is reported rather than run with `{}`.
export function parseToolArguments(raw: string | undefined): ParsedToolArguments {
  if (!raw) return { args: {} };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return { args: parsed as Record<string, unknown> };
    return { args: {}, argError: `arguments JSON parsed to a non-object (${typeof parsed})` };
  } catch (e) {
    const preview = raw.slice(0, 80);
    return { args: {}, argError: `arguments not JSON-parseable (${(e as Error).message}); received: ${JSON.stringify(preview)}` };
  }
}

export const toolNotEnabledResult = (name: string): string => `[error] tool "${name}" is not enabled for this turn.`;
export const safeModeResult = (name: string): string =>
  `[Arco SAFE mode] tool "${name}" was not executed. ` +
  'The local provider runs tools server-side only when AUTO mode is enabled on this workflow. ' +
  'Tell the operator what you were going to do, or answer from what they have shown you.';
export const localUnknownToolResult = (name: string): string =>
  `[error] unknown tool "${name}". The local-tool runtime is on a strict allowlist; see docs/PROVIDERS.md.`;

// What differs between providers today. Kept as data so the differences stay
// visible; changing one is a behavior change for that provider.
export interface LocalToolRules {
  // A Computer (voice) chat runs its tools through Computer: before the
  // boundary check (Ollama), after it (LM Studio and its connections), or not
  // at all (llama.cpp).
  computer: 'first' | 'after-boundary' | 'none';
  // The refusal text when this call may not run this turn, else null.
  boundary: (name: string) => string | null;
  unknownTool: (name: string) => string;
  // After coaching is ignored: end the turn (true) or keep coaching (false).
  endTurnOnRepeat: boolean;
}

export interface LocalToolRuntime {
  cwd: string | undefined;
  isKnownTool?: (name: string) => boolean;
  autoMode: boolean;
  computerChat: boolean;
  loop: ToolLoopDetector;
  runComputer: (name: string, args: Record<string, unknown>) => Promise<string>;
  runTool: (name: string, args: Record<string, unknown>, cwd: string) => Promise<string>;
  notice: (text: string) => void;
}

// The result text for one call, in this order: bad arguments, Computer (when
// first), the boundary, Computer (when after), SAFE mode, a missing folder, an
// unknown tool, the loop coach, then the tool itself.
export async function decideLocalToolCall(name: string, parsed: ParsedToolArguments, rules: LocalToolRules, rt: LocalToolRuntime): Promise<string> {
  const { args, argError } = parsed;
  if (argError) return `[error] tool "${name}" arguments rejected: ${argError}`;
  if (rules.computer === 'first' && rt.computerChat) return rt.runComputer(name, args);
  const refusal = rules.boundary(name);
  if (refusal !== null) return refusal;
  if (rules.computer === 'after-boundary' && rt.computerChat) return rt.runComputer(name, args);
  if (!rt.autoMode) return safeModeResult(name);
  // The tool runtime anchors paths to the workflow folder; a spawn without one
  // is refused rather than run relative to the server's own folder.
  if (!rt.cwd) return `[error] tool "${name}" requires a workflow cwd; this spawn has none.`;
  if (!isKnownOllamaTool(name) && !rt.isKnownTool?.(name)) return rules.unknownTool(name);
  const { coach, terminate, previousCount } = rt.loop.shouldCoach(name, args);
  if (terminate && rules.endTurnOnRepeat) {
    rt.notice(`tool-loop terminating: "${name}" called ${previousCount + 1}x with identical args after coaching ignored — ending turn`);
    return rt.loop.terminationMessage(name, previousCount + 1);
  }
  if (coach) {
    rt.notice(`tool-loop coach: "${name}" called ${previousCount + 1}x with identical args — injected coaching message instead of re-executing`);
    return rt.loop.coachingMessage(name, previousCount + 1);
  }
  return rt.runTool(name, args, rt.cwd);
}

// Runs the calls in order. A cancel stops the batch before the next call:
// Write and Edit do not watch the abort signal, so a batch cancelled during
// an earlier Bash would otherwise still change files after "Worker killed".
export async function dispatchLocalToolCalls<C, M>(calls: readonly C[], aborted: () => boolean, each: (call: C) => Promise<M>): Promise<M[]> {
  const out: M[] = [];
  for (const call of calls) {
    if (aborted()) break;
    out.push(await each(call));
  }
  return out;
}

// Keeps large results out of the message stack: the first and last part of
// the text (lines for Read). The full output stays in the event log.
export function truncateLocalToolResult(name: string, raw: string, label: string, headBytes: number, tailBytes: number): string {
  if (raw.length <= headBytes + tailBytes + 200) return raw;
  if (name === 'Read') {
    const lines = raw.split('\n');
    if (lines.length <= 250) return raw;
    const head = lines.slice(0, 100).join('\n');
    const tail = lines.slice(-100).join('\n');
    return `${head}\n\n[... ${lines.length - 200} lines elided by Arco to keep ${label} context lean — re-read with explicit line range if needed ...]\n\n${tail}`;
  }
  const head = raw.slice(0, headBytes);
  const tail = raw.slice(-tailBytes);
  return `${head}\n\n[... ${raw.length - head.length - tail.length} bytes of tool output elided by Arco to keep ${label} context lean ...]\n\n${tail}`;
}
