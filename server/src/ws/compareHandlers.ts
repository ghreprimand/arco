// WORKBENCH_EXPANSION_PLAN.md §B1 — Compare primitive WS handlers.
//
// Extracted from workflowHandlers.ts to keep that file under the 2000-line cap.
// Owns the request → fan-out, the operator vote, the operator-chosen synthesize
// follow-up, and cancel. The bounded-job fan-out itself lives in
// server/src/primitives/runCompare.ts (modeled on runReviewer/runResearch).

import { WebSocket } from 'ws';
import { COMPARE_MIN_LEGS, COMPARE_MAX_LEGS } from '@archon/shared';
import { send } from '../server/broadcast.js';
import { workflows } from '../server/state.js';
import { resolveProviderAccount } from '../providerAccounts.js';
import { runCompare, type CompareRecord } from '../primitives/runCompare.js';
import type { Session } from '../workflows/types.js';

// Active races, keyed by compareId. Kept alive after the race settles so the
// operator vote can resolve the winning leg's identity and the optional
// synthesize follow-up can seed one more bounded leg with every answer. The
// durable audit trail is events.jsonl (the compare_* broadcasts); this map is
// just the in-memory join. A server restart mid-race drops it (vote/synthesize
// then fail loud — same posture as cancel_research's "no live worker" path).
const activeCompares = new Map<string, CompareRecord>();

// Fan ONE prompt out to N read-only legs. Resolves each leg's config like the
// reviewer/research paths (Codex legs get their account routed), clamps the leg
// count, and hands off to runCompare. Returns immediately; per-leg streaming +
// completion arrive via compare_* events.
export async function handleCompareRequest(
  ws: WebSocket,
  session: Session,
  msg: import('@archon/shared').CompareRequestMessage,
): Promise<void> {
  void session;
  const wf = workflows.get(msg.workflowId);
  if (!wf) {
    send(ws, { type: 'error', message: `Unknown workflow ${msg.workflowId.slice(0, 8)}` });
    return;
  }
  const cwd = wf.config.workingDirectory;
  if (!cwd) {
    send(ws, { type: 'error', message: 'Workflow has no working directory configured.' });
    return;
  }
  if (!msg.prompt?.trim()) {
    send(ws, { type: 'error', message: 'Compare prompt is empty.' });
    return;
  }
  // Clamp the leg count to [MIN, MAX]. Fewer than MIN is not a race; more than
  // MAX bloats the fan-out and the grid.
  const legs = (msg.legs ?? []).slice(0, COMPARE_MAX_LEGS);
  if (legs.length < COMPARE_MIN_LEGS) {
    send(ws, { type: 'error', message: `Compare needs at least ${COMPARE_MIN_LEGS} legs.` });
    return;
  }

  // Resolve Codex accounts positionally so each Codex leg routes to the right
  // home (mirrors the reviewer/research single-leg resolution, per leg).
  const codexHomes: Array<string | undefined> = [];
  const resolvedLegs = await Promise.all(legs.map(async (leg) => {
    if (leg.provider !== 'codex') { codexHomes.push(undefined); return leg; }
    const acct = await resolveProviderAccount('codex', leg.providerAccountRef ?? wf.config.providerAccountRef, cwd).catch(() => null);
    codexHomes.push(acct?.codexHome);
    return acct ? { ...leg, providerAccountRef: acct.profile.id } : leg;
  }));

  const record: CompareRecord = {
    compareId: '',
    prompt: msg.prompt,
    legs: resolvedLegs,
    blind: Boolean(msg.blind),
    answers: resolvedLegs.map(() => ''),
  };

  const handle = runCompare(
    { workflowId: msg.workflowId, cwd, manager: wf.manager, broadcast: (m) => send(ws, m) },
    { prompt: msg.prompt, legs: resolvedLegs, blind: Boolean(msg.blind), codexHomes, record },
  );
  record.compareId = handle.compareId;
  activeCompares.set(handle.compareId, record);

  console.log(`[archon] [${msg.workflowId.slice(0, 8)}] compare ${handle.compareId} started (${resolvedLegs.length} legs${msg.blind ? ', blind' : ''})`);
  handle.settled.then((r) => {
    console.log(`[archon] [${msg.workflowId.slice(0, 8)}] compare ${handle.compareId} settled (${r.succeededLegs}/${resolvedLegs.length} legs succeeded)`);
  }).catch((err) => {
    console.error(`[archon] compare ${handle.compareId} settle error:`, err);
  });
}

// Record the operator's winner pick. Operator action only — nothing auto-votes,
// no LLM judges. The broadcast lands in events.jsonl (the audit + replay trail)
// and carries the winner's identity so a blind-mode client can reveal it.
export function handleCompareVote(
  ws: WebSocket,
  msg: import('@archon/shared').CompareVoteMessage,
): void {
  const rec = activeCompares.get(msg.compareId);
  if (!rec) {
    send(ws, { type: 'error', message: `Unknown compare ${msg.compareId.slice(0, 12)} (likely server restart).` });
    return;
  }
  if (msg.winnerLegIndex < 0 || msg.winnerLegIndex >= rec.legs.length) {
    send(ws, { type: 'error', message: 'Vote references an out-of-range leg.' });
    return;
  }
  send(ws, {
    type: 'compare_vote_recorded',
    workflowId: msg.workflowId,
    compareId: msg.compareId,
    winnerLegIndex: msg.winnerLegIndex,
    winner: rec.legs[msg.winnerLegIndex],
    votedAt: Date.now(),
  });
  console.log(`[archon] [${msg.workflowId.slice(0, 8)}] compare ${msg.compareId} vote: leg ${msg.winnerLegIndex} (${rec.legs[msg.winnerLegIndex].provider}:${rec.legs[msg.winnerLegIndex].model})`);
}

// Operator-chosen synthesize follow-up: ONE more bounded read-only leg, run by
// the operator-named synthesizer agent, seeded with every leg's answer and
// asked to graft the best of the others onto a combined response. Streams into
// a fresh "synthesis" pane (legIndex == legs.length). NOT an automatic verdict —
// only fires when the operator clicks SYNTHESIZE.
export async function handleCompareSynthesize(
  ws: WebSocket,
  msg: import('@archon/shared').CompareSynthesizeMessage,
): Promise<void> {
  const wf = workflows.get(msg.workflowId);
  const rec = activeCompares.get(msg.compareId);
  if (!wf || !rec) {
    send(ws, { type: 'error', message: `Unknown compare ${msg.compareId.slice(0, 12)} (likely server restart).` });
    return;
  }
  const cwd = wf.config.workingDirectory;
  if (!cwd) {
    send(ws, { type: 'error', message: 'Workflow has no working directory configured.' });
    return;
  }
  const idx = msg.synthesizerLegIndex;
  if (idx < 0 || idx >= rec.legs.length) {
    send(ws, { type: 'error', message: 'Synthesize references an out-of-range leg.' });
    return;
  }
  const synthLeg = rec.legs[idx];
  // Seed the synthesizer with the prompt + every (non-empty) answer, labeled by
  // their position. No cross-leg session — this is a fresh bounded leg whose
  // ENTIRE input is this assembled brief.
  const answersBlock = rec.answers
    .map((a, i) => a.trim() ? `### Answer ${String.fromCharCode(65 + i)}\n\n${a.trim()}` : null)
    .filter(Boolean)
    .join('\n\n');
  const synthPrompt = `You are synthesizing the single best response to a prompt from several independent answers below. Read them all, keep what each got right, drop what's wrong or redundant, and write ONE improved, self-contained answer. Do not mention that you are merging answers — just produce the best response.\n\n--- ORIGINAL PROMPT ---\n\n${rec.prompt}\n\n--- CANDIDATE ANSWERS ---\n\n${answersBlock}`;

  const codexHome = synthLeg.provider === 'codex'
    ? (await resolveProviderAccount('codex', synthLeg.providerAccountRef ?? wf.config.providerAccountRef, cwd).catch(() => null))?.codexHome
    : undefined;

  // Spawn directly (not via runCompare) so we can stamp the synthesis pane index
  // and reuse the SAME compareId for the events. Mirrors runCompare's leg spawn:
  // read-only, no tools, no shared session.
  const synthLegIndex = rec.legs.length; // panes 0..n-1 are originals; n is synthesis
  const legId = `${msg.compareId}-synth`;
  let collected = '';
  const legStartedAt = Date.now();
  send(ws, {
    type: 'compare_leg_delta', workflowId: msg.workflowId, compareId: msg.compareId,
    legIndex: synthLegIndex, text: '',
  });
  wf.manager.spawn(
    { id: legId, task: synthPrompt, model: synthLeg.model, effort: synthLeg.effort, provider: synthLeg.provider, tools: [] },
    (ev) => {
      if (ev.type === 'worker_text') {
        collected += ev.text;
        send(ws, { type: 'compare_leg_delta', workflowId: msg.workflowId, compareId: msg.compareId, legIndex: synthLegIndex, text: ev.text });
      } else if (ev.type === 'worker_system_notice') {
        send(ws, { type: 'system_notice', workflowId: msg.workflowId, content: ev.notice });
      }
    },
    {
      cwd, workflowId: msg.workflowId,
      skipPermissions: synthLeg.provider === 'ollama',
      sandbox: 'read-only', outputStyle: 'normal',
      ...(synthLeg.provider === 'codex' && codexHome ? { providerAccountRef: synthLeg.providerAccountRef, codexHome } : {}),
    },
  ).then((r) => {
    send(ws, {
      type: 'compare_leg_complete', workflowId: msg.workflowId, compareId: msg.compareId,
      legIndex: synthLegIndex, text: (collected.trim() || r.text || '').trim(),
      durationMs: Date.now() - legStartedAt, ...(r.error ? { error: r.error } : {}), completedAt: Date.now(),
    });
  }).catch((err) => {
    send(ws, {
      type: 'compare_leg_complete', workflowId: msg.workflowId, compareId: msg.compareId,
      legIndex: synthLegIndex, text: collected.trim(), durationMs: Date.now() - legStartedAt,
      error: err instanceof Error ? err.message : String(err), completedAt: Date.now(),
    });
  });
  console.log(`[archon] [${msg.workflowId.slice(0, 8)}] compare ${msg.compareId} synthesize via leg ${idx} (${synthLeg.provider}:${synthLeg.model})`);
}

// Cancel an in-flight race — kill every leg worker for this compare. Mirrors
// handleCancelResearch's kill path; the leg .then() emits compare_leg_complete
// with the kill's error so panes don't hang.
export function handleCancelCompare(ws: WebSocket, workflowId: string, compareId: string): void {
  const wf = workflows.get(workflowId);
  const rec = activeCompares.get(compareId);
  if (!wf || !rec) return;
  for (let i = 0; i < rec.legs.length; i++) wf.manager.kill(`${compareId}-leg${i}`);
  wf.manager.kill(`${compareId}-synth`);
  console.log(`[archon] [${workflowId.slice(0, 8)}] compare ${compareId} cancel requested`);
}
