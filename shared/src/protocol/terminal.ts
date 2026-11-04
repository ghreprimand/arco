// ── Integrated operator terminal (Workbench Expansion §K1) ──
//
// Two surfaces:
//  1. The seq'd `/ws` control plane (THIS file) — open/kill a session, plus
//     lifecycle + operator-command-line events that DO land in events.jsonl
//     for four-question visibility.
//  2. The dedicated `/terminal` WS path (server/src/terminal/terminalChannel.ts)
//     — the RAW byte stream, deliberately NOT persisted and NOT seq'd. Its wire
//     envelope (attach / input / prefill / resize / kill) is defined inline in
//     terminalChannel.ts, not here. §K3's `prefill` writes a suggested command
//     to the PTY input line with NO trailing newline (pre-fill-never-auto-run).
//
// HARD FENCE: operator-only. The PTY is never an agent tool; nothing here is
// reachable by the model. See docs/TERMINAL.md.

// Client → server. Open a new PTY session for `workflowId`, rooted at `cwd`
// (a directory inside the workflow root — the server resolves it through
// resolveWithinCwd and refuses an escape). `cwd` omitted ⇒ workflow root.
export interface TerminalOpenMessage {
  type: 'terminal_open';
  workflowId: string;
  cwd?: string;
}

// Client → server. Explicit Kill — reap the shell. (Closing the window only
// detaches; this is the one operator action that ends the session from the
// control plane. The window can also kill via the `/terminal` channel.)
export interface TerminalKillMessage {
  type: 'terminal_kill';
  workflowId: string;
  sessionId: string;
}

// Client → server. Ask for the live session list for a workflow (§K2). The
// server replies with `terminal_sessions` from the live ptyManager pool — the
// source of truth, since PTYs don't survive a server restart, so replaying the
// events.jsonl `terminal_opened` history would list dead sessions. Used to
// populate the multi-session switcher and to repopulate after a client
// reconnect (the server also re-emits `terminal_sessions` on rehydrate).
export interface TerminalListMessage {
  type: 'terminal_list';
  workflowId: string;
}

// Client → server. An operator-submitted command line (captured on Enter in
// the xterm view). Logged to events.jsonl for visibility — the raw stream is
// not. Best-effort: empty / whitespace-only lines are dropped client-side.
export interface TerminalCommandMessage {
  type: 'terminal_command';
  workflowId: string;
  sessionId: string;
  command: string;
}

// Server → client. A session was opened. Persisted to events.jsonl (lifecycle
// visibility). The client uses `sessionId` to attach over `/terminal`.
export interface TerminalOpenedMessage {
  type: 'terminal_opened';
  workflowId: string;
  sessionId: string;
  cwd: string;
  shell: string;
  // §K2 — human-facing switcher label (`shell N`, or the cwd basename when a
  // non-root cwd was requested). Optional for back-compat with replayed K1
  // events that predate the field.
  label?: string;
  ts: number;
}

// One session in a `terminal_sessions` list (§K2). Mirrors the server's
// PtySessionInfo. No raw stream / scrollback — those ride `/terminal`.
export interface TerminalSessionInfo {
  sessionId: string;
  label: string;
  cwd: string;
  createdAt: number;
}

// Server → client. The live session list for a workflow (§K2). Sent in reply
// to `terminal_list` AND on rehydrate so a reconnecting client recovers its
// session switcher. NOT persisted to events.jsonl — it's live pool state.
export interface TerminalSessionsMessage {
  type: 'terminal_sessions';
  workflowId: string;
  sessions: TerminalSessionInfo[];
}

// Server → client. A session ended (operator Kill, workflow close, shell exit,
// or shutdown). Persisted to events.jsonl. `reason` aids transcript review.
export interface TerminalKilledMessage {
  type: 'terminal_killed';
  workflowId: string;
  sessionId: string;
  reason: 'operator-kill' | 'workflow-close' | 'shell-exit' | 'shutdown';
  ts: number;
}

// Server → client. Echo of an operator-run command line. Persisted to
// events.jsonl. Mirrors the client's terminal_command so reconnects replay it.
export interface TerminalCommandLoggedMessage {
  type: 'terminal_command_logged';
  workflowId: string;
  sessionId: string;
  command: string;
  ts: number;
}
