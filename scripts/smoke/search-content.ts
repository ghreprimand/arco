// Workbench Expansion A5 — Content-search smoke.
//
// Tests the MECHANISM directly (no WS, no LLM): calls searchContent against a
// temp dir and asserts the load-bearing behaviors:
//
//   1. A seeded token is found in the right file at the right line.
//   2. A matching file inside a SKIP_DIR (node_modules/) is NOT returned —
//      proves the ignore globs are wired.
//   3. A bogus binary path degrades gracefully ({ available:false }) — no
//      throw, no 500-equivalent. (Stands in for "rg not on PATH".)
//   4. An empty query returns an empty (but available) result.
//
// If `rg` isn't installed on the test host, the positive cases assert the
// available:false path instead (still a green run — the wrapper degrades the
// same way the bogus-binary case does).
//
// Run: npm run smoke:search-content  (no dev server needed)

import { step, assert, assertEq, summary } from './lib.js';
import { searchContent, RIPGREP_BIN } from '../../server/src/contentSearch.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = 'ARCHON_SEARCH_TOKEN_XYZZY';

async function main() {
  const cleanups: string[] = [];

  const dir = mkdtempSync(join(tmpdir(), 'archon-search-'));
  cleanups.push(dir);

  // A real source file with the token on a known line (line 2).
  writeFileSync(join(dir, 'real.txt'), `first line\nhas ${TOKEN} here\nthird line\n`);
  // A decoy with the same token but inside node_modules — must be ignored.
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'pkg', 'vendored.txt'), `${TOKEN} in vendored\n`);

  if (RIPGREP_BIN) {
    await step('seeded token is found in the right file + line', async () => {
      const r = await searchContent({ cwd: dir, query: TOKEN });
      assert(r.available, 'rg should be reported available');
      assert(r.hits.length >= 1, 'should find at least one hit');
      const real = r.hits.find((h) => h.file === 'real.txt');
      assert(!!real, `expected a hit in real.txt, got: ${r.hits.map((h) => h.file).join(', ')}`);
      assertEq(real!.line, 2, 'token is on line 2 of real.txt');
      assert(real!.text.includes(TOKEN), 'hit text should contain the token');
    });

    await step('SKIP_DIR (node_modules) hit is NOT returned', async () => {
      const r = await searchContent({ cwd: dir, query: TOKEN });
      const vendored = r.hits.find((h) => h.file.includes('node_modules'));
      assert(!vendored, `node_modules hit should be ignored, got: ${JSON.stringify(vendored)}`);
    });

    await step('empty query returns an empty, available result', async () => {
      const r = await searchContent({ cwd: dir, query: '' });
      assert(r.available, 'empty query is still available');
      assertEq(r.hits.length, 0, 'empty query yields no hits');
    });
  } else {
    await step('rg absent: searchContent degrades to available:false', async () => {
      const r = await searchContent({ cwd: dir, query: TOKEN });
      assert(!r.available, 'missing rg should report available:false');
      assertEq(r.hits.length, 0, 'no hits without rg');
    });
  }

  await step('bogus binary path degrades gracefully (no throw)', async () => {
    const r = await searchContent({
      cwd: dir,
      query: TOKEN,
      bin: join(dir, 'definitely-not-a-real-binary'),
    });
    assert(!r.available, 'bogus binary should report available:false');
    assertEq(r.hits.length, 0, 'no hits from a bogus binary');
  });

  for (const d of cleanups) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  summary('A5 search-content');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
