// Workbench Expansion D1 — context-refs smoke.
//
// Tests the MECHANISM directly (no WS, no LLM, no server boot):
//
//   (A) The PURE client parser (client/src/components/composer/contextRefs.ts):
//       extracts @file:path / @diff / @staged / @git:N; edge-cases @file: with
//       no path, @git:abc (non-numeric → not a git ref), and classifies @url:
//       as a known kind.
//   (B) The SERVER expander (server/src/contextRefs.ts) against the REAL Archon
//       repo (this very checkout is a git repo with real files):
//         - @file:package.json → real package.json contents appear, bounded.
//         - @diff → runs (a diff or a clean "no changes" notice; never throws).
//         - @git:2 → the last 2 commit subjects appear.
//         - @file:../../etc/passwd → refused with a "path not allowed" notice.
//         - an oversized temp file → truncated with the "[truncated N bytes]"
//           notice (acceptance requires this).
//         - @url:… → recognized-but-deferred notice (not an error, not dropped).
//
// Run: npm run smoke:context-refs  (no dev server needed)

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { step, assert, assertEq, summary } from './lib.js';
import { parseContextRefs } from '../../client/src/components/composer/contextRefs.js';
import { expandContextRefs, MAX_CONTEXT_REF_BYTES } from '../../server/src/contextRefs.js';

// Resolve the repo root from this script's location (scripts/smoke/ → ../..).
// tsx may load this as ESM (import.meta.url) or transpile to CJS (__dirname);
// support both, mirroring scripts/docs-check.ts.
const SCRIPT_DIR =
  typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, '..', '..');

async function main() {
  const cleanups: string[] = [];

  // ──────────────────────────────────────────────────────────── (A) PARSER ──
  await step('parser extracts each supported ref kind', async () => {
    const refs = parseContextRefs('look at @file:src/x.ts then @diff and @staged plus @git:3');
    const byKind = (k: string) => refs.filter((r) => r.kind === k);
    assertEq(byKind('file').length, 1, 'one @file');
    assertEq(byKind('file')[0].arg, 'src/x.ts', '@file arg parsed');
    assertEq(byKind('diff').length, 1, 'one @diff');
    assertEq(byKind('staged').length, 1, 'one @staged');
    assertEq(byKind('git').length, 1, 'one @git');
    assertEq(byKind('git')[0].count, 3, '@git:3 count parsed');
  });

  await step('parser edge-cases: bare @file:, @git:abc, @url:', async () => {
    // @file: with no path → NOT matched (requires \S+ after the colon).
    assertEq(parseContextRefs('@file:').length, 0, '@file: with no path is not a ref');
    assertEq(parseContextRefs('text @file: more').length, 0, '@file: mid-sentence with no path is not a ref');
    // @git:abc → NOT a git ref (digits only). Nothing else matches it either.
    assertEq(parseContextRefs('@git:abc').length, 0, '@git:abc is not a ref');
    // @url: IS recognized as a known kind (so the chip renders + grammar stable).
    const urlRefs = parseContextRefs('see @url:https://example.com/x');
    assertEq(urlRefs.length, 1, 'one @url ref recognized');
    assertEq(urlRefs[0].kind, 'url', '@url classified as url kind');
    assertEq(urlRefs[0].arg, 'https://example.com/x', '@url arg parsed');
  });

  await step('parser does not match mid-token @ (email / scope)', async () => {
    assertEq(parseContextRefs('mail me at a@file:x.ts').length, 0, '@ must be at a word boundary');
  });

  await step('parser reports offsets that round-trip', async () => {
    const text = 'prefix @diff suffix';
    const refs = parseContextRefs(text);
    assertEq(refs.length, 1, 'one ref');
    assertEq(text.slice(refs[0].start, refs[0].end), '@diff', 'offsets bracket the raw ref');
  });

  // ─────────────────────────────────────────────────── (B) SERVER EXPANSION ──
  await step('@file:package.json expands to real contents (bounded)', async () => {
    const exp = await expandContextRefs(REPO_ROOT, 'check @file:package.json');
    assertEq(exp.expandedCount, 1, 'one ref expanded');
    assert(exp.block.includes('--- Context (@file:package.json) ---'), 'block carries the file header');
    assert(exp.block.includes('"name"'), 'real package.json contents appear (has a "name" field)');
    assert(exp.notices.some((n) => n.includes('@file:package.json expanded')), 'notice records the expansion');
  });

  await step('@diff runs against the real repo (diff or clean notice, no throw)', async () => {
    const exp = await expandContextRefs(REPO_ROOT, 'review @diff');
    assertEq(exp.expandedCount, 1, '@diff expanded');
    assert(exp.block.includes('--- Context (@diff) ---'), 'block carries the diff header');
    // Either real diff text or the "(no changes)" sentinel — both are valid.
    assert(
      exp.notices.some((n) => n.includes('@diff expanded')),
      `@diff notice present (got ${JSON.stringify(exp.notices)})`,
    );
  });

  await step('@git:2 expands to the last 2 commit subjects', async () => {
    // Ground-truth: read the last 2 subjects straight from git.
    const subjects = execFileSync('git', ['log', '-n', '2', '--format=%s'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim().split('\n');
    const exp = await expandContextRefs(REPO_ROOT, 'context: @git:2');
    assertEq(exp.expandedCount, 1, '@git:2 expanded');
    assert(exp.block.includes('--- Context (@git:2 — last 2 commits) ---'), 'block carries the git header');
    for (const subj of subjects) {
      assert(exp.block.includes(subj), `block contains commit subject "${subj.slice(0, 40)}…"`);
    }
  });

  await step('@file path-traversal is refused (never read)', async () => {
    const exp = await expandContextRefs(REPO_ROOT, 'sneaky @file:../../etc/passwd');
    assertEq(exp.expandedCount, 0, 'no block produced for an escaping path');
    assertEq(exp.block, '', 'block is empty');
    assert(
      exp.notices.some((n) => n.includes('path not allowed')),
      `traversal refused with a notice (got ${JSON.stringify(exp.notices)})`,
    );
  });

  await step('@file absolute-outside path is refused', async () => {
    const exp = await expandContextRefs(REPO_ROOT, '@file:/etc/passwd');
    assertEq(exp.expandedCount, 0, 'no block for an absolute-outside path');
    assert(
      exp.notices.some((n) => n.includes('path not allowed')),
      `absolute-outside refused (got ${JSON.stringify(exp.notices)})`,
    );
  });

  await step('oversized @file is truncated with the [truncated N bytes] notice', async () => {
    const dir = mkdtempSync(join(REPO_ROOT, '.smoke-ctxrefs-'));
    cleanups.push(dir);
    const rel = join(dir.slice(REPO_ROOT.length + 1), 'big.txt');
    const big = 'x'.repeat(MAX_CONTEXT_REF_BYTES + 5000);
    writeFileSync(join(REPO_ROOT, rel), big);
    const exp = await expandContextRefs(REPO_ROOT, `@file:${rel}`);
    assertEq(exp.expandedCount, 1, 'oversized file still expands (truncated)');
    assert(exp.block.includes('… [truncated'), 'block carries the truncation marker');
    assert(
      exp.notices.some((n) => n.includes('truncated') && n.includes('over the')),
      `truncation notice present (got ${JSON.stringify(exp.notices)})`,
    );
    // Body length is bounded by the cap (plus the short truncation marker).
    assert(exp.block.length < MAX_CONTEXT_REF_BYTES + 500, 'expanded body is bounded by the cap');
  });

  await step('missing @file expands to a readable notice (no throw)', async () => {
    const exp = await expandContextRefs(REPO_ROOT, '@file:does/not/exist.xyz');
    assertEq(exp.expandedCount, 0, 'no block for a missing file');
    assert(
      exp.notices.some((n) => n.includes('not found')),
      `missing file noticed (got ${JSON.stringify(exp.notices)})`,
    );
  });

  await step('@url is recognized-but-deferred (notice, not error, not dropped)', async () => {
    const exp = await expandContextRefs(REPO_ROOT, 'fetch @url:https://example.com');
    assertEq(exp.expandedCount, 1, '@url produces a (deferral) block');
    assert(exp.block.includes('not yet supported'), 'block states @url is unsupported');
    assert(
      exp.notices.some((n) => n.includes('not yet supported')),
      `deferral notice present (got ${JSON.stringify(exp.notices)})`,
    );
  });

  await step('no refs → empty expansion (zero overhead)', async () => {
    const exp = await expandContextRefs(REPO_ROOT, 'just a plain prompt with no refs');
    assertEq(exp.expandedCount, 0, 'nothing expanded');
    assertEq(exp.block, '', 'empty block');
    assertEq(exp.notices.length, 0, 'no notices');
  });

  await step('@diff on a non-git directory degrades gracefully', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'archon-ctxrefs-plain-'));
    cleanups.push(plain);
    const exp = await expandContextRefs(plain, '@diff');
    assertEq(exp.expandedCount, 0, 'no block in a non-git dir');
    assert(
      exp.notices.some((n) => n.includes('not a git repository')),
      `non-git diff noticed (got ${JSON.stringify(exp.notices)})`,
    );
  });

  for (const dir of cleanups) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  summary('D1 context-refs');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
