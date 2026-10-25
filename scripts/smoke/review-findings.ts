// Workbench Expansion D5 — review-findings parser smoke.
//
// Tests the PURE parser directly (no WS, no LLM, no server boot):
// server/src/primitives/parseReviewFindings.ts. The client mirror
// (client/src/components/RightPanel/reviewFindings.ts) is kept byte-identical
// by hand, so exercising the server copy covers both.
//
// The load-bearing invariant is TOLERANCE: a valid fenced findings block
// parses into structured findings; an absent or malformed block falls back to
// ZERO findings while the prose is never touched (the caller still renders the
// body verbatim). We assert both halves.
//
// Run: npm run smoke:review-findings  (no dev server needed)

import { step, assert, assertEq, summary } from './lib.js';
import { parseReviewFindings } from '../../server/src/primitives/parseReviewFindings.js';

const PROSE = `## Summary
The agent added a new endpoint.

## Concerns
The handler doesn't validate input.

## Verdict
MINOR — works but needs validation.`;

async function main() {
  // ─────────────────────────────────────────────────── valid findings block ──
  await step('parses a well-formed findings block appended after prose', async () => {
    const body = `${PROSE}

\`\`\`findings
[
  { "file": "server/src/http/router.ts", "line": 42, "severity": "warning", "note": "missing input validation" },
  { "file": "server/src/index.ts", "line": 7, "severity": "info", "note": "consider a comment here" }
]
\`\`\`
`;
    const findings = parseReviewFindings(body);
    assertEq(findings.length, 2, 'two findings parsed');
    assertEq(findings[0].file, 'server/src/http/router.ts', 'file parsed');
    assertEq(findings[0].line, 42, 'line parsed');
    assertEq(findings[0].severity, 'warning', 'severity parsed');
    assert(findings[0].note.includes('validation'), 'note parsed');
    assertEq(findings[1].severity, 'info', 'second severity parsed');
  });

  await step('accepts a ```json-tagged block too', async () => {
    const body = `prose\n\n\`\`\`json\n[{ "file": "a.ts", "line": 1, "severity": "error", "note": "boom" }]\n\`\`\``;
    const findings = parseReviewFindings(body);
    assertEq(findings.length, 1, 'one finding from a json block');
    assertEq(findings[0].severity, 'error', 'error severity');
  });

  await step('uses the LAST block so an in-prose JSON example does not shadow it', async () => {
    const body = `Here's the shape:\n\n\`\`\`json\n[{ "file": "EXAMPLE.ts", "line": 1, "severity": "info", "note": "example" }]\n\`\`\`\n\nActual:\n\n\`\`\`findings\n[{ "file": "real.ts", "line": 9, "severity": "warning", "note": "real" }]\n\`\`\``;
    const findings = parseReviewFindings(body);
    assertEq(findings.length, 1, 'one finding (the last block wins)');
    assertEq(findings[0].file, 'real.ts', 'the real block, not the example');
  });

  await step('coerces common severity synonyms and stringified lines', async () => {
    const body = `\`\`\`findings\n[{ "file": "a.ts", "line": "12", "severity": "WARN", "note": "n" }]\n\`\`\``;
    const findings = parseReviewFindings(body);
    assertEq(findings.length, 1, 'one finding');
    assertEq(findings[0].line, 12, 'stringified line coerced to int');
    assertEq(findings[0].severity, 'warning', 'WARN → warning');
  });

  await step('drops individual invalid entries but keeps the valid ones', async () => {
    const body = `\`\`\`findings
[
  { "file": "ok.ts", "line": 5, "severity": "error", "note": "good" },
  { "file": "", "line": 5, "severity": "error", "note": "empty file → dropped" },
  { "file": "bad.ts", "line": 0, "severity": "error", "note": "zero line → dropped" },
  { "file": "bad2.ts", "line": 3, "severity": "spicy", "note": "bad severity → dropped" },
  { "file": "bad3.ts", "line": 3, "severity": "info" }
]
\`\`\``;
    const findings = parseReviewFindings(body);
    assertEq(findings.length, 1, 'only the one fully-valid finding survives');
    assertEq(findings[0].file, 'ok.ts', 'the valid finding');
  });

  // ──────────────────────────────────────────── prose-only fallback (tolerance) ──
  await step('PROSE FALLBACK: absent block → zero findings, no throw', async () => {
    const findings = parseReviewFindings(PROSE);
    assertEq(findings.length, 0, 'no findings when there is no block — prose still renders upstream');
  });

  await step('PROSE FALLBACK: malformed JSON in the block → zero findings, no throw', async () => {
    const body = `${PROSE}\n\n\`\`\`findings\n[ { "file": "a.ts", "line": 1,  // not valid JSON\n\`\`\``;
    const findings = parseReviewFindings(body);
    assertEq(findings.length, 0, 'malformed JSON degrades to zero findings');
  });

  await step('PROSE FALLBACK: a non-array JSON block → zero findings', async () => {
    const body = `\`\`\`findings\n{ "file": "a.ts", "line": 1, "severity": "info", "note": "n" }\n\`\`\``;
    const findings = parseReviewFindings(body);
    assertEq(findings.length, 0, 'a JSON object (not array) yields zero findings');
  });

  await step('empty / undefined body → zero findings (no throw)', async () => {
    assertEq(parseReviewFindings('').length, 0, 'empty string');
    // @ts-expect-error — exercising the defensive guard against a non-string.
    assertEq(parseReviewFindings(undefined).length, 0, 'undefined is tolerated');
  });

  summary('D5 review-findings');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
