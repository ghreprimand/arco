import { AUTOMATIC_LAYOUT_DESCRIPTION, LAYOUT_MODES, setLayoutMode, useLayout } from '../layout/layoutRange';
import { hasEnabledUsageProvider } from './usageVisibility';
import { useStartupStore } from '../stores/startupStore';
import { VoiceMenu } from './VoiceMenu';
import { HelpMenu } from './HelpMenu';
import { headerActionStyle as actionBtn } from './headerActionStyle';
import { HeaderVersionBox } from './HeaderVersionBox';
import { useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { useTerminalStore } from '../stores/terminalStore';
import { useTerminalTarget } from '../hooks/useTerminalTarget';
import { UsageBar } from './UsageBar';
import { WorkflowStatusChip } from './WorkflowStatusChip';
import { ProvidersPopover } from './ProvidersPopover';
import { HeaderDropdown, type HeaderMenuItem } from './HeaderDropdown';
import { SystemModal } from './SystemModal';
import { openMediaStudio } from './media/launchers';
import { openArchive } from '../explorer/launch';
import { HeaderAuthChip } from './HeaderAuthChip';
import { NotificationCenter } from './NotificationCenter';
import { HubLinkChip } from './HubLinkChip';
import { StatusLight } from './primitives/StatusLight';
import type { WorkbenchNoticeCategory } from '@arco/shared';

interface Props {
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

export function SystemHeader({ onReconnect, onRestartServer, reconnectState, onSetPreviewPort, onSetNotificationMutes, onHubLinkToggle }: Props) {
  const layout = useLayout();
  const visibleLayout = layout.range === 'medium' ? 'COMPACT' : layout.range.toUpperCase();
  const layoutLabel = layout.mode === 'auto' ? `AUTO: ${visibleLayout}` : layout.mode.toUpperCase();
  const tightHeader = layout.interfaceWidth < 1100;
  const layoutTip = `Layout: ${layoutLabel}. Click to switch. ${AUTOMATIC_LAYOUT_DESCRIPTION} Current width: ${layout.interfaceWidth} interface pixels.`;
  const connected = useAppStore((s) => s.connected);
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
  const showGithub = useAppStore((s) => s.showGithub);
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
  const [providersOpen, setProvidersOpen] = useState(false);

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
      title: 'Recall: search every past conversation by keyword',
    },
    {
      key: 'plans',
      label: 'PLANS',
      icon: '\u2630',
      onClick: () => { void openArchive('plans', terminalRoot ?? undefined); },
      dataHelp: 'header.plans',
      title: 'ALL PLANS: browse and review every plan across projects without attaching one',
    },
    {
      key: 'archive',
      label: 'ARTIFACTS',
      icon: '\u2338',
      onClick: () => { void openArchive(undefined, terminalRoot ?? undefined); },
      dataHelp: 'header.archive',
      title: 'ARTIFACTS: live view of what agents produced across all projects',
    },
  ];
  const toolItems: HeaderMenuItem[] = [
    {
      key: 'terminal',
      label: 'TERMINAL',
      icon: '>_',
      onClick: () => { if (terminalWorkflowId && terminalRoot) openTerminalWindow({ workflowId: terminalWorkflowId }); },
      dataHelp: 'header.terminal',
      disabled: !terminalEnabled,
      title: terminalEnabled ? 'Open a terminal in the active workflow root' : 'Open a workflow first: a terminal needs a working directory',
    },
    {
      key: 'github',
      label: 'GITHUB',
      icon: '◆',
      onClick: () => setShowGithub(!showGithub),
      dataHelp: 'header.github',
      title: 'GitHub: repos, PRs, issues, Actions',
      active: showGithub,
      color: authStatus?.github.loggedIn ? 'var(--color-accent-primary-dim)' : 'var(--color-fg-muted)',
    },
    {
      key: 'media',
      label: 'MEDIA',
      icon: '⌗',
      onClick: () => openMediaStudio(),
      dataHelp: 'header.media',
      title: 'Media studio: view/zoom images, play audio/video (Import a file or right-click one in Files)',
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: tightHeader ? '5px 8px' : '5px 20px', gap: tightHeader ? '4px' : '8px', minHeight: '36px', flexWrap: 'wrap' }}>
        {/* Left group: wordmark + the hub-link chip pinned right beside it.
            Moved here from the right status cluster (it was crowded there): the
            link state is identity-level, so it reads cleanly next to the mark.
            Renders nothing when no hub is configured. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: tightHeader ? '4px' : '10px', flexShrink: 0 }}>
          <h1
            data-help="header.arco-mark"
            className="display-font glow-text-bright arco-wordmark"
            style={{ fontSize: '16px', letterSpacing: '4px', fontWeight: 400, color: 'var(--color-accent-primary)' }}
          >
            ARCO
          </h1>
          <button type="button" className="display-font" data-help="header.layout" data-testid="header-layout" title={layoutTip} aria-label={layoutTip} onClick={() => setLayoutMode(LAYOUT_MODES[(LAYOUT_MODES.findIndex((item) => item.id === layout.mode) + 1) % LAYOUT_MODES.length].id)} style={{ ...actionBtn, whiteSpace: 'nowrap', flexShrink: 0, fontSize: '10px' }}>
            {layout.mode === 'auto' && layout.interfaceWidth < 1100 ? 'AUTO' : layoutLabel}
          </button>
          <HubLinkChip onToggle={onHubLinkToggle} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: tightHeader ? '3px' : '8px', fontSize: '11px', fontFamily: 'var(--font-display)', letterSpacing: tightHeader ? '0px' : '1px', flexWrap: 'wrap', justifyContent: 'flex-end', minWidth: 0, flexShrink: 0, maxWidth: '100%' }}>
          {/* Status cluster — urgent runtime state, always visible: provider
              versions (folded into a popover), the provider throttling warning, and the Claude auth chip. */}
          {/* Provider throttling stays visible in focus mode —
              it's urgent runtime state. Everything else is secondary chrome. */}
          <WorkflowStatusChip />

          {!focusMode && (
          <>
          <div data-providers-cluster data-help="header.providers" style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
            {/* Provider dots keep their hover usage; a click opens the Providers
                panel (versions, usage pages, FREE VRAM for local runtimes, CONNECTIONS). */}
            {showUsage && <UsageBar usage={usage} onDotClick={() => setProvidersOpen((v) => !v)} />}
            <ProvidersPopover open={providersOpen} onOpenChange={setProvidersOpen} hideTrigger={showUsage} />
          </div>
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
            title="Knowledge: Recall, Plans, Artifacts"
          />
          <HeaderDropdown
            label="TOOLS"
            icon="⊞"
            items={toolItems}
            dataHelp="header.tools"
            title="Tools: Terminal, GitHub, Media"
          />
          <GroupDivider />
          </>
          )}
          <VoiceMenu />
          {/* Connection health stays visible in focus mode — urgent state. */}
          <div data-help="header.connection-status" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            {/* Slot 2 — three-state connection indicator. StatusLight drops in
                a night-shift emissive LED: halo depth is keyed to state
                (critical breathes fast, nominal breathes calmly). The label
                stays a separate span because we keep its color-dim look for
                ONLINE (dim primary): the chattier color mapping here doesn't
                fit StatusLight's state tokens and operator-familiar labels are
                load-bearing. */}
            <span data-testid="connection-light" title={connected && !syncing ? 'ONLINE' : undefined} aria-label={connected && !syncing ? 'Online' : undefined} role={connected && !syncing ? 'img' : undefined} style={{ display: 'inline-flex' }}>
              <StatusLight
                state={!connected ? 'critical' : syncing ? 'warning' : 'nominal'}
              />
            </span>
            <span
              title={
                !connected
                  ? serverDown
                    // §C1 — server PROCESS is unreachable (/healthz failed). A WS
                    // RECONNECT/RESTART can't help until it's back up.
                    ? 'Arco server process is unreachable (the /healthz probe failed). RECONNECT/RESTART won’t help until it’s back: check `arco service status` / `arco service logs`, or relaunch it.'
                    : reconnectState?.attempting
                      ? reconnectState.nextAttemptIn > 0
                        ? `Server is reachable: WebSocket dropped. Automatic reconnect scheduled in ${Math.round(reconnectState.nextAttemptIn / 100) / 10}s`
                        : 'Server is reachable: WebSocket dropped. Automatic reconnect in progress'
                      : 'WebSocket dropped (server appears reachable). Use RECONNECT.'
                  : undefined
              }
              style={{ color: !connected ? 'var(--color-danger)' : syncing ? 'var(--color-accent-secondary)' : 'var(--color-accent-primary-dim)' }}
            >
              {!connected
                ? serverDown
                  ? 'SERVER DOWN'
                  : reconnectState?.attempting ? 'RECONNECTING…' : 'OFFLINE'
                : syncing ? 'SYNCING…' : null}
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
                    dead process: showing it would imply a recovery that can't
                    happen. */}
                <button
                  onClick={onReconnect}
                  className="display-font"
                  title={serverDown
                    ? "Re-check /healthz: the server process looked unreachable. RESTART can't help until it answers."
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
              ? 'Exit focus mode: restore the right panel + header actions'
              : 'Focus mode: hide the right panel + secondary header chrome for a full-width chat'}
            style={{
              ...actionBtn,
              background: focusMode ? 'var(--color-accent-primary-a10)' : 'transparent',
              border: `1px solid ${focusMode ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
              color: focusMode ? 'var(--color-accent-primary)' : 'var(--color-accent-primary-dim)',
            }}
          >
            {focusMode ? '◳ EXIT FOCUS' : '◳ FOCUS'}
          </button>
          {!focusMode && (
          <>
          <HelpMenu />
          <button
            onClick={() => setShowSettings(true)}
            data-help="header.settings"
            className="display-font"
            title="Settings: providers, auth, CLI"
            style={actionBtn}
          >
            ⚙ SETTINGS
          </button>
          </>
          )}
          <HeaderVersionBox />
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
    </header>
  );
}
