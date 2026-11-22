import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as clusterMailbox from '../clusterMailbox.js';
import * as clusterPeerOps from '../clusterPeerOps.js';
import * as clusterStore from '../clusterStore.js';
import { createResearchFolder } from './researchFolder.js';
import { addResearcher, configureResearch, holdResearcherReply, removeResearcher, onMemberSettled, revealResearch, setResearcherSignInWaiting, startResearchDirector, startRound, timeoutRound } from './researchRounds.js';
import { catchUpKey, initResearch, loadResearch, researchSummary, updateResearch } from './researchState.js';
import { ensureResearchTripwires, observeResearchText, observeResearchTool, RESEARCH_CANARY_FILE, researchToolBoundaryWarning } from './researchTripwires.js';
import { closeResearch, closedResearchRecordPath, installResearchCloseOnDelete, sweepClosedResearch, unsentFiles } from './researchClose.js';
import { setBeforeClusterDelete } from '../clusterStore.js';
import { researchMembersRoot } from './researchCreate.js';
import { prepareResearchCreate } from './researchCreate.js';

async function project() {
  const root = await fs.mkdtemp(join(tmpdir(), 'arco-research-'));
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

test('research creation rejects a CLI-only setting on a different provider', async () => {
  const result = await prepareResearchCreate({ type: 'cluster_create_from_scratch', cwd: '', research: { name: 'Fixture', brief: 'Compare.' }, members: [
    { provider: 'claude', model: 'sonnet' },
    { provider: 'ollama', model: 'fixture', researchClaudeTransport: 'cli' },
  ] });
  assert.deepEqual(result, { refusal: 'member[1] invalid_research_transport' });
});

test('research creation explains an unsupported Codex version', { skip: process.platform === 'win32' }, async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'arco-codex-version-'));
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
    assert.equal((await startRound(p.clusterId, p.director, 'Compare the fixtures.', 5)).ok, true);
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
    assert.equal((await startRound(p.clusterId, p.director, 'Round two.', 5)).ok, true);
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
    assert.equal((await startRound(p.clusterId, p.director, 'Brief.', 5)).ok, true);
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
    assert.equal((await startRound(p.clusterId, p.director, 'Brief.', 5)).ok, true);
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
    assert.equal((await startRound(p.clusterId, p.director, 'Brief.', 5)).ok, true);
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


test('research clusters reject ordinary members, access changes, board and plans', async () => {
  const p = await project();
  try {
    const bridge = await import('../clusterPlanBridge.js');
    await assert.rejects(clusterStore.addMember(p.clusterId, randomUUID()), /research project controls/);
    assert.equal(await clusterStore.setMemberAccessMode(p.clusterId, p.a, 'standard'), null);
    assert.equal(await clusterStore.setTaskBoardMode(p.clusterId, 'project'), null);
    assert.equal(await clusterStore.setPlanId(p.clusterId, randomUUID()), null);
    assert.equal(await bridge.setClusterPlanBody(p.clusterId, '# Unexpected plan'), null);
    const snapshots = await import('../clusterSnapshots.js');
    await assert.rejects(snapshots.saveSnapshot({ clusterId: p.clusterId, name: 'Fixture' }), /Research projects cannot be saved/);
  } finally { await clusterStore.deleteCluster(p.clusterId); await fs.rm(p.root, { recursive: true, force: true }); }
});

test('result selection excludes unreleased reports and preserves only released source files', async () => {
  const { selectResearchFiles } = await import('./resultSelection.js');
  const { sourceFileName } = await import('./researchFolder.js');
  const root = await fs.mkdtemp(join(tmpdir(), 'arco-research-selection-'));
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
  const root = await fs.mkdtemp(join(tmpdir(), 'arco-catch-up-send-'));
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
  const root = await fs.mkdtemp(join(tmpdir(), 'arco-research-send-'));
  try {
    const source = join(root, 'source'), destination = join(root, 'project');
    await fs.mkdir(join(source, 'rounds', 'round-1'), { recursive: true });
    await fs.mkdir(destination); await fs.writeFile(join(source, 'exports.md'), '# Exports\n');
    await fs.writeFile(join(source, 'rounds', 'round-1', 'report-a.md'), '# Report\n');
    const state = { folder: source, name: 'Fixture', createdAt: '2026-01-01', rounds: [{ n: 1, releasedAt: '2026-01-01', entries: { A: { state: 'replied' } } }] } as never;
    const selection = { kind: 'report', round: 1, letter: 'A' } as const;
    const first = await sendResearchToFolder(state, selection, destination);
    assert.equal(first.error, undefined); assert.deepEqual(first.written, ['rounds/round-1/report-a.md']);
    const second = await sendResearchToFolder(state, selection, destination);
    assert.notEqual(first.target, second.target);
    assert.equal(await fs.readFile(join(first.target!, 'rounds', 'round-1', 'report-a.md'), 'utf8'), '# Report\n');
    const log = await fs.readFile(join(source, 'exports.md'), 'utf8');
    assert.ok(log.includes(first.target!)); assert.ok(log.includes(second.target!));
    const plan = await createPlan(destination, { title: 'Fixture', body: '' });
    const artifact = { name: 'source.txt', contentBase64: Buffer.from('source').toString('base64'), byteLength: 6 };
    await fs.mkdir(join(source, 'sources'));
    await fs.writeFile(join(source, 'sources', sourceFileName(artifact)), 'source');
    await fs.writeFile(join(source, 'rounds', 'round-1', 'report-a.md'), `# Report\n[source](../../sources/${sourceFileName(artifact)})\n`);
    (state as any).rounds[0].entries.A.artifacts = [artifact];
    const withSource = await sendResearchToFolder(state, selection, destination);
    assert.match(await fs.readFile(join(withSource.target!, 'rounds', 'round-1', 'report-a.md'), 'utf8'), /\]\(\.\.\/\.\.\/sources\//);
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
  const root = await fs.mkdtemp(join(tmpdir(), 'arco-research-start-'));
  const workflowId = randomUUID(), clusterId = randomUUID();
  try {
    const source = join(root, 'source'), parent = join(root, 'projects');
    await fs.mkdir(join(source, 'rounds', 'round-1'), { recursive: true }); await fs.mkdir(parent);
    await fs.writeFile(join(source, 'rounds', 'round-1', 'report-a.md'), '# Report\n');
    await fs.writeFile(join(source, 'exports.md'), '# Exports\n');
    const state = { clusterId, folder: source, name: 'Fixture', rounds: [{ n: 1, releasedAt: '2026-01-01', entries: { A: { state: 'replied' } } }] } as never;
    const selection = { kind: 'report', round: 1, letter: 'A' } as const;
    assert.deepEqual((await previewResearchStart(state, selection)).map(x => x.path), ['rounds/round-1/report-a.md']);
    await fs.mkdir(join(parent, 'existing')); await fs.writeFile(join(parent, 'existing', 'keep.txt'), 'keep');
    await assert.rejects(prepareResearchStart(state, selection, parent, 'existing', false), /already exists/);
    const prepared = await prepareResearchStart(state, selection, parent, 'existing', true);
    assert.ok(prepared.token); assert.equal(await fs.readFile(join(parent, 'existing', 'keep.txt'), 'utf8'), 'keep');
    assert.equal(await fs.readFile(join(prepared.target!, 'rounds/round-1/report-a.md'), 'utf8'), '# Report\n');
    assert.doesNotMatch(await fs.readFile(join(source, 'exports.md'), 'utf8'), /started project/);
    workflows.set(workflowId, { config: { workingDirectory: join(parent, 'wrong') } } as never);
    await assert.rejects(confirmResearchStart(clusterId, prepared.token!, workflowId), /project folder/);
    workflows.set(workflowId, { config: { workingDirectory: prepared.project } } as never);
    await confirmResearchStart(clusterId, prepared.token!, workflowId);
    assert.match(await fs.readFile(join(source, 'exports.md'), 'utf8'), /started project/);
  } finally { workflows.delete(workflowId); await fs.rm(root, { recursive: true, force: true }); }
});

test('research exports exclude private state and unreleased rounds and record confirmation', async () => {
  const { prepareResearchExport, confirmResearchExport } = await import('./exportResults.js');
  const { unzipSync } = await import('fflate');
  const root = await fs.mkdtemp(join(tmpdir(), 'arco-research-export-'));
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
  const root = await fs.mkdtemp(join(tmpdir(), 'arco-research-composer-'));
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
