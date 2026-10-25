// H9 — in-turn tool-loop guardrail (Native).
//
// Sibling of §3.1's cross-turn stuck-worker breaker, but scoped to ONE operator
// turn: the model's client-tool loop (streamOneRound → dispatch → repeat) can
// spin on the same call without making progress — re-running an identical Bash
// that keeps failing, re-Reading the same file, re-Grepping the same pattern.
// MAX_TOOL_TURNS (1000) only catches it after minutes of wasted spend; this
// trips in a handful of iterations.
//
// Two signals, both per-turn (reset at primary_turn_started):
//   • identical-repeat — the same (toolName, argsHash) called N times. Suspicious
//     on its own (the model isn't varying its approach) but can be legitimate
//     (paging, polling), so the threshold is higher.
//   • no-progress — the same (toolName, argsHash) AND the same outputHash. The
//     model is getting the byte-identical result back and calling again anyway.
//     This is the genuine stuck loop; lower threshold.
//
// `outputHash` is the watchdog's normalized hash (../outputSignature.ts). Its
// fuzziness — collapsing timestamps/line-numbers/ANSI — is CORRECT here: we want
// "same error recurring," not arg-precise equality.
//
// Default posture is warnings-only (a tool_loop_warning event + system_notice);
// hard-stop is opt-in via ARCHON_TOOL_LOOP_GUARD=stop. Metadata carried in the
// event is {toolName, argsHash} ONLY — never the raw args (which can hold secrets
// / large pastes), matching the watchdog-instrumentation discipline.

import { createHash } from 'crypto';

// same (tool,args,output) this many times → no-progress loop. 3 = the model has
// now seen the identical result twice and called a third time.
export const NO_PROGRESS_THRESHOLD = 3;
// same (tool,args) this many times regardless of output → identical-repeat. Set
// well above a normal retry-with-tweak cadence so paging/polling don't trip it.
export const IDENTICAL_REPEAT_THRESHOLD = 6;

export type ToolLoopMode = 'off' | 'warn' | 'stop';

// Operator arming. Default 'warn' (visible, non-blocking). 'stop' aborts the
// tool loop on the first trip; 'off' disables detection entirely.
export function toolLoopGuardMode(): ToolLoopMode {
  const raw = (process.env.ARCHON_TOOL_LOOP_GUARD ?? '').trim().toLowerCase();
  if (raw === 'stop' || raw === 'hard' || raw === '1' || raw === 'on') return 'stop';
  if (raw === 'off' || raw === '0' || raw === 'false') return 'off';
  return 'warn';
}

// Stable, secret-free hash of a tool's input. Canonicalizes object key order so
// {a,b} and {b,a} collapse; truncates the serialized form before hashing to cap
// work on huge inputs (a 1MB paste still hashes cheaply).
export function hashArgs(input: unknown): string {
  let serial: string;
  try {
    serial = canonicalJson(input);
  } catch {
    serial = String(input);
  }
  return createHash('sha1').update(serial.slice(0, 16384)).digest('hex').slice(0, 12);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export type ToolLoopSignal = 'none' | 'identical-repeat' | 'no-progress';

export interface ToolLoopVerdict {
  toolName: string;
  argsHash: string;
  // # of (toolName, argsHash) calls seen this turn (including the current one).
  repeatCount: number;
  // # of (toolName, argsHash, outputHash) calls seen this turn — identical
  // output. 0 when no outputHash was supplied for this call.
  sameOutputCount: number;
  // a threshold was crossed on this call.
  tripped: boolean;
  // true ONLY on the call where the threshold is first crossed for this key, so
  // the worker warns/stops once rather than on every later iteration.
  firstTrip: boolean;
  signal: ToolLoopSignal;
}

// Per-turn loop detector. One instance per worker; `reset()` at turn start.
export class ToolLoopGuard {
  private repeats = new Map<string, number>(); // tool|argsHash → count
  private sameOutput = new Map<string, number>(); // tool|argsHash|outputHash → count
  private tripped = new Set<string>(); // keys already reported this turn

  constructor(
    private readonly noProgressThreshold = NO_PROGRESS_THRESHOLD,
    private readonly identicalRepeatThreshold = IDENTICAL_REPEAT_THRESHOLD,
  ) {}

  reset(): void {
    this.repeats.clear();
    this.sameOutput.clear();
    this.tripped.clear();
  }

  // Record one dispatched tool call (after the result is known). `outputHash` is
  // optional — omit it for tools whose result we don't hash; then only the
  // identical-repeat signal can fire.
  record(toolName: string, argsHash: string, outputHash?: string): ToolLoopVerdict {
    const argKey = `${toolName}|${argsHash}`;
    const repeatCount = (this.repeats.get(argKey) ?? 0) + 1;
    this.repeats.set(argKey, repeatCount);

    let sameOutputCount = 0;
    if (outputHash) {
      const outKey = `${argKey}|${outputHash}`;
      sameOutputCount = (this.sameOutput.get(outKey) ?? 0) + 1;
      this.sameOutput.set(outKey, sameOutputCount);
    }

    // no-progress is the stronger signal → check it first.
    let signal: ToolLoopSignal = 'none';
    if (sameOutputCount >= this.noProgressThreshold) signal = 'no-progress';
    else if (repeatCount >= this.identicalRepeatThreshold) signal = 'identical-repeat';

    const tripped = signal !== 'none';
    const firstTrip = tripped && !this.tripped.has(argKey);
    if (firstTrip) this.tripped.add(argKey);

    return { toolName, argsHash, repeatCount, sameOutputCount, tripped, firstTrip, signal };
  }
}

// Operator-facing one-liner for a tripped verdict. Names the signal + counts;
// never the args.
export function describeToolLoop(v: ToolLoopVerdict, mode: ToolLoopMode): string {
  const what = v.signal === 'no-progress'
    ? `${v.toolName} returned the identical result ${v.sameOutputCount}× with no change`
    : `${v.toolName} called ${v.repeatCount}× with identical arguments`;
  const action = mode === 'stop'
    ? 'stopping the tool loop (ARCHON_TOOL_LOOP_GUARD=stop)'
    : 'continuing (set ARCHON_TOOL_LOOP_GUARD=stop to hard-stop)';
  return `Tool-loop guard: ${what} — ${action}.`;
}
