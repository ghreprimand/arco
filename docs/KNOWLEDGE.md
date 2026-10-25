# Arco — knowledge base (B3)

A per-cwd, **operator-owned** knowledge store under `<cwd>/.arco/knowledge/` that turns can read — a curated, editable companion to `CLAUDE.md` (repo layout, gotchas, deploy steps, conventions) the operator builds up instead of re-explaining each session. Articles flagged **always include** fold into the next turn's system prompt as a **bounded** block.

Implemented in `server/src/knowledge/` (`store.ts`, `distill.ts`), exposed over REST (`server/src/http/knowledgeRoutes.ts`) and one workflow-scoped WS pair (`server/src/ws/knowledgeHandlers.ts`). Client surfaces: `client/src/components/RightPanel/KnowledgeTab.tsx` + `KnowledgeWizard.tsx`, store `client/src/stores/knowledgeDistillStore.ts`. Protocol types in `shared/src/protocol/knowledge.ts`.

---

## The fence (read this first)

B3 is the sanctioned, operator-in-the-loop **replacement** for the *rejected* self-writing memory / curator pattern (see `CLAUDE.md` hard fences and `WORKBENCH_EXPANSION_PLAN.md` Appendix B). The line is bright:

- **Nothing is ever auto-saved to the KB by an LLM.** CRUD is operator-driven (UI buttons → REST). No agent reaches a write path — the store has no awareness of distillation at all.
- The wizard's **"distill from session"** step has an agent *draft* an article from the current transcript. The agent has **no Write/Edit tool** and no access to the store; the draft lands in the wizard's editable fields and the operator **edits and explicitly Saves** it (a normal create). No auto-commit, no background curation, no "learn from this session" automation.
- **Bounded injection + on-disk visibility** (operator-readable markdown bodies) are what clear the four-question test: operator-initiated, deterministic, visible in `events.jsonl` (a `system_notice` with injected byte counts), and reversible (unflag/edit/delete).

The only LLM involvement anywhere in this subsystem is the optional drafting assist, always followed by an explicit human Save.

---

## Storage layout

```
<cwd>/.arco/knowledge/
  index.json     → { articles: [{ id, title, tags[], alwaysInclude, createdAt, updatedAt, bytes }] }
  <id>.md        → markdown body (one file per article)
```

Atomic temp+rename writes, cloned from `planStore.ts` / `workflowMeta.ts` (body written first, then index — an orphan body without an index entry is invisible rather than corrupting the list). Each article = `{ title, body (markdown), tags[], alwaysInclude: boolean }` + an id + timestamps + the body byte length (mirrored in the index so list/query stay O(N) with no per-row body read).

### The `load()/save()/query()` interface boundary

The store sits behind a deliberate three-primitive interface (`KnowledgeStore` in `store.ts`):

- `load(cwd, id)` → one full article (summary + body), or null.
- `save(cwd, article)` → upsert a full article.
- `query(cwd, { text?, alwaysIncludeOnly? })` → matching summaries (case-insensitive substring over title + tags; bodies are *not* scanned here).
- (`remove(cwd, id)` rounds out CRUD.)

Everything else — the CRUD helpers (`createArticle` / `updateArticle` / `deleteArticle` / `listArticles` / `readArticle`) and the injection builder — is built on top of these. **Why the boundary:** the KB is the one Arco subsystem with a real **SQLite+FTS5 future** if article count / search latency grows (per `WORKBENCH_EXPANSION_PLAN.md` Part E storage rationale). Keeping CRUD behind this interface makes that migration a single-file binding swap (`const store = jsonStore` → a SQLite-backed impl + a one-shot JSON→rows migration), not a rewrite. Until then, JSON/markdown keeps the KB consistent with the rest of the repo and the bodies diff-able.

---

## The bounded injection block

`buildKnowledgeBlock(cwd, budget = KNOWLEDGE_INJECT_BUDGET)` assembles the **always-include** articles into one block, folded into the turn's `appendSystemPrompt` in `server/src/ws/turnEngine.ts` (provider-agnostic — every primary provider that consumes `appendSystemPrompt` benefits; placed right after the CLAUDE.md discovery fold).

**Bounded is load-bearing.** The combined body is hard-capped at `KNOWLEDGE_INJECT_BUDGET` (24 KB, in `shared/src/protocol/knowledge.ts`). Articles are taken in `updatedAt` order (freshest-curated first wins the budget) until adding the next would overflow; when the set is truncated, an explicit notice naming the dropped count is appended. The KB can therefore **never silently bloat the turn's context**:

- The Knowledge tab shows a **budget bar** — the running always-include total against the cap (turns red + "over budget, will truncate" past the cap).
- On the first iteration of a turn, the server emits a `system_notice` (workflow-scoped → persisted to `events.jsonl`) reporting `included/total` articles and the **post-cap** byte count, so the four-question test's context visibility is satisfied. (Mirrors the D1 `contextRefs` cap-with-truncation-notice discipline.)

On-demand (not always-include) articles are operator-readable in the tab but never injected.

---

## The "Add from…" wizard

`KnowledgeWizard.tsx` offers three sources, all converging on the **same editable draft fields** The operator then Saves:

1. **Blank** — an empty draft.
2. **Quick link** — paste a URL and write a short summary. **The URL is NOT auto-fetched.** Arco has no SSRF-guarded fetch helper yet (the same reason D1's `@url:` is deferred); shipping an unreviewed SSRF surface in this phase is out of scope. This is a *manual quick-link*: the operator pastes the URL into the body and writes the summary. (If/when a guarded fetch lands, it must reject private/loopback/link-local ranges before this becomes auto-fetch.)
3. **Distill from this session** — fires `knowledge_distill_request` (WS). The server (`knowledgeHandlers.ts`) replays the transcript and spawns a bounded, **read-only** worker (`runDistill` in `distill.ts`, mirroring `runDocEdit.ts`) that proposes a draft article (H1 title + body + trailing `tags:` line, parsed by `parseDraft`). The draft returns as `knowledge_distill_proposed`, lands in the wizard's editable fields via `knowledgeDistillStore`, and **the operator must click Save** to persist (POST `/api/knowledge`). The agent has no write tool and the wizard makes the draft-only posture explicit ("Nothing is saved until you click Save").

---

## REST surface

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/knowledge?path=<cwd>[&q=<text>]` | List summaries + `{ alwaysIncludeBytes, budget }` |
| GET | `/api/knowledge/body?path=<cwd>&id=<id>` | One full article |
| POST | `/api/knowledge?path=<cwd>` | Create (`{ title, body, tags?, alwaysInclude? }`) |
| PATCH | `/api/knowledge?path=<cwd>&id=<id>` | Update (any subset) |
| DELETE | `/api/knowledge?path=<cwd>&id=<id>` | Delete |

CRUD is REST (not workflow-scoped WS) — it's per-cwd, mirroring the Plans surface. These are the **only** knowledge write paths and every one is operator-driven. Only the distill *draft* rides the workflow WS, so its lifecycle is visible in `events.jsonl`.

---

## Smoke

`scripts/smoke/knowledge.ts` (`npm run smoke:knowledge`, no dev server) exercises the store behind `load/save/query`, asserts an always-include article's **text appears in the assembled system prompt** (the acceptance assertion), that on-demand articles are *not* injected, that unflagging removes an article from injection, and that an over-budget always-include set **truncates with a notice** within the budget.

---

## Recall back-links (Workbench §F4)

An article can be linked from one or more **Recall** conversations — the source
conversations the operator distilled it from. The link is created by Recall's
**Distill to KB** action (see `docs/RECALL.md § Distill to KB`): when the
operator Saves the pre-filled draft, Recall creates a `kb` link
(`POST /api/recall/link` with `{ type: 'kb', id: <articleId> }`).

The KNOWLEDGE tab surfaces these as **Linked conversations** under each article
(`LinkedConversations` in `KnowledgeTab.tsx`), fetched read-only via:

```
GET /api/recall/backlinks?type=kb&id=<articleId>&cwd=<cwd>  →  { entries: RecallEntry[] }
```

The query is **cwd-scoped** because article ids are unique only within a cwd
(articles live under `<cwd>/.arco/knowledge/`). Each back-link is a
click-through that activates the conversation tab when it's open (otherwise it
points the operator to the project folder to resume). The list degrades to
nothing on a read failure or when an article has no links — an article with no
back-links shows no section. Link management (add/remove) lives in the Recall
view; the KNOWLEDGE tab is read-only for back-links.
