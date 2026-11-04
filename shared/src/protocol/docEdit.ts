// -- AI-collaborative document editing (docs/ARCHITECTURE.md) --
//
// A scoped, reviewable edit assist layered on the A6 editor. The operator
// selects a region (or Select-All for whole-doc), picks an agent via the
// existing RUN AS picker, and types an instruction. The server spawns a
// SHORT-LIVED, READ-ONLY worker (NO Write/Edit tool — text output only) and
// asks it to return a replacement for JUST that selection. The proposal comes
// back as `doc_edit_proposed`; the client previews it as an A3 diff and the
// operator Accepts (splice into the buffer — buffer only, nothing on disk) or
// Rejects. The existing A6 Save persists to disk through the
// `resolveWithinCwd`-guarded write endpoint.
//
// Fence note (CLAUDE.md "hard fences"): the agent PROPOSES, the operator
// APPROVES twice — once into the buffer (Accept), again on the guarded Save.
// The agent has NO Write tool and never touches disk. NO orchestrator LLM, NO
// second-LLM judge, ONE bounded turn per proposal. Operator-initiated +
// bounded + reversible at both levels (Reject discards; Accept is buffer-only;
// the A2 checkpoint covers the on-disk save) ⇒ clears the four-question test.

import type { EffortLevel, ModelName, ProviderName } from './providers.js';

// Cap on the surrounding context the client sends per side, so the prompt stays
// scoped. Enforced client-side (slice) AND server-side (defensive re-clamp).
export const DOC_EDIT_CONTEXT_LIMIT = 2048;

export interface DocEditRequestMessage {
  type: 'doc_edit_request';
  workflowId: string;
  // Who runs the edit turn — RUN AS picker output, resolved like the reviewer /
  // research config. In-tab path only for A7 (the proposal must round-trip to
  // THIS editor buffer), so this matches the tab's primary.
  editor: {
    provider: ProviderName;
    model: ModelName;
    effort: EffortLevel;
    providerAccountRef?: string;
  };
  // The open file's path — context/logging only. The agent writes nothing, so
  // this is never resolved to a write target server-side.
  filePath: string;
  // The selected text the agent rewrites. For a whole-doc edit this is the
  // entire buffer and `wholeDoc` is true.
  selectionText: string;
  // Buffer offsets of the selection. The SERVER just echoes these back in the
  // proposal so the CLIENT knows which range to splice the replacement into.
  selectionFrom: number;
  selectionTo: number;
  // Bounded surrounding text (≤ DOC_EDIT_CONTEXT_LIMIT each) the client
  // extracts so the agent has local context without the whole file.
  contextBefore: string;
  contextAfter: string;
  // The operator's edit instruction ("tighten this", "fix the formatting", …).
  instruction: string;
  // True when the selection is the whole document (Select-All path).
  wholeDoc: boolean;
}

// Optional symmetry/progress signal — fired when the edit worker is spawned.
export interface DocEditStartedMessage {
  type: 'doc_edit_started';
  workflowId: string;
  docEditId: string;
  filePath: string;
  editor: {
    provider: ProviderName;
    model: ModelName;
    effort: EffortLevel;
    providerAccountRef?: string;
  };
  startedAt: number;
}

// The proposal (server→client). `replacement` is the proposed text for JUST the
// selection (not the whole file). `selectionFrom`/`selectionTo` are echoed so
// the client applies it to the exact range. On failure `error` is set and
// `replacement` is empty.
export interface DocEditProposedMessage {
  type: 'doc_edit_proposed';
  workflowId: string;
  docEditId: string;
  filePath: string;
  selectionFrom: number;
  selectionTo: number;
  replacement: string;
  error?: string;
  completedAt: number;
}
