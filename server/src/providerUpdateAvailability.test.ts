import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { platformKey, resolveInstallableVersion } from './npmPlatformResolve.js';

import { decideCodexUpdate, describeCliUpdate } from './cliUpdateDecision.js';

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

test('a Windows standalone update selects its launcher and never calls npm or reports an unchanged version as latest', () => {
  const launcher = String.raw`C:\Codex\bin\codex.exe`;
  const decision = decideCodexUpdate({ kind: 'standalone', launcher, supportsUpdate: true }, '0.169.0');
  assert.deepEqual(decision.command, { cmd: launcher, args: ['update'] });
  assert.equal(decision.repairArgs, undefined);
  assert.equal(decision.targetVersion, '0.169.0');
  const unchanged = describeCliUpdate('codex', '0.165.0', '0.165.0', decision.targetVersion, { exitCode: 0, output: '' });
  assert.equal(unchanged.outcome, 'unchanged');
  assert.equal(unchanged.updated, false);
  assert.equal(unchanged.message, 'Codex did not change; v0.169.0 is still available.');
  const refused = decideCodexUpdate({ kind: 'npm', launcher, supportsUpdate: true, npmRootMatches: false }, '0.169.0');
  assert.equal(refused.command, undefined);
  assert.match(refused.message ?? '', /different Codex installation/);
});

test('a nonzero updater exit is a failure even if the old CLI still runs', () => {
  for (const provider of ['codex', 'claude']) {
    const result = describeCliUpdate(provider, '0.165.0', '0.165.0', '0.169.0', { exitCode: 1, output: 'Permission denied' });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.updated, false);
    assert.match(result.error ?? '', /Permission denied/);
  }
});
