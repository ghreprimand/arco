// -- LSP diagnostics (docs/ARCHITECTURE.md) --
//
// After a Write/Edit in a Claude Native turn, the server lazy-spawns the
// project's language server (typescript-language-server / pyright / gopls /
// rust-analyzer — whichever is on PATH), opens the changed file, and forwards
// the server's `textDocument/publishDiagnostics` notification to the client as
// a workflow-scoped `diagnostics` message.
//
// LSP positions are 0-based (line + character); Arco's UI is 1-based. The
// conversion happens once, at the server→protocol mapping boundary
// (server/src/lsp/client.ts `mapPublishDiagnostics`), so every field below is
// already 1-based by the time it crosses the wire.
//
// Graceful degradation: if no language server is installed for the changed
// file's language, the subsystem is a silent no-op — no message, no error.
// The operator installs the upstream language server themselves (same pattern
// as the caveman output style). See docs/LSP.md.

export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

// One diagnostic, already converted to Arco's 1-based line/column model.
export interface DiagnosticItem {
  severity: DiagnosticSeverity;
  message: string;
  // 1-based line + column of the diagnostic's start (converted from LSP's
  // 0-based range.start at the mapping boundary).
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  // LSP `source` ("ts", "rust-analyzer", etc.) and `code` (rule id) when the
  // server supplies them; both optional.
  source?: string;
  code?: string | number;
}

// Server→client, workflow-scoped. Replaces (not accumulates) the prior set for
// `file`: a publishDiagnostics with an empty array clears the file's
// diagnostics, which is how "fix the error and it disappears" works.
export interface DiagnosticsMessage {
  type: 'diagnostics';
  workflowId: string;
  // cwd-relative path of the file the diagnostics belong to.
  file: string;
  items: DiagnosticItem[];
}
