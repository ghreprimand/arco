import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

test('a required network namespace refuses the shared host network', (t) => {
  const bin = mkdtempSync(join(tmpdir(), 'arco-unshare-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, 'unshare'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, ARCO_TEST_REQUIRE_NETNS: '1' };
  delete env.ARCO_BROWSER_NETNS_ACTIVE;
  delete env.ARCO_TEST_NETNS_ACTIVE;
  delete env.ARCO_TEST_NETNS;
  const result = spawnSync(process.execPath, ['scripts/smoke/run-browser-suites.mjs', 'topbar'], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /isolated network namespace is required/i);
});
