// 2026-06-15 — headless smoke for the per-cluster efficiency level.
//
// Covers:
//   1. Pure preset bundle (clusterEfficiency.ts): doctrine presence per level,
//      peer-send budget shrink (thorough 15 > balanced 8 > lean 4), and the
//      mailbox-notice variant text per level (full / softened / minimal).
//   2. Addendum folding — buildDoctrine appends the operator note; a bare
//      addendum at 'thorough' still produces a block.
//   3. WS round-trip — cluster_efficiency_set flips cluster_state.efficiencyLevel
//      (balanced → with addendum → back to thorough, where the field drops).
//
// Skips (manual-only):
//   - Real LLM turns (no API spend) — the system-prompt INJECTION of the
//     doctrine + the budget bite are verified by typecheck + the pure asserts
//     here + an operator pass with a live cluster.
//
// Run with the dev server up:
//   npm run dev:server &
//   npm run smoke:cluster-efficiency
//
// Exits 0 on all-pass, 1 on any failure.

import { connect, step, assert, assertEq, summary } from './lib.js';
import * as eff from '../../server/src/clusterEfficiency.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function main(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-smoke-eff-'));
  console.log(`Cluster-efficiency smoke — cwd ${cwd}`);
  console.log('');

  await step('1: peer-send budget shrinks with level', async () => {
    assertEq(eff.sendBudgetFor('thorough'), 15, 'thorough budget = 15');
    assertEq(eff.sendBudgetFor('balanced'), 8, 'balanced budget = 8');
    assertEq(eff.sendBudgetFor('lean'), 4, 'lean budget = 4');
    assertEq(eff.sendBudgetFor(undefined), 15, 'undefined level falls back to thorough budget');
  });

  await step('2: doctrine presence + addendum folding', async () => {
    assertEq(eff.buildDoctrine('thorough'), undefined, 'thorough has no doctrine');
    const bal = eff.buildDoctrine('balanced');
    assert(!!bal && bal.includes('BALANCED'), 'balanced doctrine present');
    const lean = eff.buildDoctrine('lean');
    assert(!!lean && lean.includes('LEAN'), 'lean doctrine present');
    const withNote = eff.buildDoctrine('lean', 'Skip the integration suite.');
    assert(!!withNote && withNote.includes('Operator note: Skip the integration suite.'), 'addendum folds into doctrine');
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
    assert(full.includes('2 pending peer messages') && full.includes('re-engage'), 'full notice keeps re-engage language');
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
    // Fresh clusters default to thorough → efficiencyLevel field absent.
    const state = cm.state as { efficiencyLevel?: string };
    assert(state.efficiencyLevel === undefined, 'fresh cluster defaults to thorough (field absent)');
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

  await step('8: teardown', async () => {
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
