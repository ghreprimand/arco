import assert from 'node:assert/strict';
import test from 'node:test';
import { authLoginInstructions } from './authLoginInstructions.js';

test('Docker login keeps host and in-container commands distinct', () => {
  const result = authLoginInstructions('codex login --device-auth', 'Enter the one-time code.', 'docker');
  assert.equal(result.started, false);
  assert.equal(result.command, 'codex login --device-auth');
  assert.equal(result.hostCommand, 'docker compose exec arco codex login --device-auth');
  assert.match(result.manual!, /compose.yaml/);
  assert.match(result.manual!, /data volume/);
});
test('native login does not depend on Docker', () => {
  const result = authLoginInstructions('claude auth login --claudeai', '', 'native');
  assert.equal(result.hostCommand, undefined);
  assert.match(result.manual!, /TOOLS → TERMINAL/);
});
test('account-scoped environment and quoting survive Docker wrapping', () => {
  const command = "env CODEX_HOME='/data/home/.arco/accounts/team profile' codex login --device-auth";
  const result = authLoginInstructions(command, '', 'docker');
  assert.equal(result.command, command);
  assert.equal(result.hostCommand, `docker compose exec arco ${command}`);
});
