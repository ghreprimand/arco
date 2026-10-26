import './envAliases.js'; // env fallback resolves before any module reads ARCO_* (see envAliases.ts)
import { configureComputerActivity, interruptComputerActivity } from './voice/activity.js';
import { configureMailRules } from './voice/mailRules.js';
import { configureConditions } from './voice/conditions.js';
import { interruptComputerWatches } from './voice/watches.js';
import { setDeepSeekActivityCheck } from './providers/deepseekProfiles.js';
import { setStrataSwitchActivityCheck } from './providers/strataProfiles.js';
import { setOperatorQuestionPublisher } from './providers/codex-appserver/operatorQuestions.js';
import { resolveVoiceTool, setVoiceToolPublisher } from './voice/operatorTools.js';
import { handleOperatorQuestionReply } from './ws/operatorQuestionHandlers.js';
// Side-effect import, kept FIRST: forces this process onto IPv4 before any
// module can open a socket. See server/src/net/forceIpv4.ts for the incident.
import { loadWorkspace, onWorkspaceChange, syncWorkspace } from './workspace.js';
import './net/forceIpv4.js';
import { hydrateProcessPathFromUserEnv } from './runtimeEnv.js';
import type {
Capabilities,
ClientMessage,
ServerMessage,
WorkflowConfig
} from '@arco/shared';
import { isClusterMemberProvider } from '@arco/shared';
import { spawnSync } from 'child_process';
import { mkdir } from 'fs/promises';
import { createServer,IncomingMessage,ServerResponse } from 'http';
import { WebSocket,WebSocketServer } from 'ws';
import { detectCliChanges,probeCapabilities,type CliChange } from './capabilities.js';
import { ensureCatalog } from './catalog.js';
import * as clusterAutoTurn from './clusterAutoTurn.js';
import * as clusterIdleNudger from './clusterIdleNudger.js';
import * as clusterPlanBridge from './clusterPlanBridge.js';
import * as clusterStore from './clusterStore.js';
import * as taskDispatcher from './taskDispatcher.js';
import {
runCalibration,
type CalibrationState
} from './contextCalibrator.js';
import { BYTES_PER_TOKEN_DEFAULT,estimateContextFill,OVERHEAD_TOKENS_DEFAULT } from './contextEstimator.js';
import { recoverWorkflowsFromDisk } from './crashRecovery.js';
import { initHubLink, onHubLinkStatus, getHubLinkStatus, setHubLinkEnabled } from './management/initHubLink.js';
import { getRecallIndex } from './recall/index.js';
import { handleHttpRequest,type HttpDeps } from './http/router.js';
import { ensureCatalog as ensureLlamacppCatalog } from './llamacppCatalog.js';
import {
createPlan,
isValidPlanId,
readPlanSummary,
recordAttachment,
recordDetachment
} from './planStore.js';
import { PreviewAutoDetect } from './previewAutoDetect.js';
import { tryHandlePreviewUpgrade } from './previewProxy.js';
import { ptyManager, reapOrphanTerminals } from './terminal/ptyManager.js';
import { handleTerminalUpgrade, setTerminalKillHook, setTerminalExitHook } from './terminal/terminalChannel.js';
import { runPrimaryTurn } from './primitives/seedWorker.js';
import {
routeClaudeNativeQuestionReply,
routeClaudeNativeGateReply,
setClaudeNativeClusterEventBroadcast,
setClaudeNativePlanBroadcast,
setClaudeNativeTaskHandler,
setClaudeNativeTodosBroadcast,
setClaudeNativeWorkflowEventBroadcast,
debugSeedNativeCompactProbe,
} from './providers/claude-native/index.js';
import { setZaiNativeWorkflowEventBroadcast } from './providers/zai-native/index.js';
import type { PlanBroadcast,TaskSpawnHandle } from './providers/claude-native/worker.js';
import { scheduleGeminiNativeCatalogPrefetch } from './providers/gemini-native/catalog.js';
import { scheduleCursorCatalogPrefetch } from './providers/cursor/catalog.js';
import { llamacppManager } from './providers/llamacppManager.js';
import { lspManager } from './lsp/client.js';
import {
handleLiveChangesSubscribe,
handleLiveChangesUnsubscribe,
releaseLiveChangesForSocket
} from './liveChanges.js';
import {
wireSnapshot as quotaWireSnapshot,
setChangeListener as setQuotaListener
} from './quota.js';
import {
acquirePlansWatcher,
broadcastCluster,
broadcastTransient,
broadcastWorkflow,
buildClusterStatePayload,
notifyClusterStateForWorkflow,
releasePlansWatcher,
send,
sendAllHandoffLockSnapshots,
} from './server/broadcast.js';
import {
HOST,
PERIODIC_PROBE_INTERVAL_MS,
PORT,
PROJECT_ROOT,
UPLOADS_DIR
} from './server/constants.js';
import { markReady } from './server/readiness.js';
import { initFileLogging, getLogFilePath, withoutOperationalLogging } from './server/logger.js';
import {
sessions,
workflowCwds,
workflows
} from './server/state.js';
import {
acquireProjectSettingsWatcher,
installGlobalSettingsWatcher,
onSettingsChange,
readSettings
} from './settings.js';
import { WorkerManager } from './workers/WorkerManager.js';
import { clearRegisteredPids,readRegisteredProcs,reapProc } from './workers/pidRegistry.js';
import { captureBootRev } from './diagnostics/codeSkew.js';
import { formatShutdownForensics } from './diagnostics/shutdownForensics.js';
import { startMemoryMonitor, logMemorySample } from './memoryMonitor.js';
import { listeningPortsForPidFamily } from './workers/procListening.js';
import {
appendHistoryEntry,
clearProviderCliSessions,
readMeta,
updateMeta,
writeMeta,
} from './workflowMeta.js';
import {
flushAll as flushAllWorkflowEvents,
initWorkflowStore,
replayEvents as replayWorkflowEvents
} from './workflowStore.js';
import type {
Session
} from './workflows/types.js';
import {
detachClusterObservers,
handleClusterAddFreshWorkers,
handleClusterAutoTurnToggle,
handleClusterBroadcast,
handleClusterCreate,
handleClusterCreateFromScratch,
handleClusterCreateWithFreshWorkers,
handleClusterDelete,
handleClusterDispatchSettingsUpdate,
handleClusterDispatchOnce,
handleClusterDispatchToggle,
handleClusterSwarmCreate,
handleClusterOrchestrationAssistRequest,
handleClusterOrchestrationProposalApply,
handleClusterOrchestrationProposalList,
handleClusterOrchestrationProposalReject,
handleClusterIdleNudgerToggle,
handleClusterEfficiencySet,
handleClusterRemoteSet,
handleClusterGatesSet,
handleClusterMemberReorder,
handleClusterProgressSet,
handleClusterTaskBoardAttachSet,
handleClusterTaskBoardModeSet,
handleClusterMemberAdd,
handleClusterMemberFocusSet,
handleClusterMemberRemove,
handleClusterMemberReplace,
handleClusterMemberRoleSet,
handleClusterMemberTierSet,
handleClusterPlanAttach,
handleClusterPlanClear,
handleClusterPlanSet,
handleClusterRename,
handleClusterSnapshotSave,
handleClusterSnapshotList,
handleClusterSnapshotRestore,
handleClusterSnapshotDelete,
handleClusterSubscribe,
handleOperatorPeerSend,
dispatchTaskTurnSynthetic,
broadcastTaskDispatchResult,
initClusterHandlers,
} from './ws/clusterHandlers.js';
import {
broadcastSessionMetadata,
deriveAutoHandoff,
derivePrimaryConfig,
handleUserMessage,
initTurnEngine,
maybeAutoCompactNative,
persistInitialMeta,
writeCalibrationToMeta
} from './ws/turnEngine.js';
import {
  handleBakeoffCleanup,
  handleBakeoffList,
  handleBakeoffPromote,
  handleBakeoffStart,
  initBakeoffHandlers,
} from './ws/bakeoffHandlers.js';
import {
  createBlankNativeWorkflow,
  handleAttachCodebaseMemory,
  handleCancel,
  handleCancelQueuedMessage,
  handleCancelResearch,
  handleCancelCookbookDownload,
  handleCookbookDownloadRequest,
  handleCookbookRecommendRequest,
  handleCancelReview,
  handleClearPreviewPort,
  handleCreateLabelRequest,
  handleCreateWorkflow,
  handleDetachCodebaseMemory,
  handleDocEditRequest,
  handleMdTuneupRequest,
  handleMdTuneupAccept,
  handleMdTuneupCandidatesRequest,
  handleHandoffCancel,
  handleHandoffLockClear,
  handleLoadEarlierMessages,
  handleRemoveWorkflow,
  handleRenameWorkflow,
  handleRevertToCheckpoint,
  handleRevertToPointRequest,
  handleResearchRequest,
  handleRecallSummaryRequest,
  handleReviewRequest,
  handleSetPreviewPort,
  handleUpdatePrimaryConfig,
  initWorkflowHandlers,
} from './ws/workflowHandlers.js';
import { handleKnowledgeDistillRequest } from './ws/knowledgeHandlers.js';
import { handleCompactWorkflow, handleFoldWorkflow } from './ws/compactHandlers.js';
import { handleComputerContextControl, announceComputerSettled } from './voice/computerContext.js';
import { handleSetToolPosture } from './ws/postureHandlers.js';
import { handleSetProjectTrust } from './ws/projectTrustHandlers.js';
import {
  handleTaskLedgerCreate,
  handleTaskLedgerUpdate,
  handleTaskLedgerDelete,
  handleTaskLedgerList,
  handleTaskRunRecover,
  sendTaskLedgerSnapshot,
} from './ws/taskLedgerHandlers.js';
import {
  handleTaskWorktreeCreate,
  handleTaskWorktreeRemove,
} from './ws/taskWorktreeHandlers.js';
import { handleGenesisSeedUpdate, handleGenesisScaffold, handleGenesisCreativeArm, handleGenesisAssistRequest } from './ws/genesisHandlers.js';
import { handlePreviewCaptureRequest } from './ws/previewCaptureHandlers.js';
import { initNotifications, mutesMessage, setMutes as setNotificationMutes, notifyQuotaRecovered, emit as emitNotice } from './notifications.js';
import { initNtfyTransport } from './ntfyTransport.js';
import { loadFriendlyName } from './management/identity.js';
import {
  handleMcpRegistryList,
  handleMcpRegistryCreate,
  handleMcpRegistryUpdate,
  handleMcpRegistryDelete,
  handleMcpWorkflowAllow,
  handleMcpProbe,
} from './ws/mcpHandlers.js';
import {
  handleCompareRequest,
  handleCompareVote,
  handleCompareSynthesize,
  handleCancelCompare,
} from './ws/compareHandlers.js';
import {
  handleHandoffRequest,
  handleRehydrateWorkflows,
  handleClusterMemberRehydrate,
  registerAllClusterMembersOnBoot,
  handleSpawnFromHere,
  initHandoffHandlers,
} from './ws/handoffHandlers.js';
import { resolveOrphanedGate, handleGateRevoke } from './ws/gateHandlers.js';
import { checkRequestOrigin } from './http/originGuard.js';
import { checkUpgradeAuth, describePeer, wsAuthEnabled } from './http/wsAuth.js';

// Strict-incognito exception list, read by the protocol fence in the ws
// message handler below. That fence rejects every config
// surface because a config edit is how a stale client would make an incognito
// workflow touch disk or opt into the management hub. These three fields do
// neither: model / effort choose the next turn's worker, chatWebAccess arms
// web_search + web_fetch, and none of them is persisted (an incognito chat's
// cwd is the private incognitoChatCwd() dir, so the meta write finds no meta.json to update).
// Anything else on the message — remoteEnabled above all — still gets rejected.
const INCOGNITO_SAFE_CONFIG_FIELDS = new Set(['type', 'workflowId', 'model', 'effort', 'chatWebAccess']);

function isIncognitoSafeConfigEdit(msg: ClientMessage): boolean {
  if (msg.type !== 'update_primary_config') return false;
  return Object.keys(msg).every((k) => INCOGNITO_SAFE_CONFIG_FIELDS.has(k));
}

// Shut down the whole dev process tree (concurrently + tsx + vite + us).
function killDevWrapper(): void {
  // SIGKILL the entire dev tree associated with this Arco checkout.
  // The pattern matches by absolute path so we don't touch anything
  // running from a different repo on the same machine. Three layers:
  //   - .bin/(concurrently|tsx|vite): the wrapper scripts
  //   - tsx/dist/(preflight|loader): the actual server node process
  //     (grandchild of tsx-watch — survives if we only kill .bin/tsx,
  //     and it's the one holding port 3001)
  //   - vite/dist/node: the actual vite node process (same shape, holds 5173)
  // Workflow events are flushed (flushAllWorkflowEvents awaited) before
  // this fires; sockets and file locks are released by the kernel on
  // process death, so SIGKILL is safe.
  const patterns = [
    `${PROJECT_ROOT}/node_modules/\\.bin/(concurrently|tsx|vite)`,
    `${PROJECT_ROOT}/node_modules/tsx/dist`,
    `${PROJECT_ROOT}/node_modules/vite/dist`,
  ];
  for (const p of patterns) {
    try {
      spawnSync('pkill', ['-KILL', '-f', p], { stdio: 'ignore' });
    } catch { /* ignore — best effort */ }
  }
}

hydrateProcessPathFromUserEnv();

// Install the console privacy/filter wrapper as early as practical. Structured
// file output remains inert unless ARCO_LOG_FILE=1 (set by the systemd unit),
// while dev stdout still honors strict-incognito suppression. See logger.ts.
initFileLogging();

// H46 — periodic RSS/heap trend logging. Gated on the same signal as file
// logging (getLogFilePath() non-null), so it's inert in dev and writes through
// the file-logging tee in prod. The interval timer is .unref()'d internally.
startMemoryMonitor({ enabled: getLogFilePath() !== null });

await mkdir(UPLOADS_DIR, { recursive: true });

let capabilities: Capabilities = await probeCapabilities();
console.log(`[arco] CLI capabilities: v${capabilities.cliVersion} | efforts: ${capabilities.efforts.join(',')}`);
// H43 — snapshot the git HEAD the running build booted from, so the code-skew
// probe can later report how far the live dist has drifted behind on-disk HEAD.
// Captured here in the boot import graph (before listen()), mirroring readiness's
// BOOTED_AT; idempotent, never throws.
captureBootRev();

// §B2 — capabilities is a pre-listen() top-level await, so it's always done by
// the time we're listening. Flip the readiness component now (the other,
// `stores`, flips on the post-listen workflow recovery below).
markReady('capabilities');

// Antigravity desktop integration — probe the isolated-profile CDP endpoint
// at boot so the operator sees "available / not running / not installed" in
// the server log without having to dig through runtime errors.
(async () => {
  try {
    const { antigravityManager } = await import('./providers/antigravityManager.js');
    const diag = await antigravityManager.diagnostics();
    const profile = diag.profileMode === 'default'
      ? 'default profile'
      : `${diag.profileMode} profile${diag.userDataDir ? ` ${diag.userDataDir}` : ''}`;
    if (diag.available) {
      console.log(`[arco] Antigravity: available (RPC, debug-port :${diag.cdpPort}, ${profile}, model ${diag.configuredModelId}${diag.cdp.browser ? `, ${diag.cdp.browser}` : ''})`);
    } else if (diag.installed) {
      console.log(`[arco] Antigravity: not running (${diag.reason}, ${profile}, model ${diag.configuredModelId}) — will lazy-spawn on first use`);
    } else {
      console.log(`[arco] Antigravity: not installed (${diag.reason})`);
    }
  } catch (err) {
    console.warn('[arco] Antigravity probe failed:', err instanceof Error ? err.message : err);
  }
})();

// Diff CLI help surfaces against the last boot's snapshots. First-run
// providers seed a baseline silently; subsequent version/flag changes are
// reported once via `capabilities_changed` on WS connect, filtered by
// operator-acknowledged versions from ~/.arco/settings.json.
let cliChanges: CliChange[] = [];
try {
  cliChanges = await detectCliChanges(capabilities);
  if (cliChanges.length > 0) {
    for (const c of cliChanges) {
      console.log(`[arco] CLI change — ${c.provider} ${c.fromVersion} → ${c.toVersion} (+${c.newFlags.length} / -${c.removedFlags.length} flags)`);
    }
  }
} catch (err) {
  console.warn('[arco] CLI change detection failed:', err instanceof Error ? err.message : err);
}

// Periodic background re-probe. The three primary-capable CLIs (Claude,
// Gemini, Codex) release updates often; one-shot boot detection misses
// upgrades installed while Arco is long-lived. Every 4h we re-run
// probeCapabilities + detectCliChanges, broadcast the refreshed
// capabilities + any newly-detected changes to every open client, and
// merge into cliChanges so future reconnects see them too.
async function periodicCapabilityProbe(): Promise<void> {
  try {
    const next = await probeCapabilities();
    const lvNext = next.latestVersions ?? {};
    const lvPrev = capabilities.latestVersions ?? {};
    const versionsChanged =
      next.cliVersion !== capabilities.cliVersion ||
      next.geminiVersion !== capabilities.geminiVersion ||
      next.codexVersion !== capabilities.codexVersion ||
      next.cursorVersion !== capabilities.cursorVersion ||
      next.strataVersion !== capabilities.strataVersion ||
      next.xolotlRevision !== capabilities.xolotlRevision ||
      lvNext.claude !== lvPrev.claude ||
      lvNext.gemini !== lvPrev.gemini ||
      lvNext.codex !== lvPrev.codex ||
      lvNext.ollama !== lvPrev.ollama ||
      lvNext.strata !== lvPrev.strata ||
      lvNext.xolotl !== lvPrev.xolotl;
    capabilities = next;
    let changes: CliChange[] = [];
    try { changes = await detectCliChanges(next); } catch { /* best-effort */ }
    if (!versionsChanged && changes.length === 0) return;
    for (const c of changes) {
      console.log(`[arco] Periodic CLI change — ${c.provider} ${c.fromVersion} → ${c.toVersion} (+${c.newFlags.length} / -${c.removedFlags.length} flags)`);
    }
    if (changes.length > 0) cliChanges = [...cliChanges, ...changes];
    for (const [ws] of sessions) {
      if (versionsChanged) {
        send(ws, { type: 'capabilities_updated', capabilities: next, updated: true, previousVersion: '' });
      }
      if (changes.length > 0) {
        send(ws, { type: 'capabilities_changed', changes });
      }
    }
  } catch (err) {
    console.warn('[arco] periodic capability probe failed:', err instanceof Error ? err.message : err);
  }
}
setInterval(() => { periodicCapabilityProbe().catch(() => { /* swallow */ }); }, PERIODIC_PROBE_INTERVAL_MS);

// ── HTTP server ──

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  void handleHttpRequest(req, res, httpDeps);
});

// ── WebSocket server ──
//
// `wss` is `noServer: true` and the manual upgrade fan-out below is the SINGLE
// owner of httpServer's 'upgrade' event. We previously built it as
// `{ server: httpServer, path: '/ws' }`, which makes ws attach its OWN upgrade
// listener IN ADDITION to ours. Both then fired for every upgrade: on a
// `/terminal` (or preview) upgrade our fan-out upgraded the socket, and THEN
// ws's listener also ran, saw a non-'/ws' path, and called
// abortHandshake(socket, 400) on the already-live socket — writing
// "HTTP/1.1 400 Bad Request" bytes into the raw WS stream. The browser parsed
// that leading 'H' (0x48) as a frame header with RSV1 set → "Invalid frame
// header" and a permanently dead terminal (the proxy was never at fault). One
// owner, one handleUpgrade per path, no double-fire.
const wss = new WebSocketServer({ noServer: true });

// WS upgrade fan-out — the sole 'upgrade' listener. Routes '/ws' to the main
// protocol server, '/terminal' to the raw-PTY channel, preview paths to the
// preview proxy, everything else to a clean 404.
httpServer.on('upgrade', (req, socket, head) => {
  const wsPath = (req.url || '').split('?')[0];
  // Browsers don't apply CORS to WebSockets, so a hostile page could open
  // /terminal (a raw shell) or /ws with nothing but the loopback bind in the
  // way. Same Origin/Host rule as HTTP (http/originGuard.ts).
  const guard = checkRequestOrigin(req);
  if (!guard.ok) {
    console.warn(`[arco] refused upgrade ${wsPath}: ${guard.reason}`);
    try {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
    } catch { /* ignore */ }
    return;
  }
  // Control socket + raw PTY need the browser session cookie (http/wsAuth.ts) —
  // the origin guard alone admits any Origin-less local process, including
  // the agents this server spawns. Preview upgrades stay on the origin guard.
  if (wsPath === '/ws' || wsPath === '/terminal') {
    const auth = checkUpgradeAuth(req);
    if (!auth.ok) {
      console.warn(`[arco] refused upgrade ${wsPath}: ${auth.reason} (${describePeer(req)})`);
      try {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
      } catch { /* ignore */ }
      return;
    }
  }
  if (wsPath === '/ws') {
    wss.handleUpgrade(req, socket, head, (client, request) => wss.emit('connection', client, request));
    return;
  }
  // WORKBENCH_EXPANSION §K1 — the dedicated `/terminal` raw-PTY channel. Rides
  // the same loopback-bound HTTP server as `/ws`, so it inherits the identical
  // access posture (origin guard + the session-cookie gate above). See
  // server/src/terminal/terminalChannel.ts.
  if (handleTerminalUpgrade(req, socket, head)) return;
  if (tryHandlePreviewUpgrade(req, socket, head, (wfid) => workflows.get(wfid)?.preview?.port, { allowReferer: true })) {
    return;
  }
  // Unknown upgrade target — close cleanly so curious clients get a clear NACK.
  try {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  } catch { /* ignore */ }
});

// Deps the extracted HTTP router (http/router.ts) closes over but cannot import
// without a cycle back into index.ts: the mutable capabilities cell, the two
// server handles (for shutdown routes), the dev-wrapper killer, and four
// plan/cluster handlers. Declared after `wss` so both server handles exist.
const httpDeps: HttpDeps = {
  getCapabilities: () => capabilities,
  setCapabilities: (c) => { capabilities = c; },
  httpServer,
  wss,
  killDevWrapper,
  detachAllForPlan,
  handlePlanAttach,
  handleClusterDelete,
  assertAllMembersClaudeOrCodex,
};

// FILE_SIZE_REFACTOR_PLAN.md Phase 4 — inject the four index.ts-local
// back-edges into the extracted cluster handler module exactly once, before
// the server accepts connections. These four are hoisted function
// declarations, so they're available here at module-eval time.
initClusterHandlers({
  handleUserMessage,
  handleRemoveWorkflow,
  createBlankNativeWorkflow,
  assertAllMembersClaudeOrCodex,
});
initBakeoffHandlers({
  handleUserMessage,
  handleRemoveWorkflow,
  createBlankNativeWorkflow,
});

// Zombie-socket heartbeat: ws.readyState can stay OPEN while bytes silently
// vanish. Ping every 15s; if the prior pong never arrived, terminate.
const heartbeatInterval = setInterval(() => {
  for (const client of wss.clients) {
    const hb = client as WebSocket & { isAlive?: boolean };
    if (hb.isAlive === false) {
      try { client.terminate(); } catch { /* already gone */ }
      continue;
    }
    hb.isAlive = false;
    try { client.ping(); } catch { /* peer teardown raced us */ }
  }
}, 15000);
wss.on('close', () => clearInterval(heartbeatInterval));



// MASTER_REFACTOR §3.3 F5 (2026-05-11) — let clusterStore.displayNameFor
// surface the operator-set workflow name. The resolver is module-scoped in
// clusterStore so peer-ops + member payload builders don't need to thread
// the workflow registry through every callsite. Installs once at startup.
clusterStore.setWorkflowNameResolver((wfid) => workflows.get(wfid)?.config.name);

// ARCO_OPS_PLAN.md §J1 — inject the global all-clients sender into the
// notification hub + load persisted mutes. Fire-and-forget (the read is best-
// effort; emits before it resolves just see an empty mute set).
void initNotifications((msg) => {
  for (const ws of sessions.keys()) {
    try { send(ws, msg); } catch { /* socket may already be torn down */ }
  }
});

// J2 — ntfy external push. Inert unless ARCO_NTFY_URL is set; when active it
// hangs a fire-and-forget POST off the J1 notice chokepoint, labeled with this
// workstation's friendly name and click-linking to the K2 console.
initNtfyTransport({
  instanceLabel: loadFriendlyName(),
  // REMOTE_MANAGEMENT.md §1.4 + R3 §3 — gate phone pushes by the remote
  // opt-in: clustered workflows follow their CLUSTER's switch, standalone
  // workflows their own flag. Instance-level notices (no workflowId) always push.
  isRemoteEnabled: (workflowId) => {
    const cid = clusterStore.getClusterIdForWorkflow(workflowId);
    if (cid) return clusterStore.isClusterRemoteEnabled(cid);
    return workflows.get(workflowId)?.config.remoteEnabled === true;
  },
});

// Server-authoritative tab set: every open/close anywhere re-syncs every
// browser's tab strip (server/src/workspace.ts).
void loadWorkspace();
onWorkspaceChange((workspace) => {
  for (const ws of sessions.keys()) {
    try { send(ws, { type: 'workspace_changed', workspace }); } catch { /* socket may already be torn down */ }
  }
});

// Global quota broadcast fan-out.
setQuotaListener((provider, next) => {
  const msg: ServerMessage = {
    type: 'quota_status',
    providers: quotaWireSnapshot(),
    timestamp: Date.now(),
  };
  for (const ws of sessions.keys()) {
    try { send(ws, msg); } catch { /* socket may already be torn down */ }
  }
  // §J1 — markAvailable only fires the listener on a real throttled→available
  // flip, so a non-throttled state here IS a recovery worth a notice.
  if (!next.throttled) notifyQuotaRecovered(provider);
});




// Auto-bind the Preview tab when the agent starts a dev server. Hooked
// into the seedWorker tool-use bridge for any Bash(run_in_background) call
// whose command shape matches a known dev server. See previewAutoDetect.ts
// for the matching rules and probe loop.
const previewAutoDetect = new PreviewAutoDetect({
  getCurrentPreview: (wfid) => {
    const wf = workflows.get(wfid);
    if (!wf?.preview) return undefined;
    return { port: wf.preview.port, manual: wf.preview.manual };
  },
  setAutoBoundPort: (wfid, port, framework) =>
    handleSetPreviewPort(wfid, port, framework, /* manual */ false),
  clearAutoBoundPort: (wfid) => handleClearPreviewPort(wfid),
  isPortHeldByOtherWorkflow: (selfWfid, port) => {
    for (const [wfid, wf] of workflows) {
      if (wfid === selfWfid) continue;
      if (wf.preview?.port === port) return true;
    }
    return false;
  },
  getRootPidForToolUse: (wfid, toolUseId) => {
    const wf = workflows.get(wfid);
    return wf?.bgTracker?.rootPidForToolUse(toolUseId);
  },
  listeningPortsForPidFamily,
});

initTurnEngine({ previewAutoDetect, handleCreateWorkflow, handleHandoffRequest });
initWorkflowHandlers({ previewAutoDetect, handleRehydrateWorkflows });
setStrataSwitchActivityCheck(() => [...workflows.values()].some((wf) =>
  (wf.busy && ['ollama', 'llamacpp', 'lmstudio', 'deepseek'].includes(wf.primary.provider)) ||
  Object.values(wf.manager.snapshotWorkers()).some((w) => ['ollama', 'llamacpp', 'lmstudio', 'deepseek'].includes(w.provider ?? '') && (w.status === 'running' || w.status === 'spawning'))));
setDeepSeekActivityCheck((includeDeepSeek) => [...workflows.values()].some((wf) =>
  (wf.busy && ['ollama', 'llamacpp', 'lmstudio', 'strata', ...(includeDeepSeek ? ['deepseek'] : [])].includes(wf.primary.provider)) ||
  Object.values(wf.manager.snapshotWorkers()).some((w) => ['ollama', 'llamacpp', 'lmstudio', 'strata', ...(includeDeepSeek ? ['deepseek'] : [])].includes(w.provider ?? '') && (w.status === 'running' || w.status === 'spawning'))));
setOperatorQuestionPublisher((workflowId, question) => broadcastWorkflow(workflowId, { type: 'operator_question', workflowId, question }));
// VOICE_AGENT_PLAN.md — voice tool calls go to the Computer chat's observers;
// the browser with the hands-free session answers (others ignore the call).
// Sent straight to the sockets, NOT through broadcastWorkflow: a persisted
// voice_tool_call would be replayed on reconnect and could re-run an action.
// The model's own tool-use item in the chat transcript is the durable record.
setVoiceToolPublisher((workflowId, message) => {
  const wf = workflows.get(workflowId);
  if (!wf) return 0;
  let delivered = 0;
  for (const observer of wf.observers) {
    if (observer.readyState === WebSocket.OPEN) { observer.send(JSON.stringify(message)); delivered++; }
  }
  return delivered;
});
initHandoffHandlers({ previewAutoDetect, handleCreateWorkflow, handlePlanAttach, assertAllMembersClaudeOrCodex });


wss.on('connection', (ws: WebSocket) => {
  const sessionId = crypto.randomUUID();
  const session: Session = { id: sessionId, workflowIds: new Set(), clusterIds: new Set(), clusterObserved: new Map() };
  sessions.set(ws, session);

  (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
  ws.on('pong', () => { (ws as WebSocket & { isAlive?: boolean }).isAlive = true; });

  console.log(`[arco] Client connected: ${sessionId.slice(0, 8)}`);
  send(ws, { type: 'connected', sessionId });

  send(ws, {
    type: 'quota_status',
    providers: quotaWireSnapshot(),
    timestamp: Date.now(),
  });
  // §J1 — current notification mute set so the notice-center renders in sync.
  send(ws, mutesMessage());
  // Current hub-link status so the header indicator renders on connect.
  {
    const hs = getHubLinkStatus();
    send(ws, { type: 'hub_link_status', connected: hs.connected, monitoredCount: hs.monitoredCount, ...(hs.hubUrl ? { hubUrl: hs.hubUrl } : {}), ...(hs.connectedSince !== undefined ? { connectedSince: hs.connectedSince } : {}) });
  }
  sendAllHandoffLockSnapshots(ws);

  // CLI change notice — filtered by acknowledged versions so the dot
  // stays dark after the operator hits "ack" on a given bump.
  if (cliChanges.length > 0) {
    readSettings()
      .then((s) => {
        const ack = s.acknowledgedCliVersions ?? {};
        const unacked = cliChanges.filter((c) => ack[c.provider] !== c.toVersion);
        if (unacked.length > 0) {
          send(ws, { type: 'capabilities_changed', changes: unacked });
        }
      })
      .catch(() => {
        send(ws, { type: 'capabilities_changed', changes: cliChanges });
      });
  }

  ws.on('message', (data: Buffer) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      send(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    // Strict-incognito protocol fence. The dedicated Chat surface needs only
    // text turns, queue cancellation, stop, rename, and close. Reject every
    // project/primitive/config surface server-side so a stale or handcrafted
    // client cannot make an incognito workflow write artifacts or opt into the
    // management hub.
    const scopedWorkflowId = 'workflowId' in msg && typeof msg.workflowId === 'string'
      ? msg.workflowId
      : undefined;
    const scopedIncognito = scopedWorkflowId
      ? workflows.get(scopedWorkflowId)?.config.incognito === true
      : false;
    if (scopedIncognito && !new Set([
      'user_message', 'cancel', 'cancel_queued_message', 'remove_workflow', 'rename_workflow',
    ]).has(msg.type) && !(workflows.get(scopedWorkflowId!)?.config.voiceOperator && ['computer_context_control', 'voice_tool_result'].includes(msg.type)) && !isIncognitoSafeConfigEdit(msg)) {
      send(ws, { type: 'error', workflowId: scopedWorkflowId, message: 'That operation is unavailable in strict Incognito Chat.' });
      return;
    }

    switch (msg.type) {
      case 'create_workflow':
        (msg.config.incognito ? withoutOperationalLogging : <T>(fn: () => T) => fn())(() =>
          handleCreateWorkflow(ws, session, msg.config).catch((err) => {
            console.error('[arco] create_workflow handler failed:', err);
          }),
        );
        break;
      // §J1 — operator mute preference. Inform-only system: this is the ONLY
      // client message the notification path services, and it sets a preference,
      // not a command. setMutes persists + re-broadcasts the snapshot to all.
      case 'set_notification_mutes':
        setNotificationMutes(msg.muted);
        break;
      case 'user_message':
        if (scopedIncognito && ((msg.attachments?.length ?? 0) > 0 || msg.primitive !== undefined || (msg.pickedSkills?.length ?? 0) > 0)) {
          send(ws, { type: 'error', workflowId: msg.workflowId, message: 'Attachments, skills, and workbench primitives are unavailable in strict Incognito Chat.' });
          break;
        }
        (workflows.get(msg.workflowId)?.config.incognito ? withoutOperationalLogging : <T>(fn: () => T) => fn())(() =>
          handleUserMessage(ws, session, msg.workflowId, msg.content, msg.clientMessageId, msg.attachments, msg.interjection === true, msg.kind, msg.primitive, msg.pickedSkills).catch((err) => {
            console.error('[arco] user_message handler failed:', err);
          // Tell the client the turn died — without this, the UI sits
          // mid-turn forever on any internal exception inside the handler.
          // primary_turn_ended unsticks busy + composer; system_notice
          // gives the operator a visible signal something went wrong.
          const wf = workflows.get(msg.workflowId);
          if (wf) {wf.busy = false;void announceComputerSettled(msg.workflowId);}
          send(ws, {
            type: 'system_notice',
            workflowId: msg.workflowId,
            content: `[arco] user_message handler crashed: ${err instanceof Error ? err.message : String(err)}`,
          });
          send(ws, {
            type: 'primary_turn_ended',
            workflowId: msg.workflowId,
            endedAt: Date.now(),
          });
          // Crash path sent primary_turn_ended via send(ws, ...) (single
          // socket, not broadcastWorkflow), so the cluster_state trigger
          // didn't fire. Notify directly so cluster-level indicators drop.
            void notifyClusterStateForWorkflow(msg.workflowId);
          }),
        );
        break;
      case 'cancel':
        (scopedIncognito ? withoutOperationalLogging : <T>(fn: () => T) => fn())(() => handleCancel(ws, msg.workflowId));
        break;
      case 'computer_context_control':
        (scopedIncognito ? withoutOperationalLogging : <T>(fn: () => T) => fn())(() => handleComputerContextControl(ws, msg)).catch((err) => {
          send(ws, { type: 'error', workflowId: msg.workflowId, message: `Computer context control failed: ${err instanceof Error ? err.message : String(err)}` });
        });
        break;
      case 'compact_workflow':
        handleCompactWorkflow(ws, session, msg).catch((err) => {
          console.error('[arco] compact_workflow handler failed:', err);
        });
        break;
      case 'fold_workflow':
        handleFoldWorkflow(ws, session, msg).catch((err) => {
          console.error('[arco] fold_workflow handler failed:', err);
        });
        break;
      case 'set_tool_posture':
        handleSetToolPosture(ws, session, msg);
        break;
      case 'set_project_trust':
        void handleSetProjectTrust(ws, session, msg);
        break;
      case 'hub_link_set_enabled':
        // Local kill switch / reconnect for the management-hub link. The status
        // listener broadcasts the new state to every client.
        setHubLinkEnabled(msg.enabled);
        break;
      case 'cancel_queued_message':
        (scopedIncognito ? withoutOperationalLogging : <T>(fn: () => T) => fn())(() => handleCancelQueuedMessage(ws, msg.workflowId, msg.clientMessageId));
        break;
      case 'remove_workflow':
        (scopedIncognito ? withoutOperationalLogging : <T>(fn: () => T) => fn())(() => handleRemoveWorkflow(msg.workflowId));
        break;
      case 'bakeoff_list':
        handleBakeoffList(ws, msg).catch((err) => {
          console.error('[arco] bakeoff_list handler failed:', err);
        });
        break;
      case 'bakeoff_start':
        handleBakeoffStart(ws, session, msg).catch((err) => {
          console.error('[arco] bakeoff_start handler failed:', err);
        });
        break;
      case 'bakeoff_promote':
        handleBakeoffPromote(ws, msg).catch((err) => {
          console.error('[arco] bakeoff_promote handler failed:', err);
        });
        break;
      case 'bakeoff_cleanup':
        handleBakeoffCleanup(ws, msg).catch((err) => {
          console.error('[arco] bakeoff_cleanup handler failed:', err);
        });
        break;
      case 'workspace_sync':
        syncWorkspace(msg.adopt === true, Array.isArray(msg.workflows) ? msg.workflows : [], Array.isArray(msg.clusterIds) ? msg.clusterIds : [])
          .then((workspace) => send(ws, { type: 'workspace_snapshot', workspace }))
          .catch((err) => console.error('[arco] workspace_sync failed:', err));
        break;
      case 'rehydrate_workflows':
        handleRehydrateWorkflows(ws, session, msg.workflows).catch((err) => {
          console.error('[arco] rehydrate handler failed:', err);
        });
        break;
      case 'upload_complete':
        send(ws, { type: 'file_uploaded', fileId: msg.fileId, filename: msg.filename, path: msg.path });
        break;
      case 'review_request':
        handleReviewRequest(ws, session, msg).catch((err) => {
          console.error('[arco] review_request handler failed:', err);
        });
        break;
      case 'cancel_review':
        handleCancelReview(ws, msg.workflowId, msg.reviewId);
        break;
      case 'research_request':
        handleResearchRequest(ws, session, msg).catch((err) => {
          console.error('[arco] research_request handler failed:', err);
        });
        break;
      case 'cancel_research':
        handleCancelResearch(ws, msg.workflowId, msg.researchId);
        break;
      case 'compare_request':
        handleCompareRequest(ws, session, msg).catch((err) => {
          console.error('[arco] compare_request handler failed:', err);
        });
        break;
      case 'compare_vote':
        handleCompareVote(ws, msg);
        break;
      case 'compare_synthesize':
        handleCompareSynthesize(ws, msg).catch((err) => {
          console.error('[arco] compare_synthesize handler failed:', err);
        });
        break;
      case 'cancel_compare':
        handleCancelCompare(ws, msg.workflowId, msg.compareId);
        break;
      case 'cookbook_recommend_request':
        handleCookbookRecommendRequest(ws, session, msg).catch((err) => {
          console.error('[arco] cookbook_recommend_request handler failed:', err);
        });
        break;
      case 'cookbook_download_request':
        handleCookbookDownloadRequest(ws, session, msg).catch((err) => {
          console.error('[arco] cookbook_download_request handler failed:', err);
        });
        break;
      case 'cookbook_cancel_download':
        handleCancelCookbookDownload(ws, msg.workflowId, msg.downloadId);
        break;
      case 'doc_edit_request':
        handleDocEditRequest(ws, session, msg).catch((err) => {
          console.error('[arco] doc_edit_request handler failed:', err);
        });
        break;
      case 'md_tuneup_candidates_request':
        handleMdTuneupCandidatesRequest(ws, session, msg).catch((err) => {
          console.error('[arco] md_tuneup_candidates_request handler failed:', err);
        });
        break;
      case 'md_tuneup_request':
        handleMdTuneupRequest(ws, session, msg).catch((err) => {
          console.error('[arco] md_tuneup_request handler failed:', err);
        });
        break;
      case 'md_tuneup_accept':
        handleMdTuneupAccept(ws, session, msg).catch((err) => {
          console.error('[arco] md_tuneup_accept handler failed:', err);
        });
        break;
      case 'recall_summary_request':
        handleRecallSummaryRequest(ws, session, msg).catch((err) => {
          console.error('[arco] recall_summary_request handler failed:', err);
        });
        break;
      case 'knowledge_distill_request':
        handleKnowledgeDistillRequest(ws, session, msg).catch((err) => {
          console.error('[arco] knowledge_distill_request handler failed:', err);
        });
        break;
      case 'handoff_request':
        handleHandoffRequest(ws, session, msg).catch((err) => {
          console.error('[arco] handoff_request handler failed:', err);
        });
        break;
      case 'handoff_cancel':
        handleHandoffCancel(ws, msg.workflowId, msg.handoffId);
        break;
      case 'handoff_lock_clear':
        handleHandoffLockClear(ws, msg.cwd, msg.workflowId, msg.handoffId);
        break;
      case 'spawn_from_here_request':
        handleSpawnFromHere(ws, session, msg).catch((err) => {
          console.error('[arco] spawn_from_here_request handler failed:', err);
        });
        break;
      case 'update_primary_config':
        handleUpdatePrimaryConfig(ws, session, msg).catch((err) => {
          console.error('[arco] update_primary_config handler failed:', err);
        });
        break;
      case 'load_earlier_messages':
        handleLoadEarlierMessages(ws, msg.workflowId);
        break;
      case 'recalibrate_request':
        handleRecalibrateRequest(ws, msg.workflowId).catch((err) => {
          console.error('[arco] recalibrate_request handler failed:', err);
        });
        break;
      case 'fresh_antigravity_cascade':
        handleFreshAntigravityCascadeRequest(ws, msg.workflowId).catch((err) => {
          console.error('[arco] fresh_antigravity_cascade handler failed:', err);
        });
        break;
      case 'plan_attach':
        handlePlanAttach(msg.workflowId, msg.planId).catch((err) => {
          console.error('[arco] plan_attach handler failed:', err);
        });
        break;
      case 'plan_detach':
        handlePlanDetach(msg.workflowId).catch((err) => {
          console.error('[arco] plan_detach handler failed:', err);
        });
        break;
      case 'set_preview_port':
        handleSetPreviewPort(msg.workflowId, msg.port, msg.framework, msg.manual !== false).catch((err) => {
          console.error('[arco] set_preview_port handler failed:', err);
        });
        break;
      case 'clear_preview_port':
        handleClearPreviewPort(msg.workflowId).catch((err) => {
          console.error('[arco] clear_preview_port handler failed:', err);
        });
        break;
      case 'enter_plan_mode_request': {
        const wf = workflows.get(msg.workflowId);
        if (!wf) break;
        wf.pendingPlanModeEntry = true;
        console.log(`[arco] [${msg.workflowId.slice(0, 8)}] plan-mode armed by operator`);
        break;
      }
      case 'voice_tool_result': {
        const wf = workflows.get(msg.workflowId);
        if (wf && wf.observers.has(ws)) resolveVoiceTool(msg);
        break;
      }
      case 'operator_question_reply': {
        void handleOperatorQuestionReply(ws, session, msg).catch(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'operator_question_reply_result', workflowId: msg.workflowId, requestId: msg.requestId, ok: false, error: 'The answer could not be delivered.' }));
        });
        break;
      }
      case 'ask_user_question_reply': {
        const ok = routeClaudeNativeQuestionReply(msg.workflowId, msg.questionId, msg.reply);
        if (!ok) {
          // Stale reply (worker disposed, question already cancelled, or
          // taken by another reply). Silently drop — the client surfaces
          // the cancelled-tool-result if relevant via primary_complete.
          console.log(`[arco] [${msg.workflowId.slice(0, 8)}] ask_user_question_reply dropped (no pending question for ${msg.questionId})`);
        }
        break;
      }
      case 'gate_reply': {
        // DEBAG (docs/DEBAG_PLAN.md) — operator approved/rejected a parked
        // review gate. First try the live in-process park; if none (the gate
        // survived a server restart, so its Promise is gone), fall back to the
        // durable sidecar and feed the approved action as the next-turn input.
        const ok = routeClaudeNativeGateReply(msg.workflowId, msg.gateId, msg.decision, msg.finalArgs, msg.remember);
        if (!ok) {
          resolveOrphanedGate(ws, session, msg.workflowId, msg.gateId, msg.decision, msg.finalArgs)
            .then((handled) => {
              if (!handled) {
                console.log(`[arco] [${msg.workflowId.slice(0, 8)}] gate_reply dropped (no pending gate for ${msg.gateId})`);
              }
            })
            .catch((err) => console.error(`[arco] [${msg.workflowId.slice(0, 8)}] orphaned gate_reply failed:`, err));
        }
        break;
      }
      case 'gate_revoke': {
        // DEBAG (docs/DEBAG_PLAN.md §5) — operator revoked a standing approval.
        handleGateRevoke(msg.workflowId, msg.signature).catch((err) =>
          console.error(`[arco] [${msg.workflowId.slice(0, 8)}] gate_revoke failed:`, err));
        break;
      }
      case 'create_label_request':
        handleCreateLabelRequest(ws, msg).catch((err) => {
          console.error('[arco] create_label_request handler failed:', err);
        });
        break;
      case 'revert_to_checkpoint':
        handleRevertToCheckpoint(ws, msg).catch((err) => {
          console.error('[arco] revert_to_checkpoint handler failed:', err);
        });
        break;
      case 'revert_to_point_request':
        handleRevertToPointRequest(ws, msg).catch((err) => {
          console.error('[arco] revert_to_point_request handler failed:', err);
        });
        break;
      case 'live_changes_subscribe':
        handleLiveChangesSubscribe(ws, msg);
        break;
      case 'live_changes_unsubscribe':
        handleLiveChangesUnsubscribe(ws, msg);
        break;
      case 'terminal_open':
        handleTerminalOpen(ws, msg.workflowId, msg.cwd);
        break;
      case 'terminal_kill':
        handleTerminalKill(msg.workflowId, msg.sessionId);
        break;
      case 'terminal_command':
        handleTerminalCommand(msg.workflowId, msg.sessionId, msg.command);
        break;
      case 'terminal_list':
        handleTerminalList(ws, msg.workflowId);
        break;
      case 'task_ledger_create':
        handleTaskLedgerCreate(ws, msg).catch((err) => {
          console.error('[arco] task_ledger_create handler failed:', err);
        });
        break;
      case 'task_ledger_update':
        handleTaskLedgerUpdate(ws, msg).catch((err) => {
          console.error('[arco] task_ledger_update handler failed:', err);
        });
        break;
      case 'task_ledger_delete':
        handleTaskLedgerDelete(ws, msg).catch((err) => {
          console.error('[arco] task_ledger_delete handler failed:', err);
        });
        break;
      case 'task_ledger_list':
        handleTaskLedgerList(ws, msg).catch((err) => {
          console.error('[arco] task_ledger_list handler failed:', err);
        });
        break;
      case 'task_run_recover':
        handleTaskRunRecover(ws, msg).catch((err) => {
          console.error('[arco] task_run_recover handler failed:', err);
        });
        break;
      case 'task_worktree_create':
        handleTaskWorktreeCreate(ws, msg).catch((err) => {
          console.error('[arco] task_worktree_create handler failed:', err);
        });
        break;
      case 'task_worktree_remove':
        handleTaskWorktreeRemove(ws, msg).catch((err) => {
          console.error('[arco] task_worktree_remove handler failed:', err);
        });
        break;
      case 'genesis_seed_update':
        handleGenesisSeedUpdate(ws, msg).catch((err) => {
          console.error('[arco] genesis_seed_update handler failed:', err);
        });
        break;
      case 'genesis_scaffold':
        handleGenesisScaffold(ws, msg).catch((err) => {
          console.error('[arco] genesis_scaffold handler failed:', err);
        });
        break;
      case 'genesis_creative_arm':
        handleGenesisCreativeArm(ws, msg).catch((err) => {
          console.error('[arco] genesis_creative_arm handler failed:', err);
        });
        break;
      case 'genesis_assist_request':
        handleGenesisAssistRequest(ws, msg).catch((err) => {
          console.error('[arco] genesis_assist_request handler failed:', err);
        });
        break;
      case 'preview_capture_request':
        handlePreviewCaptureRequest(ws, msg).catch((err) => {
          console.error('[arco] preview_capture_request handler failed:', err);
        });
        break;
      case 'mcp_registry_list':
        handleMcpRegistryList(ws, msg).catch((err) => {
          console.error('[arco] mcp_registry_list handler failed:', err);
        });
        break;
      case 'mcp_registry_create':
        handleMcpRegistryCreate(ws, msg).catch((err) => {
          console.error('[arco] mcp_registry_create handler failed:', err);
        });
        break;
      case 'mcp_registry_update':
        handleMcpRegistryUpdate(ws, msg).catch((err) => {
          console.error('[arco] mcp_registry_update handler failed:', err);
        });
        break;
      case 'mcp_registry_delete':
        handleMcpRegistryDelete(ws, msg).catch((err) => {
          console.error('[arco] mcp_registry_delete handler failed:', err);
        });
        break;
      case 'mcp_workflow_allow':
        handleMcpWorkflowAllow(ws, msg).catch((err) => {
          console.error('[arco] mcp_workflow_allow handler failed:', err);
        });
        break;
      case 'mcp_probe':
        handleMcpProbe(ws, msg).catch((err) => {
          console.error('[arco] mcp_probe handler failed:', err);
        });
        break;
      case 'cluster_subscribe':
        handleClusterSubscribe(ws, session, msg.clusterId).catch((err) => {
          console.error('[arco] cluster_subscribe handler failed:', err);
        });
        break;
      case 'cluster_member_rehydrate':
        // Client renders a roster member it has no local job for (a never-run
        // member after a restart). Materialize its job so the pane leaves
        // "AWAITING REHYDRATE…". See handleClusterMemberRehydrate.
        handleClusterMemberRehydrate(ws, session, msg.clusterId, msg.workflowId).catch((err) => {
          console.error('[arco] cluster_member_rehydrate handler failed:', err);
        });
        break;
      case 'cluster_unsubscribe':
        session.clusterIds.delete(msg.clusterId);
        // 2026-05-11 bug fix — symmetric to handleClusterSubscribe. Drop
        // the per-member observer adds that came from this cluster sub.
        detachClusterObservers(ws, session, msg.clusterId);
        break;
      case 'cluster_create':
        handleClusterCreate(ws, session, msg.cwd, msg.memberWorkflowIds).catch((err) => {
          console.error('[arco] cluster_create handler failed:', err);
        });
        break;
      case 'cluster_delete':
        handleClusterDelete(msg.clusterId).catch((err) => {
          console.error('[arco] cluster_delete handler failed:', err);
        });
        break;
      case 'cluster_broadcast':
        handleClusterBroadcast(ws, session, msg).catch((err) => {
          console.error('[arco] cluster_broadcast handler failed:', err);
        });
        break;
      case 'cluster_dispatch_once':
        handleClusterDispatchOnce(ws, msg).catch((err) => {
          console.error('[arco] cluster_dispatch_once handler failed:', err);
        });
        break;
      case 'cluster_dispatch_toggle':
        handleClusterDispatchToggle(ws, msg).catch((err) => {
          console.error('[arco] cluster_dispatch_toggle handler failed:', err);
        });
        break;
      case 'cluster_dispatch_settings_update':
        handleClusterDispatchSettingsUpdate(ws, msg).catch((err) => {
          console.error('[arco] cluster_dispatch_settings_update handler failed:', err);
        });
        break;
      case 'cluster_task_board_attach_set':
        handleClusterTaskBoardAttachSet(ws, msg.clusterId, msg.attached).catch((err) => {
          console.error('[arco] cluster_task_board_attach_set handler failed:', err);
        });
        break;
      case 'cluster_task_board_mode_set':
        handleClusterTaskBoardModeSet(ws, msg.clusterId, msg.mode).catch((err) => {
          console.error('[arco] cluster_task_board_mode_set handler failed:', err);
        });
        break;
      case 'cluster_swarm_create':
        handleClusterSwarmCreate(ws, msg).catch((err) => {
          console.error('[arco] cluster_swarm_create handler failed:', err);
        });
        break;
      case 'cluster_orchestration_assist_request':
        handleClusterOrchestrationAssistRequest(ws, msg).catch((err) => {
          console.error('[arco] cluster_orchestration_assist_request handler failed:', err);
        });
        break;
      case 'cluster_orchestration_proposal_list':
        handleClusterOrchestrationProposalList(ws, msg).catch((err) => {
          console.error('[arco] cluster_orchestration_proposal_list handler failed:', err);
        });
        break;
      case 'cluster_orchestration_proposal_reject':
        handleClusterOrchestrationProposalReject(ws, msg).catch((err) => {
          console.error('[arco] cluster_orchestration_proposal_reject handler failed:', err);
        });
        break;
      case 'cluster_orchestration_proposal_apply':
        handleClusterOrchestrationProposalApply(ws, msg).catch((err) => {
          console.error('[arco] cluster_orchestration_proposal_apply handler failed:', err);
        });
        break;
      case 'cluster_orchestration_proposal_accept':
        handleClusterOrchestrationProposalApply(ws, msg).catch((err) => {
          console.error('[arco] cluster_orchestration_proposal_accept handler failed:', err);
        });
        break;
      case 'operator_peer_send':
        handleOperatorPeerSend(ws, msg).catch((err) => {
          console.error('[arco] operator_peer_send handler failed:', err);
        });
        break;
      case 'cluster_rename':
        handleClusterRename(ws, msg.clusterId, msg.name).catch((err) => {
          console.error('[arco] cluster_rename handler failed:', err);
        });
        break;
      case 'cluster_member_remove':
        handleClusterMemberRemove(msg.clusterId, msg.workflowId).catch((err) => {
          console.error('[arco] cluster_member_remove handler failed:', err);
        });
        break;
      case 'cluster_member_add':
        handleClusterMemberAdd(ws, msg.clusterId, msg.workflowId).catch((err) => {
          console.error('[arco] cluster_member_add handler failed:', err);
        });
        break;
      case 'cluster_create_with_fresh_workers':
        handleClusterCreateWithFreshWorkers(ws, session, msg).catch((err) => {
          console.error('[arco] cluster_create_with_fresh_workers handler failed:', err);
        });
        break;
      case 'cluster_create_from_scratch':
        handleClusterCreateFromScratch(ws, session, msg).catch((err) => {
          console.error('[arco] cluster_create_from_scratch handler failed:', err);
        });
        break;
      case 'cluster_add_fresh_workers':
        handleClusterAddFreshWorkers(ws, session, msg).catch((err) => {
          console.error('[arco] cluster_add_fresh_workers handler failed:', err);
        });
        break;
      case 'cluster_member_replace':
        handleClusterMemberReplace(ws, session, msg).catch((err) => {
          console.error('[arco] cluster_member_replace handler failed:', err);
        });
        break;
      case 'cluster_plan_set':
        handleClusterPlanSet(ws, msg.clusterId, msg.body).catch((err) => {
          console.error('[arco] cluster_plan_set handler failed:', err);
        });
        break;
      case 'cluster_plan_attach':
        handleClusterPlanAttach(ws, msg.clusterId, msg.planId).catch((err) => {
          console.error('[arco] cluster_plan_attach handler failed:', err);
        });
        break;
      case 'cluster_plan_clear':
        handleClusterPlanClear(ws, msg.clusterId).catch((err) => {
          console.error('[arco] cluster_plan_clear handler failed:', err);
        });
        break;
      case 'cluster_member_role_set':
        handleClusterMemberRoleSet(ws, msg.clusterId, msg.workflowId, msg.role).catch((err) => {
          console.error('[arco] cluster_member_role_set handler failed:', err);
        });
        break;
      case 'cluster_member_tier_set':
        handleClusterMemberTierSet(ws, msg.clusterId, msg.workflowId, msg.tier).catch((err) => {
          console.error('[arco] cluster_member_tier_set handler failed:', err);
        });
        break;
      case 'cluster_member_focus_set':
        handleClusterMemberFocusSet(ws, msg.clusterId, msg.workflowId, msg.focus).catch((err) => {
          console.error('[arco] cluster_member_focus_set handler failed:', err);
        });
        break;
      case 'cluster_idle_nudger_toggle':
        handleClusterIdleNudgerToggle(ws, msg.clusterId, msg.enabled).catch((err) => {
          console.error('[arco] cluster_idle_nudger_toggle handler failed:', err);
        });
        break;
      case 'cluster_efficiency_set':
        handleClusterEfficiencySet(ws, msg.clusterId, msg.level, msg.addendum).catch((err) => {
          console.error('[arco] cluster_efficiency_set handler failed:', err);
        });
        break;
      case 'cluster_remote_set':
        handleClusterRemoteSet(ws, msg.clusterId, msg.enabled).catch((err) => {
          console.error('[arco] cluster_remote_set handler failed:', err);
        });
        break;
      case 'cluster_gates_set':
        handleClusterGatesSet(ws, msg.clusterId, msg.enabled).catch((err) => {
          console.error('[arco] cluster_gates_set handler failed:', err);
        });
        break;
      case 'cluster_member_reorder':
        handleClusterMemberReorder(ws, msg.clusterId, msg.memberIds).catch((err) => {
          console.error('[arco] cluster_member_reorder handler failed:', err);
        });
        break;
      case 'cluster_progress_set':
        handleClusterProgressSet(ws, msg.clusterId, msg.mode).catch((err) => {
          console.error('[arco] cluster_progress_set handler failed:', err);
        });
        break;
      case 'cluster_auto_turn_toggle':
        handleClusterAutoTurnToggle(ws, msg.clusterId, msg.enabled).catch((err) => {
          console.error('[arco] cluster_auto_turn_toggle handler failed:', err);
        });
        break;
      case 'cluster_snapshot_save':
        handleClusterSnapshotSave(ws, msg).catch((err) => {
          console.error('[arco] cluster_snapshot_save handler failed:', err);
        });
        break;
      case 'cluster_snapshot_list':
        handleClusterSnapshotList(ws).catch((err) => {
          console.error('[arco] cluster_snapshot_list handler failed:', err);
        });
        break;
      case 'cluster_snapshot_restore':
        handleClusterSnapshotRestore(ws, session, msg).catch((err) => {
          console.error('[arco] cluster_snapshot_restore handler failed:', err);
        });
        break;
      case 'cluster_snapshot_delete':
        handleClusterSnapshotDelete(ws, msg).catch((err) => {
          console.error('[arco] cluster_snapshot_delete handler failed:', err);
        });
        break;
      case '__debug_cluster_auto_turn_inject':
        // Phase 5b — dev/smoke-only test hook. Gated on ARCO_TEST=1 so
        // production never honours it. Directly invokes the detector with
        // operator-specified chainDepth so the depth cap + rate cap can be
        // exercised without spinning real LLM turns.
        if (process.env.ARCO_TEST === '1') {
          try {
            clusterAutoTurn.onPeerMessageSent({
              clusterId: msg.clusterId,
              senderWfid: msg.senderWfid,
              recipientWfid: msg.recipientWfid,
              incomingChainDepth: msg.chainDepth,
            });
          } catch (err) {
            console.error('[arco] __debug_cluster_auto_turn_inject failed:', err);
          }
        } else {
          console.warn('[arco] __debug_cluster_auto_turn_inject received but ARCO_TEST!=1; ignoring');
        }
        break;
      case 'rename_workflow':
        (scopedIncognito ? withoutOperationalLogging : <T>(fn: () => T) => fn())(() =>
          handleRenameWorkflow(ws, msg.workflowId, msg.name).catch((err) => {
            console.error('[arco] rename_workflow handler failed:', err);
          }),
        );
        break;
      case 'attach_codebase_memory':
        handleAttachCodebaseMemory(ws, msg.workflowId, msg.indexPath).catch((err) => {
          console.error('[arco] attach_codebase_memory handler failed:', err);
        });
        break;
      case 'detach_codebase_memory':
        handleDetachCodebaseMemory(ws, msg.workflowId).catch((err) => {
          console.error('[arco] detach_codebase_memory handler failed:', err);
        });
        break;
      case '__debug_native_plan_set':
        // Smoke-only hook: directly invokes the Claude Native EnterPlanMode
        // broadcast logic without spinning a real Anthropic turn. Gated on
        // ARCO_TEST so production never honours it.
        if (process.env.ARCO_TEST === '1') {
          handleNativeEnterPlanModeSet(msg.workflowId, msg.plan).catch((err) => {
            console.error('[arco] __debug_native_plan_set handler failed:', err);
          });
        } else {
          console.warn('[arco] __debug_native_plan_set received but ARCO_TEST!=1; ignoring');
        }
        break;
      case '__debug_native_auto_compact_probe':
        // NATIVE_COMPACTION_PLAN Phase 2 — smoke-only hook. Seeds the cached
        // Native worker with a probe history (canned summary, no API spend),
        // sets the workflow's lastContextPercent + efficiencyAutoCompact mode,
        // then runs the REAL maybeAutoCompactNative trigger at a synthetic turn
        // boundary so the smoke can assert the native_compacted emission +
        // keep-tail + bounded-once behavior. Gated on ARCO_TEST.
        if (process.env.ARCO_TEST === '1') {
          (async () => {
            const wf = workflows.get(msg.workflowId);
            if (!wf) return;
            const cwd = workflowCwds.get(msg.workflowId) ?? wf.config.workingDirectory ?? process.cwd();
            wf.config.efficiencyAutoCompact = msg.mode;
            wf.config.claudeTransport = 'native';
            wf.lastContextPercent = msg.contextPercent;
            wf.busy = false;
            const seeded = debugSeedNativeCompactProbe(
              msg.workflowId,
              {
                model: wf.primary.model,
                effort: wf.primary.effort,
                provider: 'claude',
                cwd,
                workflowId: msg.workflowId,
                claudeTransport: 'native',
                efficiencyAutoCompact: msg.mode,
              } as never,
              msg.messages,
            );
            if (!seeded) return;
            await maybeAutoCompactNative(msg.workflowId, wf, cwd);
          })().catch((err) => {
            console.error('[arco] __debug_native_auto_compact_probe handler failed:', err);
          });
        } else {
          console.warn('[arco] __debug_native_auto_compact_probe received but ARCO_TEST!=1; ignoring');
        }
        break;
    }
  });

  ws.on('close', () => {
    console.log(`[arco] Client disconnected: ${sessionId.slice(0, 8)}`);
    sessions.delete(ws);
    releaseLiveChangesForSocket(ws);
    // Release the observer slot on every workflow this ws owned — the
    // workflow itself stays in the global registry. Subsequent rehydrate
    // from the reconnected ws will reclaim the observer slot. Critical so
    // in-flight turns + interjection queues aren't orphaned on reconnect.
    for (const wfid of session.workflowIds) {
      const wf = workflows.get(wfid);
      if (wf) {
        wf.observers.delete(ws);
        if (wf.config.incognito && wf.observers.size === 0 && !wf.incognitoCleanupTimer) {
          // Incognito jobs are deliberately absent from browser localStorage.
          // Give a transient socket reconnect ten seconds to reclaim the live
          // in-memory tab; a refresh/close sends no rehydrate entry, so the
          // timer tears down workers and transcript memory shortly after.
          wf.incognitoCleanupTimer = setTimeout(() => {
            const current = workflows.get(wfid);
            if (current?.config.incognito && current.observers.size === 0) {
              handleRemoveWorkflow(wfid);
            }
          }, 10_000);
        }
      }
    }
    // 2026-05-11 bug fix — cluster-subscribe-installed observer entries
    // also need releasing. detachClusterObservers preserves entries from
    // other sources, but at WS close every entry from this WS is going
    // away anyway, so the explicit-observer guards are no-ops and we just
    // drop the cluster-side adds for completeness.
    for (const [clusterId, wfids] of session.clusterObserved.entries()) {
      for (const wfid of wfids) {
        const wf = workflows.get(wfid);
        if (wf) wf.observers.delete(ws);
      }
      void clusterId;
    }
    session.clusterObserved.clear();
    // Cluster subscriptions live on the Session object itself; clearing
    // the Session removed them, but be explicit for symmetry.
    session.clusterIds.clear();
  });
});

// WorkflowConfig's `orchestrator*` fields are transitional in Lite — they
// describe the tab's primary agent. The protocol rename to `primary` is
// bundled with Phase 8 polish; until then, derive the Lite shape here.

// Operator-triggered force recalibration. Skips zone gating but keeps the
// same busy guard + persistence path as the automatic trigger. A no-op for
// non-Claude providers, missing session id, or during an in-flight turn
// (calibration spawns its own `claude --print /context`; letting two
// concurrent claude processes hit the same session JSONL was the exact
// corruption the concurrent-native-session detector exists to prevent).
async function handleRecalibrateRequest(ws: WebSocket, workflowId: string): Promise<void> {
  const wf = workflows.get(workflowId);
  if (!wf) return;
  const cwd = wf.config.workingDirectory;
  if (!cwd) return;
  if (wf.primary.provider !== 'claude') {
    send(ws, { type: 'system_notice', workflowId, content: '[CALIBRATE] Only available for Claude sessions.' });
    return;
  }
  const sessionId = wf.primarySessionId;
  if (!sessionId) {
    send(ws, { type: 'system_notice', workflowId, content: '[CALIBRATE] No live session yet — send a turn first.' });
    return;
  }
  if (wf.busy) {
    send(ws, { type: 'system_notice', workflowId, content: '[CALIBRATE] Primary turn in flight — wait for it to finish.' });
    return;
  }

  const est = await estimateContextFill(cwd, sessionId, wf.primary.model, wf.calibration).catch(() => null);
  if (!est) {
    send(ws, { type: 'system_notice', workflowId, content: '[CALIBRATE] Could not read session state — aborting.' });
    return;
  }

  // The estimator now reads ground truth directly from the session JSONL's
  // assistant `usage` blocks. When that path returns a value there's nothing
  // to calibrate — running /context would just spawn an extra `claude --print`
  // and overwrite the byte-count ratio that we no longer consult. Re-broadcast
  // the existing estimate so the UI's "last calibrated" timestamp refreshes.
  if (est.method === 'ground-truth') {
    broadcastTransient(workflowId, {
      type: 'context_usage',
      workflowId,
      ...est,
      claudeSessionId: sessionId,
    });
    wf.lastContextPercent = est.percentOfWindow;
    send(ws, {
      type: 'system_notice',
      workflowId,
      content: `[CALIBRATE] Already ground-truth. ${est.estimatedTokens.toLocaleString()} / ${est.windowSize.toLocaleString()} tokens (${est.percentOfWindow}%) — read from session JSONL.`,
    });
    return;
  }

  console.log(`[arco] [${workflowId.slice(0, 8)}] manual recalibrate at ${est.percentOfWindow}%`);
  send(ws, { type: 'system_notice', workflowId, content: `[CALIBRATE] Running ground-truth /context on ${sessionId.slice(0, 8)}…` });

  let result: import('./contextCalibrator.js').CalibrationResult | null = null;
  try {
    result = await runCalibration(sessionId, wf.primary.model, cwd, est.jsonlBytes, (cancelFn) => {
      wf.cancelCalibration = cancelFn;
    });
  } catch (err) {
    console.error(`[arco] [${workflowId.slice(0, 8)}] manual calibration error:`, err);
  }
  wf.cancelCalibration = undefined;

  if (!result) {
    send(ws, { type: 'system_notice', workflowId, content: '[CALIBRATE] Failed — see server console.' });
    return;
  }

  const cal: CalibrationState = wf.calibration ?? {
    ratio: BYTES_PER_TOKEN_DEFAULT,
    overhead: OVERHEAD_TOKENS_DEFAULT,
    zonesCalibrated: new Set(),
  };
  cal.ratio = result.ratio;
  cal.overhead = result.overhead;
  cal.lastGroundTruth = Date.now();
  wf.calibration = cal;

  writeCalibrationToMeta(cwd, workflowId, cal.ratio, cal.overhead, cal.lastGroundTruth).catch((err) => {
    console.error(`[arco] [${workflowId.slice(0, 8)}] calibration meta write failed:`, err);
  });

  const calEst = await estimateContextFill(cwd, sessionId, wf.primary.model, cal).catch(() => null);
  if (calEst) {
    broadcastTransient(workflowId, {
      type: 'context_usage',
      workflowId,
      ...calEst,
      claudeSessionId: sessionId,
    });
    wf.lastContextPercent = calEst.percentOfWindow;
    send(ws, {
      type: 'system_notice',
      workflowId,
      content: `[CALIBRATE] Done. ${calEst.estimatedTokens.toLocaleString()} / ${calEst.windowSize.toLocaleString()} tokens (${calEst.percentOfWindow}%) — ratio ${result.ratio.toFixed(2)} B/T.`,
    });
  }
}

async function handleFreshAntigravityCascadeRequest(ws: WebSocket, workflowId: string): Promise<void> {
  const wf = workflows.get(workflowId);
  if (!wf) return;
  const cwd = wf.config.workingDirectory;
  if (!cwd) return;
  if (wf.primary.provider !== 'antigravity') {
    send(ws, { type: 'system_notice', workflowId, content: '[ANTIGRAVITY] Fresh cascade reset is only available for Antigravity primaries.' });
    return;
  }
  if (wf.busy) {
    send(ws, { type: 'system_notice', workflowId, content: '[ANTIGRAVITY] Primary turn in flight — wait for it to finish before resetting the cascade.' });
    return;
  }

  const oldCascadeId = wf.primarySessionId;
  if (oldCascadeId) {
    const transcript = await replayWorkflowEvents(cwd, workflowId, 0).catch(() => []);
    const turnCount = transcript.filter((ev) => ev.type === 'user_message_echo').length;
    await appendHistoryEntry(cwd, workflowId, {
      sessionId: oldCascadeId,
      provider: 'antigravity',
      startedAt: transcript[0] && 'timestamp' in transcript[0] && typeof transcript[0].timestamp === 'number'
        ? transcript[0].timestamp
        : Date.now(),
      endedAt: Date.now(),
      turnCount,
      archivedReason: 'fresh-cascade-reset',
    }).catch((err) => {
      console.error(`[arco] [${workflowId.slice(0, 8)}] antigravity cascade-reset history append failed:`, err);
    });
  }

  wf.primarySessionId = undefined;
  wf.autoHandoff.warnFired = false;
  wf.autoHandoff.autoFired = false;
  wf.calibration = undefined;
  wf.lastContextPercent = 0;

  try {
    await clearProviderCliSessions(cwd, workflowId, 'antigravity');
  } catch (err) {
    console.error(`[arco] [${workflowId.slice(0, 8)}] antigravity cascade-reset meta write failed:`, err);
  }

  send(ws, {
    type: 'system_notice',
    workflowId,
    content: oldCascadeId
      ? '[ANTIGRAVITY] Stored cascade id cleared. The next Antigravity turn will start a fresh cascade; this does not compact Antigravity internal context/cache.'
      : '[ANTIGRAVITY] No stored cascade id. The next Antigravity turn will start a fresh cascade.',
  });
  broadcastSessionMetadata(workflowId, wf);
}

// Build the plan-header prefix to prepend to the next primary turn's prompt.
// Returns '' when no plan is attached. When a plan is attached, includes a
// one-line "active plan" header. When the plan body has been edited since
// the last injection (planLastSeenUpdatedAt < plan.updatedAt), also includes
// the full plan body once so the agent picks up the operator's edits.
// Side-effect: bumps meta.planLastSeenUpdatedAt to the plan's current
// updatedAt so the full-body refresh fires exactly once per edit.

// Plans-directory watcher. One FSWatcher per cwd; reference-counted by the
// number of in-memory workflows currently attached to a plan in that cwd.
// We watch the directory rather than individual files so creates/deletes by
// the agent are picked up too. Reconcile is debounced 200ms to coalesce the
// two writes from atomicWrite (.tmp → rename) and to ride out partial-edit
// flickers from non-atomic writers (the agent's Edit tool).
//
// The skip-flag dance keeps the operator's REST-PATCH path from
// double-broadcasting plan_attached: PATCH already broadcasts on its own,
// then the watcher fires on the .md write — we mark the planId as
// "skip-once" before writing and the watcher consumes the flag.


// Plan attach/detach. Plans live at <cwd>/.arco/plans/<id>.md (see
// planStore.ts) and are explicitly attached — never auto-bound by cwd. The
// active plan's title gets injected as a one-line system note into every
// primary turn (see runPrimaryTurn call site). plan_attached/detached are
// workflow-scoped broadcasts (persisted to events.jsonl) so reconnects
// replay them and the Plan tab stays in sync across windows.
async function handlePlanAttach(workflowId: string, planId: string): Promise<void> {
  const wf = workflows.get(workflowId);
  if (!wf) return;
  const cwd = wf.config.workingDirectory;
  if (!cwd) return;
  if (!isValidPlanId(planId)) return;
  const summary = await readPlanSummary(cwd, planId).catch(() => null);
  if (!summary) {
    broadcastTransient(workflowId, {
      type: 'error',
      message: `Plan ${planId.slice(0, 8)} not found in this workspace.`,
    });
    return;
  }
  // Switching plans: close the previous plan's open span (and drop its
  // watcher reference) before opening the new one.
  const previousPlanId = wf.planId;
  if (previousPlanId && previousPlanId !== planId) {
    await recordDetachment(cwd, previousPlanId, workflowId).catch(() => { /* best-effort */ });
    releasePlansWatcher(cwd);
  }
  wf.planId = planId;
  // Persist into meta.json so the binding survives server restarts. Also
  // reset planLastSeenUpdatedAt so the next turn injects the full plan body
  // (the agent hasn't seen this plan yet under this workflow).
  try {
    await updateMeta(cwd, workflowId, (meta) => {
      meta.planId = planId;
      meta.planLastSeenUpdatedAt = 0;
    });
  } catch (err) {
    console.error(`[arco] [${workflowId.slice(0, 8)}] plan attach meta write failed:`, err);
  }
  // Record the attachment span (idempotent — a no-op when an open span for
  // this pair already exists, e.g. on rehydrate replay).
  if (!previousPlanId || previousPlanId !== planId) {
    acquirePlansWatcher(cwd);
  }
  await recordAttachment(cwd, planId, workflowId, wf.config.name).catch(() => { /* best-effort */ });
  broadcastWorkflow(workflowId, {
    type: 'plan_attached',
    workflowId,
    planId: summary.id,
    title: summary.title,
    updatedAt: summary.updatedAt,
  });
}

// Bulk detach used by the mark-complete and delete REST paths. Mirrors
// handlePlanDetach but loops over every workflow in the cwd that's
// attached to this plan. Skips wf.planId !== planId so it's idempotent
// even when the watcher's deletion-reconcile races us.
async function detachAllForPlan(cwd: string, planId: string): Promise<number> {
  let count = 0;
  for (const [wfid, wf] of workflows) {
    if (wf.planId !== planId) continue;
    if (workflowCwds.get(wfid) !== cwd) continue;
    wf.planId = undefined;
    try {
      await updateMeta(cwd, wfid, (meta) => {
        if (!meta.planId) return false;
        delete meta.planId;
        delete meta.planLastSeenUpdatedAt;
      });
    } catch (err) {
      console.error(`[arco] [${wfid.slice(0, 8)}] meta clear failed during detach-all:`, err);
    }
    await recordDetachment(cwd, planId, wfid).catch(() => { /* best-effort */ });
    broadcastWorkflow(wfid, { type: 'plan_detached', workflowId: wfid });
    releasePlansWatcher(cwd);
    count += 1;
  }
  return count;
}

async function handlePlanDetach(workflowId: string): Promise<void> {
  const wf = workflows.get(workflowId);
  if (!wf) return;
  const cwd = wf.config.workingDirectory;
  if (!cwd) return;
  const previousPlanId = wf.planId;
  wf.planId = undefined;
  try {
    await updateMeta(cwd, workflowId, (meta) => {
      delete meta.planId;
      delete meta.planLastSeenUpdatedAt;
    });
  } catch (err) {
    console.error(`[arco] [${workflowId.slice(0, 8)}] plan detach meta write failed:`, err);
  }
  if (previousPlanId) {
    await recordDetachment(cwd, previousPlanId, workflowId).catch(() => { /* best-effort */ });
    releasePlansWatcher(cwd);
  }
  broadcastWorkflow(workflowId, { type: 'plan_detached', workflowId });
}

// Persist + fan out to all observers of a workflow. For callers that don't
// have a specific WebSocket in hand (background tasks, REST handlers,
// snapshot epilogues). Mirrors the workflow-scoped path inside send() so the
// events.jsonl write + observer broadcast still happen when no socket
// originated the message.

// CLUSTER_MODE_PLAN.md Phase 4 + local-provider followup. Claude and Codex
// wire peer tools through Native/MCP. Ollama and llama.cpp use Arco's
// server-side local tool runtime, so they can now participate without stdio
// MCP. Gemini / Antigravity stay rejected because Arco cannot inject peer
// tools into those providers today. Returns null on success, an error code
// string on rejection.
async function assertAllMembersClaudeOrCodex(memberIds: string[]): Promise<string | null> {
  for (const wfid of memberIds) {
    const wf = workflows.get(wfid);
    if (!wf) return `member_not_found:${wfid}`;
    const provider = wf.config.primaryProvider ?? 'claude';
    if (!isClusterMemberProvider(provider)) {
      return `member_not_supported:${wfid}`;
    }
    if (provider === 'claude') {
      const tabTransport = wf.config.claudeTransport;
      const cascade = await readSettings(wf.config.workingDirectory).catch(() => null);
      const effective: 'native' | 'cli' =
        tabTransport === 'native' || tabTransport === 'cli'
          ? tabTransport
          : cascade?.claude?.transport === 'native' ? 'native' : 'cli';
      void effective;
    }
    // Codex: both `exec` and `appserver` transports are accepted; the
    // dispatcher resolves the cascade per turn and the providers wire MCP
    // overrides themselves based on `WorkerConfig.clusterId`.
  }
  return null;
}

// ── Integrated operator terminal (Workbench Expansion §K1) ──
//
// The seq'd control plane for the operator PTY. spawn/kill/command-line land
// in events.jsonl via broadcastWorkflow (lifecycle + command-line visibility,
// four-question test); the raw byte stream rides the separate `/terminal` WS
// channel and is deliberately NOT persisted. HARD FENCE: operator-only — the
// PTY is never an agent tool.
function handleTerminalOpen(ws: WebSocket, workflowId: string, cwd?: string): void {
  const wf = workflows.get(workflowId);
  const root = wf?.config.workingDirectory;
  if (!wf || !root) {
    send(ws, { type: 'error', message: 'Terminal: no working directory bound to this workflow.' });
    return;
  }
  let session;
  try {
    // resolveWithinCwd inside spawn refuses a cwd that escapes the root.
    session = ptyManager.spawn(workflowId, root, cwd);
  } catch (err) {
    send(ws, {
      type: 'error',
      message: `Terminal: ${err instanceof Error ? err.message : 'could not spawn shell'}`,
    });
    return;
  }
  // No bootstrap attach here — the real window attaches over `/terminal`.
  // Shell-exit persistence rides setTerminalExitHook (below), which fires
  // regardless of whether a window is currently attached.
  console.log(`[arco] [${workflowId.slice(0, 8)}] terminal opened ${session.id} (${session.shell} @ ${session.cwd})`);
  broadcastWorkflow(workflowId, {
    type: 'terminal_opened',
    workflowId,
    sessionId: session.id,
    cwd: session.cwd,
    shell: session.shell,
    label: session.label,
    ts: Date.now(),
  });
}

// §K2 — reply with the live session list for a workflow. The ptyManager pool is
// the source of truth (PTYs don't survive a restart, so events.jsonl replay
// would list dead sessions). Used to populate the switcher + repopulate after a
// reconnect. Lifecycle-only; the raw stream rides `/terminal`.
function handleTerminalList(ws: WebSocket, workflowId: string): void {
  send(ws, {
    type: 'terminal_sessions',
    workflowId,
    sessions: ptyManager.infoForWorkflow(workflowId),
  });
}

function handleTerminalKill(workflowId: string, sessionId: string): void {
  const s = ptyManager.get(sessionId);
  if (!s || s.workflowId !== workflowId) return;
  ptyManager.kill(sessionId);
  broadcastWorkflow(workflowId, {
    type: 'terminal_killed', workflowId, sessionId, reason: 'operator-kill', ts: Date.now(),
  });
}

function handleTerminalCommand(workflowId: string, sessionId: string, command: string): void {
  const trimmed = command.trim();
  if (trimmed.length === 0) return;
  broadcastWorkflow(workflowId, {
    type: 'terminal_command_logged', workflowId, sessionId, command: trimmed, ts: Date.now(),
  });
}

// Kill-from-inside-the-window (the `/terminal` channel's `kill` message) still
// needs a lifecycle event in events.jsonl. The channel calls this hook.
setTerminalKillHook((s) => {
  broadcastWorkflow(s.workflowId, {
    type: 'terminal_killed', workflowId: s.workflowId, sessionId: s.id, reason: 'operator-kill', ts: Date.now(),
  });
});

// Shell exited on its own (operator typed `exit`, the process died). Persist a
// lifecycle event so the session's end is in events.jsonl regardless of which
// window (if any) was attached. The store-side clear happens off this event.
setTerminalExitHook((s, code) => {
  if (!s.workflowId) return;
  broadcastWorkflow(s.workflowId, {
    type: 'terminal_killed', workflowId: s.workflowId, sessionId: s.id, reason: 'shell-exit', ts: Date.now(),
  });
  // §J1 — only a non-zero shell exit is high-signal (a crash / failed command
  // chain the operator likely tabbed away from). A clean `exit` stays quiet.
  if (typeof code === 'number' && code !== 0) {
    emitNotice({
      category: 'terminal-exited',
      severity: 'warning',
      title: `Terminal exited (code ${code})`,
      body: `Session ${s.id.slice(0, 8)} ended non-zero.`,
      workflowId: s.workflowId,
    });
  }
});

// ── Signal handling ──

let exiting = false;
function onSignal(signal: string): void {
  if (exiting) return;
  exiting = true;
  // Provider subprocesses are spawned with `detached: true`, so they outlive
  // the server unless we SIGKILL them explicitly here. The usual WorkerManager
  // kill path uses a 5s SIGTERM→SIGKILL fuse — that timer won't fire because
  // we're about to exit. SIGKILL the process groups synchronously instead.
  // H46 — final memory line so each run's log ends with its high-water mark
  // (no-op output unless file logging is on; process.memoryUsage() is cheap).
  if (getLogFilePath() !== null) logMemorySample('shutdown');
  // H42 part B — snapshot what's in flight BEFORE we reap. Busy non-cluster
  // workflows are the turns this stop truncates; key the breakdown by provider.
  const busyByProvider: Record<string, number> = {};
  let inflightTurns = 0;
  for (const wf of workflows.values()) {
    if (!wf.busy || wf.config.kind === 'cluster') continue;
    inflightTurns++;
    const p = wf.config.primaryProvider ?? 'unknown';
    busyByProvider[p] = (busyByProvider[p] ?? 0) + 1;
  }
  const ptySessions = (() => { try { return ptyManager.allSessions().length; } catch { return 0; } })();
  const activityFlush = interruptComputerActivity();
  const watchFlush = interruptComputerWatches();
  const live = readRegisteredProcs();
  console.log(`[arco] Received ${signal}, killing ${live.length} live worker(s) and exiting`);
  const reaped = { killed: 0, reused: 0, gone: 0 };
  for (const p of live) reaped[reapProc(p)]++; // start-time-verified (skips a recycled pid)
  clearRegisteredPids();
  // H42 part B — single forensics line recording what the stop interrupted.
  // Deliberately a server-log line, not per-workflow events (we're inside the
  // ~100 ms flush budget with the WS already closing). Operator greps it after.
  console.log(formatShutdownForensics({
    signal, uptimeSec: process.uptime(), rssBytes: process.memoryUsage().rss,
    reaped, inflightTurns, busyByProvider, ptySessions, flushBudgetMs: 100,
  }));
  // WORKBENCH_EXPANSION §K1/§K2 — reap operator PTY sessions. They're spawned
  // without `detached`, so they'd die with us anyway, but be deterministic and
  // emit a `shutdown` lifecycle event per session for transcript visibility.
  // ptyManager.kill (inside killAll) unregisters each pid from the durable
  // terminal registry, so the next boot sweep is a no-op — we don't SIGKILL a
  // freshly-spawned pid that happens to recycle a number.
  try {
    for (const s of ptyManager.allSessions()) {
      broadcastWorkflow(s.workflowId, {
        type: 'terminal_killed', workflowId: s.workflowId, sessionId: s.id, reason: 'shutdown', ts: Date.now(),
      });
    }
    ptyManager.killAll();
  } catch { /* best-effort */ }
  // §C3 — reap any lazy-spawned LSP servers. Synchronous SIGTERM+SIGKILL of
  // each live language-server child (they're spawned without `detached`, so a
  // clean exit reaps them anyway; this makes graceful shutdown deterministic).
  try { lspManager.shutdown(); } catch { /* best-effort */ }
  try { wss.close(); } catch { /* ignore */ }
  try { httpServer.close(); } catch { /* ignore */ }
  Promise.allSettled([activityFlush, watchFlush, flushAllWorkflowEvents(), llamacppManager.shutdown()])
    .finally(() => setTimeout(() => process.exit(0), 100));
}
process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('SIGINT', () => onSignal('SIGINT'));

// Last-resort safety net. The server makes many outbound `fetch` calls (usage
// meters, catalogs, refresh tokens, hub link). Any one of them rejecting on a
// network blip — e.g. api.anthropic.com resolving to an ENETUNREACH IPv6 — used
// to escape as an unhandled rejection and `process.exit(1)` the whole server,
// which systemd then crash-looped into a permanent start-limit-hit "SERVER
// DOWN". A single failed background call must NOT take the process down: log it
// loudly and keep serving. We deliberately do NOT exit here — the individual
// call sites own graceful degradation; this only stops a missed catch from
// being fatal. (SIGTERM/SIGINT above are the only intentional exit paths.)
process.on('unhandledRejection', (reason) => {
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  console.error(`[arco] unhandledRejection (non-fatal, server stays up): ${detail}`);
});
process.on('uncaughtException', (err) => {
  console.error(`[arco] uncaughtException (non-fatal, server stays up): ${err.stack ?? err.message}`);
});

// Reap any worker subprocesses left alive by a crashed/force-quit previous
// run. The registry is authoritative; anything in it was tracked and not
// cleared, so it's safe to SIGKILL. Runs synchronously before listen() so
// no new turns start while the old ones are still consuming tokens.
function reapOrphanWorkers(): void {
  const stale = readRegisteredProcs();
  if (stale.length === 0) {
    console.log('[arco] Orphan sweep: registry clean, nothing to reap');
    return;
  }
  // H44 — verify each pid's start time before SIGKILL so a recycled pid (now an
  // unrelated process) is left alone; only genuinely-stale workers are reaped.
  let killed = 0, reused = 0, gone = 0;
  for (const p of stale) {
    const outcome = reapProc(p);
    if (outcome === 'killed') killed++;
    else if (outcome === 'reused') reused++;
    else gone++;
  }
  console.log(
    `[arco] Orphan worker sweep (${stale.length} tracked): reaped ${killed}, ` +
    `already gone ${gone}, skipped ${reused} (pid recycled)`,
  );
  clearRegisteredPids();
}

// ── Start ──

reapOrphanWorkers();
// §K2 — reap operator-terminal shells leaked by a crashed/force-quit prior run
// (node-pty children reparent to init on a hard kill). Same durable-registry
// pattern as workers; runs before listen() so no orphan shell survives a boot.
reapOrphanTerminals();

// Phase 7a — wire the Claude Native worker's todos_updated broadcast hook
// onto the workflow-scoped transient bus. The Activity tab consumes
// todos_updated to render the operator-visible todo list.
setClaudeNativeTodosBroadcast((workflowId, todos) => {
  broadcastTransient(workflowId, { type: 'todos_updated', workflowId, todos });
});

// EFFICIENCY_PLAN.md Phase B/D — Native worker emits workflow-scoped events
// for hook rewrites, pre-tool-use guards, and ctx-management actions
// through this broadcaster. Routed through broadcastWorkflow so they land
// in events.jsonl with proper seq/parent threading.
setClaudeNativeWorkflowEventBroadcast((workflowId, msg) => {
  broadcastWorkflow(workflowId, msg);
});
setZaiNativeWorkflowEventBroadcast((workflowId, msg) => {
  broadcastWorkflow(workflowId, msg);
});

// Peer tool `cluster_plan_tick` — the Native worker emits a single
// cluster_plan_changed via this sink whenever a successful toggle lands, so
// every WS subscribed to the cluster (operator's PLAN tab + every peer's
// activity feed) re-renders. No persist hop: broadcastCluster already runs
// the fanout through the same persistAndStampSeq pipeline used by the
// operator-side cluster_plan_set path.
setClaudeNativeClusterEventBroadcast((clusterId, msg) => {
  broadcastCluster(clusterId, msg);
  if (msg.type === 'cluster_plan_changed') {
    void buildClusterStatePayload(clusterId)
      .then((payload) => {
        if (payload) broadcastCluster(clusterId, { type: 'cluster_state', clusterId, state: payload });
      })
      .catch((err) => console.error('[arco] cluster plan state refresh failed:', err));
  }
});

// Phase 7b — Claude Native plan broadcast hook. EnterPlanMode writes the
// plan body to a real plan file under .arco/plans/, attaches it to the
// workflow (so the PLAN tab renders the body via the existing plan-attach
// pipeline), and emits a plan_set event carrying the body inline. ExitPlanMode
// emits plan_exited; the plan stays attached.
//
// Cluster gate: when the workflow is a cluster member the silent
// handlePlanAttach side-effect is replaced with a `plan_candidate_ready`
// broadcast so the operator picks via PlanCandidateBanner (save-to-worker
// vs attach-to-cluster vs discard). `plan_set` still fires either way so
// events.jsonl reflects the EnterPlanMode call.
//
// This function NEVER writes the shared cluster plan itself. The two paths
// that may are the operator's (`cluster_plan_set`) and the guarded peer tool
// (`peerPlanWrite`, which enforces checkbox preservation). Do not re-add a
// direct `setClusterPlanBody()` call here — that is the 683bbb3 regression.
async function handleNativeEnterPlanModeSet(workflowId: string, plan: string): Promise<void> {
  const wf = workflows.get(workflowId);
  const cwd = wf?.config.workingDirectory;
  // Title heuristic shared between the auto-attach and cluster-candidate
  // paths so a SAVE & ATTACH TO WORKER click reproduces what the silent
  // path would have written.
  const firstLine = plan.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const stripped = firstLine.replace(/^#+\s*/, '').trim();
  const title = stripped.slice(0, 80) || 'Native plan';

  const clusterId = clusterStore.getClusterIdForWorkflow(workflowId);
  let planId: string | undefined;
  if (wf && cwd && !clusterId) {
    try {
      const created = await createPlan(cwd, { title, body: plan });
      planId = created.id;
      // Attach so the PLAN tab renders the body. handlePlanAttach handles
      // the meta.json + watcher + plan_attached broadcast.
      await handlePlanAttach(workflowId, created.id);
    } catch (err) {
      console.warn(`[arco] [${workflowId.slice(0, 8)}] EnterPlanMode plan-file create failed:`, err);
    }
  } else if (wf && cwd && clusterId) {
    // Cluster member — surface the choice to the operator. No file written
    // yet; the banner buttons own the persist call (ATTACH TO CLUSTER routes
    // to `cluster_plan_set` → handleClusterPlanSet).
    //
    // 2026-09-01: restored after `683bbb3` (2026-05-19, "Unify cluster plans
    // and restore native web tools") replaced this with a direct
    // `setClusterPlanBody()` call. That write bypassed EVERY guard the
    // deliberate model-driven path enforces — `peerPlanWrite` denies
    // mailbox-only members and rejects a destructive body with
    // `destructive_write_requires_operator` via
    // `validatePlanWritePreservesCheckboxes`, whose doctrine is: a model may
    // author or non-destructively restructure the plan, but "must preserve
    // existing checkbox tasks and their status". EnterPlanMode did a wholesale
    // body replace with none of that, so one member's plan tool could wipe
    // every task and its status for every other member (the cluster plan is
    // folded into all of their system prompts) with no operator step.
    //
    // Evidence it was collateral rather than intent: the same commit updated
    // PlanCandidateBanner.tsx's ATTACH TO CLUSTER semantics, `plan_candidate_ready`
    // survived only in the catch block, and this function's own doc comment
    // still described the gate. See docs/GOTCHAS.md § Plans.
    broadcastWorkflow(workflowId, {
      type: 'plan_candidate_ready',
      workflowId,
      body: plan,
      source: 'native-plan-tool',
      planTitle: title,
    });
  }
  broadcastWorkflow(workflowId, { type: 'plan_set', workflowId, plan, source: 'native-tool', ...(planId ? { planId } : {}) });
}

setClaudeNativePlanBroadcast((workflowId): PlanBroadcast => ({
  set: async (plan: string) => {
    await handleNativeEnterPlanModeSet(workflowId, plan);
  },
  exited: async (summary: string | undefined) => {
    broadcastWorkflow(workflowId, { type: 'plan_exited', workflowId, ...(summary ? { summary } : {}) });
  },
}));

// Phase 7b — Claude Native Task tool handler. Mints a child workflow that
// inherits the parent's primary config, spawns a tab visible to the operator
// (broadcast to the parent's observers), runs one primary turn seeded with
// the prompt, and resolves the parent's awaiting tool result with the child's
// final assistant text. Depth-1 only — the child carries `claudeNativeTaskDisabled`
// so its tool registry drops `Task`.
setClaudeNativeTaskHandler(async ({ parentWorkflowId, description, prompt, model }): Promise<TaskSpawnHandle> => {
  const parent = workflows.get(parentWorkflowId);
  if (!parent) throw new Error(`Task: parent workflow ${parentWorkflowId.slice(0, 8)} not found`);
  const parentCwd = parent.config.workingDirectory;
  if (!parentCwd) throw new Error('Task: parent has no working directory');

  const childWorkflowId = crypto.randomUUID();
  const taskId = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  // Clone parent's WorkflowConfig with a new id + name; inherit transport.
  const childName = description.length > 60 ? description.slice(0, 57) + '…' : description;
  const childConfig: WorkflowConfig = {
    ...parent.config,
    name: `Task: ${childName}`,
  };
  const childPrimary = derivePrimaryConfig(childConfig);
  if (model) childPrimary.model = model as typeof childPrimary.model;
  const childManager = new WorkerManager();

  workflows.set(childWorkflowId, {
    config: childConfig,
    busy: true,
    manager: childManager,
    primary: childPrimary,
    queue: { steering: [], followUp: [] },
    observers: new Set(parent.observers),
    autoHandoff: deriveAutoHandoff(childConfig),
    lastContextPercent: 0,
    previewHistory: [],
  });
  workflowCwds.set(childWorkflowId, parentCwd);
  acquireProjectSettingsWatcher(parentCwd);

  try {
    await initWorkflowStore(parentCwd, childWorkflowId);
    await persistInitialMeta(parentCwd, childWorkflowId, childConfig, childPrimary, { parentWorkflowId });
  } catch (err) {
    workflows.delete(childWorkflowId);
    workflowCwds.delete(childWorkflowId);
    throw new Error(`Task: child init failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Tell parent's observers a new workflow exists, and stamp childWorkflowId
  // onto each observing Session.workflowIds so the close-handler cleanup +
  // rehydrate path see the child as their own. The `parentWorkflowId` field
  // tells the client to mint a JobState (so promote can flip it into the top
  // tab strip without a server round-trip) but suppress the auto-tab + the
  // active-tab switch — depth-1 Task children render scoped to the parent
  // (inline chat card + TASKS sub-tab), not as siblings of the parent.
  for (const obs of parent.observers) {
    const sess = sessions.get(obs);
    if (sess) sess.workflowIds.add(childWorkflowId);
    if (obs.readyState === WebSocket.OPEN) {
      send(obs, { type: 'workflow_created', workflowId: childWorkflowId, config: childConfig, parentWorkflowId });
    }
  }
  // Persist + broadcast the seed prompt as the child's first user message so
  // the operator sees it in the new tab's chat.
  broadcastWorkflow(childWorkflowId, { type: 'user_message_echo', workflowId: childWorkflowId, content: prompt, timestamp: Date.now() });

  // Capture the child's assistant text so finalText resolves with it on
  // primary_complete. We also tee broadcasts to all observers via
  // broadcastWorkflow (the runPrimaryTurn ctx.broadcast already targets the
  // parent's WS via broadcastWorkflow indirectly through the workflow
  // observer set we cloned above).
  let accumulated = '';
  let settled = false;
  let resolveFinal: (text: string) => void;
  let rejectFinal: (err: Error) => void;
  const finalText = new Promise<string>((res, rej) => { resolveFinal = res; rejectFinal = rej; });

  const childTurn = runPrimaryTurn(
    {
      workflowId: childWorkflowId,
      cwd: parentCwd,
      manager: childManager,
      broadcast: (m) => {
        broadcastWorkflow(childWorkflowId, m);
        // Capture text deltas + completion locally so the parent's Task
        // promise can resolve.
        if (m.type === 'primary_text') accumulated += m.text;
        if (m.type === 'primary_complete') {
          settled = true;
          resolveFinal(accumulated);
        }
        if (m.type === 'error' && !settled) {
          settled = true;
          rejectFinal(new Error(m.message ?? 'child errored'));
        }
      },
    },
    {
      primary: childPrimary,
      prompt,
      resumeSessionId: undefined,
      // Task children ALWAYS run Native — the Task tool only exists on Native
      // workers, so by construction the parent is Native here. The old
      // `parent.config.claudeTransport === 'native'` check missed tabs riding
      // the settings cascade (config field unset, global default 'native'):
      // those children fell through to the CLI provider, which exited in
      // ~0.5s with "Not logged in · Please run /login" as the tool result —
      // and the parent silently planned around four dead delegations
      // (GroundTruth incident, 2026-07-01).
      claudeTransport: 'native',
      claudeNativeCompact: parent.config.claudeNativeCompact === true,
      claudeNativeForceInterleavedThinkingBeta: parent.config.claudeNativeForceInterleavedThinkingBeta === true,
      claudeNativeThinkingDisplay: parent.config.claudeNativeThinkingDisplay,
      claudeNativeTaskDisabled: true,
      // H30 — the child turn threads outputStyle the same way the normal turn
      // does (a runPrimaryTurn arg, NOT derivePrimaryConfig, which drops it).
      // Without this the child silently ran 'normal' regardless of the parent's
      // OUTPUT STYLE pick. Inherit the parent's setting.
      outputStyle: parent.config.outputStyle,
      // GOAL_NORTHSTAR_PLAN.md — a Task child works in service of the parent's
      // objective, so it inherits the parent's north-star (like the Review /
      // Handoff / DOCS / GIT seeds do, and unlike outputStyle's forced normal
      // in those seeds). derivePrimaryConfig drops it, so thread it explicitly.
      goal: parent.config.goal,
    },
  );

  // Drop busy on settle so the child tab is interactive afterward.
  childTurn.settled.finally(() => {
    const wf = workflows.get(childWorkflowId);
    if (wf) wf.busy = false;
  }).catch(() => { /* swallow */ });

  return {
    taskId,
    childWorkflowId,
    finalText,
    read: () => ({ output: accumulated, settled }),
    cancel: () => {
      try { childManager.killAll(); } catch { /* gone */ }
      if (!settled) {
        settled = true;
        rejectFinal(new Error('AbortError: parent cancelled'));
      }
    },
  };
});

httpServer.listen(PORT, HOST, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║         A R C O      v0.1.0 (Lite)       ║
  ║         Server online :: ${PORT}             ║
  ║         Phase 2 — primary-worker chat    ║
  ╚══════════════════════════════════════════╝
  `);
  if (!wsAuthEnabled()) {
    console.warn('[arco] ARCO_WS_AUTH=off — /ws and /terminal accept ANY local client (test servers only).');
  }
  ensureCatalog().catch((err) => console.error('[arco] ensureCatalog:', err));
  ensureLlamacppCatalog().catch((err) => console.error('[arco] ensureLlamacppCatalog:', err));
  scheduleGeminiNativeCatalogPrefetch();
  scheduleCursorCatalogPrefetch();
  readSettings().catch((err) => console.error('[arco] initial readSettings failed:', err));
  // CLUSTER_MODE_PLAN.md Phase 5 — configure the idle-nudger detector with
  // the broadcast surfaces + a resolver that snapshots live cluster
  // membership + per-member busy state at each tick. The detector runs on
  // its own polling timer (interval derived from IDLE_FLOOR_SECONDS) and
  // gates per-cluster via clusterStore.isIdleNudgerEnabled. Default OFF —
  // an idle cluster with the toggle off produces zero work in the tick.
  clusterIdleNudger.configure({
    broadcastWorkflow,
    resolveMembers: () => {
      const out = new Map<string, { workflowId: string; busy: boolean }[]>();
      for (const cid of clusterStore.listKnownClusterIds()) {
        const members = clusterStore.getMembers(cid);
        if (!members) continue;
        out.set(cid, members.map((wfid) => ({ workflowId: wfid, busy: workflows.get(wfid)?.busy === true })));
      }
      return out;
    },
  });
  clusterIdleNudger.start();

  // CLUSTER_MODE_PLAN.md Phase 5b — configure the auto-turn detector. The
  // detector itself has no timer (it runs inline off broadcastWorkflow's
  // peer_message_sent branch), so configure() just wires the three
  // callbacks the detector needs: broadcast (for cluster_auto_turn_fired
  // events), isBusy (the busy gate before dispatch), and dispatchAutoTurn
  // (which builds a synthetic ws/session pair and routes through
  // handleUserMessage so the turn is indistinguishable on the wire from an
  // operator-initiated send — same user_message_echo, same drain ordering,
  // same persistence path).
  clusterAutoTurn.configure({
    broadcastWorkflow,
    isBusy: (wfid) => workflows.get(wfid)?.busy === true,
    resolveMembers: () => {
      const out = new Map<string, { workflowId: string; busy: boolean }[]>();
      for (const cid of clusterStore.listKnownClusterIds()) {
        const members = clusterStore.getMembers(cid);
        if (!members) continue;
        out.set(cid, members.map((wfid) => ({ workflowId: wfid, busy: workflows.get(wfid)?.busy === true })));
      }
      return out;
    },
    dispatchAutoTurn: (wfid, content) => {
      // Phase 5b — smoke override. When ARCO_TEST_NO_AUTO_TURN_DISPATCH=1
      // the smoke harness wants to exercise the detector's audit events
      // (cluster_auto_turn_fired) without burning real LLM turns for every
      // dispatch. Skip the handleUserMessage call entirely; the event was
      // already broadcast by the detector before reaching here.
      if (process.env.ARCO_TEST_NO_AUTO_TURN_DISPATCH === '1') return;
      // Synthetic ws — every method is a no-op. handleUserMessage only uses
      // `send(ws, ...)` for error-back to the operator; an auto-turn has no
      // operator socket to error back to, and any errors land in the
      // recipient's events.jsonl via broadcastWorkflow anyway. readyState
      // is set to CLOSED so send()'s persistence path runs but the actual
      // socket write is skipped (see send() in this file).
      const fakeWs = {
        readyState: WebSocket.CLOSED,
        send: () => undefined,
      } as unknown as WebSocket;
      const fakeSession: Session = {
        id: 'auto-turn-synthetic',
        workflowIds: new Set([wfid]),
        clusterIds: new Set(),
        clusterObserved: new Map(),
      };
      handleUserMessage(
        fakeWs,
        fakeSession,
        wfid,
        content,
        undefined,   // no clientMessageId — this is server-originated
        undefined,   // no attachments
        false,       // not an interjection — auto-turn only fires on idle
        undefined,   // kind: default ('follow-up' path is for busy recipients)
        undefined,   // no DOCS/GIT primitive
      ).catch((err) => {
        console.error(`[arco] auto-turn handleUserMessage failed for ${wfid.slice(0, 8)}:`, err);
      });
    },
  });
  clusterAutoTurn.start();

  configureComputerActivity((wfid, content, guard, settled) => new Promise<boolean>((resolve) => {
    const fakeWs={readyState:WebSocket.CLOSED,send:()=>undefined} as unknown as WebSocket;
    const fakeSession:Session={id:'computer-activity',workflowIds:new Set([wfid]),clusterIds:new Set(),clusterObserved:new Map()};
    const run=()=>handleUserMessage(fakeWs,fakeSession,wfid,content,undefined,undefined,false,undefined,undefined,undefined,{
      backgroundEvent:true,onBackgroundSettled:settled,
      claimGuard:async(claim)=>{const accepted=await guard(claim);resolve(accepted);return accepted;},
    });
    const pending=workflows.get(wfid)?.config.incognito?withoutOperationalLogging(run):run();
    void pending.then(()=>{resolve(false);settled();},()=>{resolve(false);settled('Computer activity turn failed or was interrupted.');});
  }));

  const conditionalTurn: Parameters<typeof configureMailRules>[0] = (wfid, content, guard) => new Promise<boolean>((resolve) => {
    const fakeWs = { readyState: WebSocket.CLOSED, send: () => undefined } as unknown as WebSocket;
    const fakeSession: Session = { id: 'computer-mail-rule', workflowIds: new Set([wfid]), clusterIds: new Set(), clusterObserved: new Map() };
    void handleUserMessage(fakeWs, fakeSession, wfid, content, undefined, undefined, false, undefined, undefined, undefined, {
      claimGuard: async (claim) => {
        const accepted = await guard(claim); resolve(accepted); return accepted;
      },
    }).then(() => resolve(false), () => resolve(false));
  });
  configureMailRules(conditionalTurn);
  configureConditions(conditionalTurn,(wfid,_content,guard)=>new Promise<boolean>((resolve)=>{
    const fakeWs={readyState:WebSocket.CLOSED,send:()=>undefined} as unknown as WebSocket;
    const fakeSession:Session={id:'computer-script-compact',workflowIds:new Set([wfid]),clusterIds:new Set(),clusterObserved:new Map()};
    void handleCompactWorkflow(fakeWs,fakeSession,{type:'compact_workflow',workflowId:wfid},async(claim)=>{
      let token:number|false=false;
      const accepted=await guard(()=>{if(workflows.get(wfid)?.busy)return false;token=claim();return true;});
      resolve(accepted);return accepted?token:false;
    }).then(()=>resolve(false),()=>resolve(false));
  }));

  // DIRECTOR_WORKERS_WORKFLOW_PLAN.md Stage G — operator-armed task
  // dispatcher daemon. Default OFF per cluster; the timer is always present
  // but each tick gates through clusterStore.taskDispatcherSettingsFor().
  // Dispatch uses the same synthetic user-message path as DISPATCH ONCE and
  // the same durable dispatch_fired / dispatch_skipped ledger events.
  taskDispatcher.configureDispatcherDaemon({
    dispatchTaskTurn: dispatchTaskTurnSynthetic,
    publishResult: broadcastTaskDispatchResult,
  });
  taskDispatcher.startDispatcherDaemon();
  // Workflow-reporting layer (docs/REMOTE_MANAGEMENT.md §2). Inert unless
  // ARCO_HUB_URL is set — when it is, this live Arco registers to the
  // management hub as a 'service', pushes its workflow snapshot, and applies
  // routed reply/stop/continue actions (re-validating locally).
  // Broadcast hub-link status to every client so the desktop header can show a
  // "hub-linked" indicator + offer a local kill switch (transparency).
  onHubLinkStatus((status) => {
    for (const [ws] of sessions) send(ws, { type: 'hub_link_status', connected: status.connected, monitoredCount: status.monitoredCount, ...(status.hubUrl ? { hubUrl: status.hubUrl } : {}), ...(status.connectedSince !== undefined ? { connectedSince: status.connectedSince } : {}) });
  });
  initHubLink(process.cwd(), process.env.npm_package_version || '0.1.0');
  // Phase 2 — settings cascade HMR. Global watcher boots once; per-cwd
  // watchers are acquired on workflowCwds.set above. Each fire broadcasts
  // settings_updated to every connected client; clients re-fetch with their
  // own cwd context.
  installGlobalSettingsWatcher();
  onSettingsChange((scope, cwd) => {
    for (const [ws] of sessions) {
      send(ws, { type: 'settings_updated', scope, cwd });
    }
  });
  recoverWorkflowsFromDisk()
    .then((recovered) => {
      for (const r of recovered) {
        workflowCwds.set(r.meta.workflowId, r.cwd);
        acquireProjectSettingsWatcher(r.cwd);
      }
      console.log(`[arco] Recovered ${recovered.length} workflows from disk`);
    })
    .catch((err) => console.error('[arco] crash recovery failed:', err))
    // §B2 — mark `stores` ready in .finally, NOT only .then: a recovery error is
    // failure-isolated (logged above), and must still flip the gate. Otherwise
    // /readyz would stick at 503 forever and systemd/k8s would kill a process
    // that is actually serving.
    .finally(() => markReady('stores'));
  // Workbench Expansion §F1 — reconcile the machine-global Recall index with
  // disk on startup. Backfill is idempotent (upsert by wfid), so this both
  // picks up workflows that ran while a prior server was down AND reconstructs
  // recall.db from scratch if it was deleted. Failure-isolated — a recall
  // backfill error never blocks server boot.
  getRecallIndex()
    .backfill()
    .then((n) => console.log(`[arco] Recall index backfilled ${n} workflows`))
    .catch((err) => console.error('[arco] recall backfill failed:', err));
  // Eager boot registration of every persisted cluster member. The workflows
  // map otherwise fills lazily from client rehydrate_workflows, so a member no
  // connected client holds a config for stayed unregistered — its pane stuck on
  // "AWAITING REHYDRATE…" and its turns invisible. Failure-isolated (matches the
  // recall backfill above): a bad cluster meta never blocks boot or /readyz.
  registerAllClusterMembersOnBoot()
    .then((n) => n > 0 && console.log(`[arco] Registered ${n} cluster member(s) on boot`))
    .catch((err) => console.error('[arco] cluster member boot registration failed:', err));
});
