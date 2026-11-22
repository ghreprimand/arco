import assert from 'node:assert/strict';
import test from 'node:test';

test('a fenced Cursor member gets a session pass, only Cursor hosts with web off, and no approval bypass', async () => {
  const { workerAccessPass } = await import('./workerAccessPass.js');
  const token = `fixture.${Buffer.from(JSON.stringify({ exp: 2000 })).toString('base64url')}.fixture`;
  assert.deepEqual(JSON.parse(workerAccessPass('cursor', { accessToken: token, email: 'private' }, 1000)), { accessToken: token, refreshToken: token });
  assert.throws(() => workerAccessPass('cursor', { accessToken: token }, 1_800_000), /needs renewing/);
  assert.throws(() => workerAccessPass('cursor', {}), /needs renewing/);
  // Cursor's file tools may read any path the fence shows, so the pass is emptied once the agent has started.
  const { prepareWorkerAccessPass } = await import('./workerAccessPass.js');
  const { readFile } = await import('node:fs/promises');
  const live = `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`;
  const pass = await prepareWorkerAccessPass('cursor', { accessToken: live });
  try {
    assert.equal(pass.path, `${pass.directory}/access.json`);
    assert.equal(JSON.parse(await readFile(pass.path, 'utf8')).accessToken, live);
    await pass.withdraw!();
    assert.equal(await readFile(pass.path, 'utf8'), '{}');
  } finally { await pass.close(); }

  const { workerProviderHostAllowed } = await import('./workerWebProxy.js');
  const hosts = new Set(['api2.cursor.sh', '.cursor.sh']);
  assert.equal(workerProviderHostAllowed(hosts, 'agentn.global.api5.cursor.sh'), true);
  assert.equal(workerProviderHostAllowed(hosts, 'api2.cursor.sh'), true);
  assert.equal(workerProviderHostAllowed(hosts, 'cursor.sh'), false);
  assert.equal(workerProviderHostAllowed(hosts, 'evilcursor.sh'), false);
  assert.equal(workerProviderHostAllowed(hosts, 'example.com'), false);

  const { checkedCursorIsolationArgs, cursorIsolatedCliConfig } = await import('./cursorIsolatedLaunch.js');
  assert.deepEqual(checkedCursorIsolationArgs(['--model', 'auto', '--resume', 'chat-1']), ['--model', 'auto', '--resume', 'chat-1']);
  for (const unsafe of [['--force'], ['--yolo'], ['--auto-review'], ['--approve-mcps'], ['--sandbox', 'disabled'], ['--workspace', '/'], ['--model', '--force'], ['--model', 'a', '--model', 'b']]) {
    assert.throws(() => checkedCursorIsolationArgs(unsafe), /Cursor isolation/, unsafe.join(' '));
  }
  const off = JSON.parse(cursorIsolatedCliConfig(false));
  const on = JSON.parse(cursorIsolatedCliConfig(true));
  assert.deepEqual(off.sandbox, { mode: 'enabled', readBoundary: 'workspace', networkAccess: 'enabled' });
  // Cursor's web search runs on Cursor's servers, outside Arco's web filter.
  assert.equal(off.autoAcceptWebSearch, false);
  assert.equal(on.autoAcceptWebSearch, true);
  assert.deepEqual(off.permissions.deny, ['WebFetch(*)']);
  assert.deepEqual(on.permissions.allow, ['Mcp(arco-cluster:peer_read)', 'Mcp(arco-cluster:peer_send)']);

  const { cursorResearcherDoctrine } = await import('./cliResearcherDoctrine.js');
  const { RESEARCHER_DOCTRINE } = await import('../research/researchDoctrine.js');
  const doctrine = cursorResearcherDoctrine(RESEARCHER_DOCTRINE);
  assert.match(doctrine, /may use shell tools inside the sandbox/);
  assert.match(doctrine, /fetch pages with curl in your shell/);
  assert.doesNotMatch(doctrine, /web search and web fetch/);

  const { cursorIsolationVersionReason } = await import('../providers/cursor/isolatedVersion.js');
  assert.equal(cursorIsolationVersionReason('2026.11.22'), undefined);
  assert.equal(cursorIsolationVersionReason('2027.01.05'), undefined);
  assert.match(cursorIsolationVersionReason('2026.11.19') ?? '', /2026\.11\.22 or later; 2026\.11\.19 is installed/);
  assert.match(cursorIsolationVersionReason('unknown') ?? '', /could not be determined/);
});
