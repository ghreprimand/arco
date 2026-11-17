// Unit tests for classifyCodeSkew (H43 — code-skew banner).
//
// The git-reading wrappers are environment-bound; the decision logic is pure and
// is what the probe's correctness rests on: dev → skipped, no-checkout → skipped,
// same rev → ok, N commits behind → warn with the count, non-linear drift → warn.
//
// Run with: node --import tsx --test src/diagnostics/codeSkew.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, devNull } from 'node:os';
import { join } from 'node:path';
import { classifyCodeSkew } from './codeSkew.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('dev runtime → skipped (source is live)', () => {
  const r = classifyCodeSkew({ dev: true, bootRev: A, headRev: B, behind: 5 });
  assert.equal(r.status, 'skipped');
  assert.match(r.detail, /tsx watch/);
});

test('not a git checkout → skipped', () => {
  const r = classifyCodeSkew({ dev: false, bootRev: null, headRev: null, behind: null });
  assert.equal(r.status, 'skipped');
});

test('boot rev == HEAD → ok (build current)', () => {
  const r = classifyCodeSkew({ dev: false, bootRev: A, headRev: A, behind: null });
  assert.equal(r.status, 'ok');
  assert.match(r.detail, /current/);
});

test('N commits behind → warn with count + rebuild hint', () => {
  const r = classifyCodeSkew({ dev: false, bootRev: A, headRev: B, behind: 3 });
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /3 commits behind/);
  assert.match(r.detail, /aaaaaaaa/); // short boot rev
  assert.match(r.detail, /bbbbbbbb/); // short HEAD rev
  assert.ok(r.hint && /rebuild/i.test(r.hint), 'carries a rebuild hint');
});

test('1 commit behind → singular phrasing', () => {
  const r = classifyCodeSkew({ dev: false, bootRev: A, headRev: B, behind: 1 });
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /1 commit behind/);
  assert.doesNotMatch(r.detail, /commits/);
});

test('HEAD differs but count uncomputable (rebase/reset) → generic warn', () => {
  const r = classifyCodeSkew({ dev: false, bootRev: A, headRev: B, behind: null });
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /changed since boot/);
});


test('startup revision probes keep a non-repository Git failure out of stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arco-no-git-'));
  try {
    const script = `
      import childProcess from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const exec = childProcess.execFileSync;
      // This fixture must never query the host's network identity.
      childProcess.execFileSync = (file, ...args) => {
        if (file === 'tailscale') throw new Error('network identity disabled in fixture');
        return exec(file, ...args);
      };
      syncBuiltinESMExports();
      const skew = await import(${JSON.stringify(new URL('./codeSkew.ts', import.meta.url).href)});
      const identity = await import(${JSON.stringify(new URL('../management/identity.ts', import.meta.url).href)});
      console.log(JSON.stringify({ boot: skew.getBootRev(), revision: identity.buildServiceInstanceDescriptor(process.env.GIT_DIR, 'fixture').gitRevision }));
    `;
    const child = spawnSync(process.execPath, ['--conditions', 'development', '--import', import.meta.resolve('tsx'), '--input-type', 'module', '--eval', script], {
      cwd: dir, encoding: 'utf8', timeout: 10_000,
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        HOME: dir, USERPROFILE: dir, ARCO_HOME: join(dir, 'state'),
        GIT_DIR: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull,
      },
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    assert.deepEqual(JSON.parse(child.stdout), { boot: null, revision: 'unknown' });
    assert.equal(child.stderr, '', 'expected Git absence must not print a fatal start-up line');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
