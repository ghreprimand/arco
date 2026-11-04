// Workbench Expansion D5 — structured review-findings parser (client mirror).
//
// The reviewer is prompted to append a fenced findings block AFTER its prose
// narrative: a ```findings (or ```json) code fence containing a JSON array of
// { file, line, severity, note }. ReviewTab parses the lazily-fetched review
// body with this module and renders the findings as a clickable list.
//
// TOLERANCE (director-checked invariant): this parser NEVER throws and NEVER
// hides the prose. If the block is absent, malformed, or contains junk, it
// returns []. Old reviews (pre-D5) and non-compliant models therefore still
// render exactly as before — the prose is shown regardless. Each finding is
// validated individually; a single bad entry is dropped, not the whole block.
//
// LOAD-BEARING DUPLICATION: this grammar mirrors
// server/src/primitives/parseReviewFindings.ts. They can't share a module —
// this file lives outside the server tsconfig rootDir — so the parser is
// intentionally duplicated and kept BYTE-IDENTICAL by hand (mirrors the D1
// contextRefs.ts ↔ composer/contextRefs.ts precedent). The smoke unit-tests
// the server copy; keep this one in lockstep.

export type FindingSeverity = 'info' | 'warning' | 'error';

export interface Finding {
  file: string;
  line: number;
  severity: FindingSeverity;
  note: string;
}

const SEVERITIES: readonly FindingSeverity[] = ['info', 'warning', 'error'];

// Pull the LAST fenced block tagged ```findings or ```json out of the body.
// Last, not first: the reviewer is told to append it after the prose, and a
// JSON example inside the narrative shouldn't shadow the real block. Returns
// the inner text (without fences) or null if no such block exists.
function extractFindingsBlock(body: string): string | null {
  // Match ```findings / ```json (case-insensitive) … ``` — non-greedy inner.
  const re = /```(?:findings|json)\s*\n([\s\S]*?)\n?```/gi;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) last = m[1];
  return last;
}

function coerceSeverity(v: unknown): FindingSeverity | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if ((SEVERITIES as readonly string[]).includes(s)) return s as FindingSeverity;
  // Tolerate a couple of common synonyms so a near-miss model still lands a
  // finding rather than dropping it. Anything else → reject this finding.
  if (s === 'warn') return 'warning';
  if (s === 'err' || s === 'critical' || s === 'blocking') return 'error';
  if (s === 'note' || s === 'nit') return 'info';
  return null;
}

function validateFinding(raw: unknown): Finding | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.file !== 'string' || o.file.trim() === '') return null;
  // line: positive integer. Accept a numeric string too (models stringify).
  const lineNum = typeof o.line === 'number' ? o.line : Number(o.line);
  if (!Number.isInteger(lineNum) || lineNum < 1) return null;
  const severity = coerceSeverity(o.severity);
  if (!severity) return null;
  if (typeof o.note !== 'string' || o.note.trim() === '') return null;
  return { file: o.file.trim(), line: lineNum, severity, note: o.note.trim() };
}

// Parse a review body into structured findings. Pure + total: returns [] for
// any body lacking a valid findings block. Never throws.
export function parseReviewFindings(body: string): Finding[] {
  if (!body) return [];
  const block = extractFindingsBlock(body);
  if (block === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(block.trim());
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Finding[] = [];
  for (const entry of parsed) {
    const f = validateFinding(entry);
    if (f) out.push(f);
  }
  return out;
}
