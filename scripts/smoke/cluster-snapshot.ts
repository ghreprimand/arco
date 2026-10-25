// Cluster snapshots — headless WS smoke (2026-06-12).
//
// Covers (protocol + on-disk only; no LLM turns):
//   1. Create a Native source workflow.
//   2. cluster_create_with_fresh_workers → 2-member cluster.
//   3. REST peer/send so each member's events.jsonl carries real history
//      (peer_message_sent on the sender, peer_message_received on drain).
//   4. cluster_snapshot_save → assert cluster_snapshot_saved + the on-disk
//      manifest.json + members/<wfid>/events.jsonl files exist under
//      ~/.archon/cluster-snapshots/<id>/.
//   5. cluster_snapshot_list → the saved snapshot appears in the summary.
//   6. cluster_snapshot_restore → a NEW cluster_created arrives with a NEW
//      clusterId + 2 members with NEW workflowIds; the client is DELIVERED each
//      member (workflow_created) and its replayed history over the wire (not
//      just on disk); the on-disk events.jsonl in the target cwd carries the
//      rewritten ids + replayed history.
//   7. cluster_snapshot_delete → list no longer contains it.
//   8. teardown.
//
// Skips (manual-only): the restored cluster tab/chat RENDERING in the browser
// (verified by operator pass). The over-the-wire workflow_created + replayed
// history assertions here guard the review's blocker (restore must deliver
// history to the client, not merely persist it).
//
// Run with the dev server up:
//   npm run dev:server &
//   npm run smoke:cluster-snapshot
//
// Exits 0 on all-pass, 1 on any failure.

import { connect, step, assert, assertEq, summary } from './lib.js';
import { mkdtempSync, rmSync, existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const PORT = parseInt(process.env.ARCHON_PORT || '3001', 10);
const REST_BASE = `http://127.0.0.1:${PORT}`;
const SNAPSHOTS_ROOT = join(homedir(), '.archon', 'cluster-snapshots');

async function main(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'archon-snap-src-'));
  const restoreCwd = mkdtempSync(join(tmpdir(), 'archon-snap-dst-'));
  const snapName = `smoke-snap-${Date.now().toString(36)}`;
  console.log(`Cluster-snapshot smoke — src ${cwd}`);
  console.log(`                         dst ${restoreCwd}`);
  console.log('');

  const c = await connect();

  let sourceWfid = '';
  let clusterId = '';
  let members: string[] = [];
  let snapshotId = '';
  let firstSnapshotCreatedAt = '';
  let restoredClusterId = '';
  let restoredMembers: string[] = [];

  await step('1: create Native source workflow', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'Snapshot Source',
        primaryProvider: 'claude',
        primaryModel: 'claude-opus-4-7',
        primaryEffort: 'normal',
        skipPermissions: true,
        workingDirectory: cwd,
        claudeTransport: 'native',
        outputStyle: 'terse',
        goal: 'Portable cluster smoke goal',
        fastMode: true,
        advanced: { additionalDirectories: ['/portable-extra'] },
        researchSpawnToken: 'must-not-port',
        templateSpawnToken: 'must-not-port-either',
        remoteEnabled: true,
        remoteGatesEnabled: true,
      },
    });
    const m = await c.waitFor(
      (x) => x.type === 'workflow_created' && (x.config as { name?: string }).name === 'Snapshot Source',
      8000,
      'workflow_created',
    );
    sourceWfid = m.workflowId as string;
    assert(sourceWfid.length > 0, 'source workflowId returned');
  });

  await step('2: cluster_create_with_fresh_workers (+1 sibling) → 2 members', async () => {
    c.send({
      type: 'cluster_create_with_fresh_workers',
      sourceWorkflowId: sourceWfid,
      additionalCount: 1,
      name: 'Snapshot Cluster',
    });
    const m = await c.waitFor(
      (x) => x.type === 'cluster_created' &&
        ((x.state as { members: Array<{ workflowId: string }> }).members.some((mem) => mem.workflowId === sourceWfid)),
      8000,
      'cluster_created',
    );
    clusterId = m.clusterId as string;
    members = (m.state as { members: Array<{ workflowId: string }> }).members.map((mem) => mem.workflowId);
    assertEq(members.length, 2, 'cluster has 2 members');
  });

  await step('3: REST peer/send + drain so members carry real history', async () => {
    for (const wfid of members) c.send({ type: 'subscribe', workflowId: wfid });
    await new Promise((r) => setTimeout(r, 100));
    const sendP = c.waitFor(
      (x) => x.type === 'peer_message_sent' && (x as { from?: string }).from === members[0],
      3000,
      'peer_message_sent',
    );
    const r = await fetch(`${REST_BASE}/api/clusters/${clusterId}/peer/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: members[0], to: members[1], content: 'snapshot history seed' }),
    });
    assertEq(r.status, 200, `peer/send returned 200 (got ${r.status})`);
    await sendP;
    // Drain into members[1] so a peer_message_received lands in its events.jsonl.
    const drainR = await fetch(`${REST_BASE}/api/clusters/${clusterId}/peer/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workflowId: members[1] }),
    });
    const drained = await drainR.json() as Array<{ content: string }>;
    assertEq(drained.length, 1, 'drained the seeded message');
    assertEq(drained[0].content, 'snapshot history seed', 'drained content matches');

    // Provider-native session stores are deliberately outside the portable
    // artifact. Seed fake source-machine ids so save + restore both prove they
    // cannot leak into a fork.
    for (const wfid of members) {
      const metaPath = join(cwd, '.archon', 'workflows', wfid, 'meta.json');
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
        cliSessions: Array<{ provider: string; sessionId: string; createdAt: number }>;
      };
      meta.cliSessions = [{ provider: 'codex', sessionId: `source-machine-${wfid}`, createdAt: Date.now() }];
      writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
    }
  });

  await step('3b: seed synthetic turns + a cluster_member_nudged on member[0]', async () => {
    // Append 3 turns to one member's on-disk events.jsonl directly so we can
    // exercise last-N-turn truncation + clusterId remap without real LLM turns.
    // Flush the in-memory buffer first by giving the server a moment, then read
    // the file to find the current max seq and continue above it (init's tail-
    // scan keyed off the highest seq, so colliding would corrupt ordering).
    await new Promise((r) => setTimeout(r, 200));
    const seededWfid = members[0];
    const seededEvents = join(cwd, '.archon', 'workflows', seededWfid, 'events.jsonl');
    let maxSeq = 0;
    if (existsSync(seededEvents)) {
      for (const line of readFileSync(seededEvents, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const seq = (JSON.parse(t) as { seq?: number }).seq;
          if (typeof seq === 'number' && seq > maxSeq) maxSeq = seq;
        } catch { /* skip */ }
      }
    }
    let seq = maxSeq + 1;
    const ts = Date.now();
    const lines: string[] = [];
    for (let turn = 1; turn <= 3; turn++) {
      lines.push(JSON.stringify({ seq: seq++, ts, type: 'primary_turn_started', workflowId: seededWfid }));
      lines.push(JSON.stringify({ seq: seq++, ts, type: 'primary_text', workflowId: seededWfid, text: `turn ${turn} body alpha` }));
      lines.push(JSON.stringify({ seq: seq++, ts, type: 'primary_text', workflowId: seededWfid, text: `turn ${turn} body beta` }));
    }
    // One cluster_member_nudged carrying the ORIGINAL clusterId — restore must
    // remap this to the new clusterId.
    lines.push(JSON.stringify({ seq: seq++, ts, type: 'cluster_member_nudged', clusterId, workflowId: seededWfid }));
    // Two task_ledger_snapshot copies — compaction rule 5 must keep ONLY the
    // last (each is a full ledger copy; a real 4-member log carried 31 MB of
    // them). Tagged stale/fresh so the restore assertion can tell them apart.
    lines.push(JSON.stringify({ seq: seq++, ts, type: 'task_ledger_snapshot', workflowId: seededWfid, tasks: [{ id: 't1', title: 'ledger STALE copy' }] }));
    lines.push(JSON.stringify({ seq: seq++, ts, type: 'task_ledger_snapshot', workflowId: seededWfid, tasks: [{ id: 't1', title: 'ledger FRESH copy' }] }));
    appendFileSync(seededEvents, lines.join('\n') + '\n', 'utf8');
  });

  await step('3c: configure passive cluster settings captured by the snapshot', async () => {
    const efficiencyP = c.waitFor(
      (x) => x.type === 'cluster_state' && x.clusterId === clusterId &&
        (x.state as { efficiencyLevel?: string; efficiencyAddendum?: string }).efficiencyLevel === 'lean' &&
        (x.state as { efficiencyAddendum?: string }).efficiencyAddendum === 'Snapshot doctrine.',
      3000,
      'cluster_state lean + addendum',
    );
    c.send({ type: 'cluster_efficiency_set', clusterId, level: 'lean', addendum: 'Snapshot doctrine.' });
    await efficiencyP;

    const progressP = c.waitFor(
      (x) => x.type === 'cluster_state' && x.clusterId === clusterId &&
        (x.state as { progressTracking?: string }).progressTracking === 'plan',
      3000,
      'cluster_state progressTracking === plan',
    );
    c.send({ type: 'cluster_progress_set', clusterId, mode: 'plan' });
    await progressP;

    const boardP = c.waitFor(
      (x) => x.type === 'cluster_state' && x.clusterId === clusterId &&
        (x.state as { taskBoardMode?: string }).taskBoardMode === 'none',
      3000,
      'cluster_state taskBoardMode === none',
    );
    c.send({ type: 'cluster_task_board_mode_set', clusterId, mode: 'none' });
    await boardP;
  });

  await step('4: cluster_snapshot_save → saved + on-disk files exist', async () => {
    const savedP = c.waitFor(
      (x) => x.type === 'cluster_snapshot_saved' &&
        ((x.snapshot as { name?: string }).name === snapName),
      5000,
      'cluster_snapshot_saved',
    );
    c.send({ type: 'cluster_snapshot_save', clusterId, workflowId: members[0], name: snapName });
    const saved = await savedP;
    const snapshot = saved.snapshot as { id: string; memberCount: number; sourceCwd: string };
    snapshotId = snapshot.id;
    firstSnapshotCreatedAt = (saved.snapshot as { createdAt: string }).createdAt;
    assert(snapshotId.length > 0, 'snapshot id returned');
    assertEq(snapshot.memberCount, 2, 'snapshot captured 2 members');
    assertEq(snapshot.sourceCwd, cwd, 'snapshot sourceCwd matches the cluster cwd');

    // On-disk: manifest.json + each member's events.jsonl copy.
    const dir = join(SNAPSHOTS_ROOT, snapshotId);
    assert(existsSync(join(dir, 'manifest.json')), 'manifest.json exists on disk');
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
      members: Array<{
        oldWorkflowId: string;
        workflowConfig?: {
          outputStyle?: string;
          goal?: string;
          fastMode?: boolean;
          advanced?: { additionalDirectories?: string[] };
          researchSpawnToken?: string;
          templateSpawnToken?: string;
          remoteEnabled?: boolean;
          remoteGatesEnabled?: boolean;
        };
      }>;
    };
    const sourceManifestMember = manifest.members.find((m) => m.oldWorkflowId === sourceWfid);
    assertEq(sourceManifestMember?.workflowConfig?.outputStyle, 'terse', 'manifest preserves output style');
    assertEq(sourceManifestMember?.workflowConfig?.goal, 'Portable cluster smoke goal', 'manifest preserves north star');
    assertEq(sourceManifestMember?.workflowConfig?.fastMode, true, 'manifest preserves fast mode');
    assertEq(
      sourceManifestMember?.workflowConfig?.advanced?.additionalDirectories?.[0],
      '/portable-extra',
      'manifest preserves advanced config',
    );
    assert(sourceManifestMember?.workflowConfig?.researchSpawnToken === undefined, 'manifest strips research token');
    assert(sourceManifestMember?.workflowConfig?.templateSpawnToken === undefined, 'manifest strips template token');
    assert(sourceManifestMember?.workflowConfig?.remoteEnabled === undefined, 'manifest strips member REMOTE arming');
    assert(sourceManifestMember?.workflowConfig?.remoteGatesEnabled === undefined, 'manifest strips member remote gates');
    for (const wfid of members) {
      assert(existsSync(join(dir, 'members', wfid, 'meta.json')), `member ${wfid.slice(0, 8)} meta copy exists`);
      assert(existsSync(join(dir, 'members', wfid, 'events.jsonl')), `member ${wfid.slice(0, 8)} events copy exists`);
      const portableMeta = JSON.parse(
        readFileSync(join(dir, 'members', wfid, 'meta.json'), 'utf8'),
      ) as { cliSessions?: unknown[] };
      assertEq(portableMeta.cliSessions?.length, 0, `member ${wfid.slice(0, 8)} snapshot strips provider sessions`);
    }
    // The seeded peer content must be present in at least one captured events
    // copy (the sender's peer_message_sent preview or the recipient's received).
    const anyHistory = members.some((wfid) =>
      readFileSync(join(dir, 'members', wfid, 'events.jsonl'), 'utf8').includes('snapshot history seed'),
    );
    assert(anyHistory, 'captured events.jsonl carries the seeded peer history');
  });

  await step('4b: duplicate save conflicts; confirmed retry atomically replaces it', async () => {
    const conflictP = c.waitFor(
      (x) => x.type === 'cluster_snapshot_conflict' &&
        (x.existing as { id?: string }).id === snapshotId,
      3000,
      'cluster_snapshot_conflict',
    );
    c.send({ type: 'cluster_snapshot_save', clusterId, workflowId: members[0], name: snapName });
    const conflict = await conflictP;
    assertEq((conflict.existing as { name: string }).name, snapName, 'conflict identifies the same-name snapshot');
    const beforeReplace = JSON.parse(
      readFileSync(join(SNAPSHOTS_ROOT, snapshotId, 'manifest.json'), 'utf8'),
    ) as { createdAt: string; clusterState: { efficiencyLevel?: string } };
    assertEq(beforeReplace.createdAt, firstSnapshotCreatedAt, 'unconfirmed conflict leaves old manifest untouched');
    assertEq(beforeReplace.clusterState.efficiencyLevel, 'lean', 'old snapshot still carries original state');

    const efficiencyP = c.waitFor(
      (x) => x.type === 'cluster_state' && x.clusterId === clusterId &&
        (x.state as { efficiencyLevel?: string; efficiencyAddendum?: string }).efficiencyLevel === 'balanced' &&
        (x.state as { efficiencyAddendum?: string }).efficiencyAddendum === 'Replacement doctrine.',
      3000,
      'cluster_state replacement settings',
    );
    c.send({ type: 'cluster_efficiency_set', clusterId, level: 'balanced', addendum: 'Replacement doctrine.' });
    await efficiencyP;
    await new Promise((r) => setTimeout(r, 5));

    const replacedP = c.waitFor(
      (x) => x.type === 'cluster_snapshot_saved' &&
        (x.snapshot as { id?: string }).id === snapshotId,
      5000,
      'cluster_snapshot_saved replacement',
    );
    c.send({
      type: 'cluster_snapshot_save',
      clusterId,
      workflowId: members[0],
      name: snapName,
      replaceSnapshotId: snapshotId,
    });
    const replaced = await replacedP;
    const replacedSummary = replaced.snapshot as { id: string; createdAt: string };
    assertEq(replacedSummary.id, snapshotId, 'replacement keeps the stable local snapshot id');
    assert(replacedSummary.createdAt !== firstSnapshotCreatedAt, 'replacement records a new capture time');
    const afterReplace = JSON.parse(
      readFileSync(join(SNAPSHOTS_ROOT, snapshotId, 'manifest.json'), 'utf8'),
    ) as { clusterState: { efficiencyLevel?: string; efficiencyAddendum?: string } };
    assertEq(afterReplace.clusterState.efficiencyLevel, 'balanced', 'replacement captured new cluster state');
    assertEq(afterReplace.clusterState.efficiencyAddendum, 'Replacement doctrine.', 'replacement captured new doctrine');
  });

  await step('5: cluster_snapshot_list → the saved snapshot appears', async () => {
    const listP = c.waitFor(
      (x) => x.type === 'cluster_snapshot_list' && Array.isArray((x as { snapshots?: unknown }).snapshots),
      3000,
      'cluster_snapshot_list',
    );
    c.send({ type: 'cluster_snapshot_list' });
    const list = await listP;
    const snaps = list.snapshots as Array<{ id: string; name: string }>;
    assert(snaps.some((s) => s.id === snapshotId && s.name === snapName), 'saved snapshot in the list');
  });

  await step('6: cluster_snapshot_restore → NEW cluster with 2 fresh members + history', async () => {
    // A restored member is any workflowId we haven't seen as a source/original.
    const isFreshMember = (x: { workflowId?: unknown }) =>
      typeof x.workflowId === 'string' && !members.includes(x.workflowId) && x.workflowId !== sourceWfid;
    // BLOCKER regression guard. Restore must DELIVER each member to the client:
    // a workflow_created (so the client builds the JobState) AND the replayed
    // history events — not merely write events.jsonl to disk. These arrive in a
    // burst BEFORE cluster_created, so register the waiters before sending or the
    // cluster_created wait would splice them out of the buffer.
    const sourceCreatedP = c.waitFor(
      (x) => x.type === 'workflow_created' && isFreshMember(x) &&
        (x.config as { name?: string }).name === 'Snapshot Source',
      8000,
      'workflow_created for restored source member',
    );
    // History delivery contract (2026-06-12): each member's compacted history
    // arrives as ONE replay_batch message — never a stream of N live events.
    // Streaming let an interrupt persist client lastSeq≈head with no chat
    // (permanently blank workers); the batch is all-or-nothing.
    const replayedHistoryP = c.waitFor(
      (x) => x.type === 'replay_batch' && isFreshMember(x) && JSON.stringify(x).includes('snapshot history seed'),
      8000,
      'replay_batch carrying restored history (over the wire)',
    );
    const restoredP = c.waitFor(
      (x) => x.type === 'cluster_created' &&
        x.clusterId !== clusterId &&
        ((x.state as { members: Array<{ workflowId: string }> }).members.length === 2),
      8000,
      'cluster_created (restored)',
    );
    c.send({ type: 'cluster_snapshot_restore', snapshotId, targetCwd: restoreCwd, turnsPerMember: 2 });
    const restored = await restoredP;
    restoredClusterId = restored.clusterId as string;
    restoredMembers = (restored.state as { members: Array<{ workflowId: string }> }).members.map((m) => m.workflowId);

    assert(restoredClusterId !== clusterId, 'restored cluster has a NEW clusterId');
    assertEq(restoredMembers.length, 2, 'restored cluster has 2 members');
    const restoredState = restored.state as {
      efficiencyLevel?: string;
      efficiencyAddendum?: string;
      progressTracking?: string;
      taskBoardMode?: string;
      remoteEnabled?: boolean;
      remoteGatesEnabled?: boolean;
      idleNudgerEnabled?: boolean;
      autoTurnOnMailbox?: boolean;
      dispatcher?: { enabled?: boolean };
    };
    assertEq(restoredState.efficiencyLevel, 'balanced', 'restore preserves replacement efficiency level');
    assertEq(restoredState.efficiencyAddendum, 'Replacement doctrine.', 'restore preserves replacement addendum');
    assertEq(restoredState.progressTracking, 'plan', 'restore preserves progress tracking');
    assertEq(restoredState.taskBoardMode, 'none', 'restore preserves task-board mode');
    assert(restoredState.remoteEnabled !== true, 'restore leaves REMOTE disarmed');
    assert(restoredState.remoteGatesEnabled !== true, 'restore leaves remote gates disarmed');
    assert(restoredState.idleNudgerEnabled !== true, 'restore leaves nudges disarmed');
    assert(restoredState.autoTurnOnMailbox !== true, 'restore leaves auto-pickup disarmed');
    assert(restoredState.dispatcher?.enabled !== true, 'restore leaves dispatcher execution disarmed');

    // The blocker the review caught: a workflow_created + replayed transcript
    // must reach the CLIENT, else the restored panes are empty.
    const restoredSource = await sourceCreatedP;
    assert(
      restoredMembers.includes(restoredSource.workflowId as string),
      'restored member workflow_created delivered to client',
    );
    const restoredSourceConfig = restoredSource.config as {
      workingDirectory?: string;
      outputStyle?: string;
      goal?: string;
      fastMode?: boolean;
      advanced?: { additionalDirectories?: string[] };
    };
    assertEq(restoredSourceConfig.workingDirectory, restoreCwd, 'restore retargets only the working directory');
    assertEq(restoredSourceConfig.outputStyle, 'terse', 'restore preserves output style');
    assertEq(restoredSourceConfig.goal, 'Portable cluster smoke goal', 'restore preserves north star');
    assertEq(restoredSourceConfig.fastMode, true, 'restore preserves fast mode');
    assertEq(
      restoredSourceConfig.advanced?.additionalDirectories?.[0],
      '/portable-extra',
      'restore preserves advanced config',
    );
    await replayedHistoryP;
    // Fork semantics — every restored member id must be brand new.
    for (const id of restoredMembers) {
      assert(!members.includes(id), `restored member ${id.slice(0, 8)} is a NEW workflowId`);
      const restoredMeta = JSON.parse(
        readFileSync(join(restoreCwd, '.archon', 'workflows', id, 'meta.json'), 'utf8'),
      ) as { cliSessions?: unknown[] };
      assertEq(restoredMeta.cliSessions?.length, 0, `restored member ${id.slice(0, 8)} has no source-machine session`);
    }

    // The restored members' events.jsonl must exist in the TARGET cwd with the
    // history replayed (proves the workflowId rewrite + copy landed).
    const anyRestoredHistory = restoredMembers.some((wfid) => {
      const p = join(restoreCwd, '.archon', 'workflows', wfid, 'events.jsonl');
      return existsSync(p) && readFileSync(p, 'utf8').includes('snapshot history seed');
    });
    assert(anyRestoredHistory, 'restored member events.jsonl carries the replayed history in the target cwd');

    // The rewritten events.jsonl must reference the NEW member ids, not the old.
    for (const wfid of restoredMembers) {
      const p = join(restoreCwd, '.archon', 'workflows', wfid, 'events.jsonl');
      if (!existsSync(p)) continue;
      const text = readFileSync(p, 'utf8');
      for (const oldId of members) {
        assert(!text.includes(oldId), `restored events for ${wfid.slice(0, 8)} contain no stale old id ${oldId.slice(0, 8)}`);
      }
    }

    // PROBLEM 2 — last-N-turn truncation. The restored member mapping from the
    // seeded source (the only one carrying the synthetic "turn K body" text)
    // must keep exactly 2 primary_turn_started markers (we seeded 3, restored
    // with turnsPerMember: 2).
    const seededRestored = restoredMembers.find((wfid) => {
      const p = join(restoreCwd, '.archon', 'workflows', wfid, 'events.jsonl');
      return existsSync(p) && readFileSync(p, 'utf8').includes('body alpha');
    });
    assert(!!seededRestored, 'found the restored member mapping from the seeded source');
    const seededText = readFileSync(join(restoreCwd, '.archon', 'workflows', seededRestored!, 'events.jsonl'), 'utf8');
    const markerCount = seededText
      .split('\n')
      .filter((l) => l.trim())
      .filter((l) => { try { return (JSON.parse(l) as { type?: string }).type === 'primary_turn_started'; } catch { return false; } })
      .length;
    assertEq(markerCount, 2, 'seeded member truncated to exactly the last 2 turns');
    // Last 2 turns kept ⇒ turns 2 and 3 survive, turn 1 dropped.
    assert(!seededText.includes('turn 1 body'), 'oldest (turn 1) dropped by last-2 truncation');
    assert(seededText.includes('turn 3 body'), 'newest (turn 3) retained');

    // PROBLEM 3 — delta coalescing. Each seeded turn carries TWO adjacent
    // primary_text deltas (alpha, beta); the restored copy must merge each
    // run into ONE event (2 turns ⇒ 2 primary_text lines, each holding both
    // halves). Guards the 2026-06-12 regression where a restore replayed
    // tens of thousands of token-level deltas and reconnect-looped the
    // client under the SYNCING overlay.
    const textLines = seededText
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l) as { type?: string; text?: string }; } catch { return null; } })
      .filter((e): e is { type: string; text: string } => e?.type === 'primary_text');
    assertEq(textLines.length, 2, 'adjacent text deltas coalesced to one event per turn');
    assert(
      textLines.every((e) => e.text.includes('body alpha') && e.text.includes('body beta')),
      'coalesced event carries the concatenated run text',
    );

    // Compaction rule 5 — task_ledger_snapshot is latest-wins. We seeded two
    // (STALE then FRESH); the restored copy must keep ONLY the fresh one.
    // Guards the 2026-06-12 regression where 163 full-ledger copies (31 MB)
    // rode a 4-member restore, froze the tab, and tripped the WS heartbeat.
    const ledgerLines = seededText
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l) as { type?: string }; } catch { return null; } })
      .filter((e) => e?.type === 'task_ledger_snapshot');
    assertEq(ledgerLines.length, 1, 'only the last task_ledger_snapshot survives compaction');
    assert(seededText.includes('ledger FRESH copy'), 'surviving ledger snapshot is the newest');
    assert(!seededText.includes('ledger STALE copy'), 'superseded ledger snapshot dropped');

    // PROBLEM 1 — clusterId remap. Any cluster_member_nudged line in the
    // restored log must carry the NEW restored clusterId, not the original.
    for (const line of seededText.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let entry: { type?: string; clusterId?: string };
      try { entry = JSON.parse(t); } catch { continue; }
      if (entry.type === 'cluster_member_nudged') {
        assertEq(entry.clusterId, restoredClusterId, 'cluster_member_nudged remapped to the NEW clusterId');
        assert(entry.clusterId !== clusterId, 'cluster_member_nudged no longer carries the original clusterId');
      }
    }
  });

  await step('7: cluster_snapshot_delete → list no longer contains it', async () => {
    // Require a list where the snapshot is ABSENT. Earlier steps can leave a
    // stale cluster_snapshot_list in the buffer (the save auto-pushes one, and
    // step 5 requests another), so a plain "any list" wait could match a stale
    // pre-delete list that still has the id. Waiting for absence pins us to the
    // fresh post-delete list.
    const listP = c.waitFor(
      (x) => x.type === 'cluster_snapshot_list' &&
        Array.isArray((x as { snapshots?: unknown }).snapshots) &&
        !((x as { snapshots: Array<{ id: string }> }).snapshots).some((s) => s.id === snapshotId),
      3000,
      'cluster_snapshot_list without the deleted id',
    );
    c.send({ type: 'cluster_snapshot_delete', snapshotId });
    await listP;
    assert(!existsSync(join(SNAPSHOTS_ROOT, snapshotId)), 'snapshot dir removed from disk');
  });

  await step('8: teardown', async () => {
    c.send({ type: 'cluster_delete', clusterId });
    if (restoredClusterId) c.send({ type: 'cluster_delete', clusterId: restoredClusterId });
    for (const id of [...members, ...restoredMembers]) {
      c.send({ type: 'remove_workflow', workflowId: id });
    }
    await new Promise((r) => setTimeout(r, 200));
    await c.close();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(restoreCwd, { recursive: true, force: true });
  });

  summary('Cluster-snapshot smoke');
}

main().catch((err) => {
  console.error('Cluster-snapshot smoke crashed:', err);
  process.exit(2);
});
