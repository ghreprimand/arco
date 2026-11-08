import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { platformKey, resolveInstallableVersion } from './npmPlatformResolve.js';
import type { Capabilities } from '@arco/shared';

const pkg = '@openai/codex';
const build = (version: string) => ({ version, optionalDependencies: { [`${pkg}-${platformKey()}`]: `npm:${pkg}@${version}-${platformKey()}` } });
function registry(t: TestContext, fallback: unknown, missing = true) {
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('/latest')) return Response.json(build('2.0.0'));
    if (url.endsWith(`2.0.0-${platformKey()}`)) {
      if (!missing) throw new Error('fixture registry unavailable');
      return new Response('', { status: 404 });
    }
    return fallback === null ? new Response('', {status:503}) : Response.json(fallback);
  });
}
for (const fallback of [null, {versions:{}}, {versions:{'2.0.0':build('2.0.0')}}]) {
  test(`known missing platform build returns no install target with ${JSON.stringify(fallback)}`, async t => {
    registry(t, fallback);
    const result = await resolveInstallableVersion(pkg);
    assert.ok(result);
    assert.equal(result.version, undefined);
    assert.equal((result as any).blocked, true);
    assert.match(result.notice ?? '', /not installed|not changed|deferred/i);
  });
}

test('a verified older build remains an install target', async t => {
  registry(t,{versions:{'2.0.0':build('2.0.0'),'1.0.0':build('1.0.0'),[`1.0.0-${platformKey()}`]:{version:`1.0.0-${platformKey()}`}}});
  assert.equal((await resolveInstallableVersion(pkg))?.version,'1.0.0');
});

test('an unknown registry result remains distinct from a known missing build', async t => {
  registry(t,null,false);
  assert.equal(await resolveInstallableVersion(pkg),null);
});

test('a refused update never invokes an installer or replaces current capabilities', async t => {
  registry(t,null);
  const calls: string[] = [];
  let realCalls = 0;
  const denied = () => { realCalls++; assert.fail('Refused update reached the real execFile runner'); };
  const realExecFile = childProcess.execFile;
  Object.defineProperty(denied, promisify.custom, { value: denied, configurable: true });
  childProcess.execFile = denied as any;
  // execFile has a custom promisifier which otherwise closes over the original
  // implementation, even when the exported callback function is mocked.
  syncBuiltinESMExports();
  try {
    const {runCliUpdate} = await import('./capabilities.js');
    const previous = {cliVersion:'1.0.0',codexVersion:'1.0.0'} as Capabilities;
    const injected = async (cmd: string): Promise<string> => {
      calls.push(cmd);
      assert.fail('Refused update reached the injected command runner');
    };
    for (const runner of [injected, undefined]) {
      const result = await runCliUpdate(previous,'codex',runner);
      assert.deepEqual(calls,[]);
      assert.equal(realCalls,0,'Refused update must never reach real execFile/npm');
      assert.equal(result.capabilities,previous);
      assert.equal(result.updated,false);
      assert.equal(result.currentVersion,'1.0.0');
      assert.match(result.error ?? '', /deferred|not installed/);
    }
  } finally { childProcess.execFile = realExecFile; t.mock.restoreAll(); syncBuiltinESMExports(); }
});
