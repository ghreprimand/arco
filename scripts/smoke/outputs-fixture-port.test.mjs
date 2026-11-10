import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outputsFixtureEnvironment } from './outputs-fixture-port.mjs';

test('only outputs receives a selected shared backend port', async () => {
 const env = { PATH: 'fixture' };
 const output = await outputsFixtureEnvironment('outputs', env);
 assert.match(output.ARCO_PORT, /^[1-9][0-9]*$/);
 assert.equal(output.ARCO_PORT, output.ARCO_TEST_FIXTURE_PORT);
 assert.equal(env.ARCO_PORT, undefined);
 assert.deepEqual(await outputsFixtureEnvironment('other', env), env);
});
