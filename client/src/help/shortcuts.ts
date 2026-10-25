// Keyboard-shortcut registry — the single source of truth for the in-app
// cheat sheet (Cmd/Ctrl+? → ShortcutCheatSheet) and the manual's Reference
// "Keyboard shortcuts" section.
//
// IMPORTANT: this registry is a DOCUMENTATION surface. It does NOT drive the
// handlers — the real keydown listeners live in App.tsx (global hotkeys),
// CommandPalette / RecallView (modal nav), TerminalInput (composer), and the
// individual modals (Escape-to-close). When you add or change a global
// shortcut, register it here too so the cheat sheet and manual stay honest.
// Do not wire the handlers to consume this array (deliberately out of scope —
// it would couple presentation to behavior and risk regressions).

export interface Shortcut {
  combo: string;
  label: string;
  group: string;
}

export const SHORTCUTS: Shortcut[] = [
  // ── Global ──
  { group: 'Global', combo: 'Ctrl/Cmd+K', label: 'Open the workflow creator (new tab) — only when focus is outside a text field (inside a composer Ctrl+K kills to end of line).' },
  { group: 'Global', combo: 'Ctrl/Cmd+P', label: 'Toggle the command palette — search tabs, files, transcript, commands (prefix > for ripgrep content search).' },
  { group: 'Global', combo: 'Ctrl/Cmd+?', label: 'Toggle this keyboard-shortcut cheat sheet.' },

  // ── Command palette / Recall ──
  { group: 'Command palette & Recall', combo: '↑ / ↓', label: 'Move the selection up / down through results.' },
  { group: 'Command palette & Recall', combo: 'Enter', label: 'Open the highlighted result.' },
  { group: 'Command palette & Recall', combo: 'Esc', label: 'Close the palette / Recall view.' },
  { group: 'Command palette & Recall', combo: '>', label: 'In the command palette, prefix the query to switch to file-content (ripgrep) search.' },

  // ── Composer ──
  { group: 'Composer', combo: 'Enter', label: 'Send the composer (or enqueue as a steer while a turn is in flight).' },
  { group: 'Composer', combo: 'Shift+Enter', label: 'Insert a newline without sending.' },
  { group: 'Composer', combo: 'Ctrl/Cmd+Enter', label: 'While Claude or Codex is busy, interrupt and send the draft next; preserve queued messages.' },
  { group: 'Composer', combo: 'Alt+Enter', label: 'While a turn is in flight, enqueue as a follow-up (lands after the current turn). No-op when idle.' },
  { group: 'Composer', combo: 'Alt+↑', label: 'Recall the most recently queued message into the editor.' },
  { group: 'Composer', combo: 'Ctrl+K', label: 'Kill from the cursor to end of line (readline-style; no clipboard). Agent and Chat composers.' },
  { group: 'Composer', combo: 'Esc', label: 'Cancel the in-flight turn (asks first if messages are queued), or clear a queued message when the editor is empty.' },
  { group: 'Composer', combo: 'Shift+Esc', label: 'Cancel the in-flight turn without the drop-queued-messages prompt.' },
  { group: 'Composer', combo: 'Ctrl/Cmd+V', label: 'Paste an image or file from the clipboard as an attachment (dropping a file anywhere works too; not in Incognito chats).' },

  // ── Chat tab ──
  { group: 'Chat tab', combo: 'Enter', label: 'Send the message (Send is disabled while a response is running — use Stop).' },
  { group: 'Chat tab', combo: 'Shift+Enter', label: 'Insert a newline without sending.' },
  { group: 'Chat tab', combo: 'Esc', label: 'Stop the response that is running (same as the ■ button).' },

  // ── GitHub panel ──
  { group: 'GitHub panel', combo: 't', label: 'In a repo CODE view, open Go-to-file (when focus is not in a text field).' },

  // ── Modals ──
  { group: 'Modals', combo: 'Esc', label: 'Close the active modal — Settings, Manual, this cheat sheet, the Review / Handoff / Spawn dialogs, the file viewer, etc.' },
];
