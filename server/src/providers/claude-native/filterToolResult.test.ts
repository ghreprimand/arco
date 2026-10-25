// EFFICIENCY_PLAN.md Phase C — round-trip golden-input tests for the filter
// packs. Run with: `npm run test:filters -w server` (which invokes node
// --test --import tsx).
//
// Acceptance from §7e:
//   - cargo-test green (200-line passing) → ~5 lines, no `... ok` rows
//   - cargo-test red (3 failures) → every FAILED line preserved + first
//     5 lines per failure body verbatim
//   - jest/vitest, pytest, git-status, find/grep/ls — basic shape parity

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFilterPipeline } from './filterToolResult.js';
import { bashCargoTest } from './filterConfigs/bash-cargo-test.js';
import { bashJestVitest } from './filterConfigs/bash-jest-vitest.js';
import { bashPytest } from './filterConfigs/bash-pytest.js';
import { bashGitStatus } from './filterConfigs/bash-git-status.js';
import { bashFind } from './filterConfigs/bash-find.js';
import { bashGrep } from './filterConfigs/bash-grep.js';
import { bashLs } from './filterConfigs/bash-ls.js';
import { resolveFilterPack } from './filterConfigs/index.js';

// ── cargo test ────────────────────────────────────────────────────────────

function makeCargoTestGreen(n: number): string {
  const lines: string[] = [];
  lines.push('   Compiling foo v0.1.0 (/work/foo)');
  lines.push('    Finished test [unoptimized + debuginfo] target(s) in 1.23s');
  lines.push('     Running unittests src/lib.rs (target/debug/deps/foo-abc)');
  lines.push('');
  lines.push(`running ${n} tests`);
  for (let i = 0; i < n; i++) lines.push(`test tests::case_${i} ... ok`);
  lines.push('');
  lines.push(`test result: ok. ${n} passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.42s`);
  lines.push('');
  return lines.join('\n');
}

function makeCargoTestRed(passing: number, failing: number): string {
  const lines: string[] = [];
  lines.push('   Compiling foo v0.1.0 (/work/foo)');
  lines.push(`running ${passing + failing} tests`);
  for (let i = 0; i < passing; i++) lines.push(`test tests::ok_${i} ... ok`);
  for (let i = 0; i < failing; i++) lines.push(`test tests::bad_${i} ... FAILED`);
  lines.push('');
  lines.push('failures:');
  lines.push('');
  for (let i = 0; i < failing; i++) {
    lines.push(`---- tests::bad_${i} stdout ----`);
    lines.push(`thread 'tests::bad_${i}' panicked at src/lib.rs:42:5:`);
    lines.push(`assertion \`left == right\` failed`);
    lines.push(`  left: 1`);
    lines.push(` right: 2`);
    lines.push(`note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace`);
    lines.push('');
  }
  lines.push(`test result: FAILED. ${passing} passed; ${failing} failed; 0 ignored;`);
  return lines.join('\n');
}

test('cargo-test: green run drops every "... ok" row', () => {
  const raw = makeCargoTestGreen(200);
  const r = runFilterPipeline(raw, 0, bashCargoTest);
  assert.ok(r.filteredBytes < r.originalBytes, 'should shrink');
  assert.equal(r.filtered.split('\n').filter((l) => /\.\.\. ok$/.test(l)).length, 0, 'no per-test ok lines');
  // Summary header / footer lines survive.
  assert.match(r.filtered, /running 200 tests/);
  assert.match(r.filtered, /test result: ok\./);
  // ~5 substantive lines (header + Compiling + Finished + Running + summary
  // + a handful of blanks). Allow generously.
  const nonBlank = r.filtered.split('\n').filter((l) => l.trim().length > 0);
  assert.ok(nonBlank.length <= 8, `green run should compress to ~5 substantive lines, got ${nonBlank.length}`);
});

test('cargo-test: red run preserves every FAILED + first 5 lines per failure', () => {
  const raw = makeCargoTestRed(50, 3);
  const r = runFilterPipeline(raw, 1, bashCargoTest);
  // Every FAILED line survives.
  const failedLines = r.filtered.split('\n').filter((l) => /\.\.\. FAILED$/.test(l));
  assert.equal(failedLines.length, 3, 'every FAILED line preserved');
  // Each `---- … stdout ----` header survives.
  assert.equal(r.filtered.match(/---- tests::bad_\d+ stdout ----/g)?.length, 3);
  // First 5 lines of each failure body verbatim — the panic, assertion,
  // left, right, and the note line.
  assert.match(r.filtered, /thread 'tests::bad_0' panicked at src\/lib\.rs:42:5:/);
  assert.match(r.filtered, /assertion `left == right` failed/);
  assert.match(r.filtered, /  left: 1/);
  assert.match(r.filtered, / right: 2/);
});

// ── jest / vitest ─────────────────────────────────────────────────────────

test('jest-vitest: green run drops PASS lines', () => {
  const lines: string[] = [];
  lines.push('PASS  src/foo.test.ts');
  for (let i = 0; i < 100; i++) lines.push(`  ✓ should do thing ${i}`);
  lines.push('');
  lines.push('Tests:       100 passed, 100 total');
  lines.push('Time:        0.5s');
  const raw = lines.join('\n');
  const r = runFilterPipeline(raw, 0, bashJestVitest);
  assert.equal(r.filtered.split('\n').filter((l) => /^\s*✓/.test(l)).length, 0);
  assert.match(r.filtered, /Tests:\s+100 passed/);
});

test('jest-vitest: red run preserves ✗ lines + summary', () => {
  const raw = [
    'FAIL src/bad.test.ts',
    '  ✗ should compute (1 ms)',
    '    Expected: 2',
    '    Received: 1',
    '    at Object.<anonymous> (src/bad.test.ts:5:3)',
    '',
    '  ● bad › should compute',
    '    Expected: 2',
    'Tests:       0 passed, 1 failed, 1 total',
  ].join('\n');
  const r = runFilterPipeline(raw, 1, bashJestVitest);
  assert.match(r.filtered, /✗ should compute/);
  assert.match(r.filtered, /Tests:\s+0 passed, 1 failed/);
});

// ── pytest ────────────────────────────────────────────────────────────────

test('pytest: green run drops PASSED rows, keeps session header + summary', () => {
  const lines: string[] = [];
  lines.push('platform linux -- Python 3.11.0, pytest-7.4.0');
  lines.push('rootdir: /work');
  lines.push('collected 200 items');
  for (let i = 0; i < 200; i++) lines.push(`tests/test_x.py::test_${i} PASSED                     [  1%]`);
  lines.push('============== 200 passed in 1.23s ===============');
  const raw = lines.join('\n');
  const r = runFilterPipeline(raw, 0, bashPytest);
  assert.equal(r.filtered.split('\n').filter((l) => /\bPASSED\b/.test(l)).length, 0);
  assert.match(r.filtered, /platform linux/);
  assert.match(r.filtered, /200 passed/);
});

test('pytest: red run preserves FAILURES section + FAILED markers', () => {
  const lines: string[] = [];
  lines.push('collected 5 items');
  lines.push('tests/test_x.py::test_a PASSED                       [ 20%]');
  lines.push('tests/test_x.py::test_b FAILED                       [ 40%]');
  lines.push('=================================== FAILURES ===================================');
  lines.push('___________________________________ test_b ___________________________________');
  lines.push('');
  lines.push('    def test_b():');
  lines.push('>       assert 1 == 2');
  lines.push('E       assert 1 == 2');
  lines.push('');
  lines.push('=========================== short test summary info ============================');
  lines.push('FAILED tests/test_x.py::test_b - assert 1 == 2');
  const raw = lines.join('\n');
  const r = runFilterPipeline(raw, 1, bashPytest);
  assert.match(r.filtered, /test_b FAILED/);
  assert.match(r.filtered, /=== FAILURES ===/);
  assert.match(r.filtered, /assert 1 == 2/);
});

// ── git status ────────────────────────────────────────────────────────────

test('git-status: drops banner + hint lines, keeps porcelain paths', () => {
  const raw = [
    'On branch main',
    'Your branch is up to date with \'origin/main\'.',
    '',
    'Changes not staged for commit:',
    '  (use "git add <file>..." to update what will be committed)',
    '  (use "git restore <file>..." to discard changes in working directory)',
    '\tmodified:   src/foo.ts',
    '\tmodified:   src/bar.ts',
    '',
    'no changes added to commit (use "git add" and/or "git commit -a")',
  ].join('\n');
  const r = runFilterPipeline(raw, 0, bashGitStatus);
  assert.doesNotMatch(r.filtered, /^On branch /m);
  assert.doesNotMatch(r.filtered, /\(use "git/);
  assert.match(r.filtered, /modified:\s+src\/foo\.ts/);
  assert.match(r.filtered, /modified:\s+src\/bar\.ts/);
});

// ── find / grep / ls — head_cap behaviour ────────────────────────────────

test('find: head_cap on huge listings; truncation marker present', () => {
  const lines: string[] = [];
  for (let i = 0; i < 5000; i++) lines.push(`./node_modules/foo-${i}/index.js`);
  const raw = lines.join('\n');
  const r = runFilterPipeline(raw, 0, bashFind);
  assert.ok(r.filteredBytes < r.originalBytes, 'should head_cap');
  assert.match(r.filtered, /\[\.\.\. \d+ bytes truncated/);
});

test('find: branch_on_exit flips to tail_cap on failure', () => {
  const lines: string[] = [];
  for (let i = 0; i < 5000; i++) lines.push(`./node_modules/foo-${i}/index.js`);
  lines.push('find: ‘/etc/secrets’: Permission denied');
  const raw = lines.join('\n');
  const r = runFilterPipeline(raw, 1, bashFind);
  assert.match(r.filtered, /Permission denied/);
  assert.match(r.filtered, /tail_cap/);
});

test('grep: head_cap on huge match list', () => {
  const lines: string[] = [];
  for (let i = 0; i < 4000; i++) lines.push(`src/foo.ts:${i}: some_match()`);
  const raw = lines.join('\n');
  const r = runFilterPipeline(raw, 0, bashGrep);
  assert.ok(r.filteredBytes < r.originalBytes);
});

test('ls: head_cap on big directory', () => {
  const lines: string[] = [];
  for (let i = 0; i < 3000; i++) lines.push(`-rw-r--r-- 1 operator operator 1234 May  9 file_${i}.txt`);
  const raw = lines.join('\n');
  const r = runFilterPipeline(raw, 0, bashLs);
  assert.ok(r.filteredBytes < r.originalBytes);
});

// ── dispatcher ────────────────────────────────────────────────────────────

test('resolveFilterPack: off mode returns null', () => {
  assert.equal(resolveFilterPack('Bash', { command: 'cargo test' }, 'off'), null);
});

test('resolveFilterPack: matches cargo test / git status / find / grep / ls / pytest / jest', () => {
  const conservative = 'conservative' as const;
  assert.equal(resolveFilterPack('Bash', { command: 'cargo test' }, conservative)?.name, 'cargo-test-drop-passing');
  assert.equal(resolveFilterPack('Bash', { command: 'sudo cargo test' }, conservative)?.name, 'cargo-test-drop-passing');
  assert.equal(resolveFilterPack('Bash', { command: 'git status' }, conservative)?.name, 'git-status-trim-hints');
  assert.equal(resolveFilterPack('Bash', { command: 'find . -name "*.ts"' }, conservative)?.name, 'find-head-cap');
  assert.equal(resolveFilterPack('Bash', { command: 'rg foo src/' }, conservative)?.name, 'grep-head-cap');
  assert.equal(resolveFilterPack('Bash', { command: 'ls -la' }, conservative)?.name, 'ls-head-cap');
  assert.equal(resolveFilterPack('Bash', { command: 'pytest tests/' }, conservative)?.name, 'pytest-drop-passing');
  assert.equal(resolveFilterPack('Bash', { command: 'jest --coverage' }, conservative)?.name, 'jest-vitest-drop-passing');
  assert.equal(resolveFilterPack('Bash', { command: 'npx vitest run' }, conservative)?.name, 'jest-vitest-drop-passing');
});

test('resolveFilterPack: unknown commands pass through', () => {
  assert.equal(resolveFilterPack('Bash', { command: 'echo hello' }, 'conservative'), null);
  assert.equal(resolveFilterPack('Read', { file_path: '/x' }, 'conservative'), null);
});

// ── reversibility / cache invariant ───────────────────────────────────────

test('originalBytes always equals raw input size; filteredBytes equals filtered size', () => {
  const raw = 'hello world\nhello world\nhello world\nhello world\nhello world\n';
  const r = runFilterPipeline(raw, 0, { name: 'dedup-test', dedup: true });
  assert.equal(r.originalBytes, Buffer.byteLength(raw, 'utf8'));
  assert.equal(r.filteredBytes, Buffer.byteLength(r.filtered, 'utf8'));
  // Three+ consecutive identical lines collapse.
  assert.match(r.filtered, /\(x5\)/);
});

test('passthrough pack: byte counts identical when nothing fires', () => {
  const raw = 'plain text\nno changes here\n';
  const r = runFilterPipeline(raw, 0, { name: 'noop' });
  assert.equal(r.filtered, raw);
  assert.equal(r.originalBytes, r.filteredBytes);
});
