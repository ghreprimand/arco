import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { APP_BUILD, APP_VERSION } from './appVersion.js';
import { tryHandleAppVersionRoutes } from './http/appVersionRoutes.js';

const root = new URL('../../', import.meta.url);
test('all workspace manifests carry the same semantic version', () => {
  const versions = ['', 'shared/', 'server/', 'client/'].map(directory =>
    JSON.parse(readFileSync(new URL(`${directory}package.json`, root), 'utf8')).version);
  assert.match(versions[0], /^\d+\.\d+\.\d+$/);
  assert.deepEqual(versions, Array(4).fill(APP_VERSION));
});

test('version and liveness routes describe the same running build', async () => {
  const server = createServer((req, res) => {
    if (!tryHandleAppVersionRoutes(req, res)) { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${base}/api/app/version`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), APP_BUILD);
    for (const route of ['/healthz', '/health']) {
      const health = await (await fetch(`${base}${route}`)).json();
      assert.deepEqual({ version: health.version, ...(health.commit ? { commit: health.commit } : {}) }, APP_BUILD);
      assert.equal(health.status, 'live');
      assert.equal(health.pid, process.pid);
      assert.equal(typeof health.uptimeSec, 'number');
    }
    assert.equal((await fetch(`${base}/api/app/version`, { method: 'POST' })).status, 404);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('build commit is optional and captured when the process imports its version', () => {
  for (const commit of ['', 'abc1234']) {
    const script = `import { APP_BUILD } from ${JSON.stringify(new URL('./appVersion.ts', import.meta.url).href)}; process.env.ARCO_BUILD_COMMIT = 'changed'; console.log(JSON.stringify(APP_BUILD));`;
    const build = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      env: { ...process.env, ARCO_BUILD_COMMIT: commit }, encoding: 'utf8',
    }));
    assert.deepEqual(build, { version: APP_VERSION, ...(commit ? { commit } : {}) });
  }
});
