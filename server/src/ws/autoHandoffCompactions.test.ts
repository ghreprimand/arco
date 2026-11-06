// Auto-handoff after N compactions (0.1.5): counting, reset, firing at a turn
// boundary, migration of saved percent settings, and which providers can count.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
import type { WorkflowState, Session } from '../workflows/types.js';
import type { WebSocket } from 'ws';

const root = mkdtempSync(join(tmpdir(), 'arco-auto-handoff-'));
installIsolatedTestHome(root);
// Windows refuses to remove a folder while a file in it is still open: wait
// for the background project writes and any file operation still in flight
// (settings and counter saves), then retry briefly.
after(async () => {
  const { settleProjectWrites } = await import('../testSupport/projectWrites.js');
  await settleProjectWrites();
  for (let i = 0; i < 40 && process.getActiveResourcesInfo().some((r) => r.startsWith('FSReq')); i++) await new Promise((r) => setTimeout(r, 50));
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
const shared = await import('@arco/shared');
const engine = await import('./turnEngine.js');
const counter = await import('../compactionCounter.js');
const { reportCompaction } = await import('../compactionReport.js');
const { workflows } = await import('../server/state.js');
const { readSettings, patchSettings } = await import('../settings.js');

function fixture(id: string, extra: Partial<WorkflowState> = {}): { wf: WorkflowState; sent: string[]; cwd: string } {
  const cwd = join(root, id); mkdirSync(cwd, { recursive: true });
  const sent: string[] = [];
  const ws = { readyState: 1, send: (data: string) => { sent.push(data); } } as unknown as WebSocket;
  const wf = { busy: false, observers: new Set([ws]), config: { name: id, workingDirectory: cwd, claudeTransport: 'native' },
    primary: { provider: 'claude', model: 'sonnet', effort: 'high' }, primarySessionId: 'session-a',
    autoHandoff: { enabled: true, afterCompactions: 3, compactions: 0, fired: false }, ...extra,
  } as unknown as WorkflowState;
  workflows.set(id, wf);
  return { wf, sent, cwd };
}
const notices = (sent: string[]) => sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'system_notice').map((m) => m.content as string);

test('saved percent settings migrate: on stays on with 5 compactions, off stays off', () => {
  assert.deepEqual(shared.normalizeAutoHandoff({ enabled: true, warnAt: 75, autoAt: 90 }), { enabled: true, afterCompactions: 5, warnAt: 75, autoAt: 90 });
  assert.deepEqual(shared.normalizeAutoHandoff({ enabled: false, warnAt: 60, autoAt: 80, mode: 'fresh-summarizer' }), { enabled: false, afterCompactions: 5, warnAt: 60, autoAt: 80, mode: 'fresh-summarizer' });
  assert.deepEqual(shared.normalizeAutoHandoff({ enabled: true, afterCompactions: 2, summarizer: { provider: 'claude', model: 'opus' } }), { enabled: true, afterCompactions: 2, warnAt: 75, autoAt: 90, summarizer: { provider: 'claude', model: 'opus' } });
  assert.equal(shared.normalizeAutoHandoff({ enabled: true, afterCompactions: 0 })?.afterCompactions, 1);
  assert.equal(shared.normalizeAutoHandoff({ enabled: true, afterCompactions: 99 })?.afterCompactions, 20);
  for (const bad of [undefined, null, 'on', {}, { enabled: 'yes' }]) assert.equal(shared.normalizeAutoHandoff(bad), undefined);
  const live = engine.deriveAutoHandoff({ name: 'x', primaryModel: 'm', primaryEffort: 'high', autoHandoff: { enabled: true, warnAt: 70, autoAt: 85 } } as never);
  assert.deepEqual({ enabled: live.enabled, after: live.afterCompactions, count: live.compactions }, { enabled: true, after: 5, count: 0 });
  const config = { name: 'x', autoHandoff: { enabled: true, warnAt: 70, autoAt: 85 } } as never as import('@arco/shared').WorkflowConfig;
  engine.applyAutoHandoffDefault(config, { enabled: false });
  assert.deepEqual(config.autoHandoff, { enabled: true, afterCompactions: 5, warnAt: 70, autoAt: 85 }, 'creation keeps the saved percentages for 0.1.4');
});

test('every saved auto-handoff keeps the percentages 0.1.4 needs to hand off', () => {
  // 0.1.4 fires only when the context percentage reaches autoAt; without the
  // field a tab that is on never hands off there.
  assert.deepEqual(shared.normalizeAutoHandoff({ enabled: true, afterCompactions: 4 }), { enabled: true, afterCompactions: 4, warnAt: 75, autoAt: 90 });
  assert.deepEqual(shared.normalizeAutoHandoff({ enabled: true, warnAt: 10, autoAt: 200 }), { enabled: true, afterCompactions: 5, warnAt: 60, autoAt: 95 }, 'clamped to the 0.1.4 slider ranges');
  assert.deepEqual(shared.normalizeAutoHandoff({ enabled: true, warnAt: 'x', autoAt: Number.NaN }), { enabled: true, afterCompactions: 5, warnAt: 75, autoAt: 90 });
});

test('meta.json always carries the 0.1.4 percentages with a saved auto-handoff', async () => {
  const { writeMeta } = await import('../workflowMeta.js');
  const cwd = join(root, 'legacy-meta'); mkdirSync(cwd, { recursive: true });
  const workflowId = '0f0e0d0c-0b0a-4908-8706-050403020100';
  await writeMeta(cwd, { workflowId, cwd, name: 'legacy', kind: 'chat', cliSessions: [], primaryProvider: 'claude', primaryModel: 'sonnet', createdAt: 1, lastActiveAt: 1, autoHandoff: { enabled: true, afterCompactions: 4 } } as never);
  const saved = JSON.parse(readFileSync(join(cwd, '.arco', 'workflows', workflowId, 'meta.json'), 'utf8'));
  assert.deepEqual(saved.autoHandoff, { enabled: true, afterCompactions: 4, warnAt: 75, autoAt: 90 });
});

test('a 0.1.5 change keeps the 0.1.4 percentages the tab already has', async () => {
  const { writeMeta, readMeta } = await import('../workflowMeta.js');
  const { handleUpdatePrimaryConfig } = await import('./updatePrimaryConfig.js');
  const cwd = join(root, 'keep-percent'); mkdirSync(cwd, { recursive: true });
  const id = '1f0e0d0c-0b0a-4908-8706-050403020100';
  const ws = { readyState: 1, send: () => undefined } as unknown as WebSocket;
  const wf = { config: { name: 'keep', workingDirectory: cwd, autoHandoff: { enabled: true, afterCompactions: 5, warnAt: 80, autoAt: 92 } },
    primary: { provider: 'claude', model: 'sonnet', effort: 'low' }, observers: new Set([ws]), bootMaterialized: true,
    autoHandoff: { enabled: true, afterCompactions: 5, compactions: 0, fired: false } } as unknown as WorkflowState;
  workflows.set(id, wf);
  try {
    await writeMeta(cwd, { workflowId: id, name: 'keep', cwd, kind: 'chat', createdAt: 1, lastActiveAt: 1, primaryProvider: 'claude', primaryModel: 'sonnet', cliSessions: [], autoHandoff: wf.config.autoHandoff } as never);
    await handleUpdatePrimaryConfig(ws, {} as Session, { type: 'update_primary_config', workflowId: id, autoHandoff: { enabled: true, afterCompactions: 6 } } as never);
    assert.deepEqual((await readMeta(cwd, id))?.autoHandoff, { enabled: true, afterCompactions: 6, warnAt: 80, autoAt: 92 });
  } finally { workflows.delete(id); }
});

test('saved global defaults from before 0.1.5 keep enabled and drop the percentages', async () => {
  const settingsPath = join(process.env.ARCO_HOME!, 'settings.json');
  mkdirSync(process.env.ARCO_HOME!, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ autoHandoffDefaults: { enabled: true, warnAt: 70, autoAt: 85, mode: 'quick' } }));
  assert.deepEqual((await readSettings()).autoHandoffDefaults, { enabled: true, mode: 'quick' });
  writeFileSync(settingsPath, JSON.stringify({ autoHandoffDefaults: { enabled: false, warnAt: 70 } }));
  assert.deepEqual((await readSettings()).autoHandoffDefaults, { enabled: false });
  await patchSettings({ autoHandoffDefaults: { enabled: true, afterCompactions: 8 } });
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')).autoHandoffDefaults, { enabled: true, afterCompactions: 8 });
  const config = { name: 'x' } as import('@arco/shared').WorkflowConfig;
  engine.applyAutoHandoffDefault(config, (await readSettings()).autoHandoffDefaults);
  assert.deepEqual(config.autoHandoff, { enabled: true, afterCompactions: 8, warnAt: 75, autoAt: 90 });
  await patchSettings({ autoHandoffDefaults: { enabled: false, afterCompactions: 5 } });
});

test('compactions count per conversation, ignore other sessions, reset with a new session and restore', () => {
  const { wf } = fixture('count');
  try {
    reportCompaction({ workflowId: 'count', source: 'claude-native' });
    reportCompaction({ workflowId: 'count', source: 'codex', sessionId: 'session-a' });
    reportCompaction({ workflowId: 'count', source: 'claude-cli', sessionId: 'side-worker' });
    reportCompaction({ workflowId: 'unknown-tab', source: 'ollama' });
    assert.equal(counter.compactionsThisConversation(wf), 2);
    assert.equal(wf.autoHandoff.session, 'session-a');
    wf.primarySessionId = 'session-b';
    assert.equal(counter.compactionsThisConversation(wf), 0, 'a new session starts at 0');
    reportCompaction({ workflowId: 'count', source: 'claude-native' });
    assert.equal(counter.compactionsThisConversation(wf), 1);
    counter.resetCompactions('count', wf);
    assert.deepEqual([wf.autoHandoff.compactions, wf.autoHandoff.session, wf.autoHandoff.fired], [0, undefined, false]);
    counter.restoreCompactions(wf, { session: 'session-b', count: 4 });
    assert.equal(counter.compactionsThisConversation(wf), 4);
    counter.restoreCompactions(wf, { session: 'old-session', count: 9 });
    assert.equal(counter.compactionsThisConversation(wf), 4, 'a count from another session is not restored');
    for (const bad of [null, { count: -1 }, { count: 1.5 }, 'x']) counter.restoreCompactions(wf, bad);
    assert.equal(counter.compactionsThisConversation(wf), 4);
  } finally { workflows.delete('count'); }
});

test('the handoff fires at the Nth compaction, once, with one chat line and nothing before it', async () => {
  const { wf, sent, cwd } = fixture('fire');
  const requests: string[] = [];
  engine.initTurnEngine({ previewAutoDetect: {} as never, handleCreateWorkflow: async () => {}, handleHandoffRequest: async (_ws, _session, msg) => {
    requests.push(msg.mode); counter.resetCompactions('fire', wf); return { artifactName: 'handoff-1.md' };
  } });
  try {
    for (let i = 1; i <= 2; i++) {
      reportCompaction({ workflowId: 'fire', source: 'claude-native' });
      assert.equal(await engine.maybeAutoHandoff('fire', wf, cwd), false);
    }
    assert.deepEqual(notices(sent), [], 'no warning before the handoff');
    reportCompaction({ workflowId: 'fire', source: 'claude-native' });
    wf.busy = true;
    assert.equal(await engine.maybeAutoHandoff('fire', wf, cwd), false, 'never inside a turn');
    wf.busy = false;
    assert.equal(await engine.maybeAutoHandoff('fire', wf, cwd), true);
    assert.deepEqual(requests, ['quick']);
    const lines = notices(sent);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^Handed off after 3 compactions: \[handoff document\]\(.+\/handoffs\/handoff-1\.md\)$/);
    assert.equal(await engine.maybeAutoHandoff('fire', wf, cwd), false, 'the new conversation starts at 0');
    // Off: no handoff however many compactions.
    wf.autoHandoff.enabled = false;
    for (let i = 0; i < 4; i++) reportCompaction({ workflowId: 'fire', source: 'claude-native' });
    assert.equal(await engine.maybeAutoHandoff('fire', wf, cwd), false);
    // A handoff that does not complete is not retried in the same conversation.
    wf.autoHandoff.enabled = true;
    engine.initTurnEngine({ previewAutoDetect: {} as never, handleCreateWorkflow: async () => {}, handleHandoffRequest: async () => { requests.push('cancelled'); } });
    assert.equal(await engine.maybeAutoHandoff('fire', wf, cwd), true);
    assert.equal(await engine.maybeAutoHandoff('fire', wf, cwd), false);
    assert.deepEqual(requests, ['quick', 'cancelled']);
    assert.equal(notices(sent).length, 1);
  } finally { workflows.delete('fire'); }
});

test('a due handoff runs before the boundary compaction; chat tabs never hand off', async () => {
  const { wf, cwd } = fixture('order', { config: { name: 'order', workingDirectory: join(root, 'order'), claudeTransport: 'native', autoCompaction: { enabled: true, thresholdPercent: 80 } } } as never);
  let compacts = 0, handoffs = 0;
  engine.initTurnEngine({ previewAutoDetect: {} as never, handleCreateWorkflow: async () => {}, handleHandoffRequest: async () => { handoffs++; return { artifactName: 'h.md' }; }, handleCompactWorkflow: async () => { compacts++; } });
  try {
    wf.autoHandoff.compactions = 3; wf.autoHandoff.session = 'session-a';
    const token = engine.claimBusy(wf); engine.releaseBusy(wf, token);
    const reading = { percent: 95, provider: 'claude', sessionId: 'session-a', transport: 'native' };
    assert.equal(await engine.runExplicitContextActions('order', wf, cwd, { enabled: true, thresholdPercent: 80 }, reading, token, undefined, {} as Session), 'done');
    assert.deepEqual([handoffs, compacts], [1, 0]);
    const chat = fixture('chat', { config: { kind: 'chat', name: 'chat' } } as never);
    chat.wf.autoHandoff.compactions = 9;
    assert.equal(await engine.maybeAutoHandoff('chat', chat.wf, chat.cwd), false);
  } finally { workflows.delete('order'); workflows.delete('chat'); }
});

test('which providers can count, and auto-compaction is required where Arco compacts', () => {
  const avail = shared.autoHandoffAvailability;
  const on = { enabled: true, thresholdPercent: 90 }, off = { enabled: false, thresholdPercent: 90 };
  assert.equal(avail({ provider: 'claude', claudeTransport: 'native', compaction: on }).available, true);
  assert.deepEqual(avail({ provider: 'claude', claudeTransport: 'native', compaction: off }), { available: false, needsAutoCompaction: true, reason: 'Needs auto-compaction. Turn on AUTO-COMPACTION to use auto-handoff.' });
  assert.equal(avail({ provider: 'claude', claudeTransport: 'native', compaction: undefined }).available, false, 'API compaction only');
  assert.equal(avail({ provider: 'claude', claudeTransport: 'cli' }).available, true);
  assert.equal(avail({ provider: 'codex', codexTransport: 'appserver', compaction: off }).available, true, 'Codex compacts itself');
  assert.match((avail({ provider: 'codex', codexTransport: 'exec' }) as { reason: string }).reason, /exec transport/);
  assert.equal(avail({ provider: 'ollama', compaction: on }).available, true);
  assert.equal(avail({ provider: 'ollama', compaction: undefined, ollamaSavedEnabled: true }).available, true);
  assert.equal((avail({ provider: 'ollama', compaction: undefined, ollamaSavedEnabled: false }) as { needsAutoCompaction?: boolean }).needsAutoCompaction, true);
  assert.match((avail({ provider: 'cursor' }) as { reason: string }).reason, /Cursor/);
  for (const provider of ['llamacpp', 'lmstudio', 'strata', 'deepseek']) assert.match((avail({ provider }) as { reason: string }).reason, /no compaction/);
  assert.equal(avail({ provider: 'claude', chat: true }).available, false);
  // Cluster policy precedence: a worker policy wins over the cluster default.
  const resolve = (worker: typeof on | undefined, cluster: typeof on | undefined) => shared.resolveProviderAutoCompaction(worker, cluster, 'claude', 'native', false);
  assert.equal(avail({ provider: 'claude', claudeTransport: 'native', compaction: resolve(undefined, off) }).available, false);
  assert.equal(avail({ provider: 'claude', claudeTransport: 'native', compaction: resolve(on, off) }).available, true);
  assert.equal(avail({ provider: 'claude', claudeTransport: 'native', compaction: resolve(off, on) }).available, false);
  assert.equal(avail({ provider: 'claude', claudeTransport: 'native', compaction: resolve(undefined, undefined) }).available, true, 'provider default is on');
});

test('N of 1 fires on the first compaction, and a thrown handoff is not retried', async () => {
  const { wf, sent, cwd } = fixture('once', { autoHandoff: { enabled: true, afterCompactions: 1, compactions: 0, fired: false } });
  let calls = 0;
  engine.initTurnEngine({ previewAutoDetect: {} as never, handleCreateWorkflow: async () => {}, handleHandoffRequest: async () => { calls += 1; throw new Error('fixture handoff failed'); } });
  try {
    assert.equal(await engine.maybeAutoHandoff('once', wf, cwd), false, 'nothing is due before the first compaction');
    reportCompaction({ workflowId: 'once', source: 'claude-native' });
    assert.equal(await engine.maybeAutoHandoff('once', wf, cwd), true);
    assert.equal(calls, 1);
    assert.match(notices(sent).at(-1) ?? '', /AUTO-HANDOFF FAILED/);
    assert.equal(await engine.maybeAutoHandoff('once', wf, cwd), false, 'a failed handoff does not run again in this conversation');
    assert.equal(calls, 1);
  } finally { workflows.delete('once'); }
});

test('a Fold does not count and a native compaction does', async () => {
  const { wf } = fixture('fold-count');
  const { broadcastWorkflow } = await import('../server/broadcast.js');
  try {
    broadcastWorkflow('fold-count', { type: 'context_folded', workflowId: 'fold-count' } as never);
    assert.equal(counter.compactionsThisConversation(wf), 0, 'Fold keeps the conversation and does not count');
    broadcastWorkflow('fold-count', { type: 'native_compacted', workflowId: 'fold-count' } as never);
    assert.equal(counter.compactionsThisConversation(wf), 1);
  } finally { workflows.delete('fold-count'); }
});

test('an unavailable provider never hands off, whatever the count', async () => {
  const { wf, cwd } = fixture('cursor', { primary: { provider: 'cursor', model: 'm', effort: 'high' } } as never);
  let handoffs = 0;
  engine.initTurnEngine({ previewAutoDetect: {} as never, handleCreateWorkflow: async () => {}, handleHandoffRequest: async () => { handoffs++; } });
  try {
    wf.autoHandoff.compactions = 10;
    assert.equal(await engine.maybeAutoHandoff('cursor', wf, cwd), false);
    assert.equal(handoffs, 0);
  } finally { workflows.delete('cursor'); }
});
