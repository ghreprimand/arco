
import type { Finding, FindingSeverity } from './parseReviewFindings.js';

export type ReviewVerdict = 'PASS' | 'MINOR' | 'BLOCKING';

// Ollama can constrain decoding with a JSON Schema, which makes verdict and
// finding extraction more reliable for local models. The schema represents the
// review's Summary, Concerns and Verdict sections; reconstruction keeps the
// persisted markdown artifact and clickable findings in their existing format.
// Other providers continue to use the tolerant free-text parser.

// The structured review object the Ollama model is constrained to emit. Mirrors
// the three prose sections + the optional findings array. `concerns` is free
// prose (may be "None."); `findings` is the file-anchored convenience list.
export interface StructuredReview {
  summary: string;
  concerns: string;
  verdict: ReviewVerdict;
  findings: Finding[];
}

// JSON Schema passed as Ollama's `format`. Kept deliberately small — every
// property `required` so the sampler can't drop a field, `enum` on verdict +
// severity so the model can only land a valid value (the single biggest source
// of verdict-detection misses on small models). `findings` is required but may
// be an empty array.
//
// NOTE: this is a plain JSON-Schema object (Ollama accepts the raw schema as
// `format`). We do NOT use `additionalProperties:false` on the findings items
// — some Ollama/llama.cpp grammar backends choke on it; the parser below
// allowlists fields anyway, so extra keys are harmless.
export const REVIEW_FORMAT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    concerns: { type: 'string' },
    verdict: { type: 'string', enum: ['PASS', 'MINOR', 'BLOCKING'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer', minimum: 1 },
          severity: { type: 'string', enum: ['info', 'warning', 'error'] },
          note: { type: 'string' },
        },
        required: ['file', 'line', 'severity', 'note'],
      },
    },
  },
  required: ['summary', 'concerns', 'verdict', 'findings'],
} as const;

const VERDICTS: readonly ReviewVerdict[] = ['PASS', 'MINOR', 'BLOCKING'];
const SEVERITIES: readonly FindingSeverity[] = ['info', 'warning', 'error'];

function coerceFinding(raw: unknown): Finding | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.file !== 'string' || o.file.trim() === '') return null;
  const lineNum = typeof o.line === 'number' ? o.line : Number(o.line);
  if (!Number.isInteger(lineNum) || lineNum < 1) return null;
  if (typeof o.severity !== 'string') return null;
  const sev = o.severity.trim().toLowerCase();
  if (!(SEVERITIES as readonly string[]).includes(sev)) return null;
  if (typeof o.note !== 'string' || o.note.trim() === '') return null;
  return { file: o.file.trim(), line: lineNum, severity: sev as FindingSeverity, note: o.note.trim() };
}

// Parse the model's schema-constrained JSON text into a StructuredReview.
// Returns null if the text isn't the expected object (the caller then falls
// back to free-text parsing — fail-safe per the M5 guardrails). Grammar-
// constrained decoding should make this near-impossible to fail, but a model
// without grammar support that ignored `format` would land here, so the
// fallback stays real.
export function parseStructuredReview(text: string): StructuredReview | null {
  if (!text || !text.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    // Tolerate a model that wrapped the JSON in prose or a code fence despite
    // the schema (e.g. a non-grammar build that treated `format` as advisory).
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { parsed = JSON.parse(m[0]); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.verdict !== 'string') return null;
  const verdict = o.verdict.trim().toUpperCase();
  if (!(VERDICTS as readonly string[]).includes(verdict)) return null;
  const summary = typeof o.summary === 'string' ? o.summary.trim() : '';
  const concerns = typeof o.concerns === 'string' ? o.concerns.trim() : '';
  const findings: Finding[] = [];
  if (Array.isArray(o.findings)) {
    for (const f of o.findings) {
      const v = coerceFinding(f);
      if (v) findings.push(v);
    }
  }
  return { summary, concerns, verdict: verdict as ReviewVerdict, findings };
}

// Rebuild the canonical Summary/Concerns/Verdict markdown body (plus a
// findings block when present) from a StructuredReview, so the on-disk
// artifact looks identical to a free-text reviewer's output. Keeps the
// downstream artifact format + the Review tab renderer unchanged — the only
// thing that differs on the Ollama path is HOW the structure was obtained
// (grammar-constrained JSON instead of regex-scraped prose).
export function reconstructStructuredReview(r: StructuredReview): string {
  const parts: string[] = [
    '## Summary',
    '',
    r.summary || '_(none provided)_',
    '',
    '## Concerns',
    '',
    r.concerns || 'None.',
    '',
    '## Verdict',
    '',
    `${r.verdict} — structured (schema-constrained) review.`,
  ];
  if (r.findings.length > 0) {
    parts.push(
      '',
      '```findings',
      JSON.stringify(r.findings, null, 2),
      '```',
    );
  }
  return parts.join('\n');
}
