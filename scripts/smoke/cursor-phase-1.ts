// Phase 1 acceptance — a minimal spawnable Cursor (ACP) primary.
//
// Boots a `cursor` workflow, sends one prompt, and asserts the full primary
// turn round-trips: streamed `primary_text` + a `primary_complete`. This
// exercises the real `cursor-agent acp` transport end-to-end (spawn → ACP
// handshake → session/new → session/prompt → session/update deltas → settle).
//
//   ARCHON_SMOKE_WS_URL=ws://localhost:3011/ws npx tsx scripts/smoke/cursor-phase-1.ts
//
// ⚠️ METERED: makes one real Cursor turn on `--model auto` (tiny prompt). The
// worker must be logged in (`cursor-agent login`) or the turn fails.

import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { connect, step, assert, summary, type AnyMessage } from './lib.js';

const TURN_TIMEOUT_MS = 90_000;

async function main(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'cursor-smoke-'));
  writeFileSync(join(cwd, 'README.md'), '# cursor smoke sandbox\n');

  const c = await connect();
  let wfid = '';

  await step('create a cursor (ACP) workflow', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'cursor phase-1',
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
    const cfg = (m as AnyMessage & { config?: { primaryProvider?: string } }).config;
    assert(cfg?.primaryProvider === 'cursor', 'workflow_created config carries primaryProvider:cursor');
  });

  await step('one prompt round-trips: primary_text stream + primary_complete', async () => {
    c.send({
      type: 'user_message',
      workflowId: wfid,
      content: 'Reply with exactly the single word: PONG. Nothing else.',
    });

    const done = await c.waitFor(
      (x) => x.type === 'primary_complete' && (x as { workflowId?: string }).workflowId === wfid,
      TURN_TIMEOUT_MS,
      'primary_complete',
    );
    assert(typeof (done as { durationMs?: number }).durationMs === 'number', 'primary_complete carries durationMs');
    // Surface any error/notice that landed, to make failures diagnosable.
    const notices = c
      .peekMessages()
      .filter((m) => (m.type === 'primary_error' || m.type === 'worker_error' || m.type === 'system_notice') && (m as { workflowId?: string }).workflowId === wfid)
      .map((m) => JSON.stringify(m).slice(0, 200));
    if (notices.length) console.log('        notices:', notices.join(' | '));

    const answer = c
      .peekMessages()
      .filter((m) => m.type === 'primary_text' && (m as { workflowId?: string }).workflowId === wfid)
      .map((m) => (m as { text?: string }).text ?? '')
      .join('');
    assert(answer.length > 0, `primary_text streamed some assistant output (got ${answer.length} chars)`);
    assert(/pong/i.test(answer), `assistant said PONG (got: ${JSON.stringify(answer.slice(0, 120))})`);
  });

  await c.close();
  summary('cursor-phase-1');
}

main().catch((err) => {
  console.error('cursor-phase-1 crashed:', err);
  process.exit(1);
});
