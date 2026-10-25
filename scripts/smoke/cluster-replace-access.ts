import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, step, assert, assertEq, summary } from './lib.js';
import * as taskLedger from '../../server/src/project/taskLedger.js';

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), 'archon-cluster-replace-'));
  const c = await connect();
  let clusterId = '';
  let original = '';
  let replacement = '';
  let otherMember = '';
  let boardKey: string | undefined;
  let taskId = '';
  let isolatedMember = '';

  await step('create two-member cluster with a blind worker', async () => {
    c.send({
      type: 'cluster_create_from_scratch',
      cwd,
      name: 'Replace/access smoke',
      members: [
        {
          provider: 'claude',
          model: 'claude-opus-4-6',
          effort: 'high',
          displayName: 'Auditor',
          role: 'AUDITOR',
          tier: 'heavy',
          focus: 'Independent review',
          accessMode: 'blind',
        },
        {
          provider: 'claude',
          model: 'claude-opus-4-6',
          effort: 'medium',
          displayName: 'Builder',
        },
      ],
    });
    const created = await c.waitFor((m) => m.type === 'cluster_created', 8000, 'cluster_created');
    clusterId = created.clusterId as string;
    const state = created.state as { members: Array<{ workflowId: string; accessMode?: string }>; taskBoardKey?: string };
    original = state.members[0].workflowId;
    otherMember = state.members[1].workflowId;
    boardKey = state.taskBoardKey;
    assertEq(state.members[0].accessMode, 'blind', 'blind access mode persisted');
  });

  await step('seed one active assignment for transfer', async () => {
    const task = { ...taskLedger.newTask({ title: 'Carry me forward' }), assignee: original };
    taskId = task.id;
    await taskLedger.save(cwd, [task], boardKey);
  });

  await step('replace atomically with metadata and active-task transfer', async () => {
    c.send({
      type: 'cluster_member_replace',
      clusterId,
      workflowId: original,
      accessMode: 'blind',
      includeHistory: false,
      transferActiveTasks: true,
    });
    const replaced = await c.waitFor((m) => m.type === 'cluster_member_replaced', 8000, 'cluster_member_replaced');
    replacement = replaced.newWorkflowId as string;
    assert(replacement !== original, 'replacement has a new workflow id');
    assertEq(replaced.accessMode, 'blind', 'replacement remains blind');
    assertEq(replaced.historyIncluded, false, 'history omitted');
    assertEq(replaced.transferredTaskCount, 1, 'one active assignment transferred');
    const member = replaced.member as { displayName: string; role?: string; tier?: string; focus?: string };
    assertEq(member.displayName, 'Auditor', 'name preserved');
    assertEq(member.role, 'AUDITOR', 'role preserved');
    assertEq(member.tier, 'heavy', 'tier preserved');
    assertEq(member.focus, 'Independent review', 'focus preserved');
  });

  await step('task assignment points at replacement', async () => {
    const tasks = await taskLedger.load(cwd, boardKey);
    assertEq(tasks.find((task) => task.id === taskId)?.assignee, replacement, 'assignee remapped');
  });

  await step('cluster state preserves member slot order', async () => {
    const stateMsg = await c.waitFor(
      (m) => m.type === 'cluster_state' && (m.state as { members?: Array<{ workflowId: string }> })?.members?.[0]?.workflowId === replacement,
      5000,
      'cluster_state replacement order',
    );
    const state = stateMsg.state as { members: Array<{ workflowId: string }> };
    assertEq(state.members.length, 2, 'cluster did not collapse during replace');
  });

  await step('add an isolated fresh member with a durable private workspace', async () => {
    c.send({
      type: 'cluster_add_fresh_workers',
      clusterId,
      count: 1,
      provider: 'claude',
      model: 'claude-opus-4-6',
      accessMode: 'isolated',
    });
    const added = await c.waitFor(
      (m) => m.type === 'cluster_member_added' && (m.member as { accessMode?: string })?.accessMode === 'isolated',
      8000,
      'isolated cluster_member_added',
    );
    isolatedMember = (added.member as { workflowId: string }).workflowId;
    assert(
      existsSync(join(homedir(), '.archon', 'clusters', clusterId, 'isolates', isolatedMember, 'workspace')),
      'isolated workspace exists outside project',
    );
  });

  c.send({ type: 'cluster_delete', clusterId });
  await c.waitFor((m) => m.type === 'cluster_deleted' && m.clusterId === clusterId, 3000, 'cluster_deleted');
  c.send({ type: 'remove_workflow', workflowId: replacement });
  c.send({ type: 'remove_workflow', workflowId: otherMember });
  c.send({ type: 'remove_workflow', workflowId: isolatedMember });
  await c.close();
  rmSync(cwd, { recursive: true, force: true });
  summary('Cluster replace/access smoke');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
