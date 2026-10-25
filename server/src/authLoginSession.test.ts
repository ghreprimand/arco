import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLoginOutput } from './authLoginSession.js';

test('parses the Codex device-auth link and one-time code through ANSI colours', () => {
  const out = 'Follow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94m1E6U-APX0O\x1b[0m\n';
  assert.deepEqual(parseLoginOutput(out), { url: 'https://auth.openai.com/codex/device', code: '1E6U-APX0O', awaitingCode: false });
});

test('parses the Claude authorize link and notices the paste prompt', () => {
  const out = 'Opening browser to sign in…\nIf the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=xyz\nPaste code here if prompted > ';
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
