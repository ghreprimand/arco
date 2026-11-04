// Workbench Expansion I4 — GitHub PR-create + diff-reconstruction unit smoke.
//
// PURE unit test — NO live `gh`, NO network, NO real PR. Creating a PR is an
// outward side effect; this harness never performs one. It exercises the two
// pure helpers the feature is built on:
//
//   (1) buildCreatePrRequest (server/src/github.ts) — shapes the REST call and
//       validates operator input. Asserts the correct {path, method, body} for
//       valid input (operator text rides the JSON body, NOT a shell/argv string)
//       and that empty title/base/head throw PrValidationError.
//   (2) ghFilesToUnifiedDiff / ghFilesWithoutPatch (client GhPullFile diff
//       reconstruction) — GitHub's bare-hunk patches → parseable unified diff.
//       Asserts the synthetic git headers, /dev/null for add/remove, the
//       a/old b/new header for renames, and that binary/no-patch files are
//       excluded from the rendered patch.
//
// Run: npm run smoke:github-pr  (no dev server needed)

import { step, assert, assertEq, summary } from './lib.js';
import { buildCreatePrRequest, PrValidationError } from '../../server/src/github.js';
import { ghFilesToUnifiedDiff, ghFilesWithoutPatch, ghFileToUnifiedDiff } from '../../client/src/components/GitHubPanel/ghDiff.js';
import type { GhPullFile } from '../../client/src/components/GitHubPanel/types.js';

function expectThrows(fn: () => unknown, msg: string) {
  let threw = false;
  try { fn(); } catch (e) { threw = e instanceof PrValidationError; }
  assert(threw, msg);
}

async function main() {
  // ── buildCreatePrRequest ──
  await step('buildCreatePrRequest: valid input → REST body (not a shell string)', () => {
    const r = buildCreatePrRequest('o', 'n', { title: 'Add X', base: 'main', head: 'feat', body: 'why' });
    assertEq(r.path, '/repos/o/n/pulls', 'path');
    assertEq(r.method, 'POST', 'method');
    assertEq(r.body.title, 'Add X', 'title in body');
    assertEq(r.body.base, 'main', 'base in body');
    assertEq(r.body.head, 'feat', 'head in body');
    assertEq(r.body.body, 'why', 'body in body');
  });

  await step('buildCreatePrRequest: title starting with `-` is safe operator text in JSON', () => {
    const r = buildCreatePrRequest('o', 'n', { title: '-rf danger', base: 'main', head: 'feat' });
    // It lands verbatim in the JSON body — never an argv flag.
    assertEq(r.body.title, '-rf danger', 'leading-dash title preserved in body');
    assert(!('body' in r.body) || r.body.body === undefined, 'omits empty body');
  });

  await step('buildCreatePrRequest: trims whitespace', () => {
    const r = buildCreatePrRequest('o', 'n', { title: '  T  ', base: ' main ', head: ' h ', body: '   ' });
    assertEq(r.body.title, 'T', 'trimmed title');
    assertEq(r.body.base, 'main', 'trimmed base');
    assertEq(r.body.head, 'h', 'trimmed head');
    assertEq(r.body.body, undefined, 'whitespace-only body omitted');
  });

  await step('buildCreatePrRequest: empty title/base/head rejected', () => {
    expectThrows(() => buildCreatePrRequest('o', 'n', { title: '', base: 'main', head: 'h' }), 'empty title throws');
    expectThrows(() => buildCreatePrRequest('o', 'n', { title: 'T', base: '', head: 'h' }), 'empty base throws');
    expectThrows(() => buildCreatePrRequest('o', 'n', { title: 'T', base: 'main', head: '' }), 'empty head throws');
    expectThrows(() => buildCreatePrRequest('o', 'n', { title: '   ', base: 'main', head: 'h' }), 'whitespace title throws');
  });

  // ── diff reconstruction ──
  const sample: GhPullFile[] = [
    { sha: '1', filename: 'src/mod.ts', status: 'modified', additions: 1, deletions: 1, changes: 2, patch: '@@ -1,2 +1,2 @@\n-old\n+new\n line' },
    { sha: '2', filename: 'src/new.ts', status: 'added', additions: 1, deletions: 0, changes: 1, patch: '@@ -0,0 +1 @@\n+hello' },
    { sha: '3', filename: 'src/gone.ts', status: 'removed', additions: 0, deletions: 1, changes: 1, patch: '@@ -1 +0,0 @@\n-bye' },
    { sha: '4', filename: 'src/renamed.ts', previous_filename: 'src/old-name.ts', status: 'renamed', additions: 0, deletions: 0, changes: 0, patch: '@@ -1 +1 @@\n-a\n+a2' },
    { sha: '5', filename: 'assets/logo.png', status: 'modified', additions: 0, deletions: 0, changes: 0, blob_url: 'https://github.com/x/logo.png' }, // no patch
  ];

  await step('ghFileToUnifiedDiff: modified file gets a/old b/new header', () => {
    const d = ghFileToUnifiedDiff(sample[0])!;
    assert(d.startsWith('diff --git a/src/mod.ts b/src/mod.ts\n'), 'git header');
    assert(d.includes('--- a/src/mod.ts\n'), '--- header');
    assert(d.includes('+++ b/src/mod.ts\n'), '+++ header');
    assert(d.includes('@@ -1,2 +1,2 @@'), 'hunk preserved');
  });

  await step('ghFileToUnifiedDiff: added file uses /dev/null as old side', () => {
    const d = ghFileToUnifiedDiff(sample[1])!;
    assert(d.includes('--- /dev/null\n'), 'added → --- /dev/null');
    assert(d.includes('+++ b/src/new.ts\n'), 'added → +++ b/new');
  });

  await step('ghFileToUnifiedDiff: removed file uses /dev/null as new side', () => {
    const d = ghFileToUnifiedDiff(sample[2])!;
    assert(d.includes('--- a/src/gone.ts\n'), 'removed → --- a/old');
    assert(d.includes('+++ /dev/null\n'), 'removed → +++ /dev/null');
  });

  await step('ghFileToUnifiedDiff: rename uses previous_filename for old path', () => {
    const d = ghFileToUnifiedDiff(sample[3])!;
    assert(d.startsWith('diff --git a/src/old-name.ts b/src/renamed.ts\n'), 'rename git header');
    assert(d.includes('--- a/src/old-name.ts\n'), 'rename old path');
    assert(d.includes('+++ b/src/renamed.ts\n'), 'rename new path');
  });

  await step('ghFileToUnifiedDiff: binary/no-patch returns null', () => {
    assertEq(ghFileToUnifiedDiff(sample[4]), null, 'no patch → null');
  });

  await step('ghFilesToUnifiedDiff: concatenates only files with a patch', () => {
    const all = ghFilesToUnifiedDiff(sample);
    assert(all.includes('a/src/mod.ts'), 'includes modified');
    assert(all.includes('a/src/new.ts') || all.includes('b/src/new.ts'), 'includes added');
    assert(all.includes('a/src/old-name.ts'), 'includes rename');
    assert(!all.includes('assets/logo.png'), 'excludes binary/no-patch file');
    // Four files have a patch → four git headers.
    assertEq((all.match(/diff --git /g) || []).length, 4, 'four reconstructed files');
  });

  await step('ghFilesWithoutPatch: only the binary/no-patch file', () => {
    const np = ghFilesWithoutPatch(sample);
    assertEq(np.length, 1, 'one no-patch file');
    assertEq(np[0].filename, 'assets/logo.png', 'the binary file');
  });

  summary('github-pr');
}

main();
