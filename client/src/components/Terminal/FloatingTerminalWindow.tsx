import { useEffect, useRef, useState } from 'react';
import { useTerminalStore, type TerminalWindow, type TerminalSession } from '../../stores/terminalStore';
import { readDraft } from '../../stores/draftStore';
import { useAppStore } from '../../stores/appStore';
import { FloatingWindow } from './FloatingWindow';
import { XtermViewLazy as XtermView } from './XtermViewLazy';
import { appendToDraft } from './composerBridge';

// Stable empty array for the sessions selector. Returning a fresh `?? []` from a
// Zustand selector makes useSyncExternalStore see a new snapshot every render →
// "getSnapshot should be cached" → infinite re-render ("Maximum update depth
// exceeded"), which crashed TerminalWindowInstance the instant a window opened
// before any session existed. One shared reference fixes it.
const EMPTY_SESSIONS: TerminalSession[] = [];

// WORKBENCH_EXPANSION §K1/§K2 — operator terminal floating windows.
//
// Mounted once at App level. §K2 widens K1's single window to N: this renders
// one FloatingWindow per open window descriptor in terminalStore.windows. Each
// window views ONE session and carries its own session switcher + "+ new" +
// per-session Kill. TWO windows may point at the SAME sessionId — the server's
// multi-listener fans live output to both XtermViews.
//
// Session ≠ connection: closing a window DETACHES (its XtermView socket closes
// → server removes that window's listener → shell lives on). Reopening / a
// second window re-attaches by sessionId and repaints scrollback. Only KILL
// ends the session.

interface Props {
  openTerminal: (workflowId: string, cwd?: string) => void;
  killTerminal: (workflowId: string, sessionId: string) => void;
  logTerminalCommand: (workflowId: string, sessionId: string, command: string) => void;
  listTerminalSessions: (workflowId: string) => void;
}

export function FloatingTerminalWindow(props: Props) {
  const windows = useTerminalStore((s) => s.windows);
  return (
    <>
      {windows.map((w) => (
        <TerminalWindowInstance key={w.windowId} win={w} {...props} />
      ))}
    </>
  );
}

function TerminalWindowInstance({
  win,
  openTerminal,
  killTerminal,
  logTerminalCommand,
  listTerminalSessions,
}: Props & { win: TerminalWindow }) {
  const { windowId, workflowId, sessionId, pendingCwd } = win;

  const sessions = useTerminalStore((s) => s.sessionsByWorkflow[workflowId] ?? EMPTY_SESSIONS);
  const closeWindow = useTerminalStore((s) => s.closeWindow);
  const newSession = useTerminalStore((s) => s.newSession);
  const switchWindowSession = useTerminalStore((s) => s.switchWindowSession);
  const consumePrefill = useTerminalStore((s) => s.consumePrefill);

  const job = useAppStore((s) => s.jobs[workflowId]);
  const setDraft = useAppStore((s) => s.setDraft);
  const [exitNote, setExitNote] = useState<string | null>(null);
  // §K5 — latest xterm selection text ('' when none). Drives the
  // "send to composer" affordance below. Operator-curated only.
  const [selection, setSelection] = useState('');

  // §K5 — operator→agent output bridge. The operator selects output and clicks
  // this; we APPEND a quoted block to THIS window's workflow composer draft
  // (read fresh from the store so we don't clobber in-progress typing). It is
  // INSERTED, never sent — the operator still presses send. This preserves the
  // operator-only terminal fence: the agent never gets terminal control or
  // auto-fed output.
  const sendSelectionToComposer = () => {
    if (!selection) return;
    const current = readDraft(workflowId);
    setDraft(workflowId, appendToDraft(current, selection));
  };

  // On first mount, ask the server for the live session list (populates the
  // switcher; also lets an attach pick an existing session after a reconnect).
  const askedRef = useRef(false);
  useEffect(() => {
    if (askedRef.current) return;
    askedRef.current = true;
    listTerminalSessions(workflowId);
  }, [workflowId, listTerminalSessions]);

  // Spawn-on-demand: a window with no session but a pendingCwd asked the store
  // to spawn. Fire terminal_open once; bindSpawnedSession (in the WS dispatch)
  // attaches the resulting sessionId to this window.
  const spawnedRef = useRef(false);
  useEffect(() => {
    if (sessionId || pendingCwd === undefined || spawnedRef.current) return;
    spawnedRef.current = true;
    setExitNote(null);
    openTerminal(workflowId, pendingCwd === '' ? undefined : pendingCwd);
  }, [sessionId, pendingCwd, workflowId, openTerminal]);

  // §K3 — drain a staged prefill once a session exists. Nonce makes repeat chip
  // clicks re-fire (a value-equal prefill prop wouldn't trip the effect).
  const [prefillCmd, setPrefillCmd] = useState<string | null>(null);
  const prefillNonceRef = useRef(0);
  useEffect(() => {
    if (!sessionId) return;
    const cmd = consumePrefill(windowId);
    if (cmd != null) {
      prefillNonceRef.current += 1;
      setPrefillCmd(cmd);
    }
    // win.pendingPrefill is read via consumePrefill at fire time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, windowId, win.pendingPrefill]);

  const activeLabel = sessions.find((s) => s.sessionId === sessionId)?.label;
  const title = `TERMINAL · ${job?.config.name || workflowId.slice(0, 8)}${activeLabel ? ` · ${activeLabel}` : ''}`;

  return (
    <FloatingWindow
      title={title}
      onClose={() => closeWindow(windowId)}
      headerActions={
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {/* Session switcher — pick which session this window views. */}
          {sessions.length > 0 && (
            <select
              value={sessionId ?? ''}
              onChange={(e) => { if (e.target.value) { setExitNote(null); setSelection(''); switchWindowSession(windowId, e.target.value); } }}
              data-help="terminal.switcher"
              title="Switch which shell session this window views"
              className="display-font"
              style={{
                background: 'var(--color-bg-secondary)',
                border: '1px solid var(--color-border-hairline)',
                borderRadius: '3px',
                color: 'var(--color-fg)',
                cursor: 'pointer',
                fontSize: '9px',
                letterSpacing: '0.5px',
                padding: '2px 4px',
                maxWidth: '120px',
              }}
            >
              {sessionId === null && <option value="">(no session)</option>}
              {sessions.map((s) => (
                <option key={s.sessionId} value={s.sessionId}>{s.label}</option>
              ))}
            </select>
          )}
          {/* §K5 — send the SELECTED terminal output into this workflow's
              composer as a quoted block. Enabled only when there's a live
              selection. Operator-action-only: it inserts a draft the operator
              still edits/sends — it never auto-feeds the agent. */}
          {sessionId && (
            <button
              onClick={sendSelectionToComposer}
              disabled={!selection}
              data-help="terminal.send-to-composer"
              title={selection ? 'Insert the selected output into the composer (you still press send)' : 'Select terminal output first'}
              className="display-font"
              style={{
                background: 'transparent',
                border: '1px solid var(--color-border-hairline)',
                borderRadius: '3px',
                color: selection ? 'var(--color-fg-muted)' : 'var(--color-border-hairline)',
                cursor: selection ? 'pointer' : 'default',
                fontSize: '9px',
                letterSpacing: '1px',
                padding: '2px 8px',
              }}
            >
              → COMPOSER
            </button>
          )}
          {/* + new shell — ALWAYS spawns a fresh session in a NEW window. */}
          <button
            onClick={() => newSession(workflowId)}
            data-help="terminal.new"
            title="Open a new shell session (a fresh window)"
            className="display-font"
            style={{
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: 'var(--color-fg-muted)',
              cursor: 'pointer',
              fontSize: '9px',
              letterSpacing: '1px',
              padding: '2px 8px',
            }}
          >
            + NEW
          </button>
          {/* §K4 — pop the session out into its own OS-level browser window.
              Opens /?popoutTerminal=<id> (query-param-on-root route — main.tsx
              branches on it). Does NOT close this window: both views attach to
              the same session over the §K2 multi-listener, so typing in either
              drives the same shell. The pop-out attaches only (never spawns);
              closing it detaches just its socket. */}
          {sessionId && (
            <button
              onClick={() => {
                window.open(
                  `/?popoutTerminal=${encodeURIComponent(sessionId)}`,
                  '_blank',
                  'width=720,height=480,resizable=yes',
                );
              }}
              data-help="terminal.popout"
              title="Pop this shell out into a separate browser window (same live session)"
              className="display-font"
              style={{
                background: 'transparent',
                border: '1px solid var(--color-border-hairline)',
                borderRadius: '3px',
                color: 'var(--color-fg-muted)',
                cursor: 'pointer',
                fontSize: '9px',
                letterSpacing: '1px',
                padding: '2px 8px',
              }}
            >
              POP OUT
            </button>
          )}
          {sessionId && (
            <button
              onClick={() => { killTerminal(workflowId, sessionId); }}
              data-help="terminal.kill"
              title="Kill this shell session (ends the process — not just the window)"
              className="display-font"
              style={{
                background: 'transparent',
                border: '1px solid var(--color-danger)',
                borderRadius: '3px',
                color: 'var(--color-danger)',
                cursor: 'pointer',
                fontSize: '9px',
                letterSpacing: '1px',
                padding: '2px 8px',
              }}
            >
              KILL
            </button>
          )}
        </div>
      }
    >
      {sessionId ? (
        <XtermView
          key={sessionId}
          sessionId={sessionId}
          prefill={prefillCmd}
          prefillNonce={prefillNonceRef.current}
          onPrefillConsumed={() => setPrefillCmd(null)}
          onSelectionChange={setSelection}
          onCommandLine={(cmd) => logTerminalCommand(workflowId, sessionId, cmd)}
          onExit={(code) => setExitNote(`Shell exited (code ${code}). Open a new shell or pick another session.`)}
          onError={(msg) => setExitNote(msg)}
        />
      ) : (
        <div
          className="display-font"
          style={{ padding: '20px', color: 'var(--color-fg-muted)', fontSize: '11px', letterSpacing: '0.5px' }}
        >
          {exitNote ?? (pendingCwd !== undefined ? 'Starting shell…' : 'No session — pick one above or + NEW.')}
        </div>
      )}
      {sessionId && exitNote && (
        <div
          style={{
            padding: '6px 10px',
            borderTop: '1px solid var(--color-border-hairline)',
            color: 'var(--color-warning)',
            fontSize: '10px',
            fontFamily: 'var(--font-display)',
            flexShrink: 0,
          }}
        >
          {exitNote}
        </div>
      )}
    </FloatingWindow>
  );
}
