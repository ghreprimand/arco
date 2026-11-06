// The local-model Bash tool (Ollama, llama.cpp, LM Studio) runs in the same
// shell as Claude Native: /bin/sh on Linux and macOS, Git Bash on Windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeOllamaTool } from './ollamaTools.js';
import { _setCommandShellForTest } from '../commandShell.js';

test('the local-model Bash tool runs in the platform shell, ends the tree on timeout, and names a missing shell', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-local-bash-'));
  try {
    const ok = await executeOllamaTool('Bash', { command: 'echo hello; exit 4' }, { cwd });
    assert.match(ok, /exit code: 4/);
    assert.match(ok, /hello/);
    const started = Date.now();
    const slow = await executeOllamaTool('Bash', { command: 'sleep 30 & sleep 30', timeout: 1000 }, { cwd });
    assert.match(slow, /^\[timed out after 1000ms\]/);
    assert.ok(Date.now() - started < 15_000, `ended after ${Date.now() - started} ms`);
    _setCommandShellForTest({ ok: false, problem: 'Git Bash was not found (fixture).' });
    assert.equal(await executeOllamaTool('Bash', { command: 'echo hi' }, { cwd }), '[error] The Bash tool cannot run: Git Bash was not found (fixture).');
  } finally { _setCommandShellForTest(null); rmSync(cwd, { recursive: true, force: true }); }
});
