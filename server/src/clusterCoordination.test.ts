import type { ClusterState } from './clusterStore.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { presetForText, normalizeClusterRoleText, ROLE_PRESETS, buildTurnWaitInstructions, buildClusterCoordination, buildClusterNudge, buildClusterMailboxNotice, buildClusterAutoPickup, resolveClusterMessageGuard, isClusterMessageGuard, type ClusterMessageGuard } from '@arco/shared';

import { buildLocalClusterSystemPrompt, withLocalTurnWaitInstructions, OLLAMA_PRIMARY_SYSTEM_PROMPT, LLAMACPP_PRIMARY_SYSTEM_PROMPT } from './server/prompts.js';
import { codexClusterDeveloperInstructions } from './providers/codexCodeMode.js';
import { buildClusterDirectorDoctrine } from './clusterDirector.js';

const sandbox = await fs.mkdtemp(join(tmpdir(), 'arco-coordination-'));
process.env.ARCO_HOME = join(sandbox, 'home');
const store = await import('./clusterStore.js');
const peer = await import('./clusterPeerOps.js');
const budget = await import('./clusterBudget.js');
const ledger = await import('./project/taskLedger.js');
const snapshots = await import('./clusterSnapshots.js');
const { writeMeta } = await import('./workflowMeta.js');
const { settleProjectWrites } = await import('./testSupport/projectWrites.js');
const { flushAll } = await import('./workflowStore.js');
const { trackRecallFixture } = await import('./testSupport/recallFixture.test-support.js');
const closeRecall = trackRecallFixture();
after(async () => { await settleProjectWrites(); await closeRecall(); await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
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
  const { writeSkill } = await import('./skills.js');
  const skill = await writeSkill({ scope: 'project', name: 'Snapshot fixture', description: '', body: 'Preserve this standing fixture.' }, c.cwd);
  const skillPins = [{ scope: 'project' as const, slug: skill.slug }];
  await store.setSkillPins(c.clusterId, skillPins);
  for (const id of c.members) await writeMeta(c.cwd, { workflowId: id, name: 'Fixture', cwd: c.cwd, createdAt: 1, lastActiveAt: 1, primaryProvider: 'claude', primaryModel: 'sonnet', primaryEffort: 'medium', cliSessions: [], operator: 'fixture', lastEventSeq: null, lastTranscriptSeq: null, compactedAt: null });
  const snapshot = await snapshots.saveSnapshot({ clusterId: c.clusterId, name: 'Coordination fixture' });
  const restored = await snapshots.restoreSnapshot(snapshot.id, c.cwd);
  const state = await store.readCluster(restored.cluster.clusterId); assert.ok(state);
  assert.equal(state.efficiencyLevel, 'lean'); assert.equal(state.progressTracking, 'board');
  assert.deepEqual(state.skillPins, skillPins);
  assert.equal(store.normalizeTaskBoardMode(state), 'project'); assert.deepEqual(state.messageGuard, guard('hard', 31));
  const path = join(process.env.ARCO_HOME!, 'cluster-snapshots', snapshot.id, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(path, 'utf8'));
  delete manifest.clusterState.efficiencyLevel; delete manifest.clusterState.messageGuard;
  delete manifest.clusterState.taskBoardMode; delete manifest.clusterState.taskBoardAttached; delete manifest.clusterState.progressTracking;
  delete manifest.clusterState.skillPins;
  await fs.writeFile(path, JSON.stringify(manifest));
  const legacy = await snapshots.restoreSnapshot(snapshot.id, c.cwd);
  const oldState = await store.readCluster(legacy.cluster.clusterId); assert.ok(oldState);
  assert.equal(store.getEfficiencyLevel(legacy.cluster.clusterId), 'thorough'); assert.deepEqual(oldState.messageGuard, guard('hard', 15));
  assert.equal(store.normalizeTaskBoardMode(oldState), 'project'); assert.equal(store.getProgressTracking(legacy.cluster.clusterId), 'both');
  assert.notEqual(oldState.autoTurnOnMailboxEnabled, true);
});

test('snapshot restore preserves both historical director roles', async () => {
  const c = await make();
  const roles = ['Director role.', 'Coordinator role.'];
  for (const [i, id] of c.members.entries()) {
    await writeMeta(c.cwd, { workflowId: id, name: `Fixture ${i}`, cwd: c.cwd, createdAt: 1, lastActiveAt: 1, primaryProvider: 'claude', primaryModel: 'sonnet', primaryEffort: 'medium', cliSessions: [], operator: 'fixture', lastEventSeq: null, lastTranscriptSeq: null, compactedAt: null });
    await store.setMemberRole(c.clusterId, id, roles[i]!, { restoringSnapshot: true });
  }
  const snapshot = await snapshots.saveSnapshot({ clusterId: c.clusterId, name: 'Historical roles' });
  const restored = await snapshots.restoreSnapshot(snapshot.id, c.cwd);
  const state = await store.readCluster(restored.cluster.clusterId); assert.ok(state);
  assert.equal(state.members.length, 2);
  assert.deepEqual(state.members.map((id) => state.memberRoles?.[id]), roles);
});

test('role-aware coordination and all mail entry points preserve required review without status loops', () => {
  for (const level of ['thorough', 'balanced', 'lean'] as const) {
    const director = buildClusterCoordination(level, 'Operator instruction', 'Director role.');
    assert.match(director, /exact placement/); assert.match(director, /final diff/); assert.match(director, /concrete blockers/);
    assert.match(director, /Operator NOTE.*not a mode or budget/);
    const builder = buildClusterCoordination(level, undefined, 'Implementer role.');
    const guardLine = 'Efficiency guides coordination and testing. Message guards, safety checks, operator-requested review and landing review stay unchanged.';
    const sendCheck = 'Before sending, check that the message gives the recipient something to act on or something it is waiting for. A closing note to a member whose work is finished (landed, thanks, nothing further) does neither; record it on the board instead.';
    const nextStep = "When a report states the sender's next step, no reply approves it; reply only to change that step, answer a question, or assign other work. Reports that continue on their own end with their next step.";
    const noWait = 'Do not wait inside a turn for long-running checks: never sleep or poll for more than 60 seconds at a time. Start long runs in the background or hand them off, report what is running, and end the turn.';
    for (const prompt of [director, builder]) {
      assert.equal(prompt.split(sendCheck).length - 1, 1);
      assert.equal(prompt.split(nextStep).length - 1, 1);
      assert.ok(prompt.includes(`${sendCheck}\n\n${nextStep}`));
      assert.ok(prompt.includes(`${guardLine}\n\n${sendCheck}`));
    }
    const workerWait = buildTurnWaitInstructions('Implementer');
    const continueWork = 'When you report progress or answer a question while assigned work is unfinished, continue that work in the same turn; end the turn only when it is done or with one stated blocker.';
    for (const role of [undefined, ...ROLE_PRESETS.filter((preset) => preset.key !== 'director').map((preset) => preset.text)]) {
      assert.equal(buildTurnWaitInstructions(role).split(continueWork).length - 1, 1);
    }
    assert.doesNotMatch(buildTurnWaitInstructions('Director'), /continue that work in the same turn/);
    for (const [role, coordination] of [['Director', director], ['Implementer', builder]] as const) {
      assert.doesNotMatch(coordination, /60 seconds|120 seconds/);
      const expected = buildTurnWaitInstructions(role);
      const assertOneWait = (prompt: string) => {
        assert.equal(prompt.split(expected).length - 1, 1);
        assert.equal(prompt.split(role === 'Director' ? workerWait : noWait).length - 1, 0);
        assert.equal(prompt.match(/(?:60|120) seconds/g)?.length, 1);
      };
      // Check the assembled sources, not just the coordination fragment.
      for (const base of [OLLAMA_PRIMARY_SYSTEM_PROMPT, LLAMACPP_PRIMARY_SYSTEM_PROMPT]) {
        assertOneWait(buildLocalClusterSystemPrompt({
          base: withLocalTurnWaitInstructions(base, role), clusterRole: role,
          clusterEfficiencyDoctrine: coordination,
          clusterProgressDoctrine: buildClusterDirectorDoctrine(role),
        }));
      }
      const codex = codexClusterDeveloperInstructions({ provider: 'codex', model: 'fixture', effort: 'low', cwd: '/tmp/project', clusterId: 'fixture', clusterRole: role });
      assertOneWait([codex, coordination].join('\n\n'));
      // Other remote provider prefixes use the same role-aware builder.
      assertOneWait([expected, coordination, buildClusterDirectorDoctrine(role)].filter(Boolean).join('\n\n'));
    }
    for (const base of [OLLAMA_PRIMARY_SYSTEM_PROMPT, LLAMACPP_PRIMARY_SYSTEM_PROMPT]) {
      const standalone = withLocalTurnWaitInstructions(base);
      assert.equal(standalone.split(workerWait).length - 1, 1);
      assert.doesNotMatch(standalone, /60 seconds/);
    }
    assert.match(workerWait, /at most 120 seconds each/);
    assert.match(workerWait, /Between waits, check for new messages \(peer_read in a cluster\)/);
    assert.match(workerWait, /Report when the result is in/);
    assert.match(workerWait, /what you are waiting on and that you need a nudge/);
    assert.match(builder, /what was done, what was run and what is not covered/);
    const testing = { lean: /Testing: run only the tests for what you changed/, balanced: /Testing: add one test for each real fault you fix/, thorough: /Testing: test new behaviour and each fault you fix/ };
    assert.match(builder, testing[level]);
    assert.doesNotMatch(builder, /assign whole phases|Do NOT review|skip.*tests/i);
    for (const prompt of [buildClusterNudge(level, false, 'Director'), buildClusterMailboxNotice(level, 2, 'Director'), buildClusterAutoPickup(level, 'Director')]) {
      assert.match(prompt, /concrete contradictory evidence/); assert.match(prompt, /required.*review/); assert.match(prompt, /Delegate/);
    }
    assert.match(buildClusterNudge(level, true), /without interrupting current work/);
  }
});

test('Advisor and Designer presets survive storage and remain ordinary cluster members', async () => {
  const c = await make();
  const { isClusterDirector, clusterDirectorProblem } = await import('@arco/shared');
  const { buildClusterDirectorDoctrine } = await import('./clusterDirector.js');
  for (const [i, key] of ['advisor', 'designer'].entries()) {
    const preset = ROLE_PRESETS.find((p) => p.key === key)!;
    assert.ok(preset, key);
    assert.ok(preset.text.length <= store.MEMBER_ROLE_MAX, `${key} is not truncated`);
    await store.setMemberRole(c.clusterId, c.members[i]!, preset.text);
    const saved = (await store.readCluster(c.clusterId))!.memberRoles![c.members[i]!]!;
    assert.equal(saved, preset.text);
    assert.equal(normalizeClusterRoleText(`  ${saved} `), preset.text);
    assert.equal(presetForText(saved)?.key, key);
    assert.equal(isClusterDirector(saved), false);
    assert.equal(clusterDirectorProblem(['Director role.', saved]), null);
    assert.equal(buildClusterDirectorDoctrine(saved), undefined);
    assert.match(buildClusterCoordination('balanced', undefined, saved), /Finish the assigned outcome/);
    assert.match(buildClusterAutoPickup('balanced', saved), /within your assigned scope/);
  }
  const misplaced = await peer.peerSend(context(c, c.members[1]), { to: 'Director', content: 'A Director-only request' });
  assert.equal(misplaced.ok, false, 'mentioning Director in the Advisor body does not make it a recipient');
  const addressed = await peer.peerSend(context(c, c.members[1]), { to: 'Advisor', content: 'Please recommend a choice.' });
  assert.equal(addressed.ok, true, 'the canonical Advisor role remains addressable');
  assert.match(buildClusterDirectorDoctrine('Director role.')!, /has an Advisor.*consult it.*decision remains yours/);
});

test('previous role presets retain their labels while edited roles stay custom', () => {
  const legacy: Array<[string, string]> = [
    ['reviewer', "Reviewer role. Read peer output via peer_read and the cluster plan. Critique. Don't write code; write critiques."],
    ['researcher', "Researcher role. Investigate the codebase, produce findings as text. Don't modify files. Surface findings via peer_send."],
    ['documenter', 'Documenter role. Read peer work via peer_read; write + update docs (README, guides, comments). Modify docs only.'],
    ['designer', 'Designer role. Own screen layout, states, wording and accessibility. Change UI files only; report via peer_send.'],
  ];
  for (const [key, text] of legacy) {
    const current = ROLE_PRESETS.find((preset) => preset.key === key)!;
    assert.ok(current.text.length <= 120);
    assert.equal(normalizeClusterRoleText(`  ${text} `), current.text);
    assert.equal(presetForText(text)?.label, current.label);
    assert.equal(presetForText(`${text} Custom.`), undefined);
  }
});

test('the previous unedited Builder preset keeps its preset, label and normalizes forward', () => {
  const legacy = 'Implementer role. Focus on your assigned scope. Use peer_send to report progress + blockers, not to direct peers.';
  const current = ROLE_PRESETS.find((p) => p.key === 'builder')!.text;
  assert.equal(presetForText('Implementer role. Finish assigned work and routine compatible choices; send one blocker or final evidence via peer_send.')?.label, 'BUILDER');
  assert.equal(presetForText(legacy)?.label, 'BUILDER'); assert.equal(presetForText(current)?.label, 'BUILDER');
  assert.equal(normalizeClusterRoleText(`  ${legacy} `), current);
  assert.equal(presetForText(`${legacy} Custom.`), undefined, 'an edited role stays custom');
});

test('the previous Tester preset keeps its preset, label and normalizes forward', () => {
  const legacy = 'Tester role. Write + run tests against peer work. Report failures via peer_send. Modify test files only.';
  const current = ROLE_PRESETS.find((p) => p.key === 'tester')!.text;
  assert.ok(current.length <= 120);
  assert.match(current, /Run project checks/);
  assert.equal(presetForText('Tester role. Write + run tests and full verification (e.g. landing gates); report via peer_send. Modify test files only.')?.label, 'TESTER');
  assert.equal(presetForText(legacy)?.label, 'TESTER');
  assert.equal(presetForText(current)?.label, 'TESTER');
  assert.equal(normalizeClusterRoleText(`  ${legacy} `), current);
  assert.equal(presetForText(`${legacy} Custom.`), undefined, 'an edited role stays custom');
});

test('cluster board directories are portable and an existing colon-named board keeps its tasks', async () => {
  const c = await make();
  const key = store.taskBoardKeyForState(c)!;
  assert.match(key, /:/);
  const created = ledger.newTask({ title: 'portable board task' });
  await ledger.save(c.cwd, [created], key);
  const boards = join(c.cwd, '.arco', 'project', 'boards');
  const names = await fs.readdir(boards);
  assert.deepEqual(names, [ledger.taskBoardDirName(key)]); assert(!names[0].includes(':'), names[0]);
  assert.equal((await ledger.load(c.cwd, key))[0]?.title, 'portable board task');
  assert.equal((await ledger.load(c.cwd)).length, 0, 'the project board stays separate');
  if (process.platform === 'win32') return;
  const legacyCwd = await fs.mkdtemp(join(sandbox, 'legacy-'));
  const legacyDir = join(legacyCwd, '.arco', 'project', 'boards', key);
  await fs.mkdir(legacyDir, { recursive: true });
  const kept = ledger.newTask({ title: 'written before the mapping' });
  await fs.writeFile(join(legacyDir, 'tasks.json'), JSON.stringify({ version: 1, tasks: [kept] }));
  assert.equal((await ledger.load(legacyCwd, key))[0]?.title, 'written before the mapping');
  await ledger.save(legacyCwd, [kept, ledger.newTask({ title: 'added later' })], key);
  assert.deepEqual(await fs.readdir(join(legacyCwd, '.arco', 'project', 'boards')), [key], 'no second directory for the same board');
  assert.equal((await ledger.load(legacyCwd, key)).length, 2);
});


test('peer send returns recipient context from the board and latest reply', async () => {
  const c = await make();
  const task = { ...ledger.newTask({ title: 'Check the fixture' }), assignee: c.members[1], status: 'in_progress' as const };
  await ledger.save(c.cwd, [task], store.taskBoardKeyForState(c));
  assert.ok((await peer.peerSend(context(c, c.members[1]), { to: c.members[0], content: 'Ready to review\nDetails follow' })).ok);
  const sent = await peer.peerSend(context(c), { to: c.members[1], content: 'Please inspect' });
  assert.ok(sent.ok);
  assert.equal(sent.recipientContext?.task?.title, 'Check the fixture');
  assert.equal(sent.recipientContext?.lastMessage?.firstLine, 'Ready to review');
  assert.equal(sent.recipientContext?.state, 'unknown');
});

test('a handoff with task_id records the approval current when it was sent', async () => {
  const c = await make();
  const key = store.taskBoardKeyForState(c);
  const base = ledger.newTask({ title: 'Write the fixture notes' });
  const approvedTask = ledger.applyUpdate([base], base.id, { approved: true })!.updated;
  await ledger.save(c.cwd, [approvedTask], key);
  assert.ok((await peer.peerSend(context(c), { to: c.members[1], content: 'Please write the fixture notes.', taskId: base.id })).ok);
  const recorded = (await ledger.loadKernel(c.cwd, key)).comments.find((cm) => cm.metadata?.kind === 'handoff');
  assert.equal(recorded?.metadata?.approvalId, approvedTask.operatorApproval!.id);
});

test('director status-only sends are held once before accounting, and confirmation delivers unchanged', async () => {
  const c = await make({ messageGuard: guard('hard', 10) });
  await store.setMemberRole(c.clusterId, c.members[0], 'Director role.');
  await store.setMemberRole(c.clusterId, c.members[1], 'Implementer role.');
  const events: any[] = [];
  const ctx = { ...context(c), broadcastSender: (event: any) => events.push(event) };
  const attachment = await peer.peerSend(ctx, { to: c.members[1], content: 'landed artifact', artifactPaths: ['artifact.txt'] });
  assert.equal(!attachment.ok && attachment.code, 'enqueue_failed');
  const body = 'landed X, tag moved';
  const held = await peer.peerSend(ctx, { to: c.members[1], content: body });
  assert.equal(!held.ok && held.code, 'status_confirmation');
  assert.equal(budget.peek(c.members[0]).count, 0);
  assert.equal(events.at(-1)?.reason, 'status_confirmation');
  // A task_id does not exempt a status-only message from confirmation.
  const boardTask = ledger.newTask({ title: 'Check the fixture' });
  await ledger.save(c.cwd, [boardTask], store.taskBoardKeyForState(c));
  const heldWithTask = await peer.peerSend(ctx, { to: c.members[1], content: body, taskId: boardTask.id });
  assert.equal(!heldWithTask.ok && heldWithTask.code, 'status_confirmation');
  const delivered = await peer.peerSend(ctx, { to: c.members[1], content: body, confirm: true });
  assert.ok(delivered.ok);
  assert.equal((await peer.peerRead(context(c, c.members[1])))[0]?.content, body);
  assert.equal(budget.peek(c.members[0]).count, 1);
  for (const text of ['landed X; rebase onto it', 'landed X; what next?', 'accepted P6.53', 'merged #42', 'landed X; assignment: 5fbd0f17', 'tagged 12345678-1234-1234-1234-123456789012']) {
    assert.ok((await peer.peerSend(ctx, { to: c.members[1], content: text })).ok, text);
  }
  assert.ok((await peer.peerSend(context(c, c.members[1]), { to: c.members[0], content: 'DONE: landed X, tag moved' })).ok);
  assert.ok((await peer.peerSend(ctx, { to: c.members[1], content: 'recorded operator note' }, { bypassBudget: true, bypassDedupe: true })).ok);
  const full = await make({ messageGuard: guard('hard', 1) });
  await store.setMemberRole(full.clusterId, full.members[0], 'Director role.');
  const fullCtx = context(full);
  assert.ok((await peer.peerSend(fullCtx, { to: full.members[1], content: 'Please run tests' })).ok);
  const another = 'merged changes';
  assert.equal((await peer.peerSend(fullCtx, { to: full.members[1], content: another })).ok, false);
  assert.ok((await peer.peerSend(fullCtx, { to: full.members[1], content: another, confirm: true })).ok);
  assert.equal((await peer.peerSend(fullCtx, { to: full.members[1], content: 'Please run other tests', confirm: true })).ok, false);

});

test('status classifier exempts instructions and questions and detects standalone status words', () => {
  assert.equal(peer.isStatusOnlyPeerMessage('landed X, tag moved'), true);
  for (const text of ['landed X; rebase onto it', 'accepted; fix the test', 'tagged; continue?', 'push notification', 'DONE']) {
    assert.equal(peer.isStatusOnlyPeerMessage(text), false, text);
  }
});

test('director met sign-off closes a task and records who closed it', async () => {
  const c = await make();
  await store.setMemberRole(c.clusterId, c.members[0], 'Director role.');
  const task = ledger.newTask({ title: 'Finished' });
  await ledger.save(c.cwd, [task], store.taskBoardKeyForState(c));
  const result = await peer.peerTaskUpdate(context(c), { id: task.id, status: 'review', signoff: { state: 'met', summary: 'Ready.' } }, () => {});
  assert.ok(result.ok); assert.equal(result.task.status, 'done');
  assert.equal(result.task.directorClosure?.byWorkflowId, c.members[0]);
  assert.equal(result.task.directorClosure?.at, result.task.signoff?.at);
  const persisted = await ledger.load(c.cwd, store.taskBoardKeyForState(c));
  assert.equal(persisted[0].status, 'done'); assert.deepEqual(persisted[0].directorClosure, result.task.directorClosure);
  const reopened = ledger.applyUpdate(persisted, task.id, { status: 'review' });
  assert.ok(reopened); assert.equal(reopened.updated.directorClosure, undefined);
});

test('explicitly disabled auto-done keeps new met sign-offs in review', async () => {
  const c = await make();
  await store.setMemberRole(c.clusterId, c.members[0], 'Director role.');
  const settings = await import('./settings.js');
  await settings.patchSettings({ autoMarkDoneOnMetSignoff: false });
  assert.equal((await settings.readSettings()).autoMarkDoneOnMetSignoff, false);
  const task = ledger.newTask({ title: 'Needs acceptance' });
  await ledger.save(c.cwd, [task], store.taskBoardKeyForState(c));
  const result = await peer.peerTaskUpdate(context(c), { id: task.id, status: 'review', signoff: { state: 'met' } }, () => {});
  assert.ok(result.ok); assert.equal(result.task.status, 'review'); assert.equal(result.task.directorClosure, undefined);
  await settings.patchSettings({ autoMarkDoneOnMetSignoff: true });
  assert.equal((await ledger.load(c.cwd, store.taskBoardKeyForState(c)))[0].status, 'review', 'existing sign-offs are not closed retroactively');
});

test('non-directors and incomplete verdicts do not close a task', async () => {
  const c = await make();
  await store.setMemberRole(c.clusterId, c.members[0], 'Director role.');
  const tasks = ['worker', 'partial', 'not met'].map(title => ledger.newTask({ title }));
  await ledger.save(c.cwd, tasks, store.taskBoardKeyForState(c));
  const worker = await peer.peerTaskUpdate(context(c, c.members[1]), { id: tasks[0].id, status: 'review', signoff: { state: 'met' } }, () => {});
  assert.ok(worker.ok); assert.equal(worker.task.status, 'review');
  for (const [i, state] of [[1, 'partial'], [2, 'not_met']] as const) {
    const r = await peer.peerTaskUpdate(context(c), { id: tasks[i].id, status: 'review', signoff: { state } }, () => {});
    assert.ok(r.ok); assert.equal(r.task.status, 'review');
    const returned = await peer.peerTaskUpdate(context(c), { id: tasks[i].id, status: i === 1 ? 'in_progress' : 'todo', signoff: { state } }, () => {});
    assert.ok(returned.ok); assert.equal(returned.task.status, i === 1 ? 'in_progress' : 'todo');
    const unchanged = await peer.peerTaskUpdate(context(c), { id: tasks[i].id, signoff: { state } }, () => {});
    assert.ok(unchanged.ok); assert.equal(unchanged.task.status, i === 1 ? 'in_progress' : 'todo');
  }
});

test('explicit met sign-off completes only the uniquely numbered attached item and is safe to repeat', async () => {
  const c = await make();
  await store.setMemberRole(c.clusterId, c.members[0], 'Director role.');
  const bridge = await import('./clusterPlanBridge.js');
  const plan = await bridge.setClusterPlanBody(c.clusterId, '# Plan\n\n- [ ] P9.60 Outcome\n- [ ] P9.61 Later');
  assert.ok(plan);
  const { executePeerTool } = await import('./providers/claude-native/peerTools.js');
  const planRead = JSON.parse(await executePeerTool('cluster_plan_read', {}, { workflowId: c.members[0], clusterId: c.clusterId, broadcast: () => {} }));
  assert.equal(planRead.planId, plan.planId);
  assert.match(planRead.revision, /^[a-f0-9]{64}$/);
  const staleItem = await bridge.completePlanItem(c.clusterId, plan.planId, 'P9.60', { text: 'P9.60 Previous wording', checked: false, revision: planRead.revision });
  assert.equal(!staleItem.ok && staleItem.code, 'stale_plan');
  const task = ledger.newTask({ title: 'P9.60 Outcome' });
  await ledger.save(c.cwd, [task], store.taskBoardKeyForState(c));
  const ctx = context(c);
  const args = { id: task.id, signoff: { state: 'met', summary: 'Ready.' }, completePlan: { planId: plan.planId, itemId: 'P9.60', revision: planRead.revision } };
  const workerDenied = await peer.peerTaskUpdate(context(c, c.members[1]), args, () => {});
  assert.equal(workerDenied.ok, false);
  const stale = await peer.peerTaskUpdate(ctx, { ...args, completePlan: { ...args.completePlan, planId: randomUUID() } }, () => {});
  assert.equal(stale.ok, false);
  const bad = await peer.peerTaskUpdate(ctx, { ...args, completePlan: { ...args.completePlan, itemId: 'P9.61' } }, () => {});
  assert.equal(bad.ok, false);
  assert.match((await bridge.readClusterPlan(c.clusterId))!.body, /- \[ \] P9.60/);
  const planStore = await import('./clusterPlanStore.js');
  const receipt = { ...args.completePlan, completedRevision: planStore.planRevision(planStore.checkedPlanBody(plan.body, 2)) };
  const pending = await peer.peerTaskUpdate(ctx, { id: task.id, status: 'review', signoff: { state: 'partial', summary: 'Plan completion pending for P9.60; retry the met sign-off.' }, pendingPlan: receipt }, () => {});
  assert.ok(pending.ok);
  assert.ok((await bridge.completePlanItem(c.clusterId, plan.planId, 'P9.60', { text: 'P9.60 Outcome', checked: false, revision: planRead.revision })).ok);
  assert.ok((await peer.peerTaskUpdate(ctx, args, () => {})).ok);
  assert.ok((await peer.peerTaskUpdate(ctx, args, () => {})).ok);
  const body = (await bridge.readClusterPlan(c.clusterId))!.body;
  assert.match(body, /- \[x\] P9.60/); assert.match(body, /- \[ \] P9.61/);
  assert.equal((await ledger.load(c.cwd, store.taskBoardKeyForState(c)))[0].signoff?.state, 'met');
  const linked = ledger.newTask({ title: 'A linked task', links: [{ kind: 'plan', ref: plan.planId, label: 'P9.61' }] });
  const current = await ledger.load(c.cwd, store.taskBoardKeyForState(c));
  await ledger.save(c.cwd, [...current, linked], store.taskBoardKeyForState(c));
  assert.ok((await peer.peerTaskUpdate(ctx, { id: linked.id, signoff: { state: 'met' }, completePlan: { planId: plan.planId, itemId: 'P9.61', revision: planStore.planRevision(body) } }, () => {})).ok);
  assert.match((await bridge.readClusterPlan(c.clusterId))!.body, /- \[x\] P9.61/);
});

test('cluster authoring enforces the summary limit without stranding legacy items', async () => {
  const c = await make();
  const ctx = context(c);
  const long = 'a'.repeat(241);
  const rejected = await peer.peerPlanWrite(ctx, `# Plan\n- [ ] P1 ${long}`, () => {});
  assert.equal(!rejected.ok && rejected.code, 'item_too_long');
  const bridge = await import('./clusterPlanBridge.js');
  await bridge.setClusterPlanBody(c.clusterId, `# Plan\n- [ ] P1 ${long}`);
  assert.ok((await peer.peerPlanWrite(ctx, `# Plan\n- [ ] P1 ${'a'.repeat(240)} [detail](ref:detail)`, () => {})).ok);
});

test('met sign-off refuses a changed plan and cannot transfer pending completion to another plan', async () => {
  const c = await make(); await store.setMemberRole(c.clusterId, c.members[0], 'Director role.');
  const bridge = await import('./clusterPlanBridge.js');
  const { planRevision, checkedPlanBody } = await import('./clusterPlanStore.js');
  const plan = await bridge.setClusterPlanBody(c.clusterId, '# Plan\n- [ ] P1.1 Reviewed outcome'); assert.ok(plan);
  const task = ledger.newTask({ title: 'P1.1 Work' }); await ledger.save(c.cwd, [task], store.taskBoardKeyForState(c));
  const ctx = context(c), revision = planRevision(plan.body);
  const args = { id: task.id, signoff: { state: 'met' }, completePlan: { planId: plan.planId, itemId: 'P1.1', revision } };
  await bridge.setClusterPlanBody(c.clusterId, '# Plan\n- [ ] P1.1 Changed outcome');
  const stale = await peer.peerTaskUpdate(ctx, args, () => {}); assert.equal(stale.ok, false);
  assert.equal((await ledger.load(c.cwd, store.taskBoardKeyForState(c)))[0].signoff, undefined);
  await bridge.setClusterPlanBody(c.clusterId, plan.body);
  const pendingPlan = { ...args.completePlan, completedRevision: planRevision(checkedPlanBody(plan.body, 1)) };
  assert.ok((await peer.peerTaskUpdate(ctx, { id: task.id, status: 'review', signoff: { state: 'partial', summary: 'Plan completion pending for P1.1; retry the met sign-off.' }, pendingPlan }, () => {})).ok);
  const plans = await import('./planStore.js');
  const replacement = await plans.createPlan(c.cwd, { title: 'Replacement', body: plan.body });
  await bridge.attachExistingPlan(c.clusterId, replacement.id);
  const wrong = await peer.peerTaskUpdate(ctx, { ...args, completePlan: { ...args.completePlan, planId: replacement.id } }, () => {});
  assert.equal(wrong.ok, false);
  assert.match((await bridge.readClusterPlan(c.clusterId))!.body, /- \[ \] P1.1/);
  assert.equal((await ledger.load(c.cwd, store.taskBoardKeyForState(c)))[0].signoff?.planCompletion?.planId, plan.planId);
});

test('plan completion preserves done tasks and refuses archived tasks', async () => {
  const c = await make(); await store.setMemberRole(c.clusterId, c.members[0], 'Director role.');
  const bridge = await import('./clusterPlanBridge.js'); const { planRevision } = await import('./clusterPlanStore.js');
  const plan = await bridge.setClusterPlanBody(c.clusterId, '# Plan\n- [ ] P1.1 Outcome\n- [ ] P1.2 Later'); assert.ok(plan);
  const done = { ...ledger.newTask({ title: 'P1.1 Outcome' }), status: 'done' as const };
  const archived = { ...ledger.newTask({ title: 'P1.2 Later' }), status: 'archived' as const };
  await ledger.save(c.cwd, [done, archived], store.taskBoardKeyForState(c));
  const ctx = context(c), revision = planRevision(plan.body);
  const bad = await peer.peerTaskUpdate(ctx, { id: archived.id, signoff: { state: 'met' }, completePlan: { planId: plan.planId, itemId: 'P1.2', revision } }, () => {});
  assert.equal(bad.ok, false); assert.equal((await ledger.load(c.cwd, store.taskBoardKeyForState(c)))[1].status, 'archived');
  const events: Array<{ type: string }> = [];
  const args = { id: done.id, status: 'review' as const, signoff: { state: 'met' }, completePlan: { planId: plan.planId, itemId: 'P1.1', revision } };
  const completed = await peer.peerTaskUpdate(ctx, args, event => events.push(event)); assert.ok(completed.ok); assert.equal(completed.task.status, 'done');
  const repeat = await peer.peerTaskUpdate(ctx, args, event => events.push(event)); assert.ok(repeat.ok); assert.equal(repeat.task.status, 'done');
  for (const event of events) if (event.type === 'task_ledger_snapshot') assert.doesNotMatch(JSON.stringify(event), /"status":"review"/);
  const beforeReopen = await ledger.load(c.cwd, store.taskBoardKeyForState(c));
  const reopened = ledger.applyUpdate(beforeReopen, done.id, { status: 'review' }); assert.ok(reopened);
  await ledger.save(c.cwd, reopened.tasks, store.taskBoardKeyForState(c));
  const resubmitted = await peer.peerTaskUpdate(ctx, args, event => events.push(event)); assert.ok(resubmitted.ok); assert.equal(resubmitted.task.status, 'done');
  const saved = await ledger.load(c.cwd, store.taskBoardKeyForState(c));
  assert.equal(saved[0].status, 'done');
  const legacy = { ...saved[0], signoff: { state: 'met' as const, at: Date.now() } };
  await ledger.save(c.cwd, [legacy, saved[1]], store.taskBoardKeyForState(c));
  const eventCount = events.length;
  const current = await bridge.readClusterPlan(c.clusterId); assert.ok(current);
  const legacyRetry = await peer.peerTaskUpdate(ctx, { ...args, completePlan: { ...args.completePlan, revision: planRevision(current.body) } }, event => events.push(event));
  assert.ok(legacyRetry.ok); assert.equal(legacyRetry.task.status, 'done'); assert.equal(events.length, eventCount);
});
