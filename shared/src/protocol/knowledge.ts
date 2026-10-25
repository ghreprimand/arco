// ── Knowledge base (WORKBENCH_EXPANSION_PLAN.md §B3) ──
//
// A per-cwd, OPERATOR-OWNED knowledge store at <cwd>/.archon/knowledge/. A
// curated, editable companion to CLAUDE.md (repo layout, gotchas, deploy
// steps) that the operator builds up instead of re-explaining each session.
// Articles flagged `alwaysInclude` fold into the next turn's system prompt as
// a BOUNDED block (capped at KNOWLEDGE_INJECT_BUDGET, truncation-noticed).
//
// THE FENCE (CLAUDE.md hard fences + plan Appendix B). This subsystem is the
// sanctioned, operator-in-the-loop REPLACEMENT for the *rejected* self-writing
// memory / curator pattern. The line is bright:
//   - Nothing is EVER auto-saved to the KB by an LLM. CRUD is operator-driven.
//   - The wizard's "distill from this session" step has an agent DRAFT an
//     article from the transcript; the agent only proposes text — the operator
//     edits and explicitly Saves it (a normal create/update). No auto-commit,
//     no background curation, no "learn from this session" automation.
//   - Bounded injection + on-disk visibility (operator-readable markdown) are
//     what clear the four-question test.
//
// CRUD goes over REST (GET/POST/PATCH/DELETE /api/knowledge) — it's per-cwd,
// not workflow-scoped, mirroring the Plans REST surface. Only the distill
// DRAFT (which spawns a bounded read-only worker) rides the workflow WS, so its
// lifecycle is visible in events.jsonl.

import type { EffortLevel, ModelName, ProviderName } from './providers.js';

// Hard cap on the combined always-include block folded into the system prompt.
// Load-bearing: the KB can NEVER silently bloat the turn's context. When the
// always-include set exceeds this, the block is truncated and an explicit
// notice is appended (mirrors the D1 contextRefs cap-with-notice discipline).
// Shown in the Knowledge tab UI so the operator sees how close they are.
export const KNOWLEDGE_INJECT_BUDGET = 24 * 1024; // 24 KB

// Per-article body cap (defensive — a single article can't blow the budget
// alone, and keeps index/body files sane). Title/tags are separately bounded
// server-side.
export const KNOWLEDGE_BODY_MAX = 64 * 1024;

// Context cap on the transcript handed to the distill drafter, so the bounded
// turn stays scoped. Enforced server-side.
export const KNOWLEDGE_DISTILL_CONTEXT_LIMIT = 48 * 1024;

export interface KnowledgeArticleSummary {
  id: string;
  title: string;
  tags: string[];
  // Always-include articles fold into every turn's system prompt (bounded);
  // on-demand articles are operator-readable in the tab but not injected.
  alwaysInclude: boolean;
  createdAt: number;
  updatedAt: number;
  // Byte length of the markdown body — lets the tab show per-article cost and
  // the running always-include total against KNOWLEDGE_INJECT_BUDGET without a
  // body fetch per row.
  bytes: number;
}

export interface KnowledgeArticle extends KnowledgeArticleSummary {
  body: string;
}

// GET /api/knowledge?path=<cwd> → list (summaries only; bodies fetched per-id).
export interface KnowledgeListResponse {
  articles: KnowledgeArticleSummary[];
  // Running always-include total + the cap, so the tab renders the budget bar
  // without summing client-side (and stays the single source of truth).
  alwaysIncludeBytes: number;
  budget: number;
}

// GET /api/knowledge/body?path=<cwd>&id=<id> → one full article.
export interface KnowledgeBodyResponse {
  article: KnowledgeArticle;
}

// POST /api/knowledge?path=<cwd> body { title, body, tags, alwaysInclude }.
export interface KnowledgeCreateRequest {
  title: string;
  body: string;
  tags?: string[];
  alwaysInclude?: boolean;
}

// PATCH /api/knowledge?path=<cwd>&id=<id> — any subset.
export interface KnowledgeUpdateRequest {
  title?: string;
  body?: string;
  tags?: string[];
  alwaysInclude?: boolean;
}

// ── Distill-from-session DRAFT (WS, workflow-scoped) ──
// The ONLY LLM involvement in the KB. Spawns a bounded, READ-ONLY worker that
// reads the current transcript and proposes a draft article (title + body +
// tag suggestions). The agent NEVER saves — `knowledge_distill_proposed` lands
// in the wizard as editable fields the operator reviews and Saves via the
// normal create endpoint. Mirrors runDocEdit.ts (propose-then-operator-approve).
export interface KnowledgeDistillRequestMessage {
  type: 'knowledge_distill_request';
  workflowId: string;
  // Who drafts — RUN AS picker output, resolved like the reviewer / doc-edit
  // path. Reviewers/seeds never call this; it's operator-button-only.
  drafter: {
    provider: ProviderName;
    model: ModelName;
    effort: EffortLevel;
    providerAccountRef?: string;
  };
  // Optional operator steer ("focus on the deploy steps", "capture the gotcha
  // we just hit"). Folded into the drafter's framing.
  focus?: string;
}

export interface KnowledgeDistillStartedMessage {
  type: 'knowledge_distill_started';
  workflowId: string;
  distillId: string;
  startedAt: number;
}

// The DRAFT (server→client). Lands in the wizard's editable fields. Nothing is
// persisted — the operator edits then Saves through POST /api/knowledge.
export interface KnowledgeDistillProposedMessage {
  type: 'knowledge_distill_proposed';
  workflowId: string;
  distillId: string;
  // Proposed, editable. `title` is best-effort extracted from the draft's H1.
  title: string;
  body: string;
  tags: string[];
  error?: string;
  completedAt: number;
}
