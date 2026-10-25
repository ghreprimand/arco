// Unit tests for buildSafeEnv (H20 — MCP env allowlist).
//
// Regression guard for the secret leak: before H20 every spawned MCP child
// inherited the full `process.env`, including the Claude OAuth token, GitHub
// PAT, and provider API keys. buildSafeEnv must (1) pass through only the
// allowlisted base + LC_*/XDG_* families, (2) drop everything else, and (3)
// apply the operator-declared `def.env` on top (the intended secret channel),
// overriding any inherited base value.
//
// Run with: node --import tsx --test src/mcp/safeEnv.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSafeEnv } from './client.js';

test('drops host secrets but keeps the safe base', () => {
  process.env.ARCHON_TEST_SECRET = 'oauth-token-xyz';
  process.env.GITHUB_TOKEN = 'ghp_should_not_leak';
  process.env.LC_ALL = 'en_US.UTF-8';
  process.env.XDG_CONFIG_HOME = '/home/u/.config';
  try {
    const env = buildSafeEnv();
    assert.equal(env.ARCHON_TEST_SECRET, undefined, 'arbitrary secret must be dropped');
    assert.equal(env.GITHUB_TOKEN, undefined, 'GITHUB_TOKEN must be dropped');
    assert.ok(typeof env.PATH === 'string' && env.PATH.length > 0, 'PATH must pass through');
    assert.equal(env.LC_ALL, 'en_US.UTF-8', 'LC_* family must pass through');
    assert.equal(env.XDG_CONFIG_HOME, '/home/u/.config', 'XDG_* family must pass through');
  } finally {
    delete process.env.ARCHON_TEST_SECRET;
    delete process.env.GITHUB_TOKEN;
    delete process.env.LC_ALL;
    delete process.env.XDG_CONFIG_HOME;
  }
});

test('applies operator-declared env, overriding the base', () => {
  process.env.HOME = '/home/real';
  const env = buildSafeEnv({ MY_SERVER_KEY: 'sk-declared', HOME: '/sandbox/home' });
  assert.equal(env.MY_SERVER_KEY, 'sk-declared', 'declared var must be present');
  assert.equal(env.HOME, '/sandbox/home', 'declared value must override inherited base');
});

test('no declared env is the same as the bare allowlist', () => {
  const a = buildSafeEnv();
  const b = buildSafeEnv(undefined);
  assert.deepEqual(a, b);
  // None of the keys should be an obvious secret-bearing name.
  for (const k of Object.keys(a)) {
    assert.ok(
      !/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY/i.test(k),
      `unexpected secret-looking key survived the filter: ${k}`,
    );
  }
});
