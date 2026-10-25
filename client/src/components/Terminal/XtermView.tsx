import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useAppStore } from '../../stores/appStore';
import { THEME_REGISTRY } from '../../themes/registry';
import { ensureWsSession } from '../../utils/wsSession';

// WORKBENCH_EXPANSION §K1 — the xterm.js view bound to ONE PTY session over
// the dedicated `/terminal` WS path (raw byte stream, separate from the seq'd
// `/ws`). Mount with a sessionId; the view opens its own socket, attaches,
// repaints scrollback, and pumps input/resize. Unmounting closes the socket
// which DETACHES server-side — the shell lives on (session ≠ connection).
//
// ROBUSTNESS (2026-06 — after a blank-pane incident): two failure modes used to
// kill this view SILENTLY. (1) The `/terminal` WS occasionally fails its
// handshake (the Vite dev proxy's WS upgrade is mildly racy; `/ws` papers over
// it by reconnecting, this view did not) → permanent blank pane. We now RETRY
// with backoff and surface the failure as a visible overlay. (2) Calling
// `fit()` / writing to xterm before the container has layout throws
// `Cannot read properties of undefined (reading 'dimensions')` deep in xterm's
// Viewport → the whole view crashes. We now defer `open()`+`fit()` until the
// container is actually sized.

const TERMINAL_WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/terminal`;
const MAX_CONNECT_ATTEMPTS = 6;

// xterm renders to a <canvas>, so it needs LITERAL color/font strings — CSS
// custom properties (var(--…)) don't resolve in a canvas context, which is why
// the old `fontFamily: 'var(--font-code, monospace)'` silently fell back to
// plain monospace. We read the active theme's computed tokens off :root and
// hand xterm concrete values (background, text, cursor + the resolved code
// font, which is JetBrains Mono by default — see global.css --font-code). This
// is re-run on theme switch so the terminal tracks the active theme. Most
// themes leave xterm's default 16-colour ANSI palette intact; a faithful
// terminal-palette port can opt into a complete Core + ANSI table through the
// theme manifest (Red Planet is the first).
function readTerminalTheme(): {
  theme: NonNullable<ConstructorParameters<typeof Terminal>[0]>['theme'];
  fontFamily: string;
} {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const background = v('--color-bg', '#0b0e14');
  const foreground = v('--color-fg', '#cdd6f4');
  const accent = v('--color-accent-primary', foreground);
  const appliedThemeId = document.documentElement.dataset.theme;
  const terminalPalette = appliedThemeId ? THEME_REGISTRY[appliedThemeId]?.terminal : undefined;
  return {
    // cursorAccent = the glyph colour UNDER the block cursor; bg keeps it legible.
    theme: terminalPalette ?? { background, foreground, cursor: accent, cursorAccent: background },
    fontFamily: v('--font-code', "'JetBrains Mono', monospace"),
  };
}

// Exported so the code-split wrapper (XtermViewLazy.tsx) can type its props
// without importing this module — importing it eagerly would defeat the split
// and drag @xterm/xterm back into the main chunk.
export interface Props {
  sessionId: string;
  // Detect Enter-submitted lines client-side so the operator's command line
  // can be logged to events.jsonl (visibility) without persisting the raw
  // stream. We accumulate typed bytes and flush the buffered line on \r.
  onCommandLine?: (command: string) => void;
  // Fired when the shell exits (server `exit` frame) so the parent can show
  // a hint and offer reopen.
  onExit?: (code: number) => void;
  // Fired if attach fails (stale/killed session).
  onError?: (message: string) => void;
  // §K3 "Run in terminal" — a command staged by the chat chip to PRE-FILL on
  // the prompt. Sent as a `prefill` frame (NO newline — never auto-runs) right
  // after attach completes. `prefillNonce` makes a repeat-prefill of the SAME
  // command text re-fire (clicking the chip twice); without it a value-equal
  // prop wouldn't trip the effect. `onPrefillConsumed` clears the parent's
  // staged command so it doesn't replay on the next render.
  prefill?: string | null;
  prefillNonce?: number;
  onPrefillConsumed?: () => void;
  // §K5 — fired whenever the xterm selection changes, with the current
  // selected text ('' when nothing is selected). Lets the parent enable a
  // "send to composer" affordance and read the verbatim selection. The agent
  // never sees this stream — it's purely operator-curated.
  onSelectionChange?: (selectedText: string) => void;
}

export function XtermView({ sessionId, onCommandLine, onExit, onError, prefill, prefillNonce, onPrefillConsumed, onSelectionChange }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Live xterm handles so the theme-watch effect (below) can re-style the
  // terminal in place when the app theme changes, without tearing down the
  // session.
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // The active theme id — switching themes bumps this and re-runs the
  // theme-watch effect. apply.ts has already written the new CSS vars to :root
  // by the time React re-renders, so readTerminalTheme() sees the new values.
  const themeId = useAppStore((s) => s.settings?.themeId);
  // Stash latest callbacks so the effect can stay keyed only on sessionId.
  const cbRef = useRef({ onCommandLine, onExit, onError, onPrefillConsumed, onSelectionChange });
  cbRef.current = { onCommandLine, onExit, onError, onPrefillConsumed, onSelectionChange };
  // The live socket + whether we've attached yet, so a prefill that arrives
  // after the socket opens can be sent immediately, and one that arrives
  // before can be flushed on attach.
  const wsRef = useRef<WebSocket | null>(null);
  const attachedRef = useRef(false);
  // Pending prefill text that landed before attach completed; flushed on open.
  const pendingPrefillRef = useRef<string | null>(null);
  // Visible connection status — null once attached & receiving. A non-null
  // value renders an overlay so a failed/ retrying connection is never a
  // silent blank pane.
  const [status, setStatus] = useState<{ kind: 'connecting' | 'error'; text: string } | null>({ kind: 'connecting', text: 'Connecting…' });

  // Send a prefill frame — text WITHOUT a newline (the server also strips a
  // trailing terminator defensively). This NEVER submits the line.
  const sendPrefill = (text: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && attachedRef.current) {
      ws.send(JSON.stringify({ type: 'prefill', data: text }));
      cbRef.current.onPrefillConsumed?.();
    } else {
      pendingPrefillRef.current = text;
    }
  };

  // React to a staged prefill (chip click). Fires on mount-with-prefill and on
  // every nonce bump (repeat clicks of the same command).
  useEffect(() => {
    if (prefill != null && prefill.length > 0) sendPrefill(prefill);
    // sendPrefill reads refs; intentionally keyed on the staged command + nonce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, prefillNonce]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let disposed = false;
    let attempts = 0;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;

    const initial = readTerminalTheme();
    const term = new Terminal({
      fontFamily: initial.fontFamily,
      fontSize: 13,
      cursorBlink: true,
      // Match the active app theme (background + text + cursor). Re-applied on
      // theme switch by the themeId effect below.
      theme: initial.theme,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;

    // Only fit when the container actually has layout. Fitting (or writing)
    // against a zero-size container makes xterm read undefined renderer
    // `dimensions` and throw — the bug that crashed this view. Guarded + sized.
    const safeFit = () => {
      if (disposed) return;
      if (el.clientWidth <= 0 || el.clientHeight <= 0) return;
      try { fit.fit(); } catch { /* renderer not ready yet — a later resize retries */ }
    };

    let lineBuf = '';

    const sendResize = () => {
      safeFit();
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };

    const connect = () => {
      if (disposed) return;
      attempts += 1;
      setStatus({ kind: 'connecting', text: attempts > 1 ? `Reconnecting… (attempt ${attempts}/${MAX_CONNECT_ATTEMPTS})` : 'Connecting…' });
      // Same session-cookie gate as /ws (server/src/http/wsAuth.ts).
      void ensureWsSession().then(() => { if (!disposed) openSocket(); });
    };

    const openSocket = () => {
      const ws = new WebSocket(TERMINAL_WS_URL);
      wsRef.current = ws;
      attachedRef.current = false;

      ws.onopen = () => {
        if (disposed) return;
        ws.send(JSON.stringify({ type: 'attach', sessionId }));
        attachedRef.current = true;
        sendResize();
        const staged = pendingPrefillRef.current;
        if (staged != null) {
          pendingPrefillRef.current = null;
          ws.send(JSON.stringify({ type: 'prefill', data: staged }));
          cbRef.current.onPrefillConsumed?.();
        }
      };
      ws.onmessage = (ev) => {
        let m: { type: string; bytes?: string; code?: number; message?: string };
        try { m = JSON.parse(ev.data as string); } catch { return; }
        if (m.type === 'data' && typeof m.bytes === 'string') {
          // First real bytes prove the channel works — clear the overlay.
          setStatus(null);
          try { term.write(m.bytes); } catch { /* render race — ignore one frame */ }
        } else if (m.type === 'exit') {
          cbRef.current.onExit?.(m.code ?? 0);
        } else if (m.type === 'error') {
          // Server attach error (stale/killed session) — terminal, don't retry.
          setStatus({ kind: 'error', text: m.message ?? 'terminal error' });
          cbRef.current.onError?.(m.message ?? 'terminal error');
        }
      };
      ws.onerror = () => {
        // onclose carries the real signal; onerror just precedes it. Don't
        // double-handle here (would race the retry scheduler in onclose).
      };
      ws.onclose = () => {
        if (disposed) return;
        wsRef.current = null;
        // A clean close AFTER we'd attached = the server/socket went away; a
        // close BEFORE attach = a failed/racy handshake (the Vite proxy issue).
        // Retry with linear backoff up to the cap, then surface a clear error.
        if (attempts < MAX_CONNECT_ATTEMPTS) {
          const delay = Math.min(2000, 250 * attempts);
          setStatus({ kind: 'connecting', text: `Connection lost — retrying in ${(delay / 1000).toFixed(1)}s…` });
          connectTimer = setTimeout(connect, delay);
        } else {
          setStatus({
            kind: 'error',
            text: `Could not connect to the terminal channel after ${MAX_CONNECT_ATTEMPTS} attempts. The /terminal WebSocket isn't reaching the server — if you're on the Vite dev server, restart it so the WS proxy reloads.`,
          });
        }
      };
    };

    const onDataDisp = term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
      // Command-line heuristic. \r = Enter; flush the accumulated line.
      // \x7f = backspace. Anything else printable accretes. This is a
      // best-effort visibility log, not a precise shell parser.
      for (const ch of data) {
        if (ch === '\r' || ch === '\n') {
          const line = lineBuf.trim();
          if (line.length > 0) cbRef.current.onCommandLine?.(line);
          lineBuf = '';
        } else if (ch === '\x7f') {
          lineBuf = lineBuf.slice(0, -1);
        } else if (ch >= ' ') {
          lineBuf += ch;
        }
      }
    });

    // §K5 — surface the live selection to the parent so it can offer a
    // "send to composer" button. Operator-curated only: we just report the
    // current selection text; nothing is sent anywhere on its own.
    const onSelDisp = term.onSelectionChange(() => {
      cbRef.current.onSelectionChange?.(term.hasSelection() ? term.getSelection() : '');
    });

    // Open + connect only once the container has real layout (defer the xterm
    // `dimensions` crash). ResizeObserver fires once on observe with the
    // initial box; we open on the first non-zero size, then keep refitting.
    let opened = false;
    const ro = new ResizeObserver(() => {
      if (disposed) return;
      if (!opened && el.clientWidth > 0 && el.clientHeight > 0) {
        opened = true;
        term.open(el);
        safeFit();
        setTimeout(() => { if (!disposed) { try { term.focus(); } catch { /* ignore */ } } }, 0);
        connect();
        return;
      }
      if (opened) sendResize();
    });
    ro.observe(el);
    // Fallback: if the container already had size before the observer fired
    // (synchronous layout), open on the next frame so we never stall blank.
    requestAnimationFrame(() => {
      if (disposed || opened) return;
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        opened = true;
        term.open(el);
        safeFit();
        setTimeout(() => { if (!disposed) { try { term.focus(); } catch { /* ignore */ } } }, 0);
        connect();
      }
    });

    return () => {
      disposed = true;
      if (connectTimer) clearTimeout(connectTimer);
      ro.disconnect();
      onDataDisp.dispose();
      onSelDisp.dispose();
      attachedRef.current = false;
      const ws = wsRef.current;
      wsRef.current = null;
      // Closing the socket DETACHES server-side; the shell survives.
      try { ws?.close(); } catch { /* ignore */ }
      try { term.dispose(); } catch { /* ignore */ }
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  // Re-theme the live terminal when the app theme changes. xterm needs literal
  // values, so we re-read the freshly-applied CSS tokens and push them onto the
  // existing terminal — no session teardown. A font change needs a refit so
  // xterm recomputes the cell grid for the new glyph metrics. Runs after the
  // main effect on mount too (harmless: re-applies the same theme).
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const next = readTerminalTheme();
    term.options.theme = next.theme;
    if (term.options.fontFamily !== next.fontFamily) {
      term.options.fontFamily = next.fontFamily;
      try { fitRef.current?.fit(); } catch { /* renderer not ready — a later resize refits */ }
    }
    // Repaint with the new palette/font (guarded: a no-op before open()).
    try { term.refresh(0, Math.max(0, term.rows - 1)); } catch { /* not opened yet */ }
  }, [themeId]);

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, width: '100%', height: '100%' }}>
      <div
        ref={containerRef}
        style={{ position: 'absolute', inset: 0, background: 'var(--color-bg)', padding: '4px' }}
      />
      {status && (
        <div
          style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '24px', textAlign: 'center', pointerEvents: 'none',
            background: status.kind === 'error' ? 'rgba(11,14,20,0.86)' : 'transparent',
            color: status.kind === 'error' ? 'var(--color-danger, #e06c75)' : 'var(--color-fg-muted, #8a93a6)',
            fontFamily: 'var(--font-code, monospace)', fontSize: '12px', lineHeight: 1.5,
          }}
        >
          {status.text}
        </div>
      )}
    </div>
  );
}
