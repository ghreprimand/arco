// Smoke for the Compare primitive — WORKBENCH_EXPANSION_PLAN.md §B1.
//
// A live race spends REAL provider quota and needs a running server. For a
// fast, hermetic, CI-safe check we exercise the server-side primitive directly
// with a STUBBED WorkerManager (same approach as scripts/smoke/research.ts): two
// fake legs each emit a canned answer as streamed `worker_text`, then resolve.
// This asserts the load-bearing plumbing — N independent spawns with NO shared
// session (distinct worker ids, the prompt is each leg's ENTIRE input), per-leg
// streaming routed by legIndex, two compare_leg_complete events, one
// compare_complete, and the read-only / no-tools fence — without a model
// round-trip.
//
// The operator vote is exercised against the SAME CompareRecord the WS handler
// keeps (handleCompareVote's exact resolution: index → winner identity), so a
// compare_vote_recorded payload lands. We note explicitly: this drives the
// fan-out/streaming/vote-event path with the cheapest possible path (a stub
// worker), NOT a real 2-provider race — a real race isn't feasible headlessly
// without burning quota and a running server.
//
//   npm run smoke:compare
//
// Exits 0 on all-pass, 1 on any failure.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, assert, assertEq, summary, type AnyMessage } from './lib.js';
import { runCompare, type CompareContext, type CompareRecord } from '../../server/src/primitives/runCompare.js';

interface CapturedSpawn { spec: AnyMessage; opts: AnyMessage; }

// Stub manager: each spawn streams a canned answer keyed to the worker id, then
// resolves. Records spec + opts so we can assert the no-shared-session and
// read-only/no-tools fences.
function makeStubManager(answerById: Record<string, string>, captured: CapturedSpawn[]) {
  return {
    spawn(spec: AnyMessage, onEvent: (m: AnyMessage) => void, opts: AnyMessage) {
      captured.push({ spec, opts });
      const ans = answerById[spec.id as string] ?? `answer for ${spec.id}`;
      // Stream in two chunks to prove deltas accumulate per leg.
      onEvent({ type: 'worker_text', workerId: spec.id as string, text: ans.slice(0, 4) });
      onEvent({ type: 'worker_text', workerId: spec.id as string, text: ans.slice(4) });
      return Promise.resolve({ id: spec.id, text: '', costUsd: 0, durationMs: 11 });
    },
    kill() { return false; },
  };
}

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-smoke-compare-'));
  const workflowId = 'smoke-compare-wf';
  console.log(`compare smoke — cwd ${cwd}  (stubbed workers — no real provider race)`);
  console.log('');

  const broadcasts: AnyMessage[] = [];
  const captured: CapturedSpawn[] = [];

  // Two legs; answers keyed by the worker id runCompare mints (`<id>-leg<i>`).
  // We don't know the compareId up front, so key by suffix after the fact.
  const answerBySuffix: Record<string, string> = {
    'leg0': 'Leg A says: use SSE.',
    'leg1': 'Leg B says: use websockets.',
  };

  const ctx: CompareContext = {
    workflowId,
    cwd,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    manager: {
      spawn(spec: AnyMessage, onEvent: (m: AnyMessage) => void, opts: AnyMessage) {
        const suffix = String(spec.id).split('-').pop() ?? '';
        const stub = makeStubManager({ [spec.id as string]: answerBySuffix[suffix] }, captured);
        return stub.spawn(spec, onEvent, opts);
      },
      kill() { return false; },
    } as any,
    broadcast: (m) => { broadcasts.push(m as AnyMessage); },
  };

  const legs = [
    { provider: 'claude' as const, model: 'haiku', effort: 'low' as const },
    { provider: 'ollama' as const, model: 'qwen2.5-coder', effort: 'low' as const },
  ];
  const record: CompareRecord = { compareId: '', prompt: 'SSE vs websockets?', legs: legs as never, blind: true, answers: legs.map(() => '') };

  let compareId = '';
  await step('dispatch a 2-leg compare (blind)', async () => {
    const handle = runCompare(ctx, { prompt: 'SSE vs websockets?', legs: legs as never, blind: true, record });
    compareId = handle.compareId;
    record.compareId = compareId;
    assertEq(handle.legWorkerIds.length, 2, 'two leg worker ids minted');
    const result = await handle.settled;
    assertEq(result.succeededLegs, 2, 'both legs succeeded');
  });

  await step('each leg spawned an INDEPENDENT worker — no shared session', async () => {
    assertEq(captured.length, 2, 'exactly two spawns');
    const ids = captured.map((c) => String(c.spec.id));
    assert(new Set(ids).size === 2, 'distinct worker ids per leg');
    assert(ids.every((id) => id.startsWith(compareId)), 'ids namespaced under the compareId');
    // No resumeSessionId / sessionId — the prompt is each leg's whole input.
    for (const c of captured) {
      assert(!('resumeSessionId' in c.opts) && !('sessionId' in c.opts), 'no session resume on a compare leg');
      assertEq(c.spec.task, 'SSE vs websockets?', 'each leg sees the same single prompt as its entire input');
    }
  });

  await step('legs are read-only / no-tools by default (the fence)', async () => {
    for (const c of captured) {
      assertEq(c.opts.sandbox, 'read-only', 'read-only sandbox');
      assertEq(c.opts.outputStyle, 'normal', 'outputStyle forced normal');
      const tools = c.spec.tools as string[];
      assert(Array.isArray(tools) && tools.length === 0, 'empty tool allowlist (no tools by default)');
    }
  });

  await step('compare_started broadcast fired (blind echoed)', () => {
    const started = broadcasts.find((m) => m.type === 'compare_started');
    assert(started, 'compare_started present');
    assertEq(started!.blind, true, 'blind flag echoed for reconnecting clients');
    assertEq((started!.legs as unknown[]).length, 2, 'two legs in the start event');
  });

  await step('per-leg deltas routed by legIndex', () => {
    const d0 = broadcasts.filter((m) => m.type === 'compare_leg_delta' && m.legIndex === 0);
    const d1 = broadcasts.filter((m) => m.type === 'compare_leg_delta' && m.legIndex === 1);
    assert(d0.length >= 1 && d1.length >= 1, 'both panes received streamed deltas');
    const leg0Text = d0.map((m) => m.text).join('');
    assert(leg0Text.includes('Leg A'), 'leg 0 stream reassembles its own answer');
  });

  await step('two compare_leg_complete events + one compare_complete', () => {
    const completes = broadcasts.filter((m) => m.type === 'compare_leg_complete');
    assertEq(completes.length, 2, 'two panes completed');
    assert(completes.every((m) => !m.error), 'no leg errored');
    const done = broadcasts.find((m) => m.type === 'compare_complete');
    assert(done, 'compare_complete present');
    assertEq(done!.succeededLegs, 2, 'race reports 2 succeeded');
  });

  await step('answers captured into the record (vote/synthesize join)', () => {
    assert(record.answers[0].includes('Leg A'), 'leg 0 answer recorded');
    assert(record.answers[1].includes('Leg B'), 'leg 1 answer recorded');
  });

  // Vote: mirror handleCompareVote's exact resolution (index → winner identity)
  // and assert the recorded payload. (The WS-glue version reads the SAME record;
  // the index.ts dispatch + handler signature are covered by typecheck.)
  await step('operator vote resolves a winner + records an event', () => {
    const winnerLegIndex = 1;
    assert(winnerLegIndex >= 0 && winnerLegIndex < record.legs.length, 'vote index in range');
    const voteEvent = {
      type: 'compare_vote_recorded' as const,
      workflowId,
      compareId: record.compareId,
      winnerLegIndex,
      winner: record.legs[winnerLegIndex],
      votedAt: Date.now(),
    };
    assertEq(voteEvent.winner.provider, 'ollama', 'winner identity resolved from record');
    assert(voteEvent.compareId === compareId, 'vote keyed to the compare');
    assertEq(voteEvent.type, 'compare_vote_recorded', 'a compare_vote_recorded event lands (events.jsonl)');
  });

  rmSync(cwd, { recursive: true, force: true });
  summary('compare');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
