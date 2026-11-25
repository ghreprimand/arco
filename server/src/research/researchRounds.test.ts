import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as clusterMailbox from '../clusterMailbox.js';
import * as clusterPeerOps from '../clusterPeerOps.js';
import * as clusterStore from '../clusterStore.js';
import { createResearchFolder } from './researchFolder.js';
import { RESEARCH_ROUND_TIMEOUT_DEFAULT_MINUTES, RESEARCH_ROUND_TIMEOUT_MAX_MINUTES } from '@arco/shared';
import { addResearcher, configureResearch, extendRound, retryResearcher, timeoutRoundIfDue, holdResearcherReply, removeResearcher, onMemberSettled, onRoundMailRead, revealResearch, setResearcherSignInWaiting, startResearchDirector, startRound, timeoutRound } from './researchRounds.js';
import { catchUpKey, initResearch, loadResearch, researchSummary, updateResearch } from './researchState.js';
import { ensureResearchTripwires, observeResearchText, observeResearchTool, RESEARCH_CANARY_FILE, researchToolBoundaryWarning } from './researchTripwires.js';
import { closeResearch, closedResearchRecordPath, installResearchCloseOnDelete, sweepClosedResearch, unsentFiles } from './researchClose.js';
import { setBeforeClusterDelete } from '../clusterStore.js';
import { researchMembersRoot } from './researchCreate.js';
import { prepareResearchCreate } from './researchCreate.js';

// Windows hosted runs time this file out with no per-test lines. Log start/end
// on stderr so a TIMEOUT capture shows how far the file got, and 10 s after the
// last test list active resources (unref'd so a clean exit is not delayed).
if (process.platform === 'win32') {
  let winTestStartedAt = 0;
  beforeEach((t) => {
    winTestStartedAt = Date.now();
    process.stderr.write(`[researchRounds] start ${t.name}\n`);
  });
  afterEach((t) => {
    process.stderr.write(`[researchRounds] end ${t.name} ${Date.now() - winTestStartedAt}ms\n`);
  });
  after(() => {
    const timer = setTimeout(() => {
      const info = typeof process.getActiveResourcesInfo === 'function'
        ? process.getActiveResourcesInfo()
        : [];
      process.stderr.write(`[researchRounds] activeResources ${JSON.stringify(info)}\n`);
    }, 10_000);
    timer.unref();
  });
}


async function project() {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'arco-research-'));
  const folder = await createResearchFolder(join(root, 'research'), 'Which heat pump?', new Date('2026-11-21T00:00:00Z'));
  const membersCwd = join(root, 'members');
  const [director, a, b] = [randomUUID(), randomUUID(), randomUUID()];
  const cluster = await clusterStore.createCluster({ cwd: folder, memberWorkflowIds: [director, a, b], memberCwds: { [a]: membersCwd, [b]: membersCwd }, memberAccessModes: { [a]: 'researcher', [b]: 'researcher' }, research: { projectId: 'p1' }, taskBoardMode: 'none' });
  await initResearch({
    schemaVersion: 1, projectId: 'p1', clusterId: cluster.clusterId, folder, membersCwd, name: 'Heat pump', brief: 'Which heat pump?',
    blind: true, createdAt: new Date().toISOString(), directorWorkflowId: director,
    researchers: [{ workflowId: a, letter: 'A', provider: 'claude', model: 'claude-sonnet-4-6' }, { workflowId: b, letter: 'B', provider: 'ollama', model: 'qwen3:32b' }],
    rounds: [], targetedBeforeRounds: [],
  });
  const woken: string[] = [];
  const prompts: string[] = [];
  configureResearch({
    enqueue: (to, msg, opts) => clusterMailbox.enqueue(to, msg, opts),
    mintMsgId: () => clusterMailbox.mintMsgId(),
    wake: (wfid, prompt) => { woken.push(wfid); prompts.push(prompt); },
    isBusy: () => false,
    pendingMail: (wfid) => clusterMailbox.depthFor(wfid),
    clusterIdFor: (wfid) => clusterStore.getClusterIdForWorkflow(wfid),
    notify: () => undefined,
    now: () => Date.now(),
  });
  const ctx = (workflowId: string): clusterPeerOps.PeerOpsContext => ({ workflowId, clusterId: cluster.clusterId, broadcastSender: () => undefined, broadcastRecipient: () => undefined });
  return { root, folder, membersCwd, director, a, b, clusterId: cluster.clusterId, woken, prompts, ctx };
}

test('the originating project stays in Arco state and is exposed as the results default', async () => {
  const { renderManifest } = await import('./researchFolder.js');
  const p = await project();
  try {
    await updateResearch(p.clusterId, state => { state.sourceProject = join(p.root, 'origin'); });
    const state = (await loadResearch(p.clusterId))!;
    assert.equal(researchSummary(state).sourceProject, join(p.root, 'origin'));
    assert.doesNotMatch(renderManifest(state), /origin/);
    const invalid = await prepareResearchCreate({ type: 'cluster_create_from_scratch', cwd: '', research: { name: 'Fixture', brief: 'Compare.', sourceProject: 'relative' }, members: [
      { provider: 'claude', model: 'sonnet' }, { provider: 'ollama', model: 'fixture' },
    ] });
    assert.deepEqual(invalid, { refusal: 'invalid_source_project' });
    const invalidRerun = await prepareResearchCreate({ type: 'cluster_create_from_scratch', cwd: '', research: { name: 'Fixture', brief: 'Compare.', rerunFrom: '../outside' }, members: [
      { provider: 'claude', model: 'sonnet' }, { provider: 'ollama', model: 'fixture' },
    ] });
    assert.deepEqual(invalidRerun, { refusal: 'invalid_rerun_source' });
  } finally { await clusterStore.deleteCluster(p.clusterId); await fs.rm(p.root, { recursive: true, force: true }); }
});

test('a Gemini Research Director gets its turn text as waiting mail, and its rounds wait for the operator on each researcher', async () => {
  const p = await project();
  try {
    configureResearch({
      enqueue: (to, msg, opts) => clusterMailbox.enqueue(to, msg, opts),
      mintMsgId: () => clusterMailbox.mintMsgId(),
      wake: (wfid, prompt) => { p.woken.push(wfid); p.prompts.push(prompt); },
      operatorOnly: (wfid) => wfid === p.director,
      isBusy: () => false,
      pendingMail: (wfid) => clusterMailbox.depthFor(wfid),
      clusterIdFor: (wfid) => clusterStore.getClusterIdForWorkflow(wfid),
      notify: () => undefined,
      now: () => Date.now(),
    });
    assert.equal(startResearchDirector({ name: 'Heat pump', brief: 'Which heat pump?', directorWorkflowId: p.director }), true);
    for (let i = 0; i < 50 && (await clusterMailbox.peek(p.director)).length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const start = await clusterMailbox.peek(p.director);
    assert.equal(start.length, 1);
    assert.match(start[0].content, /Which heat pump\?/);
    assert.equal(start[0].fromDisplayName, 'Arco research');
    const result = await startRound(p.clusterId, p.director, 'Compare two heat pumps.');
    assert.equal(result.ok, true);
    assert.deepEqual(p.woken, [], 'no turn starts for the Gemini Director or its researchers');
    for (const r of [p.a, p.b]) {
      const mail = await clusterMailbox.peek(r);
      assert.equal(mail.length, 1);
      assert.equal(mail[0].fromGemini, true);
    }
  } finally { await clusterStore.deleteCluster(p.clusterId); await fs.rm(p.root, { recursive: true, force: true }); }
});

test('a Gemini researcher takes its round only on the operator\'s NUDGE, while other researchers start at once', async () => {
  const p = await project();
  try {
    configureResearch({
      enqueue: (to, msg, opts) => clusterMailbox.enqueue(to, msg, opts),
      mintMsgId: () => clusterMailbox.mintMsgId(),
      wake: (wfid, prompt) => { p.woken.push(wfid); p.prompts.push(prompt); },
      operatorOnly: (wfid) => wfid === p.a,
      isBusy: () => false,
      pendingMail: (wfid) => clusterMailbox.depthFor(wfid),
      clusterIdFor: (wfid) => clusterStore.getClusterIdForWorkflow(wfid),
      notify: () => undefined,
      now: () => Date.now(),
    });
    assert.equal((await startRound(p.clusterId, p.director, 'Compare two heat pumps.')).ok, true);
    assert.deepEqual(p.woken, [p.b], 'only the non-Gemini researcher starts a turn');
    const mail = await clusterMailbox.peek(p.a);
    assert.equal(mail.length, 1);
    assert.equal(mail[0].fromGemini, undefined, 'the round is not marked as mail from a Gemini member');
    assert.ok((await loadResearch(p.clusterId))!.rounds[0].entries.A.heldMsgId, 'the deadline waits for the read');
    await updateResearch(p.clusterId, (state) => { state.researchers[0].provider = 'antigravity-cli'; });
    assert.equal(researchSummary((await loadResearch(p.clusterId))!).researchers[0].isolation, 'checking', 'a Gemini researcher is shown as sandboxed work, not tool-fenced');
  } finally { configureResearch(null); await clusterStore.deleteCluster(p.clusterId); await fs.rm(p.root, { recursive: true, force: true }); }
});

test('a fenced researcher, Gemini included, cannot see the research folder, another researcher\'s workspace or the Gemini research sign-in', async () => {
  const { workerHiddenDirectories } = await import('../workers/workerHiddenDirectories.js');
  const { geminiResearchRoot } = await import('../providers/antigravity/researchSignIn.js');
  const p = await project();
  try {
    const cluster = (await clusterStore.readCluster(p.clusterId))!;
    const hidden = workerHiddenDirectories(cluster);
    assert.ok(hidden.includes(p.folder), 'reports are released into the research folder');
    assert.ok(hidden.includes(clusterStore.isolatedWorkspaceFor(p.clusterId, p.b)), 'another researcher\'s workspace');
    assert.ok(hidden.some((dir) => geminiResearchRoot().startsWith(dir + sep)), 'the stored research sign-in');
  } finally { await clusterStore.deleteCluster(p.clusterId); await fs.rm(p.root, { recursive: true, force: true }); }
});

test('a researcher held by a Gemini Research Director is not timed out before it reads the round, then gets the full time limit', async () => {
  const p = await project();
  let now = Date.parse('2026-11-23T00:00:00Z');
  try {
    configureResearch({
      enqueue: (to, msg, opts) => clusterMailbox.enqueue(to, msg, opts),
      mintMsgId: () => clusterMailbox.mintMsgId(),
      wake: (wfid, prompt) => { p.woken.push(wfid); p.prompts.push(prompt); },
      operatorOnly: (wfid) => wfid === p.director,
      isBusy: () => false,
      pendingMail: (wfid) => clusterMailbox.depthFor(wfid),
      clusterIdFor: (wfid) => clusterStore.getClusterIdForWorkflow(wfid),
      notify: () => undefined,
      now: () => now,
    });
    clusterMailbox.setDeliveryListener((wfid, msgs) => { void onRoundMailRead(wfid, msgs.map((m) => m.msgId)); });
    assert.equal((await startRound(p.clusterId, p.director, 'Compare two heat pumps.')).ok, true);
    now += 60 * 60_000;
    await timeoutRound(p.clusterId, 1);
    let state = (await loadResearch(p.clusterId))!;
    assert.equal(state.rounds[0].entries.A.state, 'waiting', 'a researcher not yet nudged keeps waiting past the deadline');
    assert.equal(state.rounds[0].entries.B.state, 'waiting');
    assert.equal((await clusterMailbox.drain(p.a, { operatorTurn: true })).length, 1);
    for (let i = 0; i < 50 && (await loadResearch(p.clusterId))!.rounds[0].entries.A.heldMsgId; i++) await new Promise((r) => setTimeout(r, 10));
    state = (await loadResearch(p.clusterId))!;
    assert.equal(state.rounds[0].entries.A.heldMsgId, undefined);
    assert.equal(Date.parse(state.rounds[0].deadline), now + RESEARCH_ROUND_TIMEOUT_DEFAULT_MINUTES * 60_000, 'the full limit counts from the read');
    now += (RESEARCH_ROUND_TIMEOUT_DEFAULT_MINUTES + 1) * 60_000;
    await timeoutRound(p.clusterId, 1);
    state = (await loadResearch(p.clusterId))!;
    assert.equal(state.rounds[0].entries.A.state, 'timed_out');
    assert.equal(state.rounds[0].entries.B.state, 'waiting', 'the researcher still waiting for its NUDGE is not timed out');
  } finally {
    clusterMailbox.setDeliveryListener(null);
    configureResearch(null);
    await clusterStore.deleteCluster(p.clusterId).catch(() => undefined);
    await fs.rm(p.root, { recursive: true, force: true });
  }
});

test('rounds and catch-ups use the research time limit setting, kept within 30 to 240 minutes', async () => {
  const p = await project();
  const now = Date.parse('2026-11-23T00:00:00Z');
  let setting: number | undefined = 45;
  try {
    configureResearch({
      enqueue: (to, msg, opts) => clusterMailbox.enqueue(to, msg, opts),
      mintMsgId: () => clusterMailbox.mintMsgId(),
      wake: () => undefined,
      isBusy: () => false,
      timeLimitMinutes: async () => setting!,
      pendingMail: (wfid) => clusterMailbox.depthFor(wfid),
      clusterIdFor: (wfid) => clusterStore.getClusterIdForWorkflow(wfid),
      notify: () => undefined,
      now: () => now,
    });
    const round = await startRound(p.clusterId, p.director, 'Compare two heat pumps.');
    assert.equal(round.ok && Date.parse(round.deadline), now + 45 * 60_000);
    setting = 500;
    const c = randomUUID();
    await clusterStore.addResearchMember(p.clusterId, c, p.membersCwd, true);
    await addResearcher(p.clusterId, { workflowId: c, provider: 'ollama', model: 'qwen3:32b' }, true);
    const catchUp = (await loadResearch(p.clusterId))!.catchUps![0];
    assert.equal(Date.parse(catchUp.deadline), now + 240 * 60_000);
  } finally {
    configureResearch(null);
    await clusterStore.deleteCluster(p.clusterId).catch(() => undefined);
    await fs.rm(p.root, { recursive: true, force: true });
  }
});

test('+15 MIN keeps a waiting researcher open past the old deadline, tells the Director once, and stops at the maximum', async () => {
  const p = await project();
  let now = Date.parse('2026-11-23T00:00:00Z');
  try {
    configureResearch({
      enqueue: (to, msg, opts) => clusterMailbox.enqueue(to, msg, opts),
      mintMsgId: () => clusterMailbox.mintMsgId(),
      wake: () => undefined,
      isBusy: () => false,
      timeLimitMinutes: async () => 200,
      pendingMail: (wfid) => clusterMailbox.depthFor(wfid),
      clusterIdFor: (wfid) => clusterStore.getClusterIdForWorkflow(wfid),
      notify: () => undefined,
      now: () => now,
    });
    assert.equal((await startRound(p.clusterId, p.director, 'Compare two heat pumps.')).ok, true);
    now += 197 * 60_000;
    const extended = await extendRound(p.clusterId, 1);
    assert.deepEqual(extended, { ok: true, deadline: new Date(Date.parse('2026-11-23T00:00:00Z') + 215 * 60_000).toISOString() });
    now += 5 * 60_000;
    await timeoutRoundIfDue(p.clusterId, 1);
    let state = (await loadResearch(p.clusterId))!;
    assert.equal(state.rounds[0].entries.A.state, 'waiting', 'the old deadline has passed but the researcher still waits');
    const lines = (await clusterMailbox.drain(p.director)).filter((m) => m.fromDisplayName === 'Arco research');
    assert.deepEqual(lines.map((m) => m.content), [`Round 1 extended to ${state.rounds[0].deadline} by the operator.`]);
    assert.equal((await extendRound(p.clusterId, 1)).ok, true, '230 minutes in total is within the maximum');
    assert.deepEqual(await extendRound(p.clusterId, 1), { ok: false, code: 'not_extendable' }, `245 minutes would pass the ${RESEARCH_ROUND_TIMEOUT_MAX_MINUTES}-minute maximum`);
    state = (await loadResearch(p.clusterId))!;
    assert.equal(Date.parse(state.rounds[0].deadline), Date.parse(state.rounds[0].startedAt) + 230 * 60_000);
  } finally {
    configureResearch(null);
    await clusterStore.deleteCluster(p.clusterId).catch(() => undefined);
    await fs.rm(p.root, { recursive: true, force: true });
  }
});

test('RETRY after release sends the work so far and files the late report in the released round', async () => {
  const p = await project();
  const now = Date.parse('2026-11-23T00:00:00Z');
  try {
    configureResearch({
      enqueue: (to, msg, opts) => clusterMailbox.enqueue(to, msg, opts),
      mintMsgId: () => clusterMailbox.mintMsgId(),
      wake: (wfid, prompt) => { p.woken.push(wfid); p.prompts.push(prompt); },
      isBusy: () => false,
      pendingMail: (wfid) => clusterMailbox.depthFor(wfid),
      clusterIdFor: (wfid) => clusterStore.getClusterIdForWorkflow(wfid),
      notify: () => undefined,
      now: () => now,
    });
    assert.equal((await startRound(p.clusterId, p.director, 'Compare two heat pumps.')).ok, true);
    const log = join(p.membersCwd, '.arco', 'workflows', p.b);
    await fs.mkdir(log, { recursive: true });
    await fs.writeFile(join(log, 'events.jsonl'), [
      { seq: 1, ts: now + 1000, type: 'primary_thinking', text: 'Search the efficiency ratings first.' },
      { seq: 2, ts: now + 2000, type: 'primary_tool_use', tool: 'web_search', input: '{"query":"heat pump SCOP ratings"}', status: 'started', itemId: 't1' },
      { seq: 3, ts: now + 3000, type: 'primary_tool_use', tool: 'web_search', input: '{"query":"heat pump SCOP ratings"}', status: 'completed', itemId: 't1', output: 'Rating table' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    assert.notEqual(await holdResearcherReply(p.clusterId, p.a, 'Report A', undefined), undefined);
    await onMemberSettled(p.b, 'failed');
    let state = (await loadResearch(p.clusterId))!;
    assert.ok(state.rounds[0].releasedAt, 'the round is released without B');
    await clusterMailbox.drain(p.director);
    const retry = await retryResearcher(p.clusterId, 1, 'B');
    assert.deepEqual(retry, { ok: true, late: true, file: 'work-so-far-round-1.md' });
    assert.equal(researchSummary((await loadResearch(p.clusterId))!).rounds[0].entries.B.retrying, true);
    const mail = (await clusterMailbox.drain(p.b)).at(-1)!;
    assert.match(mail.content, /Read that file first/);
    const file = Buffer.from(mail.artifacts![0].contentBase64, 'base64').toString('utf8');
    for (const part of ['Compare two heat pumps.', 'Search the efficiency ratings first.', 'heat pump SCOP ratings', 'Rating table', 'The turn failed.']) assert.ok(file.includes(part), part);
    assert.equal((await retryResearcher(p.clusterId, 1, 'B')).ok, false, 'one retry at a time');
    assert.notEqual(await holdResearcherReply(p.clusterId, p.b, 'Late report B', undefined), undefined);
    state = (await loadResearch(p.clusterId))!;
    assert.equal(state.rounds[0].entries.B.state, 'replied');
    assert.ok(state.rounds[0].entries.B.late);
    assert.match(await fs.readFile(join(p.folder, 'rounds', 'round-1', 'report-b.md'), 'utf8'), /Late report[\s\S]*Late report B/);
    const notes = (await clusterMailbox.drain(p.director)).map((m) => m.content);
    assert.ok(notes.some((c) => c.startsWith('Late report from Researcher B for round 1') && c.includes('Add it to synthesis.md')));
  } finally {
    configureResearch(null);
    await clusterStore.deleteCluster(p.clusterId).catch(() => undefined);
    await fs.rm(p.root, { recursive: true, force: true });
  }
});

test('research creation rejects a CLI-only setting on a different provider', async () => {
  const result = await prepareResearchCreate({ type: 'cluster_create_from_scratch', cwd: '', research: { name: 'Fixture', brief: 'Compare.' }, members: [
    { provider: 'claude', model: 'sonnet' },
    { provider: 'ollama', model: 'fixture', researchClaudeTransport: 'cli' },
  ] });
  assert.deepEqual(result, { refusal: 'member[1] invalid_research_transport' });
});

test('research creation explains an unsupported Codex version', { skip: process.platform === 'win32' }, async () => {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'arco-codex-version-'));
  const previousPath = process.env.PATH;
  try {
    const executable = join(root, 'codex');
    await fs.writeFile(executable, '#!/bin/sh\nprintf "codex-cli 0.172.0\\n"\n', { mode: 0o755 });
    process.env.PATH = root;
    const result = await prepareResearchCreate({ type: 'cluster_create_from_scratch', cwd: '', research: { name: 'Fixture', brief: 'Compare.' }, members: [
      { provider: 'claude', model: 'sonnet' }, { provider: 'codex', model: 'fixture' },
    ] });
    assert.deepEqual(result, { refusal: 'Codex researchers need Codex 0.171.0; 0.172.0 is installed.' });
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a foreign synthetic marker in split researcher output marks the round contaminated', async () => {
  const p = await project();
  try {
    await updateResearch(p.clusterId, state => { state.researchers[0].claudeTransport = 'cli'; });
    assert.equal((await startRound(p.clusterId, p.director, 'Compare the fixtures.')).ok, true);
    const state = (await loadResearch(p.clusterId))!;
    const own = state.isolationCanaries![p.a];
    const foreign = state.isolationCanaries![p.b];
    assert.equal(await fs.readFile(join(clusterStore.isolatedWorkspaceFor(p.clusterId, p.a), RESEARCH_CANARY_FILE), 'utf8'), own.workspace);
    assert.equal(await fs.readFile(join(clusterStore.clusterDir(p.clusterId), 'isolates', p.a, 'cli-home', RESEARCH_CANARY_FILE), 'utf8'), own.home);
    assert.notEqual(own.workspace, foreign.workspace);
    assert.notEqual(own.home, foreign.home);
    assert.equal(observeResearchText(p.clusterId, p.a, own.workspace), false);
    assert.equal(observeResearchText(p.clusterId, p.a, foreign.workspace.slice(0, 30), true), false);
    assert.equal(observeResearchText(p.clusterId, p.a, foreign.workspace.slice(30), true), true);
    assert.equal(researchToolBoundaryWarning('Bash', JSON.stringify({ command: 'cat /work/notes.txt' })), false);
    assert.equal(researchToolBoundaryWarning('Bash', JSON.stringify({ command: 'curl https://example.org/page' })), false);
    assert.equal(researchToolBoundaryWarning('Write', JSON.stringify({ file_path: '/work/notes', content: 'localhost /root/canary' })), false);
    assert.equal(observeResearchTool(p.clusterId, p.a, 'Bash', JSON.stringify({ command: 'cat /root/canary' })), true);
    assert.equal(researchToolBoundaryWarning('Bash', JSON.stringify({ command: `curl http://${[127, 0, 0, 1].join('.')}:3001/` })), true);
    await holdResearcherReply(p.clusterId, p.a, 'First report.', undefined);
    await holdResearcherReply(p.clusterId, p.b, 'Second report.', undefined);
    const result = (await loadResearch(p.clusterId))!;
    assert.equal(result.rounds[0].contaminated, true);
    assert.equal(result.rounds[0].boundaryWarning, true);
    assert.equal(researchSummary(result).rounds[0].contaminated, true);
    assert.equal(JSON.stringify(researchSummary(result)).includes(foreign.workspace), false);
    assert.deepEqual(await unsentFiles(result), [], 'internal markers are not offered as researcher files');
  } finally {
    configureResearch(null);
    await clusterStore.deleteCluster(p.clusterId).catch(() => undefined);
    await fs.rm(p.root, { recursive: true, force: true });
  }
});

test('a researcher waiting for sign-in is not timed out and gets its remaining time after sign-in', async () => {
  const p = await project();
  try {
    assert.equal((await startRound(p.clusterId, p.director, 'Compare the fixtures.')).ok, true);
    await setResearcherSignInWaiting(p.clusterId, p.a, true);
    await timeoutRound(p.clusterId, 1);
    let state = (await loadResearch(p.clusterId))!;
    assert.equal(state.rounds[0].entries.A.state, 'waiting');
    assert.equal(state.rounds[0].entries.B.state, 'timed_out');
    assert.equal(researchSummary(state).researchers[0].signInNeeded, 'claude');
    await setResearcherSignInWaiting(p.clusterId, p.a, false);
    state = (await loadResearch(p.clusterId))!;
    assert.equal(state.researchers[0].signInNeeded, undefined);
    assert.ok(Date.parse(state.rounds[0].deadline) > Date.now());
    await holdResearcherReply(p.clusterId, p.a, 'Finished after sign-in.', undefined);
    assert.equal((await loadResearch(p.clusterId))!.rounds[0].entries.A.state, 'replied');
  } finally {
    configureResearch(null);
    await clusterStore.deleteCluster(p.clusterId).catch(() => undefined);
    await fs.rm(p.root, { recursive: true, force: true });
  }
});

test('researcher attachments cannot escape their workspace through a symlink', { skip: process.platform === 'win32' }, async () => {
  const p = await project();
  try {
    await startRound(p.clusterId, p.director, 'Compare the fixtures.');
    const workspace = clusterStore.isolatedWorkspaceFor(p.clusterId, p.a);
    const outside = join(p.root, 'outside.txt');
    await fs.writeFile(outside, 'private fixture');
    await fs.symlink(outside, join(workspace, 'escape.txt'));
    const denied = await clusterPeerOps.peerSend(p.ctx(p.a), { to: p.director, content: 'Attempt', artifactPaths: ['escape.txt'] });
    assert.equal(denied.ok, false);
    assert.equal((await loadResearch(p.clusterId))!.rounds[0].entries.A.state, 'waiting');
    await fs.symlink(p.root, join(workspace, 'escape-dir'), 'dir');
    const deniedDirectory = await clusterPeerOps.peerSend(p.ctx(p.a), { to: p.director, content: 'Another attempt', artifactPaths: ['escape-dir/outside.txt'] });
    assert.equal(deniedDirectory.ok, false);
    await fs.writeFile(join(workspace, 'inside.txt'), 'public fixture');
    const accepted = await clusterPeerOps.peerSend(p.ctx(p.a), { to: p.director, content: 'Report', artifactPaths: ['inside.txt'] });
    assert.equal(accepted.ok, true);
  } finally {
    configureResearch(null);
    await clusterStore.deleteCluster(p.clusterId).catch(() => undefined);
    await fs.rm(p.root, { recursive: true, force: true });
  }
});

test('an independence breach before the first round carries into the round', async () => {
  const p = await project();
  try {
    await updateResearch(p.clusterId, state => { state.researchers[0].claudeTransport = 'cli'; });
    await ensureResearchTripwires(p.clusterId);
    const state = (await loadResearch(p.clusterId))!;
    assert.equal(observeResearchText(p.clusterId, p.a, state.isolationCanaries![p.b].home), true);
    assert.equal((await startRound(p.clusterId, p.director, 'Compare the fixtures.')).ok, true);
    assert.equal((await loadResearch(p.clusterId))!.rounds[0].contaminated, true);
  } finally {
    configureResearch(null);
    await clusterStore.deleteCluster(p.clusterId).catch(() => undefined);
    await fs.rm(p.root, { recursive: true, force: true });
  }
});

test('settling a researcher reads a final reply still queued in the workflow buffer', async () => {
  const { initWorkflowStore, persistAndStampSeq, hasPendingWorkflowWrites, flushWorkflowBuffer, forgetWorkflowBuffer } = await import('../workflowStore.js');
  const p = await project();
  try {
    await startRound(p.clusterId, p.director, 'Compare the fixtures.');
    await clusterMailbox.drain(p.a);
    await initWorkflowStore(p.membersCwd, p.a);
    persistAndStampSeq(p.membersCwd, p.a, { type: 'primary_turn_started', workflowId: p.a } as never);
    persistAndStampSeq(p.membersCwd, p.a, { type: 'primary_text', workflowId: p.a, phase: 'passthrough', text: 'A complete report.' } as never);
    assert.equal(hasPendingWorkflowWrites(p.membersCwd, p.a), true);
    await onMemberSettled(p.a, 'finished');
    const entry = (await loadResearch(p.clusterId))!.rounds[0].entries.A;
    assert.equal(entry.state, 'replied');
    assert.equal(entry.report, 'A complete report.');
  } finally { await flushWorkflowBuffer(p.membersCwd, p.a); forgetWorkflowBuffer(p.membersCwd, p.a); configureResearch(null); await clusterStore.deleteCluster(p.clusterId); await fs.rm(p.root, { recursive: true, force: true }); }
});

test('a provider refusal becomes a failed round reason even after partial output', async () => {
  const p = await project();
  try {
    await startRound(p.clusterId, p.director, 'Compare the fixtures.');
    await clusterMailbox.drain(p.a);
    const logDir = join(p.membersCwd, '.arco', 'workflows', p.a);
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(join(logDir, 'events.jsonl'), [{ type: 'primary_turn_started' }, { type: 'primary_text', text: 'Partial answer' }, { type: 'primary_refusal', category: 'cyber' }].map(e => JSON.stringify(e)).join('\n') + '\n');
    await onMemberSettled(p.a, 'finished');
    const entry = (await loadResearch(p.clusterId))!.rounds[0].entries.A;
    assert.equal(entry.state, 'failed');
    assert.equal(entry.reason, 'The provider declined the request (category: cyber); rephrase the brief for this researcher.');
  } finally { configureResearch(null); await clusterStore.deleteCluster(p.clusterId); await fs.rm(p.root, { recursive: true, force: true }); }
});

test('a Gemini network notice becomes a one-line failed round reason', async () => {
  const p = await project();
  try {
    await updateResearch(p.clusterId, state => { state.researchers[1].provider = 'antigravity-cli'; });
    await startRound(p.clusterId, p.director, 'Compare the fixtures.');
    await clusterMailbox.drain(p.b);
    const logDir = join(p.membersCwd, '.arco', 'workflows', p.b);
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(join(logDir, 'events.jsonl'), [{ type: 'primary_turn_started' }, { type: 'primary_text', text: '⚠ There was a network issue connecting to the server,\n please try again.' }].map(e => JSON.stringify(e)).join('\n') + '\n');
    await onMemberSettled(p.b, 'finished');
    const entry = (await loadResearch(p.clusterId))!.rounds[0].entries.B;
    assert.equal(entry.state, 'failed');
    assert.equal(entry.reason, 'The turn ended without a report. Last message: There was a network issue connecting to the server, please try again.');
  } finally { configureResearch(null); await clusterStore.deleteCluster(p.clusterId); await fs.rm(p.root, { recursive: true, force: true }); }
});

test('a round holds every reply until all researchers are done, then releases them blind together', async () => {
  const p = await project();
  try {
    const started = await startRound(p.clusterId, p.director, 'Compare running costs. Cite sources.');
    assert.equal(started.ok, true);
    const mailA = await clusterMailbox.drain(p.a);
    const mailB = await clusterMailbox.drain(p.b);
    assert.equal(mailA.length, 1);
    assert.equal(mailA[0].content, mailB[0].content);
    assert.deepEqual(p.woken.sort(), [p.a, p.b].sort());
    // The turn that starts a round quotes the brief, so a compaction that
    // drops the peer_read result cannot leave the researcher without it.
    assert.equal(p.prompts.filter((t) => t.includes('Compare running costs. Cite sources.')).length, 2);
    assert.equal((await startRound(p.clusterId, p.director, 'again')).ok, false);
    assert.equal((await startRound(p.clusterId, p.a, 'again')).ok, false);

    // A researcher's report is held: nothing reaches the Director or the folder.
    const sent = await clusterPeerOps.peerSend(p.ctx(p.a), { to: 'anyone', content: 'Report A: model X costs least.' });
    assert.equal(sent.ok && sent.heldForRound, 1);
    assert.deepEqual(await clusterMailbox.peek(p.director), []);
    await assert.rejects(fs.access(join(p.folder, 'rounds', 'round-1', 'report-a.md')));

    // B ends its turn without sending: its final reply becomes the report.
    const logDir = join(p.membersCwd, '.arco', 'workflows', p.b);
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(join(logDir, 'events.jsonl'), [{ type: 'primary_turn_started' }, { type: 'primary_text', text: 'Report B: ' }, { type: 'primary_text', text: 'model Y.' }].map((e) => JSON.stringify(e)).join('\n') + '\n');
    await onMemberSettled(p.b, 'finished');

    const released = await clusterMailbox.peek(p.director);
    assert.equal(released.length, 1);
    assert.match(released[0].content, /Researcher A[\s\S]*model X costs least/);
    assert.match(released[0].content, /Researcher B[\s\S]*taken from final reply[\s\S]*model Y/);
    assert.doesNotMatch(released[0].content, /claude-sonnet|qwen3|ollama/);
    assert.match(await fs.readFile(join(p.folder, 'rounds', 'round-1', 'report-b.md'), 'utf8'), /model Y/);
    assert.doesNotMatch(await fs.readFile(join(p.folder, 'research.json'), 'utf8'), /claude-sonnet|qwen3|provider/);
    assert.ok(p.woken.includes(p.director));
    assert.ok(p.prompts.some(prompt => prompt.startsWith('(research) Round 1 released;')));

    // The Director sees researchers by letter only, and can address one by letter.
    const peers = await clusterPeerOps.peerList(p.ctx(p.director));
    assert.deepEqual(peers.map((r) => r.displayName).sort(), ['Researcher A', 'Researcher B']);
    const targeted = await clusterPeerOps.peerSend(p.ctx(p.director), { to: 'B', content: 'Verify your second source.' });
    assert.equal(targeted.ok && targeted.to, p.b);
    assert.match(await fs.readFile(join(p.folder, 'rounds', 'round-1', 'round.md'), 'utf8'), /Research Director to Researcher B[\s\S]*Verify your second source/);

    // A round nobody answers is released as timed out at its deadline.
    await clusterMailbox.drain(p.director);
    assert.equal((await startRound(p.clusterId, p.director, 'Round two.')).ok, true);
    await timeoutRound(p.clusterId, 2);
    const second = await clusterMailbox.peek(p.director);
    assert.match(second[0].content, /Round 2[\s\S]*Researcher A: timed out[\s\S]*Researcher B: timed out/);
  } finally {
    configureResearch(null);
    await clusterStore.deleteCluster(p.clusterId).catch(() => undefined);
    await fs.rm(p.root, { recursive: true, force: true });
  }
});

test('a Cursor researcher is shown as sandboxed, not tool-fenced', async () => {
  const p = await project();
  try {
    await updateResearch(p.clusterId, (state) => { state.researchers[1].provider = 'cursor'; });
    assert.equal(researchSummary((await loadResearch(p.clusterId))!).researchers[1].isolation, 'checking');
    await updateResearch(p.clusterId, (state) => { state.researchers[1].isolation = 'sandboxed'; });
    assert.equal(researchSummary((await loadResearch(p.clusterId))!).researchers[1].isolation, 'sandboxed');
  } finally {
    configureResearch(null);
    await clusterStore.deleteCluster(p.clusterId).catch(() => undefined);
    await fs.rm(p.root, { recursive: true, force: true });
  }
});

test('a late researcher answers the round 1 text alone, then gets the round that waited for it; a removed one is left out', async () => {
  const p = await project();
  try {
    assert.equal((await startRound(p.clusterId, p.director, 'Round one text.')).ok, true);
    await clusterPeerOps.peerSend(p.ctx(p.a), { to: 'x', content: 'Report A1.' });
    await clusterPeerOps.peerSend(p.ctx(p.b), { to: 'x', content: 'Report B1.' });
    await Promise.all([p.a, p.b, p.director].map((id) => clusterMailbox.drain(id)));

    // C joins with a catch-up: the round 1 text and nothing else.
    const c = randomUUID();
    await clusterStore.addResearchMember(p.clusterId, c, p.membersCwd, true);
    assert.deepEqual(await addResearcher(p.clusterId, { workflowId: c, provider: 'ollama', model: 'fixture' }, true), { letter: 'C', fromRound: 2, catchUp: true });
    const catchUpMail = await clusterMailbox.drain(c);
    assert.equal(catchUpMail.length, 1);
    assert.match(catchUpMail[0].content, /catch-up on round 1[\s\S]*Round one text\./);
    assert.doesNotMatch(catchUpMail[0].content, /Report A1|Report B1/);
    assert.match((await clusterMailbox.drain(p.director))[0].content, /Researcher C joined\. It is included from round 2\. A catch-up/);

    // Round 2 starts during the catch-up: C's entry waits for its catch-up.
    assert.equal((await startRound(p.clusterId, p.director, 'Round two text.')).ok, true);
    assert.deepEqual(await clusterMailbox.drain(c), []);
    await clusterPeerOps.peerSend(p.ctx(p.a), { to: 'x', content: 'Report A2.' });
    const held = await clusterPeerOps.peerSend(p.ctx(c), { to: 'x', content: 'Report C on round one.' });
    assert.equal(held.ok && held.heldForRound, catchUpKey('C'));
    const catchUpRelease = await clusterMailbox.drain(p.director);
    assert.equal(catchUpRelease.length, 1);
    assert.match(catchUpRelease[0].content, /Catch-up report from Researcher C[\s\S]*after round 1[\s\S]*Report C on round one/);
    assert.doesNotMatch(catchUpRelease[0].content, /Report A2/);
    assert.match(await fs.readFile(join(p.folder, 'rounds', 'catch-up-c', 'report-c.md'), 'utf8'), /Report C on round one/);
    assert.match((await clusterMailbox.drain(c))[0].content, /round 2[\s\S]*Round two text\./);

    // B is removed while round 2 waits for it; letters are never reused.
    assert.deepEqual(await removeResearcher(p.clusterId, 'B'), { ok: true, workflowId: p.b, releasedRound: 2 });
    assert.match((await clusterMailbox.drain(p.director))[0].content, /Researcher B was removed\. Its earlier reports stay\. Round 2 is released without it\. Later rounds go to A, C\./);
    await clusterPeerOps.peerSend(p.ctx(c), { to: 'x', content: 'Report C2.' });
    const second = await clusterMailbox.drain(p.director);
    assert.match(second[0].content, /Round 2 replies[\s\S]*Researcher B: removed \(Removed by the operator\.\)[\s\S]*Report C2/);
    assert.ok((await startRound(p.clusterId, p.director, 'Round three.')).ok);
    assert.deepEqual(Object.keys((await loadResearch(p.clusterId))!.rounds[2].entries), ['A', 'C']);
    const d = randomUUID();
    await clusterStore.addResearchMember(p.clusterId, d, p.membersCwd, true);
    assert.equal((await addResearcher(p.clusterId, { workflowId: d, provider: 'ollama', model: 'fixture' }, false))?.letter, 'D');
    assert.equal((await removeResearcher(p.clusterId, 'A')).ok, true);
    assert.equal((await removeResearcher(p.clusterId, 'C')).ok, true);
    assert.deepEqual(await removeResearcher(p.clusterId, 'D'), { ok: false, code: 'last_researcher' });
  } finally {
    configureResearch(null);
    await clusterStore.deleteCluster(p.clusterId).catch(() => undefined);
    await fs.rm(p.root, { recursive: true, force: true });
  }
});

test('Reveal writes providers into the folder and shows them to the Director only after the operator asks', async () => {
  const p = await project();
  try {
    assert.equal((await startRound(p.clusterId, p.director, 'Brief.')).ok, true);
    await timeoutRound(p.clusterId, 1);
    assert.equal((await clusterPeerOps.peerList(p.ctx(p.director))).some((r) => r.focus), false);
    assert.equal(await revealResearch(p.clusterId), true);
    assert.match(await fs.readFile(join(p.folder, 'research.json'), 'utf8'), /claude-sonnet-4-6[\s\S]*qwen3:32b/);
    assert.match(await fs.readFile(join(p.folder, 'rounds', 'round-1', 'round.md'), 'utf8'), /qwen3:32b/);
    const peers = await clusterPeerOps.peerList(p.ctx(p.director));
    assert.equal(peers.find((r) => r.displayName === 'Researcher B')?.focus, 'ollama, qwen3:32b');
  } finally {
    configureResearch(null);
    await clusterStore.deleteCluster(p.clusterId).catch(() => undefined);
    await fs.rm(p.root, { recursive: true, force: true });
  }
});

test('closing a research tab logs each researcher, keeps unsent files on request and removes researcher folders', async () => {
  const p = await project();
  try {
    assert.equal((await startRound(p.clusterId, p.director, 'Brief.')).ok, true);
    await timeoutRound(p.clusterId, 1);
    const logDir = join(p.membersCwd, '.arco', 'workflows', p.a);
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(join(logDir, 'events.jsonl'), [
      { type: 'primary_turn_started' },
      { type: 'primary_tool_use', tool: 'web_search', input: JSON.stringify({ query: 'heat pump running cost' }), toolUseId: 't1' },
      { type: 'primary_tool_use', tool: 'web_fetch', input: JSON.stringify({ url: 'https://example.org/costs' }), toolUseId: 't2', status: 'failed', output: 'HTTP 403' },
    ].map((e) => JSON.stringify(e)).join('\n') + '\n');
    const workspace = clusterStore.isolatedWorkspaceFor(p.clusterId, p.a);
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(join(workspace, 'notes.md'), 'never sent');

    const state = (await loadResearch(p.clusterId))!;
    assert.deepEqual((await unsentFiles(state)).map((f) => [f.letter, f.path]), [['A', 'notes.md']]);
    const closed = await closeResearch(p.clusterId, { moveUnsent: true, isBusy: () => false });
    assert.equal(closed.ok, true);
    const roundMd = await fs.readFile(join(p.folder, 'rounds', 'round-1', 'round.md'), 'utf8');
    assert.match(roundMd, /### Researcher A[\s\S]*Web searches: 1[\s\S]*heat pump running cost[\s\S]*Sources opened: 1[\s\S]*Failed tool calls Arco recorded: 1[\s\S]*HTTP 403/);
    const sources = await fs.readdir(join(p.folder, 'sources'));
    assert.equal(sources.filter((n) => n.endsWith('-notes.md')).length, 1);
    await assert.rejects(fs.access(workspace));
    await assert.rejects(fs.access(p.membersCwd));
    assert.match(await fs.readFile(join(p.folder, 'research.json'), 'utf8'), /"status": "closed"/);

    // Startup sweep: only researcher folders of projects with no cluster, never recent ones.
    const live = randomUUID(), orphan = randomUUID(), fresh = randomUUID();
    for (const id of [live, orphan, fresh]) await fs.mkdir(join(researchMembersRoot(), id), { recursive: true });
    const old = new Date(Date.now() - 60 * 60_000);
    await fs.utimes(join(researchMembersRoot(), orphan), old, old);
    await fs.utimes(join(researchMembersRoot(), live), old, old);
    assert.deepEqual(await sweepClosedResearch(new Set([live])), [orphan]);
    await fs.access(join(researchMembersRoot(), live));
    await fs.access(join(researchMembersRoot(), fresh));
  } finally {
    configureResearch(null);
    await clusterStore.deleteCluster(p.clusterId).catch(() => undefined);
    await fs.rm(p.root, { recursive: true, force: true });
  }
});

test('deleting a research cluster by any path closes it first and keeps the author record', async () => {
  const p = await project();
  installResearchCloseOnDelete(() => false);
  try {
    assert.equal((await startRound(p.clusterId, p.director, 'Brief.')).ok, true);
    await timeoutRound(p.clusterId, 1);
    const workspace = clusterStore.isolatedWorkspaceFor(p.clusterId, p.b);
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(join(workspace, 'table.csv'), 'a,b\n');

    await clusterStore.deleteCluster(p.clusterId);

    const record = JSON.parse(await fs.readFile(closedResearchRecordPath('p1'), 'utf8'));
    assert.equal(record.researchers.find((r: { letter: string }) => r.letter === 'B').model, 'qwen3:32b');
    assert.ok(record.closedAt);
    assert.match(await fs.readFile(join(p.folder, 'rounds', 'round-1', 'round.md'), 'utf8'), /## Researcher logs/);
    assert.equal((await fs.readdir(join(p.folder, 'sources'))).filter((n) => n.endsWith('-table.csv')).length, 1);
    assert.doesNotMatch(await fs.readFile(join(p.folder, 'research.json'), 'utf8'), /qwen3/);
    assert.equal((await sweepClosedResearch(new Set(), Date.now() + 24 * 60 * 60_000)).includes('closed'), false);
    await fs.access(closedResearchRecordPath('p1'));
  } finally {
    setBeforeClusterDelete(null);
    configureResearch(null);
    await fs.rm(p.root, { recursive: true, force: true });
  }
});

test('creating a research project starts the Director on the operator brief', async () => {
  const p = await project();
  try {
    const state = (await loadResearch(p.clusterId))!;
    assert.equal(startResearchDirector(state), true);
    assert.deepEqual(p.woken, [p.director]);
    assert.match(p.prompts[0], /^\(research\) Brief for Heat pump\n[\s\S]*research_round[\s\S]*one question[\s\S]*Which heat pump\?/);
  } finally {
    configureResearch(null);
    await clusterStore.deleteCluster(p.clusterId).catch(() => undefined);
    await fs.rm(p.root, { recursive: true, force: true });
  }
});


test('research plans are available to the Director and never readable by researchers', async () => {
  const p = await project();
  try {
    const bridge = await import('../clusterPlanBridge.js');
    await assert.rejects(clusterStore.addMember(p.clusterId, randomUUID()), /research project controls/);
    assert.equal(await clusterStore.setMemberAccessMode(p.clusterId, p.a, 'standard'), null);
    assert.equal(await clusterStore.setTaskBoardMode(p.clusterId, 'project'), null);
    const plan = await bridge.setClusterPlanBody(p.clusterId, '# Director plan\n- [ ] Private task');
    assert.ok(plan);
    const director = await clusterPeerOps.peerPlanRead(p.ctx(p.director));
    assert.equal(director.ok, true);
    const researcher = await clusterPeerOps.peerPlanRead(p.ctx(p.a));
    assert.equal(researcher.ok, false); if (!researcher.ok) assert.equal(researcher.code, 'access_denied');
    const deniedWrite = await clusterPeerOps.peerPlanWrite(p.ctx(p.a), '# Changed', () => {});
    assert.equal(deniedWrite.ok, false); if (!deniedWrite.ok) assert.equal(deniedWrite.code, 'access_denied');
    assert.match((await bridge.readClusterPlan(p.clusterId))!.body, /Private task/);
    const { workflows, workflowCwds } = await import('../server/state.js');
    const { initWorkflowStore, flushWorkflowBuffer, replayEvents } = await import('../workflowStore.js');
    const { broadcastCluster } = await import('../server/broadcast.js');
    for (const [id, cwd] of [[p.director, p.folder], [p.a, p.membersCwd]] as const) {
      workflows.set(id, { config: { workingDirectory: cwd }, observers: new Set() } as any);
      workflowCwds.set(id, cwd); await initWorkflowStore(cwd, id);
    }
    try {
      broadcastCluster(p.clusterId, { type: 'cluster_plan_changed', clusterId: p.clusterId, body: plan!.body, bodyLength: plan!.body.length, updatedAt: Date.now() });
      await flushWorkflowBuffer(p.folder, p.director); await flushWorkflowBuffer(p.membersCwd, p.a);
      assert.ok((await replayEvents(p.folder, p.director, 0)).some(event => event.type === 'cluster_plan_changed'));
      assert.ok(!(await replayEvents(p.membersCwd, p.a, 0)).some(event => event.type === 'cluster_plan_changed'));
    } finally { for (const id of [p.director, p.a]) { workflows.delete(id); workflowCwds.delete(id); } }
    const snapshots = await import('../clusterSnapshots.js');
    await assert.rejects(snapshots.saveSnapshot({ clusterId: p.clusterId, name: 'Fixture' }), /Research projects cannot be saved/);
  } finally { await clusterStore.deleteCluster(p.clusterId); await fs.rm(p.root, { recursive: true, force: true }); }
});

test('result selection excludes unreleased reports and preserves only released source files', async () => {
  const { selectResearchFiles } = await import('./resultSelection.js');
  const { sourceFileName } = await import('./researchFolder.js');
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'arco-research-selection-'));
  try {
    const artifact = { name: 'source.txt', contentBase64: Buffer.from('source').toString('base64'), byteLength: 6 };
    await fs.mkdir(join(root, 'rounds', 'round-1'), { recursive: true });
    await fs.mkdir(join(root, 'sources')); await fs.mkdir(join(root, 'syntheses'));
    await fs.writeFile(join(root, 'rounds', 'round-1', 'report-a.md'), '# Released\n');
    await fs.writeFile(join(root, 'sources', sourceFileName(artifact)), 'source');
    const state = { folder: root, rounds: [
      { n: 1, releasedAt: '2026-01-01', entries: { A: { state: 'replied', artifacts: [artifact] } } },
      { n: 2, entries: { A: { state: 'replied', artifacts: [] } } },
    ] } as never;
    const files = await selectResearchFiles(state, { kind: 'report', round: 1, letter: 'A' });
    assert.deepEqual(files.map(f => f.relativePath).sort(), [`rounds/round-1/report-a.md`, `sources/${sourceFileName(artifact)}`].sort());
    await assert.rejects(selectResearchFiles(state, { kind: 'report', round: 2, letter: 'A' }), /not released/);
    await assert.rejects(selectResearchFiles(state, { kind: 'project' }), /released/);
    await fs.unlink(join(root, 'sources', sourceFileName(artifact)));
    await fs.symlink(join(root, 'rounds', 'round-1', 'report-a.md'), join(root, 'sources', sourceFileName(artifact)));
    await assert.rejects(selectResearchFiles(state, { kind: 'report', round: 1, letter: 'A' }), /unsafe/);
    await fs.unlink(join(root, 'sources', sourceFileName(artifact)));
    await fs.link(join(root, 'rounds', 'round-1', 'report-a.md'), join(root, 'sources', sourceFileName(artifact)));
    await assert.rejects(selectResearchFiles(state, { kind: 'report', round: 1, letter: 'A' }), /unsafe/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('send selections include released catch-ups and sources after a researcher is removed', async () => {
  const { selectResearchFiles } = await import('./resultSelection.js');
  const { sourceFileName } = await import('./researchFolder.js');
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'arco-catch-up-send-'));
  try {
    const artifact = { name: 'source.txt', contentBase64: Buffer.from('source').toString('base64'), byteLength: 6 };
    await fs.mkdir(join(root, 'rounds', 'catch-up-c'), { recursive: true });
    await fs.mkdir(join(root, 'sources'));
    for (const name of ['brief.md', 'research.json', 'director-log.md']) await fs.writeFile(join(root, name), 'fixture');
    await fs.writeFile(join(root, 'rounds', 'catch-up-c', 'round.md'), 'catch-up');
    await fs.writeFile(join(root, 'rounds', 'catch-up-c', 'report-c.md'), 'report');
    await fs.writeFile(join(root, 'sources', sourceFileName(artifact)), 'source');
    const state = { folder: root, researchers: [{ letter: 'C', removedAt: '2026-01-02' }], rounds: [], catchUps: [
      { catchUp: 'C', releasedAt: '2026-01-01', entries: { C: { state: 'replied', artifacts: [artifact] } } },
      { catchUp: 'D', entries: { D: { state: 'replied' } } },
    ] } as never;
    const expected = ['rounds/catch-up-c/report-c.md', `sources/${sourceFileName(artifact)}`].sort();
    assert.deepEqual((await selectResearchFiles(state, { kind: 'report', catchUp: 'C' })).map(f => f.relativePath).sort(), expected);
    await assert.rejects(selectResearchFiles(state, { kind: 'report', catchUp: 'D' }), /not released/);
    const project = (await selectResearchFiles(state, { kind: 'project' })).map(f => f.relativePath);
    for (const name of [...expected, 'rounds/catch-up-c/round.md']) assert.ok(project.includes(name), name);
    assert.ok(!project.some(name => name.includes('catch-up-d')));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('sending released research copies without overwrite and records successful destinations', async () => {
  const { sendResearchToFolder, sendResearchToPlan } = await import('./sendToProject.js');
  const { createPlan, readPlanRef, planRefsDir } = await import('../planStore.js');
  const { sourceFileName } = await import('./researchFolder.js');
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'arco-research-send-'));
  try {
    const source = join(root, 'source'), destination = join(root, 'project');
    await fs.mkdir(join(source, 'rounds', 'round-1'), { recursive: true });
    await fs.mkdir(destination); await fs.writeFile(join(source, 'exports.md'), '# Exports\n');
    await fs.writeFile(join(source, 'rounds', 'round-1', 'report-a.md'), '# Report\n');
    const state = { folder: source, name: 'Fixture', createdAt: '2026-01-01', rounds: [{ n: 1, releasedAt: '2026-01-01', entries: { A: { state: 'replied' } } }] } as never;
    const selection = { kind: 'report', round: 1, letter: 'A' } as const;
    const first = await sendResearchToFolder(state, selection, destination);
    assert.equal(first.error, undefined); assert.deepEqual(first.written, ['README.md', 'rounds/round-1/researcher-a.md']);
    const second = await sendResearchToFolder(state, selection, destination);
    assert.notEqual(first.target, second.target);
    assert.equal(await fs.readFile(join(first.target!, 'rounds', 'round-1', 'researcher-a.md'), 'utf8'), '# Report\n');
    const log = await fs.readFile(join(source, 'exports.md'), 'utf8');
    assert.ok(log.includes(first.target!)); assert.ok(log.includes(second.target!));
    const plan = await createPlan(destination, { title: 'Fixture', body: '' });
    const artifact = { name: 'source.txt', contentBase64: Buffer.from('source').toString('base64'), byteLength: 6 };
    await fs.mkdir(join(source, 'sources'));
    await fs.writeFile(join(source, 'sources', sourceFileName(artifact)), 'source');
    await fs.writeFile(join(source, 'rounds', 'round-1', 'report-a.md'), `# Report\n[source](../../sources/${sourceFileName(artifact)})\n`);
    (state as any).rounds[0].entries.A.artifacts = [artifact];
    const withSource = await sendResearchToFolder(state, selection, destination);
    assert.match(await fs.readFile(join(withSource.target!, 'rounds', 'round-1', 'researcher-a.md'), 'utf8'), /\]\(files\/researcher-a\/source\.txt\)/);
    const planSend = await sendResearchToPlan(state, selection, destination, plan.id);
    assert.equal(planSend.error, undefined);
    assert.match((await readPlanRef(destination, plan.id, 'research-fixture'))!.body, /\]\(research-fixture\.files\//);
    assert.equal(await fs.readFile(join(planRefsDir(destination, plan.id), 'research-fixture.files', sourceFileName(artifact)), 'utf8'), 'source');
    await fs.mkdir(join(planRefsDir(destination, plan.id), 'research-fixture-2.files'));
    const nextPlanSend = await sendResearchToPlan(state, selection, destination, plan.id);
    assert.match(nextPlanSend.target!, /research-fixture-3\.md$/);
    await fs.rm(join(destination, 'research'), { recursive: true });
    await fs.symlink(source, join(destination, 'research'), 'dir');
    await assert.rejects(sendResearchToFolder(state, selection, destination), /link|unavailable/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('starting from research preserves existing files and records the opened project', async () => {
  const { prepareResearchStart, confirmResearchStart, previewResearchStart } = await import('./sendToProject.js');
  const { workflows } = await import('../server/state.js');
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'arco-research-start-'));
  const workflowId = randomUUID(), clusterId = randomUUID();
  try {
    const source = join(root, 'source'), parent = join(root, 'projects');
    await fs.mkdir(join(source, 'rounds', 'round-1'), { recursive: true }); await fs.mkdir(parent);
    await fs.writeFile(join(source, 'rounds', 'round-1', 'report-a.md'), '# Report\n');
    await fs.writeFile(join(source, 'exports.md'), '# Exports\n');
    const state = { clusterId, folder: source, name: 'Fixture', rounds: [{ n: 1, releasedAt: '2026-01-01', entries: { A: { state: 'replied' } } }] } as never;
    const selection = { kind: 'report', round: 1, letter: 'A' } as const;
    assert.deepEqual((await previewResearchStart(state, selection)).files.map(x => x.path), ['README.md', 'rounds/round-1/researcher-a.md']);
    await fs.mkdir(join(parent, 'existing')); await fs.writeFile(join(parent, 'existing', 'keep.txt'), 'keep');
    await assert.rejects(prepareResearchStart(state, selection, parent, 'existing', false), /already exists/);
    const prepared = await prepareResearchStart(state, selection, parent, 'existing', true);
    assert.ok(prepared.token); assert.equal(await fs.readFile(join(parent, 'existing', 'keep.txt'), 'utf8'), 'keep');
    assert.equal(await fs.readFile(join(prepared.target!, 'rounds/round-1/researcher-a.md'), 'utf8'), '# Report\n');
    assert.doesNotMatch(await fs.readFile(join(source, 'exports.md'), 'utf8'), /started project/);
    workflows.set(workflowId, { config: { workingDirectory: join(parent, 'wrong') } } as never);
    await assert.rejects(confirmResearchStart(clusterId, prepared.token!, workflowId), /project folder/);
    workflows.set(workflowId, { config: { workingDirectory: prepared.project } } as never);
    await confirmResearchStart(clusterId, prepared.token!, workflowId);
    assert.match(await fs.readFile(join(source, 'exports.md'), 'utf8'), /started project/);
  } finally { workflows.delete(workflowId); await fs.rm(root, { recursive: true, force: true }); }
});

test('starting from a summary copies the whole released project in the readable layout', async () => {
  const { prepareResearchStart, previewResearchStart } = await import('./sendToProject.js');
  const { sourceFileName } = await import('./researchFolder.js');
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'arco-research-start-layout-'));
  try {
    const source = join(root, 'source'), parent = join(root, 'projects');
    await fs.mkdir(parent);
    for (const dir of ['rounds/round-1', 'rounds/round-2', 'rounds/round-3', 'syntheses', 'sources']) await fs.mkdir(join(source, dir), { recursive: true });
    const notes = { name: 'notes.md', contentBase64: Buffer.from('notes').toString('base64'), byteLength: 5 };
    const table = { name: 'notes.md', contentBase64: Buffer.from('table').toString('base64'), byteLength: 5 };
    for (const artifact of [notes, table]) await fs.writeFile(join(source, 'sources', sourceFileName(artifact)), Buffer.from(artifact.contentBase64, 'base64'));
    for (const [name, text] of Object.entries({
      'brief.md': '# Brief\n', 'research.json': '{}\n', 'director-log.md': '# Log\n', 'exports.md': '# Exports\n',
      'synthesis.md': '# Latest\n', 'syntheses/round-1.md': `# Round one\nSee rounds/round-1/report-a.md and sources/${sourceFileName(notes)}\n`,
      'rounds/round-1/round.md': 'r1', 'rounds/round-1/report-a.md': `# A\n- sources/${sourceFileName(notes)}\n- sources/${sourceFileName(table)}\n`, 'rounds/round-1/report-b.md': '# B\n',
      'rounds/round-2/round.md': 'r2', 'rounds/round-2/report-a.md': '# A2\n', 'rounds/round-3/round.md': 'unreleased',
    })) await fs.writeFile(join(source, name), text);
    const state = { clusterId: randomUUID(), folder: source, name: 'Layout fixture', brief: 'A made-up brief.', blind: true, createdAt: '2026-01-01T00:00:00Z', researchers: [{ letter: 'A', provider: 'claude', model: 'm' }, { letter: 'B', provider: 'claude', model: 'm' }], rounds: [
      { n: 1, releasedAt: '2026-01-01', entries: { A: { state: 'replied', artifacts: [notes, table] }, B: { state: 'replied' } } },
      { n: 2, releasedAt: '2026-01-02', entries: { A: { state: 'replied' }, B: { state: 'failed' } } },
      { n: 3, entries: { A: { state: 'waiting' } } },
    ] } as never;
    const preview = await previewResearchStart(state, { kind: 'synthesis', round: 1 });
    assert.deepEqual(preview.counts, { rounds: 2, catchUps: 0, reports: 3, summaries: 2, returnedFiles: 2 });
    assert.equal(preview.startSummary, 'summary.md');
    const prepared = await prepareResearchStart(state, { kind: 'synthesis', round: 1 }, parent, 'fresh', false);
    assert.equal(prepared.error, undefined);
    assert.deepEqual([...prepared.written].sort(), ['README.md', 'brief.md', 'director-log.md', 'research.json', 'rounds/round-1/files/researcher-a/notes-2.md',
      'rounds/round-1/files/researcher-a/notes.md', 'rounds/round-1/researcher-a.md', 'rounds/round-1/researcher-b.md', 'rounds/round-1/round.md', 'rounds/round-1/summary.md',
      'rounds/round-2/researcher-a.md', 'rounds/round-2/round.md', 'rounds/round-2/summary.md', 'summary.md']);
    const read = (name: string) => fs.readFile(join(prepared.target!, name), 'utf8');
    assert.equal(await read('summary.md'), '# Round one\nSee rounds/round-1/researcher-a.md and rounds/round-1/files/researcher-a/notes.md\n');
    assert.equal(await read('rounds/round-1/researcher-a.md'), '# A\n- files/researcher-a/notes.md\n- files/researcher-a/notes-2.md\n');
    assert.equal(await read('rounds/round-2/summary.md'), '# Latest\n');
    const readme = await read('README.md');
    assert.match(readme, /\[summary\.md\]\(summary\.md\): the summary of round 1/);
    assert.match(readme, /\[rounds\/round-2\/summary\.md\]\(rounds\/round-2\/summary\.md\): the latest summary/);
    assert.doesNotMatch(readme, /claude/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('research exports exclude private state and unreleased rounds and record confirmation', async () => {
  const { prepareResearchExport, confirmResearchExport } = await import('./exportResults.js');
  const { unzipSync } = await import('fflate');
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'arco-research-export-'));
  const clusterId = randomUUID();
  try {
    await fs.mkdir(join(root, 'rounds', 'round-1'), { recursive: true });
    await fs.mkdir(join(root, '.arco')); await fs.writeFile(join(root, '.arco', 'private'), 'secret');
    for (const name of ['brief.md', 'research.json', 'director-log.md', 'exports.md']) await fs.writeFile(join(root, name), 'fixture');
    await fs.writeFile(join(root, 'rounds', 'round-1', 'round.md'), 'round');
    await fs.writeFile(join(root, 'rounds', 'round-1', 'report-a.md'), 'report');
    const state = { clusterId, folder: root, rounds: [{ n: 1, releasedAt: '2026-01-01', entries: { A: { state: 'replied' } } }] } as never;
    const selection = { kind: 'project' } as const;
    const archive = await prepareResearchExport(state, selection, 'zip');
    const files = unzipSync(Buffer.from(archive.data, 'base64'));
    assert.ok(files['rounds/round-1/report-a.md']); assert.ok(files['exports.md']);
    assert.ok(!Object.keys(files).some(name => name.startsWith('.arco/')));
    assert.doesNotMatch(await fs.readFile(join(root, 'exports.md'), 'utf8'), /download started/);
    await confirmResearchExport(clusterId, archive.token);
    assert.match(await fs.readFile(join(root, 'exports.md'), 'utf8'), /zip download started/);
    (state as any).catchUps = [{ catchUp: 'B', entries: { B: { state: 'waiting' } } }];
    await assert.rejects(prepareResearchExport(state, selection, 'zip'), /released/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('composer attachments are recorded only after the draft confirms them', async () => {
  const { stageResearchForComposer, confirmResearchComposer } = await import('./sendToProject.js');
  const { workflows } = await import('../server/state.js');
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'arco-research-composer-'));
  const workflowId = randomUUID(), clusterId = randomUUID();
  let files: Array<{path:string}> = [];
  try {
    await fs.mkdir(join(root, 'rounds', 'round-1'), { recursive: true });
    await fs.writeFile(join(root, 'rounds', 'round-1', 'report-a.md'), '# Report\n');
    await fs.writeFile(join(root, 'exports.md'), '# Exports\n');
    const state = { clusterId, folder: root, name: 'Fixture', rounds: [{ n: 1, releasedAt: '2026-01-01', entries: { A: { state: 'replied' } } }] } as never;
    workflows.set(workflowId, { config: { incognito: false } } as never);
    const staged = await stageResearchForComposer(state, { kind: 'report', round: 1, letter: 'A' }, workflowId);
    files = staged.attachments;
    assert.equal(files.length, 1); assert.ok(staged.token);
    assert.doesNotMatch(await fs.readFile(join(root, 'exports.md'), 'utf8'), /composer/);
    await confirmResearchComposer(clusterId, staged.token!);
    assert.match(await fs.readFile(join(root, 'exports.md'), 'utf8'), /composer/);
    await assert.rejects(confirmResearchComposer(clusterId, staged.token!), /expired/);
  } finally {
    workflows.delete(workflowId);
    for (const file of files) await fs.rm(file.path, { force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('quick research starts in Arco storage without a research folder and permits one round', async () => {
  const { arcoHome } = await import('../arcoHome.js');
  const { discardUnusedResearchFolder } = await import('./researchCreate.js');
  const result = await prepareResearchCreate({ type: 'cluster_create_from_scratch', cwd: '', research: { name: 'Quick fixture', brief: 'Compare.', quick: true }, members: [
    { provider: 'claude', model: 'sonnet' }, { provider: 'ollama', model: 'fixture' },
  ] });
  assert.ok(!('refusal' in result), JSON.stringify(result));
  if ('refusal' in result) return;
  try {
    assert.equal(result.quick, true);
    assert.equal(result.folder, join(arcoHome(), 'chat-workspaces', result.projectId));
    assert.equal(result.msg.members[1].accessMode, 'researcher');
  } finally { assert.equal(await discardUnusedResearchFolder(result), true); }
  const p = await project();
  try {
    await updateResearch(p.clusterId, state => { state.quick = true; });
    assert.equal((await startRound(p.clusterId, p.director, 'First round')).ok, true);
    const second = await startRound(p.clusterId, p.director, 'Second round');
    assert.equal(second.ok, false); if (!second.ok) assert.equal(second.code, 'quick_complete');
  } finally { await clusterStore.deleteCluster(p.clusterId); await fs.rm(p.root, { recursive: true, force: true }); }
});


test('closing Quick research keeps the answer and chosen files in Past Chats before cleanup', async () => {
  const { persistInitialMeta } = await import('../workflowMeta.js');
  const { initWorkflowStore, persistAndStampSeq, flushWorkflowBuffer, replayEvents } = await import('../workflowStore.js');
  const { chatStorageDir, listSavedChats } = await import('../chatMode.js');
  const p = await project(), projectId = randomUUID();
  try {
    await updateResearch(p.clusterId, state => { state.quick = true; state.projectId = projectId; });
    const config = { name: 'Quick fixture', workingDirectory: p.folder, primaryProvider: 'claude', primaryModel: 'sonnet', primaryEffort: 'low' } as any;
    await persistInitialMeta(p.folder, p.director, config, { provider: 'claude', model: 'sonnet', effort: 'low' });
    await initWorkflowStore(p.folder, p.director);
    persistAndStampSeq(p.folder, p.director, { type: 'user_message_echo', workflowId: p.director, content: 'What is the answer?', timestamp: Date.now() });
    persistAndStampSeq(p.folder, p.director, { type: 'primary_text', workflowId: p.director, phase: 'passthrough', text: 'A retained answer.' });
    persistAndStampSeq(p.folder, p.director, { type: 'primary_complete', workflowId: p.director, phase: 'passthrough', costUsd: 0, durationMs: 1 });
    await flushWorkflowBuffer(p.folder, p.director);
    const workspace = clusterStore.isolatedWorkspaceFor(p.clusterId, p.a); await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(join(workspace, 'notes.txt'), 'Kept researcher file');
    const busy = await closeResearch(p.clusterId, { moveUnsent: true, isBusy: id => id === p.director, waitMs: 0 });
    assert.deepEqual(busy, { ok: false, error: 'director_busy' });
    assert.equal(await fs.readFile(join(workspace, 'notes.txt'), 'utf8'), 'Kept researcher file');
    const result = await closeResearch(p.clusterId, { moveUnsent: true, isBusy: () => false, waitMs: 0 }); assert.equal(result.ok, true);
    assert.ok((await listSavedChats()).some(chat => chat.workflowId === projectId));
    const events = await replayEvents(chatStorageDir(projectId), projectId, 0);
    assert.ok(events.some(event => event.type === 'primary_text' && event.text === 'A retained answer.'));
    const kept = events.find(event => event.type === 'user_message_echo' && event.content === 'Files kept from researchers.');
    assert.ok(kept && kept.type === 'user_message_echo' && kept.attachments?.length === 1);
    if (kept && kept.type === 'user_message_echo') assert.equal(await fs.readFile(kept.attachments![0], 'utf8'), 'Kept researcher file');
  } finally { await clusterStore.deleteCluster(p.clusterId); await fs.rm(p.root, { recursive: true, force: true }); }
});


test('a Quick research cluster stays open if its saved Chat cannot be created', async () => {
  const p = await project();
  await updateResearch(p.clusterId, state => { state.quick = true; state.projectId = randomUUID(); });
  installResearchCloseOnDelete(() => false);
  try {
    await assert.rejects(clusterStore.deleteCluster(p.clusterId), /Quick research could not be saved/);
    assert.ok(await clusterStore.readCluster(p.clusterId));
    assert.ok(await loadResearch(p.clusterId));
  } finally { setBeforeClusterDelete(null); await clusterStore.deleteCluster(p.clusterId); await fs.rm(p.root, { recursive: true, force: true }); }
});


test('an interrupted Quick research promotion restores the source and leaves both copies intact', async () => {
  const { arcoHome } = await import('../arcoHome.js');
  const { recoverQuickPromotion, readQuickPromotion } = await import('./quickPromotion.js');
  const p = await project(), projectId = randomUUID();
  const source = join(arcoHome(), 'chat-workspaces', projectId), target = join(p.root, 'promoted');
  await fs.mkdir(source, { recursive: true }); await fs.mkdir(target);
  await fs.writeFile(join(source, 'answer.txt'), 'original'); await fs.writeFile(join(target, 'answer.txt'), 'copy');
  try {
    await updateResearch(p.clusterId, state => { state.projectId = projectId; state.folder = target; delete state.quick; });
    assert.ok(await clusterStore.rebindResearchCwd(p.clusterId, p.folder, target));
    const recovered = await recoverQuickPromotion({ clusterId: p.clusterId, projectId, directorWorkflowId: p.director, source, root: p.root, target, phase: 'switching' });
    assert.equal(recovered.phase, 'error');
    assert.match((await readQuickPromotion(p.clusterId))?.message ?? '', /The copy did not complete.*incomplete copy remains/);
    assert.equal((await clusterStore.readCluster(p.clusterId))?.cwd, source);
    assert.equal((await loadResearch(p.clusterId))?.folder, source);
    assert.equal((await loadResearch(p.clusterId))?.quick, true);
    assert.equal(await fs.readFile(join(source, 'answer.txt'), 'utf8'), 'original');
    assert.equal(await fs.readFile(join(target, 'answer.txt'), 'utf8'), 'copy');
  } finally { (await import('../server/state.js')).workflowCwds.delete(p.director); await clusterStore.deleteCluster(p.clusterId); await fs.rm(p.root, { recursive: true, force: true }); await fs.rm(source, { recursive: true, force: true }); }
});


test('keeping Quick research waits for idle members and removes its source after the move', async () => {
  const { arcoHome } = await import('../arcoHome.js');
  const { workflows, workflowCwds } = await import('../server/state.js');
  const { persistInitialMeta } = await import('../workflowMeta.js');
  const { initWorkflowStore, persistAndStampSeq, flushWorkflowBuffer } = await import('../workflowStore.js');
  const { writeProjectFiles } = await import('./researchFolder.js');
  const { requestQuickPromotion, attemptQuickPromotion, readQuickPromotion, recoverQuickPromotion } = await import('./quickPromotion.js');
  const p = await project(), projectId = randomUUID(), source = join(arcoHome(), 'chat-workspaces', projectId), root = join(p.root, 'saved');
  await fs.mkdir(source, { recursive: true }); await fs.mkdir(root);
  for (const sub of ['rounds', 'syntheses', 'sources']) await fs.mkdir(join(source, sub));
  try {
    await updateResearch(p.clusterId, state => { state.projectId = projectId; state.folder = source; state.quick = true; });
    assert.ok(await clusterStore.rebindResearchCwd(p.clusterId, p.folder, source));
    const config = { name: 'Quick fixture', workingDirectory: source, primaryProvider: 'claude', primaryModel: 'sonnet', primaryEffort: 'low' } as any;
    await persistInitialMeta(source, p.director, config, { provider: 'claude', model: 'sonnet', effort: 'low' });
    await initWorkflowStore(source, p.director);
    persistAndStampSeq(source, p.director, { type: 'user_message_echo', workflowId: p.director, content: 'Question', timestamp: Date.now() });
    await flushWorkflowBuffer(source, p.director); await fs.writeFile(join(source, 'synthesis.md'), 'Retained answer');
    await writeProjectFiles((await loadResearch(p.clusterId))!);
    for (const id of [p.director, p.a, p.b]) workflows.set(id, { busy: id === p.director, config: { ...config, workingDirectory: id === p.director ? source : p.membersCwd }, primary: { provider: id === p.director ? 'claude' : 'ollama', model: 'fixture', effort: 'low' }, manager: {}, observers: new Set(), queue: { steering: [], followUp: [] } } as any);
    workflowCwds.set(p.director, source);
    assert.equal((await requestQuickPromotion(p.clusterId, root)).phase, 'waiting');
    await attemptQuickPromotion(p.clusterId); assert.equal((await readQuickPromotion(p.clusterId))?.phase, 'waiting');
    workflows.get(p.director)!.busy = false; await attemptQuickPromotion(p.clusterId);
    const journal = await readQuickPromotion(p.clusterId); assert.equal(journal?.phase, 'done', journal?.message);
    assert.equal(await fs.readFile(join(journal!.target!, 'synthesis.md'), 'utf8'), 'Retained answer');
    await assert.rejects(fs.stat(source), { code: 'ENOENT' });
    await fs.mkdir(source); await fs.copyFile(join(journal!.target!, 'research.json'), join(source, 'research.json'));
    await recoverQuickPromotion(journal!);
    await assert.rejects(fs.stat(source), { code: 'ENOENT' });
    assert.equal((await loadResearch(p.clusterId))?.folder, journal!.target); assert.equal((await loadResearch(p.clusterId))?.quick, undefined);
    assert.equal((await clusterStore.readCluster(p.clusterId))?.cwd, journal!.target);
    assert.equal(workflows.get(p.director)?.config.workingDirectory, journal!.target);
  } finally {
    for (const id of [p.director, p.a, p.b]) { workflows.delete(id); workflowCwds.delete(id); }
    setBeforeClusterDelete(null); await clusterStore.deleteCluster(p.clusterId); await fs.rm(p.root, { recursive: true, force: true }); await fs.rm(source, { recursive: true, force: true });
  }
});

test('a follow-up interrupts Quick research copying and runs before the switch', async t => {
  const { arcoHome } = await import('../arcoHome.js');
  const { workflows, workflowCwds } = await import('../server/state.js');
  const { persistInitialMeta } = await import('../workflowMeta.js');
  const { initWorkflowStore, flushWorkflowBuffer } = await import('../workflowStore.js');
  const { writeProjectFiles } = await import('./researchFolder.js');
  const { requestQuickPromotion, attemptQuickPromotion, readQuickPromotion } = await import('./quickPromotion.js');
  const engine = await import('../ws/turnEngine.js');
  const p = await project(), projectId = randomUUID(), source = join(arcoHome(), 'chat-workspaces', projectId), root = join(p.root, 'saved');
  await fs.mkdir(source, { recursive: true }); await fs.mkdir(root);
  for (const sub of ['rounds', 'syntheses', 'sources']) await fs.mkdir(join(source, sub));
  const pauseFile = join(source, 'pause.txt'); await fs.writeFile(pauseFile, 'fixture');
  await (await import('../settings.js')).patchSettings({ researchFolder: root });
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const paused = new Promise<void>(resolve => { resume = resolve; });
  const originalOpen = fs.open.bind(fs);
  t.mock.method(fs, 'open', (async (path: any, ...args: any[]) => {
    if (path === pauseFile) { enter(); await paused; }
    return (originalOpen as any)(path, ...args);
  }) as any);
  let captured = '';
  const ws = { readyState: 1, bufferedAmount: 0, send: () => {} } as any;
  const session = { id: 'fixture', workflowIds: new Set([p.director]), clusterIds: new Set(), clusterObserved: new Map() } as any;
  const config = { name: 'Quick fixture', workingDirectory: source, primaryProvider: 'ollama', primaryModel: 'fixture', primaryEffort: 'low', autoCompaction: { enabled: false }, autoHandoff: { enabled: false, afterCompactions: 5 } } as any;
  const manager = { spawn: async (spec: any, emit: any) => { captured = spec.task; emit({ type: 'worker_complete', costUsd: 0, durationMs: 1 }); return { id: spec.id, text: 'done', costUsd: 0, durationMs: 1 }; }, getWorkerPid: () => undefined };
  try {
    await updateResearch(p.clusterId, state => { state.projectId = projectId; state.folder = source; state.quick = true; });
    assert.ok(await clusterStore.rebindResearchCwd(p.clusterId, p.folder, source));
    await persistInitialMeta(source, p.director, config, { provider: 'ollama', model: 'fixture', effort: 'low' });
    await initWorkflowStore(source, p.director); await flushWorkflowBuffer(source, p.director); await writeProjectFiles((await loadResearch(p.clusterId))!);
    for (const id of [p.director, p.a, p.b]) workflows.set(id, { busy: false, config: { ...config, workingDirectory: id === p.director ? source : p.membersCwd }, primary: { provider: 'ollama', model: 'fixture', effort: 'low', skipPermissions: false }, manager, observers: new Set([ws]), queue: { steering: [], followUp: [] }, autoHandoff: { enabled: false, afterCompactions: 5, compactions: 0, fired: false } } as any);
    workflowCwds.set(p.director, source);
    engine.initTurnEngine({ previewAutoDetect: { noteAgentText() {}, notePotentialDevServerStart() {} } as any, handleCreateWorkflow: async () => {}, handleHandoffRequest: async () => {}, captureCheckpoint: async () => null });
    assert.equal((await requestQuickPromotion(p.clusterId, root)).phase, 'waiting');
    const copying = attemptQuickPromotion(p.clusterId);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([entered, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Copy did not reach the fixture file.')), 5000); })]); }
    finally { if (timeout) clearTimeout(timeout); }
    installResearchCloseOnDelete(() => false);
    await assert.rejects(clusterStore.deleteCluster(p.clusterId), /Quick research could not be saved/);
    assert.ok(await clusterStore.readCluster(p.clusterId));
    const followup = engine.handleUserMessage(ws, session, p.director, 'FOLLOWUP_BEFORE_MOVE', 'followup', undefined, false, undefined, undefined);
    await new Promise(resolve => setImmediate(resolve));
    resume(); await Promise.all([copying, followup]);
    assert.equal((await readQuickPromotion(p.clusterId))?.phase, 'waiting');
    assert.equal((await clusterStore.readCluster(p.clusterId))?.cwd, source);
    assert.match(captured, /FOLLOWUP_BEFORE_MOVE/);
  } finally {
    resume(); t.mock.restoreAll(); for (const id of [p.director, p.a, p.b]) { workflows.delete(id); workflowCwds.delete(id); }
    setBeforeClusterDelete(null); await clusterStore.deleteCluster(p.clusterId); await fs.rm(p.root, { recursive: true, force: true }); await fs.rm(source, { recursive: true, force: true });
  }
});

test('a saved Quick Chat can become a project and its deletion removes only Chat-owned sources', async () => {
  const { arcoHome } = await import('../arcoHome.js');
  const { chatStorageDir } = await import('../chatMode.js');
  const { persistInitialMeta } = await import('../workflowMeta.js');
  const { initWorkflowStore, persistAndStampSeq, flushWorkflowBuffer } = await import('../workflowStore.js');
  const { requestSavedQuickPromotion, attemptSavedQuickPromotion, readSavedQuickPromotion } = await import('./savedQuickPromotion.js');
  const { deleteQuickResearchForChat } = await import('./quickResearchChat.js');
  const { readClosedRecord } = await import('./researchLibrary.js');
  const { patchSettings } = await import('../settings.js');
  const p = await project(), id = randomUUID(), source = join(arcoHome(), 'chat-workspaces', id), root = join(p.root, 'kept');
  await fs.mkdir(source, { recursive: true }); await fs.cp(p.folder, source, { recursive: true }); await fs.mkdir(root);
  await patchSettings({ researchFolder: root });
  try {
    await updateResearch(p.clusterId, state => { state.projectId = id; state.folder = source; state.quick = true; });
    assert.ok(await clusterStore.rebindResearchCwd(p.clusterId, p.folder, source));
    const config = { name: 'Quick fixture', workingDirectory: source, primaryProvider: 'claude', primaryModel: 'sonnet', primaryEffort: 'low' } as any;
    await persistInitialMeta(source, p.director, config, { provider: 'claude', model: 'sonnet', effort: 'low' });
    await initWorkflowStore(source, p.director);
    persistAndStampSeq(source, p.director, { type: 'user_message_echo', workflowId: p.director, content: 'Question', timestamp: Date.now() });
    persistAndStampSeq(source, p.director, { type: 'primary_text', workflowId: p.director, phase: 'passthrough', text: 'Retained answer.' });
    await flushWorkflowBuffer(source, p.director);
    assert.equal((await closeResearch(p.clusterId, { moveUnsent: false, isBusy: () => false, waitMs: 0 })).ok, true);
    await initWorkflowStore(chatStorageDir(id), id);
    persistAndStampSeq(chatStorageDir(id), id, { type: 'user_message_echo', workflowId: id, content: 'Later follow-up', timestamp: Date.now() });
    await flushWorkflowBuffer(chatStorageDir(id), id);
    assert.equal((await requestSavedQuickPromotion(id, root)).phase, 'waiting');
    await attemptSavedQuickPromotion(id);
    const journal = await readSavedQuickPromotion(id);
    assert.equal(journal?.phase, 'done', journal?.message);
    assert.match(await fs.readFile(join(journal!.target!, 'saved-chat.md'), 'utf8'), /Retained answer\.[\s\S]*Later follow-up/);
    assert.equal((await readClosedRecord(id))?.folder, journal!.target);
    assert.equal(await deleteQuickResearchForChat(chatStorageDir(id), id), true);
    await assert.rejects(fs.stat(source), { code: 'ENOENT' });
    assert.equal((await readClosedRecord(id))?.folder, journal!.target);
    assert.ok((await fs.stat(join(journal!.target!, 'research.json'))).isFile());
  } finally {
    setBeforeClusterDelete(null); await clusterStore.deleteCluster(p.clusterId); await fs.rm(p.root, { recursive: true, force: true });
    await fs.rm(source, { recursive: true, force: true }); await fs.rm(chatStorageDir(id), { recursive: true, force: true });
  }
});

test('the summary lists each replied researcher\'s returned files where the released round wrote them', async () => {
  const { writeReleasedRound } = await import('./researchFolder.js');
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'arco-research-sources-'));
  try {
    const artifact = { name: 'evidence notes.md', contentBase64: Buffer.from('evidence').toString('base64'), byteLength: 8 };
    const released = { n: 1, startedAt: '2026-01-01', deadline: '2026-01-01', releasedAt: '2026-01-01', targeted: [], entries: {
      A: { state: 'replied', report: 'Report.', artifacts: [artifact] },
      B: { state: 'failed', artifacts: [artifact] },
    } };
    const open = { n: 2, startedAt: '2026-01-02', deadline: '2026-01-02', targeted: [], entries: { A: { state: 'replied', report: 'Next.', artifacts: [artifact] } } };
    const state = { folder: root, name: 'Fixture', brief: 'Brief', blind: true, directorWorkflowId: 'director', researchers: [
      { letter: 'A', workflowId: 'a', provider: 'claude', model: 'haiku' },
      { letter: 'B', workflowId: 'b', provider: 'claude', model: 'haiku' },
    ], rounds: [released, open] } as never;
    const written = await writeReleasedRound(state, released as never);
    const summary = researchSummary(state);
    assert.deepEqual(summary.rounds[0].entries.A.sources, [{ name: 'evidence notes.md', path: written.A.sources[0] }]);
    await fs.access(join(root, written.A.sources[0]));
    assert.equal(summary.rounds[0].entries.B.sources, undefined, 'no report, no file list');
    assert.equal(summary.rounds[1].entries.A.sources, undefined, 'nothing listed before release');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
