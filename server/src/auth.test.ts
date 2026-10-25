import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getClaudeAuthStatus, triggerAuthLogin } from './auth.js';

// A fake `claude` on PATH whose `auth status --json` behavior is picked by the
// FAKE_CLAUDE_MODE env var at call time (execFile inherits process.env).
const binDir = mkdtempSync(join(tmpdir(), 'archon-auth-test-'));
writeFileSync(join(binDir, 'claude'), `#!/bin/sh
case "$FAKE_CLAUDE_MODE" in
  in)      echo '{"loggedIn": true, "email": "a@b.c"}' ;;
  out)     echo '{"loggedIn": false}'; exit 1 ;;
  garbage) echo 'not json' ;;
  crash)   exit 2 ;;
esac
`);
chmodSync(join(binDir, 'claude'), 0o755);
const origPath = process.env.PATH;
process.env.PATH = `${binDir}:${origPath}`;

test.after(() => {
  process.env.PATH = origPath;
  delete process.env.FAKE_CLAUDE_MODE;
  rmSync(binDir, { recursive: true, force: true });
});

// Order matters: the probe keeps a last-known answer across calls.
test('a failed probe before any good answer reads logged-out but flagged probeFailed', async () => {
  process.env.FAKE_CLAUDE_MODE = 'crash';
  const s = await getClaudeAuthStatus();
  assert.equal(s.loggedIn, false);
  assert.equal(s.probeFailed, true);
});

test('a parsed loggedIn:true is a fresh answer', async () => {
  process.env.FAKE_CLAUDE_MODE = 'in';
  const s = await getClaudeAuthStatus();
  assert.equal(s.loggedIn, true);
  assert.equal(s.probeFailed, undefined);
  assert.equal(s.email, 'a@b.c');
});

test('a flaky probe after a good answer keeps loggedIn (the false-chip regression)', async () => {
  for (const mode of ['garbage', 'crash']) {
    process.env.FAKE_CLAUDE_MODE = mode;
    const s = await getClaudeAuthStatus();
    assert.equal(s.loggedIn, true, mode);
    assert.equal(s.probeFailed, true, mode);
  }
});

test('a non-zero exit carrying loggedIn:false JSON is a real logged-out verdict', async () => {
  process.env.FAKE_CLAUDE_MODE = 'out';
  const s = await getClaudeAuthStatus();
  assert.equal(s.loggedIn, false);
  assert.equal(s.probeFailed, undefined);
});

test('CLI logins return a headless terminal command and never spawn', async () => {
  const cases: Array<[Parameters<typeof triggerAuthLogin>[0], RegExp]> = [
    ['claude', /^claude auth login --claudeai$/],
    ['gemini', /^env NO_BROWSER=true gemini$/],
    ['codex', /^codex login --device-auth$/],
    ['cursor', /^env NO_OPEN_BROWSER=1 cursor-agent login$/],
    ['github', /^gh auth login .*--web$/],
  ];
  for (const [provider, re] of cases) {
    const r = await triggerAuthLogin(provider);
    assert.equal(r.started, false, provider);
    assert.match(r.command ?? '', re, provider);
    assert.ok(r.manual?.includes(r.command!), provider);
  }
});

test('auth-less providers get a hint, not a command', async () => {
  for (const provider of ['zai', 'ollama', 'lmstudio'] as const) {
    const r = await triggerAuthLogin(provider);
    assert.equal(r.command, undefined, provider);
    assert.ok(r.manual, provider);
  }
});
