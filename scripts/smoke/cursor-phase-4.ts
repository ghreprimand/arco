// Phase 4 acceptance — system-prompt folds (north-star goalBlock).
//
// Phase 4 folds two operator-context blocks into the dispatched Cursor prompt:
//
//   1. North-star (goalBlock) — folded per-provider in worker.ts, mirroring
//      codex.ts. This IS testable now: set a goal via update_primary_config,
//      then a turn whose answer is only knowable from the north-star text.
//   2. Cluster plan/role/doctrine — folded via turnEngine's
//      needsStringFormCluster (now includes 'cursor'). NOT exercised here:
//      Cursor is not yet a ClusterMemberProvider (Phase 6), so no cursor tab
//      ever carries a turnClusterId and the branch is inert forward-prep. The
//      cluster half of the fold-smoke lands with Phase 6.
//
// The assertion is behavioural (the model quotes a codeword only present in the
// north-star), the honest end-to-end proxy for "the block reached the wire" —
// there is no WS surface exposing the raw dispatched prompt. Same live-model
// posture as cursor-phase-3.
//
//   ARCHON_SMOKE_WS_URL=ws://localhost:3011/ws npx tsx scripts/smoke/cursor-phase-4.ts
//
// ⚠️ METERED: makes 1 real Cursor turn (tiny prompt) on `auto`. The worker must
// be logged in (`cursor-agent login`).

import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { connect, step, assert, summary } from './lib.js';

const TURN_TIMEOUT_MS = 90_000;
// Distinctive token that appears ONLY in the north-star — not in the prompt, so
// a pass proves the goalBlock fold reached the model's context.
const CODEWORD = 'FJORD-7731';

async function main(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'cursor-smoke-p4-'));
  writeFileSync(join(cwd, 'README.md'), '# cursor phase-4 sandbox\n');

  const c = await connect();
  let wfid = '';

  await step('create a cursor (ACP) workflow on auto', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'cursor phase-4',
        primaryProvider: 'cursor',
        primaryModel: 'auto',
        primaryEffort: 'medium',
        skipPermissions: true,
        workingDirectory: cwd,
      },
    });
    const m = await c.waitFor((x) => x.type === 'workflow_created', 8000, 'workflow_created');
    wfid = m.workflowId as string;
    assert(typeof wfid === 'string' && wfid.length > 0, 'workflowId returned');
  });

  await step('set a north-star (goal) and wait for it to persist', async () => {
    c.send({
      type: 'update_primary_config',
      workflowId: wfid,
      goal: `The project's secret codeword is ${CODEWORD}. If asked for the codeword, reply with it exactly.`,
    });
    // persist-then-announce: goal_set fires only after meta.json is durable.
    await c.waitFor(
      (x) => x.type === 'goal_set' && (x as { workflowId?: string }).workflowId === wfid,
      8000,
      'goal_set',
    );
  });

  await step('turn sees the north-star: model quotes the codeword', async () => {
    c.send({
      type: 'user_message',
      workflowId: wfid,
      content: 'What is the secret codeword? Reply with only the codeword, nothing else.',
    });
    // Accumulate streamed reply text INSIDE the predicate — waitFor splices the
    // buffer up to the matched primary_complete, which would otherwise discard
    // the preceding primary_text deltas before we could peek them.
    let reply = '';
    await c.waitFor((x) => {
      const t = (x as { text?: string }).text;
      if (
        x.type === 'primary_text' &&
        (x as { workflowId?: string }).workflowId === wfid &&
        (x as { phase?: string }).phase === 'passthrough' &&
        typeof t === 'string'
      ) {
        reply += t;
      }
      return x.type === 'primary_complete' && (x as { workflowId?: string }).workflowId === wfid;
    }, TURN_TIMEOUT_MS, 'primary_complete (reply accumulated)');
    console.log('        reply:', JSON.stringify(reply.slice(0, 200)));
    assert(reply.includes(CODEWORD), `reply quotes the north-star codeword ${CODEWORD}`);
  });

  await c.close();
  summary('cursor-phase-4');
}

main().catch((err) => {
  console.error('cursor-phase-4 crashed:', err);
  process.exit(1);
});
