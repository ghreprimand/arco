import test from 'node:test';
import assert from 'node:assert/strict';
import { UPSTREAM_ENV_PREFIX, applyEnvFallback } from './envAliases.js';

test('an upstream-prefixed variable fills an unset ARCO_ name', () => {
  const env: NodeJS.ProcessEnv = { [`${UPSTREAM_ENV_PREFIX}HOME`]: '/tmp/fallback-home', [`${UPSTREAM_ENV_PREFIX}PORT`]: '4000' };
  applyEnvFallback(env);
  assert.equal(env.ARCO_HOME, '/tmp/fallback-home');
  assert.equal(env.ARCO_PORT, '4000');
});

test('a set ARCO_ name wins over the upstream-prefixed variable', () => {
  const env: NodeJS.ProcessEnv = { ARCO_HOME: '/tmp/arco-home', [`${UPSTREAM_ENV_PREFIX}HOME`]: '/tmp/fallback-home' };
  applyEnvFallback(env);
  assert.equal(env.ARCO_HOME, '/tmp/arco-home');
});

test('the bare prefix and unrelated variables are ignored', () => {
  const env: NodeJS.ProcessEnv = { [UPSTREAM_ENV_PREFIX]: 'x', OTHER_HOME: 'y' };
  applyEnvFallback(env);
  assert.deepEqual(Object.keys(env).sort(), [UPSTREAM_ENV_PREFIX, 'OTHER_HOME'].sort());
});
