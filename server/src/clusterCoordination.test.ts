import type { ClusterState } from './clusterStore.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { presetForText, normalizeClusterRoleText, ROLE_PRESETS, buildClusterCoordination, buildClusterNudge, buildClusterMailboxNotice, buildClusterAutoPickup, resolveClusterMessageGuard, isClusterMessageGuard, type ClusterMessageGuard } from '@arco/shared';

const sandbox = await fs.mkdtemp(join(tmpdir(), 'arco-coordination-'));
process.env.ARCO_HOME = join(sandbox, 'home');
const store = await import('./clusterStore.js');
const peer = await import('./clusterPeerOps.js');
const budget = await import('./clusterBudget.js');
const ledger = await import('./project/taskLedger.js');
const snapshots = await import('./clusterSnapshots.js');
const { writeMeta } = await import('./workflowMeta.js');
const { flushAll } = await import('./workflowStore.js');
after(async () => { await flushAll(); await fs.rm(sandbox, { recursive: true, force: true }); });
const make = async (settings = {}) => store.createCluster({ cwd: await fs.mkdtemp(join(sandbox, 'project-')), memberWorkflowIds: [randomUUID(), randomUUID()], ...settings });
const context = (c: ClusterState, sender = c.members[0]) => ({ workflowId: sender, clusterId: c.clusterId, broadcastSender: () => {}, broadcastRecipient: () => {} });
const guard = (mode: ClusterMessageGuard['mode'], threshold = 2): ClusterMessageGuard => ({ mode, threshold });

test('new creation defaults are explicit, independent and board-local; choices win', async () => {
  const c = await make();
  assert.equal(c.efficiencyLevel, 'balanced'); assert.equal(c.progressTracking, 'both');
  assert.equal(store.normalizeTaskBoardMode(c), 'cluster');
  assert.deepEqual(c.messageGuard, { mode: 'warn', threshold: 15 });
  const task = ledger.newTask({ title: 'Existing project work' });
  await ledger.save(c.cwd, [task]);
  const before = await fs.readFile(join(c.cwd, '.arco', 'project', 'tasks.json'));
  assert.deepEqual(await ledger.load(c.cwd, store.taskBoardKeyForState(c)), []);
  const other = await store.createCluster({ cwd: c.cwd, memberWorkflowIds: [randomUUID(), randomUUID()] });
  await ledger.save(c.cwd, [ledger.newTask({ title: 'Cluster-only work' })], store.taskBoardKeyForState(c));
  assert.deepEqual(await ledger.load(c.cwd, store.taskBoardKeyForState(other)), []);
  assert.deepEqual(await fs.readFile(join(c.cwd, '.arco', 'project', 'tasks.json')), before);
  const lean = await make({ efficiencyLevel: 'lean' });
  assert.deepEqual(lean.messageGuard, { mode: 'warn', threshold: 15 });
  const explicit = await make({ efficiencyLevel: 'thorough', progressTracking: 'plan', taskBoardMode: 'none', messageGuard: guard('none', 19) });
  assert.equal(explicit.efficiencyLevel, 'thorough'); assert.equal(explicit.progressTracking, 'plan');
  assert.equal(store.normalizeTaskBoardMode(explicit), 'none'); assert.deepEqual(explicit.messageGuard, guard('none', 19));
  await assert.rejects(make({ messageGuard: guard('hard', 0) }), /Invalid cluster/);
});

test('legacy omitted fields keep old caps and board meaning, pinned before any style edit', async () => {
  for (const level of [undefined, 'thorough', 'balanced', 'lean'] as const) {
    const id = randomUUID(), members = [randomUUID(), randomUUID()];
    const state: ClusterState = { clusterId: id, members, cwd: sandbox, schemaVersion: 1, createdAt: '', ...(level ? { efficiencyLevel: level } : {}) };
    await fs.mkdir(store.clusterDir(id), { recursive: true });
    await fs.writeFile(store.clusterMetaPath(id), JSON.stringify(state));
    const loaded = await store.readCluster(id); assert.ok(loaded);
    assert.equal(store.getEfficiencyLevel(id), level ?? 'thorough');
    assert.equal(store.normalizeTaskBoardMode(loaded), 'project');
    assert.equal(store.normalizeTaskBoardMode({ taskBoardAttached: false }), 'none');
    const legacyGuard = resolveClusterMessageGuard(state);
    assert.deepEqual(store.getMessageGuard(id), legacyGuard);
    await store.setEfficiency(id, level === 'lean' ? 'balanced' : 'lean', 'Retained NOTE');
    assert.deepEqual(store.getMessageGuard(id), legacyGuard);
    const child = spawnSync(process.execPath, ['--conditions', 'development', '--import', 'tsx', '--input-type=module', '-e', `import * as s from ${JSON.stringify(new URL('./clusterStore.ts', import.meta.url).href)}; await s.readCluster(${JSON.stringify(id)}); console.log(JSON.stringify(s.getMessageGuard(${JSON.stringify(id)})));`], { env: process.env, encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, 0, child.stderr); assert.deepEqual(JSON.parse(child.stdout.trim()), legacyGuard);
  }
});

test('explicit guards stay independent of style, NOTE and progress edits; malformed guard rejected', async () => {
  const c = await make();
  for (const mode of ['warn', 'hard', 'none'] as const) {
    await store.setEfficiency(c.clusterId, 'lean', 'A note', guard(mode, 23));
    await store.setEfficiency(c.clusterId, 'thorough');
    await store.setProgressTracking(c.clusterId, 'board');
    assert.deepEqual(store.getMessageGuard(c.clusterId), guard(mode, 23));
    assert.equal(store.getEfficiencyAddendum(c.clusterId), 'A note');
  }
  const before = await fs.readFile(store.clusterMetaPath(c.clusterId));
  assert.equal(await store.setEfficiency(c.clusterId, 'balanced', '', guard('warn', 1.5)), null);
  assert.deepEqual(await fs.readFile(store.clusterMetaPath(c.clusterId)), before);
  for (const value of [0, -1, 1.5, 1001, NaN]) assert.equal(isClusterMessageGuard(guard('hard', value)), false);
  for (const value of [1, 15, 1000]) assert.equal(isClusterMessageGuard(guard('warn', value)), true);
});

test('warn-only accepts above threshold, warns once after successful enqueue and resets per sender', async () => {
  const c = await make({ messageGuard: guard('warn') }), ctx = context(c);
  let warnings = 0;
  for (let i = 1; i <= 6; i++) {
    if (i === 3) {
      const failed = await peer.peerSend(ctx, { to: c.members[1], content: 'q'.repeat(17000) });
      assert.equal(failed.ok, false);
    }
    const r = await peer.peerSend(ctx, { to: c.members[1], content: 'warn-' + i });
    assert.equal(r.ok, true); if (!r.ok) continue;
    assert.equal(r.guard?.count, i); assert.equal(r.guard?.remaining, null);
    if (r.guard?.warning) { warnings++; assert.match(r.guard.warning, /Mail accepted/); }
  }
  assert.equal(warnings, 1); assert.equal(await (await import('./clusterMailbox.js')).depthFor(c.members[1]), 6);
  budget.reset(ctx.workflowId);
  for (let i = 1; i <= 3; i++) {
    const r = await peer.peerSend(ctx, { to: c.members[1], content: 'new-turn-' + i });
    assert.ok(r.ok); assert.equal(Boolean(r.guard?.warning), i === 3);
  }
  assert.equal(budget.peek(c.members[1]).count, 0);
});

test('hard guard rejects without delivery, refunds failures and dedupe, and reserves concurrency', async () => {
  const c = await make({ messageGuard: guard('hard') }), ctx = context(c);
  const first = await peer.peerSend(ctx, { to: c.members[1], content: 'first' }); assert.ok(first.ok); assert.equal(first.guard?.remaining, 1);
  const duplicate = await peer.peerSend(ctx, { to: c.members[1], content: 'first' }); assert.equal(!duplicate.ok && duplicate.code, 'duplicate_send');
  const tooBig = await peer.peerSend(ctx, { to: c.members[1], content: 'x'.repeat(17000) }); assert.equal(!tooBig.ok && tooBig.code, 'content_too_large');
  assert.equal(budget.peek(ctx.workflowId).count, 1);
  const results = await Promise.all(['second', 'third'].map(content => peer.peerSend(ctx, { to: c.members[1], content })));
  assert.equal(results.filter(r => r.ok).length, 1);
  const rejected = results.find(r => !r.ok); assert.ok(rejected && !rejected.ok);
  assert.equal(rejected.code, 'budget_exhausted'); assert.equal(rejected.count, 2); assert.equal(rejected.cap, 2);
  assert.match(rejected.message, /not delivered/); assert.equal(budget.peek(ctx.workflowId).count, 2);
  budget.reset(ctx.workflowId);
  assert.ok((await peer.peerSend(ctx, { to: c.members[1], content: 'third' })).ok, 'refused send did not poison dedupe');
  const external = await make();
  const invalid = await peer.peerSend(ctx, { to: external.members[0], content: 'outside' }); assert.equal(!invalid.ok && invalid.code, 'unknown_peer');
  const bypass = await peer.peerSend(ctx, { to: c.members[1], content: 'operator' }, { bypassBudget: true }); assert.ok(bypass.ok);
  assert.equal(budget.peek(ctx.workflowId).count, 1);
});

test('Native tool results expose warning/count feedback without extra peer messages', async () => {
  const { executePeerTool } = await import('./providers/claude-native/peerTools.js');
  const c = await make({ messageGuard: guard('warn', 1) });
  const ctx = { workflowId: c.members[0], clusterId: c.clusterId, broadcast: () => {} };
  const first = JSON.parse(await executePeerTool('peer_send', { to: c.members[1], content: 'Native first' }, ctx));
  assert.equal(first.guard?.count, 1);
  const second = JSON.parse(await executePeerTool('peer_send', { to: c.members[1], content: 'Native second' }, ctx));
  assert.match(second.guard?.warning, /Mail accepted/);
  const denied = await executePeerTool('cluster_task_list', {}, { ...ctx, accessMode: 'blind' });
  assert.match(denied, /access_denied/);
});

test('no limit removes only peer quota; size, dedupe and membership fences still apply', async () => {
  const c = await make({ messageGuard: guard('none', 1) }), ctx = context(c);
  for (let i = 0; i < 18; i++) {
    const r = await peer.peerSend(ctx, { to: c.members[1], content: 'unlimited-' + i });
    assert.ok(r.ok); assert.equal(r.guard?.cap, null); assert.equal(r.guard?.threshold, null); assert.equal(r.guard?.warning, undefined);
  }
  assert.equal(budget.peek(ctx.workflowId).count, 18);
  const invalid = await peer.peerSend(ctx, { to: c.members[1], content: 'z'.repeat(17000) }); assert.equal(invalid.ok, false);
  assert.equal(budget.peek(ctx.workflowId).count, 18);
});

test('snapshot restore retains explicit choices and old-format omitted fallback without migrating boards', async () => {
  const c = await make({ efficiencyLevel: 'lean', progressTracking: 'board', taskBoardMode: 'project', messageGuard: guard('hard', 31) });
  for (const id of c.members) await writeMeta(c.cwd, { workflowId: id, name: 'Fixture', cwd: c.cwd, createdAt: 1, lastActiveAt: 1, primaryProvider: 'claude', primaryModel: 'sonnet', primaryEffort: 'medium', cliSessions: [], operator: 'fixture', lastEventSeq: null, lastTranscriptSeq: null, compactedAt: null });
  const snapshot = await snapshots.saveSnapshot({ clusterId: c.clusterId, name: 'Coordination fixture' });
  const restored = await snapshots.restoreSnapshot(snapshot.id, c.cwd);
  const state = await store.readCluster(restored.cluster.clusterId); assert.ok(state);
  assert.equal(state.efficiencyLevel, 'lean'); assert.equal(state.progressTracking, 'board');
  assert.equal(store.normalizeTaskBoardMode(state), 'project'); assert.deepEqual(state.messageGuard, guard('hard', 31));
  const path = join(process.env.ARCO_HOME!, 'cluster-snapshots', snapshot.id, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(path, 'utf8'));
  delete manifest.clusterState.efficiencyLevel; delete manifest.clusterState.messageGuard;
  delete manifest.clusterState.taskBoardMode; delete manifest.clusterState.taskBoardAttached; delete manifest.clusterState.progressTracking;
  await fs.writeFile(path, JSON.stringify(manifest));
  const legacy = await snapshots.restoreSnapshot(snapshot.id, c.cwd);
  const oldState = await store.readCluster(legacy.cluster.clusterId); assert.ok(oldState);
  assert.equal(store.getEfficiencyLevel(legacy.cluster.clusterId), 'thorough'); assert.deepEqual(oldState.messageGuard, guard('hard', 15));
  assert.equal(store.normalizeTaskBoardMode(oldState), 'project'); assert.equal(store.getProgressTracking(legacy.cluster.clusterId), 'both');
  assert.notEqual(oldState.autoTurnOnMailboxEnabled, true);
});

test('role-aware coordination and all mail entry points preserve required review without status loops', () => {
  for (const level of ['thorough', 'balanced', 'lean'] as const) {
    const director = buildClusterCoordination(level, 'Operator instruction', 'Director role.');
    assert.match(director, /exact placement/); assert.match(director, /final diff/); assert.match(director, /concrete blockers/);
    assert.match(director, /Operator NOTE.*not a mode or budget/);
    const builder = buildClusterCoordination(level, undefined, 'Implementer role.');
    assert.match(builder, /before the full gate/); assert.match(builder, /candidate tree or patch/);
    assert.doesNotMatch(builder, /assign whole phases|Do NOT review|skip.*tests/i);
    for (const prompt of [buildClusterNudge(level, false, 'Director'), buildClusterMailboxNotice(level, 2, 'Director'), buildClusterAutoPickup(level, 'Director')]) {
      assert.match(prompt, /concrete contradictory evidence/); assert.match(prompt, /required.*review/); assert.match(prompt, /Delegate/);
    }
    assert.match(buildClusterNudge(level, true), /without interrupting current work/);
  }
});

test('the previous unedited Builder preset keeps its preset, label and normalizes forward', () => {
  const legacy = 'Implementer role. Focus on your assigned scope. Use peer_send to report progress + blockers, not to direct peers.';
  const current = ROLE_PRESETS.find((p) => p.key === 'builder')!.text;
  assert.equal(presetForText(legacy)?.label, 'BUILDER'); assert.equal(presetForText(current)?.label, 'BUILDER');
  assert.equal(normalizeClusterRoleText(`  ${legacy} `), current);
  assert.equal(presetForText(`${legacy} Custom.`), undefined, 'an edited role stays custom');
});
