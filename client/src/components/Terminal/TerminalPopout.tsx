import { useState } from 'react';
import { XtermViewLazy as XtermView } from './XtermViewLazy';
import '../../styles/global.css';

// WORKBENCH_EXPANSION §K4 — pop-out terminal: a STANDALONE full-window view of an
// EXISTING PTY session in its own OS-level browser window (operator drags it to a
// second monitor / tiles it). Rendered by main.tsx INSTEAD of <App/> when the
// `?popoutTerminal=<sessionId>` query param is present (see main.tsx + docs/TERMINAL.md
// for the route-shape rationale). This component:
//
//   - boots NO app stores and NO seq'd `/ws` control plane — it is a pure view.
//     The only socket it opens is XtermView's own `/terminal` WS, which attaches
//     by sessionId alone (the session knows its own workflowId server-side).
//   - NEVER spawns a session. It only ATTACHES to one the in-app window already
//     created over `/ws` (`terminal_open`). A bad/stale id surfaces as `error`.
//   - coexists with the in-app floating window viewing the same session — §K2's
//     multi-listener fans live output to BOTH, and typing in either drives the
//     same shell. We deliberately do NOT close the in-app window on pop-out.
//   - on the parent (main app) window closing: nothing happens here. The session
//     lives in the server's ptyManager pool, owned by the workflow — not by any
//     window. This pop-out keeps streaming until its own socket closes (detach)
//     or the operator Kills the session from the in-app window.
//
// Theme is inherited for free: main.tsx runs bootstrapCachedTheme() before render,
// and this is same-origin / same-localStorage as the main app.

interface Props {
  sessionId: string;
}

export function TerminalPopout({ sessionId }: Props) {
  const [ended, setEnded] = useState<string | null>(null);

  // The pop-out has no `/ws`, so it can't resolve the session's label — show the
  // id (and a generic title). That's sufficient: the operator opened it knowingly.
  const shortId = sessionId.slice(0, 8);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--color-bg, #0b0e14)',
        color: 'var(--color-fg)',
      }}
    >
      <div
        className="display-font"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          padding: '4px 10px',
          borderBottom: '1px solid var(--color-border-hairline)',
          background: 'var(--color-bg-secondary)',
          fontSize: '10px',
          letterSpacing: '1px',
          flexShrink: 0,
        }}
      >
        <span>TERMINAL · {shortId}</span>
        {ended && (
          <button
            onClick={() => window.close()}
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
            CLOSE
          </button>
        )}
      </div>

      {ended ? (
        <div
          className="display-font"
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '20px',
            textAlign: 'center',
            color: 'var(--color-fg-muted)',
            fontSize: '11px',
            letterSpacing: '0.5px',
            lineHeight: 1.6,
          }}
        >
          {ended}
        </div>
      ) : (
        <XtermView
          key={sessionId}
          sessionId={sessionId}
          onExit={(code) =>
            setEnded(`Session ended (shell exited, code ${code}). You can close this window — the session is gone.`)
          }
          onError={() =>
            setEnded('Session not found — it may have been killed, or the server restarted (PTYs do not survive a restart). You can close this window.')
          }
        />
      )}
    </div>
  );
}
