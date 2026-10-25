// ── Deep Research primitive (WORKBENCH_EXPANSION_PLAN.md §B2) ──
//
// An operator-initiated, bounded, agent-agnostic research run. The server
// spawns a short-lived worker (read-only local tools + the provider's native
// web-search/web-fetch tool path) with a research-structured prompt that asks
// the model to plan → search → read → synthesize a CITED markdown report
// inside ONE bounded native agentic turn. Output is persisted as a
// `research-<ts>.md` artifact and surfaced in the RESEARCH tab.
//
// Fence note (CLAUDE.md "hard fences"): there is NO orchestrator LLM, NO
// second-LLM synthesis, and NO LLM "is it done?" judge. The "bounded rounds"
// map to the provider's natural bounded tool-use iterations; Archon enforces a
// HARD ceiling (`maxRounds`, default 4 — translated to web-tool `max_uses`)
// and the model's own "sufficient" signal is advisory only. One provider, one
// bounded turn. Operator-initiated + bounded + artifact-reviewed ⇒ clears the
// four-question test.

import type { EffortLevel, ModelName, ProviderName } from './providers.js';

// Hard ceiling on research breadth. Drives the web-tool `max_uses` budget and
// is stated in the prompt as the non-negotiable stop. Operator-set; clamped to
// [1, RESEARCH_MAX_ROUNDS_CEILING] server-side.
export const RESEARCH_DEFAULT_ROUNDS = 4;
export const RESEARCH_MAX_ROUNDS_CEILING = 10;

export interface ResearchRequestMessage {
  type: 'research_request';
  workflowId: string;
  // Who runs the research turn. Resolved exactly like the reviewer config —
  // the dialog's RUN AS picker fills this. For an in-tab run it matches the
  // tab's primary; for a new-tab run the client spawns a fresh tab and that
  // tab issues its own research_request once created.
  researcher: {
    provider: ProviderName;
    model: ModelName;
    effort: EffortLevel;
    providerAccountRef?: string;
  };
  // The operator's research question / brief.
  topic: string;
  // Hard round ceiling (web-tool max_uses). Clamped server-side.
  maxRounds: number;
  // Dig-deeper mode. When set, this is a follow-up against an EXISTING report:
  // the worker is seeded with the prior report body + its cited sources and is
  // told to APPEND a dated addendum to the same artifact rather than start
  // fresh. `followUp` carries the operator's narrow question ("expand point 3",
  // "find counter-evidence", "what did source X say?").
  seedArtifactName?: string;
  followUp?: string;
}

// Cancel an in-flight research run. Mirrors cancel_review — kills the worker,
// which resolves runResearch's settled promise with an error and fires the
// usual research_complete with an error field.
export interface CancelResearchMessage {
  type: 'cancel_research';
  workflowId: string;
  researchId: string;
}

// ── Research events (all workflow-scoped → persisted to events.jsonl) ──

export interface ResearchStartedMessage {
  type: 'research_started';
  workflowId: string;
  researchId: string;
  researcher: {
    provider: ProviderName;
    model: ModelName;
    effort: EffortLevel;
    providerAccountRef?: string;
  };
  topic: string;
  maxRounds: number;
  // True when this run appends to an existing artifact (dig-deeper).
  isFollowUp: boolean;
  artifactName: string;
  startedAt: number;
}

// Coarse progress signal. Emitted when the worker invokes a web-search /
// web-fetch tool so the RESEARCH tab can show "searching… (n)" without parsing
// raw tool events. Round is the running tool-invocation count (advisory; the
// per-turn Activity stream remains the authoritative tool log).
export interface ResearchProgressMessage {
  type: 'research_progress';
  workflowId: string;
  researchId: string;
  round: number;
  note: string;
}

export interface ResearchCompleteMessage {
  type: 'research_complete';
  workflowId: string;
  researchId: string;
  artifactName: string;
  // Tool-invocation count the run actually used (≤ maxRounds budget).
  roundsUsed: number;
  // Source URLs extracted from the report's citations, best-effort.
  sourceCount: number;
  isFollowUp: boolean;
  error?: string;
  completedAt: number;
}
