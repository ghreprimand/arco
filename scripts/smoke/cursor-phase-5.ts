// Phase 5 acceptance — read-only primitives via the stateless print path.
//
// A Cursor reviewer / summarizer / DOCS one-shot must NOT reuse the primary
// tab's long-lived ACP worker: the primitive carries the initiating tab's
// workflowId, so the ACP cache would run it INSIDE the operator's live session.
// Phase 5 routes any `sandbox: 'read-only'` cursor spawn to a throwaway
// `cursor-agent -p --mode ask` process instead (providers/cursor/print.ts).
//
// This exercises the reviewer — the canonical read-only primitive — end to end:
//
//   1. A transcript exists (one tiny primary turn).
//   2. A `review_request` with a CURSOR reviewer returns a real artifact
//      (`review_artifact_ready`, no error) — proving the print one-shot ran the
//      review to completion off the primary path.
//   3. The primary session SURVIVES: a second primary turn afterward still
//      round-trips. If the reviewer had hijacked the cached ACP session (the bug
//      Phase 5 closes) the primary would be polluted or wedged — this is the
//      honest behavioural proxy for "the primitive ran in its own throwaway
//      session, read-only", since no WS surface exposes the `--mode ask` flag.
//
//   ARCHON_SMOKE_WS_URL=ws://localhost:3011/ws npx tsx scripts/smoke/cursor-phase-5.ts
//
// ⚠️ METERED: makes ~2 primary Cursor turns + 1 reviewer turn (tiny prompts) on
// `auto`. The worker must be logged in (`cursor-agent login`).

import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { connect, step, assert, summary } from './lib.js';

const TURN_TIMEOUT_MS = 90_000;
const REVIEW_TIMEOUT_MS = 120_000;

async function main(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'cursor-smoke-p5-'));
  writeFileSync(join(cwd, 'README.md'), '# cursor phase-5 sandbox\n');

  const c = await connect();
  let wfid = '';

  await step('create a cursor (ACP) workflow on auto', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'cursor phase-5',
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

  await step('turn 1 seeds a transcript to review', async () => {
    c.send({ type: 'user_message', workflowId: wfid, content: 'Reply with exactly: ALPHA. Nothing else.' });
    await c.waitFor(
      (x) => x.type === 'primary_complete' && (x as { workflowId?: string }).workflowId === wfid,
      TURN_TIMEOUT_MS,
      'primary_complete #1',
    );
  });

  await step('a cursor reviewer runs read-only (print one-shot) and returns an artifact', async () => {
    c.send({
      type: 'review_request',
      workflowId: wfid,
      reviewer: { provider: 'cursor', model: 'auto', effort: 'medium' },
      contextRef: { kind: 'last-turn' },
    });

    const started = await c.waitFor(
      (x) => x.type === 'review_started' && (x as { workflowId?: string }).workflowId === wfid,
      15_000,
      'review_started',
    );
    assert(
      (started as { reviewer?: { provider?: string } }).reviewer?.provider === 'cursor',
      'review_started names the cursor reviewer',
    );

    const done = await c.waitFor(
      (x) => x.type === 'review_artifact_ready' && (x as { workflowId?: string }).workflowId === wfid,
      REVIEW_TIMEOUT_MS,
      'review_artifact_ready',
    );
    const err = (done as { error?: string }).error;
    if (err) console.log('        review error:', JSON.stringify(err.slice(0, 240)));
    assert(!err, 'review returned without error (print one-shot ran to completion)');
    assert(
      typeof (done as { artifactName?: string }).artifactName === 'string' &&
        (done as { artifactName?: string }).artifactName!.length > 0,
      'review produced a named artifact',
    );
  });

  await step('the primary ACP session survived the review (not hijacked)', async () => {
    // If the reviewer had reused the cached ACP worker, this turn would fail,
    // hang, or answer out of a polluted context. A clean round-trip proves the
    // primitive ran in its own throwaway session.
    c.send({ type: 'user_message', workflowId: wfid, content: 'Reply with exactly: OMEGA. Nothing else.' });
    await c.waitFor(
      (x) => x.type === 'primary_complete' && (x as { workflowId?: string }).workflowId === wfid,
      TURN_TIMEOUT_MS,
      'primary_complete #2 (post-review)',
    );
  });

  await c.close();
  summary('cursor-phase-5');
}

main().catch((err) => {
  console.error('cursor-phase-5 crashed:', err);
  process.exit(1);
});
