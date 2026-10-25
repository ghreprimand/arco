import { create } from 'zustand';

// WORKBENCH_EXPANSION §K1/§K2 — floating terminal window state.
//
// Kept OUT of appStore: the terminal's raw byte stream rides a dedicated
// `/terminal` WS path (not the seq'd `/ws` protocol), and windows are
// non-persisted overlays. This store tracks (a) the open floating WINDOWS
// (§K2 — N at once, each viewing one session, two may share a session), and
// (b) the per-workflow SESSION LIST learned from terminal_opened /
// terminal_sessions. Sessions are server-owned, long-lived resources (they
// outlive their windows); a window re-attaches by sessionId.

export interface TerminalOpenRequest {
  workflowId: string;
  // Directory to root a NEW session in (defaults to workflow root server-side
  // when omitted). The two entry points differ only in this value.
  cwd?: string;
}

// A live session, as the switcher sees it. Mirrors the server's PtySessionInfo.
export interface TerminalSession {
  sessionId: string;
  label: string;
  cwd: string;
  createdAt: number;
}

// One open floating window. Several can be open; two may point at the same
// sessionId (the server multi-listener fans output to both).
export interface TerminalWindow {
  // Stable per-window id (NOT the sessionId — a window can switch sessions).
  windowId: string;
  workflowId: string;
  // The session this window is currently viewing. null = "spawning / pick one":
  // the window will ask the server to open a session (with `pendingCwd`) or
  // attach to the workflow's first existing session.
  sessionId: string | null;
  // cwd staged for a NOT-yet-spawned session (set by an open request that
  // forces a fresh spawn). Cleared once the spawn's terminal_opened lands.
  pendingCwd?: string;
  // §K3 — a command staged for pre-fill on this window's session input line.
  pendingPrefill?: string;
}

let windowSeq = 0;
function nextWindowId(): string {
  windowSeq += 1;
  return `tw-${Date.now().toString(36)}-${windowSeq.toString(36)}`;
}

interface TerminalState {
  // Open floating windows (§K2 — N at once).
  windows: TerminalWindow[];
  // Per-workflow live session list (for the switcher), learned from
  // terminal_opened (append) / terminal_sessions (replace) / terminal_killed
  // (remove).
  sessionsByWorkflow: Record<string, TerminalSession[]>;

  // Launcher / Files entry points. Reuses the workflow's existing window if one
  // is open (raises it implicitly via React remount order); otherwise opens a
  // new window. The window attaches to the workflow's existing session, or — if
  // none — spawns one rooted at `cwd`. This preserves K1's "reuse the single
  // session" behavior for the non-"+ new shell" entry points.
  openTerminal: (req: TerminalOpenRequest) => void;
  // §K2 — ALWAYS spawn a fresh session in a (new) window. The "+ new shell"
  // action. `cwd` optional (defaults to workflow root server-side).
  newSession: (workflowId: string, cwd?: string) => void;
  // Close one window (DETACH — the shell lives on). By windowId.
  closeWindow: (windowId: string) => void;
  // Point an open window at a different session (switcher).
  switchWindowSession: (windowId: string, sessionId: string) => void;
  // A window's spawn landed: bind the new sessionId to whichever window is
  // waiting on a spawn for this workflow (pendingCwd set, sessionId null).
  bindSpawnedSession: (workflowId: string, sessionId: string) => void;

  // Session-list maintenance, driven by the WS dispatch.
  addSession: (workflowId: string, session: TerminalSession) => void;
  removeSession: (workflowId: string, sessionId: string) => void;
  setSessions: (workflowId: string, sessions: TerminalSession[]) => void;

  // §K3 — the chat chip: open/raise a window for the workflow AND stage the
  // command for pre-fill on its session.
  prefillInTerminal: (workflowId: string, command: string) => void;
  consumePrefill: (windowId: string) => string | null;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  windows: [],
  sessionsByWorkflow: {},

  openTerminal: (req) =>
    set((s) => {
      // Reuse an open window for this workflow if one exists (raise/focus).
      const existing = s.windows.find((w) => w.workflowId === req.workflowId);
      if (existing) return s;
      const sessions = s.sessionsByWorkflow[req.workflowId] ?? [];
      // Attach to the workflow's first existing session if any; else spawn.
      const first = sessions[0]?.sessionId ?? null;
      const win: TerminalWindow = {
        windowId: nextWindowId(),
        workflowId: req.workflowId,
        sessionId: first,
        pendingCwd: first ? undefined : (req.cwd ?? ''),
      };
      return { windows: [...s.windows, win] };
    }),

  newSession: (workflowId, cwd) =>
    set((s) => {
      const win: TerminalWindow = {
        windowId: nextWindowId(),
        workflowId,
        sessionId: null,
        // '' (not undefined) marks "spawn requested" even when cwd is the root.
        pendingCwd: cwd ?? '',
      };
      return { windows: [...s.windows, win] };
    }),

  closeWindow: (windowId) =>
    set((s) => ({ windows: s.windows.filter((w) => w.windowId !== windowId) })),

  switchWindowSession: (windowId, sessionId) =>
    set((s) => ({
      windows: s.windows.map((w) =>
        w.windowId === windowId ? { ...w, sessionId, pendingCwd: undefined } : w,
      ),
    })),

  bindSpawnedSession: (workflowId, sessionId) =>
    set((s) => {
      // Find the oldest window for this workflow still waiting on a spawn.
      const waiting = s.windows.find(
        (w) => w.workflowId === workflowId && w.sessionId === null && w.pendingCwd !== undefined,
      );
      if (!waiting) return s;
      return {
        windows: s.windows.map((w) =>
          w.windowId === waiting.windowId
            ? { ...w, sessionId, pendingCwd: undefined }
            : w,
        ),
      };
    }),

  addSession: (workflowId, session) =>
    set((s) => {
      const list = s.sessionsByWorkflow[workflowId] ?? [];
      if (list.some((x) => x.sessionId === session.sessionId)) return s;
      return {
        sessionsByWorkflow: {
          ...s.sessionsByWorkflow,
          [workflowId]: [...list, session].sort((a, b) => a.createdAt - b.createdAt),
        },
      };
    }),

  removeSession: (workflowId, sessionId) =>
    set((s) => {
      const list = s.sessionsByWorkflow[workflowId] ?? [];
      const next = list.filter((x) => x.sessionId !== sessionId);
      // Windows viewing the killed session fall back to "no session" — the
      // window stays open showing the exit/empty state; the operator can pick
      // another session from the switcher or close it.
      const windows = s.windows.map((w) =>
        w.sessionId === sessionId ? { ...w, sessionId: null } : w,
      );
      return {
        sessionsByWorkflow: { ...s.sessionsByWorkflow, [workflowId]: next },
        windows,
      };
    }),

  setSessions: (workflowId, sessions) =>
    set((s) => {
      const sorted = [...sessions].sort((a, b) => a.createdAt - b.createdAt);
      // Reconcile open windows: any window whose session no longer exists (e.g.
      // server restarted and the old sessions are gone) drops to null.
      const live = new Set(sorted.map((x) => x.sessionId));
      const windows = s.windows.map((w) =>
        w.sessionId && !live.has(w.sessionId) ? { ...w, sessionId: null } : w,
      );
      return {
        sessionsByWorkflow: { ...s.sessionsByWorkflow, [workflowId]: sorted },
        windows,
      };
    }),

  prefillInTerminal: (workflowId, command) =>
    set((s) => {
      const existing = s.windows.find((w) => w.workflowId === workflowId);
      if (existing) {
        return {
          windows: s.windows.map((w) =>
            w.windowId === existing.windowId ? { ...w, pendingPrefill: command } : w,
          ),
        };
      }
      // No window open — open one (attach existing session, else spawn root)
      // and stage the prefill on it.
      const sessions = s.sessionsByWorkflow[workflowId] ?? [];
      const first = sessions[0]?.sessionId ?? null;
      const win: TerminalWindow = {
        windowId: nextWindowId(),
        workflowId,
        sessionId: first,
        pendingCwd: first ? undefined : '',
        pendingPrefill: command,
      };
      return { windows: [...s.windows, win] };
    }),

  consumePrefill: (windowId) => {
    const win = get().windows.find((w) => w.windowId === windowId);
    const cmd = win?.pendingPrefill ?? null;
    if (cmd != null) {
      set((s) => ({
        windows: s.windows.map((w) =>
          w.windowId === windowId ? { ...w, pendingPrefill: undefined } : w,
        ),
      }));
    }
    return cmd;
  },
}));
