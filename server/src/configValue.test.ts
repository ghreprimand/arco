// DD12 — config-value interpolation tests. Pure introspection + resolution
// (env-expand + literal + command via a real short-lived child) + the no-leak
// failure paths. No live server / API.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeConfigValue,
  resolveConfigValue,
  splitArgs,
  clearConfigValueCache,
} from './configValue.js';

test('describeConfigValue classifies without resolving', () => {
  assert.equal(describeConfigValue('').kind, 'empty');
  assert.equal(describeConfigValue('   ').kind, 'empty');
  assert.equal(describeConfigValue('sk-literal-123').kind, 'literal');
  assert.equal(describeConfigValue('!op read op://v/k').kind, 'command');
  const env = describeConfigValue('${MODEL_SERVICE_KEY}');
  assert.equal(env.kind, 'env');
  assert.deepEqual(env.envVars, ['MODEL_SERVICE_KEY']);
});

test('describeConfigValue reports configured for indirect forms (no leak)', () => {
  assert.equal(describeConfigValue('!secret-cmd').configured, true);
  assert.equal(describeConfigValue('${X}').configured, true);
  assert.equal(describeConfigValue('').configured, false);
});

test('splitArgs honors quotes', () => {
  assert.deepEqual(splitArgs('op read op://v/k'), ['op', 'read', 'op://v/k']);
  assert.deepEqual(splitArgs('foo "a b" c'), ['foo', 'a b', 'c']);
  assert.deepEqual(splitArgs("foo 'a b'"), ['foo', 'a b']);
});

test('resolveConfigValue passes a literal through', async () => {
  clearConfigValueCache();
  const r = await resolveConfigValue('plain-value');
  assert.equal(r.value, 'plain-value');
  assert.equal(r.error, undefined);
});

test('resolveConfigValue expands ${ENV} with $$/$! escapes', async () => {
  clearConfigValueCache();
  process.env.DD12_TEST_VAR = 'resolved-secret';
  const r = await resolveConfigValue('${DD12_TEST_VAR}');
  assert.equal(r.value, 'resolved-secret');
  const esc = await resolveConfigValue('${DD12_TEST_VAR}$$tail');
  assert.equal(esc.value, 'resolved-secret$tail', '$$ → literal $');
  const bang = await resolveConfigValue('$!notacommand');
  assert.equal(bang.value, '!notacommand', '$! → literal ! (not treated as command)');
  delete process.env.DD12_TEST_VAR;
});

test('resolveConfigValue errors (no leak) on a missing env var', async () => {
  clearConfigValueCache();
  delete process.env.DD12_MISSING_VAR;
  const r = await resolveConfigValue('${DD12_MISSING_VAR}');
  assert.equal(r.value, undefined);
  assert.match(r.error ?? '', /not set: DD12_MISSING_VAR/);
});

test('resolveConfigValue runs a !command and uses stdout', async () => {
  clearConfigValueCache();
  const r = await resolveConfigValue('!node -e "process.stdout.write(\'cmd-secret\')"');
  assert.equal(r.value, 'cmd-secret');
});

test('resolveConfigValue surfaces a command failure without partial value', async () => {
  clearConfigValueCache();
  const r = await resolveConfigValue('!node -e "process.exit(3)"');
  assert.equal(r.value, undefined);
  assert.match(r.error ?? '', /exited 3/);
});

test('empty / whitespace raw resolves to undefined value', async () => {
  clearConfigValueCache();
  assert.equal((await resolveConfigValue('')).value, undefined);
  assert.equal((await resolveConfigValue('   ')).value, undefined);
});
