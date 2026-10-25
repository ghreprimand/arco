// H50 — multi-strategy fuzzy Edit apply (Native).
//
// The exact `str_replace` an Edit does is brittle: the model reconstructs
// old_string from memory and drifts on whitespace it can't see — a trailing
// space, a re-indented block, or an over-escaped `\n`/`\t` that should have been
// a real newline/tab. Claude Code tolerates this with a fallback chain; the
// Native Edit tool didn't, so a one-space drift returned "old_string not found"
// and burned a turn. This module adds the chain, server-side and deterministic:
//
//   1. exact          — substring match (unchanged semantics; most precise).
//   2. escape-drift   — retry after interpreting literal \n \t \r \" in
//                       old_string (the over-escaping case).
//   3. trailing-ws    — line-based match ignoring per-line TRAILING whitespace.
//   4. indent         — line-based match ignoring per-line LEADING+trailing
//                       whitespace (uniform re-indentation).
//
// Each fuzzy strategy must be UNAMBIGUOUS (exactly one match) unless replace_all,
// and the splice always replaces the file's ACTUAL bytes for the matched region
// (we never write back the model's drifted old_string). On total no-match we
// return a "closest lines" hint so the model can correct without re-Reading.
// Batch (MultiEdit) is deliberately out of scope.

export type EditStrategy = 'exact' | 'escape-drift' | 'trailing-ws' | 'indent';

export interface EditApplyResult {
  applied: boolean;
  updated?: string;
  strategy?: EditStrategy;
  count?: number;
  // when !applied: a model-facing message (ambiguity error or no-match + hint).
  reason?: string;
}

export function applyEdit(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
): EditApplyResult {
  // 1. exact substring — preserve the tool's original semantics exactly.
  if (content.includes(oldStr)) {
    return spliceExact(content, oldStr, newStr, replaceAll, 'exact');
  }

  // 2. escape-drift — the model emitted literal "\n"/"\t"/"\r"/'\"' where the
  // file has the real character. Interpret and retry an EXACT match.
  const unescaped = interpretEscapes(oldStr);
  if (unescaped !== oldStr && content.includes(unescaped)) {
    return spliceExact(content, unescaped, newStr, replaceAll, 'escape-drift');
  }

  // 3/4. line-based fuzzy. Only attempt when old_string spans recognizable
  // lines; a single-line old_string with no whitespace drift won't be helped.
  for (const strat of ['trailing-ws', 'indent'] as const) {
    const norm = strat === 'trailing-ws' ? trimEndLine : trimLine;
    const r = spliceLineFuzzy(content, oldStr, newStr, replaceAll, norm, strat);
    if (r) return r;
  }

  // total no-match → hint.
  return { applied: false, reason: `old_string not found. ${closestLinesHint(content, oldStr)}` };
}

// Exact / unescaped substring splice with the tool's uniqueness rule.
function spliceExact(
  content: string,
  needle: string,
  newStr: string,
  replaceAll: boolean,
  strategy: EditStrategy,
): EditApplyResult {
  if (replaceAll) {
    const count = content.split(needle).length - 1;
    return { applied: true, updated: content.split(needle).join(newStr), strategy, count };
  }
  const first = content.indexOf(needle);
  const second = content.indexOf(needle, first + 1);
  if (second !== -1) {
    return {
      applied: false,
      reason: 'old_string is not unique — pass replace_all:true or extend old_string with surrounding context.',
    };
  }
  return {
    applied: true,
    updated: content.slice(0, first) + newStr + content.slice(first + needle.length),
    strategy,
    count: 1,
  };
}

// Line-based fuzzy match under a per-line normalizer. Splits content into lines,
// finds every start index where the normalized old-block matches the normalized
// file lines, and splices the ORIGINAL line range with new_string's lines. Returns
// null when this normalizer yields no candidate (so the caller tries the next).
function spliceLineFuzzy(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
  norm: (s: string) => string,
  strategy: EditStrategy,
): EditApplyResult | null {
  const fileLines = content.split('\n');
  const oldLines = oldStr.split('\n');
  const n = oldLines.length;
  if (n === 0 || n > fileLines.length) return null;
  const normOld = oldLines.map(norm);

  const starts: number[] = [];
  for (let i = 0; i + n <= fileLines.length; i++) {
    let ok = true;
    for (let k = 0; k < n; k++) {
      if (norm(fileLines[i + k]) !== normOld[k]) { ok = false; break; }
    }
    if (ok) starts.push(i);
  }
  if (starts.length === 0) return null;
  // Guard: a fuzzy match that ALSO matches exactly is the exact path's job; we
  // only reach here when exact failed, so any candidate here is genuinely fuzzy.
  if (!replaceAll && starts.length > 1) {
    return {
      applied: false,
      reason: `old_string matched ${starts.length} places under ${strategy} normalization — pass replace_all:true or extend old_string with surrounding context.`,
    };
  }
  const newLines = newStr.split('\n');
  // splice high→low so earlier indices stay valid.
  const lines = fileLines.slice();
  for (let s = starts.length - 1; s >= 0; s--) {
    lines.splice(starts[s], n, ...newLines);
  }
  return { applied: true, updated: lines.join('\n'), strategy, count: starts.length };
}

function trimEndLine(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimLine(s: string): string {
  return s.trim();
}

// Interpret the common literal escapes a model over-escapes into old_string.
// Conservative: only the four that actually cause Edit misses. A real backslash
// the model meant literally won't match the file either way, so this can't make
// a correct edit incorrect — it only RECOVERS an otherwise-failed match.
function interpretEscapes(s: string): string {
  return s
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"');
}

// Build the "closest lines" hint shown on a true no-match: locate the file
// region most similar to old_string's first non-empty line and quote a small
// window with 1-based line numbers, so the model can fix old_string in place.
export function closestLinesHint(content: string, oldStr: string): string {
  const fileLines = content.split('\n');
  const target = (oldStr.split('\n').find((l) => l.trim().length > 0) ?? '').trim();
  if (!target) return 'The file has no matching region to suggest.';

  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < fileLines.length; i++) {
    const score = similarity(fileLines[i].trim(), target);
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  if (bestIdx === -1 || bestScore < 0.34) {
    return 'No similar region found — Read the file again to get the current text.';
  }
  const from = Math.max(0, bestIdx - 3);
  const to = Math.min(fileLines.length - 1, bestIdx + 3);
  const window = [];
  for (let i = from; i <= to; i++) {
    const marker = i === bestIdx ? '→' : ' ';
    window.push(`${marker} ${i + 1}: ${fileLines[i]}`);
  }
  return `Closest region (line ${bestIdx + 1}):\n${window.join('\n')}`;
}

// Deterministic character-bigram similarity (Sørensen–Dice) in [0,1]. Cheap,
// order-tolerant, no external dep. Used only to rank candidate lines for the hint.
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ma = bigrams(a);
  const mb = bigrams(b);
  let overlap = 0;
  for (const [g, ca] of ma) {
    const cb = mb.get(g);
    if (cb) overlap += Math.min(ca, cb);
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}
