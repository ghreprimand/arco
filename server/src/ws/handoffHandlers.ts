import { pendingOperatorQuestions } from '../providers/codex-appserver/operatorQuestions.js';
import { computerContextState, isComputer } from '../voice/computerContext.js';
// server/src/ws/handoffHandlers.ts — handoff / spawn / rehydrate WS handler
// region extracted from index.ts (docs/ARCHITECTURE.md).
// Behavior-preserving, move-only. The four index.ts-local back-edges (the
// PreviewAutoDetect instance, handleCreateWorkflow which lives in the workflow
// handler module, plus handlePlanAttach + assertAllMembersClaudeOrCodex which
// stay in index.ts) are injected once at startup via initHandoffHandlers to
// avoid a cycle with the entry point and with workflowHandlers.
import type {
  ServerMessage,
  WorkflowConfig,
} from '@arco/shared';
import { zaiModelContextWindow } from '@arco/shared';
import { WebSocket } from 'ws';
import * as clusterPlanBridge from '../clusterPlanBridge.js';
import * as clusterStore from '../clusterStore.js';
import * as clusterEfficiency from '../clusterEfficiency.js';
import { buildProgressDoctrine } from '../clusterProgress.js';
import { buildClusterDirectorDoctrine, joinClusterDoctrines } from '../clusterDirector.js';
import { composeClusterAppend, APPEND_CLUSTER_MAX } from '../clusterStringFold.js';
import { planOutline } from '../clusterPlanOutline.js';
import { codexCodeModeClusterAddendum, codexModelUsesCodeMode } from '../providers/codexCodeMode.js';
import { estimateContextFill, promptContextEstimate } from '../contextEstimator.js';
import { rememberCwd } from '../crashRecovery.js';
import { assessGenesisReadiness } from '../genesis/stages.js';
import { nextFieldPrompt } from '../genesis/prompts.js';
import {
  readPlanSummary,
  recordAttachment,
} from '../planStore.js';
import type { PreviewAutoDetect } from '../previewAutoDetect.js';
import { runExportContext } from '../primitives/exportContext.js';
import { runPrimaryTurn } from '../primitives/seedWorker.js';
import { resolveProviderAccount } from '../providerAccounts.js';
import { catalogDriftProbe } from './clusterHandlers.js';
import { checkModelDrift, driftFlag } from '../primitiveDrift.js';
import { disposeClaudeNativeWorker } from '../providers/claude-native/index.js';
import { disposeProviderResources } from '../providers/index.js';
import { INCOGNITO_CHAT_PROVIDERS, incognitoChatCwd, isChatWorkflow } from '../chatMode.js';
import { registerPrivateLogToken } from '../server/logger.js';
import {
  acquirePlansWatcher,
  broadcastCluster,
  broadcastHandoffLockSnapshot,
  broadcastTransient,
  broadcastWorkflow,
  buildClusterStatePayload,
  send,
} from '../server/broadcast.js';
import {
  buildLocalClusterSystemPrompt,
  LLAMACPP_PRIMARY_SYSTEM_PROMPT,
  OLLAMA_PRIMARY_SYSTEM_PROMPT,
  withPreviewNudge,
} from '../server/prompts.js';
import {
  cwdHandoffChain,
  workflowCwds,
  workflows,
} from '../server/state.js';
import {
  acquireProjectSettingsWatcher,
  readSettings,
} from '../settings.js';
import {
  appendHistoryEntry,
  readMeta,
  workflowConfigFromMeta,
  reconcileLatestCliSession,
  writeMeta,
} from '../workflowMeta.js';
import {
  getHeadSeq as getWorkflowHeadSeq,
  initWorkflowStore,
  readFirstSeq as readWorkflowFirstSeq,
  replayEvents as replayWorkflowEvents,
  replayTailEvents,
  scanEventsOfTypes,
} from '../workflowStore.js';
import { ptyManager } from '../terminal/ptyManager.js';
import { sendTaskLedgerSnapshot } from './taskLedgerHandlers.js';
import { rehydrateGatesOnce } from './gateHandlers.js';
import { latestCodexTokenSnapshot } from '../workflows/transcripts.js';
import type {
  CwdHandoffSlot,
  Session,
  WorkflowState,
} from '../workflows/types.js';
import { WorkerManager } from '../workers/WorkerManager.js';
import {
  applyAutoHandoffDefault,
  broadcastSessionMetadata,
  deriveAutoHandoff,
  derivePrimaryConfig,
  claimBusy,
  drainQueueIfIdle,
  persistInitialMeta,
  releaseBusy,
  sessionMetadataForWorkflow,
  startSessionWatcher,
} from './turnEngine.js';

export interface HandoffHandlerDeps {
  previewAutoDetect: PreviewAutoDetect;
  handleCreateWorkflow: (ws: WebSocket, session: Session, config: WorkflowConfig) => Promise<void>;
  handlePlanAttach: (workflowId: string, planId: string) => Promise<void>;
  assertAllMembersClaudeOrCodex: (memberIds: string[]) => Promise<string | null>;
}
let deps: HandoffHandlerDeps;
export function initHandoffHandlers(d: HandoffHandlerDeps): void { deps = d; }

export async function handleHandoffRequest(
  ws: WebSocket,
  session: Session,
  msg: import('@arco/shared').HandoffRequestMessage,
): Promise<void> {
  const wf = workflows.get(msg.workflowId);
  if (!wf) {
    send(ws, { type: 'error', message: `Unknown workflow ${msg.workflowId.slice(0, 8)}` });
    return;
  }
  // Chat tabs are projectless: the reflection/summarizer runs as an Agent
  // worker with project tools against the ~/.arco/chats persistence cwd.
  if (isChatWorkflow(wf.config)) {
    send(ws, { type: 'error', message: 'Handoff is not available in Chat tabs.' });
    return;
  }
  if (wf.busy) {
    send(ws, { type: 'error', message: 'Primary agent is busy — cancel or wait before rotating.' });
    return;
  }
  const cwd = wf.config.workingDirectory;
  if (!cwd) {
    send(ws, { type: 'error', message: 'Workflow has no working directory configured.' });
    return;
  }

  // 2026-05-12 — per-cwd handoff serialization. If another handoff is in
  // flight for this same cwd (typical when cluster members share a repo),
  // wait for it to complete before reading git/DEVLOG state. Otherwise the
  // two reflection turns observe each other's mid-flight writes and produce
  // ordered-but-stale DEVLOG entries. The wait is bounded by the prior
  // handoff's own settle (success or failure both resolve the chain).
  while (true) {
    const priorHandoff = cwdHandoffChain.get(cwd);
    if (!priorHandoff) break;
    const ageSec = Math.max(0, Math.floor((Date.now() - priorHandoff.startedAt) / 1000));
    const holder = priorHandoff.handoffId
      ? `${priorHandoff.workflowId.slice(0, 8)} / ${priorHandoff.handoffId}`
      : `${priorHandoff.workflowId.slice(0, 8)} / preparing`;
    if (priorHandoff.workflowId === msg.workflowId) {
      send(ws, {
        type: 'system_notice',
        workflowId: msg.workflowId,
        content: `[HANDOFF] This workflow already has a handoff ${priorHandoff.handoffId ? 'running' : 'preparing'} (${holder}, ${ageSec}s). Ignoring the duplicate request.`,
      });
      return;
    }
    send(ws, {
      type: 'system_notice',
      workflowId: msg.workflowId,
      content: `[HANDOFF QUEUED] Another handoff is already running in this cwd (${holder}, ${ageSec}s). Waiting for it to complete before reading repo state.`,
    });
    try { await priorHandoff.promise; } catch { /* prior's failure shouldn't block us */ }
    // Re-check post-wait: the workflow could have been removed, or some
    // other path could have flipped wf.busy (operator started a turn, etc.).
    if (!workflows.has(msg.workflowId)) {
      send(ws, { type: 'error', message: `Workflow ${msg.workflowId.slice(0, 8)} no longer exists.` });
      return;
    }
    if (wf.busy) {
      send(ws, { type: 'error', message: 'Primary became busy while waiting in the handoff queue — cancel or wait, then retry.' });
      return;
    }
  }
  // Claim busy BEFORE the first await below. It used to be set only after
  // the replay / settings / account / drift-probe awaits, so an operator turn
  // (or auto-handoff) could start in that window and the handoff's later
  // busy=false cleared the live turn's flag. Released in the finally —
  // token-scoped, so a STOP (revokeBusy) + quick resend isn't clobbered by
  // this handoff's late unwind.
  const busyToken = claimBusy(wf);
  let busyReleasedByUs = false;
  const releaseHandoffBusy = () => {
    if (releaseBusy(wf, busyToken)) busyReleasedByUs = true;
  };

  // Install our slot on the chain so the next handoff in this cwd waits
  // for us. resolveMine fires from the finally block at the end of this
  // function regardless of which return path the body takes.
  let resolveMyHandoff!: () => void;
  const myHandoffSlot = new Promise<void>((r) => { resolveMyHandoff = r; });
  const myHandoffSlotRecord: CwdHandoffSlot = {
    promise: myHandoffSlot,
    resolve: resolveMyHandoff,
    workflowId: msg.workflowId,
    startedAt: Date.now(),
  };
  cwdHandoffChain.set(cwd, myHandoffSlotRecord);
  broadcastHandoffLockSnapshot(cwd);
  const releaseHandoffSlot = () => {
    resolveMyHandoff();
    if (cwdHandoffChain.get(cwd) === myHandoffSlotRecord) cwdHandoffChain.delete(cwd);
    broadcastHandoffLockSnapshot(cwd);
  };
  // Set once runExportContext returns; used in finally to clear wf.activeHandoff
  // only if it's still ours (handoffs per cwd are serialized via the chain).
  let myHandoffId: string | undefined;

  try {

  const transcript = await replayWorkflowEvents(cwd, msg.workflowId, 0);
  if (myHandoffSlotRecord.cancelled) {
    send(ws, { type: 'system_notice', workflowId: msg.workflowId, content: '[HANDOFF CLEARED] Handoff was cleared before it started.' });
    return;
  }
  if (transcript.length === 0) {
    send(ws, { type: 'error', message: 'Nothing to hand off yet — chat with the primary agent first.' });
    return;
  }

  // WP2 — fresh-summarizer resolution chain. A handoff fires precisely when the
  // current worker is low on context; letting that degraded worker summarize
  // itself is the exact failure mode we want to dodge. So when no per-request
  // override is supplied, fall back to the operator's configured strong
  // summarizer (settings.handoffSummarizer) before finally defaulting to the
  // tab's own primary. This covers BOTH manual handoffs (operator left the
  // dialog picker at default → no msg.summarizer) and auto-handoff (which never
  // sends msg.summarizer). settings.handoffSummarizer's model/effort are
  // optional — fill them from the tab's primary so a provider-only pin still
  // resolves to a concrete config.
  const summarizerSettings = await readSettings(cwd).catch(() => null);
  const summarizer = msg.summarizer ?? (summarizerSettings?.handoffSummarizer
    ? {
        provider: summarizerSettings.handoffSummarizer.provider,
        model: summarizerSettings.handoffSummarizer.model ?? wf.primary.model,
        effort: summarizerSettings.handoffSummarizer.effort ?? wf.primary.effort,
      }
    : {
        provider: wf.primary.provider,
        model: wf.primary.model,
        effort: wf.primary.effort,
      });
  const currentCodexAccount = wf.primary.provider === 'codex'
    ? await resolveProviderAccount('codex', wf.config.providerAccountRef, cwd).catch(() => null)
    : null;
  if (currentCodexAccount?.profile.id && wf.config.providerAccountRef !== currentCodexAccount.profile.id) {
    wf.config.providerAccountRef = currentCodexAccount.profile.id;
  }
  const effectiveSummarizer = summarizer.provider === 'codex' && currentCodexAccount
    ? { ...summarizer, providerAccountRef: currentCodexAccount.profile.id, codexHome: currentCodexAccount.codexHome }
    : summarizer;

  // §5.1 — drift guard. The summarizer model often defaults to the tab's LIVE
  // primary, which the operator can swap mid-dialog; re-resolve it against the
  // live catalog at dispatch and flag (don't block) if it drifted out.
  const handoffDrift = await checkModelDrift(effectiveSummarizer.provider, effectiveSummarizer.model, catalogDriftProbe);
  if (handoffDrift.drifted) {
    broadcastWorkflow(msg.workflowId, {
      type: 'system_notice',
      workflowId: msg.workflowId,
      content: driftFlag('handoff', effectiveSummarizer.provider, effectiveSummarizer.model, handoffDrift.reason ?? 'model drifted'),
    });
  }

  // Busy was claimed above (before the first await) for the duration of the
  // rotation so operator turns don't interleave with the summarizer +
  // pre-warm. The finally unsticks it on every return / throw path.

  // Phase 7b — resolve Claude transport to pick the right original-worker
  // path. Native parents resume by replaying events.jsonl into messages[]
  // (no CLI rollout exists), so they don't need wf.primarySessionId set.
  // Cascade lookup mirrors handleUserMessage's resolver.
  let claudeTransport: 'cli' | 'native' = 'cli';
  if (wf.primary.provider === 'claude') {
    const tab = wf.config.claudeTransport;
    if (tab === 'native' || tab === 'cli') {
      claudeTransport = tab;
    } else {
      const cascade = await readSettings(cwd).catch(() => null);
      claudeTransport = cascade?.claude?.transport === 'native' ? 'native' : 'cli';
    }
  }

  // For 'original-worker' mode the reflection turn runs on the workflow's
  // current primary session via --resume (CLI) or via in-memory messages
  // replay (Native); we pass that context through. For 'fresh-summarizer'
  // this is ignored. Native parents qualify even without primarySessionId.
  const nativeOriginalEligible = wf.primary.provider === 'claude' && claudeTransport === 'native';
  const originalPrimary = (wf.primarySessionId || nativeOriginalEligible)
    ? {
        primary: wf.primary,
        sessionId: wf.primarySessionId ?? '',
        cwd,
        ...(currentCodexAccount ? { providerAccountRef: currentCodexAccount.profile.id, codexHome: currentCodexAccount.codexHome } : {}),
        ...(wf.primary.provider === 'claude' ? { transport: claudeTransport } : {}),
      }
    : undefined;

  // WP6 — uniform original/fresh choice across providers. Only Claude/Codex/Z.ai
  // have a live session to resume; everything else (Ollama/llama.cpp/LM Studio/
  // Gemini/Antigravity) has no rollout to --resume into. Rather than blocking
  // ORIGINAL for those, we *translate* it: "original worker" on a local model
  // means "the SAME model re-reads its own transcript" — i.e. the fresh-
  // summarizer mechanism, but pinned to the tab's own primary instead of the
  // configured fresh summarizer. This keeps the operator's mental model
  // ("original = the worker that did the work writes the summary") intact even
  // where there's no session to revive.
  const resumable = wf.primary.provider === 'claude' || wf.primary.provider === 'codex' || wf.primary.provider === 'zai';
  let effectiveMode = msg.mode;
  let translatedSummarizer = effectiveSummarizer;
  if (effectiveMode === 'original-worker' && !resumable) {
    // Overflow heuristic: the summarizer must re-read roughly the whole
    // conversation. If live context is already near full, a same-sized local
    // model can't fit the transcript back into its own window. lastContextPercent
    // is the cheapest existing signal; default to "fits" when we have none.
    const tooBig = typeof wf.lastContextPercent === 'number'
      && wf.lastContextPercent >= (wf.autoHandoff?.autoAt ?? 90);
    if (!tooBig) {
      // Fits: same local model summarizes itself.
      effectiveMode = 'fresh-summarizer';
      translatedSummarizer = { provider: wf.primary.provider, model: wf.primary.model, effort: wf.primary.effort };
      send(ws, {
        type: 'system_notice',
        workflowId: msg.workflowId,
        content: `Original-worker on a local model = the same model (${wf.primary.model}) re-reads its transcript (no live session to resume).`,
      });
    } else {
      // Too big for the local model: fall back to the configured fresh
      // summarizer if one exists; otherwise best-effort with the local model.
      const configured = msg.summarizer ?? (summarizerSettings?.handoffSummarizer
        ? {
            provider: summarizerSettings.handoffSummarizer.provider,
            model: summarizerSettings.handoffSummarizer.model ?? wf.primary.model,
            effort: summarizerSettings.handoffSummarizer.effort ?? wf.primary.effort,
          }
        : null);
      effectiveMode = 'fresh-summarizer';
      if (configured) {
        translatedSummarizer = configured;
        send(ws, {
          type: 'system_notice',
          workflowId: msg.workflowId,
          content: `Transcript too large for ${wf.primary.model} to summarize itself — using fresh summarizer ${configured.model} instead.`,
        });
      } else {
        translatedSummarizer = { provider: wf.primary.provider, model: wf.primary.model, effort: wf.primary.effort };
        send(ws, {
          type: 'system_notice',
          workflowId: msg.workflowId,
          content: `Transcript may exceed ${wf.primary.model}'s window and no fresh summarizer is configured — attempting with the local model; configure a Default Summarizer (Settings) for reliability.`,
        });
      }
    }
  }

  // Safety net for the still-no-session cases that didn't hit the WP6 translation
  // above (resumable providers that haven't taken a turn yet, or a provider with
  // no original-worker reflection path). Quietly degrade to fresh-summarizer
  // rather than erroring out on exportContext's error path. exportContext only
  // implements original-worker for Claude (cli + native), Codex, and Z.ai.
  const originalWorkerEligible = wf.primary.provider === 'claude' || wf.primary.provider === 'codex' || wf.primary.provider === 'zai';
  if (effectiveMode === 'original-worker' && (!originalPrimary || !originalWorkerEligible)) {
    const why = !originalWorkerEligible ? `provider ${wf.primary.provider} has no original-worker path` : 'no resumable session';
    console.log(`[arco] [${msg.workflowId.slice(0, 8)}] handoff: ${why}, falling back to fresh-summarizer`);
    effectiveMode = 'fresh-summarizer';
  }

  const handle = runExportContext(
    {
      workflowId: msg.workflowId,
      cwd,
      manager: wf.manager,
      broadcast: (m) => send(ws, m),
    },
    {
      mode: effectiveMode,
      // docs/GOTCHAS.md - inherit the source tab's north-star into the
      // handoff seed (both modes) so the reflection/summary carries the standing
      // objective. Preserve the undefined semantics when no context is passed.
      summarizer: translatedSummarizer && wf.config.goal
        ? { ...translatedSummarizer, goal: wf.config.goal }
        : translatedSummarizer,
      transcript,
      original: originalPrimary && wf.config.goal
        ? { ...originalPrimary, goal: wf.config.goal }
        : originalPrimary,
    },
  );

  // Expose the handle so handoff_cancel can abort the reflection/summarizer
  // worker. Killing it makes handle.settled resolve with an error, which falls
  // through the normal cleanup below (busy=false + slot release).
  wf.activeHandoff = { handoffId: handle.handoffId, artifactName: handle.artifactName, abort: handle.abort };
  myHandoffId = handle.handoffId;
  myHandoffSlotRecord.handoffId = handle.handoffId;
  broadcastHandoffLockSnapshot(cwd);

  console.log(`[arco] [${msg.workflowId.slice(0, 8)}] handoff ${handle.handoffId} started (mode=${effectiveMode}${effectiveMode === 'fresh-summarizer' ? `, summarizer=${translatedSummarizer.provider}:${translatedSummarizer.model}` : `, original=${wf.primary.provider}:${wf.primary.model}`})`);

  let handoffBody: string | null = null;
  try {
    const r = await handle.settled;
    if (r.error || !r.body) {
      releaseHandoffBusy();
      return;
    }
    if (myHandoffSlotRecord.cancelled) {
      releaseHandoffBusy();
      return;
    }
    handoffBody = r.body;
  } catch (err) {
    console.error(`[arco] handoff ${handle.handoffId} settle error:`, err);
    releaseHandoffBusy();
    return;
  }

  // Archive the current primary session, if any, into meta.history[].
  const oldSessionId = wf.primarySessionId;
  let turnCount = 0;
  for (const ev of transcript) {
    if (ev.type === 'user_message_echo') turnCount++;
  }
  if (oldSessionId) {
    try {
      await appendHistoryEntry(cwd, msg.workflowId, {
        sessionId: oldSessionId,
        provider: wf.primary.provider,
        startedAt: transcript[0] && 'timestamp' in transcript[0] && typeof transcript[0].timestamp === 'number'
          ? transcript[0].timestamp
          : Date.now(),
        endedAt: Date.now(),
        turnCount,
        archivedReason: 'handoff',
        handoffArtifactName: handle.artifactName,
      });
    } catch (err) {
      console.error(`[arco] handoff ${handle.handoffId} history append failed:`, err);
    }
  }

  // Clear the pinned session id so the next primary turn mints fresh.
  wf.primarySessionId = undefined;

  // Dispose the long-lived in-process Native worker (if any) BEFORE the
  // pre-warm so the post-handoff turn comes up on a fresh worker that
  // replays only the post-handoff_artifact_ready section of events.jsonl
  // (i.e. just the seed turn). Originally gated on
  // `effectiveMode === 'original-worker'` because only that path ran the
  // reflection on the cached worker — fresh-summarizer mode runs the
  // reflection in a separate CLI worker, so we assumed the cached Native
  // worker was untouched. That assumption was wrong: any pre-handoff
  // operator turn that was cancelled mid-tool-dispatch leaves the cached
  // worker with a trailing orphan `assistant(tool_use)` in messages[],
  // and pushing the seed prompt on top of that 400s with
  // "tool_use ids were found without tool_result blocks immediately after".
  // Always dispose for native handoff so the seed turn boots fresh from
  // replay (which skips tool_use entries entirely; cf. replayMessagesFromEvents).
  // No-op for CLI handoffs. Pair-flush in pruneOrphanToolUse is the
  // defense-in-depth backstop for any other path that lands here without
  // a prior dispose.
  if (wf.primary.provider === 'claude' && claudeTransport === 'native') {
    disposeClaudeNativeWorker(msg.workflowId);
  }

  // Optional: operator asked to swap the primary as part of the handoff.
  // Update in-memory state + persist to meta.json BEFORE the pre-warm spawn
  // so the new session is minted against the chosen CLI.
  if (msg.newPrimary) {
    const nextProviderAccountRef = msg.newPrimary.provider === 'codex'
      ? (msg.newPrimary.providerAccountRef ?? wf.config.providerAccountRef)
      : undefined;
    wf.primary.provider = msg.newPrimary.provider;
    wf.primary.model = msg.newPrimary.model;
    wf.primary.effort = msg.newPrimary.effort;
    wf.config.primaryProvider = msg.newPrimary.provider === 'claude' ? undefined : msg.newPrimary.provider;
    wf.config.primaryModel = msg.newPrimary.model;
    wf.config.primaryEffort = msg.newPrimary.effort;
    wf.config.providerAccountRef = nextProviderAccountRef;
    try {
      const meta = await readMeta(cwd, msg.workflowId);
      if (meta) {
        meta.primaryProvider = msg.newPrimary.provider;
        meta.primaryModel = msg.newPrimary.model;
        meta.primaryEffort = msg.newPrimary.effort;
        meta.providerAccountRef = nextProviderAccountRef;
        meta.lastActiveAt = Date.now();
        await writeMeta(cwd, meta);
      }
    } catch (err) {
      console.error(`[arco] [${msg.workflowId.slice(0, 8)}] handoff newPrimary meta write failed:`, err);
    }
    console.log(`[arco] [${msg.workflowId.slice(0, 8)}] handoff primary swap → ${wf.primary.provider}:${wf.primary.model}@${wf.primary.effort}`);
  }

  // Reset planLastSeenUpdatedAt so the post-handoff session sees the
  // "newly attached. Read the brief at <path>." form on its seed turn
  // rather than the stable form (which assumes the agent has already
  // been told about the plan). The new session has zero context of the
  // prior attachment, so treating it as a fresh attach is correct.
  if (wf.planId) {
    try {
      const meta = await readMeta(cwd, msg.workflowId);
      if (meta) {
        meta.planLastSeenUpdatedAt = 0;
        await writeMeta(cwd, meta);
      }
    } catch (err) {
      console.error(`[arco] [${msg.workflowId.slice(0, 8)}] handoff plan-lastSeen reset failed:`, err);
    }
  }

  // Pre-warm the new session with the handoff doc as its seed turn. Persist
  // the seed to events.jsonl so replay sees it as a normal user prompt (the
  // operator can see exactly what the new session was fed). The primary
  // will reply, typically with a short ack.
  const seedPrompt = `[HANDOFF — new session initialized for this tab. Read the document below carefully. Then in 2-3 sentences: (1) state where the project stands right now, and (2) what you believe the most useful next step is. Await the operator's instruction before beginning any work.]\n\n${handoffBody}`;
  send(ws, {
    type: 'user_message_echo',
    workflowId: msg.workflowId,
    content: seedPrompt,
    timestamp: Date.now(),
  });

  const prewarmClusterId = clusterStore.getClusterIdForWorkflow(msg.workflowId);
  let prewarmClusterPlan: string | undefined;
  let prewarmClusterRole: string | undefined;
  let prewarmClusterEfficiencyDoctrine: string | undefined;
  let prewarmClusterProgressDoctrine: string | undefined;
  let prewarmClusterTaskBoardAttached = false;
  if (prewarmClusterId) {
    const planRec = await clusterPlanBridge.readClusterPlan(prewarmClusterId).catch(() => null);
    prewarmClusterPlan = planRec?.body;
    prewarmClusterRole = clusterStore.getMemberRole(prewarmClusterId, msg.workflowId);
    prewarmClusterTaskBoardAttached = clusterStore.isTaskBoardAttached(prewarmClusterId);
    prewarmClusterEfficiencyDoctrine = clusterEfficiency.buildDoctrine(
      clusterStore.getEfficiencyLevel(prewarmClusterId),
      clusterStore.getEfficiencyAddendum(prewarmClusterId),
    );
    prewarmClusterProgressDoctrine = joinClusterDoctrines(
      buildClusterDirectorDoctrine(prewarmClusterRole),
      buildProgressDoctrine(
        clusterStore.getProgressTracking(prewarmClusterId),
        !!prewarmClusterPlan?.trim(),
        prewarmClusterTaskBoardAttached,
      ),
    );
  }
  const prewarmIsLocal = wf.primary.provider === 'ollama' || wf.primary.provider === 'llamacpp' || wf.primary.provider === 'lmstudio' || (wf.primary.provider === 'strata' || wf.primary.provider === 'deepseek');
  const prewarmLocalBase = wf.primary.provider === 'ollama'
    ? OLLAMA_PRIMARY_SYSTEM_PROMPT
    : (wf.primary.provider === 'llamacpp' || wf.primary.provider === 'lmstudio' || (wf.primary.provider === 'strata' || wf.primary.provider === 'deepseek'))
      ? LLAMACPP_PRIMARY_SYSTEM_PROMPT
      : undefined;
  const prewarmSystemPrompt = prewarmIsLocal && prewarmClusterId
    ? buildLocalClusterSystemPrompt({
        base: prewarmLocalBase,
        clusterPlan: prewarmClusterPlan,
        clusterRole: prewarmClusterRole,
        clusterEfficiencyDoctrine: prewarmClusterEfficiencyDoctrine,
        clusterProgressDoctrine: prewarmClusterProgressDoctrine,
      })
    : prewarmLocalBase;

  const handoffAccount = wf.primary.provider === 'codex'
    ? await resolveProviderAccount('codex', wf.config.providerAccountRef, cwd).catch(() => null)
    : null;
  const previewNudge = withPreviewNudge(undefined);
  let prewarmAppend = previewNudge;
  const prewarmNeedsStringCluster = !!prewarmClusterId && (
    wf.primary.provider === 'codex' ||
    (wf.primary.provider === 'claude' && claudeTransport === 'cli') ||
    wf.primary.provider === 'zai' ||
    wf.primary.provider === 'cursor'
  );
  if (prewarmNeedsStringCluster) {
    const tailBlocks: string[] = [];
    if (prewarmClusterRole) tailBlocks.push(`Your role in this cluster: ${prewarmClusterRole}`);
    if (wf.primary.provider === 'codex' && codexModelUsesCodeMode(wf.primary.model, handoffAccount?.codexHome) !== false) {
      tailBlocks.push(codexCodeModeClusterAddendum());
    }
    if (prewarmClusterEfficiencyDoctrine) tailBlocks.push(prewarmClusterEfficiencyDoctrine);
    if (prewarmClusterProgressDoctrine) tailBlocks.push(prewarmClusterProgressDoctrine);
    const planBlock = prewarmClusterPlan ? `--- Shared cluster plan ---\n${prewarmClusterPlan}` : undefined;
    const planFallback = prewarmClusterPlan
      ? `--- Shared cluster plan (OUTLINE — prose omitted; call cluster_plan_read for the full plan) ---\n${planOutline(prewarmClusterPlan)}`
      : undefined;
    const folded = composeClusterAppend(planBlock, tailBlocks, previewNudge.length, APPEND_CLUSTER_MAX, planFallback);
    if (folded.planTruncatedFrom !== undefined) {
      console.log(
        `[arco] [${msg.workflowId.slice(0, 8)}] handoff seed cluster plan over string-form fold budget ` +
        `(${folded.planTruncatedFrom} bytes → ${folded.usedFallback ? 'outline fallback' : 'head-truncated'})`,
      );
    }
    if (folded.combined) prewarmAppend = `${folded.combined}\n\n${previewNudge}`;
  }
  const primaryTurn = runPrimaryTurn(
    {
      workflowId: msg.workflowId,
      cwd,
      manager: wf.manager,
      broadcast: (m) => send(ws, m),
      notePotentialDevServerStart: (cmd, toolUseId) => deps.previewAutoDetect.notePotentialDevServerStart(msg.workflowId, cmd, toolUseId),
      noteAgentText: (text) => deps.previewAutoDetect.noteAgentText(msg.workflowId, text),
    },
    {
      primary: wf.primary,
      prompt: seedPrompt,
      resumeSessionId: undefined,
      disableRssGuard: wf.disableRssGuard,
      appendSystemPrompt: prewarmAppend,
      systemPrompt: prewarmSystemPrompt,
      ...(handoffAccount ? { providerAccountRef: handoffAccount.profile.id, codexHome: handoffAccount.codexHome } : {}),
      ...(wf.primary.provider === 'claude' ? { claudeTransport } : {}),
      clusterId: prewarmClusterId,
      clusterTaskBoardAttached: prewarmClusterTaskBoardAttached,
      clusterPlan: prewarmClusterPlan,
      clusterRole: prewarmClusterRole,
      clusterEfficiencyDoctrine: prewarmClusterEfficiencyDoctrine,
      clusterProgressDoctrine: prewarmClusterProgressDoctrine,
    },
  );

  if (primaryTurn.initialSessionId && wf.primary.provider === 'claude') {
    wf.primarySessionId = primaryTurn.initialSessionId;
    // Session rotation: pin the JSONL watcher to the new session's file.
    // Without this, the old watcher stays on the archived session and the
    // new session's writes never surface as `session_entry` events — which
    // causes finalized assistant text to vanish from chat (ChatPanel's
    // extras filter excludes non-streaming assistants when sessionChat is
    // non-empty from the pre-handoff session). No-op for non-Claude.
    startSessionWatcher(msg.workflowId, wf, cwd, ws);
    reconcileLatestCliSession(cwd, msg.workflowId, 'claude', primaryTurn.initialSessionId).catch((err) => {
      console.error(`[arco] handoff ${handle.handoffId} meta reconcile failed:`, err);
    });
  }
  primaryTurn.onSessionDiscovered((sid) => {
    if (!wf.primarySessionId) {
      wf.primarySessionId = sid;
      // Same rotation fix for providers that discover their session id
      // asynchronously (init event instead of pre-mint). Claude-only in
      // practice; startSessionWatcher is a no-op on other providers.
      startSessionWatcher(msg.workflowId, wf, cwd, ws);
    }
    if (wf.primary.provider === 'antigravity') broadcastSessionMetadata(msg.workflowId, wf);
    reconcileLatestCliSession(cwd, msg.workflowId, wf.primary.provider, sid, handoffAccount?.profile.id).catch((err) => {
      console.error(`[arco] handoff ${handle.handoffId} meta reconcile (${wf.primary.provider}) failed:`, err);
    });
  });

  try {
    await primaryTurn.settled;
  } catch (err) {
    console.error(`[arco] handoff ${handle.handoffId} pre-warm settle error:`, err);
  }

  send(ws, {
    type: 'handoff_complete',
    workflowId: msg.workflowId,
    handoffId: handle.handoffId,
    archived: {
      sessionId: oldSessionId ?? '',
      turnCount,
    },
    newSessionId: wf.primarySessionId,
    completedAt: Date.now(),
  });

  // Drop any cached per-workflow provider state that's now stale against the
  // post-handoff session. Specifically: a Codex appserver tab keeps a long-
  // lived `CodexAppServerWorker` bootstrapped against the pre-handoff
  // threadId; without disposal, the next operator turn's `acquireWorker`
  // returns the cached worker and `turn/start` fires against the archived
  // thread instead of resuming `wf.primarySessionId`. No-op for non-codex
  // providers and for codex tabs on the exec transport.
  disposeProviderResources(msg.workflowId);

  console.log(`[arco] [${msg.workflowId.slice(0, 8)}] handoff ${handle.handoffId} complete (archived ${oldSessionId?.slice(0, 8)}, new ${wf.primarySessionId?.slice(0, 8)})`);
  releaseHandoffBusy();

  // Reset fired flags so warning/auto-handoff thresholds work fresh in the new session.
  wf.autoHandoff.warnFired = false;
  wf.autoHandoff.autoFired = false;

  // Reset calibration state — new session starts uncalibrated.
  wf.calibration = undefined;
  wf.lastContextPercent = 0;

  // Emit context estimate for the new (near-empty) session so the footer
  // reflects the reset without waiting for the first operator turn.
  if (wf.primarySessionId && wf.primary.provider === 'claude') {
    estimateContextFill(cwd, wf.primarySessionId, wf.primary.model).then((est) => {
      if (!est) return;
      broadcastTransient(msg.workflowId, { type: 'context_usage', workflowId: msg.workflowId, ...est, claudeSessionId: wf.primarySessionId });
    }).catch(() => { /* best-effort */ });
  }

  } finally {
    // Catches the early returns and throws that used to leave the tab stuck
    // busy. Token-scoped: a no-op when STOP / lock-clear revoked our claim or
    // a newer holder owns busy.
    releaseHandoffBusy();
    // Release our slot regardless of which return / error path we took.
    // The next queued handoff in this cwd (if any) wakes from its await.
    if (myHandoffId && wf.activeHandoff?.handoffId === myHandoffId) wf.activeHandoff = undefined;
    releaseHandoffSlot();
    // Operator messages typed during the handoff queued behind busy; only the
    // turn loop drains, so without this they sat QUEUED (and an armed goal run
    // skipped) until the next send. Fire-and-forget: the drain is a full turn.
    // Only the owning path drains — a revoked/superseded holder leaves the
    // queue to whoever holds busy now.
    if (busyReleasedByUs) void drainQueueIfIdle(msg.workflowId);
  }
}

// Phase 7 — fork a tab. Creates a fresh workflow (new wfid, own meta.json,
// own events.jsonl), seeds it with a handoff doc generated from the parent's
// transcript plus an optional operator-supplied direction. Parent tab is
// untouched. On completion, the parent receives `spawn_from_here_complete`
// carrying the new wfid so its client can auto-activate the new tab.
export async function handleSpawnFromHere(
  ws: WebSocket,
  session: Session,
  msg: import('@arco/shared').SpawnFromHereRequestMessage,
): Promise<void> {
  const parent = workflows.get(msg.parentWorkflowId);
  if (!parent) {
    send(ws, { type: 'error', message: `Unknown parent workflow ${msg.parentWorkflowId.slice(0, 8)}` });
    return;
  }
  // Chat tabs are projectless — the reflection and the spawned tab would run
  // Agent workers with project tools. Also refuse a chat-kind newConfig.
  if (isChatWorkflow(parent.config) || isChatWorkflow(msg.newConfig)) {
    send(ws, { type: 'error', message: 'Spawn from here is not available in Chat tabs.' });
    return;
  }
  // A busy parent is mid-turn (or mid-handoff/spawn). Original-worker on a
  // Codex app-server parent releases the parent's live worker so `codex exec
  // resume` can take the thread's writer lock — doing that mid-turn killed
  // the turn ("Worker disposed (workflow removed)"). A transcript cut from a
  // running turn is half a conversation anyway, so refuse outright.
  if (parent.busy) {
    send(ws, { type: 'error', message: 'Spawn from here: the parent tab is busy — wait for its turn to finish (or cancel it), then retry.' });
    return;
  }
  const parentCwd = parent.config.workingDirectory;
  if (!parentCwd) {
    send(ws, { type: 'error', message: 'Parent workflow has no working directory configured.' });
    return;
  }

  const transcript = await replayWorkflowEvents(parentCwd, msg.parentWorkflowId, 0);
  if (transcript.length === 0) {
    send(ws, { type: 'error', message: 'Parent has no conversation to fork — chat first.' });
    return;
  }

  const newCwd = msg.newConfig.workingDirectory || parentCwd;
  const newPrimary = derivePrimaryConfig(msg.newConfig);
  const initialSpawnAccount = newPrimary.provider === 'codex'
    ? await resolveProviderAccount('codex', msg.newConfig.providerAccountRef, newCwd).catch(() => null)
    : null;
  if (initialSpawnAccount?.profile.id && msg.newConfig.providerAccountRef !== initialSpawnAccount.profile.id) {
    msg.newConfig.providerAccountRef = initialSpawnAccount.profile.id;
  }

  // §5.1 — drift guard. The spawned tab's primary is operator-selected in the
  // SpawnDialog; re-resolve it against the live catalog at dispatch and flag
  // (don't block) if the model drifted out before the spawn fires. Surfaced on
  // the PARENT tab — the new tab doesn't exist yet.
  const spawnDrift = await checkModelDrift(newPrimary.provider, newPrimary.model, catalogDriftProbe);
  if (spawnDrift.drifted) {
    broadcastWorkflow(msg.parentWorkflowId, {
      type: 'system_notice',
      workflowId: msg.parentWorkflowId,
      content: driftFlag('spawn', newPrimary.provider, newPrimary.model, spawnDrift.reason ?? 'model drifted'),
    });
  }

  // Phase 4 — operator asked to spawn-into-cluster. Validate up front so
  // we don't half-create the workflow only to refuse the join. Fence now
  // accepts Claude (Native + CLI) and Codex (exec + appserver); Gemini /
  // Ollama / llama.cpp / Antigravity still rejected. Effective-transport
  // rule mirrors assertAllMembersClaudeOrCodex: per-tab override → settings
  // cascade → 'cli' fallback for Claude.
  if (msg.joinClusterId) {
    const targetCluster = await clusterStore.readCluster(msg.joinClusterId).catch(() => null);
    if (!targetCluster) {
      send(ws, { type: 'error', message: `spawn_from_here rejected: unknown_cluster:${msg.joinClusterId.slice(0, 8)}` });
      return;
    }
    const newProvider = msg.newConfig.primaryProvider ?? 'claude';
    if (newProvider !== 'claude' && newProvider !== 'codex') {
      send(ws, { type: 'error', message: `spawn_from_here rejected: member_not_supported` });
      return;
    }
    // Both Claude transports allowed as of Phase 3 + both Codex transports
    // as of Phase 4. The Claude resolver kept inline so a future per-
    // transport gate (e.g. minimum CLI version) has a hook.
    if (newProvider === 'claude') {
      const tabTransport = msg.newConfig.claudeTransport;
      const cascade = await readSettings(newCwd).catch(() => null);
      const effective: 'native' | 'cli' =
        tabTransport === 'native' || tabTransport === 'cli'
          ? tabTransport
          : cascade?.claude?.transport === 'native' ? 'native' : 'cli';
      void effective;
    }
  }

  const newManager = new WorkerManager();
  const newWorkflowId = crypto.randomUUID();
  const handoffCascade = await readSettings(newCwd).catch(() => null);
  applyAutoHandoffDefault(msg.newConfig, handoffCascade?.autoHandoffDefaults);
  // docs/GOTCHAS.md - a Spawn-from-here tab durably inherits the parent's
  // north-star (not just the one-shot seed) unless the operator picked a
  // different one at spawn time. Persisted with the new tab's meta below, so
  // every post-seed turn keeps the standing objective. Reversible: clear it on
  // the new tab.
  if (msg.newConfig.goal === undefined && parent.config.goal) {
    msg.newConfig.goal = parent.config.goal;
  }

  workflows.set(newWorkflowId, {
    config: msg.newConfig,
    busy: true, // stay busy through summarize + pre-warm
    manager: newManager,
    primary: newPrimary,
    queue: { steering: [], followUp: [] },
    observers: new Set([ws]),
    autoHandoff: deriveAutoHandoff(msg.newConfig),
    lastContextPercent: 0,
    previewHistory: [],
  });
  // Token the new tab's busy too: it's observable (and STOPpable) during
  // summarize + pre-warm, so a STOP + send there must not be cleared below.
  const newBusyToken = claimBusy(workflows.get(newWorkflowId)!);
  session.workflowIds.add(newWorkflowId);

  workflowCwds.set(newWorkflowId, newCwd);
  acquireProjectSettingsWatcher(newCwd);
  rememberCwd(newCwd).catch(() => { /* best-effort */ });
  try {
    await initWorkflowStore(newCwd, newWorkflowId);
    await persistInitialMeta(newCwd, newWorkflowId, msg.newConfig, newPrimary);
  } catch (err) {
    console.error(`[arco] spawn init failed for ${newWorkflowId.slice(0, 8)}:`, err);
    send(ws, { type: 'error', message: 'Failed to initialize spawned workflow.' });
    return;
  }

  // Broadcast the new tab so the client adds a JobState immediately. The
  // operator will see the new tab appear, then watch the handoff doc
  // generate + seed turn stream inside it.
  send(ws, { type: 'workflow_created', workflowId: newWorkflowId, config: msg.newConfig });

  // Phase 2.5b — add the freshly-created workflow to the requested cluster
  // BEFORE the seed turn runs. The clusterId threads into runPrimaryTurn via
  // `handleUserMessage` (clusterStore.getClusterIdForWorkflow lookup at turn
  // start) so peer tools register on the very first turn. Validation already
  // ran above — this call should only fail on race conditions (cluster
  // deleted between validate and add); surface as a system_notice so the
  // operator sees the join failure but the spawn still completes.
  if (msg.joinClusterId) {
    try {
      await clusterStore.addMember(msg.joinClusterId, newWorkflowId);
      const newWfNow = workflows.get(newWorkflowId);
      const member = {
        workflowId: newWorkflowId,
        displayName: clusterStore.displayNameFor(newWorkflowId),
        status: (newWfNow?.busy ? 'busy' : 'idle') as 'idle' | 'busy',
        role: undefined as string | undefined,
      };
      broadcastCluster(msg.joinClusterId, { type: 'cluster_member_added', clusterId: msg.joinClusterId, member });
      const payload = await buildClusterStatePayload(msg.joinClusterId);
      if (payload) {
        broadcastCluster(msg.joinClusterId, { type: 'cluster_state', clusterId: msg.joinClusterId, state: payload });
      }
      console.log(`[arco] spawn ${newWorkflowId.slice(0, 8)} joined cluster ${msg.joinClusterId.slice(0, 8)}`);
    } catch (err) {
      const code = (err as { code?: string })?.code ?? 'add_failed';
      console.error(`[arco] spawn ${newWorkflowId.slice(0, 8)} cluster join failed: ${code}`);
      send(ws, { type: 'error', message: `spawn cluster join failed: ${code}` });
    }
  }

  // WP2 — same resolution chain as Handoff: per-request override →
  // settings.handoffSummarizer (a strong fresh agent the operator pinned) →
  // the spawn's primary. A degraded source worker shouldn't be the one to
  // summarize itself into the spawn's seed handoff. Optional model/effort on
  // the configured summarizer fill from newPrimary.
  const spawnSummarizerSettings = await readSettings(parentCwd).catch(() => null);
  const summarizer = msg.summarizer ?? (spawnSummarizerSettings?.handoffSummarizer
    ? {
        provider: spawnSummarizerSettings.handoffSummarizer.provider,
        model: spawnSummarizerSettings.handoffSummarizer.model ?? newPrimary.model,
        effort: spawnSummarizerSettings.handoffSummarizer.effort ?? newPrimary.effort,
      }
    : {
        provider: newPrimary.provider,
        model: newPrimary.model,
        effort: newPrimary.effort,
      });

  // For 'original-worker' mode: dispatch the reflection turn against the
  // PARENT's primary session. Events stream to the new tab (ctx.workflowId
  // below is newWorkflowId) but the underlying --resume hits the parent's
  // session (CLI) or the new worker is seeded from the parent's events.jsonl
  // (Native), so the reflection has full parent context. Parent stays
  // read-only for the duration of the reflection — mark it busy and unstick
  // on any error path so the parent isn't left busy forever.
  let parentClaudeTransport: 'cli' | 'native' = 'cli';
  if (parent.primary.provider === 'claude') {
    const tab = parent.config.claudeTransport;
    if (tab === 'native' || tab === 'cli') {
      parentClaudeTransport = tab;
    } else {
      const cascade = await readSettings(parentCwd).catch(() => null);
      parentClaudeTransport = cascade?.claude?.transport === 'native' ? 'native' : 'cli';
    }
  }
  const parentNativeOriginalEligible = parent.primary.provider === 'claude' && parentClaudeTransport === 'native';
  const parentCodexAccount = parent.primary.provider === 'codex'
    ? await resolveProviderAccount('codex', parent.config.providerAccountRef, parentCwd).catch(() => null)
    : null;
  // Native parents qualify even without primarySessionId — their resume
  // mechanism is in-memory messages replay, not CLI rollouts.
  const parentHadSession = Boolean(parent.primarySessionId) || parentNativeOriginalEligible;
  const originalPrimary = parentHadSession
    ? {
        primary: parent.primary,
        sessionId: parent.primarySessionId ?? '',
        cwd: parentCwd,
        sourceWorkflowId: msg.parentWorkflowId,
        ...(parentCodexAccount ? { providerAccountRef: parentCodexAccount.profile.id, codexHome: parentCodexAccount.codexHome } : {}),
        ...(parent.primary.provider === 'claude' ? { transport: parentClaudeTransport } : {}),
        // Native + Spawn: hydrate the child's worker from the parent's
        // events.jsonl. Skipped for Handoff (target == parent → existing
        // worker carries history) and for CLI (uses --resume instead).
        // Phase 8 — pass cutoffEventSeq through so the Native worker only
        // sees parent history up to the operator's anchor.
        ...(parentNativeOriginalEligible
          ? {
              nativeReplaySource: {
                cwd: parentCwd,
                workflowId: msg.parentWorkflowId,
                ...(typeof msg.cutoffEventSeq === 'number' ? { maxSeq: msg.cutoffEventSeq } : {}),
              },
            }
          : {}),
      }
    : undefined;

  // WP6 — mirror Handoff's uniform original/fresh translation. On a non-
  // resumable parent (Ollama/llama.cpp/LM Studio/Gemini/Antigravity),
  // "original worker" means the SAME local model re-reads the parent's
  // transcript via the fresh-summarizer mechanism, pinned to the parent's
  // primary rather than the configured fresh summarizer. Overflow falls back
  // to the configured summarizer (same lastContextPercent heuristic as Handoff).
  const parentResumable = parent.primary.provider === 'claude' || parent.primary.provider === 'codex' || parent.primary.provider === 'zai';
  let effectiveMode = msg.mode;
  let translatedSummarizer = summarizer;
  if (effectiveMode === 'original-worker' && !parentResumable) {
    const tooBig = typeof parent.lastContextPercent === 'number'
      && parent.lastContextPercent >= (parent.autoHandoff?.autoAt ?? 90);
    if (!tooBig) {
      effectiveMode = 'fresh-summarizer';
      translatedSummarizer = { provider: parent.primary.provider, model: parent.primary.model, effort: parent.primary.effort };
      send(ws, {
        type: 'system_notice',
        workflowId: newWorkflowId,
        content: `Original-worker on a local model = the same model (${parent.primary.model}) re-reads its transcript (no live session to resume).`,
      });
    } else {
      const configured = msg.summarizer ?? (spawnSummarizerSettings?.handoffSummarizer
        ? {
            provider: spawnSummarizerSettings.handoffSummarizer.provider,
            model: spawnSummarizerSettings.handoffSummarizer.model ?? parent.primary.model,
            effort: spawnSummarizerSettings.handoffSummarizer.effort ?? parent.primary.effort,
          }
        : null);
      effectiveMode = 'fresh-summarizer';
      if (configured) {
        translatedSummarizer = configured;
        send(ws, {
          type: 'system_notice',
          workflowId: newWorkflowId,
          content: `Transcript too large for ${parent.primary.model} to summarize itself — using fresh summarizer ${configured.model} instead.`,
        });
      } else {
        translatedSummarizer = { provider: parent.primary.provider, model: parent.primary.model, effort: parent.primary.effort };
        send(ws, {
          type: 'system_notice',
          workflowId: newWorkflowId,
          content: `Transcript may exceed ${parent.primary.model}'s window and no fresh summarizer is configured — attempting with the local model; configure a Default Summarizer (Settings) for reliability.`,
        });
      }
    }
  }

  // Safety net: 'original-worker' still needs a resumable parent session.
  // Ollama/Gemini/Antigravity parents, or parents that haven't taken a
  // turn, fall through to 'fresh-summarizer' — same rationale as Handoff.
  if (effectiveMode === 'original-worker' && !parentHadSession) {
    console.log(`[arco] spawn ${newWorkflowId.slice(0, 8)}: parent has no resumable session, falling back to fresh-summarizer`);
    effectiveMode = 'fresh-summarizer';
  }

  // Re-check: the awaits since the top-of-function guard let a parent turn
  // start. Only original-worker touches the parent's live session.
  if (effectiveMode === 'original-worker' && parent.busy) {
    send(ws, {
      type: 'spawn_from_here_complete',
      parentWorkflowId: msg.parentWorkflowId,
      newWorkflowId,
      error: 'parent tab became busy before the reflection could start — retry once its turn finishes',
      completedAt: Date.now(),
    });
    const wf = workflows.get(newWorkflowId);
    if (wf) releaseBusy(wf, newBusyToken);
    return;
  }
  // Only release what we claimed: fresh-summarizer never marks the parent,
  // and hard-setting busy=false there cleared a live parent turn's flag.
  // Token-scoped so a parent STOP (revokeBusy) + resend during the reflection
  // isn't clobbered when the reflection settles.
  const parentBusyToken = effectiveMode === 'original-worker' ? claimBusy(parent) : null;
  const releaseParent = () => {
    if (parentBusyToken === null) return;
    if (!releaseBusy(parent, parentBusyToken)) return;
    // Flush anything the operator queued on the parent during the reflection.
    void drainQueueIfIdle(msg.parentWorkflowId);
  };

  // exportContext's handoff events stamp into the new tab's events.jsonl —
  // the forked tab owns the handoff, not the parent.
  const exp = runExportContext(
    {
      workflowId: newWorkflowId,
      cwd: newCwd,
      manager: newManager,
      broadcast: (m) => send(ws, m),
    },
    {
      mode: effectiveMode,
      // docs/GOTCHAS.md - Spawn-from-here inherits the PARENT tab's
      // north-star into the seed so the new tab starts under the same objective.
      summarizer: translatedSummarizer && parent.config.goal
        ? { ...translatedSummarizer, goal: parent.config.goal }
        : translatedSummarizer,
      transcript,
      original: originalPrimary && parent.config.goal
        ? { ...originalPrimary, goal: parent.config.goal }
        : originalPrimary,
      ...(typeof msg.cutoffEventSeq === 'number' ? { cutoffEventSeq: msg.cutoffEventSeq } : {}),
    },
  );

  console.log(`[arco] spawn ${newWorkflowId.slice(0, 8)} started from parent ${msg.parentWorkflowId.slice(0, 8)} (mode=${effectiveMode})`);

  let handoffBody: string | null = null;
  try {
    const r = await exp.settled;
    // Reflection done — parent is free to take operator turns again.
    releaseParent();
    if (r.error || !r.body) {
      send(ws, {
        type: 'spawn_from_here_complete',
        parentWorkflowId: msg.parentWorkflowId,
        newWorkflowId,
        error: r.error ?? 'summarizer returned empty body',
        completedAt: Date.now(),
      });
      const wf = workflows.get(newWorkflowId);
      if (wf) releaseBusy(wf, newBusyToken);
      return;
    }
    handoffBody = r.body;
    // Native + original-worker reflection ran on the child workflow's
    // newly-seeded Native worker; messages[] now carries
    // [parent + reflection]. Dispose so the pre-warm below comes up on a
    // fresh worker that replays only post-handoff_artifact_ready events.
    // No-op for CLI or fresh-summarizer.
    if (effectiveMode === 'original-worker' && parentNativeOriginalEligible) {
      disposeClaudeNativeWorker(newWorkflowId);
    }
  } catch (err) {
    console.error(`[arco] spawn ${newWorkflowId.slice(0, 8)} settle error:`, err);
    releaseParent();
    const wf = workflows.get(newWorkflowId);
    if (wf) releaseBusy(wf, newBusyToken);
    send(ws, {
      type: 'spawn_from_here_complete',
      parentWorkflowId: msg.parentWorkflowId,
      newWorkflowId,
      error: err instanceof Error ? err.message : String(err),
      completedAt: Date.now(),
    });
    return;
  }

  const seedPrompt = msg.newDirection && msg.newDirection.trim()
    ? `${handoffBody}\n\n---\n\nNew direction: ${msg.newDirection.trim()}`
    : `${handoffBody}\n\n---\n\nRead the handoff above. Acknowledge with "READY" and wait for the operator's next instruction.`;

  // Optional: copy the parent's attached plan onto the spawn. Default off
  // (spawn is plan-free unless the operator opted in via the SpawnDialog
  // checkbox). Mirrors handlePlanAttach but avoids the WS broadcast path
  // since the new workflow isn't observed yet — the seed turn's
  // buildPlanPrefix will emit the "newly attached" header naturally on
  // the spawn's first turn.
  if (msg.includePlan && parent.planId) {
    const newWf = workflows.get(newWorkflowId);
    if (newWf) {
      const summary = await readPlanSummary(newCwd, parent.planId).catch(() => null);
      if (summary) {
        newWf.planId = parent.planId;
        try {
          const newMeta = await readMeta(newCwd, newWorkflowId);
          if (newMeta) {
            newMeta.planId = parent.planId;
            newMeta.planLastSeenUpdatedAt = 0;
            await writeMeta(newCwd, newMeta);
          }
        } catch (err) {
          console.error(`[arco] [${newWorkflowId.slice(0, 8)}] spawn includePlan meta write failed:`, err);
        }
        acquirePlansWatcher(newCwd);
        await recordAttachment(newCwd, parent.planId, newWorkflowId, msg.newConfig.name)
          .catch(() => { /* best-effort */ });
        broadcastWorkflow(newWorkflowId, {
          type: 'plan_attached',
          workflowId: newWorkflowId,
          planId: summary.id,
          title: summary.title,
          updatedAt: summary.updatedAt,
        });
      }
    }
  }

  send(ws, {
    type: 'user_message_echo',
    workflowId: newWorkflowId,
    content: seedPrompt,
    timestamp: Date.now(),
  });

  let newClaudeTransport: 'cli' | 'native' = 'cli';
  if (newPrimary.provider === 'claude') {
    const tab = msg.newConfig.claudeTransport;
    if (tab === 'native' || tab === 'cli') {
      newClaudeTransport = tab;
    } else {
      const cascade = await readSettings(newCwd).catch(() => null);
      newClaudeTransport = cascade?.claude?.transport === 'native' ? 'native' : 'cli';
    }
  }
  const spawnAccount = initialSpawnAccount;

  const primaryTurn = runPrimaryTurn(
    {
      workflowId: newWorkflowId,
      cwd: newCwd,
      manager: newManager,
      broadcast: (m) => send(ws, m),
      notePotentialDevServerStart: (cmd, toolUseId) => deps.previewAutoDetect.notePotentialDevServerStart(newWorkflowId, cmd, toolUseId),
      noteAgentText: (text) => deps.previewAutoDetect.noteAgentText(newWorkflowId, text),
    },
    {
      primary: newPrimary,
      prompt: seedPrompt,
      resumeSessionId: undefined,
      // Inherit parent's RSS-guard opt-out — spawning a fork of a
      // known-huge workflow (kernel build etc.) should keep the same
      // latitude on the seed turn. Operator can rescind via meta.json.
      disableRssGuard: parent.disableRssGuard,
      appendSystemPrompt: withPreviewNudge(undefined),
      ...(spawnAccount ? { providerAccountRef: spawnAccount.profile.id, codexHome: spawnAccount.codexHome } : {}),
      ...(newPrimary.provider === 'claude' ? { claudeTransport: newClaudeTransport } : {}),
    },
  );

  const spawnedWf = workflows.get(newWorkflowId);
  // Persist parent's RSS-guard opt-out onto the spawned workflow so
  // subsequent turns (beyond the seed) pick it up from WorkflowState.
  if (spawnedWf && parent.disableRssGuard) spawnedWf.disableRssGuard = true;
  if (spawnedWf && primaryTurn.initialSessionId && newPrimary.provider === 'claude') {
    spawnedWf.primarySessionId = primaryTurn.initialSessionId;
    // Spawn creates the workflow inline (no handleCreateWorkflow path), so
    // the usual watcher-start call never runs. Start it here once the new
    // session's id is known — same reasoning as the handoff fix above.
    startSessionWatcher(newWorkflowId, spawnedWf, newCwd, ws);
    reconcileLatestCliSession(newCwd, newWorkflowId, 'claude', primaryTurn.initialSessionId).catch((err) => {
      console.error(`[arco] spawn meta reconcile failed:`, err);
    });
  }
  primaryTurn.onSessionDiscovered((sid) => {
    const wf = workflows.get(newWorkflowId);
    if (wf && !wf.primarySessionId) {
      wf.primarySessionId = sid;
      startSessionWatcher(newWorkflowId, wf, newCwd, ws);
    }
    if (wf && wf.primary.provider === 'antigravity') broadcastSessionMetadata(newWorkflowId, wf);
    reconcileLatestCliSession(newCwd, newWorkflowId, newPrimary.provider, sid, spawnAccount?.profile.id).catch((err) => {
      console.error(`[arco] spawn meta reconcile (${newPrimary.provider}) failed:`, err);
    });
  });

  try {
    await primaryTurn.settled;
  } catch (err) {
    console.error(`[arco] spawn ${newWorkflowId.slice(0, 8)} pre-warm settle error:`, err);
  }

  const wf = workflows.get(newWorkflowId);
  const newBusyOwned = wf ? releaseBusy(wf, newBusyToken) : false;

  send(ws, {
    type: 'spawn_from_here_complete',
    parentWorkflowId: msg.parentWorkflowId,
    newWorkflowId,
    handoffArtifactName: exp.artifactName,
    completedAt: Date.now(),
  });
  // The new tab is observable during pre-warm, so the operator may have
  // queued into it already. Only when we still owned busy.
  if (newBusyOwned) void drainQueueIfIdle(newWorkflowId);

  console.log(`[arco] spawn ${newWorkflowId.slice(0, 8)} complete`);
}

// Re-apply handleCreateWorkflow's incognito rules to a client-supplied config
// on rehydrate (server restart / reconnect). The client's config is the only
// source for an incognito tab — there's no meta.json — so a stale or crafted
// one could otherwise come back with a persistent transport, a real cwd, or
// remote surfaces armed. Returns an error string when the tab can't be
// honoured as incognito at all. Mutates `config` like the create path does.
function enforceIncognitoOnRehydrate(config: WorkflowConfig): string | null {
  if (config.kind !== 'chat') return 'Incognito is available only in Chat mode.';
  if (config.resumeWorkflowId || config.resumeSessionId) {
    return 'An incognito Chat cannot resume a saved workflow or provider session.';
  }
  const provider = derivePrimaryConfig(config).provider;
  if (!INCOGNITO_CHAT_PROVIDERS.has(provider)) {
    return `${provider} cannot guarantee a non-persistent CLI session in Incognito Chat.`;
  }
  if (config.voiceOperator) {
    if (!['codex', 'claude', 'ollama', 'strata'].includes(provider)) return 'Computer supports Codex, Claude, Ollama and Strata.';
    config.chatWebAccess = false;
    if (provider === 'claude') config.claudeTransport = 'native';
  }
  config.skipPermissions = false;
  // Always re-assign THIS process's private 0700 dir: a client-held path is
  // either a previous process's (removed on its exit) or the old shared
  // os.tmpdir(), and neither may be trusted as the incognito cwd.
  config.workingDirectory = incognitoChatCwd();
  config.remoteEnabled = false;
  config.remoteGatesEnabled = false;
  // Computer uses a verified ephemeral app-server thread; ordinary Chat stays exec.
  if (provider === 'codex') config.codexTransport = config.voiceOperator ? 'appserver' : 'exec';
  if (provider === 'zai') config.zaiTransport = 'native';
  return null;
}

export async function handleRehydrateWorkflows(
  ws: WebSocket,
  session: Session,
  entries: Array<{ workflowId: string; config: WorkflowConfig; currentSessionId: string; lastSeq?: number; tail?: boolean }>,
): Promise<void> {
  for (const entry of entries) {
    const existing = workflows.get(entry.workflowId);
    if (!existing && entry.config.incognito) {
      // Register before anything below can log the wfid.
      registerPrivateLogToken(entry.workflowId);
      const refusal = enforceIncognitoOnRehydrate(entry.config);
      if (refusal) {
        send(ws, { type: 'error', message: `Incognito tab could not be restored: ${refusal}` });
        continue;
      }
    }
    if (existing) {
      if (existing.incognitoCleanupTimer) {
        clearTimeout(existing.incognitoCleanupTimer);
        existing.incognitoCleanupTimer = undefined;
      }
      // Attach this ws as an additional observer. In-flight turns survive —
      // their closures reference this WorkflowState, and future broadcasts
      // fan out to every observer ws in the set.
      existing.observers.add(ws);
      // A boot-materialized cluster member holds a config reconstructed from
      // meta.json, which can't carry client-only fields (advanced / fastMode /
      // allowedProviders / skipPermissions — a SAFE-mode member would otherwise
      // silently run as skipPermissions:true, and a fallbackModel / extra-dirs
      // member would lose them). The reconnecting client is their only source of
      // truth: replace the placeholder config with the client's full one and
      // re-derive. Guarded on !busy so an in-flight turn (rare in the window
      // between boot registration and the first reconnect) isn't disrupted; the
      // meta-restoration below then overlays meta-authoritative fields as usual.
      if (existing.bootMaterialized && !existing.busy) {
        existing.config = entry.config;
        existing.primary = derivePrimaryConfig(entry.config);
        existing.autoHandoff = deriveAutoHandoff(entry.config);
        existing.bootMaterialized = false;
      }
    } else {
      const primary = derivePrimaryConfig(entry.config);
      workflows.set(entry.workflowId, {
        config: entry.config,
        busy: false,
        manager: new WorkerManager(),
        primary,
        ...(entry.config.incognito ? { incognitoEvents: [] } : {}),
        queue: { steering: [], followUp: [] },
        observers: new Set([ws]),
        autoHandoff: deriveAutoHandoff(entry.config),
        lastContextPercent: 0,
        previewHistory: [],
      });
      if (!entry.config.incognito) console.log(`[arco] Rehydrated workflow: "${entry.config.name}" [${entry.workflowId.slice(0, 8)}]`);
    }
    session.workflowIds.add(entry.workflowId);
    const wf = workflows.get(entry.workflowId)!;
    if (!existing && wf.config.incognito && wf.config.voiceOperator) {
      // A new server epoch has no private history, even if the reconnecting
      // page still has old rows in memory. Do not imply that context survived.
      wf.config.computerContext = { resetAtPercent: wf.config.computerContext?.resetAtPercent, keepContext: false, resets: 0 };
      send(ws, { type: 'computer_context_updated', workflowId: entry.workflowId, state: wf.config.computerContext, fresh: true, discardTranscript: true, settled: true });
    }
    const cwd = wf.config.workingDirectory ?? entry.config.workingDirectory;
    if (cwd && !wf.config.incognito) {
      workflowCwds.set(entry.workflowId, cwd);
      acquireProjectSettingsWatcher(cwd);
      rememberCwd(cwd).catch(() => { /* best-effort */ });
      try {
        await initWorkflowStore(cwd, entry.workflowId);
      } catch (err) {
        console.error(`[arco] workflowStore init failed for ${entry.workflowId.slice(0, 8)}:`, err);
      }
      // Read meta.json to restore primarySessionId so the next user_message
      // continues the prior CLI session instead of starting a fresh one.
      try {
        const meta = await readMeta(cwd, entry.workflowId);
        if (meta) {
          const latestForProvider = [...meta.cliSessions].reverse().find((s) => s.provider === wf.primary.provider);
          if (latestForProvider && !wf.primarySessionId) {
            wf.primarySessionId = latestForProvider.sessionId;
          }
          if (meta.autoHandoff) {
            wf.autoHandoff.enabled = meta.autoHandoff.enabled;
            wf.autoHandoff.warnAt = meta.autoHandoff.warnAt;
            wf.autoHandoff.autoAt = meta.autoHandoff.autoAt;
            // WP5 — restore mode + summarizer too (resolution at fire time).
            wf.autoHandoff.mode = meta.autoHandoff.mode;
            wf.autoHandoff.summarizer = meta.autoHandoff.summarizer;
            wf.config.autoHandoff = { ...meta.autoHandoff };
          } else {
            const cascade = await readSettings(cwd).catch(() => null);
            if (applyAutoHandoffDefault(wf.config, cascade?.autoHandoffDefaults) && wf.config.autoHandoff) {
              wf.autoHandoff = deriveAutoHandoff(wf.config);
              meta.autoHandoff = { ...wf.config.autoHandoff };
              meta.lastActiveAt = Date.now();
              await writeMeta(cwd, meta).catch((err) => {
                console.error(`[arco] [${entry.workflowId.slice(0, 8)}] auto-handoff default meta write failed:`, err);
              });
            }
          }
          if (meta.disableRssGuard) wf.disableRssGuard = true;
          if (meta.planId) {
            const summary = await readPlanSummary(cwd, meta.planId).catch(() => null);
            if (summary) {
              const wasFreshLoad = !existing;
              wf.planId = meta.planId;
              if (wasFreshLoad) {
                // Server restart path: rebuild watcher + ensure an open
                // attachment span exists. recordAttachment is idempotent so
                // a re-rehydrate (multiple browser windows) doesn't double-add.
                acquirePlansWatcher(cwd);
                await recordAttachment(cwd, meta.planId, entry.workflowId, wf.config.name)
                  .catch(() => { /* best-effort */ });
              }
            }
          }
          if (meta.calibration && !wf.calibration) {
            wf.calibration = {
              ratio: meta.calibration.ratio,
              overhead: meta.calibration.overhead,
              // Reset zones on restart so the next crossing re-calibrates
              // against whatever the session has grown into — ratio stays
              // warm from disk in the meantime.
              zonesCalibrated: new Set(),
              lastGroundTruth: meta.calibration.lastGroundTruth,
            };
          }
          if (meta.preview && !wf.preview) {
            wf.preview = { ...meta.preview };
          }
          if (meta.previewHistory && wf.previewHistory.length === 0) {
            wf.previewHistory = [...meta.previewHistory];
          }
          if (meta.zaiTransport === 'native' || meta.zaiTransport === 'appserver') {
            wf.config.zaiTransport = meta.zaiTransport;
          }
          // F5 — prefer meta.name on rehydrate so a server-only restart
          // (or a client whose localStorage predates the rename) doesn't
          // overwrite the operator's choice with a stale config.name.
          if (typeof meta.name === 'string' && meta.name !== wf.config.name) {
            wf.config.name = meta.name;
          }
        }
      } catch (err) {
        console.error(`[arco] meta read failed for ${entry.workflowId.slice(0, 8)}:`, err);
      }
    }
  }

  // Per-workflow snapshot + event replay. Iterate over this session's
  // claimed ids only so we don't push state for workflows that live on
  // other sessions.
  //
  // Only the ids in THIS message: iterating every session id replayed each
  // already-open tab from seq 0 again whenever one more tab was rehydrated
  // (a mirrored tab opening elsewhere). Sequential, in the client's order
  // (focused tab first): parallel full replays of many tabs is what OOM'd the
  // server on 2026-10-14.
  for (const entry of entries) {
    const workflowId = entry.workflowId;
    if (!session.workflowIds.has(workflowId)) continue;
    const wf = workflows.get(workflowId);
    if (!wf) continue;
    const clientLastSeq = entry.lastSeq ?? 0;
    await rehydrateOneWorkflow(ws, workflowId, wf, clientLastSeq, { tail: entry.tail === true }).catch((err) => {
      console.error(`[arco] rehydrate failed for ${workflowId.slice(0, 8)}:`, err);
    });
    // DEBAG (docs/PROVIDERS.md) - re-surface any review gate that was
    // pending across a server restart, independent of the event-replay cursor.
    const gateCwd = wf.config.workingDirectory;
    if (gateCwd) {
      rehydrateGatesOnce(workflowId, gateCwd).catch((err) => {
        console.error(`[arco] [${workflowId.slice(0, 8)}] gate rehydrate failed:`, err);
      });
    }
  }
}

// Materialize a cluster member's client-side job on demand. Fires when the
// client renders a member in the roster (cluster_state) but has no local job for
// it — a member that never took a turn before a server restart, so it was never
// persisted and couldn't ride the reconnect `rehydrate_workflows` (the client
// lacks its config). Roster and per-member jobs are decoupled, so without this
// the member's transcript pane is stuck on "AWAITING REHYDRATE…" forever, and
// any turns it runs post-restart are invisible (their events fan out to the
// cluster observer but land on no job). Send workflow_created (config) first,
// then replay from seq 0 — rehydrateOneWorkflow filters the workflow_created
// event out of the replay so it doesn't clobber the freshly-created job.
export async function handleClusterMemberRehydrate(
  ws: WebSocket,
  _session: Session,
  clusterId: string,
  workflowId: string,
): Promise<void> {
  // Membership guard — only materialize a workflow that is actually a member of
  // the named cluster. The client only ever requests roster ids; this is
  // defense-in-depth so the message can't be used to open an arbitrary tab.
  const members = clusterStore.getMembers(clusterId);
  if (!members || !members.includes(workflowId)) {
    console.log(`[arco] [${workflowId.slice(0, 8)}] cluster_member_rehydrate: not a member of cluster ${clusterId.slice(0, 8)} — ignoring`);
    return;
  }
  let wf = workflows.get(workflowId);
  if (!wf) {
    // Not registered in memory. After a restart the workflows map fills lazily
    // from client rehydrate_workflows, and a member whose config no connected
    // client holds — a stale-localStorage twin (same display name, different id)
    // or a member that never ran under this server lifetime — is never
    // registered, so its transcript can't be materialized and its pane is stuck
    // on "AWAITING REHYDRATE…". (Eager boot registration usually beats us here;
    // this stays as the on-demand safety net + the dynamic-add path.)
    const cluster = await clusterStore.readCluster(clusterId).catch(() => null);
    const cwd = cluster?.cwd;
    if (!cwd) {
      console.log(`[arco] [${workflowId.slice(0, 8)}] cluster_member_rehydrate: no cwd for cluster ${clusterId.slice(0, 8)}`);
      return;
    }
    const materialized = await materializeMemberFromMeta(cwd, workflowId, ws);
    if (!materialized) {
      console.log(`[arco] [${workflowId.slice(0, 8)}] cluster_member_rehydrate: no meta.json under ${cwd} — cannot reconstruct`);
      return;
    }
    wf = materialized;
    console.log(`[arco] [${workflowId.slice(0, 8)}] cluster_member_rehydrate: materialized "${wf.config.name}" from meta (${wf.primary.provider}) — was unregistered`);
  }
  // The cluster subscribe already added this ws to wf.observers; re-add
  // defensively so live events reach it regardless of message ordering.
  wf.observers.add(ws);
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'workflow_created', workflowId, config: wf.config }));
  // No local job ⇒ no local history: tail-first, same as a mirrored tab.
  await rehydrateOneWorkflow(ws, workflowId, wf, 0, { tail: true });
}

// Reconstruct a cluster member's WorkflowState from its persisted meta.json and
// register it in the `workflows` map. Shared by the on-demand
// `cluster_member_rehydrate` handler (which passes the requesting ws so live
// events fan out to it) and eager boot registration (no ws — replay/observer
// attach happens later when a client subscribes). Idempotent: an
// already-registered member returns its existing state (adding the observer if
// one is passed). Returns null when meta.json is missing (a deleted workflow
// still lingering in a roster). config reconstruction (incl. all transport +
// toggle fields) lives in `workflowConfigFromMeta` so this and the normal
// rehydrate path can't drift.
export async function materializeMemberFromMeta(
  cwd: string,
  workflowId: string,
  observer?: WebSocket,
): Promise<WorkflowState | null> {
  const existing = workflows.get(workflowId);
  if (existing) {
    if (observer) existing.observers.add(observer);
    return existing;
  }
  const meta = await readMeta(cwd, workflowId).catch(() => null);
  if (!meta) return null;
  // Re-check after the await — the boot scan runs fire-and-forget concurrently
  // with client reconnects, so a `rehydrate_workflows` (carrying the client's
  // FULL config) may have registered this member while we were reading meta.
  // Clobbering it would drop the client's observer (→ frozen pane, the exact
  // symptom this fixes) and reset a possibly in-flight WorkerManager (→ defeated
  // busy guard). The top-of-function guard fires BEFORE the await, so this
  // second check is what actually closes the TOCTOU window.
  const raced = workflows.get(workflowId);
  if (raced) {
    if (observer) raced.observers.add(observer);
    return raced;
  }
  const config = workflowConfigFromMeta(meta, cwd);
  const primary = derivePrimaryConfig(config);
  workflows.set(workflowId, {
    config,
    busy: false,
    manager: new WorkerManager(),
    primary,
    queue: { steering: [], followUp: [] },
    observers: new Set(observer ? [observer] : []),
    autoHandoff: deriveAutoHandoff(config),
    lastContextPercent: 0,
    previewHistory: meta.previewHistory ? [...meta.previewHistory] : [],
    // Config came from meta.json (client-only fields absent: advanced/fastMode/
    // allowedProviders/skipPermissions). A client `rehydrate_workflows` with the
    // full config upgrades this on reconnect — see handleRehydrateWorkflows.
    bootMaterialized: true,
  });
  const wf = workflows.get(workflowId)!;
  workflowCwds.set(workflowId, cwd);
  try { await initWorkflowStore(cwd, workflowId); } catch { /* replay reads disk directly */ }
  // State-side fields the normal rehydrate path restores (handleRehydrateWorkflows).
  if (meta.disableRssGuard) wf.disableRssGuard = true;
  if (meta.calibration) {
    wf.calibration = {
      ratio: meta.calibration.ratio,
      overhead: meta.calibration.overhead,
      zonesCalibrated: new Set(),
      lastGroundTruth: meta.calibration.lastGroundTruth,
    };
  }
  if (meta.preview) wf.preview = { ...meta.preview };
  if (meta.planId) wf.planId = meta.planId;
  // Restore the latest CLI session for this provider so a subsequent turn
  // resumes the member's session instead of starting fresh.
  const latest = [...(meta.cliSessions ?? [])].reverse().find((s) => s.provider === primary.provider);
  if (latest) wf.primarySessionId = latest.sessionId;
  return wf;
}

// Eager boot-time registration of every persisted cluster member. The
// `workflows` map fills lazily from client rehydrate_workflows, so a member no
// connected client holds a config for was never registered — its pane stuck on
// "AWAITING REHYDRATE…", its post-restart turns landed on no job, and the
// idle-nudger / auto-turn `resolveMembers` closures couldn't see its real busy
// state. This makes the map complete right after boot. Failure-isolated per
// member. `loadAllClustersFromDisk` also warms clusterStore's memberIndex so a
// member's first post-restart turn resolves its clusterId (peer-tool wiring).
export async function registerAllClusterMembersOnBoot(): Promise<number> {
  const clusters = await clusterStore.loadAllClustersFromDisk();
  let n = 0;
  for (const cluster of clusters) {
    for (const wfid of cluster.members) {
      if (workflows.get(wfid)) continue; // already registered (client beat us)
      const wf = await materializeMemberFromMeta(cluster.cwd, wfid).catch(() => null);
      if (wf) n++;
    }
  }
  return n;
}

// Byte window for a mirrored tab's first replay in a new browser. Roughly the
// last few dozen turns — comparable to the 200 messages a browser keeps.
const TAIL_REPLAY_BYTES = 3 * 1024 * 1024;
const MAX_GAP_REPLAY_EVENTS = 5000;
const TASK_LIFECYCLE_TYPES = ['task_started', 'task_status'] as const;

// Above this, a reconnect replay streams per-event (matches live delivery and
// every existing smoke expectation). At or beyond it, the whole gap ships as
// one replay_batch — see the comment at the use site.
const REPLAY_BATCH_THRESHOLD = 200;

export async function rehydrateOneWorkflow(
  ws: WebSocket,
  workflowId: string,
  wf: WorkflowState,
  clientLastSeq: number,
  opts: { tail?: boolean } = {},
): Promise<void> {
  const cwd = wf.config.incognito ? '' : wf.config.workingDirectory;
  let snapshotOnly = false;
  let snapshotReason: string | undefined;

  if (cwd && (opts.tail || clientLastSeq === 0)) {
    // First sight of this workflow in this browser (mirrored tab, missing
    // member job, or a job that never received a seq): recent tail only — see
    // replayTailEvents. Identical to a full replay when the log is small. One
    // batch — the client ingests it atomically.
    const { events, truncated } = await replayTailEvents(cwd, workflowId, TAIL_REPLAY_BYTES);
    const filtered = events.filter((ev) => (ev as { type?: string }).type !== 'workflow_created');
    if (ws.readyState === WebSocket.OPEN) {
      if (truncated) {
        // Raw ws.send, not send(): a per-browser notice, never persisted.
        ws.send(JSON.stringify({
          type: 'system_notice',
          workflowId,
          content: '[MIRRORED] Showing this tab\'s recent history. Earlier turns are on disk — see the HISTORY tab.',
        }));
      }
      if (filtered.length > 0) ws.send(JSON.stringify({ type: 'replay_batch', workflowId, events: filtered }));
    }
    console.log(`[arco] [${workflowId.slice(0, 8)}] tail-replayed ${filtered.length} events${truncated ? ' (truncated)' : ''}`);
    if (truncated) {
      // Phase 7b task lifecycle from before the window — see the full-replay
      // branch below for why these are always re-sent.
      const firstTailSeq = (filtered[0] as { seq?: number } | undefined)?.seq ?? Infinity;
      for (const ev of await scanEventsOfTypes(cwd, workflowId, TASK_LIFECYCLE_TYPES).catch(() => [])) {
        const t = (ev as { type?: string }).type;
        if (t !== 'task_started' && t !== 'task_status') continue;
        if (((ev as { seq?: number }).seq ?? 0) >= firstTailSeq) break;
        if (ws.readyState !== WebSocket.OPEN) break;
        ws.send(JSON.stringify(ev));
      }
    }
  } else if (cwd) {
    // Rotation check: if the first seq on disk is higher than clientLastSeq+1,
    // the client missed events that have rolled out. Snapshot-only fallback.
    const firstSeq = await readWorkflowFirstSeq(cwd, workflowId);
    if (firstSeq !== null && clientLastSeq + 1 < firstSeq) {
      snapshotOnly = true;
      snapshotReason = 'events-rotated';
    } else {
      let events = (await replayWorkflowEvents(cwd, workflowId, clientLastSeq))
        // A replayed workflow_created would clobber the client's JobState
        // (createJob resets messages) — same skip as the resume-replay path
        // in workflowHandlers.
        .filter((ev) => (ev as { type?: string }).type !== 'workflow_created');
      if (events.length > MAX_GAP_REPLAY_EVENTS) {
        // A near-total gap (a browser that barely saw this tab) — the full
        // batch can be hundreds of MB on the wire. Same tail-first treatment.
        events = (await replayTailEvents(cwd, workflowId, TAIL_REPLAY_BYTES)).events
          .filter((ev) => (ev as { type?: string }).type !== 'workflow_created')
          .filter((ev) => ((ev as { seq?: number }).seq ?? 0) > clientLastSeq);
      }
      if (events.length > 0) {
        console.log(`[arco] [${workflowId.slice(0, 8)}] replaying ${events.length} events since seq ${clientLastSeq}`);
        if (events.length > REPLAY_BATCH_THRESHOLD) {
          // Big gap (long disconnect, or a restored member whose first live
          // delivery was interrupted): one atomic replay_batch instead of N
          // bare events. Streaming thousands of events lets the client's
          // persisted lastSeq outrun its debounced chat persistence — the
          // 2026-06-12 blank-workers bug. The batch ingests in one client
          // task, so it's all-or-nothing. Small gaps keep the per-event path
          // (zero behavioral change for the common reconnect).
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'replay_batch', workflowId, events }));
          }
        } else {
          for (const ev of events) {
            if (ws.readyState !== WebSocket.OPEN) break;
            ws.send(JSON.stringify(ev));
          }
        }
      }
      // Phase 7b — task lifecycle re-broadcast. The gated replay above
      // skips anything with seq <= clientLastSeq, but task_started /
      // task_status are the only path TaskCard / TasksPanel get their
      // settled state — and on a refresh after the fan-out finishes,
      // every lifecycle event has already been seen by the client's
      // lastSeq, so they all get filtered out and the cards fall back
      // to the 'running' default. Always re-send them regardless of
      // clientLastSeq; recordTaskStarted/recordTaskStatus on the client
      // are idempotent (start preserves the existing entry's settled
      // fields; status no-ops without a prior start, then overrides).
      const allEvents = await scanEventsOfTypes(cwd, workflowId, TASK_LIFECYCLE_TYPES);
      for (const ev of allEvents) {
        const seq = (ev as { seq?: number }).seq;
        if (typeof seq === 'number' && seq > clientLastSeq) continue;
        const t = (ev as { type?: string }).type;
        if (t !== 'task_started' && t !== 'task_status') continue;
        if (ws.readyState !== WebSocket.OPEN) break;
        ws.send(JSON.stringify(ev));
      }
    }
  }

  const lastSeq = cwd ? await getWorkflowHeadSeq(cwd, workflowId) : 0;
  const zaiTransport: 'native' | 'appserver' = wf.config.zaiTransport === 'appserver' ? 'appserver' : 'native';
  let latestNativeLastPromptTokens: number | undefined;
  if (cwd && wf.primary.provider === 'zai' && zaiTransport === 'native') {
    const allEvents = await scanEventsOfTypes(cwd, workflowId, ['primary_complete']).catch(() => []);
    for (const ev of allEvents) {
      const evt = ev as { type?: string; lastPromptTokens?: number };
      if (evt.type === 'primary_complete' && typeof evt.lastPromptTokens === 'number' && evt.lastPromptTokens > 0) {
        latestNativeLastPromptTokens = evt.lastPromptTokens;
      }
    }
  }
  const snapshotAccount = wf.primary.provider === 'codex'
    ? await resolveProviderAccount('codex', wf.config.providerAccountRef, cwd).catch(() => null)
    : null;
  const codexSnapshot = (wf.primary.provider === 'codex' || (wf.primary.provider === 'zai' && zaiTransport === 'appserver')) && wf.primarySessionId
    ? await latestCodexTokenSnapshot(wf.primarySessionId, snapshotAccount?.codexHome).catch(() => null)
    : null;
  const codexSnapshotWindow = wf.primary.provider === 'zai'
    ? zaiModelContextWindow(wf.primary.model)
    : codexSnapshot?.modelContextWindow;
  const computerState = isComputer(wf) ? await computerContextState(workflowId, wf) : undefined;
  const msg: ServerMessage = {
    type: 'workflow_state_snapshot',
    workflowId,
    workers: {},
    busy: wf.busy,
    transcriptTail: [],
    operatorQuestions: pendingOperatorQuestions(workflowId),
    lastSeq,
    ...(snapshotOnly ? { snapshotOnly: true, snapshotReason } : {}),
    ...(wf.primary.provider === 'claude' && wf.primarySessionId ? { claudeSessionId: wf.primarySessionId } : {}),
    ...(sessionMetadataForWorkflow(wf) ? { sessionMetadata: sessionMetadataForWorkflow(wf) } : {}),
    ...(latestNativeLastPromptTokens
      ? { lastTurnTokens: { input: latestNativeLastPromptTokens, output: 0, cacheRead: 0, cacheCreate: 0 } }
      : codexSnapshot?.tokens ? { lastTurnTokens: codexSnapshot.tokens } : {}),
    ...(typeof codexSnapshotWindow === 'number' ? { modelContextWindow: codexSnapshotWindow } : {}),
  };
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    if (computerState) send(ws, { type: 'computer_context_updated', workflowId, state: computerState,
      fresh: !!computerState.lastResetAt && !wf.primarySessionId });
  }
  // Genesis seed state can exist only on WorkflowConfig during a from-nothing
  // scratch run. Rehydrate the normalized UI fields too, otherwise a reconnect
  // can show a scratch workflow as an ordinary tab until the operator edits.
  if (wf.config.genesisSeed && ws.readyState === WebSocket.OPEN) {
    send(ws, {
      type: 'genesis_seed_updated',
      workflowId,
      seed: wf.config.genesisSeed,
      readiness: assessGenesisReadiness(wf.config.genesisSeed),
      nextPrompt: nextFieldPrompt(wf.config.genesisSeed),
    });
  }

  // Phase 1 — start (or restart) the Claude session JSONL watcher after the
  // snapshot. Historical entries go to `ws`; new entries fan out to all
  // observers. Re-starting here handles the case where the watcher was never
  // started (server restart between sessions) or the session rotated.
  if (cwd) startSessionWatcher(workflowId, wf, cwd, ws);

  // Phase 2 — emit a context estimate immediately so the client has a fill
  // reading as soon as the snapshot arrives (not only after the next turn).
  if (cwd && wf.primary.provider === 'claude' && wf.primarySessionId) {
    estimateContextFill(cwd, wf.primarySessionId, wf.primary.model, wf.calibration).then((est) => {
      if (!est) return;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'context_usage', workflowId, ...est, claudeSessionId: wf.primarySessionId }));
      }
    }).catch(() => { /* best-effort */ });
  } else if (wf.primary.provider === 'zai' && zaiTransport === 'native' && latestNativeLastPromptTokens) {
    const est = promptContextEstimate(latestNativeLastPromptTokens, zaiModelContextWindow(wf.primary.model));
    if (est && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'context_usage', workflowId, ...est }));
    }
  }

  // Re-emit plan_attached so the rehydrated client knows the active plan
  // even if its events.jsonl-replay context was rotated/truncated. meta.json
  // is the source of truth; this is just the wire echo.
  if (cwd && wf.planId) {
    const summary = await readPlanSummary(cwd, wf.planId).catch(() => null);
    if (summary) {
      broadcastWorkflow(workflowId, {
        type: 'plan_attached',
        workflowId,
        planId: summary.id,
        title: summary.title,
        updatedAt: summary.updatedAt,
      });
    }
  }

  // docs/ARCHITECTURE.md - push the cwd's task-ledger snapshot so a
  // reconnecting client mirrors the persisted ledger without an explicit list
  // request (consistent with the plan/preview wire echoes above). cwd-scoped;
  // fired per rehydrated workflow.
  if (cwd) {
    void sendTaskLedgerSnapshot(workflowId).catch(() => { /* best-effort */ });
  }

  // §K2 — re-emit the live terminal session list so a reconnecting client
  // recovers its switcher. terminal_opened is only broadcast at spawn time and
  // PTYs don't survive a server restart, so the ptyManager pool is the source
  // of truth; send only the sessions that are actually still alive. Per-socket
  // (the reconnecting ws) — matches the rehydrate fan-out posture.
  const liveSessions = ptyManager.infoForWorkflow(workflowId);
  if (liveSessions.length > 0 && ws.readyState === WebSocket.OPEN) {
    send(ws, { type: 'terminal_sessions', workflowId, sessions: liveSessions });
  }

  // Same shape for the Preview tab — wire echo so rehydrated clients restore
  // the iframe target without waiting for the operator to re-bind.
  if (wf.preview) {
    broadcastWorkflow(workflowId, {
      type: 'preview_set',
      workflowId,
      port: wf.preview.port,
      framework: wf.preview.framework,
      manual: wf.preview.manual,
      // Hydration replay — see handleCreateWorkflow comment.
      freshlyBound: false,
    });
  }
}
