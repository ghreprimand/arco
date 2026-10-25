// EFFICIENCY_PLAN.md Phase C — pure-TS deterministic filter pipeline applied
// to a single tool_result before it enters the Native worker's `messages[]`.
//
// **Cache invariant.** Filters operate on the *current* turn's tool_result
// only — never retroactively on prior turns. The worker's `messages[]` is
// never mutated by this module; only the new tool_result content block is
// rewritten before insertion. Cache breakpoints upstream stay valid.
//
// **Reversibility.** When `originalBytes !== filteredBytes` the worker
// gzips the raw output to `<arcoHome>/workflows/<wfId>/artifacts/raw-tools/`
// and stamps `rawArtifactPath` on the emitted `tool_filtered` event. This
// module is pure — it does no I/O.
//
// Pipeline stages (configurable per pack, all optional):
//   1. strip_ansi      — remove ANSI escape codes
//   2. replace[]       — { pattern: RegExp, replacement: string } substitutions
//   3. skip[] / keep[] — line-level drop/preserve (keep overrides skip)
//   4. dedup           — collapse runs of identical lines into `… (xN)`
//   5. parse           — optional structured parser (cargo-test, jest, …)
//   6. head_cap / tail_cap — byte caps from start/end with truncation marker
//   7. branch_on_exit  — when true and exitCode !== 0, prefer tail_cap over
//      head_cap. Errors land at the end of compiler / test output, so the
//      tail is what the model needs.

export interface FilterPack {
  // Stable identifier surfaced on the tool_filtered event and the chat chip
  // (e.g. "cargo-test-drop-passing"). Pack authors keep these short and
  // dash-cased so the chat chip stays compact.
  name: string;
  stripAnsi?: boolean;
  replace?: Array<{ pattern: RegExp; replacement: string }>;
  // Line-level drop. A line matching any `skip` pattern is removed unless it
  // also matches a `keep` pattern. Patterns are run as-is (no implicit
  // anchors); pack authors include `^`/`$` when they need them.
  skip?: RegExp[];
  keep?: RegExp[];
  dedup?: boolean;
  // Structured parser run after replace/skip/dedup. Receives the post-line-
  // ops text and the exit code so it can branch (e.g. cargo-test-drop-
  // passing on green vs. preserve-failures on red). Pure function.
  parse?: (text: string, exitCode: number | null) => string;
  // Byte caps. `headCap` keeps the first N bytes; `tailCap` keeps the last
  // N. When `branchOnExit` is true and exitCode !== 0, the dispatcher flips
  // a headCap configuration to tailCap — errors are at the end.
  headCap?: number;
  tailCap?: number;
  branchOnExit?: boolean;
}

export interface FilterResult {
  filtered: string;
  filterName: string;
  originalBytes: number;
  filteredBytes: number;
}

// ESC-introduced control sequences. Two main shapes we strip:
//   CSI: ESC '[' <params> <final-byte 0x40-0x7E>   (colors, cursor moves, …)
//   OSC: ESC ']' <params> (BEL | ST)               (window titles, hyperlinks)
// Plus bare ESC + single byte (Fe sequences). Inlined to avoid the
// `ansi-regex` dep — we don't need its full coverage for compiler / test
// output, only the colors that wrap them.
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /(?:\[[0-9;?]*[ -\/]*[@-~]|\][^]*(?:|\\)|[@-Z\\-_])/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, '');
}

function applyReplacements(s: string, repls: NonNullable<FilterPack['replace']>): string {
  let out = s;
  for (const { pattern, replacement } of repls) {
    // Patterns are authored with the `g` flag where applicable; we don't
    // force-add it because the pack author may want a single-shot replace.
    out = out.replace(pattern, replacement);
  }
  return out;
}

function applyLineFilters(
  s: string,
  skip: RegExp[] | undefined,
  keep: RegExp[] | undefined,
): string {
  if (!skip?.length && !keep?.length) return s;
  const lines = s.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const isKept = keep?.some((rx) => rx.test(line)) ?? false;
    const isSkipped = !isKept && (skip?.some((rx) => rx.test(line)) ?? false);
    if (!isSkipped) out.push(line);
  }
  return out.join('\n');
}

function dedupRuns(s: string): string {
  const lines = s.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const run = j - i;
    if (run >= 3) out.push(`${lines[i]}  … (x${run})`);
    else for (let k = i; k < j; k++) out.push(lines[k]);
    i = j;
  }
  return out.join('\n');
}

function applyHeadCap(s: string, cap: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= cap) return s;
  const head = buf.subarray(0, cap).toString('utf8');
  const dropped = buf.byteLength - cap;
  return `${head}\n\n[... ${dropped} bytes truncated (head_cap) ...]`;
}

function applyTailCap(s: string, cap: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.byteLength <= cap) return s;
  const tail = buf.subarray(buf.byteLength - cap).toString('utf8');
  const dropped = buf.byteLength - cap;
  return `[... ${dropped} bytes truncated (tail_cap) ...]\n\n${tail}`;
}

// Run a single filter pack against raw output. Pure function; no I/O. The
// dispatcher in filterConfigs/index.ts picks the pack by tool name + (for
// Bash) command-prefix match; this layer only knows how to apply one.
export function runFilterPipeline(
  rawOutput: string,
  exitCode: number | null,
  pack: FilterPack,
): FilterResult {
  const originalBytes = Buffer.byteLength(rawOutput, 'utf8');
  let s = rawOutput;
  if (pack.stripAnsi) s = stripAnsi(s);
  if (pack.replace?.length) s = applyReplacements(s, pack.replace);
  if (pack.skip?.length || pack.keep?.length) s = applyLineFilters(s, pack.skip, pack.keep);
  if (pack.dedup) s = dedupRuns(s);
  if (pack.parse) s = pack.parse(s, exitCode);
  // branchOnExit: when the command failed, prefer tailCap so the operator-
  // visible error context (which lives at the end of compiler / test
  // output) survives. headCap is the wrong choice on a failed run.
  const useTailOverHead =
    pack.branchOnExit === true && exitCode !== null && exitCode !== 0 && pack.headCap !== undefined;
  if (useTailOverHead) {
    s = applyTailCap(s, pack.tailCap ?? pack.headCap!);
  } else {
    if (pack.headCap !== undefined) s = applyHeadCap(s, pack.headCap);
    if (pack.tailCap !== undefined) s = applyTailCap(s, pack.tailCap);
  }
  const filteredBytes = Buffer.byteLength(s, 'utf8');
  return {
    filtered: s,
    filterName: pack.name,
    originalBytes,
    filteredBytes,
  };
}

// Plan-§7a signature alias for callers that already hold the resolved pack.
// Returns a non-mutated passthrough when `pack` is null (mode=off, or no
// configured pack for the tool).
export function filterToolResult(
  _toolName: string,
  rawOutput: string,
  exitCode: number | null,
  pack: FilterPack | null,
): FilterResult {
  if (!pack) {
    const bytes = Buffer.byteLength(rawOutput, 'utf8');
    return { filtered: rawOutput, filterName: 'passthrough', originalBytes: bytes, filteredBytes: bytes };
  }
  return runFilterPipeline(rawOutput, exitCode, pack);
}
