import './components/Home/home.css';
import { HomeView } from './components/Home/HomeView';
import './components/Connections/connections.css';
import './components/workSurface/workSurface.css';
import { parseConnectionStatus } from './components/Connections/model';
import { useConnectionsDeepLinks } from './components/Connections/Connections';
import { useSettingsDeepLinks } from './components/settings/SettingsLayout';
import { useStartupStore } from './stores/startupStore';
import { anyPrimaryProviderConnected, fetchInstallationHistory, startupGate } from './utils/startupGate';
import { ProviderOutageBanner } from './components/ProviderOutageBanner';
import { FirstRun } from './components/FirstRun';
import { VoiceControl } from './components/VoiceControl';
import { ComputerPanel } from './components/ComputerPanel';
import { useComputerStore } from './stores/computerStore';
import { useEffect, useState } from 'react';
import { ThemedBackgroundShader } from './components/ThemedBackgroundShader';
import { SystemHeader } from './components/SystemHeader';
import { StaleBuildBanner } from './components/StaleBuildBanner';
import { TabBar } from './components/TabBar';
import { NotificationToasts } from './components/NotificationToasts';
import { WorkflowCreator } from './components/WorkflowCreator';
import { WorkflowView } from './components/WorkflowView';
import { ChatModeView } from './components/ChatModeView';
import { ClusterTab } from './components/ClusterTab';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ShutdownOverlay } from './components/ShutdownOverlay';
import { SyncingOverlay } from './components/SyncingOverlay';
import { DuplicateTabOverlay } from './components/DuplicateTabOverlay';
import { AuthOverlay } from './components/AuthOverlay';
import { SettingsPanel } from './components/SettingsPanel';
import { UserManual } from './components/UserManual';
import { HelpButton } from './components/help/HelpButton';
import { HelpBanner } from './components/help/HelpBanner';
import { HelpPopover } from './components/help/HelpPopover';
import { HelpCard } from './components/help/HelpCard';
import { DocViewer } from './components/help/DocViewer';
import { useHelpMode } from './help/useHelpMode';
import { DragOverlay } from './components/DragOverlay';
import { ArtifactModal } from './components/ArtifactModal';
import { WorkerDetailModal } from './components/WorkerDetailModal';
import { CompareOverlay } from './components/compare/CompareOverlay';
import { CompareDialogHost } from './components/compare/CompareDialogHost';
import { GitHubPanel } from './components/GitHubPanel';
import { MemoryHud } from './components/dev/MemoryHud';
import { CommandPalette } from './components/CommandPalette';
import { ShortcutCheatSheet } from './components/ShortcutCheatSheet';
import { MediaModalHost } from './components/media/MediaModalHost';
import { RecallView } from './components/Recall/RecallView';
import { FloatingTerminalWindow } from './components/Terminal/FloatingTerminalWindow';
import { useWebSocket } from './hooks/useWebSocket';
import { useTabSingleton } from './hooks/useTabSingleton';
import { useTensionDriver } from './hooks/useTension';
import { installThemeScramble } from './utils/themeScramble';
import { useAppStore } from './stores/appStore';
import type { Capabilities, UsageInfo, CodexUsageInfo, CursorUsageInfo, OllamaLiveStatus, LlamacppLiveStatus, AuthStatusByProvider, ArcoSettings } from '@arco/shared';
import { RESEARCH_DEFAULT_ROUNDS } from '@arco/shared';

const HISTORY_RETRY_MS = 15_000;
const USAGE_POLL_MS = 3 * 60 * 1000;
// Faster cadence than auth so the LIVE/READY swap actually tracks model
// load/unload events. Only runs while ollama is enabled in settings AND
// the auth probe says the daemon is reachable; both gates clear, no poll.
const OLLAMA_LIVE_POLL_MS = 15 * 1000;
// Background re-check of provider auth. Never pauses: it used to stop the
// moment Claude read logged-out, so a single flaky probe left the header chip
// red until clicked. While Claude reads logged-out it re-checks faster so a
// login finished anywhere (terminal, another device) clears the chip.
const AUTH_POLL_MS = 2 * 60 * 1000;
const AUTH_POLL_LOGGED_OUT_MS = 30 * 1000;

export function App() {
  const singleton = useTabSingleton();

  if (singleton === 'checking') return null;
  if (singleton === 'duplicate') return <DuplicateTabOverlay />;

  return <AppBody />;
}

function AppBody() {
  useConnectionsDeepLinks();
  useSettingsDeepLinks();
  useTensionDriver();
  useHelpMode();
  useEffect(() => installThemeScramble(), []);
  // A5 — Cmd/Ctrl+P command palette. App-local transient state (like a modal),
  // not a persisted store flag.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // J4 — Cmd/Ctrl+? keyboard-shortcut cheat sheet. Transient like the palette.
  const [cheatSheetOpen, setCheatSheetOpen] = useState(false);
  const { createWorkflow, genesisSeedUpdate, genesisScaffold, genesisCreativeArm, genesisAssistRequest, sendMessage, cancel, compactWorkflow, cancelQueuedMessage, removeWorkflow, listBakeoffs, startBakeoff, promoteBakeoff, cleanupBakeoff, requestReview, cancelReview, requestResearch, cancelResearch, requestRecallSummary, requestHandoff, cancelHandoff, clearHandoffLock, requestSpawnFromHere, updatePrimaryConfig, foldWorkflow, setToolPosture, setProjectTrust, loadEarlierMessages, requestRecalibrate, attachPlan, detachPlan, setPreviewPort, clearPreviewPort, previewCapture, taskLedgerCreate, taskLedgerUpdate, taskLedgerDelete, taskLedgerList, taskRunRecover, taskWorktreeCreate, taskWorktreeRemove, armPlanMode, openTerminal, killTerminal, logTerminalCommand, listTerminalSessions, uploadFile, createCluster, deleteCluster, subscribeCluster, broadcastToCluster, operatorPeerSend, renameCluster, removeClusterMember, addClusterMember, createClusterWithFreshWorkers, createClusterFromScratch, addClusterFreshWorkers, setClusterPlan, attachClusterPlan, clearClusterPlan, setClusterMemberRole, setClusterMemberTier, setClusterMemberFocus, toggleClusterIdleNudger, toggleClusterAutoTurn, setClusterTaskBoardAttached, setClusterTaskBoardMode, setClusterEfficiency, setClusterRemote, setClusterGates, reorderClusterMembers, setClusterProgress, dispatchClusterOnce, toggleClusterDispatcher, updateClusterDispatcherSettings, createClusterSwarm, attachCodebaseMemory, detachCodebaseMemory, mcpRegistryList, mcpRegistryCreate, mcpRegistryUpdate, mcpRegistryDelete, mcpWorkflowAllow, mcpProbe, setNotificationMutes, hubLinkSetEnabled, reconnect, reconnectState } = useWebSocket();
  const showHome = useAppStore((s) => s.showHome);
  const showCreator = useAppStore((s) => s.showCreator);
  const computerOpen = useComputerStore((s) => s.open);
  const activeJobId = useAppStore((s) => s.activeJobId);
  const activeClusterId = useAppStore((s) => s.activeClusterId);
  const jobs = useAppStore((s) => s.jobs);
  const setCapabilities = useAppStore((s) => s.setCapabilities);
  const setUsage = useAppStore((s) => s.setUsage);
  const setCodexUsage = useAppStore((s) => s.setCodexUsage);
  const setCursorUsage = useAppStore((s) => s.setCursorUsage);
  const authStatus = useAppStore((s) => s.authStatus);
  const setAuthStatus = useAppStore((s) => s.setAuthStatus);
  const setOllamaLive = useAppStore((s) => s.setOllamaLive);
  const setLlamacppLive = useAppStore((s) => s.setLlamacppLive);
  const setClaudeNativeCatalog = useAppStore((s) => s.setClaudeNativeCatalog);
  const setCodexCatalog = useAppStore((s) => s.setCodexCatalog);
  const setCodexCatalogForAccount = useAppStore((s) => s.setCodexCatalogForAccount);
  const setCursorCatalog = useAppStore((s) => s.setCursorCatalog);
  const settings = useAppStore((s) => s.settings);
  const setSettings = useAppStore((s) => s.setSettings);
  const showSettings = useAppStore((s) => s.showSettings);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const showManual = useAppStore((s) => s.showManual);
  const setShowManual = useAppStore((s) => s.setShowManual);
  const showGithub = useAppStore((s) => s.showGithub);
  const showRecall = useAppStore((s) => s.showRecall);
  const setShowRecall = useAppStore((s) => s.setShowRecall);
  // §H1 — Media studio modal host (image viewer + audio/video import playback).
  const mediaStudio = useAppStore((s) => s.mediaStudio);
  const setMediaStudio = useAppStore((s) => s.setMediaStudio);
  const setShutdown = useAppStore((s) => s.setShutdown);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const showJobCreator = useAppStore((s) => s.showJobCreator);
  const updateJobPrimary = useAppStore((s) => s.updateJobPrimary);
  // WS connection state — feeds the refetch-on-reconnect dependency below.
  // The page may load while the server is still starting (or while it's
  // mid-restart), in which case the on-mount HTTP fetches race the listener
  // and fail silently. The WS reconnects on its own; re-keying the fetch
  // effects on `connected` makes settings/capabilities/auth repopulate
  // without a manual page refresh after every Arco restart.
  const connected = useAppStore((s) => s.connected);

  const restartServer = async () => {
    try {
      const res = await fetch('/api/restart', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setShutdown(true, 'server_restarting');
      reconnect();
    } catch (err) {
      const message = `Could not reach Arco over HTTP to restart it (${err instanceof Error ? err.message : String(err)}). Use the launcher once if the server process is fully stopped.`;
      pushNotification('error', message);
      if (shutdown) window.alert(message);
      reconnect();
    }
  };

  // Block the UI with an auth overlay only when EVERY provider is unauthed.
  // The overlay itself polls while it's up; once at least one provider is
  // authed we let the app load (settings panel surfaces the other providers).
  // Also drives the HeaderAuthChip: a slow interval while Claude is logged in,
  // a faster one while it reads logged-out; the chip's re-login flow adds its
  // own fast poll on top.
  // Startup gate. Local runtimes are primary-capable too; a Strata-only
  // installation must not require a cloud login. A provider outage never
  // replaces an established workspace: the full-screen setup appears only
  // when nothing (open tabs or clusters, the server's record of earlier
  // workflows, or a deferral in this tab) says the installation is in use.
  const providerConnected = anyPrimaryProviderConnected(authStatus, (p) => settings?.enabledProviders?.[p] !== false);
  const hasOpenWork = useAppStore((s) => Object.keys(s.jobs).length > 0 || Object.keys(s.clusters).length > 0);
  const workspaceSynced = useStartupStore((s) => s.workspaceSynced);
  const setupDeferred = useStartupStore((s) => s.setupDeferred);
  const setupOpen = useStartupStore((s) => s.setupOpen);
  const firstRunOpen = useStartupStore((s) => s.firstRunOpen);
  const [hasHistory, setHasHistory] = useState<boolean | null>(null);
  // Forget a cached answer once work exists, so a later
  // outage after closing every tab re-asks the server instead of trusting it.
  useEffect(() => {
    if (hasOpenWork) setHasHistory(null);
  }, [hasOpenWork]);
  const needHistory = !!authStatus && !hasOpenWork && hasHistory === null;
  const [historyAttempt, setHistoryAttempt] = useState(0);
  useEffect(() => {
    if (!needHistory) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // An unknown answer (network error, non-2xx, malformed body) keeps the
    // workspace and asks again later; it never reads as a first run.
    void fetchInstallationHistory().then((used) => {
      if (cancelled) return;
      if (used === null) retry = setTimeout(() => setHistoryAttempt((n) => n + 1), HISTORY_RETRY_MS);
      else setHasHistory(used);
    });
    return () => { cancelled = true; if (retry) clearTimeout(retry); };
  }, [needHistory, connected, historyAttempt]);
  const gate = startupGate({ authKnown: !!authStatus && !!settings, providerConnected, setupDeferred, hasOpenWork, hasHistory, workspaceSynced, setupCompleted: settings?.onboardingComplete });
  useEffect(() => {
    if (gate === 'setup') useStartupStore.getState().setFirstRunOpen(true);
  }, [gate]);

  const claudeLoggedIn = authStatus?.claude?.loggedIn ?? null;
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      fetch('/api/auth-status')
        .then(async (r) => parseConnectionStatus(r.ok, await r.json()))
        .then((d) => { if (!cancelled && d) setAuthStatus(d); })
        .catch(() => { /* leave previous value */ });
    };
    // First mount (claudeLoggedIn === null) fetches once; the value landing
    // re-runs this effect, which then schedules the steady poll.
    if (claudeLoggedIn === null) {
      run();
      return () => { cancelled = true; };
    }
    const id = setInterval(run, claudeLoggedIn ? AUTH_POLL_MS : AUTH_POLL_LOGGED_OUT_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [setAuthStatus, claudeLoggedIn, connected]);

  useEffect(() => {
    if (!connected) return;
    fetch('/api/settings')
      .then((r) => r.json() as Promise<ArcoSettings>)
      .then(setSettings)
      .catch(() => { /* fail-open: components treat null settings as all-enabled */ });
  }, [setSettings, connected]);

  // Ollama live-status poll — gated on the operator having ollama enabled
  // in settings AND the auth probe last reporting the daemon up. Either
  // gate fails: clear ollamaLive (so the indicator drops back to DOWN /
  // hidden) and don't fetch. We deliberately don't poll a disabled or
  // unreachable daemon — the user called this out as wasted work.
  const ollamaEnabled = settings?.enabledProviders?.ollama !== false;
  const ollamaDaemonUp = authStatus?.ollama?.loggedIn ?? false;
  const codexEnabled = settings?.enabledProviders?.codex !== false;
  const codexLoggedIn = authStatus?.codex?.loggedIn ?? false;
  const cursorEnabled = settings?.enabledProviders?.cursor !== false;
  const cursorLoggedIn = authStatus?.cursor?.loggedIn ?? false;
  useEffect(() => {
    if (!ollamaEnabled || !ollamaDaemonUp) {
      setOllamaLive(null);
      return;
    }
    let cancelled = false;
    const run = () => {
      fetch('/api/ollama-live')
        .then((r) => r.json() as Promise<OllamaLiveStatus>)
        .then((d) => { if (!cancelled) setOllamaLive(d); })
        .catch(() => { /* leave previous value */ });
    };
    run();
    const id = setInterval(run, OLLAMA_LIVE_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [ollamaEnabled, ollamaDaemonUp, setOllamaLive]);

  // llama.cpp live-status poll. Same gating discipline as Ollama: only
  // poll when the operator has it enabled AND the auth probe last saw the
  // binary on disk. The lifecycle manager ticks the loaded-model state on
  // its own; this just gives the UI a 15s refresh on idle eviction events.
  const llamacppEnabled = settings?.enabledProviders?.llamacpp !== false;
  const llamacppBinaryUp = authStatus?.llamacpp?.loggedIn ?? false;
  useEffect(() => {
    if (!llamacppEnabled || !llamacppBinaryUp) {
      setLlamacppLive(null);
      return;
    }
    let cancelled = false;
    const run = () => {
      fetch('/api/llamacpp-live')
        .then((r) => r.json() as Promise<LlamacppLiveStatus>)
        .then((d) => { if (!cancelled) setLlamacppLive(d); })
        .catch(() => { /* leave previous value */ });
    };
    run();
    const id = setInterval(run, OLLAMA_LIVE_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [llamacppEnabled, llamacppBinaryUp, setLlamacppLive]);

  useEffect(() => {
    if (!connected) return;
    fetch('/api/capabilities')
      .then((r) => r.json() as Promise<Capabilities>)
      .then(setCapabilities)
      .catch(() => { /* keep null; creator falls back to defaults */ });
  }, [setCapabilities, connected]);

  useEffect(() => {
    if (!connected) return;
    // Server caches /v1/models for an hour; this refetches on reconnect
    // and on a 30-min poll so a new Anthropic model surfaces in the
    // picker without a page refresh. Empty `models` (no Native auth yet)
    // is fine — the picker falls back to the static CLAUDE_MODELS list.
    const load = () => {
      fetch('/api/claude-native/catalog')
        .then((r) => r.json())
        .then(setClaudeNativeCatalog)
        .catch(() => { /* keep prior snapshot */ });
    };
    load();
    const id = setInterval(load, 30 * 60 * 1000);
    return () => clearInterval(id);
  }, [setClaudeNativeCatalog, connected]);

  // Comma-joined codex account-profile ids; drives per-profile catalog polling
  // below. A plain string so the effect dep is stable by value.
  const codexAccountKey = (authStatus?.codex?.accountStatuses ?? []).map((a) => a.id).join(',');

  useEffect(() => {
    if (!connected) return;
    // Codex catalog mirror: 30-min client poll, server caches for 1h.
    // Model availability is entitlement-gated per account (HOME vs WORK), so
    // poll each configured profile separately into codexCatalogByAccount. The
    // first (default) account also feeds the plain codexCatalog fallback slice
    // read by account-less picker surfaces. Empty models → picker falls back to
    // the static CODEX_MODELS list.
    const ids = codexAccountKey ? codexAccountKey.split(',') : [];
    const load = () => {
      if (ids.length === 0) {
        // No account profiles configured → ambient ~/.codex default.
        fetch('/api/codex/catalog')
          .then((r) => r.json())
          .then(setCodexCatalog)
          .catch(() => { /* keep prior snapshot */ });
        return;
      }
      ids.forEach((id, idx) => {
        fetch(`/api/codex/catalog?account=${encodeURIComponent(id)}`)
          .then((r) => r.json())
          .then((snap) => {
            setCodexCatalogForAccount(id, snap);
            if (idx === 0) setCodexCatalog(snap);
          })
          .catch(() => { /* keep prior snapshot */ });
      });
    };
    load();
    const id = setInterval(load, 30 * 60 * 1000);
    return () => clearInterval(id);
  }, [connected, codexAccountKey, setCodexCatalog, setCodexCatalogForAccount]);

  useEffect(() => {
    if (!connected) return;
    // Cursor catalog mirror: 30-min client poll, server caches for 1h.
    // Empty models → picker falls back to a static `auto`-only seed.
    const load = () => {
      fetch('/api/cursor/catalog')
        .then((r) => r.json())
        .then(setCursorCatalog)
        .catch(() => { /* keep prior snapshot */ });
    };
    load();
    const id = setInterval(load, 30 * 60 * 1000);
    return () => clearInterval(id);
  }, [setCursorCatalog, connected]);

  useEffect(() => {
    if (!connected) return;
    const load = () => {
      fetch('/api/usage')
        .then((r) => r.json() as Promise<UsageInfo>)
        .then(setUsage)
        .catch(() => { /* leave previous value */ });
    };
    load();
    const id = setInterval(load, USAGE_POLL_MS);
    return () => clearInterval(id);
  }, [setUsage, connected]);

  useEffect(() => {
    if (!codexEnabled || !codexLoggedIn) {
      setCodexUsage({
        available: false,
        fetchedAt: Date.now(),
        source: 'disabled',
        analyticsUrl: 'https://chatgpt.com/settings/usage?tab=overview',
        error: codexEnabled ? 'Codex is not authenticated.' : 'Codex provider is disabled.',
      });
      return;
    }
    const load = () => {
      fetch('/api/codex-usage')
        .then((r) => r.json() as Promise<CodexUsageInfo>)
        .then(setCodexUsage)
        .catch(() => { /* leave previous value */ });
    };
    load();
    const id = setInterval(load, USAGE_POLL_MS);
    return () => clearInterval(id);
  }, [codexEnabled, codexLoggedIn, setCodexUsage]);

  // Cursor usage is POLLED from the authed dashboard API (ACP carries no
  // per-turn tokens), so — unlike the other providers — it never flows through
  // primary_turn_token_usage. The Usage-tab card reads this store field; the
  // header dot stays live-status-only.
  useEffect(() => {
    if (!cursorEnabled || !cursorLoggedIn) {
      setCursorUsage({
        available: false,
        fetchedAt: Date.now(),
        source: 'disabled',
        dashboardUrl: 'https://cursor.com/dashboard?tab=usage',
        ...(cursorEnabled ? { needsLogin: true } : {}),
        error: cursorEnabled ? 'Cursor is not authenticated.' : 'Cursor provider is disabled.',
      });
      return;
    }
    const load = () => {
      fetch('/api/cursor-usage')
        .then((r) => r.json() as Promise<CursorUsageInfo>)
        .then(setCursorUsage)
        .catch(() => { /* leave previous value */ });
    };
    load();
    const id = setInterval(load, USAGE_POLL_MS);
    return () => clearInterval(id);
  }, [cursorEnabled, cursorLoggedIn, setCursorUsage]);

  const shutdown = useAppStore((s) => s.shutdown);
  // Slot 2 — SYNCING overlay fires when the socket is up but at least one
  // persisted job is still waiting for its reconnect snapshot. A brand-new
  // client with no persisted jobs skips the overlay entirely (createJob
  // marks new workflows snapshotReceived=true).
  const syncing = useAppStore((s) => s.connected && Object.values(s.jobs).some((j) => !j.snapshotReceived));

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.key === 'k' && (e.ctrlKey || e.metaKey))) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      showJobCreator();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showJobCreator]);

  // A5 — Cmd/Ctrl+P opens the command palette. P is the browser Print
  // accelerator, so preventDefault() is load-bearing (without it the OS print
  // dialog steals the keystroke). Unlike Ctrl+K, this fires even when focus is
  // in the composer textarea — the palette is a global nav surface and the
  // operator shouldn't have to click out of the composer first. The palette
  // toggles (a second Ctrl+P closes it) so the keystroke is reversible.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.key === 'p' && (e.ctrlKey || e.metaKey))) return;
      e.preventDefault();
      setPaletteOpen((open) => !open);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // J4 — Cmd/Ctrl+? opens the keyboard-shortcut cheat sheet. `?` is Shift+/,
  // so matching e.key === '?' already accounts for Shift. preventDefault()
  // keeps the modifier+? from doing anything stray. Like the palette it's a
  // global nav surface, so it fires regardless of focus (the modifier means
  // it never inserts a character) and toggles (a second press closes it).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.key === '?' && (e.ctrlKey || e.metaKey))) return;
      e.preventDefault();
      setCheatSheetOpen((open) => !open);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // J4 — the CommandPalette "Keyboard shortcuts" command dispatches this so
  // mouse-only discovery opens the same cheat sheet the hotkey toggles.
  useEffect(() => {
    const onOpen = () => setCheatSheetOpen(true);
    window.addEventListener('arco:open-shortcuts', onOpen);
    return () => window.removeEventListener('arco:open-shortcuts', onOpen);
  }, []);

  const activeJob = activeJobId ? jobs[activeJobId] : undefined;

  // Resolve the cluster a workflow belongs to (if any). Used by the
  // PlanCandidateBanner cluster shortcut, the BACK TO CLUSTER button, and
  // the per-tab PROMOTE TO CLUSTER. Subscribes via the store so the result
  // updates if membership changes mid-session.
  const clusters = useAppStore((s) => s.clusters);
  const activeClusterIdForWorkflow = (wfid: string): string | null => {
    for (const c of Object.values(clusters)) {
      if (c.members.some((m) => m.workflowId === wfid)) return c.clusterId;
    }
    return null;
  };

  // Build the body of a cluster-routed review task. Returns the peer-message
  // content the operator's `→ Review via member` flow sends to the chosen
  // reviewer member. The reviewer sees the actual content to review (sliced
  // from the target's chat or plan) plus a clear directive on what to
  // produce. Falls back to null if the target job isn't hydrated or the
  // scope can't be peer-routed (git-diff). The dialog's picker already
  // disables git-diff for member routing, so null here is defensive only.
  const buildClusterReviewTask = (
    targetWfid: string,
    contextRef: import('@arco/shared').ReviewContextRef,
    includeGitDiff: boolean,
  ): string | null => {
    const store = useAppStore.getState();
    const targetJob = store.jobs[targetWfid];
    if (!targetJob) return null;
    const targetName = (() => {
      const cid = activeClusterIdForWorkflow(targetWfid);
      if (!cid) return targetWfid.slice(0, 8);
      const cluster = store.clusters[cid];
      const m = cluster?.members.find((mm) => mm.workflowId === targetWfid);
      return m?.displayName ?? targetWfid.slice(0, 8);
    })();
    const formatMessage = (m: import('@arco/shared').ChatMessage): string | null => {
      if (m.role === 'ctx-divider' || m.toolUse) return null;
      if (m.role === 'system') {
        // Strip pure-metadata pills; keep substantive system content (inlined
        // review bodies, etc.) so the reviewer sees prior context.
        const trimmed = m.content.trim();
        if (/^\[[^\]]+\][^\n]*$/.test(trimmed) && trimmed.length < 200) return null;
        return `[system] ${m.content}`;
      }
      if (m.role === 'peer-sent') return `[peer-sent → ${m.senderDisplayName ?? '?'}] ${m.content}`;
      if (m.role === 'peer-received') return `[peer-received ← ${m.senderDisplayName ?? '?'}] ${m.content}`;
      if (m.role === 'user') return `[operator → ${targetName}]\n${m.content}`;
      return `[${targetName}]\n${m.content}`;
    };
    const sliceTranscript = (n: number): string => {
      // Walk back N user-message-anchored turns. "Last turn" is N=1.
      const idxs: number[] = [];
      for (let i = 0; i < targetJob.messages.length; i++) {
        if (targetJob.messages[i].role === 'user') idxs.push(i);
      }
      if (idxs.length === 0) return targetJob.messages.map(formatMessage).filter((s): s is string => !!s).join('\n\n');
      const start = idxs[Math.max(0, idxs.length - n)];
      return targetJob.messages.slice(start).map(formatMessage).filter((s): s is string => !!s).join('\n\n');
    };
    let scopeLabel = '';
    let scopeBody = '';
    switch (contextRef.kind) {
      case 'last-turn':
        scopeLabel = 'last turn';
        scopeBody = sliceTranscript(1);
        break;
      case 'last-n':
        scopeLabel = `last ${contextRef.n} turns`;
        scopeBody = sliceTranscript(contextRef.n);
        break;
      case 'current-session':
      case 'full':
        scopeLabel = 'full transcript';
        scopeBody = targetJob.messages.map(formatMessage).filter((s): s is string => !!s).join('\n\n');
        break;
      case 'since-event':
        scopeLabel = 'transcript since checkpoint';
        scopeBody = targetJob.messages.map(formatMessage).filter((s): s is string => !!s).join('\n\n');
        break;
      case 'plan-whole':
      case 'plan-phase':
      case 'plan-items':
      case 'cluster-plan-whole':
      case 'cluster-plan-phase': {
        // Plan scopes — prefer the cluster plan body (in-store) since that's
        // the cluster-wide source of truth. Worker plan bodies live on disk
        // and aren't in client state; fall back to a placeholder if neither
        // is available. Operator can use sub-worker for richer plan reviews.
        const mode = 'mode' in contextRef ? contextRef.mode : 'verify';
        scopeLabel = mode === 'verify' ? 'plan (VERIFY WORK)' : 'plan (CRITIQUE PLAN)';
        const cid = activeClusterIdForWorkflow(targetWfid);
        const cluster = cid ? store.clusters[cid] : null;
        scopeBody = cluster?.plan?.body ?? '(plan body not available in this flow — use sub-worker reviewer for plan-scoped reviews)';
        break;
      }
      case 'git-diff':
        return null;
    }
    const diffNote = includeGitDiff
      ? '\n\nThe operator also asked you to run `git diff HEAD` in the cluster cwd and factor those changes in.'
      : '';
    // Mode-specific instructions. Plan reviews split into VERIFY (check
    // claimed-done items against actual code) vs CRITIQUE (evaluate plan
    // structure/gaps). Transcript-scoped reviews use a generic frame.
    const isPlanScope = 'mode' in contextRef;
    const planMode = isPlanScope ? contextRef.mode : null;
    let instructionsBlock: string;
    if (planMode === 'verify') {
      instructionsBlock = `**This is a VERIFY WORK review.** The plan below lists items marked complete (\`[x]\`). For each completed item, verify the claim against the actual code in the repository at the cluster's cwd. Use Read/Grep/Glob/Bash tools as needed. Do NOT critique the plan structure — only verify whether the claimed work was actually done.

**Output:**
- A verdict: PASS (all claims confirmed) / MINOR (small gaps) / BLOCKING (significant unfinished work claimed done)
- For each completed item: confirmed / partial (what's missing) / missing (claim not backed by code)
- File path + line refs for each finding`;
    } else if (planMode === 'critique') {
      instructionsBlock = `**This is a CRITIQUE PLAN review.** The plan below shows every item with its check state preserved. Evaluate the plan itself — its structure, ordering, completeness, missing considerations, unclear scope, risky assumptions. Do NOT verify whether claimed work is done; that's a different review.

**Output:**
- A verdict: PASS (plan is solid) / MINOR (small gaps or sequencing tweaks) / BLOCKING (major gaps, risks, or unclear scope)
- Specific findings: gaps, ordering issues, missing considerations, ambiguous items
- Concrete recommendations for plan edits`;
    } else {
      instructionsBlock = `**Expected output:**
- A verdict: PASS / MINOR / BLOCKING
- Specific findings with file paths or section refs
- Recommendation for next step`;
    }
    return `# Review request from operator

Please review the ${scopeLabel} content provided below.

${instructionsBlock}

Produce your full review inline in your reply. Do NOT send it to any peer — the operator will decide who needs the findings.${diffNote}

---

## Content to review (${scopeLabel})

${scopeBody}
`;
  };

  if (shutdown) {
    return <ShutdownOverlay onReconnect={reconnect} onRestartServer={restartServer} />;
  }

  // Local runtimes are primary-capable too; a Strata-only installation must
  // not require a cloud login to get past the startup gate.
  if (firstRunOpen || gate === 'setup') {
    // Settings panel sits on top of the overlay so the operator can re-enable
    // a disabled provider from inside the gate.
    return (
      <>
        <FirstRun />
        {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
        {showManual && <UserManual onClose={() => setShowManual(false)} />}
        <HelpBanner />
        <HelpButton />
        <HelpPopover />
        <HelpCard />
        <DocViewer />
      </>
    );
  }

  return (
    <div
      style={{
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      }}
    >
      <ThemedBackgroundShader />

      <div
        style={{
          position: 'relative',
          zIndex: 5,
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
        }}
      >
        <ErrorBoundary label="shell">
        <StaleBuildBanner />
        {authStatus && !providerConnected && !showHome && <ProviderOutageBanner />}
        <SystemHeader isHome={showHome && !showGithub} onReconnect={reconnect} onRestartServer={restartServer} reconnectState={reconnectState} onSetPreviewPort={setPreviewPort} onSetNotificationMutes={setNotificationMutes} onHubLinkToggle={hubLinkSetEnabled} />
        <TabBar
          onRemoveWorkflow={removeWorkflow}
          onCreateCluster={createCluster}
          onDeleteCluster={deleteCluster}
          onAddClusterMember={addClusterMember}
          onCreateClusterWithFreshWorkers={createClusterWithFreshWorkers}
        />
        <VoiceControl sendMessage={sendMessage} cancel={cancel} createWorkflow={createWorkflow} />

        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <ErrorBoundary key={showHome && !showGithub ? 'home' : activeClusterId ?? activeJob?.id ?? (showGithub ? 'github' : 'creator')}>
          {showGithub ? (
            <GitHubPanel />
          ) : showHome ? (
            <HomeView onResume={createWorkflow} />
          ) : activeClusterId ? (
            <ClusterTab
              key={activeClusterId}
              clusterId={activeClusterId}
              onSendToMember={(workflowId, content, attachments, kind) => sendMessage(workflowId, content, attachments, kind)}
              onCancelMember={(workflowId) => cancel(workflowId)}
              onCancelQueuedForMember={(workflowId, clientMessageId) => cancelQueuedMessage(workflowId, clientMessageId)}
              onUpload={uploadFile}
              onLoadEarlier={(workflowId) => loadEarlierMessages(workflowId)}
              onBroadcast={broadcastToCluster}
              onSubscribe={subscribeCluster}
              onRenameCluster={renameCluster}
              onAddFreshWorkers={addClusterFreshWorkers}
              onAddExistingMember={addClusterMember}
              onSetClusterPlan={setClusterPlan}
              onAttachClusterPlan={attachClusterPlan}
              onClearClusterPlan={clearClusterPlan}
              onSetMemberRole={setClusterMemberRole}
              onSetMemberTier={setClusterMemberTier}
              onSetMemberFocus={setClusterMemberFocus}
              onDetachMember={removeClusterMember}
              onToggleIdleNudger={toggleClusterIdleNudger}
              onToggleAutoTurn={toggleClusterAutoTurn}
              onSetTaskBoardAttached={setClusterTaskBoardAttached}
              onSetTaskBoardMode={setClusterTaskBoardMode}
              onSetEfficiency={setClusterEfficiency}
              onSetRemote={setClusterRemote}
              onSetGates={setClusterGates}
              onReorderMembers={reorderClusterMembers}
              onSetProgress={setClusterProgress}
              onDispatchOnce={dispatchClusterOnce}
              onToggleDispatcher={toggleClusterDispatcher}
              onUpdateDispatcherSettings={updateClusterDispatcherSettings}
              onCreateSwarm={createClusterSwarm}
              onUpdateTaskStatus={(workflowId, taskId, status, boardKey) =>
                taskLedgerUpdate(workflowId, taskId, { status, ...(boardKey ? { boardKey } : {}) })
              }
              onReassignTask={(workflowId, taskId, assigneeWorkflowId, boardKey) =>
                taskLedgerUpdate(workflowId, taskId, { assignee: assigneeWorkflowId ?? '', ...(boardKey ? { boardKey } : {}) })
              }
              onReclaimRun={(_clusterId, workflowId, taskId, runId, boardKey) =>
                taskRunRecover(workflowId, taskId, runId, 'reclaim', {
                  reason: 'operator reclaimed stale run',
                  staleOnly: true,
                  staleAfterMs: 5 * 60 * 1000,
                  ...(boardKey ? { boardKey } : {}),
                })
              }
              onTerminateRun={(_clusterId, workflowId, taskId, runId, boardKey) =>
                taskRunRecover(workflowId, taskId, runId, 'terminate', {
                  reason: 'operator terminated run',
                  ...(boardKey ? { boardKey } : {}),
                })
              }
              onReviewMember={(workflowId, reviewer, contextRef, includeGitDiff) =>
                requestReview(workflowId, reviewer, contextRef, includeGitDiff)
              }
              onCancelMemberReview={(workflowId, reviewId) => cancelReview(workflowId, reviewId)}
              onCancelMemberHandoff={(workflowId, handoffId) => cancelHandoff(workflowId, handoffId)}
              onClearMemberHandoffLock={clearHandoffLock}
              onHandoffMember={(workflowId, mode, newPrimary, summarizer) => {
                if (newPrimary) updateJobPrimary(workflowId, newPrimary);
                requestHandoff(workflowId, mode, summarizer, newPrimary);
              }}
              onSpawnMember={(workflowId, newConfig, newDirection, includePlan, joinClusterId) =>
                requestSpawnFromHere(workflowId, newConfig, newDirection, includePlan, undefined, undefined, joinClusterId)
              }
              onCompactMember={(workflowId) => compactWorkflow(workflowId)}
              onRecalibrateMember={(workflowId) => requestRecalibrate(workflowId)}
              onUpdateMemberPrimary={(workflowId, update) => {
                updateJobPrimary(workflowId, update);
                updatePrimaryConfig(workflowId, update);
              }}
              onAttachCodebaseMemory={attachCodebaseMemory}
              onDetachCodebaseMemory={detachCodebaseMemory}
              mcp={{
                list: mcpRegistryList,
                create: mcpRegistryCreate,
                update: mcpRegistryUpdate,
                remove: mcpRegistryDelete,
                allow: mcpWorkflowAllow,
                probe: mcpProbe,
              }}
              onArmPlanModeMember={(workflowId) => armPlanMode(workflowId)}
              onSpawnFromCluster={(sourceWorkflowId, newConfig, newDirection, includePlan, joinClusterId) =>
                requestSpawnFromHere(sourceWorkflowId, newConfig, newDirection, includePlan, undefined, undefined, joinClusterId)
              }
              onTranscriptSendFromMember={(clusterId, fromWorkflowId, toWorkflowId, content) =>
                operatorPeerSend(clusterId, fromWorkflowId, toWorkflowId, content)
              }
              onReviewViaMember={(targetWfid, reviewerWfid, contextRef, includeGitDiff) => {
                const cid = activeClusterIdForWorkflow(targetWfid);
                if (!cid) return;
                const content = buildClusterReviewTask(targetWfid, contextRef, includeGitDiff);
                if (!content) return;
                // Dispatch as a real user message so the reviewer starts a
                // turn immediately. peer_send was wrong here — it stuffs the
                // mailbox without waking the worker; with auto-pickup off the
                // task would sit forever. The reviewer's chat shows the task
                // as an operator-authored message and the response streams
                // into their chat + activity normally.
                sendMessage(reviewerWfid, content);
              }}
              onAttachPlanToMember={(workflowId, planId) => attachPlan(workflowId, planId)}
            />
          ) : showCreator || !activeJob ? (
            <WorkflowCreator
              onCreate={createWorkflow}
              onCreateCluster={createClusterFromScratch}
              onReopenCluster={(clusterId) => {
                subscribeCluster(clusterId);
                useAppStore.getState().setActiveCluster(clusterId);
              }}
            />
          ) : activeJob.config.kind === 'chat' ? (
            <ChatModeView
              key={activeJob.id}
              job={activeJob}
              onSend={(content, attachments) => sendMessage(activeJob.id, content, attachments)}
              onCancel={() => cancel(activeJob.id)}
              onLoadEarlier={() => loadEarlierMessages(activeJob.id)}
              onUpload={uploadFile}
              onUpdatePrimary={(update) => {
                // Same optimistic-then-persist shape the workbench CONFIG tab
                // uses; the chat header is just a smaller surface onto it.
                updateJobPrimary(activeJob.id, update);
                updatePrimaryConfig(activeJob.id, update);
              }}
            />
          ) : (
            <WorkflowView
              key={activeJob.id}
              job={activeJob}
              onSend={(content, attachments, kind, primitive, pickedSkills) => sendMessage(activeJob.id, content, attachments, kind, primitive, pickedSkills)}
              onCancel={() => cancel(activeJob.id)}
              onCompact={() => compactWorkflow(activeJob.id)}
              onFold={(engine) => foldWorkflow(activeJob.id, engine)}
              onSetToolPosture={(posture) => setToolPosture(activeJob.id, posture)}
              onSetProjectTrust={(cwd, decision) => setProjectTrust(activeJob.id, cwd, decision)}
              onCancelQueued={(clientMessageId) => cancelQueuedMessage(activeJob.id, clientMessageId)}
              onUpload={uploadFile}
              onReview={(reviewer, contextRef, includeGitDiff) => requestReview(activeJob.id, reviewer, contextRef, includeGitDiff)}
              onCancelReview={(reviewId) => cancelReview(activeJob.id, reviewId)}
              onCancelHandoff={(handoffId) => cancelHandoff(activeJob.id, handoffId)}
              onClearHandoffLock={clearHandoffLock}
              onHandoff={(mode, newPrimary, summarizer) => {
                if (newPrimary) updateJobPrimary(activeJob.id, newPrimary);
                requestHandoff(activeJob.id, mode, summarizer, newPrimary);
              }}
              onSpawn={(newConfig, newDirection, includePlan) => requestSpawnFromHere(activeJob.id, newConfig, newDirection, includePlan)}
              onResearch={(researcher, topic, maxRounds, spawnConfig) => {
                if (spawnConfig) {
                  // New-tab path: TerminalInput already registered the pending
                  // research keyed by spawnConfig.researchSpawnToken; create the
                  // tab and the WS workflow_created handler fires the request.
                  createWorkflow(spawnConfig);
                } else {
                  requestResearch(activeJob.id, researcher, topic, maxRounds);
                }
              }}
              onCancelResearch={(researchId) => cancelResearch(activeJob.id, researchId)}
              onResearchFollowUp={(seedArtifactName, followUp) =>
                requestResearch(
                  activeJob.id,
                  {
                    provider: (activeJob.config.primaryProvider ?? 'claude'),
                    model: activeJob.config.primaryModel,
                    effort: activeJob.config.primaryEffort,
                    providerAccountRef: activeJob.config.providerAccountRef,
                  },
                  '',
                  // Dig-deeper is intentionally a small bounded mini-round.
                  Math.min(2, RESEARCH_DEFAULT_ROUNDS),
                  { seedArtifactName, followUp },
                )
              }
              onTaskLedgerCreate={(workflowId, title, notes) => taskLedgerCreate(workflowId, title, notes)}
              onTaskLedgerUpdate={(workflowId, id, patch) => taskLedgerUpdate(workflowId, id, patch)}
              onTaskLedgerDelete={(workflowId, id) => taskLedgerDelete(workflowId, id)}
              onTaskLedgerList={(workflowId) => taskLedgerList(workflowId)}
              onTaskWorktreeCreate={(workflowId, id) => taskWorktreeCreate(workflowId, id)}
              onTaskWorktreeRemove={(workflowId, id) => taskWorktreeRemove(workflowId, id)}
              onBakeoffList={listBakeoffs}
              onBakeoffStart={startBakeoff}
              onBakeoffPromote={promoteBakeoff}
              onBakeoffCleanup={cleanupBakeoff}
              onGenesisSeedUpdate={genesisSeedUpdate}
              onGenesisScaffold={genesisScaffold}
              onGenesisCreativeArm={genesisCreativeArm}
              onGenesisAssistRequest={genesisAssistRequest}
              mcp={{
                list: mcpRegistryList,
                create: mcpRegistryCreate,
                update: mcpRegistryUpdate,
                remove: mcpRegistryDelete,
                allow: mcpWorkflowAllow,
                probe: mcpProbe,
              }}
              onUpdatePrimary={(update) => {
                // Optimistic local update, then WS notifies server to persist.
                updateJobPrimary(activeJob.id, update);
                updatePrimaryConfig(activeJob.id, update);
              }}
              onLoadEarlier={() => loadEarlierMessages(activeJob.id)}
              onRecalibrate={() => requestRecalibrate(activeJob.id)}

              onAttachPlan={(planId) => attachPlan(activeJob.id, planId)}
              onDetachPlan={() => detachPlan(activeJob.id)}
              onAttachPlanToCluster={(() => {
                // The banner only renders ATTACH TO CLUSTER when this prop is
                // defined — so resolve the cluster up front and pass undefined
                // for non-members. Avoids a click-time re-search and keeps the
                // button hidden for solo workflows.
                const cid = activeClusterIdForWorkflow(activeJob.id);
                if (!cid) return undefined;
                return (body: string) => setClusterPlan(cid, body);
              })()}
              onBackToCluster={(() => {
                const cid = activeClusterIdForWorkflow(activeJob.id);
                if (!cid) return undefined;
                return () => useAppStore.getState().setActiveCluster(cid);
              })()}
              onPromoteToCluster={(body) => {
                // Phase 2.6 — resolve the cluster this workflow belongs to.
                // PlanTab only renders the button when membership is real,
                // but the store is the source of truth at click time.
                const cid = activeClusterIdForWorkflow(activeJob.id);
                if (!cid) return;
                setClusterPlan(cid, body);
                // After promotion, detach the worker's local plan so the
                // cluster plan is the single source of truth. Without this,
                // the per-tab `.arco/plans/<planId>.md` file lingers as a
                // snapshot and Read tools see a stale version after
                // cluster_plan_tick updates the cluster plan body — the
                // exact confusion the operator hit on 2026-05-11.
                detachPlan(activeJob.id);
              }}
              onSetPreviewPort={(port, framework) => setPreviewPort(activeJob.id, port, framework)}
              onClearPreviewPort={() => clearPreviewPort(activeJob.id)}
              onPreviewCapture={(captures, viewport) => previewCapture(activeJob.id, captures, viewport)}
              onReviewCapture={(reportName) =>
                requestReview(
                  activeJob.id,
                  {
                    provider: activeJob.config.primaryProvider ?? 'claude',
                    model: activeJob.config.primaryModel,
                    effort: activeJob.config.primaryEffort,
                    ...(activeJob.config.providerAccountRef ? { providerAccountRef: activeJob.config.providerAccountRef } : {}),
                  },
                  { kind: 'preview-capture', reportName },
                )
              }
              onArmPlanMode={() => armPlanMode(activeJob.id)}
              onAttachCodebaseMemory={attachCodebaseMemory}
              onDetachCodebaseMemory={detachCodebaseMemory}
              onTranscriptSend={(() => {
                const cid = activeClusterIdForWorkflow(activeJob.id);
                if (!cid) return undefined;
                return (toWorkflowId: string, content: string) =>
                  operatorPeerSend(cid, activeJob.id, toWorkflowId, content);
              })()}
            />
          )}
          </ErrorBoundary>
        </div>
        </ErrorBoundary>
      </div>

      {computerOpen && <ComputerPanel onLoadEarlier={loadEarlierMessages} onCancel={cancel} onSend={sendMessage} />}
      {setupOpen && <AuthOverlay mode="dialog" />}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {showManual && <UserManual onClose={() => setShowManual(false)} />}
      <HelpBanner />
      <HelpButton />
      <HelpPopover />
      <HelpCard />
      <DocViewer />
      <DragOverlay />
      <NotificationToasts />
      <ArtifactModal onRespond={(workflowId, content) => sendMessage(workflowId, content)} />
      <WorkerDetailModal />
      <CompareDialogHost />
      <CompareOverlay />
      {syncing && <SyncingOverlay />}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      {cheatSheetOpen && <ShortcutCheatSheet onClose={() => setCheatSheetOpen(false)} />}
      {mediaStudio.open && (
        <MediaModalHost
          initialPath={mediaStudio.path}
          initialMode={mediaStudio.mode}
          initialEditing={mediaStudio.edit}
          onClose={() => setMediaStudio({ open: false })}
          // Thread the file's workflow so the on-disk image fetch resolves a
          // relative path against the right cwd (+ artifacts-dir fallback, same
          // as FileViewerModal). A launcher-pinned context (e.g. an artifact
          // from a background tab) wins over the active tab.
          fileContext={mediaStudio.context ?? (activeJob ? { cwd: activeJob.config.workingDirectory, workflowId: activeJob.id } : undefined)}
          // H6 — Reveal a freshly-written op output in the Files panel. The
          // RightPanel listens for this event + flips to FILES for the workflow;
          // we close the modal so the panel is visible.
          onRevealInFiles={() => {
            if (activeJob) {
              window.dispatchEvent(new CustomEvent('arco:reveal-in-files', { detail: { workflowId: activeJob.id } }));
            }
            setMediaStudio({ open: false });
          }}
        />
      )}
      {showRecall && <RecallView onClose={() => setShowRecall(false)} requestRecallSummary={requestRecallSummary} />}
      <FloatingTerminalWindow
        openTerminal={openTerminal}
        killTerminal={killTerminal}
        logTerminalCommand={logTerminalCommand}
        listTerminalSessions={listTerminalSessions}
      />
      <MemoryHud />
    </div>
  );
}
