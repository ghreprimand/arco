import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cancelLoginSession, getLoginSession, parseLoginOutput, startLoginSession } from './authLoginSession.js';
import { windowsTreeKillArgs } from './workers/processKill.js';

test('parses the Codex device-auth link and one-time code through ANSI colours', () => {
  const out = 'Follow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94m1E6U-APX0O\x1b[0m\n';
  assert.deepEqual(parseLoginOutput(out), { url: 'https://auth.openai.com/codex/device', code: '1E6U-APX0O', awaitingCode: false });
});

test('parses the Claude authorize link and notices the paste prompt', () => {
  const out = 'Opening browser to sign in...\nIf the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz\nPaste code here if prompted > ';
  const parsed = parseLoginOutput(out);
  assert.equal(parsed.url, 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz');
  assert.equal(parsed.code, undefined);
  assert.equal(parsed.awaitingCode, true);
});

test('accepts codes with more than one hyphen-joined group', () => {
  assert.equal(parseLoginOutput('2. Enter this one-time code\n   ARCO-FIXTURE-CODE\n').code, 'ARCO-FIXTURE-CODE');
});

test('reports nothing for output without a link', () => {
  assert.deepEqual(parseLoginOutput('Welcome to Codex\n'), { awaitingCode: false });
});

// A shell-started login command that starts its own child, as provider CLIs
// do (npm shims, node wrappers). Cancel and timeout must end both.

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (check: () => boolean, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return true; await new Promise((r) => setTimeout(r, 50)); } return check(); };

test('cancelling a login ends the provider process the shell started, not only the shell', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'arco-login-tree-'));
  let grandchildPid = 0;
  t.after(() => {
    cancelLoginSession('codex');
    if (grandchildPid && alive(grandchildPid)) process.kill(grandchildPid, 'SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  });
  const pidFile = join(dir, 'grandchild.pid');
  const script = join(dir, 'login.mjs');
  writeFileSync(script, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "writeFileSync(process.argv[2], String(child.pid));",
    "console.log('Open https://example.invalid/device');",
    "console.log('   ABCD-EFGH');",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const session = startLoginSession('codex', `"${process.execPath}" "${script}" "${pidFile}"`);
  assert.equal(session.status, 'pending');
  assert.ok(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0, 10_000), 'the fixture started its child');
  const grandchild = grandchildPid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(alive(grandchild));
  assert.ok(await waitFor(() => getLoginSession('codex')?.code === 'ABCD-EFGH', 5000), 'output is relayed while pending');
  assert.equal(cancelLoginSession('codex')?.status, 'cancelled');
  assert.ok(await waitFor(() => !alive(grandchild), 8000), 'the grandchild is gone after cancel');
});

test('Windows tree kill names the process and its descendants', () => {
  assert.deepEqual(windowsTreeKillArgs(4242), ['/pid', '4242', '/T', '/F']);
});
