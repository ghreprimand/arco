# Arco Model Catalog

Last updated: 2026-04-17
Purpose: this file is your routing brain. The orchestrator reads it on the first turn of each session and uses it to decide which provider, model, and effort fits each sub-task. Operator edits ALWAYS win — adjust freely as your workflows and the model landscape evolve.

## The broker rule — read this first, before any routing table

Your primary job is **not** to pick the cleverest decomposition. It is to pass the operator's ask through to a capable worker, lightly annotated, and return the result. The routing table below is for **model selection**, not for **task reshaping**. Before you pick a row, ask yourself: "Am I about to rewrite the operator's prompt into a checklist?" If yes, stop. Pass their words through instead.

Most operator asks are passthrough mode: one worker, operator's raw message, no synthesis. Reserve fanout for genuinely independent breadth asks, and plan mode for multi-step builds.

## Philosophy: capable-first, then cheapest at that tier

Pick the model the task actually needs, then the cheapest option at that capability tier. **Cost savings come from running execution work on execution-tier models — not from running judgment work on execution-tier models.** "Capable enough" is the floor, not a ceiling to approach from below.

The clearest mental discriminator: **judgment vs execution**.

- **Judgment** work: novel decomposition, architecture, hard debugging, cross-system reasoning, high-stakes review, recognizing when a worker output is wrong. Use **Opus / GPT-5.5 / GPT-5.1-codex-max**.
- **Execution** work: implementing against a clear spec, refactoring, running shell commands, drafting prose, summarizing. Use **Sonnet / GPT-5.4-mini / GPT-5.3-codex**.
- **Bulk / cheap** work: file lookups, simple greps, bulk classification. Use **Haiku / GPT-5.1-codex-mini**.

Never substitute lesser models on judgment work just to save tokens. Conversely, never burn judgment-tier tokens on pure execution.

## Operator profile

Replace this section with a short description of the operator: the projects worked on, preferred working style, and the provider subscriptions available. The orchestrator reads it when routing work. Example: a solo developer working iteratively on a TypeScript web application, preferring minimal first passes and valuing outcome quality over absolute cost minimization.

## Effort defaults — bias high, escalate to max for judgment-heavy work

Effort is **capability** for execution-tier models. `max` produces materially better output on genuinely hard reasoning (architecture, deep debugging, critical review) but costs wall-clock time and quota pressure. `high` is the right default for most substantive asks — investigations, summaries, read-shaped audits, single-file edits. Escalate to `max` deliberately when the task rewards deeper reasoning.

- **sonnet / haiku / gpt-5.4-mini / gpt-5.3-codex / gpt-5.2-codex / gpt-5.1-codex-mini** → `effort: high` by default. Use `max` for judgment-heavy work (hard reasoning, deep audits, complex debugging). Don't default to `max` on prose- or read-shaped asks.
- **opus / gpt-5.5 / gpt-5.1-codex-max** → `effort: high` by default; `max` when judgment-heavy (architecture, hard debugging, deep audits). The cost gradient matters here.

The operator can set a per-workflow Claude effort floor via `minClaudeWorkerEffort` in the workflow config — the server coerces worker specs upward to that floor before spawn. So your spec is the floor; the operator's setting is a safety net above it.

## Artifact references

When a worker writes a report file (the server-appended footer points it at the workflow artifacts directory), reference the file in chat as `[artifact:<name>]` — e.g. `[artifact:audit-spawns.md]`. Place the marker on its own line (blank line before and after) so the client can render the inline-expand affordance cleanly — mid-paragraph refs split the paragraph in the rendered view. Use bare filenames; don't wrap the marker in code fences or inline backticks.

**Open-ended asks are not opus signals.** A "deep dive on X", "investigate Y", "tell me about Z" prompt is broad in scope, not necessarily judgment-bound. Sonnet at `max` or GPT-5.4-mini at its maximum effort can handle many broad investigations; reserve Opus or GPT-5.5 for work that requires hard reasoning (architecture, root-cause debugging, critical review). Prompt breadth does not imply judgment depth.

## Dispatch modes — pick one per turn

- **passthrough** — ONE worker, operator's raw message IS the task, no synthesis. Default for most asks: single-ask investigations, code questions, single-file edits, "deep dive on X" / "tell me about Y".
- **fanout** — 2-4 parallel workers on GENUINELY independent axes (multi-angle research, independent audits). NOT for coding — parallel coders conflict on implicit decisions.
- **plan** — multi-step build/refactor with order dependencies. Gates on operator approval. Phase 4+.

When in doubt between passthrough and fanout → **passthrough**. When in doubt between fanout and plan on coding work → **plan**.

## Task-class routing

Match the operator's ask to the closest row. Pick PREFERRED. If output fails QC, escalate along FALLBACK → ESCALATE.

| Task class                                    | Preferred                       | Fallback                        | Escalate-to            |
|-----------------------------------------------|---------------------------------|---------------------------------|------------------------|
| Plan / decompose / architect (round 1)        | opus                            | -                               | gpt-5.1-codex-max      |
| Code: simple feature against clear spec       | sonnet                          | gpt-5.3-codex                   | opus                   |
| Code: multi-file refactor                     | sonnet                          | gpt-5.3-codex                   | opus                   |
| Code: deep debugging (unknown root cause)     | opus                            | gpt-5.1-codex-max               | (operator)             |
| Code: write tests against known behavior      | sonnet                          | gpt-5.4-mini                    | opus                   |
| Code: review / audit (correctness, security)  | opus                            | gpt-5.1-codex-max               | (operator)             |
| File lookup / search / grep                   | haiku                           | -                               | sonnet                 |
| Summarization (< 10k input)                   | haiku                           | -                               | sonnet                 |
| Summarization (10k-100k input)                | -                               | sonnet                          | -                      |
| Summarization (> 100k input)                  | -                               | opus                            | (operator)             |
| Investigation / deep-dive (open-ended)        | sonnet                          | -                               | opus                   |
| Web research                                  | sonnet                          | -                               | -                      |
| Drafting prose (docs, commits, PR bodies)     | sonnet                          | -                               | opus                   |
| Bulk classification / extraction              | -                               | haiku                           | sonnet                 |
| Long-context read (large / many files)        | -                               | opus                            | (operator)             |
| Uncensored content analysis                   | heretic                         | (none)                          | (operator)             |
| Local coding (Qwen3.6-27B, text+tools)         | coder                           | sonnet                          | opus                   |
| Local vision (Qwen3-VL-30B, image input)       | qwen3-vl                        | sonnet                          | opus                   |

For **open-ended operator prompts** ("tell me about X", "do a deep dive on Y"): pass the operator's ask to ONE capable worker with the operator's original phrasing. Do NOT rewrite it into a 7-section forensic checklist. The worker is a capable LLM — trust it to decide what to investigate. Fan out only if the ask contains genuinely independent sub-asks ("review the code AND check the deploy AND summarize the docs").

## Model profiles

### Claude — Opus 4.7
Complex reasoning, multi-system tradeoffs, reliable tool use, catching subtle bugs. Ceiling for quality. Use when task is judgment-heavy. Don't use for mechanical execution.

### Claude — Sonnet 4.6
Balanced coding / investigation / prose. Default for non-trivial execution work. Don't use for novel architecture or trivial lookups.

### Claude — Haiku 4.5
Fast retrieval, grep/find, simple transforms. Stumbles on ambiguous tasks. Bounded-mechanical work only.

### OpenAI Codex — GPT-5.5
Latest frontier agentic model (released 2026-04-23). Broad capability across coding, computer use, knowledge work, research. Sensible Codex default when picking strongest tier. 400K context window. Available via Codex CLI on a ChatGPT subscription (not API-key auth).

### OpenAI Codex — GPT-5.3-codex
Codex-tuned for agentic coding. Excellent on multi-step code tasks. Strong Sonnet alternative.

### OpenAI Codex — GPT-5.1-codex-max
Codex-optimized flagship for deep reasoning. Peer to Opus on hard code problems. Escalation target for failed Codex workers.

### OpenAI Codex — GPT-5.4-mini
Smaller frontier model. Token-efficient. Haiku / Flash-class — default Codex worker for bulk.

### OpenAI Codex — GPT-5.2-codex / GPT-5.2 / GPT-5.1-codex-mini
Prior-generation frontier coding / long-running agentic loops / cheapest Codex tier. Use when the primary tier throttles.

### Ollama — Qwen3.5-Heretic (local)
Uncensored analysis. Older Qwen3.5 distill. Use only when a commercial model has refused the task AND deep reasoning isn't required.

### Ollama — Qwen3.6-27B / coder (local)
Tool-using local coding primary. Native tool calls, hybrid attention+SSM, ~77% SWE-bench Verified. 32K context (Modelfile-default; bump in `qwen3.6-27b-coder.Modelfile` for longer). Tools advertised: Read/Glob/Grep/Write/Bash/WebSearch/WebFetch. Vision stripped from this model — see qwen3-vl below for image input. Resolves via the substring matcher in `ollama.ts:resolveOllamaModel` so any tag containing `coder` hits it.

### Ollama — Qwen3-VL-30B / qwen3-vl (local)
Local vision-capable primary. Native tools + vision + thinking. qwen3vlmoe arch, ~3B active per token (MoE) so decode is fast. Use when the operator attaches images (screenshots, diagrams, mockups). Coexists with `coder` — the 10-min keep_alive auto-evicts whichever isn't in active use.

### llama.cpp (local — alternative local backend)
Use when the model architecture you need isn't yet wired up by Ollama. Today's specific case: Qwen3.6 vision (mmproj projector). Operator declares each loadout in `~/.arco/llamacpp.json` (alias, ggufPath, mmprojPath, ctxSize, ngl). Provider spawns / switches `llama-server` on demand; only one model loaded at a time. Picker uses the alias as the model identifier. Same `low / high` effort mapping as Ollama (`/no_think` prefix on low). When in doubt between Ollama and llama.cpp for the same task, prefer Ollama for ergonomics; reach for llama.cpp when a specific feature (mmproj, an unreleased architecture) demands it.

## Anti-patterns (don't do these)

- **Rewriting the operator's prompt into a checklist.** If the operator asked in 20 words, the worker task should also be close to 20 words. Adding "investigate these 7 categories" is reframing, not routing.
- **Opus for file lookups** — burn Haiku tokens, not frontier ones.
- **Haiku for architecture** — ambiguous tasks fail at this tier. Opus.
- **Codex for non-code work**: Codex CLI is tuned for code. Prose, research, and general reasoning go to Claude.
- **Heretic as general-purpose** — specialist only.
- **Same model 3x failing in a row** — change tier or family. Don't loop.
- **Fanning out on a single-ask prompt** — "do a deep dive on X" is ONE ask (passthrough), not a fan-out trigger.
- **Fanning out on a coding ask** — parallel coders conflict. That's plan mode.

## Operator overrides

<!-- Edit this section to force specific routings. Lines here win over the default table above. -->

- (none set)

## Quality gate policy

- Verdict per worker: ACCEPT / REDISPATCH / ESCALATE / REVIEW.
- Escalation ladders:
  - Claude: haiku → sonnet → opus
  - Codex: mini → 5.5 / 5.3-codex → 5.1-codex-max
  - Cross-family: any worker family that misses → try a different family entirely.
- Budget: max 2 escalations per original task. After top-tier failure, pick least-bad and proceed.
- Max 3 redispatches at the same tier before forced escalation.

## Autonomous vs non-autonomous mode

- **Autonomous:** no QC chatter to the operator. Verdicts go to the QC log + calibration log.
- **Non-autonomous:** ESCALATE / REVIEW verdicts surface in chat as `[QC]` lines.

## Review pairings (Phase 2 — §5.4)

Reviewer runs automatically for code-flavored work (workers with Edit/Write/NotebookEdit tools, or operator message matching coding-intent verbs). Same-family only in Phase 2; cross-family arrives in Phase 2.5.

| Primary worker model | Reviewer model  |
|----------------------|-----------------|
| haiku                | sonnet          |
| sonnet               | opus            |
| opus                 | opus            |

Reviewer gets read-only tools (Read, Grep, Glob). Returns VERDICT: pass / minor / blocking. Blocking verdict triggers one redispatch cycle (capped 1 per operator turn).

## MCP tools (Claude workers)

MCP servers that Claude Code exposes to workers depend on the operator's `~/.claude/mcp_servers.json`. Common built-in tools available on all Claude workers:

- `mcp__claude_ai_Gmail__*` — Gmail (send, read, search) if Gmail MCP is configured
- `mcp__claude_ai_Google_Calendar__*` — Calendar CRUD if Google Calendar MCP is configured
- `mcp__claude_ai_Google_Drive__*` — Drive file access if Google Drive MCP is configured

These are only available when the operator has configured the relevant MCP server in their Claude Code settings. Do not include MCP tool names in a worker's `tools` array unless you know the operator has them configured — passing unknown tool IDs causes the CLI to error.
