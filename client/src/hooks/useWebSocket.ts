import { checkBuild } from '../buildCheck';
import { useEffect, useRef, useCallback, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import type { ClientMessage, ServerMessage, WorkflowConfig, ModelName, EffortLevel, ChatMessage, ProviderName, ReviewContextRef, MemberTier, ClusterEfficiencyLevel, ClusterProgressMode, ClusterTaskBoardMode, ClusterMemberProvider, LedgerTaskStatus, TaskLink, GenesisSeed, GenesisGithubParams, GenesisAssistField, GenesisAssistIntent, PreviewCaptureKind, PreviewViewport, WorkbenchNoticeCategory, ArcoSkillRef, BakeoffAttemptSpec } from '@arco/shared';
// Phase 6 extraction — the per-message dispatch (the former ws.onmessage body)
// and the streaming-state singletons live under ../ws now. Importing
// streamState here also loads its module-level useAppStore.subscribe prune
// block (kept at module top level there so it still runs on first load).
import { getStreamRef, streamingMsgs } from '../ws/streamState';
import { handleServerMessage } from '../ws/handleServerMessage';
import { ensureWsSession } from '../utils/wsSession';
import { registerDocEditSender, type DocEditRequestArgs } from '../stores/docEditStore';
import { registerMdTuneupRequestSender, registerMdTuneupAcceptSender, registerMdTuneupCandidatesSender, type MdTuneupEditor } from '../stores/mdTuneupStore';
import type { MdTuneupTarget } from '@arco/shared';
import { registerDistillSender, type DistillRequestArgs } from '../stores/knowledgeDistillStore';
import { deriveConnectionState, HEALTHZ_PROBE_TIMEOUT_MS } from '../runtime/runtimeState';
import {
  registerCookbookRecommendSender, type CookbookRecommendArgs,
  registerCookbookDownloadSender, registerCookbookCancelDownloadSender, type CookbookDownloadArgs,
} from '../stores/cookbookStore';
import {
  registerCompareRequestSender, registerCompareVoteSender,
  registerCompareSynthesizeSender, registerCompareCancelSender,
  type CompareRequestArgs,
} from '../stores/compareStore';
import { registerOrchestrationAssistSender, type OrchestrationAssistRequestArgs } from '../stores/orchestrationAssistStore';
import { registerLiveChangesSender } from '../stores/liveChangesStore';
import { registerClusterSnapshotSender } from '../stores/clusterSnapshotsStore';

const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 2000;

type TaskLedgerPatch = {
  title?: string;
  status?: LedgerTaskStatus;
  notes?: string;
  links?: TaskLink[];
  assignee?: string;
  worktreeRequired?: boolean;
  boardKey?: string;
};

type ClusterDispatcherSettingsPatch = {
  intervalMs?: number;
  maxTasksPerSweep?: number;
  maxConcurrentRuns?: number;
  autoWorktree?: boolean;
};

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const backoffRef = useRef(INITIAL_BACKOFF_MS);
  const teardownRef = useRef(false);
  const mintingRef = useRef(false);
  const [reconnectState, setReconnectState] = useState<{ attempting: boolean; nextAttemptIn: number }>({ attempting: false, nextAttemptIn: 0 });
  // §C1 — connection-state inputs the pure deriver consumes. everOpened keeps
  // the boot-vs-reconnect distinction (connecting only before the first open);
  // healthzReachable is the latest /healthz probe result (null = not yet
  // probed → treated as optimistic 'disconnected' until it resolves).
  const everOpenedRef = useRef(false);
  const healthzRef = useRef<boolean | null>(null);

  // §C1 — probe the server's liveness on WS close / each failed reconnect tick.
  // A resolved 2xx → server process is up (browser/network drop → disconnected);
  // a reject/timeout/non-2xx → server is gone (server-down). Same relative
  // base-URL convention as the existing /api/restart + /api/transcript fetches
  // (Vite proxies /healthz and /api to :3001 in dev; same-origin in prod), so
  // we don't fork a second server-URL derivation. Pushes the derived state into
  // the store regardless of outcome.
  const probeHealthz = useCallback(async () => {
    let reachable: boolean;
    try {
      const res = await fetch('/healthz', { signal: AbortSignal.timeout(HEALTHZ_PROBE_TIMEOUT_MS) });
      reachable = res.ok;
    } catch {
      reachable = false;
    }
    healthzRef.current = reachable;
    // Only let a probe drive the badge while the socket is actually down — a
    // late probe must not clobber an 'online' that a reopen already set.
    const open = wsRef.current?.readyState === WebSocket.OPEN;
    useAppStore.getState().setConnectionState(
      deriveConnectionState({
        wsState: open ? 'open' : 'closed',
        everOpened: everOpenedRef.current,
        healthzReachable: reachable,
      }),
    );
  }, []);

  const scheduleReconnect = useCallback((immediate = false) => {
    if (teardownRef.current) return;
    clearTimeout(reconnectTimer.current);
    const delay = immediate ? 0 : backoffRef.current;
    setReconnectState({ attempting: true, nextAttemptIn: delay });
    // §C1 — re-probe liveness on each reconnect tick so a server that dies
    // mid-backoff flips disconnected → server-down (and a recovering one flips
    // back) without waiting for the socket to actually reopen.
    void probeHealthz();
    reconnectTimer.current = setTimeout(() => {
      connect();
    }, delay);
    // Exponential backoff for the NEXT attempt if this one fails
    if (!immediate) {
      backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);
    }
  }, [probeHealthz]);

  const connect = useCallback(() => {
    if (teardownRef.current) return;
    const current = wsRef.current;
    if (current && (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING)) {
      return;
    }
    // Detach handlers from the old instance so its trailing onclose can't
    // schedule another reconnect and retain the object. Prevents churn leak
    // when connection attempts stack up.
    if (current) {
      current.onopen = null;
      current.onmessage = null;
      current.onerror = null;
      current.onclose = null;
      if (current.readyState !== WebSocket.CLOSED) {
        try { current.close(); } catch { /* already closing */ }
      }
    }
    clearTimeout(reconnectTimer.current);
    reconnectTimer.current = undefined;
    // The upgrade needs a fresh session cookie (server/src/http/wsAuth.ts).
    // mintingRef stops a second connect() during the await from opening a
    // duplicate socket.
    if (mintingRef.current) return;
    mintingRef.current = true;
    void ensureWsSession().then(() => {
      mintingRef.current = false;
      if (teardownRef.current) return;
      openSocket();
    });

    function openSocket() {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        backoffRef.current = INITIAL_BACKOFF_MS;
        setReconnectState({ attempting: false, nextAttemptIn: 0 });
        // §C1 — socket is live. Mark everOpened (no more 'connecting' boot state)
        // and clear the stale probe result so a future close starts optimistic.
        everOpenedRef.current = true;
        healthzRef.current = null;
        // A reconnect usually means the server restarted on a new build; see buildCheck.ts.
        void checkBuild();
        useAppStore.getState().setConnectionState(
          deriveConnectionState({ wsState: 'open', everOpened: true, healthzReachable: null }),
        );
      };

      ws.onmessage = (event) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        handleServerMessage(msg, { wsRef, scheduleReconnect });
      };

      ws.onclose = () => {
        useAppStore.getState().setConnected(false);
        streamingMsgs.clear();
        // §C1 — socket dropped. Reset the probe to "unknown" and show the
        // optimistic 'disconnected' immediately; scheduleReconnect fires the
        // probe that may escalate to 'server-down'.
        healthzRef.current = null;
        useAppStore.getState().setConnectionState(
          deriveConnectionState({ wsState: 'closed', everOpened: everOpenedRef.current, healthzReachable: null }),
        );
        if (teardownRef.current) return;
        scheduleReconnect(false);
      };

      ws.onerror = () => {
        // onerror is always followed by onclose — let onclose schedule the retry
        try { ws.close(); } catch { /* already closing */ }
      };
    }
  }, [scheduleReconnect]);

  const reconnectNow = useCallback(() => {
    backoffRef.current = INITIAL_BACKOFF_MS;
    const current = wsRef.current;
    if (current && current.readyState !== WebSocket.CLOSED) {
      try { current.close(); } catch { /* ignore */ }
    }
    scheduleReconnect(true);
  }, [scheduleReconnect]);

  useEffect(() => {
    teardownRef.current = false;
    connect();
    // Phase 7b — register a raw send hook on the store so chat-message
    // components (AskUserQuestionNotice) can reply without prop-threading.
    useAppStore.getState().setWsSendRaw((msg) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(msg));
      }
    });
    registerLiveChangesSender((msg) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(msg));
      }
    });
    // Cluster snapshots ride the same global-sender pattern: the store dispatches
    // save/list/restore/delete without prop-threading the WS handle.
    registerClusterSnapshotSender((msg) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(msg));
      }
    });

    // Network came back (browser navigator.onLine flipped true)
    const handleOnline = () => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) {
        reconnectNow();
      }
    };

    // Tab became visible again — check the socket and reconnect if needed
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && wsRef.current?.readyState !== WebSocket.OPEN) {
        reconnectNow();
      }
    };

    // Browser window regained focus — another nudge to reconnect
    const handleFocus = () => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) {
        reconnectNow();
      }
    };

    window.addEventListener('online', handleOnline);
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('focus', handleFocus);

    return () => {
      teardownRef.current = true;
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
      window.removeEventListener('online', handleOnline);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('focus', handleFocus);
      useAppStore.getState().setWsSendRaw(null);
      registerLiveChangesSender(null);
      registerClusterSnapshotSender(null);
    };
  }, [connect, reconnectNow]);

  const createWorkflow = useCallback((config: WorkflowConfig) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'create_workflow', config }));
  }, []);

  // docs/ARCHITECTURE.md - Genesis. Update the workflow's working seed (server
  // echoes genesis_seed_updated with readiness + next prompt) and trigger the
  // operator-confirmed scaffold (server creates the project, rebinds the cwd).
  const genesisSeedUpdate = useCallback((workflowId: string, seed: GenesisSeed) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'genesis_seed_update', workflowId, seed }));
  }, []);

  const genesisScaffold = useCallback((workflowId: string, root?: string, github?: GenesisGithubParams) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'genesis_scaffold',
      workflowId,
      ...(root ? { root } : {}),
      ...(github ? { github } : {}),
    }));
  }, []);

  // docs/ARCHITECTURE.md - arm/disarm in-workflow Creative mode on an existing
  // workflow (server echoes genesis_creative_armed with the seeded context +
  // codebase assessment).
  const genesisCreativeArm = useCallback((workflowId: string, disarm?: boolean) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'genesis_creative_arm', workflowId, ...(disarm ? { disarm: true } : {}) }));
  }, []);

  const genesisAssistRequest = useCallback((workflowId: string, requestId: string, field: GenesisAssistField, intent: GenesisAssistIntent, seed: GenesisSeed, instruction?: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'genesis_assist_request',
      workflowId,
      requestId,
      field,
      intent,
      seed,
      ...(instruction?.trim() ? { instruction: instruction.trim() } : {}),
    }));
  }, []);

  // §J1 — replace the muted notification-category set. Server persists +
  // re-broadcasts the authoritative snapshot, which the handler folds back.
  const setNotificationMutes = useCallback((muted: WorkbenchNoticeCategory[]) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'set_notification_mutes', muted }));
  }, []);

  // Returns false when the socket is down and nothing was sent, so composers
  // keep the draft + staged attachments instead of wiping an unsent message
  // (Enter during a reconnect used to erase the text with no trace).
  const sendMessage = useCallback((workflowId: string, content: string, attachments?: string[], kind?: 'steer' | 'follow-up' | 'interrupt', primitive?: 'docs' | 'git', pickedSkills?: Array<{ scope: 'project' | 'global'; slug: string }>): boolean => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return false;
    // Slot 8 — detect busy state on this workflow. If busy, mark the message
    // as an interjection so the server queues it instead of rejecting as
    // "busy". Busy here means any active worker OR any streaming assistant
    // message — same signal TerminalInput uses to show the processing state.
    const job = useAppStore.getState().jobs[workflowId];
    const hasActiveWorkers = job
      ? Object.values(job.workers).some((w) => w.status === 'running' || w.status === 'spawning')
      : false;
    const hasStreaming = job ? job.messages.some((m) => m.isStreaming) : false;
    // Server-authoritative busy flag (from primary_turn_started/ended +
    // workflow_state_snapshot). Preferred signal; the streaming/worker
    // heuristics stay as fallback for the brief window before the first
    // snapshot arrives on reconnect.
    const isBusy = (job?.busy === true) || hasActiveWorkers || hasStreaming;

    if (!isBusy) {
      const ref = getStreamRef(workflowId);
      ref.passthrough = null;
      ref.parentTurnId = null;
    }

    // Client-generated id shared between the locally-added chat message and
    // the server's `user_message_echo` broadcast. Lets the echo dedup against
    // the local add so we don't double-render on the originating tab, while
    // still picking up user prompts on Resume-picker replay / multi-tab.
    const clientMessageId = crypto.randomUUID();

    // Phase 4 — kind only matters on the busy path (idle sends bypass the
    // queue and start a fresh turn). When kind is omitted on a busy send,
    // the server defaults to 'follow-up' (back-compat with Phase-3-and-older
    // clients that just sent `interjection: true` and got silent post-turn
    // delivery).
    const effectiveKind = kind === 'interrupt' ? kind : isBusy ? (kind ?? 'follow-up') : undefined;

    wsRef.current.send(JSON.stringify({
      type: 'user_message',
      workflowId,
      content,
      attachments,
      clientMessageId,
      ...(isBusy ? { interjection: true } : {}),
      ...(effectiveKind ? { kind: effectiveKind } : {}),
      ...(primitive ? { primitive } : {}),
      ...(pickedSkills && pickedSkills.length > 0 ? { pickedSkills } : {}),
    }));

    useAppStore.getState().addMessage(workflowId, {
      id: clientMessageId,
      role: 'user',
      content,
      isStreaming: false,
      attachments,
      timestamp: Date.now(),
      queued: isBusy,
      ...(effectiveKind ? { queueKind: effectiveKind } : {}),
    });
    return true;
  }, []);

  const cancel = useCallback((workflowId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cancel', workflowId }));
  }, []);

  // Operator-triggered provider-native compaction (including Cursor `/compress`). The
  // server gates on provider + idle and drives the busy lock; this just fires
  // the request. Completion / failure surfaces as a system_notice chat line.
  const compactWorkflow = useCallback((workflowId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'compact_workflow', workflowId }));
  }, []);

  // §2.1 — operator-triggered deterministic Fold (Claude Native).
  // engine 'server' = Server Fold (on-demand compaction; server falls back to
  // the deterministic Fold on any failure).
  const foldWorkflow = useCallback((workflowId: string, engine?: 'server') => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'fold_workflow', workflowId, ...(engine ? { engine } : {}) }));
  }, []);

  // §4.1 — set the per-tab tool posture (session-local; server acks via
  // tool_posture_set). Takes effect on the next turn.
  const setToolPosture = useCallback((workflowId: string, posture: 'full' | 'coding' | 'chat' | 'review') => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'set_tool_posture', workflowId, posture }));
  }, []);

  // DD7 — operator answered the project-trust prompt for a cwd.
  const setProjectTrust = useCallback((workflowId: string, cwd: string, decision: 'always' | 'never') => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'set_project_trust', workflowId, cwd, decision }));
  }, []);

  // Local kill switch / reconnect for the management-hub link (header indicator).
  const hubLinkSetEnabled = useCallback((enabled: boolean) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'hub_link_set_enabled', enabled }));
  }, []);

  const cancelQueuedMessage = useCallback((workflowId: string, clientMessageId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    // Optimistically drop locally so the chat updates instantly even if the
    // server's broadcast is delayed. The server broadcast is idempotent —
    // removeMessage is a no-op on an already-gone id.
    useAppStore.getState().removeMessage(workflowId, clientMessageId);
    wsRef.current.send(JSON.stringify({ type: 'cancel_queued_message', workflowId, clientMessageId }));
  }, []);

  const removeWorkflow = useCallback((workflowId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'remove_workflow', workflowId }));
  }, []);

  const listBakeoffs = useCallback((workflowId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'bakeoff_list', workflowId }));
  }, []);

  const startBakeoff = useCallback((
    workflowId: string,
    prompt: string,
    attempts: BakeoffAttemptSpec[],
    name?: string,
  ) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'bakeoff_start', workflowId, prompt, attempts, name }));
  }, []);

  const promoteBakeoff = useCallback((workflowId: string, bakeoffId: string, attemptId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'bakeoff_promote', workflowId, bakeoffId, attemptId }));
  }, []);

  const cleanupBakeoff = useCallback((
    workflowId: string,
    bakeoffId: string,
    attemptIds: string[],
  ) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'bakeoff_cleanup', workflowId, bakeoffId, attemptIds }));
  }, []);

  const requestReview = useCallback((
    workflowId: string,
    reviewer: { provider: ProviderName; model: ModelName; effort: EffortLevel; providerAccountRef?: string },
    contextRef: ReviewContextRef = { kind: 'last-turn' },
    includeGitDiff: boolean = false,
  ) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'review_request',
      workflowId,
      reviewer,
      contextRef,
      includeGitDiff,
    }));
  }, []);

  const cancelReview = useCallback((workflowId: string, reviewId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cancel_review', workflowId, reviewId }));
  }, []);

  // docs/ARCHITECTURE.md - dispatch a Deep Research run against an
  // existing workflow (in-tab path, and the dig-deeper follow-up). The new-tab
  // path goes through createWorkflow + a deferred research_request keyed by
  // researchSpawnToken (see terminalInput/research.ts + the workflow_created
  // handler).
  const requestResearch = useCallback((
    workflowId: string,
    researcher: { provider: ProviderName; model: ModelName; effort: EffortLevel; providerAccountRef?: string },
    topic: string,
    maxRounds: number,
    opts?: { seedArtifactName?: string; followUp?: string },
  ) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'research_request',
      workflowId,
      researcher,
      topic,
      maxRounds,
      ...(opts?.seedArtifactName ? { seedArtifactName: opts.seedArtifactName } : {}),
      ...(opts?.followUp ? { followUp: opts.followUp } : {}),
    }));
  }, []);

  const cancelResearch = useCallback((workflowId: string, researchId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cancel_research', workflowId, researchId }));
  }, []);

  // docs/ARCHITECTURE.md - dispatch a Cookbook recommendation. The
  // server reuses the B2 bounded research turn (grounded on the G1 profile + the
  // G2 fit-filtered candidates + the task profile), so the lifecycle + artifact
  // arrive via the research_* events / RESEARCH tab. Registered into the
  // cookbookStore so the globally-mounted modal can fire without prop-threading.
  const requestCookbookRecommend = useCallback((args: CookbookRecommendArgs) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'cookbook_recommend_request',
      workflowId: args.workflowId,
      researcher: args.researcher,
      taskProfile: args.taskProfile,
      maxRounds: args.maxRounds,
      ...(args.query ? { query: args.query } : {}),
      ...(args.sim ? { sim: args.sim } : {}),
    }));
  }, []);

  useEffect(() => {
    registerCookbookRecommendSender(requestCookbookRecommend);
    return () => registerCookbookRecommendSender(null);
  }, [requestCookbookRecommend]);

  // docs/ARCHITECTURE.md - dispatch a Cookbook download (operator-
  // initiated only) + its cancel. The download lifecycle arrives via
  // cookbook_download_progress and is routed into the cookbookStore.
  const requestCookbookDownload = useCallback((args: CookbookDownloadArgs) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'cookbook_download_request',
      workflowId: args.workflowId,
      source: args.source,
      ...(args.repo ? { repo: args.repo } : {}),
      ...(args.quant ? { quant: args.quant } : {}),
      ...(args.alias ? { alias: args.alias } : {}),
      ...(args.ctxSize ? { ctxSize: args.ctxSize } : {}),
      ...(args.capabilities ? { capabilities: args.capabilities } : {}),
      ...(args.name ? { name: args.name } : {}),
      ...(args.confirm ? { confirm: args.confirm } : {}),
    }));
  }, []);
  const cancelCookbookDownload = useCallback((workflowId: string, downloadId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cookbook_cancel_download', workflowId, downloadId }));
  }, []);

  useEffect(() => {
    registerCookbookDownloadSender(requestCookbookDownload);
    registerCookbookCancelDownloadSender(cancelCookbookDownload);
    return () => {
      registerCookbookDownloadSender(null);
      registerCookbookCancelDownloadSender(null);
    };
  }, [requestCookbookDownload, cancelCookbookDownload]);

  // docs/ARCHITECTURE.md - dispatch a scoped AI doc-edit. In-tab only
  // (the proposal must round-trip to THIS editor buffer), so it always targets
  // an existing workflow. The agent returns text only; the proposal arrives via
  // doc_edit_proposed and is routed into the docEditStore.
  const requestDocEdit = useCallback((args: DocEditRequestArgs) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'doc_edit_request',
      workflowId: args.workflowId,
      editor: args.editor,
      filePath: args.filePath,
      selectionText: args.selectionText,
      selectionFrom: args.selectionFrom,
      selectionTo: args.selectionTo,
      contextBefore: args.contextBefore,
      contextAfter: args.contextAfter,
      instruction: args.instruction,
      wholeDoc: args.wholeDoc,
    }));
  }, []);

  // Register the module-level sender the docEditStore (and the deeply-nested
  // FileViewerModal affordance) fires through, so we don't thread the callback
  // through every modal call site.
  useEffect(() => {
    registerDocEditSender(requestDocEdit);
    return () => registerDocEditSender(null);
  }, [requestDocEdit]);

  // Agent-instruction-file tune-up — see shared/src/protocol/mdTuneup.ts. The
  // request spawns a read-only proposal; accept triggers the server-side
  // backup + write. Both fire through module-level senders the mdTuneupStore
  // (and the composer button / modal) reach without threading callbacks.
  const requestMdTuneup = useCallback((args: { workflowId: string; editor: MdTuneupEditor; target: MdTuneupTarget }) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'md_tuneup_request',
      workflowId: args.workflowId,
      editor: args.editor,
      target: args.target,
    }));
  }, []);
  const acceptMdTuneup = useCallback((args: { workflowId: string; tuneupId: string; filePath: string; proposed: string }) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'md_tuneup_accept',
      workflowId: args.workflowId,
      tuneupId: args.tuneupId,
      filePath: args.filePath,
      proposed: args.proposed,
    }));
  }, []);
  const requestMdTuneupCandidates = useCallback((workflowId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'md_tuneup_candidates_request', workflowId }));
  }, []);
  useEffect(() => {
    registerMdTuneupRequestSender(requestMdTuneup);
    registerMdTuneupAcceptSender(acceptMdTuneup);
    registerMdTuneupCandidatesSender(requestMdTuneupCandidates);
    return () => {
      registerMdTuneupRequestSender(null);
      registerMdTuneupAcceptSender(null);
      registerMdTuneupCandidatesSender(null);
    };
  }, [requestMdTuneup, acceptMdTuneup, requestMdTuneupCandidates]);

  const requestOrchestrationAssist = useCallback((args: OrchestrationAssistRequestArgs) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'cluster_orchestration_assist_request',
      clusterId: args.clusterId,
      workflowId: args.workflowId,
      requestId: args.requestId,
      kind: args.kind,
      prompt: args.prompt.trim(),
      inputRefs: args.inputRefs ?? [],
      model: args.model,
    }));
  }, []);

  useEffect(() => {
    registerOrchestrationAssistSender(requestOrchestrationAssist);
    return () => registerOrchestrationAssistSender(null);
  }, [requestOrchestrationAssist]);

  // §B3 — dispatch a knowledge "distill from session" DRAFT. The agent drafts
  // an article from this tab's transcript; the proposal lands in the wizard via
  // knowledge_distill_proposed for the operator to edit + Save. Nothing is saved
  // by the agent.
  const requestDistill = useCallback((args: DistillRequestArgs) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'knowledge_distill_request',
      workflowId: args.workflowId,
      drafter: args.drafter,
      focus: args.focus,
    }));
  }, []);
  useEffect(() => {
    registerDistillSender(requestDistill);
    return () => registerDistillSender(null);
  }, [requestDistill]);

  // docs/ARCHITECTURE.md - Compare primitive dispatch. One prompt
  // fans out to N read-only legs; the vote/synthesize/cancel are explicit
  // operator follow-ups. Lifecycle arrives via compare_* events → compareStore.
  const requestCompare = useCallback((args: CompareRequestArgs) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'compare_request',
      workflowId: args.workflowId,
      prompt: args.prompt,
      legs: args.legs,
      blind: args.blind,
    }));
  }, []);
  const voteCompare = useCallback((workflowId: string, compareId: string, winnerLegIndex: number) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'compare_vote', workflowId, compareId, winnerLegIndex }));
  }, []);
  const synthesizeCompare = useCallback((workflowId: string, compareId: string, synthesizerLegIndex: number) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'compare_synthesize', workflowId, compareId, synthesizerLegIndex }));
  }, []);
  const cancelCompare = useCallback((workflowId: string, compareId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cancel_compare', workflowId, compareId }));
  }, []);

  useEffect(() => {
    registerCompareRequestSender(requestCompare);
    registerCompareVoteSender(voteCompare);
    registerCompareSynthesizeSender(synthesizeCompare);
    registerCompareCancelSender(cancelCompare);
    return () => {
      registerCompareRequestSender(null);
      registerCompareVoteSender(null);
      registerCompareSynthesizeSender(null);
      registerCompareCancelSender(null);
    };
  }, [requestCompare, voteCompare, synthesizeCompare, cancelCompare]);

  // docs/ARCHITECTURE.md - operator-triggered Recall summary. Sent
  // from the Recall view's per-row Summarize action (and the operator-armed
  // on-close hook). Resolves the summarizer config like the reviewer/research
  // path. Returns true if the message was actually sent (socket open).
  const requestRecallSummary = useCallback((
    wfid: string,
    summarizer: { provider: ProviderName; model: ModelName; effort: EffortLevel; providerAccountRef?: string },
  ): boolean => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return false;
    wsRef.current.send(JSON.stringify({ type: 'recall_summary_request', wfid, summarizer }));
    return true;
  }, []);

  const requestHandoff = useCallback((
    workflowId: string,
    mode: 'original-worker' | 'fresh-summarizer' | 'fresh-agent' = 'original-worker',
    summarizer?: { provider: ProviderName; model: ModelName; effort: EffortLevel },
    newPrimary?: { provider: ProviderName; model: ModelName; effort: EffortLevel; providerAccountRef?: string },
  ) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'handoff_request',
      workflowId,
      mode,
      ...(summarizer ? { summarizer } : {}),
      ...(newPrimary ? { newPrimary } : {}),
    }));
  }, []);

  const cancelHandoff = useCallback((workflowId: string, handoffId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'handoff_cancel', workflowId, handoffId }));
  }, []);

  const clearHandoffLock = useCallback((cwd: string, workflowId: string, handoffId?: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'handoff_lock_clear',
      cwd,
      workflowId,
      ...(handoffId ? { handoffId } : {}),
    }));
  }, []);

  const updatePrimaryConfig = useCallback((
    workflowId: string,
    update: { model?: ModelName; effort?: EffortLevel; providerAccountRef?: string; autoHandoff?: { enabled: boolean; warnAt: number; autoAt: number; mode?: 'original-worker' | 'fresh-summarizer'; summarizer?: { provider: ProviderName; model?: ModelName; effort?: EffortLevel } }; autoFold?: { enabled: boolean; foldAt: number; tailBudget?: number }; autoCompaction?: import('@arco/shared').AutoCompactionPolicy | null; codexTransport?: 'exec' | 'appserver'; codexContextPolicy?: 'max' | 'standard'; claudeTransport?: 'cli' | 'native'; ultracode?: boolean; webSearchMaxUses?: number; chatWebAccess?: boolean; claudeNativeCompact?: boolean; claudeNativeForceInterleavedThinkingBeta?: boolean; claudeNativeThinkingDisplay?: 'omitted' | 'summarized' | 'updates'; nativeCompactAutoContinue?: boolean; efficiencyToolFilter?: 'off' | 'conservative' | 'aggressive'; efficiencyFactForce?: 'on' | 'off'; efficiencyConfigProtection?: 'on' | 'off'; efficiencySandbox?: 'off' | 'on'; reviewSafeMode?: 'off' | 'on'; outputStyle?: 'normal' | 'lite' | 'terse'; goalRun?: { enabled: boolean; total?: number; tokenBudget?: number }; goal?: string; pinnedSkills?: ArcoSkillRef[]; remoteEnabled?: boolean; remoteGatesEnabled?: boolean; ollamaParams?: Record<string, unknown> },
  ) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;

    wsRef.current.send(JSON.stringify({
      type: 'update_primary_config',
      workflowId,
      ...(update.model !== undefined ? { model: update.model } : {}),
      ...(update.effort !== undefined ? { effort: update.effort } : {}),
      ...(update.providerAccountRef !== undefined ? { providerAccountRef: update.providerAccountRef } : {}),
      ...(update.autoHandoff !== undefined ? { autoHandoff: update.autoHandoff } : {}),
      ...(update.autoFold !== undefined ? { autoFold: update.autoFold } : {}),
      ...(update.autoCompaction !== undefined ? { autoCompaction: update.autoCompaction } : {}),
      ...(update.codexTransport !== undefined ? { codexTransport: update.codexTransport } : {}),
      ...(update.codexContextPolicy !== undefined ? { codexContextPolicy: update.codexContextPolicy } : {}),
      ...(update.claudeTransport !== undefined ? { claudeTransport: update.claudeTransport } : {}),
      ...(update.ultracode !== undefined ? { ultracode: update.ultracode } : {}),
      ...(update.webSearchMaxUses !== undefined ? { webSearchMaxUses: update.webSearchMaxUses } : {}),
      ...(update.chatWebAccess !== undefined ? { chatWebAccess: update.chatWebAccess } : {}),
      ...(update.claudeNativeCompact !== undefined ? { claudeNativeCompact: update.claudeNativeCompact } : {}),
      ...(update.claudeNativeForceInterleavedThinkingBeta !== undefined ? { claudeNativeForceInterleavedThinkingBeta: update.claudeNativeForceInterleavedThinkingBeta } : {}),
      ...(update.claudeNativeThinkingDisplay !== undefined ? { claudeNativeThinkingDisplay: update.claudeNativeThinkingDisplay } : {}),
      ...(update.nativeCompactAutoContinue !== undefined ? { nativeCompactAutoContinue: update.nativeCompactAutoContinue } : {}),
      ...(update.efficiencyToolFilter !== undefined ? { efficiencyToolFilter: update.efficiencyToolFilter } : {}),
      ...(update.efficiencyFactForce !== undefined ? { efficiencyFactForce: update.efficiencyFactForce } : {}),
      ...(update.efficiencyConfigProtection !== undefined ? { efficiencyConfigProtection: update.efficiencyConfigProtection } : {}),
      ...(update.efficiencySandbox !== undefined ? { efficiencySandbox: update.efficiencySandbox } : {}),
      ...(update.reviewSafeMode !== undefined ? { reviewSafeMode: update.reviewSafeMode } : {}),
      ...(update.outputStyle !== undefined ? { outputStyle: update.outputStyle } : {}),
      ...(update.goal !== undefined ? { goal: update.goal } : {}),
      ...(update.goalRun !== undefined ? { goalRun: update.goalRun } : {}),
      ...(update.pinnedSkills !== undefined ? { pinnedSkills: update.pinnedSkills } : {}),
      ...(update.remoteEnabled !== undefined ? { remoteEnabled: update.remoteEnabled } : {}),
      ...(update.remoteGatesEnabled !== undefined ? { remoteGatesEnabled: update.remoteGatesEnabled } : {}),
      ...(update.ollamaParams !== undefined ? { ollamaParams: update.ollamaParams } : {}),
    }));
  }, []);

  const requestSpawnFromHere = useCallback((
    parentWorkflowId: string,
    newConfig: WorkflowConfig,
    newDirection: string,
    includePlan: boolean = false,
    mode: 'fresh-summarizer' | 'original-worker' | 'fresh-agent' = 'original-worker',
    cutoffEventSeq?: number,
    joinClusterId?: string,
  ) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'spawn_from_here_request',
      parentWorkflowId,
      newConfig,
      mode,
      ...(newDirection.trim() ? { newDirection: newDirection.trim() } : {}),
      ...(includePlan ? { includePlan: true } : {}),
      ...(typeof cutoffEventSeq === 'number' ? { cutoffEventSeq } : {}),
      ...(joinClusterId ? { joinClusterId } : {}),
    }));
  }, []);

  // Page the next-older chunk of chat history into the store. Dispatches on
  // `earlierSource`: 'ws' routes through the server's pendingEarlierEntries
  // queue (Claude JSONL watcher); 'transcript' re-hits the REST endpoint with
  // `before=<cursor>`. The pill caller doesn't need to care which.
  const loadEarlierMessages = useCallback(async (workflowId: string) => {
    const job = useAppStore.getState().jobs[workflowId];
    if (!job || !job.hasEarlierSessionHistory) return;
    if (job.earlierSource === 'ws') {
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;
      wsRef.current.send(JSON.stringify({ type: 'load_earlier_messages', workflowId }));
      return;
    }
    if (job.earlierSource === 'transcript' && job.transcriptFetch && typeof job.earlierTranscriptCursor === 'number') {
      const { sessionId, provider, cwd } = job.transcriptFetch;
      const q = new URLSearchParams({
        path: cwd,
        sessionId,
        provider,
        before: String(job.earlierTranscriptCursor),
      });
      try {
        const r = await fetch(`/api/transcript?${q.toString()}`);
        if (!r.ok) return;
        const d: { messages?: ChatMessage[]; hasEarlier?: boolean; earlierCursor?: number } = await r.json();
        if (d.messages && d.messages.length > 0) {
          useAppStore.getState().prependMessages(workflowId, d.messages);
        }
        useAppStore.getState().setEarlierState(workflowId, {
          hasEarlierSessionHistory: !!d.hasEarlier,
          earlierTranscriptCursor: typeof d.earlierCursor === 'number' ? d.earlierCursor : undefined,
          earlierSource: d.hasEarlier ? 'transcript' : undefined,
        });
      } catch { /* network error — pill stays visible for retry */ }
    }
  }, []);

  const uploadFile = useCallback(async (file: File): Promise<{ fileId: string; filename: string; path: string } | null> => {
    try {
      const res = await fetch(`http://${window.location.hostname}:3001/upload`, {
        method: 'POST',
        // Cross-port in dev — the session cookie (wsAuth.ts) only rides along
        // with credentials.
        credentials: 'include',
        headers: { 'X-Filename': file.name, 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      try {
        const res = await fetch('/upload', {
          method: 'POST',
          headers: { 'X-Filename': file.name, 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    }
  }, []);

  const requestRecalibrate = useCallback((workflowId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'recalibrate_request', workflowId }));
  }, []);

  const attachPlan = useCallback((workflowId: string, planId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'plan_attach', workflowId, planId }));
  }, []);

  const detachPlan = useCallback((workflowId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'plan_detach', workflowId }));
  }, []);

  const setPreviewPort = useCallback((workflowId: string, port: number, framework?: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    wsRef.current.send(JSON.stringify({
      type: 'set_preview_port',
      workflowId,
      port,
      ...(framework ? { framework } : {}),
      manual: true,
    }));
  }, []);

  const clearPreviewPort = useCallback((workflowId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'clear_preview_port', workflowId }));
  }, []);

  // G1 — capture the running preview (screenshot + console + network). `captures`
  // scopes which facets the report renders; the server runs the same CDP session
  // regardless. Defaults to all three.
  const previewCapture = useCallback((workflowId: string, captures?: PreviewCaptureKind[], viewport?: PreviewViewport) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'preview_capture_request',
      workflowId,
      captures: captures && captures.length > 0 ? captures : ['screenshot', 'console', 'network'],
      ...(viewport ? { viewport } : {}),
    }));
  }, []);

  // docs/ARCHITECTURE.md - project task ledger (cwd-scoped, server resolves
  // the cwd from the workflowId). The server re-snapshots after each mutation.
  const taskLedgerCreate = useCallback(
    (workflowId: string, title: string, notes?: string, links?: TaskLink[], boardKey?: string) => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;
      wsRef.current.send(JSON.stringify({
        type: 'task_ledger_create',
        workflowId,
        ...(boardKey ? { boardKey } : {}),
        title,
        ...(notes ? { notes } : {}),
        ...(links && links.length > 0 ? { links } : {}),
      }));
    },
    [],
  );

  const taskLedgerUpdate = useCallback(
    (
      workflowId: string,
      id: string,
      patch: TaskLedgerPatch,
    ) => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;
      wsRef.current.send(JSON.stringify({ type: 'task_ledger_update', workflowId, id, ...patch }));
    },
    [],
  );

  const taskLedgerDelete = useCallback((workflowId: string, id: string, boardKey?: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'task_ledger_delete', workflowId, id, ...(boardKey ? { boardKey } : {}) }));
  }, []);

  const taskLedgerList = useCallback((workflowId: string, boardKey?: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'task_ledger_list', workflowId, ...(boardKey ? { boardKey } : {}) }));
  }, []);

  const taskRunRecover = useCallback((
    workflowId: string,
    taskId: string,
    runId: string,
    action: 'reclaim' | 'terminate' | 'reassign' | 'fail',
    opts?: { reason?: string; reassignToWorkflowId?: string; staleOnly?: boolean; staleAfterMs?: number; failureLimit?: number; boardKey?: string },
  ) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'task_run_recover',
      workflowId,
      taskId,
      runId,
      action,
      ...(opts?.boardKey ? { boardKey: opts.boardKey } : {}),
      ...(opts?.reason ? { reason: opts.reason } : {}),
      ...(opts?.reassignToWorkflowId ? { reassignToWorkflowId: opts.reassignToWorkflowId } : {}),
      ...(opts?.staleOnly ? { staleOnly: true } : {}),
      ...(typeof opts?.staleAfterMs === 'number' ? { staleAfterMs: opts.staleAfterMs } : {}),
      ...(typeof opts?.failureLimit === 'number' ? { failureLimit: opts.failureLimit } : {}),
    }));
  }, []);

  // §K5 — spin / tear down an isolated git worktree for a task. The server
  // creates the worktree, sets the task's `worktree` field through the ledger
  // mutation path, and re-snapshots (so the field arrives via task_ledger_snapshot).
  const taskWorktreeCreate = useCallback((workflowId: string, id: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'task_worktree_create', workflowId, id }));
  }, []);

  const taskWorktreeRemove = useCallback((workflowId: string, id: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'task_worktree_remove', workflowId, id }));
  }, []);

  // Operator-initiated plan-mode entry. Send-time-fire from the inline
  // composer toggle: emitted immediately before the next user_message so
  // the server's WS dispatch processes them in order — pendingPlanModeEntry
  // is set, then the upcoming turn picks it up. Single-turn arming.
  const armPlanMode = useCallback((workflowId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'enter_plan_mode_request', workflowId }));
  }, []);

  // WORKBENCH_EXPANSION §K1 — operator terminal control plane (seq'd `/ws`).
  // The raw byte stream is a SEPARATE `/terminal` WS connection owned by the
  // floating window; these three only carry session lifecycle + command lines.
  const openTerminal = useCallback((workflowId: string, cwd?: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'terminal_open', workflowId, ...(cwd ? { cwd } : {}) }));
  }, []);

  const killTerminal = useCallback((workflowId: string, sessionId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'terminal_kill', workflowId, sessionId }));
  }, []);

  const logTerminalCommand = useCallback((workflowId: string, sessionId: string, command: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'terminal_command', workflowId, sessionId, command }));
  }, []);

  // §K2 — ask for the live session list (populates the switcher; the server
  // also re-emits it on rehydrate). Reply arrives as terminal_sessions.
  const listTerminalSessions = useCallback((workflowId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'terminal_list', workflowId }));
  }, []);

  // docs/PROTOCOL_CLUSTER.md - cluster surface helpers. Each maps
  // 1-to-1 to a ClientMessage variant; server replies arrive on the
  // existing onmessage switch.
  const createCluster = useCallback((cwd: string, memberWorkflowIds: string[]) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cluster_create', cwd, memberWorkflowIds }));
  }, []);

  const deleteCluster = useCallback((clusterId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cluster_delete', clusterId }));
  }, []);

  const subscribeCluster = useCallback((clusterId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cluster_subscribe', clusterId }));
  }, []);

  const broadcastToCluster = useCallback((
    clusterId: string,
    content: string,
    attachments?: string[],
    clientMessageId?: string,
    recipientWorkflowIds?: string[],
  ) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    // Only include recipientWorkflowIds when it's a non-empty subset; server
    // treats omitted as "all members" (preserves pre-2026-05-11 wire shape).
    const includeRecipients = Array.isArray(recipientWorkflowIds) && recipientWorkflowIds.length > 0;
    wsRef.current.send(JSON.stringify({
      type: 'cluster_broadcast',
      clusterId,
      content,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(includeRecipients ? { recipientWorkflowIds } : {}),
    }));
  }, []);

  // Operator-driven peer_send. Fires from the per-member chat composer to
  // hand a transcript slice (full / last turn / last N turns) to another
  // cluster member. Bypasses model-facing budget + dedupe server-side; cap
  // is 32 KB.
  const operatorPeerSend = useCallback((
    clusterId: string,
    from: string,
    to: string,
    content: string,
  ) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'operator_peer_send',
      clusterId,
      from,
      to,
      content,
    }));
  }, []);

  // Slice 6a — operator renamed a cluster from the Members header. Empty
  // string clears back to derived default. Server validates length + persists.
  const renameCluster = useCallback((clusterId: string, name: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cluster_rename', clusterId, name }));
  }, []);

  // Slice 6a — operator clicked × on a member tab in the bottom row. Server
  // detaches the member and tears down the workflow.
  const removeClusterMember = useCallback((clusterId: string, workflowId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cluster_member_remove', clusterId, workflowId }));
  }, []);

  // Phase 2.5 B2 — operator picked "Add to existing cluster…" from the
  // right-click menu. Server validates (cluster exists, target Native, same
  // cwd, not already in a cluster) then adds.
  const addClusterMember = useCallback((clusterId: string, workflowId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cluster_member_add', clusterId, workflowId }));
  }, []);

  // Phase 2.5 B3 — operator picked "Create cluster with N fresh workers…".
  // Server creates N new workflows (cwd + primary inherited from source) and
  // creates the cluster with source + N new members.
  const createClusterWithFreshWorkers = useCallback((
    sourceWorkflowId: string,
    additionalCount: number,
    opts?: { name?: string; provider?: ClusterMemberProvider; model?: string; effort?: string; providerAccountRef?: string },
  ) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    const name = opts?.name;
    wsRef.current.send(JSON.stringify({
      type: 'cluster_create_with_fresh_workers',
      sourceWorkflowId,
      additionalCount,
      ...(name && name.trim().length > 0 ? { name: name.trim() } : {}),
      // 2026-05-11 — provider/model/effort picker at spawn time. Undefined =
      // server inherits from anchor (legacy behaviour).
      ...(opts?.provider ? { provider: opts.provider } : {}),
      ...(opts?.model ? { model: opts.model } : {}),
      ...(opts?.effort ? { effort: opts.effort } : {}),
      ...(opts?.providerAccountRef ? { providerAccountRef: opts.providerAccountRef } : {}),
    }));
  }, []);

  // 2026-05-11 — operator picked CLUSTER mode in the +NEW WorkflowCreator
  // and submitted. Per-member config (provider/model/effort/role/tier +
  // optional permissions/fast/filter/output-style) is operator-built up
  // front; no source workflow. Server mints N fresh workflows + creates
  // the cluster. Cluster fence applies.
  const createClusterFromScratch = useCallback((payload: {
    cwd: string;
    name?: string;
    efficiencyLevel?: ClusterEfficiencyLevel;
    efficiencyAddendum?: string;
    members: Array<{
      provider: ClusterMemberProvider;
      model: string;
      effort?: string;
      providerAccountRef?: string;
      displayName?: string;
      role?: string;
      tier?: MemberTier;
      focus?: string;
      skipPermissions?: boolean;
      fastMode?: boolean;
      efficiencyToolFilter?: 'off' | 'conservative' | 'aggressive';
      outputStyle?: 'normal' | 'lite' | 'terse';
    }>;
  }) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'cluster_create_from_scratch',
      cwd: payload.cwd,
      ...(payload.name && payload.name.trim().length > 0 ? { name: payload.name.trim() } : {}),
      ...(payload.efficiencyLevel && payload.efficiencyLevel !== 'thorough' ? { efficiencyLevel: payload.efficiencyLevel } : {}),
      ...(payload.efficiencyAddendum && payload.efficiencyAddendum.trim().length > 0 ? { efficiencyAddendum: payload.efficiencyAddendum.trim() } : {}),
      members: payload.members,
    }));
  }, []);

  // Phase 2.5.1 — operator clicked "+ ADD WORKER" inside ClusterRightPanel.
  // Server inherits the cluster's first member's primary config + the
  // cluster's cwd, creates N fresh workflows, adds each to the cluster.
  // 2026-05-11 — optional `opts` triple overrides provider/model/effort on
  // the spawned workers; undefined means inherit-from-template (legacy).
  const addClusterFreshWorkers = useCallback((
    clusterId: string,
    count: number,
    opts?: { provider?: ClusterMemberProvider; model?: string; effort?: string; providerAccountRef?: string; accessMode?: import('@arco/shared').ClusterMemberAccessMode },
  ) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'cluster_add_fresh_workers',
      clusterId,
      count,
      ...(opts?.provider ? { provider: opts.provider } : {}),
      ...(opts?.model ? { model: opts.model } : {}),
      ...(opts?.effort ? { effort: opts.effort } : {}),
      ...(opts?.providerAccountRef ? { providerAccountRef: opts.providerAccountRef } : {}),
      ...(opts?.accessMode ? { accessMode: opts.accessMode } : {}),
    }));
  }, []);

  // Phase 2.6 — operator saved the shared cluster plan from ClusterPlanTab
  // (or PROMOTE TO CLUSTER from a per-workflow PLAN tab). Server caps body
  // at 32768 chars; the UI hard-rejects above that and soft-warns at 28672
  // (bumped from 8 KB / 7 KB on 2026-05-11 — CLUSTER_MODE_PLAN §13).
  const setClusterPlan = useCallback((clusterId: string, body: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cluster_plan_set', clusterId, body }));
  }, []);

  const attachClusterPlan = useCallback((clusterId: string, planId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cluster_plan_attach', clusterId, planId }));
  }, []);

  // Phase 2.6 — operator hit Clear plan in ClusterPlanTab.
  const clearClusterPlan = useCallback((clusterId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cluster_plan_clear', clusterId }));
  }, []);

  // Phase 2.6 — operator edited a member's role hint inline in the
  // Members sub-tab. Empty / whitespace clears.
  const setClusterMemberRole = useCallback((clusterId: string, workflowId: string, role: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cluster_member_role_set', clusterId, workflowId, role }));
  }, []);

  // 2026-05-11 — operator picked a builder-tier pill in the Members
  // sub-tab. `null` clears. Pure metadata: surfaces in peer_list so the
  // cluster director can pick the right capability level. NO server-side
  // routing — the director (an LLM) decides.
  const setClusterMemberTier = useCallback((clusterId: string, workflowId: string, tier: MemberTier | null) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cluster_member_tier_set', clusterId, workflowId, tier }));
  }, []);

  // 2026-05-11 — operator edited focus (sub-specialty) in the Members
  // sub-tab. Empty string or null clears. Free-form ≤MEMBER_FOCUS_MAX.
  // Pure metadata: surfaces in peer_list alongside tier.
  const setClusterMemberFocus = useCallback((clusterId: string, workflowId: string, focus: string | null) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cluster_member_focus_set', clusterId, workflowId, focus }));
  }, []);

  // Phase 5 — operator flipped the idle-nudger chip in the cluster header.
  // Server toggles ClusterState.idleNudgerEnabled + pushes cluster_state.
  const toggleClusterIdleNudger = useCallback((clusterId: string, enabled: boolean) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cluster_idle_nudger_toggle', clusterId, enabled }));
  }, []);

  // Phase 5b — operator flipped the AUTO-PICKUP chip in the cluster header.
  // Server toggles ClusterState.autoTurnOnMailboxEnabled + pushes
  // cluster_state. Same shape as toggleClusterIdleNudger — both arming
  // surfaces sit side-by-side in ClusterRightPanel.
  const toggleClusterAutoTurn = useCallback((clusterId: string, enabled: boolean) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cluster_auto_turn_toggle', clusterId, enabled }));
  }, []);

  const setClusterTaskBoardAttached = useCallback((clusterId: string, attached: boolean) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cluster_task_board_attach_set', clusterId, attached }));
  }, []);

  const setClusterTaskBoardMode = useCallback((clusterId: string, mode: ClusterTaskBoardMode) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cluster_task_board_mode_set', clusterId, mode }));
  }, []);

  // 2026-07-17 — operator drag-reordered the member grid. Sends the full
  // permutation; server validates against current members + rebroadcasts.
  const reorderClusterMembers = useCallback((clusterId: string, memberIds: string[]) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cluster_member_reorder', clusterId, memberIds }));
  }, []);

  // 2026-07-18 (§9.2 follow-up) — operator flipped the cluster's ⛨ GATES chip:
  // one switch arms remote gate approval for every member.
  const setClusterGates = useCallback((clusterId: string, enabled: boolean) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cluster_gates_set', clusterId, enabled }));
  }, []);

  // R3 (docs/REMOTE_MANAGEMENT.md) - operator flipped the cluster's
  // ◉ REMOTE chip. One switch shares the whole cluster (all members) with the
  // management hub; server persists + rebroadcasts + re-pushes the hub snapshot.
  const setClusterAutoCompaction = useCallback((clusterId: string, policy: import('@arco/shared').AutoCompactionPolicy | null) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cluster_auto_compaction_set', clusterId, policy }));
  }, []);

  const setClusterRemote = useCallback((clusterId: string, enabled: boolean) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cluster_remote_set', clusterId, enabled }));
  }, []);

  // 2026-06-15 — operator set the cluster's efficiency level (+ optional
  // doctrine addendum) from the cluster-header chip. Server persists +
  // pushes cluster_state. `addendum === undefined` keeps the current note.
  const setClusterEfficiency = useCallback(
    (clusterId: string, level: ClusterEfficiencyLevel, addendum?: string) => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;
      wsRef.current.send(
        JSON.stringify({
          type: 'cluster_efficiency_set',
          clusterId,
          level,
          ...(addendum !== undefined ? { addendum } : {}),
        }),
      );
    },
    [],
  );

  // 2026-06-29 — operator set the cluster's progress-tracking mode (plan /
  // board / both) from the cluster-header chip. Server persists + pushes
  // cluster_state. Takes effect on each member's NEXT turn.
  const setClusterProgress = useCallback((clusterId: string, mode: ClusterProgressMode) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'cluster_progress_set', clusterId, mode }));
  }, []);

  const dispatchClusterOnce = useCallback((clusterId: string, workflowId: string, maxTasks?: number) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'cluster_dispatch_once',
      clusterId,
      workflowId,
      requestId: crypto.randomUUID(),
      ...(typeof maxTasks === 'number' ? { maxTasks } : {}),
    }));
  }, []);

  const toggleClusterDispatcher = useCallback((clusterId: string, workflowId: string, enabled: boolean) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'cluster_dispatch_toggle',
      clusterId,
      workflowId,
      enabled,
    }));
  }, []);

  const updateClusterDispatcherSettings = useCallback((
    clusterId: string,
    workflowId: string,
    settings: ClusterDispatcherSettingsPatch,
  ) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'cluster_dispatch_settings_update',
      clusterId,
      workflowId,
      settings,
    }));
  }, []);

  const createClusterSwarm = useCallback((
    clusterId: string,
    workflowId: string,
    request: {
      goal: string;
      workerWorkflowIds: string[];
      verifierWorkflowId: string;
      synthesizerWorkflowId: string;
      armDispatch?: boolean;
    },
  ) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'cluster_swarm_create',
      clusterId,
      workflowId,
      requestId: crypto.randomUUID(),
      goal: request.goal,
      workerWorkflowIds: request.workerWorkflowIds,
      verifierWorkflowId: request.verifierWorkflowId,
      synthesizerWorkflowId: request.synthesizerWorkflowId,
      ...(request.armDispatch ? { armDispatch: true } : {}),
    }));
  }, []);

  // docs/PROVIDERS.md - operator clicked "Attach codebase memory"
  // in CONFIG. `indexPath` is operator-typed (defaults to cwd server-side
  // when blank). Server persists to meta.json and pushes a fresh
  // `codebase_memory_state`.
  const attachCodebaseMemory = useCallback((workflowId: string, indexPath?: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    const payload: { type: 'attach_codebase_memory'; workflowId: string; indexPath?: string } = {
      type: 'attach_codebase_memory',
      workflowId,
    };
    if (indexPath && indexPath.trim().length > 0) payload.indexPath = indexPath.trim();
    wsRef.current.send(JSON.stringify(payload));
  }, []);

  const detachCodebaseMemory = useCallback((workflowId: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'detach_codebase_memory', workflowId }));
  }, []);

  // MASTER_REFACTOR §3.3 F5 (2026-05-11) — operator renamed a workflow from
  // the per-member pencil-edit in ClusterRightPanel. Empty string clears
  // back to the wfid-prefix default. Server caps at 64 chars (mirrors
  // cluster_rename).
  const renameWorkflow = useCallback((workflowId: string, name: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'rename_workflow', workflowId, name }));
  }, []);

  // docs/ARCHITECTURE.md - MCP registry. The registry is machine-global;
  // CRUD broadcasts a fresh snapshot to every client. Per-tab enablement +
  // dangerous-tool ticks (mcpWorkflowAllow) and diagnostics (mcpProbe) are
  // workflow-scoped.
  const mcpRegistryList = useCallback(() => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'mcp_registry_list' }));
  }, []);

  const mcpRegistryCreate = useCallback(
    (input: { name: string; command: string; args: string[]; env?: Record<string, string>; enabled?: boolean; overrideMalwareWarning?: boolean }) => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;
      wsRef.current.send(JSON.stringify({ type: 'mcp_registry_create', ...input }));
    },
    [],
  );

  const mcpRegistryUpdate = useCallback(
    (input: { id: string; name?: string; command?: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }) => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;
      wsRef.current.send(JSON.stringify({ type: 'mcp_registry_update', ...input }));
    },
    [],
  );

  const mcpRegistryDelete = useCallback((id: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'mcp_registry_delete', id }));
  }, []);

  const mcpWorkflowAllow = useCallback(
    (workflowId: string, serverId: string, enabled: boolean, allowedDangerousTools: string[], disabledTools?: string[]) => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;
      wsRef.current.send(JSON.stringify({
        type: 'mcp_workflow_allow', workflowId, serverId, enabled, allowedDangerousTools,
        // DD11b — omit when unchanged so the server preserves the existing list.
        ...(disabledTools !== undefined ? { disabledTools } : {}),
      }));
    },
    [],
  );

  const mcpProbe = useCallback((serverId: string, workflowId?: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'mcp_probe', serverId, ...(workflowId ? { workflowId } : {}) }));
  }, []);

  return {
    createWorkflow,
    genesisSeedUpdate,
    genesisScaffold,
    genesisCreativeArm,
    genesisAssistRequest,
    setNotificationMutes,
    sendMessage,
    cancel,
    compactWorkflow,
    foldWorkflow,
    setToolPosture,
    setProjectTrust,
    hubLinkSetEnabled,
    cancelQueuedMessage,
    removeWorkflow,
    listBakeoffs,
    startBakeoff,
    promoteBakeoff,
    cleanupBakeoff,
    requestReview,
    cancelReview,
    requestResearch,
    cancelResearch,
    requestDocEdit,
    requestRecallSummary,
    requestHandoff,
    cancelHandoff,
    clearHandoffLock,
    requestSpawnFromHere,
    updatePrimaryConfig,
    loadEarlierMessages,
    requestRecalibrate,
    attachPlan,
    detachPlan,
    setPreviewPort,
    clearPreviewPort,
    previewCapture,
    taskLedgerCreate,
    taskLedgerUpdate,
    taskLedgerDelete,
    taskLedgerList,
    taskRunRecover,
    taskWorktreeCreate,
    taskWorktreeRemove,
    armPlanMode,
    openTerminal,
    killTerminal,
    logTerminalCommand,
    listTerminalSessions,
    uploadFile,
    createCluster,
    deleteCluster,
    subscribeCluster,
    broadcastToCluster,
    operatorPeerSend,
    renameCluster,
    removeClusterMember,
    addClusterMember,
    createClusterWithFreshWorkers,
    createClusterFromScratch,
    addClusterFreshWorkers,
    setClusterPlan,
    attachClusterPlan,
    clearClusterPlan,
    setClusterMemberRole,
    setClusterMemberTier,
    setClusterMemberFocus,
    toggleClusterIdleNudger,
    setClusterEfficiency,
    setClusterAutoCompaction,
    setClusterRemote,
    setClusterGates,
    reorderClusterMembers,
    setClusterProgress,
    toggleClusterAutoTurn,
    setClusterTaskBoardAttached,
    setClusterTaskBoardMode,
    dispatchClusterOnce,
    toggleClusterDispatcher,
    updateClusterDispatcherSettings,
    createClusterSwarm,
    attachCodebaseMemory,
    detachCodebaseMemory,
    renameWorkflow,
    mcpRegistryList,
    mcpRegistryCreate,
    mcpRegistryUpdate,
    mcpRegistryDelete,
    mcpWorkflowAllow,
    mcpProbe,
    reconnect: reconnectNow,
    reconnectState,
  };
}
