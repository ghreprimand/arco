import { retiredProviderReason } from '@arco/shared';
import { isKnownProvider } from '../providers/index.js';
import { publishWorkerActivity } from './turnEngine.js';
import { clearPrivateWatches } from '../voice/watches.js';
// server/src/ws/workflowHandlers.ts — workflow-lifecycle WS handler region
// extracted from index.ts (docs/ARCHITECTURE.md). Behavior-
// preserving, move-only. The two index.ts-local back-edges (the
// PreviewAutoDetect instance and handleRehydrateWorkflows, which lives in the
// handoff handler module) are injected once at startup via initWorkflowHandlers
// to avoid a cycle with the entry point and with handoffHandlers.
import { workspaceCloseWorkflow } from '../workspace.js';
import type {
  PreviewHistoryEntry,
  WorkflowConfig,
} from '@arco/shared';
import { classifyBranchSource } from '@arco/shared';
import { disposeClaudeNativeWorker } from '../providers/claude-native/index.js';
import { WebSocket } from 'ws';
import * as clusterPlanBridge from '../clusterPlanBridge.js';
import * as clusterStore from '../clusterStore.js';
import { estimateContextFill, nativeContextEstimate, promptContextEstimate } from '../contextEstimator.js';
import { createCheckpoint, revertToCheckpoint } from '../gitSnapshots.js';
import { rememberCwd } from '../crashRecovery.js';
import { genesisScratchDir } from '../genesis/scaffold.js';
import { CHAT_PROVIDERS, INCOGNITO_CHAT_PROVIDERS, chatStorageDir, incognitoChatCwd, isChatWorkflow } from '../chatMode.js';
import { registerPrivateLogToken } from '../server/logger.js';
import { assessGenesisReadiness } from '../genesis/stages.js';
import { nextFieldPrompt } from '../genesis/prompts.js';
import * as mcpConfigWriter from '../mcp/mcpConfigWriter.js';
import {
  closeOpenSpansForWorkflow,
  readPlanSummary,
  recordAttachment,
} from '../planStore.js';
import type { PreviewAutoDetect } from '../previewAutoDetect.js';
import { buildClusterPlanReviewContent, buildPlanReviewContent, buildPreviewCaptureReviewContent, buildReviewContent } from '../primitives/reviewContent.js';
import { runReviewer } from '../primitives/runReviewer.js';
import { runResearch } from '../primitives/runResearch.js';
import { runDocEdit } from '../primitives/runDocEdit.js';
import { runMdTuneup, backupAndWriteInstructionFile, discoverInstructionFiles } from '../primitives/runMdTuneup.js';
import { resolveWithinCwd } from '../providers/ollamaTools.js';
import { RESEARCH_MAX_ROUNDS_CEILING } from '@arco/shared';
import { probeHardware, simulatedProfile } from '../cookbook/hardware.js';
import { searchCatalog } from '../cookbook/catalog.js';
import { buildRecommendationTopic, filterCandidatesForProfile } from '../cookbook/recommend.js';
import { pullHfGguf, pullOllama, type DownloadProgress } from '../cookbook/install.js';
import { summarizeWorkflow } from '../recall/summarize.js';
import { getRecallIndex } from '../recall/index.js';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { artifactsDir } from '../workers/limits.js';
import { resolveProviderAccount } from '../providerAccounts.js';
import { destroySandbox } from '../providers/claude-native/sandboxStore.js';
import { disposeProviderResources } from '../providers/index.js';
import { ptyManager } from '../terminal/ptyManager.js';
import { recordContextUsage,
  acquirePlansWatcher,
  broadcastCluster,
  broadcastHandoffLockSnapshot,
  broadcastWorkflow,
  buildClusterStatePayload,
  handoffLockSnapshot,
  notifyClusterStateForWorkflow,
  releasePlansWatcher,
  send,
} from '../server/broadcast.js';
import {
  PREVIEW_HISTORY_MAX,
  SESSION_HISTORY_PAGE_SIZE,
  UUID_PATTERN,
} from '../server/constants.js';
import {
  cwdHandoffChain,
  sessions,
  workflowCwds,
  workflows,
} from '../server/state.js';
import {
  acquireProjectSettingsWatcher,
  releaseProjectSettingsWatcher,
  readSettings,
} from '../settings.js';
import {
  latestCliSessionFor,
  listWorkflowMetas,
  readMeta,
  reconcileLatestCliSession,
  writeMeta,
  type WorkflowMeta,
} from '../workflowMeta.js';
import {
  getHeadSeq as getWorkflowHeadSeq,
  initWorkflowStore,
  replayEvents as replayWorkflowEvents,
} from '../workflowStore.js';
import type {
  QueueItem,
  Session,
} from '../workflows/types.js';
import { WorkerManager } from '../workers/WorkerManager.js';
import * as stuckBreaker from '../workers/stuckBreaker.js';
import { catalogDriftProbe, dropClusterWorkflowState, syncMcpConfigForWorkflow } from './clusterHandlers.js';
import { checkModelDrift, driftFlag } from '../primitiveDrift.js';
import {
  applyAutoHandoffDefault,
  applyClaudeNativeCompactDefault,
  broadcastQueueUpdate,
  deriveAutoHandoff,
  deriveAutoFold,
  derivePrimaryConfig,
  disarmGoalRun,
  persistInitialMeta,
  revokeBusy,
  startSessionWatcher,
  toSessionEntries,
} from './turnEngine.js';

export interface WorkflowHandlerDeps {
  previewAutoDetect: PreviewAutoDetect;
  handleRehydrateWorkflows: (
    ws: WebSocket,
    session: Session,
    entries: Array<{ workflowId: string; config: WorkflowConfig; currentSessionId: string; lastSeq?: number }>,
  ) => Promise<void>;
}
let deps: WorkflowHandlerDeps;
export function initWorkflowHandlers(d: WorkflowHandlerDeps): void { deps = d; }

export async function handleCreateWorkflow(ws: WebSocket, session: Session, config: WorkflowConfig): Promise<void> {
  let workflowId: string | undefined;
  let resumed = false;
  let resumeWorkflowMeta: WorkflowMeta | null = null;

  if (config.incognito && config.kind !== 'chat') {
    send(ws, { type: 'error', message: 'Incognito is available only in Chat mode.' });
    return;
  }
  if (config.incognito && (config.resumeWorkflowId || config.resumeSessionId)) {
    send(ws, { type: 'error', message: 'An incognito Chat cannot resume a saved workflow or provider session.' });
    return;
  }
  // Past Chat paths are server-owned. Never trust the caller to select an
  // arbitrary cwd for a global conversation reopen.
  if (config.kind === 'chat' && config.resumeWorkflowId) {
    config.workingDirectory = chatStorageDir(config.resumeWorkflowId);
  }

  if (config.resumeWorkflowId) {
    if (!UUID_PATTERN.test(config.resumeWorkflowId)) {
      send(ws, { type: 'error', message: `Invalid resume workflow id: ${config.resumeWorkflowId}` });
      return;
    }
    if (!config.workingDirectory) {
      send(ws, { type: 'error', message: 'Cannot resume an Arco workflow without a working directory.' });
      return;
    }
    const saved = await readMeta(config.workingDirectory, config.resumeWorkflowId).catch(() => null);
    if (!saved) {
      send(ws, { type: 'error', message: `Arco workflow ${config.resumeWorkflowId.slice(0, 8)} was not found.` });
      return;
    }
    if (config.kind === 'chat' && saved.kind !== 'chat') {
      send(ws, { type: 'error', message: `Saved Chat ${config.resumeWorkflowId.slice(0, 8)} was not found.` });
      return;
    }
    resumeWorkflowMeta = saved;
    const hasClaudeCliSession = saved.cliSessions.some((s) => s.provider === 'claude');
    workflowId = saved.workflowId;
    resumed = true;
    const legacyClaudeNativeCompact = saved.claudeNativeCompact === true && typeof saved.claudeNativeCompactUserSetAt !== 'number';
    const restoredClaudeNativeCompact = legacyClaudeNativeCompact ? false : saved.claudeNativeCompact;
    if (legacyClaudeNativeCompact) {
      saved.claudeNativeCompact = false;
      saved.lastActiveAt = Date.now();
      await writeMeta(config.workingDirectory, saved).catch((err) => {
        console.error(`[arco] [${saved.workflowId.slice(0, 8)}] legacy claude.native.compact migration failed:`, err);
      });
    }
    config = {
      ...config,
      name: saved.name,
      primaryProvider: saved.primaryProvider,
      primaryModel: saved.primaryModel,
      primaryEffort: saved.primaryEffort,
      ...(saved.providerAccountRef ? { providerAccountRef: saved.providerAccountRef } : {}),
      ...(saved.claudeTransport
        ? { claudeTransport: saved.claudeTransport }
        : saved.primaryProvider === 'claude' && !hasClaudeCliSession
          ? { claudeTransport: 'native' as const }
          : {}),
      ...(saved.codexTransport ? { codexTransport: saved.codexTransport } : {}),
      ...(saved.codexContextPolicy ? { codexContextPolicy: saved.codexContextPolicy } : {}),
      ...(saved.computerContext ? { computerContext: saved.computerContext } : {}),
      ...(saved.ultracode === true ? { ultracode: true } : {}),
      ...(typeof saved.webSearchMaxUses === 'number' ? { webSearchMaxUses: saved.webSearchMaxUses } : {}),
      ...(typeof restoredClaudeNativeCompact === 'boolean' ? { claudeNativeCompact: restoredClaudeNativeCompact } : {}),
      ...(saved.efficiencyToolFilter ? { efficiencyToolFilter: saved.efficiencyToolFilter } : {}),
      ...(saved.efficiencyFactForce ? { efficiencyFactForce: saved.efficiencyFactForce } : {}),
      ...(saved.efficiencyConfigProtection ? { efficiencyConfigProtection: saved.efficiencyConfigProtection } : {}),
      ...(saved.efficiencySandbox ? { efficiencySandbox: saved.efficiencySandbox } : {}),
      ...(saved.reviewSafeMode ? { reviewSafeMode: saved.reviewSafeMode } : {}),
      ...(saved.outputStyle === 'normal' || saved.outputStyle === 'lite' || saved.outputStyle === 'terse'
        ? { outputStyle: saved.outputStyle }
        : saved.outputStyle === 'caveman'
          ? { outputStyle: 'terse' as const }
          : {}),
      // docs/GOTCHAS.md - restore the operator's north-star across restart
      // (into the client-bound config too, so a fresh client sees it).
      ...(typeof saved.goal === 'string' && saved.goal.trim() ? { goal: saved.goal } : {}),
      ...(saved.pinnedSkills?.length
        ? { pinnedSkills: saved.pinnedSkills.map((s) => ({ ...s })) }
        : {}),
      ...(saved.ollamaParams && typeof saved.ollamaParams === 'object'
        ? { ollamaParams: saved.ollamaParams }
        : {}),
    };
  }

  const provider = config.primaryProvider ?? 'claude';
  if (!isKnownProvider(provider)) {
    send(ws, { type: 'error', message: retiredProviderReason(provider) ?? `Unsupported provider: ${provider}` });
    return;
  }
  const primary = derivePrimaryConfig(config);
  const manager = new WorkerManager();
  // docs/PROVIDERS.md - fact-force defaults OFF for new tabs.
  // Stamp the choice so the workflow_created echo, CONFIG UI, and first
  // meta.json write agree. Explicit client values still win.
  if (config.efficiencyFactForce === undefined && !config.resumeSessionId && !config.resumeWorkflowId) {
    config.efficiencyFactForce = 'off';
  }
  // Global auto-handoff + Claude-Native-compaction defaults (mirror of
  // TRANSPORT DEFAULTS). Seeds NEW tabs only — a resumed tab restores its
  // persisted values from meta below, and an explicit per-tab config always
  // wins. Baked into config (rather than passed downstream) so it flows to
  // meta + the workflow_created echo and the CONFIG-tab renders the right
  // state before the operator's first interaction. Only the cascade read is
  // shared; each default still only seeds when the operator set a global,
  // otherwise the hardcoded fallback applies (zero behavior change).
  const seedCascade = (!config.resumeSessionId && !config.resumeWorkflowId)
    ? await readSettings(config.workingDirectory).catch(() => null)
    : null;

  // Claude Native server-side compaction defaults OFF (NATIVE_COMPACTION_PLAN
  // §1). A persisted or UI-supplied explicit value still wins; otherwise the
  // global settings default seeds it, otherwise hardcoded false.
  applyClaudeNativeCompactDefault(config, seedCascade?.claudeNativeCompactDefault);


  if (!config.resumeSessionId && !config.resumeWorkflowId) {
    // WP5 — seed the mode from the global default. Leave summarizer unseeded
    // unless a caller supplied one so later handoffSummarizer changes still
    // reach tabs that never set a per-tab override.
    applyAutoHandoffDefault(config, seedCascade?.autoHandoffDefaults);
  }

  let resumeSessionId: string | undefined;
  if (resumeWorkflowMeta) {
    resumeSessionId = latestCliSessionFor(resumeWorkflowMeta, primary.provider)?.sessionId;
  }

  if (config.resumeSessionId) {
    if (!UUID_PATTERN.test(config.resumeSessionId)) {
      send(ws, { type: 'error', message: `Invalid resume session id: ${config.resumeSessionId}` });
      return;
    }
    resumeSessionId = config.resumeSessionId;

    // If an Arco workflow in this cwd already owns this native session,
    // reuse its wfid so the resumed tab writes into the same events.jsonl
    // and inherits any existing handoff/history state.
    if (config.workingDirectory) {
      try {
        const metas = await listWorkflowMetas(config.workingDirectory);
        for (const summary of metas) {
          const full = await readMeta(config.workingDirectory, summary.workflowId);
          if (!full) continue;
          if (full.cliSessions.some((s) => s.sessionId === resumeSessionId)) {
            workflowId = full.workflowId;
            resumed = true;
            if (full.providerAccountRef && !config.providerAccountRef) {
              config.providerAccountRef = full.providerAccountRef;
            }
            break;
          }
        }
      } catch {
        /* fall through to fresh wfid */
      }
    }
  }

  if (!workflowId) workflowId = crypto.randomUUID();

  if (config.incognito) registerPrivateLogToken(workflowId);

  if (config.kind === 'chat') {
    if (!CHAT_PROVIDERS.has(primary.provider)) {
      send(ws, { type: 'error', message: `${primary.provider} is not available in Chat mode.` });
      return;
    }
    if (config.incognito && !INCOGNITO_CHAT_PROVIDERS.has(primary.provider)) {
      send(ws, { type: 'error', message: `${primary.provider} cannot guarantee a non-persistent CLI session in Incognito Chat.` });
      return;
    }
    if (config.voiceOperator) {
      if (!['codex', 'claude', 'ollama', 'strata'].includes(primary.provider)) {
        send(ws, { type: 'error', message: 'Computer supports Codex, Claude, Ollama and Strata.' }); return;
      }
      config.chatWebAccess = false;
      if (primary.provider === 'codex') config.codexTransport = 'appserver';
      if (primary.provider === 'claude') config.claudeTransport = 'native';
      config.computerContext ??= { keepContext: false, resets: 0 };
    }
    config.skipPermissions = false;
    if (config.incognito) {
      // A provider process still needs an existing cwd. The bare OS temp root
      // is shared + world-writable (another user's /tmp/CLAUDE.md, AGENTS.md,
      // .claude/settings.json got loaded as project config), so use the
      // per-process 0700 dir. Still never registered as a persistence cwd, and
      // Arco creates no per-conversation directory or files.
      config.workingDirectory = incognitoChatCwd();
      // Strict privacy wins over any stale/crafted client config: an incognito
      // workflow is never eligible for management-hub snapshots or remote
      // interaction surfaces.
      config.remoteEnabled = false;
      config.remoteGatesEnabled = false;
      // Computer uses thread/start ephemeral:true; ordinary private Chat stays exec.
      if (primary.provider === 'codex') config.codexTransport = config.voiceOperator ? 'appserver' : 'exec';

    } else {
      try {
        config.workingDirectory = chatStorageDir(workflowId);
        await fsPromises.mkdir(config.workingDirectory, { recursive: true });
      } catch (err) {
        console.error('[arco] chat storage dir create failed:', err);
        send(ws, { type: 'error', message: 'Could not create the private Chat storage directory.' });
        return;
      }
    }
  }

  // docs/ARCHITECTURE.md - from-nothing Genesis. A workflow created with a
  // genesis seed and no working directory runs the staged conversation in a
  // hidden scratch dir until `genesis_scaffold` creates the real project and
  // rebinds the cwd. Assign the scratch cwd here so the rest of creation (store
  // init, meta, turns) treats it as an ordinary cwd — the turn engine requires
  // one (turnEngine.ts guards on it). The mutated config.workingDirectory is
  // echoed back in `workflow_created`, so the client persists the scratch path
  // and re-sends it on rehydrate; `genesis_scaffold` later broadcasts
  // `workflow_cwd_bound` with the real dir to repoint it.
  if (config.genesisSeed && !config.workingDirectory) {
    const scratch = genesisScratchDir(workflowId);
    try {
      await fsPromises.mkdir(scratch, { recursive: true });
      config.workingDirectory = scratch;
    } catch (err) {
      console.error('[arco] genesis scratch dir create failed:', err);
    }
  }

  // Reuse any existing WorkflowState for this wfid (resume picker onto a
  // claimed Arco workflow lands here). Preserves in-flight turn state
  // if somehow the workflow was still alive from a prior session.
  const existing = workflows.get(workflowId);
  if (existing) {
    if (existing.incognitoCleanupTimer) {
      clearTimeout(existing.incognitoCleanupTimer);
      existing.incognitoCleanupTimer = undefined;
    }
    existing.observers.add(ws);
    existing.config = config;
    if (resumeSessionId && !existing.primarySessionId) existing.primarySessionId = resumeSessionId;
  } else {
    workflows.set(workflowId, {
      config,
      busy: false,
      manager,
      primary,
      primarySessionId: resumeSessionId,
      ...(config.incognito ? { incognitoEvents: [] } : {}),
      queue: { steering: [], followUp: [] },
      observers: new Set([ws]),
      autoHandoff: deriveAutoHandoff(config),
      lastContextPercent: 0,
      previewHistory: [],
    });
  }
  session.workflowIds.add(workflowId);

  if (!config.incognito) {
    console.log(
      `[arco] Workflow ${resumed ? 'resumed' : 'created'}: "${config.name}" [${workflowId.slice(0, 8)}] | ${primary.provider}:${primary.model} @ ${primary.effort}${
        resumeSessionId ? ` | resume=${resumeSessionId.slice(0, 8)}` : ''
      }`,
    );
  }

  if (config.workingDirectory && !config.incognito) {
    workflowCwds.set(workflowId, config.workingDirectory);
    if (config.kind !== 'chat') {
      acquireProjectSettingsWatcher(config.workingDirectory);
      rememberCwd(config.workingDirectory).catch(() => { /* best-effort */ });
    }
    try {
      await initWorkflowStore(config.workingDirectory, workflowId);
      await persistInitialMeta(config.workingDirectory, workflowId, config, primary);
      if (resumeSessionId) {
        await reconcileLatestCliSession(
          config.workingDirectory,
          workflowId,
          primary.provider,
          resumeSessionId,
          config.providerAccountRef,
        );
      }
      // Restore persisted autoHandoff settings (survive server restarts).
      const savedMeta = await readMeta(config.workingDirectory, workflowId).catch(() => null);
      const wf = workflows.get(workflowId);
      // §2.1 — restore persisted auto-fold config (survives restart). Separate
      // from the autoHandoff if/else below so it applies regardless of whether
      // autoHandoff was persisted.
      if (savedMeta?.autoFold && wf) {
        wf.config.autoFold = { ...savedMeta.autoFold };
        wf.autoFold = deriveAutoFold(wf.config);
      }
      if (savedMeta?.autoHandoff) {
        if (wf) {
          wf.autoHandoff.enabled = savedMeta.autoHandoff.enabled;
          wf.autoHandoff.warnAt = savedMeta.autoHandoff.warnAt;
          wf.autoHandoff.autoAt = savedMeta.autoHandoff.autoAt;
          // WP5 — restore mode + summarizer too (resolution at fire time).
          wf.autoHandoff.mode = savedMeta.autoHandoff.mode;
          wf.autoHandoff.summarizer = savedMeta.autoHandoff.summarizer;
          wf.config.autoHandoff = { ...savedMeta.autoHandoff };
        }
      } else if (savedMeta && wf) {
        const cascade = seedCascade ?? await readSettings(config.workingDirectory).catch(() => null);
        if (applyAutoHandoffDefault(wf.config, cascade?.autoHandoffDefaults) && wf.config.autoHandoff) {
          wf.autoHandoff = deriveAutoHandoff(wf.config);
          savedMeta.autoHandoff = { ...wf.config.autoHandoff };
          savedMeta.lastActiveAt = Date.now();
          await writeMeta(config.workingDirectory, savedMeta).catch((err) => {
            console.error(`[arco] [${workflowId.slice(0, 8)}] auto-handoff default meta write failed:`, err);
          });
        }
      }
      if (savedMeta?.disableRssGuard) {
        const wf = workflows.get(workflowId);
        if (wf) wf.disableRssGuard = true;
      }
      // Phase 6e — restore per-tab Codex transport from meta so the
      // operator's choice survives reload / server restart. The cascade is
      // still consulted as the final fall-through in handleUserMessage when
      // the field is unset.
      if (savedMeta?.codexTransport === 'exec' || savedMeta?.codexTransport === 'appserver') {
        const wf = workflows.get(workflowId);
        if (wf) wf.config.codexTransport = savedMeta.codexTransport;
      }
      if (savedMeta?.codexContextPolicy === 'max' || savedMeta?.codexContextPolicy === 'standard') {
        const wf = workflows.get(workflowId);
        if (wf) wf.config.codexContextPolicy = savedMeta.codexContextPolicy;
      }
      if (savedMeta?.providerAccountRef) {
        const wf = workflows.get(workflowId);
        if (wf) wf.config.providerAccountRef = savedMeta.providerAccountRef;
      }
      // Phase 7a — same shape for the per-tab Claude transport.
      if (savedMeta?.claudeTransport === 'cli' || savedMeta?.claudeTransport === 'native') {
        const wf = workflows.get(workflowId);
        if (wf) wf.config.claudeTransport = savedMeta.claudeTransport;
      }

      // Phase 7c-followup — restore Claude Native server-side compaction toggle.
      if (typeof savedMeta?.claudeNativeCompact === 'boolean') {
        const wf = workflows.get(workflowId);
        const legacyCompact = savedMeta.claudeNativeCompact === true && typeof savedMeta.claudeNativeCompactUserSetAt !== 'number';
        if (legacyCompact) {
          savedMeta.claudeNativeCompact = false;
          savedMeta.lastActiveAt = Date.now();
          await writeMeta(config.workingDirectory, savedMeta).catch((err) => {
            console.error(`[arco] [${workflowId.slice(0, 8)}] legacy claude.native.compact migration failed:`, err);
          });
        }
        if (wf) wf.config.claudeNativeCompact = legacyCompact ? false : savedMeta.claudeNativeCompact;
      }
      if (typeof savedMeta?.claudeNativeForceInterleavedThinkingBeta === 'boolean') {
        const wf = workflows.get(workflowId);
        if (wf) wf.config.claudeNativeForceInterleavedThinkingBeta = savedMeta.claudeNativeForceInterleavedThinkingBeta;
      }
      if (savedMeta?.claudeNativeThinkingDisplay === 'omitted' || savedMeta?.claudeNativeThinkingDisplay === 'summarized') {
        const wf = workflows.get(workflowId);
        if (wf) wf.config.claudeNativeThinkingDisplay = savedMeta.claudeNativeThinkingDisplay;
      }
      // NATIVE_COMPACTION_PLAN Phase 3 — restore the opt-in auto-continue flag.
      if (typeof savedMeta?.nativeCompactAutoContinue === 'boolean') {
        const wf = workflows.get(workflowId);
        if (wf) wf.config.nativeCompactAutoContinue = savedMeta.nativeCompactAutoContinue;
      }
      // docs/PROVIDERS.md - restore the operator's
      // per-tab efficiency toggles. Stored unconditionally on the wf.config
      // so a CLI ↔ Native transport flip on the same tab picks up the last
      // pinned value.
      if (savedMeta?.efficiencyAutoCompact === 'off' || savedMeta?.efficiencyAutoCompact === 'conservative' || savedMeta?.efficiencyAutoCompact === 'aggressive') {
        const wf = workflows.get(workflowId);
        if (wf) wf.config.efficiencyAutoCompact = savedMeta.efficiencyAutoCompact;
      }
      if (savedMeta?.efficiencyToolFilter === 'off' || savedMeta?.efficiencyToolFilter === 'conservative' || savedMeta?.efficiencyToolFilter === 'aggressive') {
        const wf = workflows.get(workflowId);
        if (wf) wf.config.efficiencyToolFilter = savedMeta.efficiencyToolFilter;
      }
      // docs/PROVIDERS.md - restore an explicit saved choice.
      // Absent stays 'off', matching the new-tab default and avoiding a
      // surprise synthetic edit/retry gate on older workflows.
      if (savedMeta?.efficiencyFactForce === 'on' || savedMeta?.efficiencyFactForce === 'off') {
        const wf = workflows.get(workflowId);
        if (wf) wf.config.efficiencyFactForce = savedMeta.efficiencyFactForce;
      }
      // Config-protection write-gate. Default 'on' for all tabs (the gate is
      // a safety default); only restore a persisted explicit value so an
      // operator opt-out ('off') survives a server restart. Absent ⇒ ON.
      if (savedMeta?.efficiencyConfigProtection === 'on' || savedMeta?.efficiencyConfigProtection === 'off') {
        const wf = workflows.get(workflowId);
        if (wf) wf.config.efficiencyConfigProtection = savedMeta.efficiencyConfigProtection;
      }
      // docs/PROVIDERS.md - restore sandbox toggle. Default
      // 'off' for all tabs (existing AND new); the operator opts in via
      // the CONFIG-tab toggle.
      if (savedMeta?.efficiencySandbox === 'on' || savedMeta?.efficiencySandbox === 'off') {
        const wf = workflows.get(workflowId);
        if (wf) wf.config.efficiencySandbox = savedMeta.efficiencySandbox;
      }
      // docs/PROVIDERS.md - restore the per-tab review-gate toggle across restart.
      // Absent ⇒ leave 'off' (opt-in is explicit).
      if (savedMeta?.reviewSafeMode === 'on' || savedMeta?.reviewSafeMode === 'off') {
        const wf = workflows.get(workflowId);
        if (wf) wf.config.reviewSafeMode = savedMeta.reviewSafeMode;
      }
      // docs/PROVIDERS.md - restore the per-tab Ollama param preset
      // blob across server restart. Pinned on wf.config so the next Ollama
      // turn merges it through the allowlist; only meaningful for Ollama tabs.
      if (savedMeta?.ollamaParams && typeof savedMeta.ollamaParams === 'object') {
        const wf = workflows.get(workflowId);
        if (wf) wf.config.ollamaParams = savedMeta.ollamaParams;
      }
      // docs/PROVIDERS.md - restore the operator's per-tab output-style
      // pick across server restart. Pinned on wf.config so a transport flip
      // on the same tab keeps the value. Legacy `'caveman'` (renamed to
      // `'terse'` 2026-05-10) is auto-aliased so existing meta.json files
      // don't lose the operator's pick.
      if (savedMeta?.outputStyle === 'normal' || savedMeta?.outputStyle === 'lite' || savedMeta?.outputStyle === 'terse') {
        const wf = workflows.get(workflowId);
        if (wf) wf.config.outputStyle = savedMeta.outputStyle;
      } else if (savedMeta?.outputStyle === 'caveman') {
        const wf = workflows.get(workflowId);
        if (wf) wf.config.outputStyle = 'terse';
      }
      // docs/GOTCHAS.md - restore the per-tab north-star across restart.
      // Pinned on wf.config so the next turn's system-block builder injects it.
      // Absent / blank ⇒ leave unset (no block).
      if (typeof savedMeta?.goal === 'string' && savedMeta.goal.trim()) {
        const wf = workflows.get(workflowId);
        if (wf) wf.config.goal = savedMeta.goal;
      }
      if (savedMeta?.pinnedSkills?.length) {
        const wf = workflows.get(workflowId);
        if (wf) wf.config.pinnedSkills = savedMeta.pinnedSkills.map((s) => ({ ...s }));
      }
      // docs/PROVIDERS.md - restore the codebase-memory attach
      // intent + last-indexed snapshot. Spawn-site wiring is deferred; this
      // just makes the CONFIG toggle survive a server restart.
      if (savedMeta?.codebaseMemory && typeof savedMeta.codebaseMemory === 'object') {
        const wf = workflows.get(workflowId);
        if (wf) wf.config.codebaseMemory = { ...savedMeta.codebaseMemory };
      }
      if (savedMeta?.planId) {
        const wf = workflows.get(workflowId);
        if (wf) {
          // Verify plan body still exists; meta could outlive a deleted plan.
          const summary = await readPlanSummary(config.workingDirectory, savedMeta.planId).catch(() => null);
          if (summary) {
            wf.planId = savedMeta.planId;
            // Re-acquire the plans watcher and ensure an open attachment span
            // exists. recordAttachment is idempotent so resuming a workflow
            // whose span is already open from a prior run is a no-op.
            acquirePlansWatcher(config.workingDirectory);
            await recordAttachment(config.workingDirectory, savedMeta.planId, workflowId, wf.config.name)
              .catch(() => { /* best-effort */ });
            // The plan_attached broadcast is deferred to after the snapshot
            // emit so observers see it in the right order — see end of this
            // function.
          }
        }
      }
      if (savedMeta?.calibration) {
        const wf = workflows.get(workflowId);
        if (wf && !wf.calibration) {
          wf.calibration = {
            ratio: savedMeta.calibration.ratio,
            overhead: savedMeta.calibration.overhead,
            zonesCalibrated: new Set(),
            lastGroundTruth: savedMeta.calibration.lastGroundTruth,
          };
        }
      }
      if (savedMeta?.preview) {
        const wf = workflows.get(workflowId);
        if (wf) wf.preview = { ...savedMeta.preview };
      }
      if (savedMeta?.previewHistory) {
        const wf = workflows.get(workflowId);
        if (wf) wf.previewHistory = [...savedMeta.previewHistory];
      }
    } catch (err) {
      console.error(`[arco] workflowStore/meta init failed for ${workflowId.slice(0, 8)}:`, err);
    }
  }

  // Hydration hints so the client rebuilds chat for resumed sessions:
  //   - resumed=true: this wfid owns events.jsonl — server replays below.
  //   - unclaimed Claude/Codex session: /api/transcript (provider-aware)
  //     hydrates from the native session JSONL / rollout file.
  //   - unclaimed other-provider session: no transcript source available;
  //     the client just starts blank with a system notice.
  const hints: {
    resumedVia?: 'native';
    hydrationSource?: 'events' | 'transcript';
    priorClaudeSessionId?: string;
    priorSessionId?: string;
    priorProvider?: 'claude' | 'codex';
  } = {};
  if (resumed) {
    hints.resumedVia = 'native';
    hints.hydrationSource = 'events';
  } else if (resumeSessionId && primary.provider === 'claude') {
    hints.resumedVia = 'native';
    hints.hydrationSource = 'transcript';
    hints.priorClaudeSessionId = resumeSessionId;
    hints.priorSessionId = resumeSessionId;
    hints.priorProvider = 'claude';
  } else if (resumeSessionId && (primary.provider === 'codex')) {
    hints.resumedVia = 'native';
    hints.hydrationSource = 'transcript';
    hints.priorSessionId = resumeSessionId;
    hints.priorProvider = 'codex';
  } else if (resumeSessionId) {
    hints.resumedVia = 'native';
  }
  const wfNowForCreate = workflows.get(workflowId);
  send(ws, {
    type: 'workflow_created',
    workflowId,
    config,
    ...hints,
    ...(wfNowForCreate?.primary.provider === 'claude' && wfNowForCreate.primarySessionId
      ? { claudeSessionId: wfNowForCreate.primarySessionId }
      : {}),
  });
  // Genesis creation starts with the seed on config, but the right-panel UI
  // reads the normalized seed/readiness fields populated by genesis_seed_updated.
  // Echo it immediately so a fresh Genesis tab does not look like an ordinary
  // blank workflow until the operator edits a field.
  if (config.genesisSeed) {
    send(ws, {
      type: 'genesis_seed_updated',
      workflowId,
      seed: config.genesisSeed,
      readiness: assessGenesisReadiness(config.genesisSeed),
      nextPrompt: nextFieldPrompt(config.genesisSeed),
    });
  }

  let resumeLatestLastPromptTokens: number | undefined;
  if (resumed && config.workingDirectory) {
    try {
      const events = await replayWorkflowEvents(config.workingDirectory, workflowId, 0);
      let replayed = 0;
      for (const ev of events) {
        if (ws.readyState !== WebSocket.OPEN) break;
        // Skip the old workflow_created — the client's createJob reinitialises
        // job state and would clobber the replay rebuild.
        if ((ev as { type?: string }).type === 'workflow_created') continue;
        ws.send(JSON.stringify(ev));
        replayed++;
        // Native ground-truth carryover: the freshest primary_complete
        // with lastPromptTokens drives the resume-time context_usage emit
        // below (Native has no session JSONL / rollout to read).
        const evt = ev as { type?: string; lastPromptTokens?: number };
        if (evt.type === 'primary_complete' && typeof evt.lastPromptTokens === 'number') {
          resumeLatestLastPromptTokens = evt.lastPromptTokens;
        }
      }
      console.log(`[arco] [${workflowId.slice(0, 8)}] resume: replayed ${replayed} events from events.jsonl`);
    } catch (err) {
      console.error(`[arco] [${workflowId.slice(0, 8)}] resume replay failed:`, err);
    }
  }

  // Phase 1 — start the Claude session JSONL watcher after events replay so
  // the client has both streams available. Historical entries go to `ws`;
  // subsequent entries fan out to all observers via broadcastTransient.
  if (config.workingDirectory && !config.incognito) {
    const wf = workflows.get(workflowId);
    if (wf) startSessionWatcher(workflowId, wf, config.workingDirectory, ws);

    // Phase 2 — emit context estimate immediately on resume so the footer
    // shows CTX fill without waiting for the next turn. Same pattern as
    // handleRehydrateWorkflows.
    const wfNow = workflows.get(workflowId);
    const sid = wfNow?.primarySessionId;
    const prov = wfNow?.primary.provider;
    const mod = wfNow?.primary.model;
    if (sid && prov === 'claude' && mod) {
      estimateContextFill(config.workingDirectory, sid, mod, wfNow?.calibration).then((est) => {
        if (!est) return;
        if (ws.readyState === WebSocket.OPEN) {
          const usageMsg = { type: 'context_usage' as const, workflowId, ...est, claudeSessionId: sid };
          recordContextUsage(workflowId, usageMsg); // 2026-07-18 — phone CTX line
          ws.send(JSON.stringify(usageMsg));
        }
      }).catch(() => { /* best-effort */ });
    } else if (prov === 'claude' && mod && typeof resumeLatestLastPromptTokens === 'number' && resumeLatestLastPromptTokens > 0) {
      // Native Claude path: no session JSONL exists, so estimateContextFill
      // can't help. The latest primary_complete in events.jsonl carries
      // lastPromptTokens (captured during the replay loop above) — re-broadcast
      // a ground-truth context_usage so the bar reflects the actual context
      // size of the conversation we're resuming into.
      const est = nativeContextEstimate(mod, resumeLatestLastPromptTokens);
      if (est && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'context_usage', workflowId, ...est }));
      }
    } else

    // Re-emit plan_attached so a fresh client (no prior events.jsonl context)
    // sees the active plan immediately rather than waiting for the next attach.
    // The events.jsonl already carries past plan_attached entries from prior
    // runs; this just makes meta.json the practical source of truth.
    if (wfNow?.planId) {
      const summary = await readPlanSummary(config.workingDirectory, wfNow.planId).catch(() => null);
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

    // Same shape for the Preview tab: replay an explicit preview_set so a
    // fresh client (or a stale one whose events were rotated out) hydrates
    // its iframe target without requiring the operator to re-bind the port.
    if (wfNow?.preview) {
      broadcastWorkflow(workflowId, {
        type: 'preview_set',
        workflowId,
        port: wfNow.preview.port,
        framework: wfNow.preview.framework,
        manual: wfNow.preview.manual,
        // Hydration replay — must NOT trigger the client's auto-switch.
        freshlyBound: false,
      });
    }
    // Replay history pills too so click-to-rebind works on a fresh client
    // even when no current binding is active.
    if (wfNow && wfNow.previewHistory.length > 0) {
      broadcastWorkflow(workflowId, {
        type: 'preview_history',
        workflowId,
        entries: wfNow.previewHistory,
      });
    }
  }
}

// Append-or-refresh: if the most recent entry is for the same port, just
// bump its boundAt rather than pushing a duplicate. Otherwise prepend the
// new entry and trim to PREVIEW_HISTORY_MAX. Most-recent-first ordering so
// the UI can render entries top-to-bottom without reversing.
export function appendPreviewHistory(
  arr: PreviewHistoryEntry[],
  entry: PreviewHistoryEntry,
): PreviewHistoryEntry[] {
  if (arr.length > 0 && arr[0].port === entry.port) {
    return [entry, ...arr.slice(1)];
  }
  // Drop any older entry for the same port (rebinding 5173 after a 3000
  // detour shouldn't keep a stale 5173 row at the bottom).
  const filtered = arr.filter((e) => e.port !== entry.port);
  return [entry, ...filtered].slice(0, PREVIEW_HISTORY_MAX);
}

export async function handleSetPreviewPort(
  workflowId: string,
  port: number,
  framework: string | undefined,
  manual: boolean,
): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  const wf = workflows.get(workflowId);
  if (!wf) return;
  const fw = framework && framework.length <= 32 ? framework : undefined;
  wf.preview = { port, framework: fw, manual };
  wf.previewHistory = appendPreviewHistory(wf.previewHistory, {
    port,
    framework: fw,
    boundAt: Date.now(),
    source: manual ? 'manual' : 'auto',
  });
  const cwd = wf.config.workingDirectory;
  if (cwd) {
    try {
      const meta = await readMeta(cwd, workflowId);
      if (meta) {
        meta.preview = { port, framework: fw, manual };
        meta.previewHistory = wf.previewHistory;
        await writeMeta(cwd, meta);
      }
    } catch (err) {
      console.warn(`[arco] [${workflowId.slice(0, 8)}] preview meta write failed:`, err);
    }
  }
  broadcastWorkflow(workflowId, {
    type: 'preview_set',
    workflowId,
    port,
    framework: fw,
    manual,
    freshlyBound: true,
  });
  broadcastWorkflow(workflowId, {
    type: 'preview_history',
    workflowId,
    entries: wf.previewHistory,
  });
}

export async function handleClearPreviewPort(workflowId: string): Promise<void> {
  const wf = workflows.get(workflowId);
  if (!wf) return;
  wf.preview = undefined;
  const cwd = wf.config.workingDirectory;
  if (cwd) {
    try {
      const meta = await readMeta(cwd, workflowId);
      if (meta && meta.preview) {
        delete meta.preview;
        await writeMeta(cwd, meta);
      }
    } catch (err) {
      console.warn(`[arco] [${workflowId.slice(0, 8)}] preview meta clear failed:`, err);
    }
  }
  broadcastWorkflow(workflowId, { type: 'preview_cleared', workflowId });
}


export function handleCancel(ws: WebSocket, workflowId: string): void {
  const wf = workflows.get(workflowId);
  if (!wf) return;
  wf.manager.killAll();
  // Revoke (not just clear) the busy claim: the killed turn's loop is still
  // unwinding post-settle awaits, and without the revoke its finally cleared
  // the busy flag of a turn the operator resent right after STOP.
  revokeBusy(wf);
  // STOP is an explicit stop for an armed goal run too. It used to end only
  // because kill() emits a synthetic error that tripped `turn_error`.
  disarmGoalRun(workflowId, wf, 'the operator pressed STOP');
  // Drop any queued interjections — operator hit STOP, so flushing them as
  // a follow-up turn would fight the intent of the cancel. Emit a per-id
  // queued_message_cancelled so the client removes the optimistic chat
  // entries (and clears the QUEUED pill) — without this, the cancelled
  // interjections stay queued:true on the client forever and the pill
  // sticks. Reuses the existing single-cancel wire format which already
  // routes through removeMessage on the client. Phase 4: also broadcast
  // queue_update so the queue strip clears in lockstep.
  const droppedQueue = [...wf.queue.steering.splice(0), ...wf.queue.followUp.splice(0)];
  const dropped = droppedQueue.length;
  for (const q of droppedQueue) {
    if (typeof q.clientMessageId !== 'string' || q.clientMessageId.length === 0) continue;
    send(ws, { type: 'queued_message_cancelled', workflowId, clientMessageId: q.clientMessageId });
  }
  if (dropped > 0) broadcastQueueUpdate(workflowId);
  // Unconditionally broadcast the cancel + turn-end. When a live worker was
  // actually killed, seedWorker's settled path will ALSO emit
  // primary_turn_ended — that's fine, endPrimaryTurn on the client is
  // idempotent. The reason this matters: if the primary worker has gone
  // "ghost" (already settled silently due to emission-ordering bugs, server
  // restart mid-turn, etc.) killAll() is a no-op, nothing else emits
  // primary_turn_ended, and the UI stays permanently stuck on the busy
  // indicator. Every subsequent CANCEL click is then a silent no-op.
  // Broadcasting here is the escape hatch.
  send(ws, { type: 'turn_cancelled', workflowId, reason: 'operator-stop' });
  send(ws, { type: 'primary_turn_ended', workflowId, endedAt: Date.now() });
  // Cancel path sent primary_turn_ended via send(ws, ...) (single socket,
  // not broadcastWorkflow), so cluster_state won't auto-re-emit. Notify
  // directly so the cluster tab dot + per-card status drop when the
  // operator cancels a cluster member's in-flight turn.
  void notifyClusterStateForWorkflow(workflowId);
  if (!wf.config.incognito) {
    console.log(`[arco] [${workflowId.slice(0, 8)}] cancel: killed primary turn${dropped > 0 ? ` (discarded ${dropped} queued interjection${dropped === 1 ? '' : 's'})` : ''}`);
  }
}

export function handleCancelQueuedMessage(ws: WebSocket, workflowId: string, clientMessageId: string): void {
  const wf = workflows.get(workflowId);
  if (!wf) return;
  // Phase 4 — try both buckets. The id is unique within a workflow so at most
  // one of these matches; we don't care which kind it was.
  const tryRemove = (arr: QueueItem[]): boolean => {
    const idx = arr.findIndex((q) => q.clientMessageId === clientMessageId);
    if (idx === -1) return false;
    arr.splice(idx, 1);
    return true;
  };
  const removed = tryRemove(wf.queue.steering) || tryRemove(wf.queue.followUp);
  if (!removed) {
    // Already flushed (turn drained past it) or never queued. No-op — don't
    // broadcast, since that would retroactively remove a message the primary
    // has already processed.
    return;
  }
  const remaining = wf.queue.steering.length + wf.queue.followUp.length;
  if (!wf.config.incognito) {
    console.log(`[arco] [${workflowId.slice(0, 8)}] queued message cancelled (${clientMessageId.slice(0, 8)}; remaining=${remaining})`);
  }
  send(ws, { type: 'queued_message_cancelled', workflowId, clientMessageId });
  broadcastQueueUpdate(workflowId);
}

// "Load earlier messages" — pop the next older page of raw JSONL entries and
// emit them as `session_entry` messages. Claude-only (other providers don't
// populate pendingEarlierEntries). Sends a fresh session_history_status so
// the client can hide the pill once the queue is drained.
export function handleLoadEarlierMessages(ws: WebSocket, workflowId: string): void {
  const wf = workflows.get(workflowId);
  if (!wf) return;
  const queue = wf.pendingEarlierEntries;
  if (!queue || queue.length === 0) {
    send(ws, { type: 'session_history_status', workflowId, hasEarlier: false, earlierRemaining: 0 });
    return;
  }
  const pageStart = Math.max(0, queue.length - SESSION_HISTORY_PAGE_SIZE);
  const page = queue.slice(pageStart);
  wf.pendingEarlierEntries = queue.slice(0, pageStart);
  for (const raw of page) {
    for (const entry of toSessionEntries(raw)) {
      send(ws, { type: 'session_entry', workflowId, entry });
    }
  }
  send(ws, {
    type: 'session_history_status',
    workflowId,
    hasEarlier: wf.pendingEarlierEntries.length > 0,
    earlierRemaining: wf.pendingEarlierEntries.length,
  });
}

// Operator closed the tab client-side. Tear down in-memory state so the
// registry doesn't leak — on-disk state under .arco/workflows/<id>/ is
// kept so the Resume picker can reclaim the workflow later.
export function handleRemoveWorkflow(workflowId: string): void {
  // Before the registry guard: a tab can be open in the workspace while its
  // state is unregistered (post-restart, before any browser rehydrated it).
  workspaceCloseWorkflow(workflowId);
  const wf = workflows.get(workflowId);
  if (!wf) return;
  publishWorkerActivity(wf, 'worker_removed');
  if (wf.incognitoCleanupTimer) {
    clearTimeout(wf.incognitoCleanupTimer);
    wf.incognitoCleanupTimer = undefined;
  }
  // Always kill live workers on tab close — reviews / handoffs / spawns each
  // spawn workers without setting wf.busy (that flag tracks the primary turn
  // only), so a busy-gated killAll() previously leaked in-flight reviewer
  // subprocesses when the operator closed the tab mid-review.
  wf.manager.killAll();
  // Phase 6 — tear down any per-workflow long-lived provider resources.
  // Today this only affects the Codex app-server transport (the cached
  // long-lived `codex app-server` child). Other providers' worker
  // lifetimes are per-turn and `manager.killAll()` above already settled
  // them. No-op when this tab never used a per-workflow-lifetime provider.
  disposeProviderResources(workflowId);
  // WORKBENCH_EXPANSION §K1 — reap any operator PTY sessions owned by this
  // tab. Sessions outlive windows but NOT the workflow; tab close ends them.
  // broadcastWorkflow still persists the lifecycle event (the tab is gone but
  // events.jsonl is the durable transcript).
  for (const s of ptyManager.killForWorkflow(workflowId)) {
    broadcastWorkflow(workflowId, {
      type: 'terminal_killed', workflowId, sessionId: s.id, reason: 'workflow-close', ts: Date.now(),
    });
  }
  if (wf.busy) {
    wf.queue.steering.length = 0;
    wf.queue.followUp.length = 0;
  }
  // Orphan any in-flight claim so the dying loop's finally is a no-op.
  revokeBusy(wf);
  // Announce the disarm while the tab's broadcast path still exists (the
  // notice lands in events.jsonl, which Resume keeps).
  disarmGoalRun(workflowId, wf, 'the tab was closed');
  // Idle-nudger / auto-turn / peer-budget state is keyed per member and
  // otherwise outlives the tab for the life of the process.
  dropClusterWorkflowState(workflowId);
  if (wf.sessionWatcher) {
    try { wf.sessionWatcher(); } catch { /* ignore */ }
    wf.sessionWatcher = null;
  }
  if (wf.bgTracker) {
    wf.bgTracker.dispose();
    wf.bgTracker = undefined;
  }
  deps.previewAutoDetect.cancel(workflowId);
  // docs/PROVIDERS.md - tear down the per-tab sandbox DB on
  // tab close. We unconditionally call destroySandbox because the file
  // is per-tab (sandbox.db sits inside the workflow's directory); the
  // helper is a no-op when there's no file and ignores ENOENT.
  {
    const cwdForSandbox = workflowCwds.get(workflowId);
    if (cwdForSandbox) {
      try { destroySandbox(cwdForSandbox, workflowId); } catch { /* best-effort */ }
    }
  }
  // Plan bookkeeping: closing a tab marks the open span as detached (with a
  // timestamp) so it shows in the Plan tab's "previously attached" history.
  // We don't clear meta.planId — re-opening the same workflow re-attaches
  // it and recordAttachment opens a fresh span.
  const cwd = workflowCwds.get(workflowId);
  if (cwd && wf.planId) {
    closeOpenSpansForWorkflow(cwd, workflowId).catch(() => { /* best-effort */ });
    releasePlansWatcher(cwd);
  }
  // F9 — best-effort unlink of `.arco/<wfid>/mcp-config.json`. May exist
  // because of cluster membership and/or attached codebase-memory; the
  // workflow is gone so nothing should consult the file again. Safe even
  // when the file was never written (cleanupFor uses fs.rm with force).
  if (cwd) mcpConfigWriter.cleanupFor(cwd, workflowId).catch(() => undefined);
  // §3.1 — drop the per-workflow stuck-breaker state on tab close.
  stuckBreaker.dispose(workflowId);
  clearPrivateWatches(workflowId);
  workflows.delete(workflowId);
  workflowCwds.delete(workflowId);
  if (cwd) releaseProjectSettingsWatcher(cwd);
  for (const s of sessions.values()) {
    s.workflowIds.delete(workflowId);
  }
  if (!wf.config.incognito) console.log(`[arco] workflow ${workflowId.slice(0, 8)} removed`);
}

// Cancel an in-flight review by killing its worker. The worker's kill path
// emits a synthetic 'error' which resolves `runReviewer`'s settled promise
// with `error: 'Worker killed'` and broadcasts `review_artifact_ready` with
// the error populated — client ReviewRow switches to the error state.
// No-op when the worker has already settled or the workflow is gone.
export function handleCancelReview(ws: WebSocket, workflowId: string, reviewId: string): void {
  const wf = workflows.get(workflowId);
  if (!wf) {
    // Workflow fell out of the in-memory registry (e.g. tab was already
    // removed). Still emit a synthetic settle so a zombie client row clears.
    send(ws, {
      type: 'review_artifact_ready',
      workflowId,
      reviewId,
      artifactName: '',
      error: 'Cancelled (workflow no longer tracked)',
      completedAt: Date.now(),
    });
    return;
  }
  const killed = wf.manager.kill(reviewId);
  if (killed) {
    console.log(`[arco] [${workflowId.slice(0, 8)}] review ${reviewId} cancel requested`);
    return;
  }
  // No live worker — stale row from a prior server run, or the review
  // already settled but the ready message was lost. Broadcast a synthetic
  // settle so observers clear the in-flight UI.
  console.log(`[arco] [${workflowId.slice(0, 8)}] review ${reviewId} cancel: no live worker, synthesizing settle`);
  send(ws, {
    type: 'review_artifact_ready',
    workflowId,
    reviewId,
    artifactName: '',
    error: 'Cancelled (no live worker — likely server restart)',
    completedAt: Date.now(),
  });
}

// Cancel an in-flight handoff. Broadcasts a cancelled settle first (so the UI
// shows CANCELLED and the worker-kill error that follows is ignored as sticky),
// then aborts the worker. The kill makes handle.settled resolve, so the normal
// handoff cleanup (busy=false + slot release + activeHandoff clear) runs.
export function handleHandoffCancel(ws: WebSocket, workflowId: string, handoffId: string): void {
  const wf = workflows.get(workflowId);
  const active = wf?.activeHandoff;
  if (!wf || !active || active.handoffId !== handoffId) {
    const cwd = wf?.config.workingDirectory;
    const slot = cwd ? cwdHandoffChain.get(cwd) : undefined;
    if (cwd && slot?.workflowId === workflowId && slot.handoffId === handoffId) {
      slot.cancelled = true;
      cwdHandoffChain.delete(cwd);
      slot.resolve();
      if (wf) {
        revokeBusy(wf);
        wf.activeHandoff = undefined;
      }
      broadcastHandoffLockSnapshot(cwd);
    }
    // Stale row (already settled, or server restarted). Synthesize a settle so
    // the client clears the in-flight UI.
    send(ws, {
      type: 'handoff_artifact_ready',
      workflowId,
      handoffId,
      artifactName: '',
      cancelled: true,
      completedAt: Date.now(),
    });
    return;
  }
  console.log(`[arco] [${workflowId.slice(0, 8)}] handoff ${handoffId} cancel requested`);
  send(ws, {
    type: 'handoff_artifact_ready',
    workflowId,
    handoffId,
    artifactName: active.artifactName,
    cancelled: true,
    completedAt: Date.now(),
  });
  active.abort();
}

export function handleHandoffLockClear(ws: WebSocket, cwd: string, workflowId: string, handoffId?: string): void {
  const slot = cwdHandoffChain.get(cwd);
  if (!slot || slot.workflowId !== workflowId || (handoffId && slot.handoffId && slot.handoffId !== handoffId)) {
    send(ws, handoffLockSnapshot(cwd));
    return;
  }

  const wf = workflows.get(slot.workflowId);
  const active = wf?.activeHandoff;
  slot.cancelled = true;
  cwdHandoffChain.delete(cwd);
  slot.resolve();
  if (wf) {
    revokeBusy(wf);
    if (!handoffId || active?.handoffId === handoffId) wf.activeHandoff = undefined;
  }
  broadcastHandoffLockSnapshot(cwd);
  send(ws, {
    type: 'system_notice',
    workflowId,
    content: `[HANDOFF CLEARED] Released stale handoff lock for ${cwd}.`,
  });

  if (active && (!handoffId || active.handoffId === handoffId)) {
    send(ws, {
      type: 'handoff_artifact_ready',
      workflowId,
      handoffId: active.handoffId,
      artifactName: active.artifactName,
      cancelled: true,
      completedAt: Date.now(),
    });
    active.abort();
  }
}

// Phase 8 — operator pinned a HISTORY label. Validate, then broadcast as
// `operator_label` so it appends to events.jsonl (via persistAndStampSeq)
// and shows up on every observer's HISTORY timeline. v1 is append-only.
export async function handleCreateLabelRequest(
  ws: WebSocket,
  msg: import('@arco/shared').CreateLabelRequestMessage,
): Promise<void> {
  const text = (msg.text ?? '').trim();
  if (!text) {
    send(ws, { type: 'error', message: 'Label text is required.' });
    return;
  }
  if (text.length > 200) {
    send(ws, { type: 'error', message: 'Label text must be 200 chars or fewer.' });
    return;
  }
  if (!Number.isFinite(msg.targetEventSeq) || msg.targetEventSeq < 1) {
    send(ws, { type: 'error', message: 'Label requires a valid targetEventSeq.' });
    return;
  }
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
  const head = await getWorkflowHeadSeq(cwd, msg.workflowId);
  if (msg.targetEventSeq > head) {
    send(ws, { type: 'error', message: `targetEventSeq ${msg.targetEventSeq} is past the workflow head (${head}).` });
    return;
  }
  broadcastWorkflow(msg.workflowId, {
    type: 'operator_label',
    workflowId: msg.workflowId,
    text,
    targetEventSeq: msg.targetEventSeq,
    createdAt: Date.now(),
  });
  console.log(`[arco] [${msg.workflowId.slice(0, 8)}] label pinned at seq ${msg.targetEventSeq}: ${text.slice(0, 60)}`);
}

// docs/PERSISTENCE.md - REWIND CONVERSATION. Move the workflow's live head to
// an earlier transcript point. Deliberately NOT `revert_to_checkpoint` (that is
// the git working-tree restore). This is a conversation rewind only (v1 —
// file restore stays the separate RESTORE FILES action).
//
// Mechanism: append a durable `leaf_move` event (the redirect node branch-aware
// replay walks) and set meta.leafSeq via atomic writeMeta. We then dispose any
// live Native worker so the next turn cold-rebuilds its messages[] from the
// rewound branch — reusing the proven post-handoff teardown rails rather than
// force-mutating a live worker's history. The abandoned branch stays
// byte-identical on disk; "undo the undo" is just another rewind.
export async function handleRevertToPointRequest(
  ws: WebSocket,
  msg: import('@arco/shared').RevertToPointRequestMessage,
): Promise<void> {
  if (!Number.isFinite(msg.targetSeq) || msg.targetSeq < 1) {
    send(ws, { type: 'error', message: 'revert_to_point_request requires a valid targetSeq.' });
    return;
  }
  const wf = workflows.get(msg.workflowId);
  if (!wf) {
    send(ws, { type: 'error', message: `Unknown workflow ${msg.workflowId.slice(0, 8)}` });
    return;
  }
  // Don't move the head under a live turn — the worker's in-memory messages[]
  // would race the rebuild. The operator can cancel first.
  if (wf.busy) {
    send(ws, { type: 'error', message: 'Cannot rewind while a turn is in progress — cancel it first.' });
    return;
  }
  const cwd = wf.config.workingDirectory;
  if (!cwd) {
    send(ws, { type: 'error', message: 'Workflow has no working directory configured.' });
    return;
  }
  // docs/PERSISTENCE.md - Native-first. Only the Claude Native
  // transport rebuilds its in-process messages[] from meta.leafSeq. On CLI /
  // Codex (session-id / rollout resume) setting leafSeq has NO effect, so a
  // rewind would silently no-op. Gate it rather than lie. The effective
  // transport resolves tab override → cascade default (mirrors index.ts:1541).
  const provider = wf.config.primaryProvider ?? 'claude';
  const tabTransport = wf.config.claudeTransport;
  const cascade = await readSettings(cwd).catch(() => null);
  const effectiveNative = provider === 'claude' && (
    tabTransport === 'native' || (tabTransport !== 'cli' && cascade?.claude?.transport === 'native')
  );
  if (!effectiveNative) {
    send(ws, { type: 'error', message: 'REWIND CONVERSATION is Claude Native only in v1 (CLI / Codex resume is summarizer-backed).' });
    return;
  }
  const head = await getWorkflowHeadSeq(cwd, msg.workflowId);
  if (msg.targetSeq > head) {
    send(ws, { type: 'error', message: `targetSeq ${msg.targetSeq} is past the workflow head (${head}).` });
    return;
  }

  // Append the durable leaf_move (persisted to events.jsonl via the broadcast
  // path). `source` records why this head move happened — v1 only emits the
  // operator-rewind case. classifyBranchSource keeps the tag the single source
  // of truth shared with the HISTORY branch-tree rendering.
  broadcastWorkflow(msg.workflowId, {
    type: 'leaf_move',
    workflowId: msg.workflowId,
    targetSeq: msg.targetSeq,
    source: classifyBranchSource('leaf_move'),
    createdAt: Date.now(),
  });

  // Mark branch mode on durably. The numeric value is informational (the head
  // pointer); branch-aware replay walks from the physical tail honoring the
  // leaf_move redirect chain. Atomic writeMeta so it survives a restart.
  const meta = await readMeta(cwd, msg.workflowId);
  if (meta) {
    meta.leafSeq = await getWorkflowHeadSeq(cwd, msg.workflowId);
    await writeMeta(cwd, meta).catch((err) => {
      console.warn(`[arco] [${msg.workflowId.slice(0, 8)}] writeMeta(leafSeq) failed:`, err);
    });
  }

  // Drop any live Native worker so the next turn rebuilds from the rewound
  // branch. No-op for non-Native transports / no live worker.
  disposeClaudeNativeWorker(msg.workflowId);
  console.log(`[arco] [${msg.workflowId.slice(0, 8)}] rewound conversation to seq ${msg.targetSeq}`);
}

// Workbench Expansion A4 — revert the working tree to a checkpoint.
//
// The careful primitive: ALWAYS take a safety snapshot of the current working
// tree FIRST (so the revert is itself undoable), then restore. If the safety
// snapshot fails we ABORT and report — never revert without a way back. The
// restore is faithful (files added after the checkpoint are removed) and never
// moves the user's HEAD/branch/real index — see gitSnapshots.revertToCheckpoint
// for the exact git mechanism.
export async function handleRevertToCheckpoint(
  ws: WebSocket,
  msg: import('@arco/shared').RevertToCheckpointMessage,
): Promise<void> {
  if (!Number.isFinite(msg.seq) || msg.seq < 0) {
    send(ws, { type: 'error', message: 'revert_to_checkpoint requires a valid seq.' });
    return;
  }
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
  // Don't revert under the agent's feet — a mutating turn mid-flight would race
  // the working-tree restore. The operator can cancel first.
  if (wf.busy) {
    send(ws, { type: 'error', message: 'Cannot revert while a turn is in progress — cancel it first.' });
    return;
  }

  // 1) Safety snapshot FIRST. Anchor it to the live head seq so it slots into
  // the same per-workflow checkpoint series. Abort the whole revert if it fails.
  const safetyGuardSeq = await getWorkflowHeadSeq(cwd, msg.workflowId);
  const safety = await createCheckpoint({
    cwd,
    workflowId: msg.workflowId,
    seq: safetyGuardSeq,
    label: `pre-revert ${new Date().toISOString()}`,
  });
  if (!safety) {
    send(ws, {
      type: 'error',
      message: 'Revert aborted: could not take a safety snapshot of the current working tree. Nothing was changed.',
    });
    return;
  }
  // Surface the safety snapshot as a normal checkpoint marker too, so the
  // operator can see/diff/revert to it like any other.
  broadcastWorkflow(msg.workflowId, {
    type: 'checkpoint_created',
    workflowId: msg.workflowId,
    seq: safetyGuardSeq,
    ref: safety.ref,
    label: safety.label,
    ts: safety.ts,
    fileCount: safety.fileCount,
  });

  // 2) Restore the working tree to the chosen checkpoint.
  const result = await revertToCheckpoint({ cwd, workflowId: msg.workflowId, seq: msg.seq });
  if (!result) {
    send(ws, {
      type: 'error',
      message: `Revert failed: checkpoint ${msg.seq} could not be restored (it may have been pruned). A safety snapshot was taken, so nothing else changed.`,
    });
    return;
  }

  broadcastWorkflow(msg.workflowId, {
    type: 'checkpoint_reverted',
    workflowId: msg.workflowId,
    seq: msg.seq,
    fileCount: result.fileCount,
    safetySnapshotRef: safety.ref,
    safetySnapshotSeq: safetyGuardSeq,
    backend: result.backend,
    ...(result.limitation ? { limitation: result.limitation } : {}),
    ts: Date.now(),
  });
  console.log(
    `[arco] [${msg.workflowId.slice(0, 8)}] reverted to checkpoint seq ${msg.seq} ` +
    `(${result.fileCount} files, ${result.backend}); safety snapshot at seq ${safetyGuardSeq}`,
  );
}

// docs/PROTOCOL_CLUSTER.md - WS handlers.
//
// Subscribe is the only client→server message that pushes back a full
// snapshot synchronously. Subsequent updates flow through the cluster_state
// trigger gate in broadcastWorkflow. Unsubscribe is purely set-removal.

// MASTER_REFACTOR §3.3 F5 (2026-05-11) — operator renamed a workflow from
// the per-member pencil-edit in ClusterRightPanel (or any other surface the
// client wires up later). Empty `name` clears `wf.config.name` so
// ClusterMember.displayName snaps back to the wfid 8-char prefix. Length
// cap matches cluster_rename (64). Updates the in-memory config, persists
// to meta.json, broadcasts `workflow_renamed` to observers, and re-emits
// `cluster_state` to every cluster subscriber so the member list /
// MemberCard grid pick up the new label without a full reload.
export async function handleRenameWorkflow(ws: WebSocket, workflowId: string, name: string): Promise<void> {
  if (typeof name !== 'string') {
    send(ws, { type: 'error', message: 'rename_workflow requires a string name' });
    return;
  }
  const wf = workflows.get(workflowId);
  if (!wf) {
    send(ws, { type: 'error', message: `Unknown workflow ${workflowId.slice(0, 8)}` });
    return;
  }
  const trimmed = name.trim();
  if (trimmed.length > 64) {
    send(ws, { type: 'error', message: `rename_workflow rejected: name_too_long (${trimmed.length} > 64)` });
    return;
  }
  const nextName = trimmed.length === 0 ? '' : trimmed;
  wf.config.name = nextName;
  const cwd = wf.config.workingDirectory;
  if (cwd) {
    try {
      const meta = await readMeta(cwd, workflowId);
      if (meta) {
        meta.name = nextName;
        meta.lastActiveAt = Date.now();
        await writeMeta(cwd, meta);
      }
    } catch (err) {
      console.error(`[arco] [${workflowId.slice(0, 8)}] rename_workflow meta write failed:`, err);
    }
  }
  const broadcastName: string | null = nextName.length === 0 ? null : nextName;
  broadcastWorkflow(workflowId, { type: 'workflow_renamed', workflowId, name: broadcastName });
  // If the workflow is in a cluster, re-emit cluster_state so every
  // subscribed UI picks up the new ClusterMember.displayName immediately.
  const clusterId = clusterStore.getClusterIdForWorkflow(workflowId);
  if (clusterId) {
    const payload = await buildClusterStatePayload(clusterId);
    if (payload) {
      broadcastCluster(clusterId, { type: 'cluster_state', clusterId, state: payload });
    }
  }
  console.log(`[arco] [${workflowId.slice(0, 8)}] renamed → ${broadcastName ?? '(default)'}`);
}

// docs/PROVIDERS.md + F9 - operator toggled "Attach codebase
// memory" in the CONFIG tab. Persists intent + indexPath on wf.config +
// meta.json, eagerly rewrites `.arco/<wfid>/mcp-config.json` (so the
// next CLI Claude spawn picks up the entry without the operator having
// to send a turn first), and broadcasts `codebase_memory_state` so the
// section + Blast Radius sub-tab see the same source. Codex transports
// rebuild the entry from WorkerConfig at the next turn's spawn.
export async function handleAttachCodebaseMemory(
  ws: WebSocket,
  workflowId: string,
  indexPath?: string,
): Promise<void> {
  const wf = workflows.get(workflowId);
  if (!wf) {
    send(ws, { type: 'error', message: `Unknown workflow ${workflowId.slice(0, 8)}` });
    return;
  }
  const trimmed = typeof indexPath === 'string' ? indexPath.trim() : '';
  const resolved = trimmed || wf.config.workingDirectory;
  const prev = wf.config.codebaseMemory ?? { attached: false };
  wf.config.codebaseMemory = {
    ...prev,
    attached: true,
    indexPath: resolved,
  };
  const cwd = wf.config.workingDirectory;
  if (cwd) {
    try {
      const meta = await readMeta(cwd, workflowId);
      if (meta) {
        meta.codebaseMemory = { ...wf.config.codebaseMemory };
        meta.lastActiveAt = Date.now();
        await writeMeta(cwd, meta);
      }
    } catch (err) {
      console.error(`[arco] [${workflowId.slice(0, 8)}] attach_codebase_memory meta write failed:`, err);
    }
    // F9 — sync mcp-config.json so a subsequent CLI Claude spawn (or the
    // operator inspecting the file) sees the codebase-memory entry merged
    // with any existing arco-cluster entry. Best-effort; the spawn path
    // also rewrites on each turn, so a transient write failure isn't fatal.
    await syncMcpConfigForWorkflow(workflowId).catch((err) => {
      console.error(`[arco] [${workflowId.slice(0, 8)}] attach_codebase_memory mcp-config sync failed:`, err);
    });
  }
  broadcastWorkflow(workflowId, {
    type: 'codebase_memory_state',
    workflowId,
    attached: true,
    indexPath: wf.config.codebaseMemory.indexPath,
    lastIndexedAt: wf.config.codebaseMemory.lastIndexedAt,
    fileCount: wf.config.codebaseMemory.fileCount,
  });
  console.log(`[arco] [${workflowId.slice(0, 8)}] codebase-memory attached → ${wf.config.codebaseMemory.indexPath}`);
}

export async function handleDetachCodebaseMemory(ws: WebSocket, workflowId: string): Promise<void> {
  const wf = workflows.get(workflowId);
  if (!wf) {
    send(ws, { type: 'error', message: `Unknown workflow ${workflowId.slice(0, 8)}` });
    return;
  }
  const prev = wf.config.codebaseMemory;
  // Keep indexPath / lastIndexedAt / fileCount so re-attach is one click;
  // only flip the intent bit.
  wf.config.codebaseMemory = {
    attached: false,
    indexPath: prev?.indexPath,
    lastIndexedAt: prev?.lastIndexedAt,
    fileCount: prev?.fileCount,
  };
  const cwd = wf.config.workingDirectory;
  if (cwd) {
    try {
      const meta = await readMeta(cwd, workflowId);
      if (meta) {
        meta.codebaseMemory = { ...wf.config.codebaseMemory };
        meta.lastActiveAt = Date.now();
        await writeMeta(cwd, meta);
      }
    } catch (err) {
      console.error(`[arco] [${workflowId.slice(0, 8)}] detach_codebase_memory meta write failed:`, err);
    }
    // F9 — sync mcp-config.json so the codebase-memory entry disappears
    // from the next CLI Claude spawn. If the workflow is still in a cluster,
    // the file gets rewritten with just the arco-cluster entry; otherwise
    // it's unlinked outright. Best-effort.
    await syncMcpConfigForWorkflow(workflowId).catch((err) => {
      console.error(`[arco] [${workflowId.slice(0, 8)}] detach_codebase_memory mcp-config sync failed:`, err);
    });
  }
  broadcastWorkflow(workflowId, {
    type: 'codebase_memory_state',
    workflowId,
    attached: false,
    indexPath: wf.config.codebaseMemory.indexPath,
    lastIndexedAt: wf.config.codebaseMemory.lastIndexedAt,
    fileCount: wf.config.codebaseMemory.fileCount,
  });
  console.log(`[arco] [${workflowId.slice(0, 8)}] codebase-memory detached`);
}

// Phase 2.5 B3 — minimal native-workflow create returning the new
// workflowId. Mirrors the essential pre-replay portion of
// handleCreateWorkflow (state init + persistInitialMeta + workflow_created
// emit) for fresh non-resume creations. Used by the N-fresh-workers cluster
// path where we need the id to weave together cluster membership.
export async function createBlankNativeWorkflow(
  ws: WebSocket,
  session: Session,
  config: WorkflowConfig,
  options?: { backgroundCreated?: boolean },
): Promise<string> {
  // Cluster fresh-worker creations are never resumes; honor the global
  // server-side-compaction default (defaults OFF — NATIVE_COMPACTION_PLAN §1).
  const blankCascade = await readSettings(config.workingDirectory).catch(() => null);
  applyClaudeNativeCompactDefault(config, blankCascade?.claudeNativeCompactDefault);
  applyAutoHandoffDefault(config, blankCascade?.autoHandoffDefaults);
  const primary = derivePrimaryConfig(config);
  const manager = new WorkerManager();
  const workflowId = crypto.randomUUID();
  workflows.set(workflowId, {
    config,
    busy: false,
    manager,
    primary,
    queue: { steering: [], followUp: [] },
    observers: new Set([ws]),
    autoHandoff: deriveAutoHandoff(config),
    lastContextPercent: 0,
    previewHistory: [],
  });
  session.workflowIds.add(workflowId);
  if (config.workingDirectory) {
    workflowCwds.set(workflowId, config.workingDirectory);
    acquireProjectSettingsWatcher(config.workingDirectory);
    rememberCwd(config.workingDirectory).catch(() => { /* best-effort */ });
    try {
      await initWorkflowStore(config.workingDirectory, workflowId);
      await persistInitialMeta(config.workingDirectory, workflowId, config, primary);
    } catch (err) {
      console.error(`[arco] createBlankNativeWorkflow init failed for ${workflowId.slice(0, 8)}:`, err);
    }
  }
  send(ws, {
    type: 'workflow_created',
    workflowId,
    config,
    ...(options?.backgroundCreated ? { backgroundCreated: true } : {}),
  });
  console.log(`[arco] Workflow created (blank/native helper): "${config.name}" [${workflowId.slice(0, 8)}]`);
  return workflowId;
}

// §C2 — resolve an operator-configured fallback-leg array into ready-to-spawn
// legs. Codex legs get their provider account resolved (codexHome) exactly like
// the primary reviewer/researcher resolution above; a leg whose account can't
// be resolved is dropped (fail-safe: better a shorter chain than a leg that
// can't authenticate). Returns undefined when the role is unset/empty so the
// primitive falls through to a single-leg chain (today's behavior). The chain
// is READ from settings; it is never written back — the "config read, not
// write" fence.
async function resolveFallbackLegs(
  configured: import('@arco/shared').FallbackLegConfig[] | undefined,
  fallbackAccountRef: string | undefined,
  cwd: string,
): Promise<import('@arco/shared').FallbackLegConfig[] | undefined> {
  if (!configured || configured.length === 0) return undefined;
  const out: import('@arco/shared').FallbackLegConfig[] = [];
  for (const leg of configured) {
    if (leg.provider === 'codex') {
      const acct = await resolveProviderAccount('codex', leg.providerAccountRef ?? fallbackAccountRef, cwd).catch(() => null);
      if (!acct) continue; // drop a Codex leg we can't authenticate
      out.push({ ...leg, providerAccountRef: acct.profile.id, codexHome: acct.codexHome });
    } else {
      out.push(leg);
    }
  }
  return out.length > 0 ? out : undefined;
}

// Phase 5 — the Review primitive's WS handler. Extracts the tab's most
// recent {user prompt, primary reply} pair from events.jsonl and spawns
// the reviewer in the background. Returns immediately; completion arrives
// via `review_artifact_ready`.
export async function handleReviewRequest(
  ws: WebSocket,
  session: Session,
  msg: import('@arco/shared').ReviewRequestMessage,
): Promise<void> {
  const wf = workflows.get(msg.workflowId);
  if (!wf) {
    send(ws, { type: 'error', message: `Unknown workflow ${msg.workflowId.slice(0, 8)}` });
    return;
  }
  // Chat tabs are projectless — a reviewer is an Agent worker with project
  // tools and would read/write against the ~/.arco/chats persistence cwd.
  if (isChatWorkflow(wf.config)) {
    send(ws, { type: 'error', message: 'Review is not available in Chat tabs.' });
    return;
  }
  const cwd = wf.config.workingDirectory;
  if (!cwd) {
    send(ws, { type: 'error', message: 'Workflow has no working directory configured.' });
    return;
  }

  // Build the reviewer's content block based on the operator-selected
  // scope. Plan-* kinds slice the attached plan markdown directly; all
  // other kinds replay the workflow's events.jsonl and format turn blocks,
  // optionally layered with `git diff HEAD` when `includeGitDiff` is set.
  const refKind = msg.contextRef.kind;
  const isPlanRef = refKind === 'plan-whole' || refKind === 'plan-phase' || refKind === 'plan-items';
  const isClusterPlanRef = refKind === 'cluster-plan-whole' || refKind === 'cluster-plan-phase';
  let builtContent: string; let builtLabel: string;
  if (refKind === 'preview-capture') {
    // §G2 — review a preview-capture report artifact (read + framing + path-confinement in reviewContent.ts).
    const r = msg.contextRef as Extract<import('@arco/shared').ReviewContextRef, { kind: 'preview-capture' }>;
    const built = await buildPreviewCaptureReviewContent(cwd, msg.workflowId, r.reportName);
    if (built.rejectReason) { send(ws, { type: 'error', message: built.rejectReason }); return; }
    builtContent = built.content; builtLabel = built.label;
  } else if (isPlanRef) {
    const planBuilt = await buildPlanReviewContent(
      cwd,
      msg.contextRef as Extract<import('@arco/shared').ReviewContextRef, { kind: 'plan-whole' | 'plan-phase' | 'plan-items' }>,
      msg.includeGitDiff ?? false,
    );
    if (planBuilt.rejectReason) {
      send(ws, { type: 'error', message: planBuilt.rejectReason });
      return;
    }
    builtContent = planBuilt.content;
    builtLabel = planBuilt.label;
  } else if (isClusterPlanRef) {
    const clusterRef = msg.contextRef as Extract<
      import('@arco/shared').ReviewContextRef,
      { kind: 'cluster-plan-whole' | 'cluster-plan-phase' }
    >;
    const cluster = await clusterStore.readCluster(clusterRef.clusterId).catch(() => null);
    if (!cluster) {
      send(ws, { type: 'error', message: `Unknown cluster ${clusterRef.clusterId.slice(0, 8)}.` });
      return;
    }
    const planRecord = await clusterPlanBridge.readClusterPlan(clusterRef.clusterId).catch(() => null);
    const body = planRecord?.body ?? '';
    const planBuilt = await buildClusterPlanReviewContent(
      cwd,
      clusterRef,
      body,
      cluster.name ?? null,
      msg.includeGitDiff ?? false,
    );
    if (planBuilt.rejectReason) {
      send(ws, { type: 'error', message: planBuilt.rejectReason });
      return;
    }
    builtContent = planBuilt.content;
    builtLabel = planBuilt.label;
  } else {
    const events = await replayWorkflowEvents(cwd, msg.workflowId, 0);
    const built = await buildReviewContent(events, cwd, msg.contextRef, msg.includeGitDiff ?? false);
    if (built.rejectReason) {
      send(ws, { type: 'error', message: built.rejectReason });
      return;
    }
    builtContent = built.content;
    builtLabel = built.label;
  }

  const reviewerAccount = msg.reviewer.provider === 'codex'
    ? await resolveProviderAccount('codex', msg.reviewer.providerAccountRef ?? wf.config.providerAccountRef, cwd).catch(() => null)
    : null;
  const reviewer = reviewerAccount
    ? { ...msg.reviewer, providerAccountRef: reviewerAccount.profile.id, codexHome: reviewerAccount.codexHome }
    : msg.reviewer;

  // §5.1 — drift guard. Re-resolve the operator-selected reviewer model against
  // the live catalog at dispatch; flag (don't block) if it drifted out.
  const reviewDrift = await checkModelDrift(reviewer.provider, reviewer.model, catalogDriftProbe);
  if (reviewDrift.drifted) {
    broadcastWorkflow(msg.workflowId, {
      type: 'system_notice',
      workflowId: msg.workflowId,
      content: driftFlag('review', reviewer.provider, reviewer.model, reviewDrift.reason ?? 'model drifted'),
    });
  }

  // §C2 — resolve the operator-configured reviewer fallback chain (bounded-job
  // only). Read from settings.fallbackChains.reviewer (cwd-layered cascade);
  // each Codex leg gets its account resolved like the primary reviewer above.
  // Unset ⇒ undefined ⇒ runReviewer runs a single-leg chain (today's behavior).
  const settings = await readSettings(cwd).catch(() => null);
  const reviewerFallbacks = await resolveFallbackLegs(settings?.fallbackChains?.reviewer, wf.config.providerAccountRef, cwd);

  const handle = runReviewer(
    {
      workflowId: msg.workflowId,
      cwd,
      manager: wf.manager,
      broadcast: (m) => send(ws, m),
    },
    {
      reviewer,
      reviewerFallbacks,
      primary: { provider: wf.primary.provider, model: wf.primary.model, effort: wf.primary.effort },
      contextRef: msg.contextRef,
      contextLabel: builtLabel,
      content: builtContent,
      // docs/GOTCHAS.md - inherit the source tab's north-star so the
      // reviewer judges against the standing objective (diverges from
      // outputStyle, which reviewers force to 'normal').
      goal: wf.config.goal,
    },
  );

  console.log(`[arco] [${msg.workflowId.slice(0, 8)}] review ${handle.reviewId} started (reviewer=${msg.reviewer.provider}:${msg.reviewer.model}@${msg.reviewer.effort}, scope=${builtLabel})`);

  handle.settled.then((r) => {
    if (r.error) console.log(`[arco] [${msg.workflowId.slice(0, 8)}] review ${handle.reviewId} failed: ${r.error}`);
    else console.log(`[arco] [${msg.workflowId.slice(0, 8)}] review ${handle.reviewId} settled${r.verdict ? ` verdict=${r.verdict}` : ''}`);
  }).catch((err) => {
    console.error(`[arco] review ${handle.reviewId} settle error:`, err);
  });
}

// docs/ARCHITECTURE.md - the Deep Research primitive's WS handler.
// Resolves the researcher config exactly like the reviewer path, clamps the
// round cap to [1, ceiling], and spawns runResearch in the background. For a
// dig-deeper follow-up (`seedArtifactName` + `followUp`) it reads the existing
// artifact body and seeds the worker so it appends a dated addendum to the
// same file. Returns immediately; completion arrives via `research_complete`.
export async function handleResearchRequest(
  ws: WebSocket,
  session: Session,
  msg: import('@arco/shared').ResearchRequestMessage,
): Promise<void> {
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
  if (!msg.topic?.trim() && !msg.followUp?.trim()) {
    send(ws, { type: 'error', message: 'Research topic is empty.' });
    return;
  }

  // Clamp the operator-set round cap to [1, ceiling] server-side — the hard,
  // deterministic stop (web-tool max_uses on Claude; prompt cap on Codex).
  const maxRounds = Math.max(1, Math.min(RESEARCH_MAX_ROUNDS_CEILING, Math.floor(msg.maxRounds || 0) || 1));

  // Dig-deeper: read the existing artifact body to seed the follow-up. Same
  // `name` sanity rules as the artifact endpoint (basename only, no traversal,
  // no leading dot) so a malicious seedArtifactName can't escape the dir.
  let priorBody: string | undefined;
  if (msg.seedArtifactName && msg.followUp) {
    const base = msg.seedArtifactName.split('/').pop() || '';
    if (!base || base.includes('\0') || base === '.' || base === '..' || base.startsWith('.')) {
      send(ws, { type: 'error', message: 'Invalid seed artifact name.' });
      return;
    }
    try {
      const full = path.join(artifactsDir(cwd, msg.workflowId), base);
      priorBody = await fsPromises.readFile(full, 'utf8');
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      send(ws, { type: 'error', message: `Could not read seed artifact: ${m}` });
      return;
    }
  }

  const researcherAccount = msg.researcher.provider === 'codex'
    ? await resolveProviderAccount('codex', msg.researcher.providerAccountRef ?? wf.config.providerAccountRef, cwd).catch(() => null)
    : null;
  const researcher = researcherAccount
    ? { ...msg.researcher, providerAccountRef: researcherAccount.profile.id, codexHome: researcherAccount.codexHome }
    : msg.researcher;

  // §C2 — resolve the operator-configured research fallback chain (bounded-job
  // only). Same shape as the reviewer path. Applies to both fresh runs and
  // dig-deeper follow-ups (both are bounded). Unset ⇒ single-leg chain.
  const settings = await readSettings(cwd).catch(() => null);
  const researcherFallbacks = await resolveFallbackLegs(settings?.fallbackChains?.research, wf.config.providerAccountRef, cwd);

  const handle = runResearch(
    {
      workflowId: msg.workflowId,
      cwd,
      manager: wf.manager,
      broadcast: (m) => send(ws, m),
    },
    {
      researcher,
      researcherFallbacks,
      topic: msg.topic ?? '',
      maxRounds,
      seedArtifactName: msg.seedArtifactName,
      followUp: msg.followUp,
      priorBody,
    },
  );

  console.log(`[arco] [${msg.workflowId.slice(0, 8)}] research ${handle.researchId} started (researcher=${msg.researcher.provider}:${msg.researcher.model}@${msg.researcher.effort}, maxRounds=${maxRounds}${msg.seedArtifactName ? `, followUp→${handle.artifactName}` : ''})`);

  handle.settled.then((r) => {
    if (r.error) console.log(`[arco] [${msg.workflowId.slice(0, 8)}] research ${handle.researchId} failed: ${r.error}`);
    else console.log(`[arco] [${msg.workflowId.slice(0, 8)}] research ${handle.researchId} settled (rounds=${r.roundsUsed}, sources=${r.sourceCount})`);
  }).catch((err) => {
    console.error(`[arco] research ${handle.researchId} settle error:`, err);
  });
}

// Cancel an in-flight research run by killing its worker — mirrors
// handleCancelReview. The kill path resolves runResearch's settled promise
// with an error and broadcasts research_complete with `error` populated.
export function handleCancelResearch(ws: WebSocket, workflowId: string, researchId: string): void {
  const wf = workflows.get(workflowId);
  if (!wf) {
    send(ws, {
      type: 'research_complete',
      workflowId,
      researchId,
      artifactName: '',
      roundsUsed: 0,
      sourceCount: 0,
      isFollowUp: false,
      error: 'Cancelled (workflow no longer tracked)',
      completedAt: Date.now(),
    });
    return;
  }
  const killed = wf.manager.kill(researchId);
  if (killed) {
    console.log(`[arco] [${workflowId.slice(0, 8)}] research ${researchId} cancel requested`);
    return;
  }
  console.log(`[arco] [${workflowId.slice(0, 8)}] research ${researchId} cancel: no live worker, synthesizing settle`);
  send(ws, {
    type: 'research_complete',
    workflowId,
    researchId,
    artifactName: '',
    roundsUsed: 0,
    sourceCount: 0,
    isFollowUp: false,
    error: 'Cancelled (no live worker — likely server restart)',
    completedAt: Date.now(),
  });
}

// docs/ARCHITECTURE.md - Cookbook agent-driven recommendation.
//
// REUSES the B2 Deep-Research bounded turn (runResearch) end-to-end — does NOT
// fork it. We resolve the RUN AS researcher exactly like handleResearchRequest,
// fetch the G2 fit-scored catalog against the detected (or simulated) G1 profile,
// fit-filter the candidates for the chosen task profile (recommend.ts), build the
// grounding TOPIC, and hand it to runResearch. The lifecycle + artifact flow
// through the EXISTING research_started/_progress/_complete events and the
// `research-<ts>.md` artifact — cancellable via the same cancel_research path.
//
// Fence: ONE bounded turn. The agent recommends; it does not route, judge "done?",
// select-and-apply, or auto-download. The operator reviews the artifact + applies
// the config in G4. Nothing here writes a model config or pulls weights.
export async function handleCookbookRecommendRequest(
  ws: WebSocket,
  session: Session,
  msg: import('@arco/shared').CookbookRecommendRequestMessage,
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

  // Same hard, deterministic clamp as Deep Research — the web-tool max_uses stop.
  const maxRounds = Math.max(1, Math.min(RESEARCH_MAX_ROUNDS_CEILING, Math.floor(msg.maxRounds || 0) || 1));

  // G1 profile (detected, or a simulated rig) + G2 fit-scored catalog. searchCatalog
  // never throws (a down HF degrades to the bundled Ollama manifest); a total
  // failure just yields an empty candidate set the agent reasons over honestly.
  const hw = msg.sim ? simulatedProfile(msg.sim) : await probeHardware();
  const catalog = await searchCatalog({ text: msg.query, sim: msg.sim }, hw);
  const candidates = filterCandidatesForProfile(catalog.rows, msg.taskProfile);
  const topic = buildRecommendationTopic(hw, candidates, msg.taskProfile, maxRounds);

  const researcherAccount = msg.researcher.provider === 'codex'
    ? await resolveProviderAccount('codex', msg.researcher.providerAccountRef ?? wf.config.providerAccountRef, cwd).catch(() => null)
    : null;
  const researcher = researcherAccount
    ? { ...msg.researcher, providerAccountRef: researcherAccount.profile.id, codexHome: researcherAccount.codexHome }
    : msg.researcher;

  const handle = runResearch(
    {
      workflowId: msg.workflowId,
      cwd,
      manager: wf.manager,
      broadcast: (m) => send(ws, m),
    },
    { researcher, topic, maxRounds },
  );

  console.log(`[arco] [${msg.workflowId.slice(0, 8)}] cookbook recommend ${handle.researchId} started (profile=${msg.taskProfile}, candidates=${candidates.length}, researcher=${msg.researcher.provider}:${msg.researcher.model}@${msg.researcher.effort}, maxRounds=${maxRounds})`);

  handle.settled.then((r) => {
    if (r.error) console.log(`[arco] [${msg.workflowId.slice(0, 8)}] cookbook recommend ${handle.researchId} failed: ${r.error}`);
    else console.log(`[arco] [${msg.workflowId.slice(0, 8)}] cookbook recommend ${handle.researchId} settled (rounds=${r.roundsUsed})`);
  }).catch((err) => {
    console.error(`[arco] cookbook recommend ${handle.researchId} settle error:`, err);
  });
}

// docs/ARCHITECTURE.md - Cookbook download + run + auto-register.
//
// OPERATOR-INITIATED ONLY: this handler runs solely on an explicit
// cookbook_download_request (a DOWNLOAD click, or a confirmed G3 recommendation).
// There is NO timer / hook / orchestrator path that pulls weights — the only
// caller is the WS router's `cookbook_download_request` case. The download is a
// single bounded fetch (HF stream or Ollama /api/pull); start/progress/done/
// refused/cancelled all broadcast via send() (workflowId → events.jsonl audit).
//
// The actual fetch + path-confinement + disk pre-flight + cancel-cleanup +
// atomic register live in cookbook/install.ts. This handler validates the
// request, wires an AbortController for cancel, relays install.ts's progress
// callbacks as cookbook_download_progress broadcasts, and tracks the in-flight
// controller so handleCancelCookbookDownload can abort it.
const cookbookDownloads = new Map<string, AbortController>();

export async function handleCookbookDownloadRequest(
  ws: WebSocket,
  session: Session,
  msg: import('@arco/shared').CookbookDownloadRequestMessage,
): Promise<void> {
  void session;
  const wf = workflows.get(msg.workflowId);
  if (!wf) {
    send(ws, { type: 'error', message: `Unknown workflow ${msg.workflowId.slice(0, 8)}` });
    return;
  }
  if (msg.source !== 'hf' && msg.source !== 'ollama') {
    send(ws, { type: 'error', message: 'Unknown download source.' });
    return;
  }

  const downloadId = `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const ctrl = new AbortController();
  cookbookDownloads.set(downloadId, ctrl);

  const emit = (p: DownloadProgress) => {
    send(ws, {
      type: 'cookbook_download_progress',
      workflowId: msg.workflowId,
      downloadId,
      source: msg.source,
      phase: p.phase,
      ...(p.receivedBytes !== undefined ? { receivedBytes: p.receivedBytes } : {}),
      ...(p.totalBytes !== undefined ? { totalBytes: p.totalBytes } : {}),
      ...(p.freeBytes !== undefined ? { freeBytes: p.freeBytes } : {}),
      ...(p.message ? { message: p.message } : {}),
    });
  };

  // Validate per-source up front so a malformed request fails before we spin up
  // an AbortController-tracked run.
  if (msg.source === 'hf' && (!msg.repo?.trim() || !msg.quant?.trim())) {
    cookbookDownloads.delete(downloadId);
    send(ws, { type: 'error', message: 'HF download needs a repo and quant.' });
    return;
  }
  if (msg.source === 'ollama' && !msg.name?.trim()) {
    cookbookDownloads.delete(downloadId);
    send(ws, { type: 'error', message: 'Ollama download needs a model name.' });
    return;
  }

  console.log(`[arco] [${msg.workflowId.slice(0, 8)}] cookbook download ${downloadId} started (source=${msg.source}, ${msg.source === 'hf' ? `${msg.repo}@${msg.quant}` : msg.name})`);

  const run = msg.source === 'hf'
    ? pullHfGguf(
        {
          repo: msg.repo!.trim(),
          quant: msg.quant!.trim(),
          ctxSize: msg.ctxSize,
          capabilities: msg.capabilities,
          alias: msg.alias,
        },
        ctrl.signal,
        emit,
      )
    : pullOllama({ name: msg.name!.trim() }, ctrl.signal, emit);

  run
    .then((r) => {
      cookbookDownloads.delete(downloadId);
      // The terminal phase (done/error/cancelled) was already emitted by the
      // install.ts progress callback; here we just re-stamp `alias` on a
      // successful HF register so the client can point at CONFIG.
      if (r.registered) {
        send(ws, {
          type: 'cookbook_download_progress',
          workflowId: msg.workflowId,
          downloadId,
          source: msg.source,
          phase: 'done',
          alias: r.registered.alias,
          message: `Registered as "${r.registered.alias}" — now selectable in CONFIG.`,
        });
        console.log(`[arco] [${msg.workflowId.slice(0, 8)}] cookbook download ${downloadId} registered "${r.registered.alias}"`);
      } else if (r.refused) {
        console.log(`[arco] [${msg.workflowId.slice(0, 8)}] cookbook download ${downloadId} REFUSED (size=${r.refused.sizeBytes} free=${r.refused.freeBytes})`);
      } else if (r.cancelled) {
        console.log(`[arco] [${msg.workflowId.slice(0, 8)}] cookbook download ${downloadId} cancelled`);
      } else if (r.error) {
        console.log(`[arco] [${msg.workflowId.slice(0, 8)}] cookbook download ${downloadId} failed: ${r.error}`);
      } else {
        console.log(`[arco] [${msg.workflowId.slice(0, 8)}] cookbook download ${downloadId} done`);
      }
    })
    .catch((err) => {
      cookbookDownloads.delete(downloadId);
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[arco] cookbook download ${downloadId} crashed:`, m);
      emit({ phase: 'error', message: m });
    });
}

// Cancel an in-flight download — aborts the fetch (install.ts deletes the
// partial file and writes NO catalog entry). Mirrors handleCancelResearch: a
// missing controller (already settled / server restart) synthesizes a
// terminal cancelled broadcast so the client doesn't hang.
export function handleCancelCookbookDownload(
  ws: WebSocket,
  workflowId: string,
  downloadId: string,
): void {
  const ctrl = cookbookDownloads.get(downloadId);
  if (ctrl) {
    ctrl.abort();
    cookbookDownloads.delete(downloadId);
    console.log(`[arco] [${workflowId.slice(0, 8)}] cookbook download ${downloadId} cancel requested`);
    return;
  }
  send(ws, {
    type: 'cookbook_download_progress',
    workflowId,
    downloadId,
    source: 'hf',
    phase: 'cancelled',
    message: 'Cancelled (no live download — likely already settled).',
  });
}

// docs/ARCHITECTURE.md - AI-collaborative document editing. Mirrors
// handleResearchRequest's account resolution, then spawns runDocEdit (a
// short-lived, READ-ONLY, NO-Write worker whose entire output is the proposed
// replacement for the operator's selection). Validates the request shape
// (non-empty selection + instruction) and returns a friendly error otherwise.
// No traversal/file concerns server-side here — the agent writes nothing; the
// echoed selectionFrom/selectionTo are client-side splice offsets only.
export async function handleDocEditRequest(
  ws: WebSocket,
  session: Session,
  msg: import('@arco/shared').DocEditRequestMessage,
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
  if (!msg.selectionText || !msg.selectionText.length) {
    send(ws, { type: 'error', message: 'Doc-edit selection is empty.' });
    return;
  }
  if (!msg.instruction?.trim()) {
    send(ws, { type: 'error', message: 'Doc-edit instruction is empty.' });
    return;
  }

  const editorAccount = msg.editor.provider === 'codex'
    ? await resolveProviderAccount('codex', msg.editor.providerAccountRef ?? wf.config.providerAccountRef, cwd).catch(() => null)
    : null;
  const editor = editorAccount
    ? { ...msg.editor, providerAccountRef: editorAccount.profile.id, codexHome: editorAccount.codexHome }
    : msg.editor;

  const handle = runDocEdit(
    {
      workflowId: msg.workflowId,
      cwd,
      manager: wf.manager,
      broadcast: (m) => send(ws, m),
    },
    {
      editor,
      filePath: msg.filePath,
      selectionText: msg.selectionText,
      selectionFrom: msg.selectionFrom,
      selectionTo: msg.selectionTo,
      contextBefore: msg.contextBefore ?? '',
      contextAfter: msg.contextAfter ?? '',
      instruction: msg.instruction,
      wholeDoc: !!msg.wholeDoc,
    },
  );

  console.log(`[arco] [${msg.workflowId.slice(0, 8)}] doc-edit ${handle.docEditId} started (editor=${msg.editor.provider}:${msg.editor.model}@${msg.editor.effort}, file=${msg.filePath.split('/').pop()}, wholeDoc=${!!msg.wholeDoc})`);

  handle.settled.then((r) => {
    if (r.error) console.log(`[arco] [${msg.workflowId.slice(0, 8)}] doc-edit ${handle.docEditId} failed: ${r.error}`);
    else console.log(`[arco] [${msg.workflowId.slice(0, 8)}] doc-edit ${handle.docEditId} proposed (${r.replacement.length} chars)`);
  }).catch((err) => {
    console.error(`[arco] doc-edit ${handle.docEditId} settle error:`, err);
  });
}

// Agent-instruction-file tune-up — see shared/src/protocol/mdTuneup.ts. Picks
// the right instruction file for the tab's provider (CLAUDE.md / AGENTS.md /
// GEMINI.md), then spawns runMdTuneup (a READ-ONLY worker that PROPOSES a
// compacted version). The proposal arrives as md_tuneup_proposed; the operator
// reviews the diff and Accepts → handleMdTuneupAccept does the backup + write.
//
// FENCE: same posture as handleDocEditRequest — the agent never writes the
// file; it proposes, the operator approves, the write is backed up + reversible.
function tuneupBaseNameForProvider(provider: string): 'CLAUDE.md' | 'AGENTS.md' | 'GEMINI.md' {
  if (provider === 'codex') return 'AGENTS.md';
  if (provider === 'gemini') return 'GEMINI.md';
  return 'CLAUDE.md';
}

// Discover the instruction files present in the cwd so the TUNE MD dialog can
// offer a pick list. `defaultPath` is the root file the tab's provider reads
// (pre-selected client-side) when it's among the candidates.
export async function handleMdTuneupCandidatesRequest(
  ws: WebSocket,
  session: Session,
  msg: import('@arco/shared').MdTuneupCandidatesRequestMessage,
): Promise<void> {
  void session;
  const wf = workflows.get(msg.workflowId);
  const cwd = wf?.config.workingDirectory;
  if (!wf || !cwd) {
    send(ws, { type: 'md_tuneup_candidates', workflowId: msg.workflowId, candidates: [] });
    return;
  }
  const candidates = await discoverInstructionFiles(cwd).catch(() => []);
  const providerDefault = tuneupBaseNameForProvider(wf.primary.provider);
  const defaultPath = candidates.find((c) => c.path === providerDefault)?.path;
  send(ws, { type: 'md_tuneup_candidates', workflowId: msg.workflowId, candidates, defaultPath });
}

export async function handleMdTuneupRequest(
  ws: WebSocket,
  session: Session,
  msg: import('@arco/shared').MdTuneupRequestMessage,
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

  // 'auto' → the file the tab's provider reads, at the repo root. Otherwise a
  // repo-relative path the operator picked from the discovered candidates.
  const target = msg.target && msg.target !== 'auto'
    ? msg.target
    : tuneupBaseNameForProvider(wf.primary.provider);
  const displayName = target.split('/').pop() || target;

  // Guard the resolved path and confirm the file exists before spawning a
  // worker — a missing file is operator error, not a tune-up. Surface it as
  // md_tuneup_proposed-with-error (NOT a generic error) so the modal the
  // operator just opened transitions to its error state instead of spinning.
  let abs: string;
  try {
    abs = resolveWithinCwd(cwd, target);
    await fsPromises.access(abs);
  } catch {
    send(ws, {
      type: 'md_tuneup_proposed',
      workflowId: msg.workflowId,
      tuneupId: `mdt-none-${Date.now().toString(36)}`,
      filePath: target,
      baseName: displayName,
      original: '',
      proposed: '',
      notes: '',
      originalBytes: 0,
      proposedBytes: 0,
      error: `No ${target} found in ${cwd}. Nothing to tune up.`,
      completedAt: Date.now(),
    });
    return;
  }

  const editorAccount = msg.editor.provider === 'codex'
    ? await resolveProviderAccount('codex', msg.editor.providerAccountRef ?? wf.config.providerAccountRef, cwd).catch(() => null)
    : null;
  const editor = editorAccount
    ? { ...msg.editor, providerAccountRef: editorAccount.profile.id, codexHome: editorAccount.codexHome }
    : msg.editor;

  const handle = runMdTuneup(
    { workflowId: msg.workflowId, cwd, manager: wf.manager, broadcast: (m) => send(ws, m) },
    { editor, filePath: abs },
  );

  console.log(`[arco] [${msg.workflowId.slice(0, 8)}] md-tuneup ${handle.tuneupId} started (file=${target}, editor=${msg.editor.provider}:${msg.editor.model}@${msg.editor.effort})`);

  handle.settled.then((r) => {
    if (r.error) console.log(`[arco] [${msg.workflowId.slice(0, 8)}] md-tuneup ${handle.tuneupId} failed: ${r.error}`);
    else console.log(`[arco] [${msg.workflowId.slice(0, 8)}] md-tuneup ${handle.tuneupId} proposed (${(r.proposed ?? '').length} chars)`);
  }).catch((err) => {
    console.error(`[arco] md-tuneup ${handle.tuneupId} settle error:`, err);
  });
}

// Operator accepted a tune-up proposal. Re-read the CURRENT on-disk file, back
// it up to `.arco/md-backups/<name>.<ts>.bak` (a hidden, .bak-suffixed path no
// agent auto-reads, but recoverable), then write the proposed content through
// the same resolveWithinCwd guard. The backup is written and fsync-flushed
// BEFORE the overwrite so a crash mid-write can never lose the original.
export async function handleMdTuneupAccept(
  ws: WebSocket,
  session: Session,
  msg: import('@arco/shared').MdTuneupAcceptMessage,
): Promise<void> {
  void session;
  const wf = workflows.get(msg.workflowId);
  const ts = Date.now();
  if (!wf) {
    send(ws, { type: 'md_tuneup_applied', workflowId: msg.workflowId, tuneupId: msg.tuneupId, filePath: msg.filePath, ok: false, error: `Unknown workflow ${msg.workflowId.slice(0, 8)}`, ts });
    return;
  }
  const cwd = wf.config.workingDirectory;
  if (!cwd) {
    send(ws, { type: 'md_tuneup_applied', workflowId: msg.workflowId, tuneupId: msg.tuneupId, filePath: msg.filePath, ok: false, error: 'Workflow has no working directory configured.', ts });
    return;
  }
  if (!msg.proposed || !msg.proposed.trim()) {
    send(ws, { type: 'md_tuneup_applied', workflowId: msg.workflowId, tuneupId: msg.tuneupId, filePath: msg.filePath, ok: false, error: 'Refusing to write an empty instruction file.', ts });
    return;
  }

  try {
    const abs = resolveWithinCwd(cwd, msg.filePath);
    const { backupPath, bytesWritten } = await backupAndWriteInstructionFile(cwd, abs, msg.proposed, ts);
    console.log(`[arco] [${msg.workflowId.slice(0, 8)}] md-tuneup ${msg.tuneupId} applied to ${path.basename(abs)} (${bytesWritten} bytes, backup ${backupPath})`);
    send(ws, { type: 'md_tuneup_applied', workflowId: msg.workflowId, tuneupId: msg.tuneupId, filePath: abs, ok: true, backupPath, bytesWritten, ts });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[arco] md-tuneup ${msg.tuneupId} accept failed:`, error);
    send(ws, { type: 'md_tuneup_applied', workflowId: msg.workflowId, tuneupId: msg.tuneupId, filePath: msg.filePath, ok: false, error, ts });
  }
}

// Workbench Expansion §F2 — operator-triggered (or operator-armed-on-close)
// conversation summary. Mirrors handleResearchRequest's account resolution:
// resolve the codex account like the reviewer/research path, then call
// summarizeWorkflow (which runs ONE bounded read-only LLM turn, falling back
// to the deterministic summarizePriorTurns digest on ANY failure — never
// fails closed). Emits recall_summary_ready (NOT workflow-scoped → not
// persisted to events.jsonl; routed to the global recall store).
//
// FENCE: the only callers are this WS message (the Recall Summarize button)
// and the operator-armed on-close hook. NEVER wired into a per-turn path.
//
// The target may be an ARCHIVED workflow (not an open tab): we use its live
// WorkerManager when it's open, else a transient one for the short-lived spawn.
export async function handleRecallSummaryRequest(
  ws: WebSocket,
  _session: Session,
  msg: import('@arco/shared').RecallSummaryRequestMessage,
): Promise<void> {
  const wfid = msg.wfid;
  // The index entry carries the cwd; resolve a codex account against that cwd
  // (or the open tab's, if any) exactly like the reviewer/research path.
  const entry = (() => {
    try { return getRecallIndex().get(wfid); } catch { return null; }
  })();
  if (!entry) {
    send(ws, { type: 'recall_summary_ready', wfid, summaryRef: null, ok: false, error: 'Conversation not found in the recall index.' });
    return;
  }
  const openWf = workflows.get(wfid);
  const cwd = openWf?.config.workingDirectory || entry.cwd;

  const summarizerAccount = msg.summarizer.provider === 'codex'
    ? await resolveProviderAccount('codex', msg.summarizer.providerAccountRef, cwd).catch(() => null)
    : null;
  const summarizer = summarizerAccount
    ? { ...msg.summarizer, providerAccountRef: summarizerAccount.profile.id, codexHome: summarizerAccount.codexHome }
    : msg.summarizer;

  // Open tab → reuse its manager; archived → a transient manager for the
  // short-lived read-only spawn (disposed implicitly when it goes out of scope).
  const manager = openWf?.manager ?? new WorkerManager();

  console.log(`[arco] [${wfid.slice(0, 8)}] recall summary requested (summarizer=${msg.summarizer.provider}:${msg.summarizer.model}@${msg.summarizer.effort})`);

  // summarizeWorkflow never throws — but guard the await anyway so a surprise
  // rejection still emits a structured event rather than crashing the handler.
  let result;
  try {
    result = await summarizeWorkflow({ wfid, summarizer, manager });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    send(ws, { type: 'recall_summary_ready', wfid, summaryRef: null, ok: false, error: m });
    return;
  }
  console.log(`[arco] [${wfid.slice(0, 8)}] recall summary settled (ok=${result.ok}, ref=${result.summaryRef ?? 'none'})`);
  send(ws, {
    type: 'recall_summary_ready',
    wfid,
    summaryRef: result.summaryRef,
    ok: result.ok,
    ...(result.error ? { error: result.error } : {}),
  });
}

// Live, same-provider edit of a workflow's primary model or effort. Provider
// stays pinned (the session UUID belongs to one CLI); next turn spawns with
// the updated args. Changes persist to meta.json so they survive reconnect.
// `handleUpdatePrimaryConfig` moved to ./updatePrimaryConfig.ts (size budget).
// Re-exported here so existing import sites (index.ts) are unchanged.
export { handleUpdatePrimaryConfig } from './updatePrimaryConfig.js';
