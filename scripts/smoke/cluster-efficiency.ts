// Isolated cluster coordination smoke: real WS/REST persistence and guards.
// Run only against the temporary server created by cluster-coordination-server.py.
import { connect, step, assert, assertEq, summary } from './lib.js';
import * as eff from '../../server/src/clusterEfficiency.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function main(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-smoke-eff-'));
  console.log(`Cluster-efficiency smoke — cwd ${cwd}`);
  console.log('');

  await step('1: omitted legacy guard retains historical cap mapping', async () => {
    assertEq(eff.sendBudgetFor('thorough'), 15, 'legacy Thorough cap = 15');
    assertEq(eff.sendBudgetFor('balanced'), 8, 'legacy Balanced cap = 8');
    assertEq(eff.sendBudgetFor('lean'), 4, 'legacy Lean cap = 4');
    assertEq(eff.sendBudgetFor(undefined), 15, 'undefined level falls back to thorough budget');
  });

  await step('2: doctrine presence + addendum folding', async () => {
    assert(!!eff.buildDoctrine('thorough')?.includes('required tests'), 'thorough retains required checks');
    const bal = eff.buildDoctrine('balanced');
    assert(!!bal && bal.includes('BALANCED'), 'balanced doctrine present');
    const lean = eff.buildDoctrine('lean');
    assert(!!lean && lean.includes('LEAN'), 'lean doctrine present');
    const withNote = eff.buildDoctrine('lean', 'Skip the integration suite.');
    assert(!!withNote && withNote.includes('Operator NOTE (appended instruction, not a mode or budget): Skip the integration suite.'), 'addendum folds into doctrine');
    // A bare addendum at thorough still produces a block so operator text is
    // never silently dropped.
    const bareNote = eff.buildDoctrine('thorough', 'Only ping me when blocked.');
    assert(!!bareNote && bareNote.includes('Only ping me when blocked.'), 'bare addendum at thorough still injects');
  });

  await step('3: mailbox-notice variant per level', async () => {
    assertEq(eff.mailboxNoticeVariantFor('thorough'), 'full', 'thorough → full');
    assertEq(eff.mailboxNoticeVariantFor('balanced'), 'softened', 'balanced → softened');
    assertEq(eff.mailboxNoticeVariantFor('lean'), 'minimal', 'lean → minimal');
    const full = eff.buildPeerMailboxNotice('thorough', 2);
    assert(full.includes('2 pending peer messages') && full.includes('concrete contradictory evidence'), 'full notice keeps re-engage language');
    const lean = eff.buildPeerMailboxNotice('lean', 1);
    assert(lean.includes('1 pending peer message') && !lean.includes('re-engage'), 'lean notice drops re-engage language');
  });

  const c = await connect();
  let sourceWfid = '';
  let clusterId = '';

  await step('4: create Native source + 1-sibling cluster', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'Smoke Eff Native Source',
        primaryProvider: 'claude',
        primaryModel: 'claude-opus-4-7',
        primaryEffort: 'normal',
        skipPermissions: true,
        workingDirectory: cwd,
        claudeTransport: 'native',
      },
    });
    const m = await c.waitFor(
      (x) => x.type === 'workflow_created' && (x.config as { name?: string }).name === 'Smoke Eff Native Source',
      8000,
      'workflow_created',
    );
    sourceWfid = m.workflowId as string;
    c.send({
      type: 'cluster_create_with_fresh_workers',
      sourceWorkflowId: sourceWfid,
      additionalCount: 1,
      name: 'Efficiency Smoke Cluster',
    });
    const cm = await c.waitFor(
      (x) => x.type === 'cluster_created' &&
        ((x.state as { members: Array<{ workflowId: string }> }).members.some((mem) => mem.workflowId === sourceWfid)),
      8000,
      'cluster_created',
    );
    clusterId = cm.clusterId as string;
    // New creation defaults are independent of legacy metadata fallbacks.
    const state = cm.state as { efficiencyLevel?: string };
    assert(state.efficiencyLevel === 'balanced', 'fresh cluster defaults to Balanced');
  });

  await step('5: set efficiency → balanced', async () => {
    const ackP = c.waitFor(
      (x) => x.type === 'cluster_state' && x.clusterId === clusterId &&
        (x.state as { efficiencyLevel?: string }).efficiencyLevel === 'balanced',
      3000,
      'cluster_state efficiencyLevel === balanced',
    );
    c.send({ type: 'cluster_efficiency_set', clusterId, level: 'balanced' });
    await ackP;
  });

  await step('6: set efficiency → lean + addendum', async () => {
    const ackP = c.waitFor(
      (x) => x.type === 'cluster_state' && x.clusterId === clusterId &&
        (x.state as { efficiencyLevel?: string; efficiencyAddendum?: string }).efficiencyLevel === 'lean' &&
        (x.state as { efficiencyAddendum?: string }).efficiencyAddendum === 'No status pings on this project.',
      3000,
      'cluster_state lean + addendum echo',
    );
    c.send({ type: 'cluster_efficiency_set', clusterId, level: 'lean', addendum: 'No status pings on this project.' });
    await ackP;
  });

  await step('7: set efficiency back → thorough drops the field', async () => {
    const ackP = c.waitFor(
      (x) => x.type === 'cluster_state' && x.clusterId === clusterId &&
        (x.state as { efficiencyLevel?: string }).efficiencyLevel === undefined,
      3000,
      'cluster_state efficiencyLevel cleared on thorough',
    );
    // addendum '' clears it too.
    c.send({ type: 'cluster_efficiency_set', clusterId, level: 'thorough', addendum: '' });
    await ackP;
  });

  await step('8: independent guard updates and actual REST feedback/permissions', async () => {
    const setGuard = async (mode: string, threshold: number) => {
      const next = c.waitFor(x => x.type === 'cluster_state' && x.clusterId === clusterId && (x.state as any).messageGuard?.mode === mode && (x.state as any).messageGuard?.threshold === threshold, 4000);
      c.send({ type: 'cluster_efficiency_set', clusterId, level: 'thorough', messageGuard: { mode, threshold } });
      return (await next).state as any;
    };
    const members = (await setGuard('warn', 2)).members.map((m: any) => m.workflowId);
    const post = (body: unknown) => fetch(`http://127.0.0.1:${process.env.ARCO_PORT}/api/clusters/${clusterId}/peer/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let warnings = 0;
    for (let i = 1; i <= 4; i++) {
      const response = await post({ from: members[0], to: members[1], content: 'wire-send-' + i });
      assertEq(response.status, 200, 'Warn only accepts each send');
      const body = await response.json() as any;
      assertEq(body.guard.count, i, 'actual send counter');
      if (body.guard.warning) warnings++;
    }
    assertEq(warnings, 1, 'one warning for this primary turn');
    await setGuard('hard', 2);
    const rejected = await post({ from: members[0], to: members[1], content: 'hard-refused' });
    assertEq(rejected.status, 400, 'hard guard refuses above cap');
    const detail = await rejected.json() as any;
    assertEq(detail.count, 4, 'guard edit retains counter'); assertEq(detail.cap, 2, 'hard cap feedback');
    assert(String(detail.message).includes('not delivered'), 'explicit refusal wording');
    await setGuard('none', 2);
    const delivered = await post({ from: members[0], to: members[1], content: 'hard-refused' });
    assertEq(delivered.status, 200, 'refusal refunds dedupe and count');
    assertEq((await delivered.json() as any).guard.count, 5, 'rejected attempt refunded');
    const invalid = await post({ from: 'not-a-member', to: members[1], content: 'refused identity' });
    assertEq(invalid.status, 400, 'membership fence remains');
    const duplicate = await post({ from: members[0], to: members[1], content: 'hard-refused' });
    assertEq(duplicate.status, 400, 'No limit retains dedupe');
  });

  await step('9: direct promotion defaults and explicit scratch creation settings', async () => {
    const source = async (suffix: string) => {
      c.send({ type: 'create_workflow', config: { name: 'Coordination ' + suffix, primaryProvider: 'claude', primaryModel: 'sonnet', primaryEffort: 'medium', workingDirectory: cwd, claudeTransport: 'native' } });
      return (await c.waitFor(x => x.type === 'workflow_created' && (x.config as any).name === 'Coordination ' + suffix, 8000)).workflowId;
    };
    const ids = [await source('one'), await source('two')];
    c.send({ type: 'cluster_create', cwd, memberWorkflowIds: ids });
    const promoted = await c.waitFor(x => x.type === 'cluster_created' && (x.state as any).members.some((m: any) => m.workflowId === ids[0]), 8000);
    const state = promoted.state as any;
    assertEq(state.efficiencyLevel, 'balanced', 'promotion uses Balanced');
    assertEq(state.taskBoardMode, 'cluster', 'promotion uses cluster board');
    assertEq(state.progressTracking ?? 'both', 'both', 'promotion keeps Both');
    assertEq(state.messageGuard.mode, 'warn', 'promotion guard independent');
    c.send({ type: 'cluster_create_from_scratch', cwd, name: 'Explicit coordination fixture', efficiencyLevel: 'thorough', messageGuard: { mode: 'hard', threshold: 27 }, taskBoardMode: 'none', progressTracking: 'plan', members: [{provider:'claude',model:'sonnet'}, {provider:'claude',model:'sonnet'}] });
    const scratch = (await c.waitFor(x => x.type === 'cluster_created' && (x.state as any).name === 'Explicit coordination fixture', 8000)).state as any;
    assertEq(scratch.efficiencyLevel ?? 'thorough', 'thorough', 'explicit Thorough wins');
    assertEq(scratch.messageGuard.threshold, 27, 'scratch threshold preserved');
    assertEq(scratch.taskBoardMode, 'none', 'explicit board off wins');
    assertEq(scratch.progressTracking, 'plan', 'explicit plan-only wins');
  });

  await step('10: teardown', async () => {
    c.send({ type: 'cluster_delete', clusterId });
    await new Promise((r) => setTimeout(r, 200));
    await c.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  summary('Cluster-efficiency smoke');
}

main().catch((err) => {
  console.error('Cluster-efficiency smoke crashed:', err);
  process.exit(2);
});
