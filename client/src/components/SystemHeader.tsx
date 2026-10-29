import { hasEnabledUsageProvider } from './usageVisibility';
import { useStartupStore } from '../stores/startupStore';
import { VoiceButton } from './VoiceControl';
import { headerActionStyle as actionBtn } from './headerActionStyle';
import { FreeVramButton } from './FreeVramButton';
import { useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { useComputerStore } from '../stores/computerStore';
import { useTerminalStore } from '../stores/terminalStore';
import { useTerminalTarget } from '../hooks/useTerminalTarget';
import { UsageBar } from './UsageBar';
import { WorkflowStatusChip } from './WorkflowStatusChip';
import { ProvidersPopover } from './ProvidersPopover';
import { HeaderDropdown, type HeaderMenuItem } from './HeaderDropdown';
import { SystemModal } from './SystemModal';
import { CookbookModal } from './Cookbook/CookbookModal';
import { useCookbookStore } from '../stores/cookbookStore';
import { openMediaStudio } from './media/launchers';
import { openArchive } from '../explorer/launch';
import { HeaderAuthChip } from './HeaderAuthChip';
import { NotificationCenter } from './NotificationCenter';
import { HubLinkChip } from './HubLinkChip';
import { StatusLight } from './primitives/StatusLight';
import type { WorkbenchNoticeCategory } from '@arco/shared';

interface Props {
  isHome: boolean;
  onReconnect: () => void;
  onRestartServer: () => void;
  reconnectState?: { attempting: boolean; nextAttemptIn: number };
  // L3 — raw 3-arg set_preview_port dispatch threaded down to ServicesTab's
  // "Open in Live Preview". Not pre-bound to a workflow: ServicesTab supplies
  // the focused workflow id at click time.
  onSetPreviewPort: (workflowId: string, port: number, framework?: string) => void;
  // §J1 — replace the muted notification-category set (persisted server-side).
  onSetNotificationMutes: (muted: WorkbenchNoticeCategory[]) => void;
  // Management-hub link kill switch / reconnect (header indicator).
  onHubLinkToggle: (enabled: boolean) => void;
}

// Thin vertical rule separating header action groups. Purely presentational —
// the grouping is the information-architecture win (I1), the rule just makes it
// legible without boxing every group.
function GroupDivider() {
  return <span aria-hidden style={{ width: '1px', height: '16px', background: 'var(--color-border-hairline)', opacity: 0.6, flexShrink: 0 }} />;
}

export function SystemHeader({ isHome, onReconnect, onRestartServer, reconnectState, onSetPreviewPort, onSetNotificationMutes, onHubLinkToggle }: Props) {
  const connected = useAppStore((s) => s.connected);
  const computerOpen = useComputerStore((s) => s.open);
  const setComputerOpen = useComputerStore((s) => s.setOpen);
  // §C1 — richer overlay distinguishing a browser/network WS drop ('disconnected',
  // server alive → RECONNECT/RESTART helps) from a dead server process
  // ('server-down' → RESTART won't help until the process is back). StatusLight
  // stays critical for both; only the label + tooltip differ so the operator
  // knows which failure they're in.
  const connectionState = useAppStore((s) => s.connectionState);
  const serverDown = connectionState === 'server-down';
  // Slot 2 — surfaces the interstitial state between OFFLINE and ONLINE where
  // the socket is up but the server hasn't yet re-sent snapshots for all
  // persisted workflows.
  const syncing = useAppStore((s) => s.connected && Object.values(s.jobs).some((j) => !j.snapshotReceived));
  const usage = useAppStore((s) => s.usage);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setShowGithub = useAppStore((s) => s.setShowGithub);
  const setShowRecall = useAppStore((s) => s.setShowRecall);
  const setCookbookOpen = useCookbookStore((s) => s.setOpen);
  const showGithub = useAppStore((s) => s.showGithub);
  const setShowManual = useAppStore((s) => s.setShowManual);
  // I3 — focus mode collapses the header to wordmark + urgent status (workflow
  // chip, connection) + the toggle, hiding the action groups + provider chips +
  // usage bar. Operator-armed, reversible.
  const focusMode = useAppStore((s) => s.focusMode);
  const setFocusMode = useAppStore((s) => s.setFocusMode);
  const authStatus = useAppStore((s) => s.authStatus);
  const enabledProviders = useAppStore((s) => s.settings?.enabledProviders);
  // WORKBENCH_EXPANSION §K1 — independent terminal launcher. Opens/attaches a
  // session in the ACTIVE workflow's root. Disabled when no workflow is active
  // (cluster view / fresh boot) since a terminal needs a bound cwd.
  const { workflowId: terminalWorkflowId, root: terminalRoot } = useTerminalTarget();
  const openTerminalWindow = useTerminalStore((s) => s.openTerminal);
  const terminalEnabled = Boolean(terminalWorkflowId && terminalRoot);

  const [systemModalOpen, setSystemModalOpen] = useState(false);

  const showUsage = hasEnabledUsageProvider(authStatus, (provider) => enabledProviders?.[provider] !== false);

  // I1-followup — the five feature actions fold into two labeled dropdowns
  // (KNOWLEDGE / TOOLS), mirroring the prior visual grouping. Settings + Manual
  // stay outside as the always-visible "frame" controls. GitHub keeps its
  // toggle/auth-aware styling via the menu item's active/color hooks; Terminal
  // keeps its workflow-gated disabled state.
  const knowledgeItems: HeaderMenuItem[] = [
    {
      key: 'recall',
      label: 'RECALL',
      icon: '⌕',
      onClick: () => setShowRecall(true),
      dataHelp: 'header.recall',
      title: 'Recall — search every past conversation by keyword',
    },
    {
      key: 'cookbook',
      label: 'COOKBOOK',
      icon: '⚙',
      onClick: () => setCookbookOpen(true),
      dataHelp: 'header.cookbook',
      title: 'Cookbook — fit-scored local-model catalog (what can I run?)',
    },
  ];
  const toolItems: HeaderMenuItem[] = [
    {
      key: 'media',
      label: 'MEDIA',
      icon: '⌗',
      onClick: () => openMediaStudio(),
      dataHelp: 'header.media',
      title: 'Media studio — view/zoom images, play audio/video (Import a file or right-click one in Files)',
    },
    {
      key: 'github',
      label: 'GITHUB',
      icon: '◆',
      onClick: () => setShowGithub(!showGithub),
      dataHelp: 'header.github',
      title: 'GitHub — repos, PRs, issues, Actions',
      active: showGithub,
      color: authStatus?.github.loggedIn ? 'var(--color-accent-primary-dim)' : 'var(--color-fg-muted)',
    },
    {
      key: 'terminal',
      label: 'TERMINAL',
      icon: '>_',
      onClick: () => { if (terminalWorkflowId && terminalRoot) openTerminalWindow({ workflowId: terminalWorkflowId }); },
      dataHelp: 'header.terminal',
      disabled: !terminalEnabled,
      title: terminalEnabled ? 'Open a terminal in the active workflow root' : 'Open a workflow first — a terminal needs a working directory',
    },
  ];

  return (
    <header
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderBottom: '1px solid var(--color-border-hairline)',
        background: 'var(--color-bg-panel)',
        position: 'relative',
        zIndex: 10,
        flexShrink: 0,
      }}
    >
      {/* Row 1: ARCO title + grouped controls */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 20px', gap: '8px', minHeight: '36px', flexWrap: 'wrap' }}>
        {/* Left group: wordmark + the hub-link chip pinned right beside it.
            Moved here from the right status cluster (it was crowded there) — the
            link state is identity-level, so it reads cleanly next to the mark.
            Renders nothing when no hub is configured. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0 }}>
          <h1
            data-help="header.arco-mark"
            aria-hidden={isHome || undefined}
            className="display-font glow-text-bright arco-wordmark"
            style={{ fontSize: '16px', letterSpacing: '4px', fontWeight: 400, visibility: isHome ? 'hidden' : 'visible' }}
          >
            ARCO
          </h1>
          <HubLinkChip onToggle={onHubLinkToggle} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', fontFamily: 'var(--font-display)', letterSpacing: '1px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {/* Status cluster — urgent runtime state, always visible: provider
              versions (folded into a popover), the workflow status chip
              (context + quota), and the Claude auth chip. */}
          {/* Workflow status (context + quota) stays visible in focus mode —
              it's urgent runtime state. Everything else is secondary chrome. */}
          <WorkflowStatusChip />

          {!focusMode && (
          <>
          <ProvidersPopover />
          <FreeVramButton />
          {/* Live-provider status as a compact inline dot cluster (was its own
              second header row of boxed LABEL|LIVE pills). Only when ≥1 provider
              is authed. */}
          {showUsage && <UsageBar usage={usage} />}
          <span data-help="header.auth-chip" style={{ display: 'inline-flex' }}>
            <HeaderAuthChip />
          </span>

          <GroupDivider />

          {/* Feature actions — two labeled dropdowns mirroring the prior groups.
              KNOWLEDGE = knowledge surfaces; TOOLS = content + integration. */}
          <HeaderDropdown
            label="KNOWLEDGE"
            icon="⌕"
            items={knowledgeItems}
            dataHelp="header.knowledge"
            title="Knowledge surfaces — Recall, Cookbook"
          />
          <HeaderDropdown
            label="TOOLS"
            icon="⊞"
            items={toolItems}
            dataHelp="header.tools"
            title="Tools — Media, GitHub, Terminal"
          />
          {/* ARCHIVE - opens the standalone chromeless file-explorer window
              (docs/CLIENT.md). Server spawns a brave --app= window;
              falls back to a popup for remote/tunnelled operators. */}
          <button
            onClick={() => { void openArchive(); }}
            data-help="header.archive"
            className="display-font"
            title="ARCHIVE — read-only file explorer in its own window (agent artifacts, recents, tree)"
            style={actionBtn}
          >
            ⌸ ARCHIVE
          </button>
          <button
            onClick={() => { void openArchive('plans'); }}
            data-help="header.plans"
            className="display-font"
            title="ALL PLANS — browse and review every plan across projects without attaching one"
            style={actionBtn}
          >
            ☰ PLANS
          </button>

          <GroupDivider />

          {/* System group — settings, manual stay outside the dropdowns as the
              always-reachable "frame" controls; connection health + power follow. */}
          <button className="display-font" style={actionBtn} onClick={() => useStartupStore.getState().openConnections()}>CONNECTIONS</button>
          <button
            onClick={() => setShowSettings(true)}
            data-help="header.settings"
            className="display-font"
            title="Settings — providers, auth, CLI"
            style={actionBtn}
          >
            ⚙ SETTINGS
          </button>
          <button
            onClick={() => setShowManual(true)}
            data-help="header.manual"
            className="display-font"
            title="User manual — every feature, every quirk"
            style={actionBtn}
          >
            ⓘ MANUAL
          </button>
          </>
          )}
          <button
            onClick={() => setComputerOpen(!computerOpen)}
            data-help="header.computer"
            className="display-font"
            aria-haspopup="dialog"
            aria-expanded={computerOpen}
            title="Computer — your voice conversation and saved memory"
            style={actionBtn}
          >
            COMPUTER
          </button>
          <VoiceButton />
          {/* Connection health stays visible in focus mode — urgent state. */}
          <div data-help="header.connection-status" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {/* Slot 2 — three-state connection indicator. StatusLight drops in
                a DARKN0DE-style emissive LED: halo depth is keyed to state
                (critical breathes fast, nominal breathes calmly). The label
                stays a separate span because we keep its color-dim look for
                ONLINE (dim primary) — the chattier color mapping here doesn't
                fit StatusLight's state tokens and operator-familiar labels are
                load-bearing. */}
            <StatusLight
              state={!connected ? 'critical' : syncing ? 'warning' : 'nominal'}
            />
            <span
              title={
                !connected
                  ? serverDown
                    // §C1 — server PROCESS is unreachable (/healthz failed). A WS
                    // RECONNECT/RESTART can't help until it's back up.
                    ? 'Arco server process is unreachable (the /healthz probe failed). RECONNECT/RESTART won’t help until it’s back — check `arco service status` / `arco service logs`, or relaunch it.'
                    : reconnectState?.attempting
                      ? reconnectState.nextAttemptIn > 0
                        ? `Server is reachable — WebSocket dropped. Automatic reconnect scheduled in ${Math.round(reconnectState.nextAttemptIn / 100) / 10}s`
                        : 'Server is reachable — WebSocket dropped. Automatic reconnect in progress'
                      : 'WebSocket dropped (server appears reachable). Use RECONNECT.'
                  : undefined
              }
              style={{ color: !connected ? 'var(--color-danger)' : syncing ? 'var(--color-accent-secondary)' : 'var(--color-accent-primary-dim)' }}
            >
              {!connected
                ? serverDown
                  ? 'SERVER DOWN'
                  : reconnectState?.attempting ? 'RECONNECTING…' : 'OFFLINE'
                : syncing ? 'SYNCING…' : 'ONLINE'}
            </span>
            {!connected && (
              <>
                {/* §C2 — targeted action per connection state. `reconnect`
                    re-fires the /healthz probe on each tick (useWebSocket
                    scheduleReconnect), so the same handler serves both: for a
                    plain 'disconnected' it reads as RECONNECT, for 'server-down'
                    it's an honest RE-PROBE (the server PROCESS is unreachable, so
                    a WS reconnect can't land until healthz answers again). RESTART
                    is hidden for server-down: /api/restart can't be delivered to a
                    dead process — showing it would imply a recovery that can't
                    happen. */}
                <button
                  onClick={onReconnect}
                  className="display-font"
                  title={serverDown
                    ? "Re-check /healthz — the server process looked unreachable. RESTART can't help until it answers."
                    : 'Force a WebSocket reconnect now'}
                  style={{
                    ...actionBtn,
                    border: '1px solid var(--color-danger)',
                    color: 'var(--color-danger)',
                    marginLeft: '4px',
                  }}
                >
                  {serverDown ? 'RE-PROBE' : 'RECONNECT'}
                </button>
                {!serverDown && (
                  <button
                    onClick={onRestartServer}
                    className="display-font"
                    title="Ask the local Arco server to restart if HTTP is still reachable"
                    style={{
                      ...actionBtn,
                      border: '1px solid var(--color-warning)',
                      color: 'var(--color-warning)',
                    }}
                  >
                    RESTART
                  </button>
                )}
              </>
            )}
          </div>
          {/* §J1 — notification bell + notice center. Always visible (notices
              are exactly the "agent finished / something broke" signal focus
              mode is for). */}
          <NotificationCenter onSetMutes={onSetNotificationMutes} />
          {/* I3 — focus-mode toggle. Stays visible in both states so the
              operator can always exit. Highlighted when armed. */}
          <button
            onClick={() => setFocusMode(!focusMode)}
            data-help="header.focus"
            className="display-font"
            title={focusMode
              ? 'Exit focus mode — restore the right panel + header actions'
              : 'Focus mode — hide the right panel + secondary header chrome for a full-width chat'}
            style={{
              ...actionBtn,
              background: focusMode ? 'var(--color-accent-primary-a10)' : 'transparent',
              border: `1px solid ${focusMode ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
              color: focusMode ? 'var(--color-accent-primary)' : 'var(--color-accent-primary-dim)',
            }}
          >
            {focusMode ? '◳ EXIT FOCUS' : '◳ FOCUS'}
          </button>
          <span data-help="header.power" style={{ display: 'inline-flex' }}>
            <button
              onClick={() => setSystemModalOpen(true)}
              className="display-font"
              title="System: Actions (restart/quit) · Diagnostics · Models · Services"
              style={{
                ...actionBtn,
                color: 'var(--color-warning)',
                fontSize: '12px',
                padding: '3px 10px',
              }}
            >
              ⏻
            </button>
          </span>
        </div>
      </div>

      {systemModalOpen && <SystemModal onClose={() => setSystemModalOpen(false)} onSetPreviewPort={onSetPreviewPort} />}
      <CookbookModal />
    </header>
  );
}
