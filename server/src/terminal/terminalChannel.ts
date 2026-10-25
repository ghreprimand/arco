// WORKBENCH_EXPANSION_PLAN.md §K1 — the `/terminal` WS channel.
//
// A dedicated WS path, separate from `/ws`. It carries the RAW PTY byte stream
// and is deliberately NOT the seq'd / persisted `/ws` protocol — nothing here
// touches events.jsonl or the seq machinery. Session lifecycle + command-line
// events are persisted separately by the caller (via broadcastWorkflow).
//
// Access posture: this server is constructed with `noServer: true` and is fed
// upgrades only from index.ts's upgrade fan-out, which runs on the same HTTP
// server bound to loopback (HOST=127.0.0.1) by default. That loopback bind IS
// the access gate for `/ws` (there is no per-connection token / origin check —
// see server/src/server/constants.ts), and `/terminal` inherits exactly the
// same posture: same server, same bind, same exposure-only-when-tunneled
// caveat. When Archon is tunneled over Tailscale this endpoint is a remote
// shell on the workstation — see docs/GOTCHAS.md § Terminal.
//
// HARD FENCE: operator-only. This channel is driven by the human's floating
// terminal window; the model never sees it.

import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import { ptyManager } from './ptyManager.js';

// ── Wire envelope (client → server) ──
//   attach  { sessionId }         — bind this socket to an existing session
//   input   { data }              — operator keystrokes / paste
//   prefill { data }              — §K3 "Run in terminal": write `data` to the
//                                   PTY input line WITHOUT a trailing newline,
//                                   so nothing executes until the operator
//                                   presses Enter. THE load-bearing fence.
//   resize  { cols, rows }        — xterm fit-addon geometry change
//   kill    {}                    — explicit Kill (reaps the shell)
// ── Wire envelope (server → client) ──
//   data   { bytes }              — raw PTY output (incl. replayed scrollback)
//   exit   { code }               — the shell exited
//   error  { message }            — attach failed / stale session
//
// The session is created over the seq'd `/ws` path (terminal_open ClientMessage
// → ptyManager.spawn), so this channel only ever ATTACHES to an existing id.

type TerminalClientMsg =
  | { type: 'attach'; sessionId: string }
  | { type: 'input'; data: string }
  | { type: 'prefill'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'kill' };

// Callback so the channel can notify the rest of the server when the operator
// kills a session from inside the window (vs. via the `/ws` terminal_kill
// path), so a lifecycle event still lands in events.jsonl.
type OnKill = (session: { id: string; workflowId: string; cwd: string; shell: string }) => void;

let onKillHook: OnKill | undefined;
export function setTerminalKillHook(hook: OnKill): void {
  onKillHook = hook;
}

// Callback so a shell that exits ON ITS OWN (operator typed `exit`, process
// died) still lands a lifecycle event in events.jsonl. The attach listener is
// swappable (window reattach), so persistence can't live in the window's own
// onExit — it rides this hook, which the channel fires regardless of which
// window (if any) is currently attached.
type OnExit = (session: { id: string; workflowId: string }, code: number) => void;
let onExitHook: OnExit | undefined;
export function setTerminalExitHook(hook: OnExit): void {
  onExitHook = hook;
}

// §K3 pre-fill-NEVER-auto-run fence, in one pure place. Strip ANY trailing
// line terminator so a prefill can never submit the command line — the
// operator's Enter is the only thing that runs it. Exported so the smoke can
// assert the exact transform (scripts/smoke/terminal-prefill.ts).
export function stripLineTerminator(text: string): string {
  return text.replace(/[\r\n]+$/, '');
}

// Bracketed-paste markers (DECSET 2004). A paste-aware interactive shell that
// receives input framed by these treats embedded newlines as LITERAL input —
// the whole block lands on the edit line and NOTHING submits until the operator
// presses Enter. This is exactly how a real terminal handles a multi-line paste.
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

// §K3 — THE single guarantee point for the prefill transform. A multi-line
// command block (e.g. a ```bash block with `npm install\nnpm test`) carries
// INTERIOR newlines; stripLineTerminator only removes the trailing one, so a
// bare write would let the PTY's line discipline execute the first line on its
// interior \n. Wrapping the (terminator-stripped) body in bracketed-paste
// markers makes a paste-aware shell hold the whole block on the edit line for
// review/edit/Enter — nothing runs until the operator's Enter. Exported so the
// smoke can assert the exact production transform.
//
// Caveat (documented, not solved — see docs/GOTCHAS.md § Terminal): if a shell
// has bracketed paste DISABLED, the \x1b[200~/\x1b[201~ markers degrade to
// literal text on the prompt rather than executing — strictly safer than a bare
// interior newline, just cosmetically odd. Matches a real paste into such a shell.
export function wrapPrefillForPty(text: string): string {
  return BRACKETED_PASTE_START + stripLineTerminator(text) + BRACKETED_PASTE_END;
}

// noServer: index.ts owns the upgrade fan-out and hands us matching upgrades.
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws: WebSocket) => {
  // The session this socket is attached to. One window ↔ one session at a time.
  let boundSessionId: string | undefined;
  // Captured at attach time (the session is alive then) so the exit hook can
  // still persist the lifecycle event after ptyManager drops the session.
  let boundWorkflowId: string | undefined;
  // K2 multi-listener: removes EXACTLY this socket's listener (not every viewer
  // of the session). Two windows can attach to one session; closing one window
  // must leave the other receiving output. ptyManager.attach returns it.
  let disposeListener: (() => void) | undefined;

  const detach = () => {
    if (disposeListener) {
      disposeListener();
      disposeListener = undefined;
    }
    boundSessionId = undefined;
  };

  ws.on('message', (raw: Buffer) => {
    let msg: TerminalClientMsg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case 'attach': {
        // Dispose any prior listener on THIS socket before re-attaching — both
        // when switching sessions (window reuse) and on a redundant re-attach to
        // the same id (so the multi-listener Set can't accumulate a stale
        // listener for a single socket).
        detach();
        const replay = ptyManager.attach(
          msg.sessionId,
          (data) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'data', bytes: data }));
          },
          (code) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'exit', code }));
            // Persist a shell-exit lifecycle event regardless of attachment.
            // ptyManager drops the session inside its own onExit, so we use the
            // workflowId captured at attach time, not a live lookup.
            if (onExitHook && boundWorkflowId) onExitHook({ id: msg.sessionId, workflowId: boundWorkflowId }, code);
          },
        );
        if (!replay) {
          ws.send(JSON.stringify({ type: 'error', message: `Session ${msg.sessionId} not found (may have been killed).` }));
          return;
        }
        disposeListener = replay.dispose;
        boundSessionId = msg.sessionId;
        boundWorkflowId = ptyManager.get(msg.sessionId)?.workflowId;
        // Flush scrollback so the window repaints history immediately.
        if (replay.scrollback.length > 0) {
          ws.send(JSON.stringify({ type: 'data', bytes: replay.scrollback }));
        }
        break;
      }
      case 'input':
        if (boundSessionId && typeof msg.data === 'string') ptyManager.write(boundSessionId, msg.data);
        break;
      case 'prefill':
        // §K3 — pre-fill-NEVER-auto-run fence. Write the suggested command to
        // the PTY input line wrapped in BRACKETED-PASTE markers, so it sits on
        // the prompt for the operator to review/edit/Enter. Bracketed paste is
        // what prevents INTERIOR newlines (a multi-line ```bash block) from
        // auto-submitting: a paste-aware shell treats embedded \n as literal
        // input and holds the whole block on the edit line. We also strip any
        // trailing terminator (inside the markers) so even a single trailing \n
        // can't submit. This is the ONLY guarantee point for the no-auto-run
        // invariant — see wrapPrefillForPty above.
        if (boundSessionId && typeof msg.data === 'string') {
          ptyManager.write(boundSessionId, wrapPrefillForPty(msg.data));
        }
        break;
      case 'resize':
        if (boundSessionId) ptyManager.resize(boundSessionId, msg.cols, msg.rows);
        break;
      case 'kill': {
        if (boundSessionId) {
          const s = ptyManager.get(boundSessionId);
          ptyManager.kill(boundSessionId);
          if (s && onKillHook) onKillHook({ id: s.id, workflowId: s.workflowId, cwd: s.cwd, shell: s.shell });
          disposeListener = undefined;
          boundSessionId = undefined;
        }
        break;
      }
    }
  });

  // Connection close = window close. DETACH only — the shell lives on. This is
  // the session ≠ connection invariant.
  ws.on('close', detach);
  ws.on('error', detach);
});

// Called from index.ts's upgrade fan-out for `/terminal` upgrades.
export function handleTerminalUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const path = (req.url || '').split('?')[0];
  if (path !== '/terminal') return false;
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
  return true;
}
