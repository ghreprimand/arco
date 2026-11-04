// docs/PROVIDERS.md / Excellence LE-4 - structured-output seam smoke.
//
// Tests the PURE schema seam directly (no WS, no LLM, no server boot):
//   server/src/primitives/reviewSchema.ts
//     - parseStructuredReview: schema JSON → StructuredReview (+ fail-safe null)
//     - reconstructStructuredReview: StructuredReview → canonical markdown that
//       the EXISTING downstream parsers (parseReviewFindings + detectVerdict-
//       style regex) still consume unchanged.
// plus a request-body assertion that mirrors the ollama.ts gate: `format` is
// attached to the /api/chat body ONLY on a tool-free turn (format + tools are
// mutually exclusive on the wire — a turn carrying tools would have its
// tool_calls suppressed by grammar-constrained decoding).
//
// The load-bearing M5 invariants asserted here:
//   1. A schema-conforming JSON reply parses, and its verdict/findings are
//      lifted WITHOUT regex-scraping.
//   2. reconstructStructuredReview produces a body that the byte-identical
//      free-text findings parser re-parses to the same findings (round-trip) —
//      so the on-disk artifact + Review tab renderer keep working unchanged.
//   3. FAIL-SAFE: a non-conforming reply yields null (caller falls back to the
//      free-text path), never a throw.
//   4. GATE: format is on the wire only when no tools are advertised.
//
// Run: npm run smoke:structured-output  (no dev server needed)

import { step, assert, assertEq, summary } from './lib.js';
import {
  REVIEW_FORMAT_SCHEMA,
  parseStructuredReview,
  reconstructStructuredReview,
} from '../../server/src/primitives/reviewSchema.js';
import { parseReviewFindings } from '../../server/src/primitives/parseReviewFindings.js';

// Mirror of the ollama.ts streamOneTurn gate: format attaches only on a
// tool-free turn. Kept in sync with the `...(format && !(tools && tools.length))`
// spread in the provider.
function buildFormatField(
  format: 'json' | Record<string, unknown> | undefined,
  tools: unknown[] | undefined,
): Record<string, unknown> {
  return format && !(tools && tools.length > 0) ? { format } : {};
}

// Free-text verdict regex — same shape as runReviewer.detectVerdict, used to
// prove the reconstructed body is also free-text-parseable (belt + suspenders).
function detectVerdict(body: string): string | undefined {
  const m = body.match(/verdict[^\n]*?\n+\s*\*?\*?(PASS|MINOR|BLOCKING)\b/i);
  if (m) return m[1].toUpperCase();
  const inline = body.match(/\b(PASS|MINOR|BLOCKING)\b/);
  return inline ? inline[1] : undefined;
}

async function main() {
  // ──────────────────────────────────────────── schema shape sanity ──
  await step('schema is a JSON-Schema object with enum-locked verdict + severity', async () => {
    const s = REVIEW_FORMAT_SCHEMA as Record<string, any>;
    assertEq(s.type, 'object', 'top-level object');
    assert(Array.isArray(s.required) && s.required.includes('verdict'), 'verdict required');
    assertEq(JSON.stringify(s.properties.verdict.enum), JSON.stringify(['PASS', 'MINOR', 'BLOCKING']), 'verdict enum locked');
    assertEq(
      JSON.stringify(s.properties.findings.items.properties.severity.enum),
      JSON.stringify(['info', 'warning', 'error']),
      'severity enum locked',
    );
  });

  // ──────────────────────────────────────────── parse + lift (no regex) ──
  await step('parses a conforming JSON reply and lifts verdict + findings directly', async () => {
    const json = JSON.stringify({
      summary: 'The agent added an endpoint.',
      concerns: 'No input validation on the handler.',
      verdict: 'MINOR',
      findings: [
        { file: 'server/src/http/router.ts', line: 42, severity: 'warning', note: 'missing validation' },
        { file: 'server/src/index.ts', line: 7, severity: 'info', note: 'consider a comment' },
      ],
    });
    const r = parseStructuredReview(json);
    assert(r !== null, 'parsed');
    assertEq(r!.verdict, 'MINOR', 'verdict lifted from JSON');
    assertEq(r!.findings.length, 2, 'two findings lifted');
    assertEq(r!.findings[0].file, 'server/src/http/router.ts', 'finding file');
    assertEq(r!.findings[0].line, 42, 'finding line');
  });

  await step('tolerates JSON wrapped in stray prose / a fence (non-grammar model)', async () => {
    const wrapped = 'Here is the review:\n```json\n' +
      JSON.stringify({ summary: 's', concerns: 'None.', verdict: 'PASS', findings: [] }) +
      '\n```';
    const r = parseStructuredReview(wrapped);
    assert(r !== null, 'extracted the brace-slice JSON');
    assertEq(r!.verdict, 'PASS', 'verdict from wrapped JSON');
  });

  await step('coerces stringified line + uppercases verdict; drops bad findings', async () => {
    const json = JSON.stringify({
      summary: 's',
      concerns: 'c',
      verdict: 'blocking',
      findings: [
        { file: 'ok.ts', line: '12', severity: 'error', note: 'good' },
        { file: '', line: 5, severity: 'error', note: 'empty file → drop' },
        { file: 'bad.ts', line: 0, severity: 'error', note: 'zero line → drop' },
        { file: 'bad2.ts', line: 3, severity: 'spicy', note: 'bad sev → drop' },
      ],
    });
    const r = parseStructuredReview(json);
    assert(r !== null, 'parsed');
    assertEq(r!.verdict, 'BLOCKING', 'verdict uppercased');
    assertEq(r!.findings.length, 1, 'only the fully-valid finding survives');
    assertEq(r!.findings[0].line, 12, 'stringified line coerced to int');
  });

  // ──────────────────────────────────────────── fail-safe (no throw) ──
  await step('FAIL-SAFE: non-conforming verdict → null (caller falls back to free text)', async () => {
    const r = parseStructuredReview(JSON.stringify({ summary: 's', concerns: 'c', verdict: 'LGTM', findings: [] }));
    assertEq(r, null, 'unknown verdict rejected');
  });

  await step('FAIL-SAFE: non-JSON text → null, no throw', async () => {
    assertEq(parseStructuredReview('## Summary\nplain prose, no JSON at all'), null, 'plain prose → null');
    assertEq(parseStructuredReview(''), null, 'empty → null');
  });

  // ──────────────────────────────── round-trip into the EXISTING parsers ──
  await step('ROUND-TRIP: reconstructed body re-parses via parseReviewFindings + verdict regex', async () => {
    const r = parseStructuredReview(JSON.stringify({
      summary: 'Added an endpoint and a migration.',
      concerns: 'Seed references a category that may not exist.',
      verdict: 'BLOCKING',
      findings: [{ file: 'db/seed.sql', line: 3, severity: 'error', note: 'unknown category id' }],
    }))!;
    const body = reconstructStructuredReview(r);
    // The downstream findings parser (byte-identical client mirror) must still work.
    const findings = parseReviewFindings(body);
    assertEq(findings.length, 1, 'reconstructed findings block re-parsed');
    assertEq(findings[0].file, 'db/seed.sql', 'finding survives the round-trip');
    // And the free-text verdict regex still lands (belt + suspenders for any
    // path that reads the artifact instead of the lifted verdict).
    assertEq(detectVerdict(body), 'BLOCKING', 'verdict regex still matches reconstructed body');
    assert(body.includes('## Summary') && body.includes('## Concerns') && body.includes('## Verdict'),
      'canonical three-section markdown preserved');
  });

  await step('ROUND-TRIP: empty findings → no fenced block, body still valid', async () => {
    const r = parseStructuredReview(JSON.stringify({ summary: 's', concerns: 'None.', verdict: 'PASS', findings: [] }))!;
    const body = reconstructStructuredReview(r);
    assertEq(parseReviewFindings(body).length, 0, 'no findings block when findings empty');
    assertEq(detectVerdict(body), 'PASS', 'verdict still parses');
  });

  // ──────────────────────────────────────────── wire gate (format vs tools) ──
  await step('GATE: format attaches to the body only on a TOOL-FREE turn', async () => {
    const schema = REVIEW_FORMAT_SCHEMA as Record<string, unknown>;
    const withTools = buildFormatField(schema, [{ function: { name: 'Read' } }]);
    assertEq(Object.keys(withTools).length, 0, 'format suppressed when tools are advertised');
    const toolFree = buildFormatField(schema, undefined);
    assert('format' in toolFree, 'format present on a tool-free turn');
    const noFormat = buildFormatField(undefined, undefined);
    assertEq(Object.keys(noFormat).length, 0, 'normal turn (no format) attaches nothing');
  });

  summary('M5 structured-output');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
