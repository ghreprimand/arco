import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import type { ServerMessage } from '@arco/shared';
import { initNotifications, _setMutesPathForTest, _resetTransportsForTest, registerNoticeTransport, onTurnStarted, onTurnEnded } from './notifications.js';
import {
  _setChannelsPathForTest, _setFetchForTest, channelsView, loadChannels, observeAttention, resolvePhoneTarget, saveChannels, sendPhone, sendTest, MIN_FINISHED_TURN_MS,
} from './attention.js';

const sent: ServerMessage[] = [];
const posts: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
let seq = 0;
const info = { name: 'Fix login', incognito: false };
const wf = () => `wf-attn-${seq++}`;

beforeEach(async () => {
  sent.length = 0; posts.length = 0;
  const dir = await mkdtemp(join(tmpdir(), 'arco-attn-'));
  _setChannelsPathForTest(join(dir, 'notification-channels.json'));
  _setMutesPathForTest(join(dir, 'notification-mutes.json'));
  _resetTransportsForTest();
  _setFetchForTest((async (url: string, init: { headers: Record<string, string>; body: string }) => { posts.push({ url, headers: init.headers, body: init.body }); return { ok: true, status: 200 }; }) as never);
  await initNotifications((m) => { sent.push(m); });
  await loadChannels();
});

const question = (id: string) => ({ type: 'operator_question', workflowId: 'x', question: { requestId: id, status: 'pending', questions: [{ question: 'Which branch?' }] } }) as unknown as ServerMessage;

test('desktop and phone are off while the BELL event is still delivered', () => {
  const id = wf();
  observeAttention(id, question('q-off'), info);
  assert.equal(sent.filter((m) => m.type === 'attention_event').length, 1);
  assert.equal((sent[0] as unknown as { desktopEligible: boolean }).desktopEligible, false);
  assert.equal(posts.length, 0);
});

test('a pending question raises one desktop event and one phone message, without text by default', async () => {
  await saveChannels({ desktop: { waiting: true }, phone: { waiting: true }, ntfy: { server: 'https://ntfy.example.org', topic: 'arco-t1' } });
  const id = wf();
  observeAttention(id, question('q-1'), info);
  observeAttention(id, question('q-1'), info); // replay of the same question
  assert.equal(sent.filter((m) => m.type === 'attention_event').length, 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://ntfy.example.org/arco-t1');
  assert.equal(posts[0].headers.Title, 'Fix login is waiting for you');
  assert.ok(!posts[0].body.includes('Which branch'), 'message text stays out');
  const ev = sent.find((m) => m.type === 'attention_event') as unknown as { workflowName: string; text?: string };
  assert.equal(ev.workflowName, 'Fix login');
  assert.equal(ev.text, undefined);
});

test('message text is included only when switched on', async () => {
  await saveChannels({ phone: { waiting: true }, phoneText: true, ntfy: { server: 'https://ntfy.example.org', topic: 'arco-t2' } });
  observeAttention(wf(), question('q-2'), info);
  await new Promise((r) => setImmediate(r));
  assert.equal(posts[0].body, 'Which branch?');
  assert.equal((sent[0] as unknown as { desktopEligible: boolean }).desktopEligible, false);
});

test('finished needs a turn of at least the minimum length and skips Incognito', async () => {
  await saveChannels({ desktop: { finished: true } });
  const id = wf();
  observeAttention(id, { type: 'primary_turn_started', workflowId: id, startedAt: 1 } as ServerMessage, info);
  observeAttention(id, { type: 'primary_turn_ended', workflowId: id, endedAt: 2 } as ServerMessage, info);
  assert.equal((sent[0] as unknown as { desktopEligible: boolean }).desktopEligible, false);
  sent.length = 0;
  const realNow = Date.now;
  try {
    const t0 = realNow();
    Date.now = () => t0;
    observeAttention(id, { type: 'primary_turn_started', workflowId: id, startedAt: t0 } as ServerMessage, info);
    Date.now = () => t0 + MIN_FINISHED_TURN_MS + 1;
    observeAttention(id, { type: 'primary_turn_ended', workflowId: id, endedAt: t0 } as ServerMessage, { name: 'Private', incognito: true });
    assert.equal(sent.length, 0, 'Incognito never notifies');
    Date.now = () => t0;
    observeAttention(id, { type: 'primary_turn_started', workflowId: id, startedAt: t0 } as ServerMessage, info);
    Date.now = () => t0 + MIN_FINISHED_TURN_MS + 1;
    observeAttention(id, { type: 'primary_turn_ended', workflowId: id, endedAt: t0 } as ServerMessage, info);
    assert.equal(sent.filter((m) => m.type === 'attention_event').length, 1);
  } finally { Date.now = realNow; }
});

test('failures raise an alert for the failed event only', async () => {
  await saveChannels({ desktop: { failed: true } });
  const id = wf();
  observeAttention(id, { type: 'worker_error', workflowId: id, workerId: 'w', error: 'boom' } as ServerMessage, info);
  assert.equal((sent[0] as unknown as { kind: string }).kind, 'failed');
});

// A home outside the temporary folder. It is never created; the guard only
// compares paths.
async function normalHome(): Promise<string> {
  return join(parse(tmpdir()).root, 'arco-attn-normal-home', '.arco');
}

test('saved settings win; ARCO_NTFY_URL keeps working when none is saved; the token never reaches the view', async () => {
  const env = { ARCO_HOME: await normalHome(), ARCO_NTFY_URL: 'https://hub.example.org/topic', ARCO_NTFY_TOKEN: 'envtok' } as NodeJS.ProcessEnv;
  assert.deepEqual(resolvePhoneTarget(await saveChannels({}), env), { url: 'https://hub.example.org/topic', token: 'envtok' });
  assert.equal(channelsView(await saveChannels({}), env).ntfyFromEnvironment, true);
  const cfg = await saveChannels({ ntfy: { server: 'https://ntfy.example.org', topic: 'arco-t3', token: 'secret' } });
  assert.deepEqual(resolvePhoneTarget(cfg, env), { url: 'https://ntfy.example.org/arco-t3', token: 'secret' });
  const view = channelsView(cfg, env);
  assert.equal(view.ntfy.tokenSet, true);
  assert.ok(!JSON.stringify(view).includes('secret'));
  const kept = await saveChannels({ ntfy: { server: 'https://ntfy.example.org', topic: 'arco-t3' } });
  assert.equal(kept.ntfy.token, 'secret', 'omitting the token keeps it');
});

test('TEST reports the result', async () => {
  const cfg = await saveChannels({ ntfy: { server: 'https://ntfy.example.org', topic: 'arco-t4' } });
  assert.ok(cfg.ntfy.topic);
  const r = await sendTest({ ntfy: { server: 'https://ntfy.example.org', topic: 'arco-t4' } });
  assert.equal(r.ok, true);
  assert.equal(posts.at(-1)?.url, 'https://ntfy.example.org/arco-t4');
  assert.equal((await sendTest({ ntfy: { server: 'https://ntfy.example.org', topic: '' } })).ok, false);
  _setFetchForTest((async () => { throw new Error('connect refused'); }) as never);
  assert.match((await sendTest({ ntfy: { server: 'https://ntfy.example.org', topic: 'arco-t4' } })).error ?? '', /refused/);
});

test('short finished turns reach in-app notices without raising desktop alerts', async () => {
  await saveChannels({ desktop: { finished: true } });
  const id = wf();
  observeAttention(id, { type: 'primary_turn_started', workflowId: id, startedAt: 1 } as ServerMessage, info);
  observeAttention(id, { type: 'primary_turn_ended', workflowId: id, endedAt: 2 } as ServerMessage, info);
  const event = sent.find((m) => m.type === 'attention_event') as unknown as { desktopEligible?: boolean };
  assert.ok(event);
  assert.equal(event.desktopEligible, false);
});

test('long turn reaches legacy transports without a second workbench notice', () => {
  const delivered: string[] = [];
  registerNoticeTransport((notice) => { delivered.push(notice.category); });
  const now = Date.now;
  try {
    const start = now(); Date.now = () => start;
    onTurnStarted('legacy-fixture');
    Date.now = () => start + 60_001;
    onTurnEnded('legacy-fixture', { workflowName: 'Fixture' });
    assert.deepEqual(delivered, ['turn-finished']);
    assert.equal(sent.some((message) => message.type === 'workbench_notice'), false);
  } finally { Date.now = now; }
});

test('a home inside the temporary folder ignores ARCO_NTFY_URL, keeps a saved address, and the override lifts the rule', async () => {
  const tempHome = join(tmpdir(), `arco-attn-temp-home-${seq++}`, '.arco');
  mkdirSync(tempHome, { recursive: true });
  const inherited = { ARCO_HOME: tempHome, ARCO_NTFY_URL: 'https://hub.example.org/topic', ARCO_NTFY_TOKEN: 'envtok' } as NodeJS.ProcessEnv;
  const none = await saveChannels({ phone: { waiting: true } });
  assert.equal(resolvePhoneTarget(none, inherited), null, 'the inherited address is not used');
  const heldView = channelsView(none, inherited);
  assert.equal(heldView.ntfyFromEnvironment, false);
  assert.equal(heldView.ntfyEnvironmentHeldBack, true);
  assert.deepEqual(resolvePhoneTarget(none, { ...inherited, ARCO_ALLOW_TEMP_HOME: '1' }), { url: 'https://hub.example.org/topic', token: 'envtok' }, 'the override sends');
  assert.deepEqual(resolvePhoneTarget(none, { ...inherited, ARCO_HUB_ALLOW_TEMP_HOME: '1' }), { url: 'https://hub.example.org/topic', token: 'envtok' }, 'the older override name sends');
  const normal = { ...inherited, ARCO_HOME: await normalHome() };
  assert.deepEqual(resolvePhoneTarget(none, normal), { url: 'https://hub.example.org/topic', token: 'envtok' }, 'a normal home is unchanged');
  assert.equal(channelsView(none, normal).ntfyEnvironmentHeldBack, false);
  const saved = await saveChannels({ phone: { waiting: true }, ntfy: { server: 'https://ntfy.example.org', topic: 'arco-t9' } });
  assert.deepEqual(resolvePhoneTarget(saved, inherited), { url: 'https://ntfy.example.org/arco-t9' }, 'an address saved in Settings still works');
  assert.equal(channelsView(saved, inherited).ntfyEnvironmentHeldBack, false);
});

test('phone titles stay on one line and mark truncation', async () => {
  await sendPhone({ url: 'https://ntfy.example.org/fixture' }, `Director in ${'Long cluster '.repeat(20)}finished`, 'Fixture', 'finished');
  assert.ok(posts[0].headers.Title.length <= 120);
  assert.ok(posts[0].headers.Title.includes('...'));
  assert.ok(posts[0].headers.Title.endsWith('finished'));
  assert.doesNotMatch(posts[0].headers.Title, /[\r\n]/);
});
