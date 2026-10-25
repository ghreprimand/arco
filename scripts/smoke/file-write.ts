// Workbench Expansion A6 — File-write smoke.
//
// Tests the MECHANISM directly (no WS, no LLM): calls writeFileWithinCwd —
// the exact core the POST /api/files/write route uses — against a temp cwd and
// asserts the load-bearing security behavior:
//
//   1. A write to a plain file inside cwd succeeds and the bytes land.
//   2. A nested write into a fresh subdir inside cwd succeeds (parent mkdir).
//   3. Every path-escape attempt is REJECTED (ok:false, status 400) and NO
//      file is written outside cwd:
//        - relative `../escape.txt`
//        - absolute path under tmpdir but outside cwd
//        - traversal that cancels back out: `foo/../../escape.txt`
//
// The escape cases are the heart of the phase: a regression here lets a
// fat-fingered or agent-suggested path write outside the project. We assert
// both the rejection AND the absence of the file on disk.
//
// Run: npm run smoke:file-write  (no dev server needed)

import { step, assert, assertEq, summary } from './lib.js';
import { writeFileWithinCwd } from '../../server/src/http/fileWriteRoutes.js';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

async function main() {
  const cleanups: string[] = [];

  // A workflow cwd, plus a sibling "outside" dir to prove escapes can't reach
  // it. Both live under tmpdir; the sibling is NOT under cwd.
  const root = mkdtempSync(join(tmpdir(), 'arco-fw-'));
  cleanups.push(root);
  const cwd = join(root, 'project');
  const outside = join(root, 'outside');
  // Make cwd exist (the helper creates files within it, not the dir itself).
  mkdirSync(cwd, { recursive: true });
  mkdirSync(outside, { recursive: true });

  await step('write inside cwd succeeds and bytes land', async () => {
    const r = await writeFileWithinCwd(cwd, 'foo.txt', 'hello world');
    assert(r.ok, `expected ok, got ${JSON.stringify(r)}`);
    assertEq(r.status, 200, 'status 200 on success');
    assert(existsSync(join(cwd, 'foo.txt')), 'foo.txt should exist');
    assertEq(readFileSync(join(cwd, 'foo.txt'), 'utf8'), 'hello world', 'content matches');
  });

  await step('nested write creates parent dir inside cwd', async () => {
    const r = await writeFileWithinCwd(cwd, 'sub/dir/bar.txt', 'nested');
    assert(r.ok, `expected ok, got ${JSON.stringify(r)}`);
    assertEq(readFileSync(join(cwd, 'sub/dir/bar.txt'), 'utf8'), 'nested', 'nested content matches');
  });

  // ── The security cases. Each must be rejected AND leave no file outside cwd.

  await step('relative ../escape.txt is REJECTED, nothing written', async () => {
    const target = join(dirname(cwd), 'escape.txt'); // root/escape.txt — outside cwd
    const r = await writeFileWithinCwd(cwd, '../escape.txt', 'PWNED');
    assert(!r.ok, 'relative escape must be rejected');
    assertEq(r.status, 400, 'rejection is a 400');
    assert(!existsSync(target), `no file should be written at ${target}`);
  });

  await step('absolute path outside cwd is REJECTED, nothing written', async () => {
    const target = join(outside, 'escape-abs.txt');
    const r = await writeFileWithinCwd(cwd, target, 'PWNED');
    assert(!r.ok, 'absolute escape must be rejected');
    assertEq(r.status, 400, 'rejection is a 400');
    assert(!existsSync(target), `no file should be written at ${target}`);
  });

  await step('traversal foo/../../escape.txt is REJECTED, nothing written', async () => {
    const target = join(dirname(cwd), 'escape.txt');
    const r = await writeFileWithinCwd(cwd, 'foo/../../escape.txt', 'PWNED');
    assert(!r.ok, 'traversal escape must be rejected');
    assertEq(r.status, 400, 'rejection is a 400');
    assert(!existsSync(target), `no file should be written at ${target}`);
  });

  await step('empty path is rejected', async () => {
    const r = await writeFileWithinCwd(cwd, '', 'x');
    assert(!r.ok && r.status === 400, 'empty path → 400');
  });

  for (const d of cleanups) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  summary('A6 file-write');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
