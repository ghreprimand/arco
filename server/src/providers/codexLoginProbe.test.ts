// `codex login status` answers "Not logged in" on a clean home; the probe must
// not read that as signed in (found by the Docker smoke on a fresh volume).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { probeCodexLoggedIn } from './codex.js';

async function withFakeCodex(output: string, exitCode: number, run: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'codex-probe-'));
  const previous = process.env.PATH;
  writeFileSync(join(dir, 'codex'), `#!/bin/sh\necho '${output}'\nexit ${exitCode}\n`);
  chmodSync(join(dir, 'codex'), 0o755);
  process.env.PATH = `${dir}${delimiter}${previous ?? ''}`;
  try { await run(); } finally { process.env.PATH = previous; rmSync(dir, { recursive: true, force: true }); }
}

test('a "Not logged in" answer is reported as signed out', { skip: process.platform === 'win32' }, async () => {
  await withFakeCodex('Not logged in', 1, async () => {
    assert.equal((await probeCodexLoggedIn()).loggedIn, false);
  });
});

test('a "Logged in using ChatGPT" answer is reported as signed in', { skip: process.platform === 'win32' }, async () => {
  await withFakeCodex('Logged in using ChatGPT', 0, async () => {
    assert.equal((await probeCodexLoggedIn()).loggedIn, true);
  });
});
