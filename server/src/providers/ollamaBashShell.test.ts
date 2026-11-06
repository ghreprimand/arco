// The local-model Bash tool (Ollama, llama.cpp, LM Studio) runs in the same
// shell as Claude Native: /bin/sh on Linux and macOS, Git Bash on Windows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeOllamaTool, getOllamaToolDefinitions } from './ollamaTools.js';
import { _powerShellFallbackForTest, _setCommandShellForTest } from '../commandShell.js';

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

const fallback = _powerShellFallbackForTest();
test('without Git Bash the local-model Bash tool runs PowerShell, says so, and handles long commands', { skip: fallback ? false : 'PowerShell is not installed here' }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-local-pwsh-'));
  const scripts = () => readdirSync(tmpdir()).filter((n) => n.startsWith('arco-ps-')).length;
  _setCommandShellForTest(fallback);
  try {
    const bash = getOllamaToolDefinitions().find((d) => d.function.name === 'Bash');
    assert.match(bash?.function.description ?? '', /via PowerShell, because Git Bash was not found/);
    const ok = await executeOllamaTool('Bash', { command: 'Write-Output "ps $($PSVersionTable.PSEdition)"; exit 4' }, { cwd });
    assert.match(ok, /exit code: 4/);
    assert.match(ok, /ps (Core|Desktop)/);
    // Too long for an encoded command line: goes through a temporary script, removed afterwards.
    const before = scripts();
    const long = await executeOllamaTool('Bash', { command: `$x = '${'a'.repeat(12_000)}'; Write-Output "length $($x.Length)"` }, { cwd });
    assert.match(long, /length 12000/);
    assert.match(long, /exit code: 0/);
    assert.equal(scripts(), before);
  } finally { _setCommandShellForTest(null); rmSync(cwd, { recursive: true, force: true }); }
});
