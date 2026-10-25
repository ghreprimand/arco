// Workbench Expansion §F1 — Recall index protocol types.
//
// Recall is a machine-global, cross-cwd index of every workflow ever run — a
// deterministic PROJECTION of each workflow's meta.json + events.jsonl, never
// a model of the operator (see docs/RECALL.md "fence-clearance"). F1 ships the
// index + non-blank title chain; summaries (summaryRef) are F2, tags are F4 —
// both columns exist now so those phases don't migrate the table.

import type { EffortLevel, ModelName, ProviderName } from './providers.js';

// One indexed conversation. Mirrors the SQLite `entries` row shape.
export interface RecallEntry {
  // Archon workflow id — the index primary key (upsert target).
  wfid: string;
  // Absolute cwd the workflow ran under (the .archon/workflows root).
  cwd: string;
  // Human-facing project label — the cwd's basename.
  project: string;
  provider: ProviderName;
  // Never blank. Resolved via the fallback chain (ai-title → first operator
  // message → `<provider> · <project> · <date>`).
  title: string;
  createdAt: number;
  lastActiveAt: number;
  // Count of operator turns (user_message_echo events) seen in events.jsonl.
  turnCount: number;
  // F2 — id/ref of a generated summary. Null until F2 ships.
  summaryRef: string | null;
  // F4 — operator tags. Empty until F4 ships.
  tags: string[];
  // F4 — operator-set "pin as memory" flag. The operator MANUALLY marks one of
  // their OWN conversations as important; pinned entries sort to the top + get a
  // filter. NOT the fenced self-writing-memory pattern (no LLM, no auto-profile)
  // — see docs/RECALL.md § Pin-as-memory vs the fenced pattern. Default false.
  pinned: boolean;
  // F4 — operator-curated links from this conversation to KB articles / tasks.
  // A local link list (E2's task link primitive isn't built yet; this degrades
  // gracefully — task links just carry an id with no resolver). Reversible
  // (removeLink). Default [].
  links: RecallLink[];
}

// F4 — one operator-curated link from a recall entry to another Archon artifact.
// `kb` links to a B3 knowledge article (id is the article id, resolved within
// the entry's cwd — articles are cwd-scoped). `task` links to an E2 task (id is
// the task id) — the E-track isn't built yet, so task links persist but have no
// resolver UI; they degrade to an inert id until E2 ships.
export interface RecallLink {
  type: 'kb' | 'task';
  id: string;
}

// GET /api/recall/index — optional ?project / ?provider filters.
export interface RecallIndexQuery {
  project?: string;
  provider?: ProviderName;
}

export interface RecallIndexResponse {
  entries: RecallEntry[];
}

// ── §F3 — global search surface ──
//
// Where in the entry a query matched. 'title' | 'summary' | 'tags' come from
// the FTS5 virtual table (the must-have); 'transcript' comes from the optional
// ripgrep pass over events.jsonl (operator-toggle, default OFF — bigger scan).
export type RecallMatchField = 'title' | 'summary' | 'tags' | 'transcript';

// One ranked search hit. A thin projection of the matched RecallEntry plus the
// snippet + where-it-matched, so the client renders the result row without a
// second index fetch.
export interface RecallSearchHit {
  wfid: string;
  title: string;
  project: string;
  provider: ProviderName;
  cwd: string;
  lastActiveAt: number;
  // F2 — null until summaries ship; the "open summary" action degrades to a
  // "no summary yet" state when this is null.
  summaryRef: string | null;
  // A short excerpt with the match highlighted via FTS5 snippet() (FTS side)
  // or the matched transcript line (ripgrep side). May be empty for a bare
  // recent-list response (empty q).
  snippet: string;
  matchedIn: RecallMatchField;
  // §F4 — operator-curated state, projected onto the hit so the result row can
  // render tag chips, the pin state, and links (and mutate them) without a
  // second index fetch. The F4 mutation routes return the full RecallEntry; the
  // client folds the changed fields back onto the matching hit.
  tags: string[];
  pinned: boolean;
  links: RecallLink[];
}

// GET /api/recall/search?q&project&provider&from&to[&transcripts=1]
export interface RecallSearchQuery {
  q?: string;
  project?: string;
  provider?: ProviderName;
  // Inclusive epoch-ms bounds on lastActiveAt. Either may be omitted.
  from?: number;
  to?: number;
  // Operator toggle — include the ripgrep transcript full-text pass. Default
  // false (the title/summary/tag FTS5 search is the must-have; transcript scan
  // is the heavier opt-in).
  includeTranscripts?: boolean;
}

export interface RecallSearchResponse {
  hits: RecallSearchHit[];
  // False when transcript search was requested but ripgrep isn't on PATH — the
  // client shows a "rg unavailable" hint rather than silently dropping the
  // transcript dimension. True (or absent) otherwise.
  transcriptsAvailable?: boolean;
}

// ── §F2 — conversation summaries ──
//
// A durable, dense recap of one conversation — "a point in time I can go back
// to." Generated ONLY on operator action (the Recall row's Summarize button) or
// operator-armed-on-close (a default-OFF toggle); NEVER in the agent turn loop.
//
// FENCE-CLEARANCE (CLAUDE.md hard fences, docs/RECALL.md Part F): the rejected
// pattern is *second-LLM summarization in the agent loop* (`distill` — doubles
// spend, fails closed). F2 clears it because the summary is a one-off,
// operator-triggered artifact with a DETERMINISTIC fallback (`summarizePriorTurns`
// digest) so it never fails closed, the full transcript stays the source of
// truth, and it is reversible (delete `~/.archon/recall/<wfid>/summary.md`).

// Client → Server: generate (or regenerate) a summary for one workflow. The
// summarizer config is resolved exactly like the reviewer / researcher config
// (the RUN AS picker, or the conversation's own primary). Sent from the Recall
// view's per-row Summarize action, or by the operator-armed on-close hook.
export interface RecallSummaryRequestMessage {
  type: 'recall_summary_request';
  wfid: string;
  summarizer: {
    provider: ProviderName;
    model: ModelName;
    effort: EffortLevel;
    providerAccountRef?: string;
  };
}

// Server → Client: the summary settled. `ok` distinguishes the bounded-LLM
// path (true) from the deterministic-fallback path (false) so the UI can label
// a degraded summary honestly — a failed LLM call is NOT an error here, it
// degrades to the structural digest. `summaryRef` is the stable ref stored in
// the index (`<wfid>/summary.md`); the client fetches the body via
// GET /api/recall/summary?wfid=<wfid>. Not workflow-scoped (no `workflowId`) —
// it's a global Recall event, routed to the recall store, not events.jsonl.
export interface RecallSummaryReadyMessage {
  type: 'recall_summary_ready';
  wfid: string;
  summaryRef: string | null;
  // true = bounded LLM summary; false = deterministic fallback digest.
  ok: boolean;
  error?: string;
}

// ── §F4 — tags + pin-as-memory + links ──
//
// All F4 mutations are operator-initiated HTTP routes (POST/DELETE under
// /api/recall/*), land in the persisted recall index, and are reversible
// (untag / unpin / unlink). No LLM is involved — pin-as-memory is the operator
// MANUALLY marking one of their OWN conversations as important, NOT the fenced
// self-writing memory pattern (which is an LLM auto-profiling the operator).
// Each mutation returns the updated entry so the client refreshes from the
// server's truth without a re-fetch.

// POST /api/recall/tags  { wfid, tags } → replaces the entry's tag set.
export interface RecallSetTagsRequest {
  wfid: string;
  tags: string[];
}

// POST /api/recall/pin  { wfid, pinned } → sets/clears the pin-as-memory flag.
export interface RecallSetPinnedRequest {
  wfid: string;
  pinned: boolean;
}

// POST /api/recall/link  { wfid, link } → adds a link (deduped on type+id).
// DELETE /api/recall/link  { wfid, link } → removes it. Both return the entry.
export interface RecallLinkRequest {
  wfid: string;
  link: RecallLink;
}

// Shared response shape for all three mutations — the updated entry.
export interface RecallEntryResponse {
  entry: RecallEntry;
}

// GET /api/recall/backlinks?type=kb&id=<id>&cwd=<cwd> → conversations linking
// to that artifact. cwd is required for kb links (articles are cwd-scoped);
// optional otherwise.
export interface RecallBacklinksResponse {
  entries: RecallEntry[];
}
