# Providers

Native and local-model file tools refuse links that leave the workflow folder, including links used as search folders. Links to files inside the same folder remain usable. New nested files can still be created.

**Status:** Guided first-run Connections setup and recovery remain in progress. See [Development status](DEVELOPMENT_STATUS.md).

Per-provider deep dive. The generally available providers are **Claude**, **Codex**, **Ollama**, **LM Studio**, **llama.cpp**, and **Cursor**. Two optional integrations, **Strata** and **DeepSeek through Xolotl**, require separately installed external services that Arco does not distribute. All configured providers can act as primaries and reviewers. They differ in spawn mechanism, session resume, auth, and capability detection; this doc tracks each one's particulars. Two providers run multiple transports side-by-side, picked per-tab from the CONFIG tab: **Claude** has `cli` (per-turn `claude` subprocess) and `native` (long-lived in-process Anthropic-API worker via `@anthropic-ai/sdk`); **Codex** has `exec` (per-turn `codex exec` subprocess) and `appserver` (long-lived `codex app-server` child). **Cursor** also has two - `acp` (long-lived) and `print` (stateless one-shot) - but the choice is routed automatically (`sandbox: 'read-only'` -> `print`), not toggled.

Chat tabs support Claude, Codex, Cursor, Ollama, llama.cpp, and LM Studio; Optional Strata and DeepSeek integrations are available when their external services are installed. See the contract below and [`CHAT.md`](CHAT.md).

For the abstract interface, see `server/src/providers/types.ts`. For when these are invoked in the broader lifecycle, see [`PRIMITIVES.md`](PRIMITIVES.md). For protocol-level message shapes, see [`PROTOCOL.md`](PROTOCOL.md).

---

## Child process input failures

If a provider CLI, sign-in process, language server or MCP server closes its input early, Arco handles the input-stream error and stays running. Existing exit reporting and request timeouts still apply; failed requests are not automatically resent.

## Diagnostic executable lookup

Diagnostics uses platform PATH lookup, including Windows PATHEXT suffixes, to find optional tools and language servers. Model Health uses the runtime's `ARCO_LLAMACPP_BIN` override when configured; otherwise it searches PATH. An invalid configured override is reported missing. These checks do not launch a model.

## Topics

| Topic |
| --- |
| [Provider comparison](#provider-comparison) |
| [The provider abstraction](#the-provider-abstraction) |
| [Interrupt and send](#interrupt-and-send) |
| [Claude](#claude) |
| [Codex](#codex) |
| [Cursor](#cursor) |
| [Ollama](#ollama) |
| [LM Studio](#lm-studio) |
| [Strata](#strata) |
| [DeepSeek (Xolotl)](#deepseek-xolotl) |
| [llama.cpp](#llamacpp) |
| [External MCP integrations](#external-mcp-integrations) |
| [Comparison matrix](#comparison-matrix) |
| [Error-classifier taxonomy](#error-classifier-taxonomy) |
| [Provider fallback chains](#provider-fallback-chains) |
| [Cross-references](#cross-references) |
| [Retired provider history](#retired-provider-history) |

## Provider comparison

| Provider | Transport | Effort levels | Native resume | Notes |
|---|---|---|---|---|
| Claude | `cli` (alternate; also reviewers and handoff seeds) | low / medium / high / xhigh / max | UUID-based (`--session-id` / `--resume`) | Picker: `opus` / `sonnet` family aliases plus pinned ids (Opus 5.5, Fable 5.2 / 5.1, Sonnet 5, Opus 5, Opus 4.8, ...). Per-turn `claude` CLI spawn. Full two-way interop with terminal `claude`. Chat renders from `~/.claude/projects/<cwd-hash>/<sessionId>.jsonl`. Auto-handoff supported. |
| Claude | `native` (new-home default) | low / medium / high / xhigh / max | Replay from `events.jsonl` (Arco-internal; no terminal resume) | Long-lived in-process `@anthropic-ai/sdk` worker, no CLI spawn. OAuth subscription auth + pinned Claude Code wire fingerprint. Append-only request prefix with preserved thinking (required by Fable 5.2 / 5.1 and Mythos 5.2 / 5.1 / Opus 5.5). Ships its own Bash / Read / Edit / Grep / Glob / Task tools, Claude-Code-compatible hooks runner, server-side `compact` + auto-handoff + deterministic Fold, operator-armed plan-mode, parallel `Task` subagent fan-out (depth-1 cap), output-style picker (normal / plain / terse), and posture-based toolsets (operator cycles a full / coding / review / chat posture that scopes exposed tools).
| Codex | `exec` (alternate; also reviewers and handoff seeds) | model/catalog-driven; Astra / Sol: low through ultra, Luna: through max | UUID-based (`codex exec resume`) | Default model GPT-6 Astra (Sol and Luna also in the cold-catalog fallback; the live `model/list` catalog is authoritative). MAX context by default. Per-turn `codex exec` spawn. Full two-way interop with terminal `codex`. Supported effort values pass through; older models are not widened to Astra-only levels. Reviewer runs `-s read-only`. Transcript hydration on Resume for unclaimed rollouts. |
| Codex | `app-server` (new-home default) | model/catalog-driven (same as `exec`) | UUID-based (rollouts in `~/.codex/sessions/`) | Long-lived `codex app-server` per tab. Structured `turn/interrupt` cancel + non-destructive `turn/steer` mid-turn input + `localImage` attachments + crash-recovery circuit breaker + output-style picker + native compact with context-signal reset. Reviewers / handoff seeds always run on `exec`. |
| Cursor | `acp` (default) + `print` | baked into the model id (`-low` / `-high` / `-xhigh` / `-max`) | `session/load` (loadSession capability) | Long-lived `cursor-agent acp` ACP worker; ~153 models incl. Grok. Steer / cancel / session resume / live model-swap via `session/set_model`. No per-turn token signal (the Usage tab is dashboard-polled). Cluster member via an in-process loopback HTTP MCP server. Read-only reviewer / primitives run a stateless `cursor-agent -p --mode ask` one-shot. |
| Ollama | (single) | per model - graded thinking: `low` = thinking off (`think:false` + `/no_think`) plus the model's own levels from `/api/show` `thinking.values` (e.g. supported levels from `/api/show`); boolean-only models keep low / high | None | No native session concept; each turn is a fresh context. Tool use + large context + image attachments + web tools (SearXNG search, fetch with Camoufox stealth fallback). Mid-turn steer supported. Override base URL with `OLLAMA_URL_BASE` (default `http://localhost:11434`). |
| llama.cpp | (single) | low / high (`low` = `/no_think`) | None | Operator-managed GGUF catalog at `~/.arco/llamacpp.json`. Singleton `llama-server` process owned by Arco (`llamacppManager`); switching aliases SIGTERMs the old server and warms the new one. OpenAI-compatible chat-completions + SSE streaming. Same tool-loop runtime as Ollama, with in-place auto-recovery (reasoning runaway / stream stall / tool-cap / context fill). Override binary with `ARCO_LLAMACPP_BIN`. |
| LM Studio | (single) | low / high (`low` = `/no_think`) | None | LM Studio reached via its **OpenAI-compatible** HTTP API (`/v1/chat/completions`, `/v1/models`) - not the native SDK. Joins ollama / llama.cpp on the serial local queue, same tool-loop runtime + recovery. Whatever model is loaded in the LM Studio app is the active model. Override base URL with `LMSTUDIO_URL_BASE` (default `http://localhost:1234`). |
| DeepSeek / Xolotl | HTTP + guarded user services | none / low / medium / high | Transcript replay | Configured profiles with model-specific context, image, and tool capabilities, guarded loading and unloading, and source-version tracking; see [`docs/DEEPSEEK.md`](DEEPSEEK.md). |
| Strata | (single HTTP worker + optional registered user services) | none / low / medium / high (`none` disables reasoning; high maps to Qwen xhigh) | Transcript replay | Standalone OpenAI-compatible service at `http://127.0.0.1:8081/v1`. The service reports installed model IDs, context and capabilities; one profile is resident at a time. Streaming reasoning, tools, image input, Chat web-only toggle, native tok/s, FREE VRAM and release notices. [Runbook](STRATA.md). |

All configured providers can act as reviewers or primary agents. Local reviewers (Ollama, llama.cpp, LM Studio, Strata) get a prompt addendum reminding them to use their read-only tools to verify diff claims against the live tree. Cross-family reviewer pairings are the most useful.

The utility agent and the Smart AUTO-PICKUP evaluator are narrower: only Claude
with Native sign-in, Cursor, Codex and Ollama can serve. Claude CLI alone cannot
make a tool-less one-shot. Codex runs as a locked-down one-shot app-server
(read-only sandbox, no MCP servers, web search off, any tool item ends it).
See [Settings: Utility agent](SETTINGS.md#utility-agent) and
[SECURITY.md](../SECURITY.md#utility-agent-and-smart-auto-pickup-evaluator-requests).

Auth is per-service: browser OAuth for Claude (CLI login, plus a separate OAuth flow for Native); terminal-launched TUI for Codex; `gh auth token` for GitHub; Ollama / LM Studio / Strata probe their HTTP endpoints (prepared local Strata profiles can also start on demand); llama.cpp probes for the binary + reads `~/.arco/llamacpp.json`; Cursor uses its own `cursor-agent login`. The auth overlay blocks app use only when no primary-capable provider is authed.

### Background programs

ACTIVITY > BACKGROUND lists programs the agent started through a shell tool and left running, such as a dev server or long build. Arco helpers, configured MCP servers and provider programs are excluded. Jobs remain visible across turns and briefly show completion after exiting. Process discovery currently requires Linux.

The tracker matches shell-tool commands to process arguments and follows their known children. Claude CLI, Codex exec and app-server, and Cursor ACP supply these events. Providers without a discoverable child-process id do not feed this process tracker. Native and local tool execution keep their existing task reporting.

## The provider abstraction

Every provider implements `ProviderProcess` from `server/src/providers/types.ts`:

```ts
interface ProviderProcess {
  id: string;
  status: 'spawning' | 'running' | 'completed' | 'failed';
  output: string;        // accumulated text, capped at MAX_WORKER_OUTPUT_BYTES (50 MB; ARCO_MAX_WORKER_OUTPUT_BYTES env override)
  pid?: number;          // undefined for HTTP/RPC providers (Ollama, LM Studio)
  spawn(prompt: string): void;
  kill(): void;
  // (extends EventEmitter - `on(event, handler)` comes from there)
}
```

`ProviderEvents` is a unified set every provider emits:

- `init`: `{ model, sessionId? }` indicates that the provider has started; Codex reports its `thread_id` here.
- `text`: `{ text }` is an incremental assistant-text fragment.
- `thinking`: `{ text }` is an incremental reasoning fragment when the transport exposes it.
- `tool_use`: carries the tool name and serialized input, with optional status and provider item identifiers for progress updates.
- `result`: closes the turn with final text, cost and duration, plus optional usage, context, and byte telemetry.
- `error`: carries the fatal error text.
- `system_notice`: reports transient status such as rate limits or retry backoff outside the assistant transcript.

`server/src/providers/index.ts` is a thin factory:

```ts
createProviderProcess(id, config) → ProviderProcess
```

It dispatches on `config.provider` and returns the right concrete class. Higher-level code (`WorkerManager`, `seedWorker`) consumes the unified event stream and never branches on provider type once the process is running.

**Stuck-worker breaker (3.1).** Independently of provider, the seed/tool-loop layer feeds each terminal tool result to a deterministic error-persistence detector (`server/src/workers/stuckBreaker.ts`, signatures from `server/src/providers/outputSignature.ts`): the same failing command recurring with an UNCHANGED result across turns trips a visible `worker_stuck` event (+ `system_notice`) so a looping worker is caught rather than burning turns silently. The verdict clears when a previously-failing tool finally succeeds. The detector is deterministic and operator-readable - no model judgment about "is this stuck."

---

## Interrupt and send

Claude (`cli`, `native`) and Codex (`exec`, `appserver`) support the Agent composer's
**INTERRUPT & SEND** and **Ctrl/Cmd+Enter** action (`user_message.kind:'interrupt'`).
The user-message loop retains its busy claim, interrupts only its primary worker,
and waits before dispatching the correction in the existing conversation. It never
uses CANCEL's queue-clearing handler. Reviewers and other busy holders are not
interrupted; unavailable requests visibly queue as follow-ups.

- CLI workers settle STOP synthetically before OS exit. Their separate `interrupt()`
  waits for the actual child `exit` (10-second ceiling) before session resume.
- Claude Native cancels its stream/tools and awaits the actual `runTurn` promise.
  If another correction cancels startup before its prompt entered history,
  `turnInputAccepted:false` carries that unsubmitted correction into the next prompt.
- Codex app-server uses `turn/interrupt` and waits for matching interrupted
  completion. Concurrent STOP/interrupt requests share one cancellation waiter.

Interrupts pending cancellation merge FIFO into one priority turn. Other queued
messages run afterward; provider steer drains are suspended during the correction.
Cancellation failure preserves the queue and surfaces a notice without another
turn. Existing edits remain in place; this action disarms an armed Goal Run.
Tests: `npm run test:interrupt-send`, `npm run smoke:interrupt-send` (isolated fake
CLIs plus real Native loop over mocked Anthropic streaming; zero model spend).

### Local file context across turns

Ollama, llama.cpp, LM Studio, Strata and DeepSeek keep named attachment and tool-file receipts across turns and reload. Each request restores up to two recent fitted images and 8 KiB of decoded text. Current attachments take priority in the request's media budget. Text-only models receive descriptions instead of image inputs. Older receipts name saved files or the original tool and input so the agent can use Read or request another range. Missing files produce an explicit notice.

Snapshots live in the conversation's `file-context/` folder, outside ARTIFACTS. Each saved result retains at most two images and 32 KiB of decoded text; request preparation considers up to 64 references. Repeated reads reuse snapshots with identical saved content. Older snapshots remain readable. Disk snapshots are immutable and are not automatically deleted. Storage measurement includes them in Conversation files, and operator ARCHIVE, RESTORE and DELETE include the folder. Incognito keeps tool-file context in bounded memory only and clears it on close or reset. Switching to Native retains readable receipts; it does not restore local snapshots as native image blocks.

## Claude

### Native file reads and attachments

Claude Native Read, Task helpers and operator attachments use Arco's portable file decoder. Initial, queued, follow-up and steered attachments use the same preparation. Tool cards show the file name, type, dimensions or selected document range instead of binary bytes. After reload, Native retains MCP media receipts with the original tool name and input for requesting the result again. Text reads retain the 256 KiB cap and line controls. UTF-8 and byte-order-marked UTF-16 text are recognized. Non-UTF-8 text without NUL bytes and with fewer than 1% unexpected control bytes per 16 KiB chunk is decoded as Windows-1252 and marked. Line ranges apply to the decoded text. A selected text range containing NUL bytes receives a binary-file note, including when those bytes occur after the initial header.

PNG, JPEG, GIF, WebP, AVIF, HEIC, TIFF, BMP and ICO are fitted with bundled codecs. No image converter installation is required. Available ImageMagick or macOS sips can accelerate decoding. Images fit within 2,000 pixels per side and 5 MB base64. The entire image is scaled without cropping; animated or multipage images use their first frame. ICO uses its largest embedded PNG or bitmap. SVG supplies bounded source text and a fitted preview. Its isolated WebAssembly renderer executes no scripts and resolves no external resources or system fonts. Text requiring a font may be absent from the preview; the source remains available.

Read accepts `pages`, such as `"1-3,5"`. PDFs provide extracted text and scanned-page images by default. Use `pdf_mode: "visual"` with `pages` to request selected PDF pages for layout, charts or figures. Word (`.doc`, `.docx`), Excel (`.xls`, `.xlsx`), PowerPoint (`.ppt`, `.pptx`), OpenDocument and RTF become text with headings, table rows, sheet names or slide labels. Notebook cells retain source and outputs, including images. Files ending in `.ipynb` retain cell selection even when metadata precedes the cell list. SVG outputs include source and a fitted image; other unsupported rich outputs leave a cell-numbered receipt naming their media type.

For spreadsheets, presentations and notebooks, `pages` selects sheets, slides or cells. Word-processing ranges select explicit page breaks and bounded sections, not printed-layout pages. Embedded images follow supported document relationships; legacy images without section mappings are available when reading the whole document. Macros, external links and notebook code are never executed.

Sources can be up to 512 MB. PNG scanline decoding supports 512 megapixels; other raster decoders allow 250 megapixels. Oversized or malformed files produce a note explaining how to supply a smaller file or range. Claude Native uses independent request image and PDF-page caps from the selected context window: 100 images at 200k, 600 above it; 100 PDF pages below 1M, 600 at 1M or above. Unknown windows use 100 for each. Encoded media is capped at 128 MiB for the first-party API and conservatively at 20 MiB for custom or unknown endpoints, whose upstream request limits may be smaller. Text, tools and other request fields still contribute to the provider's total request size.

Native context and media limits use 200,000 tokens for Sonnet 4, Sonnet 4.5,
Opus 4, Opus 4.1 and Opus 4.5, including their dated IDs. Sonnet 4.5 therefore
shows 50% context fill at 100,000 retained prompt tokens and admits 100 images
and 100 visual PDF pages. Its former 1M beta is retired. Sonnet 4.6 and newer
1M families retain their larger windows; Haiku 5.5 also uses 1M. Haiku 4.5
remains at 200K. See [Anthropic's context-window reference](https://platform.claude.com/docs/en/build-with-claude/context-windows).

Only real image blocks and base64 PDF documents consume media counts. Fetched text and ordinary text documents do not; a fetched base64 PDF counts its real pages. Tool input JSON is not media. Missing PDF page counts are measured from the bytes. Above 20 images, Arco retains its 2,000-pixel per-side rule.

Between API requests, older media becomes text receipts when needed to admit new media. One notice at the end of the turn totals the old images and PDF documents replaced, omitting empty categories; attach or request a file again to bring it back. Tool pairing remains intact; older signed reasoning is omitted and prompt-prefix bookkeeping restarts. An in-progress assistant/tool-result round keeps its original signed thinking and tool identifiers, matching in-turn compaction. Unaffected histories stay unchanged. If the new media alone exceeds the guard, a notice names the limit and image, page and encoded-size totals. Use COMPACT or HANDOFF, then attach or request the file again. A managed upload path does not grant Read access outside the workflow.

See the provider's [vision limits](https://platform.claude.com/docs/en/build-with-claude/vision) and [PDF limits](https://platform.claude.com/docs/en/build-with-claude/pdf-support).

MCP image and embedded document results use the same decoder. Linked resources are described rather than fetched automatically. Native `read_url` uses the shared public URL decoder for file links. Anthropic's server-side `web_fetch` remains available for web pages and citations. Utility jobs remain bounded text-only tasks without file tools.

Live requests and token counting receive typed media. Saved events and text summaries keep receipts and attachment references, never base64 payloads. Use Read again after reload or compaction for exact detail. Evicted raw results remain recoverable in local artifacts. Saved replay drops reasoning signatures when replacing their media with receipts.

[Anthropic's vision limits](https://platform.claude.com/docs/en/build-with-claude/vision) and [PDF limits](https://platform.claude.com/docs/en/build-with-claude/pdf-support) vary by endpoint and model. Arco deliberately uses stricter limits.

Native shell results carry exit, signal, timeout and cancellation status separately from output text. Failed commands show failed activity, run PostToolUseFailure hooks and select failure filters. Compiler, configuration and test-collection diagnostics remain visible when a test-result filter cannot safely summarize them.

Native Task model overrides are applied to the child workflow configuration before deriving its primary. The live child, emitted tab configuration and saved metadata therefore name the same requested model, including after promotion or reopen.

Spawn from a HISTORY point reads the selected earlier prefix even when it is outside the recent replay tail. Cancelled handoffs leave prior Native context intact, including the older-history summary. A cancellation or failure during pre-warm revokes an earlier prepared artifact for replay; a successful fallback after a failed reflection remains valid. Derived summary caches from the earlier replay rule are rebuilt automatically; original events remain unchanged.

Context `@file:` references expand supported documents and notebook cells as text, and send supported media through the provider attachment path. Unsupported binary content becomes a note. Text is limited to 64 KiB per reference; the aggregate context budget also applies to media.

Native Read and local Read keep their 256 KiB and 32 KiB output caps while reading in chunks; `offset` and `limit` still select later lines. Special files are refused.

Grep skips binary files and searches UTF-8, UTF-16 and Windows-1252 text. A legacy text chunk with at least one percent disallowed control characters is treated as binary. JavaScript search reports shortened long lines. Native ripgrep decodes legacy text output and also checks legacy text for non-ASCII search terms.

Native `read_url`, local WebFetch and the read-only CLI `fetch_file` tool use `fileFetch.ts`. Text downloads stop at 128 KiB; recognized images and documents have the shared 512 MiB source budget before decoding and provider limits apply. The reader checks public HTTP(S) hosts, resolved addresses and every direct HTTP redirect. Source-size and deadline refusals return a note. Native server web tools run on the provider service.

Native Read keeps the partial-read warning when its output is capped, until a later complete read covers the file. Native Grep reports invalid patterns and search failures as errors; a successful search with no matches remains empty. Native Bash keeps its newest output tail even if saving the full output fails, and reports that full output is unavailable. Native and local-model Write create nested parent directories on Windows.

Registry MCP schemas keep their definitions and validation metadata, including local references. Unsupported top-level `oneOf`, `allOf` and `anyOf` are still removed before Native requests.

### Chat-mode execution contract

`WorkerConfig.interactionMode:'chat'` is a hard tool boundary shared by the
supported providers (not Claude-specific; it lives here because Claude was
first). The one exception is the per-tab web toggle - `chatWebArmed()` in
`server/src/chatMode.ts` decides, and every transport states the mode
explicitly instead of inheriting a provider default:

- **Claude Native** - empty `tools`, or `buildChatWebTools()` (server
  `web_search` + `web_fetch` and portable `read_url`, deliberately no `code_execution`) when armed;
  only the chat system block.
- **Claude CLI** - `--tools ""`, or `--tools WebSearch,WebFetch` when armed,
  plus `--strict-mcp-config`.
- **Codex** - read-only sandbox in the isolated chat cwd (its CLI has no
  universal tool allowlist, so isolation + sandboxing are the defense);
  `web_search="live"|"disabled"` on both `exec` (`-c`) and app-server (thread
  config), plus chat `baseInstructions` on app-server.
- **Ollama** - no tools, or exactly `WebSearch` / `WebFetch` (local SearXNG +
  fetch) when armed, re-checked at dispatch by `ollamaToolCallAllowed()` so a
  hallucinated known tool name cannot cross the boundary.
- **Strata** - the shared OpenAI HTTP worker advertises and dispatches only
  `WebSearch` / `WebFetch` when Chat web access is armed. Standalone logs/image
  caches mean it is unavailable in strict Incognito.
- **llama.cpp, LM Studio** - tool schemas omitted; no web option. Both still
  re-check `ollamaToolCallAllowed()` at dispatch, so a tool call the model
  writes as text (llama.cpp's `<tool_call>` fallback) is refused in Chat and
  in plan-review turns, even with AUTO on.
- **Cursor** - each Chat turn runs `-p --mode ask` in a private folder under
  the selected Arco home, removed when the turn ends. Startup removes abandoned
  turn folders without following links. Cursor Chat has no web access; its
  header shows `NO WEB` and offers no web toggle. It receives no project
  plugin, additional read folders or `--force`. Explicit permissions deny all
  reads, writes, shell, web fetches and MCP tools, including previously approved
  servers. An empty `--allowed-tools` list excludes every built-in tool family;
  workspace context, indexing, semantic search and lint context are disabled.
  Documents arrive as extracted text. Only fitted copies of the current
  message's images go through `--image`, never through a Read fallback.
  Arco checks required flags with a deliberate parser error before starting a turn.
  Missing required isolation controls refuse Chat; an unsupported image input
  refuses images with a plain message. These Cursor flags are internal and may
  change between versions. Agent ACP sessions and read-only reviews retain
  their existing project access and argument builder.

**Computer voice exception.** A `voiceOperator` Chat receives only the
bounded `arco_*` tools from `server/src/voice/toolDefinitions.ts`, with
`VOICE_OPERATOR_PROMPT`. Codex saved uses app-server and its sole approved
`arco-voice` MCP; Incognito Computer uses app-server `thread/start {ephemeral:true}`, never
resume; a response must confirm ephemeral with no rollout path before any
request is sent. Ordinary Incognito Chat still uses `exec --ephemeral`. Claude uses
Native, whose tool dispatch returns early to the browser relay. Ollama/Strata
use their existing native tool loops, again with an independent voice allowlist;
project/web/registry tools stay absent. Ollama skips heuristic tool subsetting
and automatic compaction for Computer. Local Computer replay uses structured
tool calls/results (`voice/history.ts`), preserving the actions behind Done.
Native/local cold replay obeys the last full-reset boundary. Defaults are 50%
subscription / 75% local, based on measured configured windows and applied only
after the complete turn/queue. Strata remains unavailable in strict Incognito.
See [VOICE.md](VOICE.md) for the current contract and provider smoke commands.
Codex Computer alone has a 90-second silent-start / 60-second no-progress /
five-minute total watchdog. It retires a stalled child, fences outstanding tools
and fails the request without replaying it; the next operator request resumes
saved history on a new process. Private context loss triggers a visible clear.
Normal Chat/Agent lifecycles are unchanged. Tool results are repaired to valid
Unicode before MCP serialization; a truncated emoji previously wedged this path.

`chatSystemPrompt(armed)` swaps the system prompt with the toolset.

`WorkerConfig.incognito:true` strengthens that boundary into Arco-side
non-persistence. Claude CLI receives no session id and therefore emits
`--no-session-persistence`; Codex is forced off app-server onto one-shot
`exec --ephemeral` (Computer alone uses a verified ephemeral app-server thread). Stateless turns receive a deterministic transcript
from `WorkflowState.incognitoEvents`. Cursor is excluded from incognito because
its CLI exposes resumable chats but no ephemeral-session flag. llama.cpp is
also excluded because the shared Arco-managed `llama-server` writes an
unavoidable `~/.arco/llamacpp.log`. Claude's incognito system/history prefix
rides stdin rather than argv or an append-system-prompt temp file; direct CLI
stderr, Arco operational logs, notifications, remote reporting, and durable
PID registration are suppressed. Native and eligible local HTTP providers
retain conversation state in process only; retention by a remote API service
remains governed by that service, not Arco's disk policy.

Two transports ship side-by-side, selected per-tab via `claude.transport`. New Arco homes use `native`; the home and project settings cascade can select either transport, and a per-tab choice takes precedence. Existing cascade and per-tab choices remain unchanged. Per-tab override lives on `WorkflowConfig.claudeTransport` and is editable from the CONFIG tab without a server restart.

Authentication status distinguishes Native credentials, CLI login and usage limits availability. Stored
Native credentials remain visible when the CLI is signed out. The Native indicator reports local
presence, refresh needs, read failures or an authentication problem; an unexpired local grant is
explicitly unverified for execution. CLI warnings name the CLI and use its sign-in command. Native
warnings open the Claude sign-in group in Settings. Neither status recovery nor a usage-limits failure switches
the selected transport. An unavailable usage limits meter does not invalidate execution credentials.
Native uses one credential store per Arco home; named account/profile labels do not create separate
Native credentials. Connection checks remain metadata checks without a model turn.

Reviewers and handoff seed turns always run on `cli` regardless of the tab's transport - Native is per-workflow long-lived and Arco-internal-only, so any path that needs a `~/.claude/projects/<sid>.jsonl` rollout (handoff destinations, reviewer recovery) goes through the CLI provider. After `handoff_complete`, the dispatcher disposes the cached Native worker so the next operator turn rebuilds the messages array from the post-handoff transcript.

### Native transport - append-only prefix (2026-09-01)

Append-only prefix delivery is a current Native transport invariant. The in-process worker freezes `system` + `tools` on its first request and delivers every later config change (north-star, output style, cluster plan, CLAUDE.md re-read, posture, plan mode, MCP attach) as an appended `role:'system'` message with text and/or `tool_addition` / `tool_removal` blocks, so Claude Fable 5.2 / 5.1's preserved-thinking check never sees an edited prefix and the prompt cache survives config changes. Thinking blocks persist across turns (they used to be pruned at turn end). Every prefix mutation is a `ctx_action` in `events.jsonl`; `input_transformations` from Anthropic are logged per round. Pure helpers: `server/src/providers/claude-native/appendOnlyPrefix.ts` (`npm run test:append-only -w server`). Invariants: [Gotchas: Claude Native transport](GOTCHAS.md#claude-native-transport).

### CLI transport

`server/src/providers/claude.ts`. Subprocess via `spawn('claude', args)`.

### Spawn

`spawn('claude', args, { detached: true, env: { ...process.env } })` (through `commandArgs`, so Windows resolves the command shim). The concurrent-writer guard reads the `entrypoint` field the Claude CLI writes on each session JSONL row: `sdk-cli` for turns Arco started, any other value for a `claude --resume` terminal writing to the same JSONL (`server/src/ws/turnEngine.ts`).

### Argv (primary)

```text
claude
  -p
  --output-format stream-json
  --verbose
  --include-partial-messages
  --model <m>
  --effort <e>                        # forced xhigh under ultracode
  [--input-format stream-json]        # when image or PDF blocks are present
  [--session-id <uuid>]               # first turn (Arco pre-mints)
  [--resume <uuid>]                   # subsequent turns
  [--no-session-persistence]          # neither id set (workers, incognito)
  [--dangerously-skip-permissions]    # AUTO mode
  [--system-prompt <p>]
  [--append-system-prompt <s>]        # small values (inline string)
  [--append-system-prompt-file <fp>]  # large values switch to this separate flag; see GOTCHA
  [--tools <csv>]                     # absent = full CLI toolset; Chat passes "" or WebSearch,WebFetch
  [--strict-mcp-config]               # Chat only
  [--fallback-model <m>]
  [--add-dir <paths>]
  [--mcp-config <fp>]                 # cluster / registry MCP
  [--disallowedTools <csv>]           # registry denylist + per-tab disabled tools
```

Incognito omits `--system-prompt` / `--append-system-prompt*`; the private framing rides stdin instead.

### Argv (workers - reviewer / handoff summarizer)

Same base + `--no-session-persistence` (don't write a session JSONL) + optional `--dangerously-skip-permissions` (only in trusted reviewer contexts) + `--tools <csv>` allowlist + `--add-dir <paths>` for cross-directory reads.

### Stdin

Text-only prompts use plain stdin. When prepared attachments contain images, stdin carries a single `stream-json` user envelope with media before the request text. Documents provide decoded text, with scanned PDF pages sent as images.

**GOTCHA - ARG_MAX overflow** (large-prompt handling): when an inline `--append-system-prompt` value would push the argv past Linux's `MAX_ARG_STRLEN` (~128 KB/arg), `execve` kills the spawn with `E2BIG`. Arco's mitigation: above that threshold it writes the appendSystemPrompt to a tmpfile (`append-sp-{id}-{pid}.txt`) and passes it via the **separate** `--append-system-prompt-file` flag (a documented peer of `--append-system-prompt` in the CLI's bare help) - not the same flag with a path. If the tmpfile write fails it falls back to the inline `--append-system-prompt` argv (which may then E2BIG, but the operator sees a real spawn error rather than a silently-dropped prompt). Tmpfiles are cleaned up on settle and on server exit.

### Event parsing

Stdout is NDJSON. `StreamParser` consumes line-by-line and dispatches:

- `system.init` → `init` with `model`, `sessionId`
- `assistant.message.delta.text` → `text`
- `assistant.message.delta.thinking` → `thinking`
- `assistant.tool_use` → `tool_use` (Bash, Read, Grep, Glob, WebFetch, etc.)
- `result` → `result` with `total_cost_usd`, `duration_ms`, `usage`
- `system.api_error` / `system.notice` → `system_notice`

Unknown event types are logged and ignored (Claude CLI updates may add new shapes).

### Session resume

UUID-based. Every Claude session is identified by a UUID stored in the file `~/.claude/projects/<cwd-hash>/<sessionId>.jsonl`. The cwd-hash is a deterministic transformation of the absolute working directory.

- **First turn** - Arco pre-mints a UUID and passes `--session-id <uuid>`. Claude creates the JSONL with that name. Arco stores the UUID in `meta.cliSessions[]` immediately.
- **Resume** - `--resume <uuid>` continues the session. Arco's `wf.primarySessionId` carries the active UUID.
- **Terminal interop** - `claude --resume <uuid>` from any terminal continues the same session, and Arco picks up the new entries via the JSONL watcher (context robustness).

### Auth

Subscription-based via Anthropic. `claude auth status --json` returns `{ loggedIn, email, subscriptionType, orgName, plan }`. `POST /api/auth-login?provider=claude` shells `claude auth login` (browser OAuth flow).

API-key fallback: if `ANTHROPIC_API_KEY` is set in the spawned process env, the CLI uses it; otherwise it falls back to subscription auth from `~/.claude/.credentials.json`.

### Capability detection

`claude --version` → version string. `capabilities.ts` parses this and the help output to detect supported efforts (low/medium/high/xhigh/max), available models, and tool flags. Re-probed every 4 hours.

### Quirks

- **API overload retry loop** - `overloaded_error` and `{"type":"error"}` envelopes from the CLI are caught, surfaced as `system_notice`, and retried with 15s/30s/60s backoff up to 3 attempts. Same session id, so retries are idempotent. Implemented in the result path inside `claude.ts`.
- **Throttle detection** - stderr regexes catch "usage limit reached", "try again at HH:MM", "resets at <ISO>". Translated to `quota.markThrottled('claude', errorText, resetsAt)`.
- **Output cap** - accumulated text is capped at `MAX_WORKER_OUTPUT_BYTES = 50 MB` (override via `ARCO_MAX_WORKER_OUTPUT_BYTES` env). Beyond that, Arco emits a truncation notice and forces the worker to settle. The 32 GB tree-RSS guard handles actual memory runaways; the text cap is the secondary safety net for "model went berserk printing forever."
- **Attachments** - fitted images use stream-json `content` blocks. Documents and notebooks provide decoded text, while other binaries provide a note. `[attached file: <path>]` labels identify the source alongside its decoded content.
- **Concurrent-writer guard** - the JSONL watcher inspects new entries' `entrypoint` field. If a foreign (`!= 'sdk-cli'`) entrypoint appears, Arco fires `[WARN] Concurrent writer detected on session <uuid>...` and refuses new turns for 60 seconds. Operator must Handoff to recover.

### Ultracode (sticky, CLI-only)

A per-tab sticky mode (`WorkflowConfig.ultracode`, default off) that puts the tab in the same deep multi-agent mode as `ultracode` in the Claude CLI. The harness `WorkflowTool` and the `ultracode` keyword-trigger live **only inside the `claude` binary** (confirmed by disassembly: `WorkflowTool`, `workflowKeywordTriggerEnabled`, `WorkflowsDir`); Native's raw `@anthropic-ai/sdk` has no Workflow executor. So ultracode is a property of the **CLI transport** - Arco routes the turn through the real binary rather than reimplementing the fan-out.

- **Forcing.** `turnEngine` resolves `ultracode` from `wf.config` and, when on, forces `claudeTransport='cli'` **at turn time without overwriting** the stored `claudeTransport` - so the operator's base transport (e.g. `native`) is preserved and restores itself when ultracode is turned off. `claude.ts` then: prepends the `ultracode:` keyword to the prompt (`_launch`), forces `--effort xhigh`, and ensures `Workflow` survives any restricted `--tools` allowlist (`buildArgs`). Internally ultracode = `xhigh` + a separate `ultracode:true` flag; `--effort` itself only accepts `low|medium|high|xhigh|max`.
- **The two-result wrinkle (load-bearing).** An ultracode turn runs the WorkflowTool's subagent fleet in the **background**, so one `claude -p` process emits **two `result` events**: an early "workflow launched" ack, then the real synthesis when the fleet finishes (the process waits and exits 0 only after the last). The naive integration settles the turn on the first result (the `settled` flag in `WorkerManager.ts`, fed by `ClaudeWorker` emitting `result` per parser event) → the operator sees the ack as the answer and the synthesis is dropped. **Fix, gated on `config.ultracode`:** in `claude.ts`, `parser.on('result')` HOLDS each result (`_heldResult`) instead of emitting and surfaces a superseded prior as a progress `system_notice`; the `exit` handler FLUSHES the last held result as the canonical turn result. Normal (non-ultracode) turns are byte-identical. See [Gotchas: Provider / worker plumbing](GOTCHAS.md#provider--worker-plumbing).
- **Round-trip to Native is safe by construction.** Native replay skips all tool_use/tool_result events and rebuilds from clean USER/ASSISTANT text pairs, so flipping back to Native after an ultracode turn never tries to reconstruct the `Workflow` blocks - it sees only the final synthesis (which is a clean text turn).
- **Transparency / safety.** Ultracode runs unattended with full access (it needs AUTO - headless `-p` can't answer permission prompts) and spends heavily (a fleet per turn). The full Workflow script is captured in the `Workflow` tool_use (surfaced in the Activity tab); per-subagent detail lives in the harness workflow journal. The DEBAG review gate is Native-only and does **not** cover CLI ultracode turns. UI: CONFIG → TRANSPORT toggle, a `⚡ ULTRACODE` creation-form box, and an always-visible composer pill. Acceptance smoke: `npm run smoke:ultracode` (manual; spends real quota).

### Cluster mode

When a CLI tab is a cluster member (`clusterStore.getClusterIdForWorkflow(workflowId) !== undefined`), every `claude` spawn picks up four extra inputs:

1. **`--mcp-config <abs-path>`.** `mcpConfigWriter.writeFor(cwd, workflowId, clusterId, port)` writes a per-workflow `.arco/<wfid>/mcp-config.json` containing one `mcpServers.arco-cluster` entry. The CLI spawns a per-spawn stdio MCP child from that entry - one child per `claude` invocation, NOT per-cluster by design.
2. **Plan block** appended to `--append-system-prompt`. The cluster's shared `plan.md` (≤8 KB) rendered as `--- Shared cluster plan ---\n<body>`.
3. **Role block** appended after the plan. `Your role in this cluster: <role>` when this member's role hint is set in `clusterStore.memberRoles`.
4. **Peer-mailbox prologue** prepended ahead of plan + role. Drained from the recipient's mailbox at turn start (same path Native uses - `drainPeerMailbox` in `seedWorker.ts`), emitting `peer_message_received` per drained item BEFORE the operator's `user_message_echo` (events.jsonl ordering rule).

Order is **peer prologue → plan → role → operator's existing appendSystemPrompt content** so the model reads urgent peer context first, reference plan second, framing role third (parity with Native's `buildSystemBlocks`). Combined `finalAppend` is soft-capped at 16 KB for the CLI path; the existing 64 KB tmpfile fallback (`--append-system-prompt-file`) handles overflow either way.

`mcp-config.json` shape (verified against Claude CLI 2.1.138 in the smoke environment):

```json
{
  "mcpServers": {
    "arco-cluster": {
      "command": "npx",
      "args": [
        "tsx",
        "<abs>/server/src/mcp/clusterMcpServer.ts",
        "<clusterId>",
        "<workflowId>",
        "<arcoPort>"
      ]
    }
  }
}
```

In production builds (`NODE_ENV=production`), `command` is `node` and `args[0]` is `<abs>/server/dist/mcp/clusterMcpServer.js` - no leading `tsx`. The dev path uses `tsx` so an operator running `npm run dev:server` doesn't need a separate build step.

**Why stdio, not SSE.** Anthropic's Claude CLI accepts both stdio and SSE MCP transports via `mcp-config.json`. Stdio is simpler (no port allocation, no auth, no lifecycle management beyond claude's own child-process supervision) and the per-spawn child is short-lived so the SSE benefits (one long-lived server) don't apply. The CLI handles all child-process lifecycle: spawn at claude start, kill at claude exit.

**Tool names on the wire.** Claude CLI surfaces all cluster tools namespaced `mcp__arco-cluster__<tool>` (Anthropic's convention is `mcp__<server-name>__<tool-name>`) - the 3 peer-messaging tools (`peer_list` / `peer_send` / `peer_read`), the 3 shared-plan tools (`cluster_plan_read` / `cluster_plan_tick` / `cluster_plan_write`), and 11 task-board tools (`cluster_task_*`) that are filtered out when no board is attached. Function signatures match Native's bare `peer_list` / `peer_send` / `peer_read` / ... so the model treats them identically regardless of transport.

**MCP child lifecycle.** The child reads stdin (MCP wire), writes stdout (MCP wire), and writes stderr (logging). Each tool call → one `fetch` against `http://127.0.0.1:<arcoPort>/api/clusters/<clusterId>/peer/<op>` → translated back to the MCP result shape. Policy rejections from the REST surface (`unknown_peer`, `budget_exhausted`, `content_too_large`) become `isError: true` MCP results so the model sees a tool error rather than a silent success. The child has no persistent state - it dies cleanly when claude exits.

**`mcp-config.json` cleanup.** When a workflow leaves a cluster (`handleClusterDelete` / `handleClusterMemberRemove`), the server best-effort `rm`s the file via `mcpConfigWriter.cleanupFor`. The next CLI spawn on a member with no clusterId would otherwise still see the stale config and try to launch an MCP child for a cluster that no longer exists - the child would 404 on every tool call (the REST surface checks the cluster exists before dispatching to `clusterPeerOps`), but the operator-visible churn is wasted work.

### Registry MCP

Beyond the built-in `arco-cluster` + `codebase-memory` entries, CLI Claude also gets the operator-curated **MCP registry** servers a tab has enabled. They are merged into the same `.arco/<wfid>/mcp-config.json` (via `McpConfigOptions.registryServers`, namespaced `reg-<id8>` so they can't collide with the built-ins). The **dangerous-tool denylist is ENFORCED here**: dangerous-and-unticked tools of enabled servers are appended as `--disallowedTools "mcp__<key>__<tool>,..."`. **Verified** (Claude CLI 2.1.160): `--disallowedTools` composes with `--dangerously-skip-permissions` - the named tool is removed from the model's available set entirely, while non-listed tools of the same server still work. The operator's per-tab `disabledTools` (DD11b) ride the same `--disallowedTools` flag - a disabled tool the operator never probed (so it's not in the cached tool list) is still added by name so it can't slip through. Full model + storage + protocol detail: `docs/MCP_REGISTRY.md`.

### Native transport

`server/src/providers/claude-native/` - long-lived per-workflow worker that talks directly to Anthropic's Messages API via `@anthropic-ai/sdk@^0.91.1` (Pi-pinned). The agent loop runs in Arco's process so the mid-turn steer hook fires between tool-result append and the next API round-trip.

**File layout (post-P0 carve-out).** `worker.ts` holds the `ClaudeNativeWorker` class and the turn/stream/error loop. To keep it under the 2000-line cap, the *stateless* leaf helpers live in siblings and are re-exported from `worker.ts` so existing `from './worker.js'` import paths still resolve:
- `modelParams.ts` - token ceilings (`adaptiveMaxTokensForModel`, `chooseMaxTokens`), thinking/effort params (`buildThinkingParams`, `shouldSendInterleavedThinkingBeta`), context-window lookup (`lookupCtx`).
- `contentBlocks.ts` - content-block types (`AnyContentBlock`, `ToolUseBlock`, `MessageParam`, ...), image/user-message assembly (`buildUserMessageContent`), server-tool defs (`CLAUDE_CODE_SERVER_TOOLS`), context-management edits (`buildContextManagementEditsForRequest`), the tool-loop predicate (`shouldContinueNativeToolLoop`), and the trailing-thinking stripper (`stripTrailingThinkingFromContent`).
- `workerHelpers.ts` - `replayMessagesFromEvents`, `mergeUsage`, `truncateOutput`, `planParserAdvisories`, `sleepWithSignal`.
These moves are pure (no behavior change); `workerParity.test.ts` / `stripTrailingThinking.test.ts` still import the same names from `worker.js`.

#### Auth

OAuth subscription flow adapted from `earendil-works/pi`:

- `CLIENT_ID = 9d1c250a-e61b-44d9-88ed-5944d1962f5e` (stored as base64 + `atob` at module load - minor protection against repo scrapes; not a security boundary).
- OAuth state and the PKCE verifier are independent random values. The authorization URL carries state and the S256 challenge; the callback carries code and state; the verifier stays server-side until the token exchange. Callback `127.0.0.1:53692/callback` (overridable via `ARCO_OAUTH_CALLBACK_HOST`). On `EADDRINUSE` we fall back to manual-paste mode automatically.
- Tokens persist to `~/.arco/auth.json` under `claude.native` - mode 0600, parent dir 0700, atomic tmp+rename, `proper-lockfile` around the read-refresh-write cycle. Lock is **not** held across the SDK call.
- Refresh runs 30s ahead of expiry. On `400 invalid_grant`, the loop emits `[AUTH:claude]` system_notice and fails the turn; after three consecutive auth failures within the workflow the notice escalates and auto-retry stops until the operator re-logs in.
- Re-login goes through `POST /api/auth/claude-native/login` (returns the authorize URL + a `manualFallback` flag); the callback is captured by the local server or accepted via `POST /api/auth/claude-native/callback` (`{ url }` body) for headless / port-blocked operators.

Saved Native login tokens use `https://api.anthropic.com` for both workflow requests and the Native evaluator. An inherited `ANTHROPIC_BASE_URL` alone cannot redirect them. An explicit `claudeNative.baseUrl` in the global settings file selects a custom endpoint; project settings cannot select that destination. The next turn or evaluation reads the setting, and an existing worker rebuilds its SDK client when the endpoint changes. Remove the setting to restore the provider default.

Saved-login worker and evaluator clients explicitly disable SDK API-key inheritance. Their requests carry the saved OAuth Authorization header without an unrelated environment X-Api-Key header. API-key-only SDK clients keep their environment key and endpoint.

A configured custom endpoint receives the saved Native login token. Configure only a trusted destination. This setting does not add API-key-only Native sign-in or change the SDK's environment endpoint behavior for API-key-only callers.

#### Headers (wire fingerprint)

| Header | Value | Notes |
|---|---|---|
| `anthropic-beta` | `claude-code-20250219,oauth-2025-04-20` | `+,interleaved-thinking-2025-05-14` is appended only for non-adaptive Anthropic thinking paths by default. Current Pi skips it for adaptive-thinking models because those models have interleaving built in. CONFIG has a Native-only debug override (`claudeNativeForceInterleavedThinkingBeta`) to force it for A/B testing. |
| `user-agent` | `claude-cli/2.1.319` | Pinned in `wireFingerprint.ts`, **not** tracked from `claude --version`. Anthropic gates new models on it (Fable 5.2 requires 2.1.290 or newer). Bump only on an observed rejection. |
| `x-app` | `cli` | Constant. |
| `anthropic-dangerous-direct-browser-access` | `true` | Current Pi sends it on the SDK `authToken` path; Arco mirrors that wire fingerprint. |

Fable 5.2 and Mythos 5.2 use a 1M context window and five effort levels: low, medium, high, xhigh and max. Native keeps their thinking and request prefix intact. A date suffix on bare Fable 5 or Mythos 5 keeps the original model behavior. Switching a tab from 5.2 to another model drops its earlier reasoning; the request still works.

Short utility jobs (including BRIEF, CATCH ME UP, TIDY and Smart AUTO-PICKUP) and text compaction summaries use low effort on Fable/Mythos 5.2 and later 5.x point releases. Their response caps reserve another 8,192 tokens for reasoning. Utility answers keep the original visible-size limit. Compaction input splitting reserves this extra output space too. Normal worker turns keep the selected effort and 128K response cap.

Adaptive-thinking `max_tokens` follows current Pi model metadata: Fable/Mythos 5, Opus 5 / 5.5, Opus 4.6/4.7/4.8, Sonnet 5, and the `opus`/`opus[1m]` family aliases use 128K output; Sonnet 4.6 uses 64K. Effort still rides through `output_config.effort`; the cap is headroom, not a request to spend it. Capability decisions (thinking params, max_tokens, ctx window, catalog ctx-management gating) key on `capModel()` - the concrete id Anthropic echoed for an alias tab (persisted as `meta.resolvedModelId`, announced via the `model_resolved` event). The request `model:` field is **always a concrete id**: the Messages API does not resolve family aliases (`model: "opus"` → `not_found_error: model: opus` - only the Claude Code CLI resolves them, client-side), so `requestModel()` maps an alias through `resolveClaudeAliasFromCatalog()` to the newest in-family catalog id before dispatch. The tab's configured model stays the alias, so auto-tracking lives in the resolution rather than on the wire. A turn ending `stop_reason: 'refusal'` (HTTP 200) surfaces as a `system_notice` + durable `primary_refusal` event instead of a blank turn. See [Gotchas: Claude Native transport](GOTCHAS.md#claude-native-transport) for both invariants.

The first system block is hardcoded to `"You are Claude Code, Anthropic's official CLI for Claude."` and marked `cache_control: { type: 'ephemeral', ttl: '1h' }` so all Native tabs on a machine share the cached prefix. The appendSystemPrompt block (rendered transcript / skills / CLAUDE.md) carries the standard ephemeral marker.

**Turn-discipline block.** A standing, cache-stable block sits in `buildSystemBlocks` after the env note and *before* the operator's appendSystemPrompt/systemPrompt (so operator instructions still win): the operator is not watching and cannot answer mid-turn; keep working until the request is complete or genuinely blocked; never end a turn on a status update / plan / promise of future work; and if a delegated `Task` child fails or returns nonsense, say so explicitly and adapt rather than silently working around it. The real Claude Code CLI ships this doctrine; Native's forced-first block is only the one-line identity, so without it adaptive models checkpoint mid-task ("Continuing now." → `end_turn` → idle).

#### Thinking visibility (adaptive-thinking display)

Per-tab `WorkflowConfig.claudeNativeThinkingDisplay` (`'omitted'` default | `'summarized'` | `'updates'`, Native-only). `buildThinkingParams(model, effort, display)` stamps `thinking: { type: 'adaptive', display }` on adaptive-thinking models. `omitted` is Claude-Code parity, but a multi-minute Opus/Fable adaptive think then streams only `ping` events - nothing bumps `lastPrimaryEventAt`, so the client's 30s stuck banner fires on a healthy worker (547s of legitimate silence observed with Fable 5 @ high). The CONFIG-tab **THINKING VISIBILITY** picker flips to `summarized`, streaming thinking deltas into the Activity tab (which also refresh the stuck clock). The round-trip stderr label reads `adaptive(effort,display)`. Primitives leave it unset ⇒ `omitted`; **Task children inherit** the parent's value.

**Thinking display is not retention.** `updates` requests short progress notes on
supported models (Fable 5 / 5.1 / 5.2, Mythos 5.1 / 5.2, Opus 5.5) but cannot guarantee them:
the 2026-09-01 Fable 5.1 Native acceptance emitted none. On Opus 5.5 the notes Opus 5
returned as `text` arrive as thinking blocks, so `omitted` hides them - prefer
`summarized` there. Binding-enforcing Fable/Mythos 5.2 / 5.1 and Opus 5.5 keep thinking
and an append-only prefix regardless of display mode. See `FABLE_51_APPEND_ONLY_PLAN.md`.

#### Tool surface (7a)

Read / Write / Edit / Bash / Grep / Glob / KillShell / TodoWrite. Path validation reuses `resolveWithinCwd`. Per-tool output cap 64 KB; Read gets 256 KB (looser than Ollama's 32 KB - Claude windows are larger). Edit refuses if the target file wasn't Read in this turn (Claude Code parity). Bash registers each spawned shell against the worker's per-turn shell map so KillShell + cancel can target it; `run_in_background:true` returns a `shellId` immediately. Closing or handing off the tab ends background shells still running (SIGTERM, then SIGKILL after 2 s; `taskkill` on Windows), and the worker waits until they have ended.

CLI version and help probes stop after five seconds and cap output at 2 MB. Unanswered Codex app-server RPC requests expire after 30 seconds; interrupt and compaction deadlines also cover the initial acknowledgement.

**Edit apply.** `replace_all` selects non-overlapping matches from left to right, including when whitespace normalization is needed; unmatched lines remain unchanged. When the exact `old_string` match fails, `Edit` (`editApply.ts`) falls through an ordered set of fuzzy strategies - `escape-drift` → `trailing-ws` → `indent` - each of which must resolve to exactly one location unless `replace_all`; an ambiguous fuzzy match is refused with a `closestLinesHint` rather than guessed. **Bash output** is bounded-tail: the model sees the last ~64 KB of combined chronological stdout+stderr through one accumulator, while the COMPLETE output spills to a per-run tempfile so a noisy command can't evict context. **File mutations** are serialized through a module-level per-realpath queue (`file-mutation-queue.ts`, keyed by `realpath` so symlink aliases share one queue) - this closes the silent edit-loss window when two Native workers on one cwd (e.g. cluster members) write the same file; a write that actually had to wait emits `file_mutation_queued`.

Native also advertises Anthropic server-side `web_search_20260209` and `web_fetch_20260309` tools as `web_search` / `web_fetch`, plus `code_execution_20260120` so Anthropic's 2026 server-tool dynamic filtering path is available. These are not Arco-local tools: Anthropic executes them server-side and returns `server_tool_use` plus `web_search_tool_result` / `web_fetch_tool_result` content blocks. The Native worker surfaces the invocation in activity, but never routes it through `executeNativeTool()`. After the final answer, retained Native history is pruned of completed server-tool evidence, citation metadata, and hidden thinking; the model has already integrated the useful findings, and the next-turn prompt should not retain hundreds of KB of raw server-search evidence.

**Per-turn web budget (`max_uses`).** Each turn `buildClaudeServerTools()` (`contentBlocks.ts`) stamps a `max_uses` on the `web_search` / `web_fetch` defs - an **Arco-set per-turn ceiling, not an Anthropic account limit**. When a turn exhausts it the model reports web access ran out; it resets next turn. The default is `DEFAULT_WEB_TOOL_MAX_USES = 15`; operators raise/lower it per-tab via CONFIG → **WEB LOOKUPS / TURN** (`WorkflowConfig.webSearchMaxUses`, clamped server-side to `[1, 50]`, persisted in `meta.json`). Deep Research overrides the same field per-spawn with the run's `maxRounds`. CLI transport ignores all this - it routes web tooling through the `claude` binary, which budgets itself.

`LS` is intentionally absent - Glob covers it (Pi parity). Skipped in v1: `NotebookEdit`, the Skill tool, plugins, Claude-Code's agents system. Operators who need any of these stay on CLI transport for those tabs. (Registry **MCP servers** are now supported in-process - see "Registry MCP tools" below.)

#### Tool posture (4.1)

A per-tab posture pill scopes the *exposed* toolset without changing what any tool does. Four postures (`toolPosture.ts`, the single source of truth): `full` (default - no filtering; the tool array stays byte-identical for the prefix cache), `coding`, `chat`, `review`. Each non-`full` posture keeps a curated CORE set and scrubs the rest; dynamic opt-in tools (`mcp__*` / `peer_*` / `ctx_*`) are NEVER stripped by a posture - the operator added them explicitly. Set via `set_tool_posture` (client→server), acked with `tool_posture_set`. **Session-local**: the server sets `WorkflowState.toolPosture` (never `meta.json`) and logs the change to `events.jsonl` for transcript review, so it does not survive a server restart. Takes effect on the next turn; flipping posture re-breaks the prefix cache once, then re-warms. Native-only.

#### Registry MCP tools

The Native worker is a first-class MCP host for the operator's enabled-and-allowed registry servers (`docs/MCP_REGISTRY.md`). It opens a long-lived `McpSession` (`server/src/mcp/client.ts connectServer`) per allowed server, keyed by `reg-<id8>`, reconciled at the top of every `runTurn` (`reconcileMcpSessions` - open newly-allowed, close newly-removed; sessions persist across turns). Each session's tools are appended to `buildToolDefs()` as `mcp__<key>__<tool>` defs via `registryTools.ts registryToolDefs`, which is the **authoritative denylist gate**: a dangerous-and-unticked tool is **omitted entirely** (the model never sees it - no runtime reject). `dispatchTool` routes `mcp__reg-...` calls to the matching session's `callTool`; a missing/closed/errored session returns a clean `[error] ...` and never throws into the turn loop. **MCP sessions are force-closed on `dispose()`** (tab close + after `handoff_complete`) - a leaked stdio child would otherwise outlive the worker (load-bearing; `docs/GOTCHAS.md`). `cancel()` deliberately does not touch sessions (they survive an operator CANCEL by design). A server's `inputSchema` with a top-level `oneOf`/`allOf`/`anyOf` (Anthropic 400s on those) is defensively flattened before the def is emitted.

**Env allowlist.** Each spawned MCP child's environment is built by `buildSafeEnv` (`server/src/mcp/client.ts`) - only a small allowlisted base (plus the `LC_*` / `XDG_*` families) and the server's declared `def.env` survive; the Arco host's full environment (Claude OAuth token, GitHub PAT, provider API keys) is NEVER inherited. **Per-server tool disable-list (DD11b).** A tab's per-server `disabledTools` (bare tool names) is honored at def-build time - `registryToolDefs` omits a disabled tool entirely, so the Native model never sees it (the in-process parity of the CLI `--disallowedTools` path).

#### Post-write LSP diagnostics (C3)

After a successful `Write`/`Edit`, the tool calls a **fire-and-forget** `ctx.onFileWritten?.(abs)` hook (wrapped in `try/catch` - a diagnostics failure must NEVER break the write; the write path is P0). The worker wires it to the `lspManager` subsystem (`server/src/lsp/`), which lazy-spawns the project's language server (`typescript-language-server` / `pyright` / `gopls` / `rust-analyzer`, whichever is on PATH), opens the changed file, and forwards the server's `publishDiagnostics` to the client as a workflow-scoped `diagnostics {file, items[]}` message (rendered as a count badge + list on the Activity tab). Absent server ⇒ silent no-op (operator installs the LSP server themselves - bring-your-own-upstream). Lifecycle mirrors `llamacppManager` (one server per `(cwd, languageId)`, dedup, idle-reap, shutdown-kill). **Full detail: `docs/LSP.md`.**

** (WebFetch / WebSearch) - server-side.** The plan-doc spec called for ~150 LOC of local WebFetch + WebSearch with SSRF guard, Camoufox stealth fallback, and pluggable Brave/Tavily/Kagi/SearXNG providers. Not needed: Native authenticates as Claude Code (OAuth + the pinned `claude-cli/<version>` user-agent from `wireFingerprint.ts`) and advertises Anthropic's server-side web tools. Anthropic executes calls server-side. The separate `read_url` companion uses Arco's public URL reader for file links.

#### Tool surface (7b - Arco-integrated)

| Tool | Behavior | Edge cases |
|---|---|---|
| `EnterPlanMode` | Records the plan body to a real plan file under `.arco/plans/` (title = first non-empty line, fallback "Native plan"), attaches it to the workflow (the PLAN tab renders it via the existing plan-attach pipeline), broadcasts `plan_set { workflowId, plan, source: 'native-tool', planId }`, and sets `worker.planMode = true`. While plan mode is active, `Write` and `Edit` short-circuit with `[error] write tools disabled until ExitPlanMode`. The plan body is dry-run through the same `parsePlan` invariants ([Gotchas: Plan-review parsing invariants](GOTCHAS.md#plan-review-parsing-invariants)) and any advisories return as part of the tool result so the model can correct on the next turn - never rejected. A second `EnterPlanMode` while already in plan mode replaces the body. |
| `ExitPlanMode` | Clears `worker.planMode`. Broadcasts `plan_exited { workflowId, summary? }`. The plan stays attached to the workflow. |
| `AskUserQuestion` | Emits a `system_notice` with `[ASK:claude-native:<questionId>] <question>` (and `[ASK_OPTIONS:opt1 \| opt2]` line when `options` is set). The `AskUserQuestionNotice` component detects the sentinel and renders an inline reply form (text input or option chips). The operator's reply rides the `ask_user_question_reply` WS message; the worker resolves the awaiting Promise and the agent loop continues. **One open question per worker** - a second call while one is pending returns `[error] another question is awaiting response`. **No timeout** - the question stays open until answered or the turn is cancelled. Cancel rejects the awaiting Promise cleanly. |
| `Task` | Mints a child workflow (its own visible tab cloned from the parent's config), seeds with `prompt`, runs one primary turn, and returns the child's final assistant text as the tool result. Transport, output style, and thinking-visibility inherited (Native parent → Native child). The child config **unconditionally** pins `claudeTransport: 'native'` - the Task tool only exists on Native, and the old `=== 'native'` gate missed tabs riding the settings cascade, dropping their children onto the per-turn CLI where they failed closed with `Not logged in`. H30 also fixed a prior drop where the child ignored the parent's output-style pick. The tool description carries the **self-report doctrine** - the child is instructed to END with a concise, verifiable report (what it changed, what it ran to verify, what's left uncertain) so the parent can trust the result without re-deriving it. **Depth-1 only** - the child carries `claudeNativeTaskDisabled` so its tool registry drops `Task`; a recursive call returns `[error] Task is depth-capped at 1`. Cancel of the parent cascades into `childManager.killAll` and rejects the awaiting Promise with an AbortError-style result. SubagentStop hook fires from the worker on settle (success or error). |
| `TaskOutput` | Reads the in-flight or final accumulated text of a Task-spawned child. Result is prefixed with `[in-flight]` or `[settled]` so the model can decide whether to keep waiting. Output is tail-capped at 64 KB. **Only the spawning parent can read its children** - the `tasksByTaskId` map is per-worker; cross-tab `TaskOutput` requests return `[error] no such task`. The map entry is dropped on parent dispose. |

Plan-mode write gating applies to `Write`, `Edit`, and - via **DD11a** - registry MCP tools: while `planMode` is on, `registryToolDefs(..., planMode: true)` OMITS every non-read-only MCP tool from the toolset entirely, so the model can't mutate state through an MCP server during a plan turn (closing the gap where a model could route a write around the local write-tool short-circuit). **`Bash` is not gated** - detecting write-intent in arbitrary shell commands generically isn't worth the false-positive cost; operators relying on plan mode as a hard write barrier should rely on the surrounding sandbox / CI contract instead.

The new WS messages are minimal: `plan_set`, `plan_exited`, and `ask_user_question_reply` (the AskUserQuestion reply path; client → server). `plan_attached` is reused from the existing PLAN-tab pipeline so the body renders without a new endpoint.

#### Cluster peer tools (in-process)

When the Native worker is a cluster member (`config.clusterId` set), `getPeerToolDefinitions()` (`server/src/providers/claude-native/peerTools.ts`) registers up to 17 additional tool descriptors directly into the in-process `tools[]` array - no MCP child, no `--mcp-config` - the 11 `cluster_task_*` board tools are filtered out unless a task board is attached (`ctx.taskBoardAttached`):

- `peer_list` - return roster of cluster peers with displayName + role.
- `peer_send` - `{to, content}` (≤16 KB; 15 sends per sender per operator turn). Recipient sees the message as a system block prepended to their next operator turn (or, with operator-armed AUTO-PICKUP on, fires a turn on the idle recipient).
- `peer_read` - drain own mailbox mid-turn (consumes the same messages that would otherwise auto-inject on the next operator turn).
- `cluster_plan_read` - return the full canonical shared-plan body (`{title, body, updatedAt, byteLength}`). Read-only pull channel: the per-turn injected copy may be a truncated outline for oversize plans.
- `cluster_plan_tick` - flip a single `[ ]` ↔ `[x]` checkbox in the shared cluster plan by `taskText` substring or `lineIndex`. Returns before/after state.
- `cluster_plan_write` - write the shared cluster plan body (≤32 KB markdown). Convention: only the cluster director calls this. Model-driven writes are additive once a plan exists: the server rejects writes that remove existing checkbox tasks or change their `[ ]` / `[x]` status. Use `cluster_plan_tick` for status changes; destructive replace/clear remains operator-only through the PLAN tab.

Plus 11 board-gated `cluster_task_*` task-board tools (list / show / create / claim / update / heartbeat / link / unlink / comment / block / complete) when a board is attached.

**Restricted cluster members.** A BLIND member keeps its project cwd but the
turn engine withholds the normal cluster plan/board/roster/role/focus/
efficiency/progress context and registers only `peer_send` / `peer_read` from
the cluster surface. llama.cpp and LM Studio advertise only those cluster tools to BLIND members. ISOLATED is a stricter Claude-Native-only bootstrap: the
worker cwd becomes
`~/.arco/clusters/<clusterId>/isolates/<wfid>/workspace`; Bash, KillShell,
Task, project prompt/resource discovery, attachments, hooks, skills,
knowledge/goal/codebase memory, and registry MCPs are omitted. The worker can
export bounded scratch files only through `peer_send artifact_paths`, which
copies them across the boundary on mailbox drain. Because a previously
informed session cannot be made blind retroactively, entering ISOLATED always
creates a fresh or replacement workflow and rejects history/task transfer.

CLI Claude and both Codex transports get the same peer surface via a stdio MCP child (`server/src/mcp/clusterMcpServer.ts`); Cursor gets it via an in-process loopback StreamableHTTP MCP server (`server/src/mcp/clusterMcpLoopback.ts`, ACP honors http/sse only) - see [Cluster mode](#cluster-mode) below and the [Cursor](#cursor) section. Wire-name parity: Native sees bare `peer_list`/`peer_send`/`peer_read`/etc.; CLI Claude sees the MCP-namespaced `mcp__arco-cluster__peer_list` shape. Function signatures match so the model treats them identically.

#### Hooks

`.claude/settings.json` discovery walks up from `cfg.cwd` collecting project hooks; user hooks at `~/.claude/settings.json` are read last. Project precedence per Claude Code's documented behavior. Cached on the worker; refreshed on `ensureStarted` (re-edits picked up by closing/reopening the tab).

**Project-trust gate.** Project-local agent surfaces that the worker would otherwise honor - the repo's `CLAUDE.md` (`claudeMdDiscovery.ts`), its `.claude/skills`, and its `.claude/settings.json` hooks - are suppressed until the operator vouches for the repo. `projectTrust.ts` resolves an effective trust for the cwd from a USER/GLOBAL-scope `~/.arco/trust.json` (deepest recorded ancestor wins) in a two-pass bootstrap, so a cloned repo can't self-grant trust by shipping its own trust file. Decision values are `always` / `never` (`ask` until the operator chooses); the gate logs its decision plus the suppressed-resource summary, and a recorded decision is one reversible line in `trust.json`. This closes the cloned-repo prompt-injection vector.

Native runs command hooks as Claude Code's public hooks reference describes (`fireHooks()` and `evaluateHooks()` in `hooks.ts`). The events it fires:

| Event | When | Exit 2, or a blocking JSON decision |
|---|---|---|
| `UserPromptSubmit` | At the top of `runTurn`, before the first request. Matcher ignored. | Rejects the prompt: no request is made, the operator sees the reason and the original prompt (`suppressOriginalPrompt` leaves it out). `additionalContext` and plain-text stdout ride with the prompt. |
| `PreToolUse` | Before each tool call, matched against the tool name. | Refuses the call; the model gets `PreToolUse:<tool> hook error: [<command>]: <reason>`. `permissionDecision` `deny` refuses with its reason, `ask` parks the call on the approval card (category `hook-ask`), `allow` skips no Arco check, `defer` is ignored (non-interactive mode only). `updatedInput` replaces the whole input. `additionalContext` rides with the result. |
| `PostToolUse` | After a tool that succeeded. | The tool already ran: exit 2 stderr and the `reason` of `decision: "block"` are added next to the result. `updatedToolOutput` (a string, or `{ stdout, stderr }` for the shell tool) replaces what the model sees. `additionalContext` follows the result. |
| `PostToolUseFailure` | After a tool that failed (`error` holds its text). | As PostToolUse. |
| `Stop` | When the model finished responding (not after a cancel, truncation or refusal). Matcher ignored. | Keeps the model working: the reason (or `additionalContext`) becomes its next instruction. `stop_hook_active` is true on the continuation; after `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` (default 8) continuations in a row, counted from the last tool call, the turn ends. |
| `SubagentStop` | Instead of Stop on a Task child's first turn, matched against the agent type the parent asked for (`subagent_type`, default `general-purpose`). Input adds `agent_id`, `agent_type` and `agent_transcript_path`. | As Stop, for the child. |
| `PreCompact` | Before COMPACT, FOLD and SERVER FOLD, matched against `manual` (a button) or `auto` (auto-compaction, including a compaction inside a long turn, or auto-fold). Input: `trigger`, `custom_instructions` (null). | Skips the compaction; the notice gives the reason. `systemMessage` and `continue` are discarded. Not fired for the API's own server-side compaction, which happens inside a request. |
| `Notification` | `permission_prompt` when an approval card (review gate or hook `ask`) has waited 6 s; `idle_prompt` 60 s after a turn finished with no new message since (not after a cancel, not for a Task child). Matched against the type. Input: `message`, `title`, `notification_type`. | Cannot block. Runs in the background; exit code, stdout and stderr are ignored. |

Reading a hook's result, as in the reference: exit 0 applies the JSON object on stdout (plain text is success, and context on UserPromptSubmit); exit 2 is a blocking error where the event can block, with stderr as the reason unless the JSON makes a blocking decision with its own; any other exit is a non-blocking error the operator sees as a `[HOOKS] <event>:<tool> hook error` notice with the first line of stderr, unless stdout is a valid JSON object, whose fields then decide. `continue: false` stops processing (the call is refused and the turn ends after the round; on Stop it lets the turn end), with `stopReason` shown to the operator. `systemMessage` is shown to the operator. Matching handlers run in parallel; an identical handler defined in more than one settings file runs once. Matchers: `*`, empty or none match everything; letters, digits, `_`, `-`, spaces, `,` and `|` only is an exact name or list of names; anything else is an unanchored regular expression.

`onFailure`: a failure (cannot start, exit other than 0 or 2, timeout, invalid JSON) lets the action go ahead unless `onFailure` is `"block"`, which then does what exit 2 does (no effect on Stop and SubagentStop). On Windows without Git Bash, a shell-form PreToolUse hook with `onFailure` unset also blocks on failure, as in Claude Code. `async: true` starts the hook in the background with no timeout; its `additionalContext` and `systemMessage` reach the model with the next request. `asyncRewake: true` also runs in the background (with its timeout); exit 2 wakes the model with its stderr (or stdout): during a turn with the next request, on an idle tab as a queued follow-up that starts a turn. Closing the tab or handing it off ends every background hook still running, with its child processes, and the worker waits until they have ended.

Hook input carries Claude Code's common fields plus Arco's `workflow_id`: `session_id` (the workflow id), `transcript_path` (the tab's event log, `<project>/.arco/workflows/<id>/events.jsonl`, JSON lines in Arco's own format, written in the background so it can lag the current turn), `cwd`, `permission_mode`, `hook_event_name`, and `tool_use_id` on tool events. File paths in `tool_input` (`file_path`, `notebook_path`) are absolute. During a Task child's first turn every hook also gets `agent_id` (the child's workflow id) and `agent_type`, and `session_id` and `transcript_path` name the parent. Not sent: `prompt_id`, `scratchpad_dir`, `effort`. Plugin placeholders are only rewritten in PowerShell commands.

**`if`** (`hookIf.ts`): one permission rule per handler, as in Claude Code, read on tool events only; on any other event a handler with `if` never runs. `Bash(git *)` and `PowerShell(Remove-Item *)` check each subcommand (split on `&&`, `||`, `;`, `|`, `&` and newlines, plus the bodies of `$()`, backticks, subshells and loops; leading `VAR=value`, `timeout`, `nice`, `nohup` and similar wrappers and bare `xargs` are skipped; PowerShell aliases become the cmdlet and case is ignored). A pattern naming more than the program also matches a command holding `$()`, backticks or `$VAR`. `Edit(path)` covers Edit and Write, `Read(path)` covers Read, Grep and Glob, in gitignore syntax: `//` absolute, `~/` home, `/` the settings file's project (or `~/.claude` for user settings), else the project folder, with a bare name matching at any depth. Also `WebFetch(domain:host)`, `Agent(type)` or `Task(type)`, `mcp__server`, and `Tool(param:value)`. A command it cannot take apart (an unclosed quote, a here-document, a trailing operator) or a rule it cannot read runs the hook.

Command hooks follow Claude Code's exec form and shell form (`hookLaunch()` in `hooks.ts`):

- **Exec form** (`args` set): `command` is the program, resolved on `PATH`, started with `args` as its argument list and no shell, on every system. `${CLAUDE_PROJECT_DIR}` in `command` and in each argument is replaced by the project folder as plain text. On Windows `command` must be a real program such as `node.exe`; a `.cmd` or `.bat` file needs shell form. `shell` is ignored.
- **Shell form** (no `args`): the hook's `shell` field (`"bash"` or `"powershell"`) when set, else `commandShell()` (`server/src/commandShell.ts`): `/bin/sh -c` on Linux and macOS; Git Bash on Windows (`CLAUDE_CODE_GIT_BASH_PATH`, then the Git install of `git` on `PATH`, then the standard install folders; never the WSL `bash.exe` in the Windows system folder); PowerShell on Windows without Git Bash (`pwsh.exe`, then Windows PowerShell 5.1). PowerShell gets the command base64-encoded (`-EncodedCommand`, or a temporary `.ps1` when too long for a command line) with UTF-8 input and output, and `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` rewritten to `${env:NAME}`. `"shell": "powershell"` uses `pwsh` on Linux and macOS when it is installed.

A hook that runs in PowerShell only because Git Bash is missing carries `shellNotice`, and the worker emits it once as a `[HOOKS]` system notice (information). A hook that cannot start (no shell at all, the shell it asks for is missing, or a spawn error such as a missing program or working folder) carries `notRun`; unless that failure blocks (above), the action goes ahead and the worker emits one `[HOOKS]` notice per reason.

**The shell tool on Windows without Git Bash.** As in Claude Code, the model then gets a `PowerShell` tool instead of `Bash` (`shellToolName()`), so hooks matching `PowerShell` fire for it and `Bash` matchers do not. The other name is an unknown tool, refused before any hook. Every check keyed on Bash treats it the same (`isShellToolName()` in `shared/src/shellTool.ts`): the hardline floor (which also knows the PowerShell and cmd forms of its hazards), the review gate, tool postures, isolated members, the output filter, eviction, Fold and resume digests, the tool-call counter and the tool cards. The local-model Bash tool keeps its name.

Default hook timeout 600 s (30 s on UserPromptSubmit); per-hook `timeout` field overrides. Timed-out hooks get SIGTERM then SIGKILL after 2s grace; the output is discarded. On Windows `taskkill /T /F` ends the tree at once; with Git Bash the child also carries `ARCO_PROCESS_TREE` in its environment, and the kill first lists every MSYS process holding it through Git Bash's `/proc`, because a background job (`cmd &`) loses its Windows parent and `/T` alone misses it (`spawnShellChild()` and `signalChildTree()` in `server/src/workers/processKill.ts`, used by hooks, both Bash tools and sandbox shell scripts). Git Bash commands are passed in MSYS quoting on a verbatim command line, so backslashes (a JSON hook output with a Windows path) arrive unchanged. `CLAUDE_PROJECT_DIR=cfg.cwd` is set on the subprocess env; the per-event JSON payload is written to stdin. Inherited env minus any `ARCO_*` debug flags. Hook subprocesses register against the per-turn shell map so cancel + KillShell tear them down; background hooks end when the worker is disposed.

Reading `updatedInput` is the load-bearing piece for using rtk (`rtk-ai/rtk`) on Native: drop rtk into `~/.claude/settings.json` once and Native + CLI both apply its tool_input rewrites; each rewrite emits a `hook_rewrote_input` event so transcript review can attribute it.

**Pre-tool-use guards.** `pretoolGuards.ts` runs after the PreToolUse hook fold and before `executeNativeTool`. Today: `checkConfigProtection` blocks `Edit`/`Write`/`MultiEdit` against lint/format/type-check config (`.eslintrc*`, `.prettierrc*`, `tsconfig.json`, `tsconfig.*.json`, `.editorconfig`, `.ruff.toml`, etc.) by basename match on the resolved absolute path. Returns a synthetic `[blocked by config-protection]` tool_result that nudges the model to fix the code instead of weakening the gate. Emits `tool_gate_triggered` with `gate: "config-protection"`. Default ON; per-tab CONFIG-tab toggle deferred.

Three more deterministic floors run in the same dispatcher pre-flight (all static rules, no model judgment; their order is the `PRE_TOOL_GUARDS` list in `claude-native/toolChecks.ts`): **H17 hardline-command floor** (`detectHardlineCommand` / `checkHardlineCommand`) refuses a Bash command that would restart or kill the Arco service (`systemctl ... arco...`) or `rm -rf` the repo / cwd / `$HOME` / `/` / `*` - returns `[blocked by hardline-command-floor]`. It's a coarse always-on floor, not a sandbox: nothing the model does from a turn needs to restart Arco or wipe the repo. **H47 sensitive-path write floor** (`gateSensitiveWrite`, `tools.ts`) gates a `Write` / `Edit` whose resolved path is a `.env*` file or sits under a `.git` / `.ssh` segment behind an explicit operator allow via the AskUserQuestion machinery - fail-closed (refused outright when no approval channel is wired). **H62 partial-read→full-write warning** (`checkPartialReadFullWrite`) flags a full-file `Write` to a file only partially `Read` this turn, so the model doesn't clobber the untouched tail.

**In-turn tool-loop guardrail.** `toolLoopGuard.ts` watches for the same `(tool, args)` repeating within one operator turn - the in-turn sibling of 3.1's cross-turn stuck-worker breaker. Default posture is warnings-only: a `tool_loop_warning` event + `system_notice`. The hard-stop (abort the loop) is opt-in via `ARCO_TOOL_LOOP_GUARD=stop`.

**Tool-result filtering.** `filterToolResult.ts` is a pure-TS staged pipeline applied to a single tool_result before it enters `messages[]`. Plugged into `dispatchTool` between `executeNativeToolResult` and the PostToolUse hook fold so operator-curated hook stderr / `additionalContext` stays unfiltered. Stages, all optional per pack:

1. `strip_ansi` - removes CSI / OSC / single-byte ESC sequences.
2. `replace[]` - `{ pattern: RegExp, replacement: string }[]` substitutions.
3. `skip[]` / `keep[]` - line-level drop (`keep` overrides `skip`).
4. `dedup` - collapses runs of ≥3 identical lines into `... (xN)`.
5. `parse` - optional structured parser (cargo-test, jest, pytest).
6. `head_cap` / `tail_cap` - byte caps with truncation marker.
7. `branch_on_exit` - flips a `head_cap` configuration to `tail_cap` when `exitCode !== 0` (errors land at the end of compiler / test output).

Per-pack configs live under `claude-native/filterConfigs/`. Conservative ship-day list (resolved by `resolveFilterPack(toolName, input, mode)`):

| File | Targets | Behavior |
|---|---|---|
| `bash-cargo-test.ts` | `cargo test` | green: drop `... ok` rows; red: every FAILED line + first 5 lines per `---- ... stdout ----` block |
| `bash-jest-vitest.ts` | `jest`, `vitest`, `npx jest`, `npx vitest` | green: drop `✓ / PASS` rows; red: keep `✗` markers + summary |
| `bash-pytest.ts` | `pytest`, `python -m pytest` | green: drop `PASSED`; red: preserve `FAILURES` section verbatim |
| `bash-git-status.ts` | `git status` | strip `(use "git ...")` hints + branch banner; dedup blank runs |
| `bash-find.ts` | `find` | head_cap 16 KB; tail_cap on non-zero exit |
| `bash-grep.ts` | `grep`, `rg`, `egrep`, `fgrep` | head_cap 16 KB; tail_cap on non-zero exit |
| `bash-ls.ts` | `ls`, `la`, `ll` | head_cap 8 KB |

Modes: `off` (default) → no pack runs. `conservative` → ship-day list above. `aggressive` → reserved for measured-and-promoted packs (npm install / cargo build / docker build / git push were named-deferred in DEVLOG until conservative defaults have a week of operator data).

When the filter actually shrinks output, the worker writes the pre-filter raw bytes to `<cwd>/.arco/workflows/<wfId>/artifacts/raw-tools/<turnId>-<toolUseId>.txt.gz` and stamps the workspace-relative path on the emitted `tool_filtered` event. Recovery is one `zcat` away - reversibility is required. The chat-side `FilteredChip` (`ToolCallPill`) renders `[filtered: 12.3 KB → 1.4 KB · cargo-test-drop-passing]` and copies the path to clipboard on click.

**Adding a new filter pack.** (1) Drop a file under `filterConfigs/` returning a `FilterPack`. (2) Wire its classifier into `filterConfigs/index.ts`'s `classifyBashCommand`. (3) Add a round-trip test to `filterToolResult.test.ts` (golden green input → expected line count drop; golden red input → asserted preserved markers). (4) Ship as `conservative` only after a week of operator data; promote to `aggressive` in a follow-up phase.

**Auto-compaction.** Provider uses Arco compaction near 90% for Claude Native and Ollama, reserving 10% headroom; Claude CLI and Codex retain their own behavior. Explicit per-worker and cluster policies win. Older Native `efficiencyAutoCompact` values migrate from conservative to On at 80%, aggressive to On at 70%, and off to Provider. Claude API compaction is an optional per-tab beta under ADVANCED, off for new tabs. When it is on, the Provider default does not start a second Native compaction.

**In-turn auto-compaction (Claude Native).** A single long turn (hundreds of tool calls) can fill the window before the turn ends, and the between-turn policy never gets a turn boundary. Arco runs the Native request loop itself, so the worker also checks after each tool round: when the round's measured prompt size (see "Context size from usage" below; never the summed usage of a round that ran web search, web fetch or code execution) is at least the threshold of the model's context window, it compacts before the next request and continues the same turn. A round whose size cannot be measured is skipped, never compacted. The threshold is the tab's or cluster's AUTO-COMPACTION threshold when one is set, 70% under Provider; Off means off; with Claude API compaction (beta) on, Arco does not compact in the turn. The check runs at a clean boundary: every `tool_use` of the round has its `tool_result` and no request is in flight. The history before that round is summarized with the same summarizer and projection as COMPACT (recent user and assistant text kept verbatim through `projectKeptTail`); the round itself is kept raw (the assistant message with its thinking and `tool_use` blocks, and the user message with every `tool_result`), after a user note saying the compaction was automatic and to continue the task. The request that started the turn is always kept word for word: its text and attachment references are placed before the automatic note unless a kept-tail message already carries that text; a request over `KEPT_REQUEST_MAX_BYTES` (128,000 UTF-8 bytes) is never cut, the in-turn compaction is deferred for that turn and one notice says why; `native_compacted` persists it as `keptRequest` and replay rebuilds the same user text from it. The kept tail alone does not guarantee this: in a long turn it holds tool rounds, and when the model wrote no text between tool calls a later steer or mail message collapses the opening request out of the tail. If the summary request would not fit the window, the prefix is summarized in parts, oldest first. Every part stays within its estimated input budget, including the carried summary and any leading context note; a single message larger than a part is cut into consecutive slices, so nothing is dropped. At most one in-turn compaction runs per threshold crossing: if the next request is still at or above the threshold, one notice says so and Arco does not compact again until a request falls below it. A failed summary leaves the history unchanged, posts a notice and the turn continues. CANCEL during the summary ends the turn the usual way with the history unchanged. Cancellation is latched for the whole compaction, including between summary parts and before a new summary request; later parts are not started. A later explicit compaction starts a fresh operation. A steer that arrives meanwhile is delivered after the compacted history. Events: `native_compacting` and `native_compacted` carry `trigger: 'auto-in-turn'`, `percent` and `thresholdPercent`; `native_compacted` also carries `inTurn`, the `continueNote` (replay rebuilds it so the rest of the turn pairs with it) and, when `count_tokens` answers, `promptTokensAfter` with `contextWindow`, which refresh CTX at once. Chat shows `Compacting automatically (context N%)` and then `Compacted, continuing`; there is no takeover and no COMPACTED: CONTINUE. The compaction counts for auto-handoff like any other.

**Context size from usage (Claude Native).** A response that ran server tools (web search, web fetch, code execution) is sampled several times inside one request, and its top-level `usage` fields are the sum over those passes: right for billing, wrong as a prompt size. One research round with eleven passes of about 90k tokens reads as 97% of a 1M window while the real context is under 30%. `server/src/providers/claude-native/usageContext.ts` holds the rule every context decision uses: the last `message` entry of `usage.iterations` when the API sends it (its `input_tokens` plus cache read and cache creation); otherwise the top-level usage, but only for a round with no `server_tool_use` block or server tool result; otherwise no figure. The in-turn check measures an unmeasured round with `count_tokens` on the history as it stands and skips the decision when that fails. `count_tokens` leaves out the server-tool definitions (web search, web fetch, code execution: a few hundred tokens together, under 0.5% of any window), so the count sits marginally under the next request's size; the threshold is unaffected. The end-of-turn `lastPromptTokens` (which drives `context_usage`, `context_budget`, the between-turn auto-compaction and auto-handoff readings and the CTX meter) is `count_tokens` first and the single-pass usage second; a final round that ran server tools without `usage.iterations` and without a count reports no context figure for that turn rather than an inflated one. USAGE totals keep summing every pass; when `usage.iterations` lists a `compaction` pass, which the top-level fields leave out, the billed round is the sum over all entries. Displays follow the same rule: the CTX meter and the ACTIVITY session line show the measured context size or `-`, and Claude helper usage totals are not context readings; the worker context badge remains `-` until a separate measurement is available. Turn usage is never labelled as context. Anthropic's documentation states that `usage.iterations` is present when a compaction ran during the request; whether it is also sent for plain server-tool rounds is not documented, so the fallbacks above are the normal path and the console records which one measured a round.

Saved in-turn summaries also include the verbatim assistant narration of the retained round. The live worker keeps that round raw instead, so each representation retains the narration once. Rebuilt workers recover that text through the existing text-only replay; tool protocol blocks are not added to replay. The marker schema is unchanged.

**Auto-continue.** COMPACTION AUTO-CONTINUE applies only to automatic compactions between turns. The manual COMPACT button never sends a continue message; the composer offers COMPACTED: CONTINUE instead. An in-turn compaction needs no continue message, because the turn itself goes on.

**Output style.** A per-tab picker on the CONFIG tab, in the New workflow and cluster creator, and in the cluster member settings (ADD WORKERS, REPLACE). Three levels:

- `normal`: no addendum.
- `plain` (the default): full sentences with articles, short where possible (long ones are split, with no word limit), the answer first, one name per thing, no filler or hedging, and no repeating of earlier messages. The final reply of every turn is complete: what was done, what was checked and how, what was found with exact numbers, assumptions, risks, what is left with the next step, and anything that needs the operator.
- `terse`: full sentences with articles, at most about 20 words each, the answer first, no filler, hedging or recap, and one short line per tool phase with no chatter between routine calls.

Both addenda keep every negation (not, never, no, only, except), number and unit, keep code, commands, paths, identifiers and error text verbatim, and say that text which persists outside the chat (code, comments, commits, docs, plans, board tasks and comments, mail to other agents, skills, memory files) follows the project's conventions and is never compressed. Both also keep the operator's language (or the one asked for; quoted text never switches it), show a code change as the changed lines with one or two lines of context unless the whole file is asked for, new or mostly changed, and quote only the shortest decisive error line. During tool runs both ask for one short line per phase; Plain also asks for the reason when the approach changes. No saving is claimed: current models already answer concisely, so the levels are about readability.

`DEFAULT_OUTPUT_STYLE` (`shared/src/outputStyle.ts`) is the one default. A tab, member, preset or template with no saved style uses it; an explicit `normal` stays `normal`. A saved `lite` (before 0.1.5) reads as `plain` and `caveman` (before 2026-05-10) as `terse`, on every read path (`normalizeOutputStyle`). The default is stored as unset. `outputStyleAddendum(level)` (`server/src/providers/outputStyle.ts`) returns the fixed text; it is a constant, so the prompt prefix stays byte-identical from turn to turn. Switching takes effect on the next turn.

Where each provider puts it:

| Provider | Applied | How |
|---|---|---|
| Claude Native | yes | Last system block, after `appendSystemPrompt` and `systemPrompt`; a later change is an appended system message (append-only prefix). |
| Claude CLI | yes | End of `--append-system-prompt`, after the north star and the appended prompt. |
| Codex app-server | yes | End of the stable prompt prefix, before the `---` separator. |
| Codex exec | yes | End of the prompt prefix on stdin, before the `---` separator. |
| Cursor (ACP and print) | yes | End of the prompt prefix, after the north star, before the `---` separator. |
| Ollama, llama.cpp | yes | End of the system message; `/no_think` stays first on low effort. |
| LM Studio, Strata, DeepSeek | yes | End of the system message (the shared OpenAI-compatible worker). |

**Adding a level** needs the operator's decision first. Its text keeps the negation, number, verbatim and persisted-text rules above.

**Output-style scope for primitives.** Review / Handoff seed / DOCS / GIT spawn paths force `outputStyle: 'normal'` regardless of the source tab's pick. Hard-coded at: `runReviewer.ts` (reviewer WorkerConfig), `exportContext.ts` (CLI handoff path, Native handoff path, fresh-summarizer path), `runResearch.ts`, `runCompare.ts` and `compareHandlers.ts`, `runDocEdit.ts`, `runMdTuneup.ts`, `recall/summarize.ts`, `knowledge/distill.ts`, `genesisHandlers.ts`, and `handleUserMessage` (overrides outputStyle when `UserMessage.primitive === 'docs' | 'git'`, set by the in-tab DOCS / GIT composer dialogs, and on the first turn of a plan review). DOCS / GIT new-tab spawn forces normal client-side via `spawnConfigFromRunAs`. Any other worker spawned without a level gets no addendum: only a tab's own turns resolve the default (`resolveTurnSettings`). Spawn-from-here and Task children DO inherit the tab's level - operator flips in the child tab if needed. `outputStyle.test.ts` checks the hard-coded sites.

#### Review safe-mode - edit-before-approve gate (DEBAG)

Native-only operator-armed review safe-mode gate. Per-tab `WorkflowConfig.reviewSafeMode` (`'off'` default; persists to `meta.json`). When armed, `dispatchTool` consults a STATIC sensitivity allowlist (`gateReview.ts evaluateGate`) BEFORE running each tool - categories `bash`, `git-destructive` (push / `reset --hard` / `clean -fd`), `write-outside-cwd`, `kill-shell`. A sensitive call is not executed: it parks as a `pendingGates` entry (durable in `<cwd>/.arco/workflows/<wfid>/gate-approvals.json` via `gateStore.ts`, rehydrated after a server restart) and emits `gate_required`. The operator resolves through `gate_reply` (approve, or edit-the-tool-input-then-approve) or `gate_revoke`; the server emits `gate_resolved`. "Approve all like this" emits `gate_standing` - a scoped standing approval keyed by the call's non-lossy signature, re-evaluated against later calls so an identical-shape action auto-passes. The allowlist carries NO model judgment (deterministic, operator-readable): the server pauses on a fixed rule, it never *decides* a call is safe to run. Safe-mode off ⇒ the classifier is never consulted (hot path untouched). Client surface: the `GateApprovalNotice` card.

#### Session interop

Native sessions are Arco-internal - there's no `~/.claude/projects/<sid>.jsonl` rollout file because the Anthropic Messages API is stateless and Native owns the conversation in memory + replays from `events.jsonl`. Consequence: `claude --resume <uuid>` from a terminal does **not** continue a Native session. Operators who need terminal interop run that tab in CLI transport.

#### Replay on restart

On `ensureStarted`, if the workflow's `events.jsonl` has prior `user_message_echo` + `primary_text` entries, the worker reconstructs `this.messages` from them so a server restart picks up where it left off (replay-only - periodic snapshot deferred per 14 Q7). The reconstructed shape is logged to stderr under `[claude-native:<wfid>]` for forensic comparison; tool_use / tool_result events are not replayed (the next turn sees a clean USER/ASSISTANT history).

**Restore points / forks (Native-first).** A `revert_to_point_request` (HistoryTab "REWIND CONVERSATION" action) makes the server append a `leaf_move` event and set `meta.leafSeq`; a branch-aware replay pre-pass (`filterEventsToBranch` in `resumeSummary.ts`, driven by `replayMessagesWithResumePolicy`) then reconstructs `messages` along the active leaf only (absent `leafSeq` ⇒ byte-identical to the old linear replay). The rewind is reversible - "undo the undo" is just another `leaf_move`. Native-first: the button stays visible for every provider, disabled with the reason beside it when the worker is not Claude Native, and the server refuses those requests. `branch_summary` is RESERVED and unemitted - forks ship via `leaf_move`, not `branch_summary`. This is the active-branch behavior used when resuming the conversation.

#### Context management

Anthropic's `/v1/models` exposes three context-management capabilities. Arco keeps Anthropic's server-side context edits off by default and uses Arco-managed COMPACT / Handoff as the visible pressure valves. Current behavior:

| Layer | Default | Operator control |
|---|---|---|
| `clear_thinking` (strip stale thinking blocks server-side) | off | none today; keep off unless an explicit operator surface is added |
| `clear_tool_uses` (strip stale tool i/o server-side) | off | none today; keep off unless an explicit operator surface is added |
| `compact_20260112` (server-managed summarization at threshold) | off for Native | CONFIG > ADVANCED "Claude API compaction (beta)" toggle (`WorkflowConfig.claudeNativeCompact`; explicit `true` enables) |
| Auto-handoff (Arco starts a fresh session after N compactions, default 5) | opt-in (default `false` for new tabs) | CONFIG-tab "AUTO-HANDOFF" Hand off after N compactions (`WorkflowConfig.autoHandoff.enabled`, `afterCompactions`) |

`clear_thinking` and `clear_tool_uses` ship behind `anthropic-beta: context-management-2025-06-27` if they are ever used, but Native deliberately does not send that beta or those edits by default. The 2026-05-31 Opus 4.8 A/B test showed that `clear_tool_uses` can replace live web-search evidence with `Search result was cleared`, causing repeated searches and stale-source answers. Compact rides on `compact-2026-01-12` and is emitted only when the operator has explicitly enabled the per-tab toggle and the active model's cached `/v1/models` catalog entry advertises `compact_20260112`. An unrecognized model conservatively skips all betas rather than risk a 400. Compaction is `{ type: 'compact_20260112' }` in `context_management.edits`, not a sibling `context_management.compact` object. Per-request beta-header override is set on the SDK call so a live model swap mid-tab re-evaluates capabilities cleanly. The `Claude API compaction (beta)` toggle is only rendered when `transport === 'native'` and the active model's catalog entry has `compact_20260112: { supported: true }`; missing `WorkflowConfig.claudeNativeCompact` means disabled, and explicit `true` is the durable enable.

#### Arco-side context tools (Fold / eviction / budget meter)

Distinct from the Anthropic server-side edits above - these are Arco-owned, deterministic, and run in-process:

- **Token-budget meter (2.3).** `contextBudget.ts` emits a `context_budget` event (`{ usedTokens, effectiveWindow, pct, thresholds: { foldAt? }, crossed: { fold } }`) each turn - `pct` is measured against the *effective* window (raw window minus reserved output tokens), so it's the signal the Fold / auto-fold gate reads rather than the raw-window `context_usage` that drives the CTX bar. Transient (derived from persisted `lastPromptTokens`), not persisted itself.
- **Fold + auto-fold (2.1).** A deterministic in-place transcript trim (`foldDigest.ts`) - keeps recent turns verbatim and digests the older middle, no LLM call. Manual via the composer FOLD button (`fold_workflow` WS message); armed per-tab via the CONFIG `autoFold` toggle - an `autoFold { enabled, foldAt }` field on the per-tab config-update message (default OFF; `foldAt` is **FOLD AT**, the budget-meter pct that triggers the in-place Fold; persists to `meta.json` + `WorkflowConfig.autoFold`). A Fold is not counted toward auto-handoff. Emits `context_folded`. Cheaper than Handoff or compact - same worker, no summarizer round-trip, no fresh spawn.
- **Tool-result eviction (2.2).** `toolResultEviction.ts` is the aggregate largest-first spill that fires only when a batch of tool results' summed cost exceeds the turn budget; the raw output is gzipped to a workspace-relative `rawArtifactPath` (same convention as `tool_filtered`, fully reversible) and a `tool_evicted` event (`{ toolUseId, toolName, originalBytes, filteredBytes, rawArtifactPath }`) records what was spilled.
- **Retained-history server-tool prune (`retainedContext.ts`).** After a settled turn, `pruneServerToolEvidenceAfterTurn` drops that turn's `server_tool_use` / `*_tool_result` / citation blocks (the final answer already absorbed the findings) - thinking is always kept, and the whole prune is skipped on binding-enforcing models (`enforcesPreservedThinking()`: `fable-5-2` / `fable-5-1` / `mythos-5-2` / `mythos-5-1` / `opus-5-5`). Two pairing invariants make it safe, and breaking either one wedges the tab permanently with a 400 that every later request replays: it never edits the **latest assistant message**, and it keeps any `server_tool_use` whose result lives *in* that protected message (the `pause_turn` shape, where call and result straddle two assistant messages). `stripDanglingServerToolResults` runs at the top of each turn as the mirror of `pruneOrphanToolUse` - one detector per direction. Both failure shapes and the exact 400 wordings: [Gotchas: Claude Native transport](GOTCHAS.md#claude-native-transport).
- **Workspace facts.** `workspaceFacts.ts` auto-detects the project's ecosystem / package manager / verify commands / git branch once at session start and folds a short `--- Workspace facts ---` block into the system prompt (omitted entirely when nothing is detected ⇒ zero input-token cost), so the model and any verify-loop agree on the single "did I break it?" command.
- **Aggregate `@`-ref budget gate.** Beyond the per-ref 64 KB cap, `contextRefs.ts` tracks the aggregate of all `@`-file expansions in one message: soft-warn past ~25% of the model's window, hard-refuse any ref that would push the aggregate past ~50% (with a clear "drop a ref or send fewer files" reason) so a big paste can't silently crowd out the operator's instruction.

#### Live model catalog

`server/src/catalog.ts` polls `https://api.anthropic.com/v1/models` (using the worker's OAuth tokens + standard wire fingerprint), distills the wire shape to the picker's camelCase form via `distillCatalogModel()`, and caches the result for one hour (`REFRESH_INTERVAL_MS = 60 * 60 * 1000`). Refresh is lazy - the next request after expiry triggers it; `?force=1` on `GET /api/claude-native/catalog` bypasses the cache. Capability flags (`clearThinking`, `clearToolUses`, `compact`) are derived from the catalog entry's `supportedFeatures`, but only `compact` is consumed by the worker by default. The CONFIG-tab model picker uses `compact` to gate the CONFIG > ADVANCED Claude API compaction (beta) toggle, and `getCachedModelCapabilities(modelId)` is called per Native request to decide whether to send `compact-2026-01-12` + `{ type: 'compact_20260112' }`. Cold-start, fetch failure, or an unrecognized id (operator typo, picker out of sync) all return `null` and the worker conservatively skips the beta - the `[claude-native:<wfid>] → messages.create ... ctx_mgmt=compact` log line shows what actually went out. Static fallbacks still need to be updated when a new family ships: `supportsClaudeAdaptiveThinking()` / `CLAUDE_MODEL_EFFORTS` control effort semantics, `adaptiveMaxTokensForModel()` controls output cap, and `contextEstimator.ts` controls the CTX denominator before the live catalog can help.

Compaction handles context fill; auto-handoff counts compactions (`native_compacted`, automatic and COMPACT) and starts a fresh session after N of them in one conversation. On Claude Native it needs Arco's auto-compaction on; Claude API compaction (`compact_20260112`) is not counted. See plan-doc 15 for the full combination matrix and the resolved beta-header strings.

#### Operator in-place compact (`⊟ COMPACT` / `native_compacted`)

Distinct from the Anthropic `compact_20260112` server-side edit above (which is passive + Anthropic-thresholded). This is the operator's on-demand `/compact`, the in-Arco equivalent of Claude Code CLI's slash command: `worker.compactInPlace()` (reached via `compactClaudeNativeWorker(workflowId, config)` from the `compact_workflow` WS message and the between-turn auto path) runs ONE summarization round against a clean projection of the worker's `messages[]` - its live OAuth client, current model, `FORCED_FIRST_BLOCK` leading the system, no tools, no context-management edits. The projection strips raw `tool_use` / `tool_result` protocol blocks before the summarizer request; a trailing orphan `tool_use` from a cancelled/interrupted tool loop is pruned first and logged as `ctx_action`. On success compact REPLACES `messages[]` with `compactSummarySeed(summary)` and emits a persisted `native_compacted { summary }` marker. If the cached Native worker is absent after restart/rehydrate/disposal, the compact path cold-acquires it and replays `events.jsonl` before summarizing. The next operator turn continues from the summary in the same tab; the CTX bar drops on that turn (driven by the SDK prompt count, no synthetic snapshot needed). Far cheaper than a Handoff: same worker, no portable doc, no fresh-worker spawn, no transcript re-render.

The marker is **load-bearing on replay**: `buildMessagesFromReplayEvents` and `summarizeClaudeNativePriorTurns` reset at it (same as `handoff_artifact_ready`) and re-seed via the same `compactSummarySeed`, so the compaction survives a restart byte-for-byte. Native transport only - CLI Claude has no in-process history to replace (the WS handler rejects it; use Handoff). Operator-initiated + context-REPLACING, so it sits in Handoff's eligibility class under the four-question test, not the rejected "second-LLM summarizer in the agent loop" fence. Smoke: `npm run smoke:native-compact` (replay invariant; the live summarization round is UI-acceptance). See [Gotchas: Claude Native transport](GOTCHAS.md#claude-native-transport).

#### Server Fold (`⊞ S-FOLD` / on-demand compaction)

The third context valve between the deterministic Fold (free, lossy digest) and COMPACT/Handoff. `worker.serverFoldInPlace()` (`serverFold.ts`, reached via `fold_workflow {engine:'server'}` → `serverFoldClaudeNativeWorker`) sends ONE request with Anthropic's on-demand compaction beta - header `compact-2026-09-04`, body `compaction: {type:'summarize'}` ([docs](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand)) - using the worker's live OAuth client, the **frozen** system + tools, and the tab's thinking params (no `context_management`, `tool_choice`, `stop_sequences`, `output_config.format`; `max_tokens` `SERVER_FOLD_MAX_TOKENS` = 32K because thinking counts). Only the messages before the cut are sent: the cut (`chooseServerFoldCut`) sits between a finished assistant reply and the next operator user message, keeping the last `SERVER_FOLD_KEEP_TURNS` (2) turns verbatim, shrinking toward zero while the raw tail exceeds `SERVER_FOLD_TAIL_MAX_BYTES` (256 KB). On `stop_reason:'compaction'` the history becomes `[assistant{compaction block}, ...kept turns]` and a persisted `context_folded {engine:'server', compactionBlock, keptMessages, compactionUsage, originalBytes, foldedBytes, byteDelta}` lands in `events.jsonl`. Spend comes from `usage.iterations` (top-level usage is 0) and is shown in the notice + added to the client's tab tokens.

Capability + fallback: the model must be on the documented list (`supportsServerFold`; Haiku isn't). Any failure - a 4xx naming the beta/parameter (`unsupported`), a missing summary (`max_tokens` / `tool_use` / `refusal` / empty), 429/5xx/network (`failed`) - leaves history untouched and runs the deterministic Fold in the same request; the notice names which ran and why.

After the swap the beta rides every request that carries the block (`hasLeadingServerFoldBlock` - position-based: an on-demand block is always `messages[0]`, a threshold block never is), the `compact_20260112` edit is suppressed (the API won't combine it with a signed block), and a later COMPACT / deterministic Fold first demotes the block to plain summary text (`demoteLeadingServerFoldBlock`). Undo: HISTORY rewind (`leaf_move`) to a seq before the marker; the pre-fold transcript is untouched in `events.jsonl`. Unit: `serverFold.test.ts`.

#### Throttle / errors

Anthropic returns structured `{type:'error', error:{type, message}}` envelopes. Native maps:

- 401 / `authentication_error` → `[AUTH:claude]` system_notice + fail (refresh already attempted in `ensureLiveTokens`).
- 429 / `rate_limit_error`, 529 / `overloaded_error`, 500 / `api_error` → retry × 3. **Header-aware backoff:** `resolveRateLimitWait` (`rateLimit.ts`) reads the response's `retry-after` (delta-seconds or HTTP-date) first, then falls back to the soonest `anthropic-ratelimit-*-reset` RFC-3339 timestamp; the fixed 15s/30s/60s ladder is the fallback only when no usable header is present. The SDK's own retries are disabled (`maxRetries: 0`) so this header-aware ladder is the only backoff. The CLI transport's `parseClaudeReset` text-regex sniffer is gone - Native sees the parsed JSON plus the rate-limit headers.
- 413 / `request_too_large` → fail with a Handoff-recommendation system_notice. Don't retry.
- 400 / `invalid_request_error`, 403 / `permission_error`, 400 / `billing_error`, 404 / `not_found_error` → fail; don't retry.

#### SDK upgrade recipe

The `^0.91.1` pin is intentionally stale. When bumping:

1. Confirm `Anthropic({ authToken })` still accepts the field name (read the SDK's exported `ClientOptions` type).
2. Confirm `messages.create({ stream: true })` still emits the `content_block_*` / `message_delta` / `message_stop` SSE event shape `worker.ts:consumeStream` consumes.
3. Smoke a 10-turn run on a Ledger-shaped task and check `usage.cache_read_input_tokens` against the previous baseline (cache hit rate is the regression risk).
4. Bump the `CLAUDE_CLI_VERSION` pin in `wireFingerprint.ts` only if Anthropic's edge rejects it (a new model saying "version ... or newer is required" is the usual trigger) - otherwise leave it.

The `[claude-native:<workflowId>]` log prefix is grep-stable for forensic runs; bootstrap, replay, and dispose all log under it.

### Per-tab sandbox tools

Operator-opt-in extra tool surface gated on `WorkflowConfig.efficiencySandbox === 'on'`. Per-tab CONFIG-tab toggle; default `'off'`. Native-only - CLI / Codex / Ollama / llama.cpp ignore the field (the tools are registered into the in-process Anthropic `tools[]` array which only Native controls). Inspired by `mksglu/context-mode` (the substitution-at-call-site idea) but stripped of context-mode's silent `Read` redirection + self-heal config mutation - both rejected by the operator-autonomy contract.

**Three tools register when the toggle is on:**

| Tool | Args | Result |
|---|---|---|
| `ctx_execute` | `{ language: 'node'\|'python'\|'shell', code: string }` | Runs the script in a sandboxed subprocess; returns only what the script wrote to stdout (less any `[chunk] ...` lines, which are siphoned into the FTS5 index). Aliases accepted: `js`/`javascript` → node; `py`/`python3` → python; `sh`/`bash` → shell. |
| `ctx_search` | `{ query: string, limit?: number }` | BM25 query over the per-tab chunk index. Returns top-N rows with chunkId + language + bytes + score + snippet. FTS5 MATCH syntax. |
| `ctx_fetch` | `{ chunkId: number }` | Returns the full content of a stored chunk by ID. |

**Wire shape (smoke-verified):**

```text
ctx_execute('shell', 'find . -name "*.ts" -newer .git/HEAD | head -20')
  → stdout slice, no `[chunk]` lines stored

ctx_execute('python', '''
import json, pathlib
for p in pathlib.Path('.').rglob('*.json')[:50]:
    print(f"[chunk] {p.name}: {p.stat().st_size}B")
''')
  → "[no stdout]\n\n[stored 50 chunk(s)] ids: 1, 2, 3, ..."

ctx_search('package.json')  →  rows of {chunkId, language, byteLen, snippet}
ctx_fetch(7)                →  full content of chunk #7
```

**System-prompt nudge.** When the toggle is on, `buildSystemBlocks()` appends a soft block AFTER `FORCED_FIRST_BLOCK` + cluster plan + cluster role and BEFORE the operator's `appendSystemPrompt` / `systemPrompt` / output-style addendum. Plain text describing what the tools are useful for (large file slices, noisy-output shell commands) and the `[chunk] ...` / `[chunk] ... [/chunk]` stash protocol. Not enforcement - the model still chooses per call. Block is omitted entirely when the toggle is `'off'` so there's zero input-token cost on tabs that haven't opted in.

**Per-tab SQLite + FTS5 store.** Lives at `<cwd>/.arco/workflows/<wfId>/sandbox.db`. Schema:

```sql
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  language TEXT NOT NULL,
  content TEXT NOT NULL,
  byte_len INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE chunks_fts USING fts5(content, content='chunks', content_rowid='id');
-- + triggers chunks_ai / chunks_ad to keep the FTS5 mirror in sync
```

Default `unicode61` tokenizer (no stopwords - 'added' / 'fix' / 'the' all retained in spot-checks). Implemented via `better-sqlite3` because Node 22's bundled `node:sqlite` is compiled without FTS5. `journal_mode=WAL`; the WAL sidecars (`sandbox.db-wal` / `sandbox.db-shm`) are best-effort-unlinked alongside the main file on tab close.

**Subprocess executor.** `sandboxExecutor.ts` - `spawn(..., { detached: true })` so the child is a process-group leader. Caps: 256 KB stdout, 32 KB stderr, 10 s default timeout (`ARCO_SANDBOX_TIMEOUT_MS` override, 1-600 s). On timeout: `process.kill(-pid, 'SIGTERM')` to target the whole process group, then SIGKILL escalation after 1 s. Per-call temp directory under `<cwd>/.arco/workflows/<wfId>/sandbox-tmp/run-XXXX/` so script cwd-writes don't pollute the operator repo. No self-heal block; no retry; no second-LLM fallback.

**Lifecycle.**

- **Toggle off:** future turns rebuild `tools[]` without the descriptors; the system-prompt nudge stops appending. The SQLite file stays on disk so a re-on doesn't lose stored chunks.
- **Operator CLEAR DB:** `POST /api/workflows/:wfId/sandbox/clear` truncates the chunks table, rebuilds the FTS5 index, and broadcasts `sandbox_db_cleared` so the Files-tab sub-section drops its preview list.
- **Tab close (`remove_workflow`):** `destroySandbox(cwd, wfId)` closes the cached handle and unlinks `sandbox.db` + the WAL sidecars.
- **Server restart with workflow still alive:** rehydrate restores `efficiencySandbox` from meta.json; the next ctx_execute call re-opens the SQLite file (data preserved).

**Events.** Best-effort UI freshness via `sandbox_chunk_added { workflowId, chunkId, byteLen, language }` on every chunk insert and `sandbox_db_cleared { workflowId }` on operator clear. Both ride through `broadcastWorkflow` so they land in events.jsonl for transcript replay. The ctx_* tool calls themselves emit the standard `primary_tool_use` event surface - no special-casing.

**REST.**

| Endpoint | Body / query | Behaviour |
|---|---|---|
| `GET /api/workflows/:wfId/sandbox/stats` | - | Returns `{ chunkCount, totalBytes, dbPath, recent: [{ chunkId, language, byteLen, createdAt, preview }] }` (preview = first 200 chars). |
| `POST /api/workflows/:wfId/sandbox/clear` | - | Truncates the chunks table; emits `sandbox_db_cleared`. |
| `POST /api/workflows/:wfId/sandbox/_test_insert` | `{ language, content }` | Dev-only escape hatch for the smoke harness. Gated on `NODE_ENV !== 'production'`. |

**Trust model.** Per-tab. The sandbox is intentionally per-workflow, not per-cluster - if a cluster wants a shared knowledge graph the operator can attach the codebase-memory MCP integration instead. The model knows it's calling `ctx_execute` vs `Read` - no silent redirection. The operator can read every stored chunk's full content via the Files-tab SANDBOX sub-section.

**Smoke.** `npm run smoke:phase-e` - 9/9 steps cover the toggle's persistence + meta.json round-trip, `_test_insert` landing a chunk + firing `sandbox_chunk_added` + creating sandbox.db on disk, `/sandbox/stats` reflecting chunkCount=1, clear endpoint emptying + firing `sandbox_db_cleared`, and `remove_workflow` unlinking the DB file.

---

## Codex

App-server ignores a late turn/start acknowledgement after that turn has ended. Generated images finish saving and emit their artifact and terminal tool status before the turn settles. Enabled registry servers are passed to app-server as well as exec; changing a launch definition recycles the app-server child before its next turn.

Context-window and code-mode metadata use the selected account home first, then `CODEX_HOME`, then the CLI default home. MAX therefore reads the same account metadata as the spawned CLI. Concurrent Native, Codex and Cursor catalog refreshes share the complete fallback result: unavailable catalogs return their last snapshot or an empty result for the normal picker fallback.

Two transports ship side-by-side, selected per-tab via `codex.transport`. New Arco homes use `appserver`; the home and project settings cascade can select either transport, and a per-tab choice takes precedence. Existing cascade and per-tab choices remain unchanged. Per-tab override lives on `WorkflowConfig.codexTransport` and is editable from the CONFIG tab without a server restart.

Reviewers and handoff seed turns always run on `exec` regardless of the tab's transport - the per-workflow appserver child is too heavy for one-shot reviewer paths and there's no reviewer feature that benefits from mid-turn steer.

The Codex CONFIG tab is sparse next to Claude Native by design, not omission. The Native-only efficiency knobs (Claude API compaction (beta) under CONFIG > ADVANCED, interleaved-thinking beta, tool-result filter, fact-force first edit, sandbox tools) all reach *inside* the in-process Anthropic request - request body, `anthropic-beta` headers, the `tools[]` array, or per-tool dispatch. Codex runs as an external subprocess, so Arco can't mutate those internals and the controls have nowhere to attach. **Output style is the exception:** Arco owns the prompt prefix on both transports (`turn/start` input on `appserver`, stdin on `exec`) and folds the style addendum into it. What Codex *does* surface besides output style - codebase-index/memory + MCP servers - are the things you configure *around* a subprocess rather than inside its request. See [Gotchas: Efficiency behavior](GOTCHAS.md#efficiency-behavior) for the fact-force-specific analysis (notably why the `appserver` approval bindings don't give a usable pre-execution gate today).

### `exec` transport

`server/src/providers/codex.ts`. Subprocess via `spawn('codex', args)`.

#### Spawn

`spawn('codex', args, { detached: true, cwd: workflowCwd })`. The `cwd` matters: Codex resume mode doesn't accept `-C`, so `cwd` rides on the spawn options.

#### Argv (primary, first turn)

```text
codex
  exec
  --json
  --color never
  --skip-git-repo-check
  -s <sandbox>                        # 'read-only' | 'workspace-write' | 'danger-full-access'
  -m <model>
  [-i <image>]...                       # image attachments
  [-c reasoning_effort="<e>"]         # 1:1, catalog-clamped (see Effort mapping)
  [-c model_context_window=<n>]       # MAX context policy (default)
  [-c web_search="live|disabled"]     # Chat only
  [--ephemeral]                       # Incognito only
  [-c mcp_servers.<key>....]            # cluster / registry MCP
  [-C <cwd>]
```

`<sandbox>` is the Codex permissions level. Reviewers always get `read-only`. Primaries default to `read-only` but can be set to `workspace-write` or `danger-full-access` via `WorkerConfig.sandbox`.

#### Argv (resume)

```text
codex
  exec
  resume
  <uuid>
  <prompt>
```

**GOTCHA - narrower flag surface on resume.** `codex exec resume` does **not** accept `--color`, `-s <mode>`, `-C <cwd>`, or `--add-dir`. `buildArgs` branches on `isResume` and drops them. Sandbox maps to:
- `workspace-write` → `--full-auto`
- `danger-full-access` → `--dangerously-bypass-approvals-and-sandbox`

`cwd` rides on `spawn({ cwd })` since `-C` is rejected.

#### Stdin

The full prompt (with any prepended transcript / attachments / appendSystemPrompt) is the last positional argument. Codex doesn't have a native `--system-prompt` or `--append-system-prompt` flag, so the framing is always inline.

#### Event parsing

Stdout is NDJSON via `--json`. `CodexStreamParser` (`codex-stream.ts`) handles:

- `thread.started` → `init` with `sessionId` (the thread_id UUID)
- `message.delta` → `text`
- `reasoning.delta` → `thinking`
- `command_execution` (item.type) → `tool_use` (Codex 0.121.0's bash-call shape)
- `result` / `done` → `result`
- `error` → `error`

#### Session resume

UUID-based via thread_id. Captured from the `thread.started` init event on first turn.

- **First turn** - no UUID passed; Arco mints a placeholder UUID for `meta.cliSessions[]`, then captures the real thread_id from the init event and reconciles in place via `reconcileLatestCliSession()`.
- **Resume** - `codex exec resume <thread_id> <prompt>`. Arco's `wf.primarySessionId` carries the thread_id.
- **Terminal interop** - `codex exec resume <thread_id>` from any terminal continues the same thread.

**GOTCHA - placeholder UUID reconciliation.** Without `reconcileLatestCliSession()`, the placeholder UUID would persist in `meta.cliSessions[]` forever, and the next resume would fail with "no rollout found." The reconcile happens after the first init event, before any user-visible `primary_text`.

#### Auth

`codex login status` → `{ loggedIn, email, accountType }`. `POST /api/auth-login?provider=codex` opens a terminal emulator with `codex login` for the interactive OAuth flow.

API-key fallback: `OPENAI_API_KEY` env var.

#### Capability detection

`codex --version`. `capabilities.ts` parses for supported efforts and models. Codex's current binding includes `none|minimal|low|medium|high|xhigh|max|ultra`; Arco's picker offers only the selected model's supported operator levels. Astra is the current Arco default and advertises low through ultra; GPT-6 Sol (2026-09-22) does too, and GPT-6 Luna stops at `max`. The live catalog (`codex-appserver/catalog.ts`) is the authoritative source - see [Live model catalog](#live-model-catalog-1) below.

#### Quirks

- **30-minute throttle cooldown** - Codex's 429 response doesn't carry Retry-After; Arco defaults to a 30-minute cooldown when one fires. `quota.markThrottled('codex', errorText, Date.now() + 30 * 60_000)`.
- **Sandbox flag mapping on resume** - `-s read-only` is rejected on resume; reviewers can't run with sandbox flag. Reviewers spawn fresh (no resume), which is fine for Review's `last-turn` context model.
- **Effort mapping** - Arco's `low/medium/high/xhigh/max/ultra` values pass through on both Codex transports when supported; max is no longer unconditionally collapsed to xhigh. Catalog-aware: if a model's `supportedReasoningEfforts` doesn't include the requested effort, `mapEffort` (`codex-appserver/worker.ts`) and `mapEffortToReasoning` (`codex.ts`) downgrade to the highest *supported* effort. The `primary_model` event reports the requested effort; when catalog clamping occurs this is not proof of the effective wire value.
- **Transcript hydration on Resume** - when an unclaimed Codex rollout (one with no Arco meta.json) is picked from the Resume picker, the server reads the rollout's JSONL and emits `session_entry` events to populate the chat. Implemented in `GET /api/transcript?provider=codex`.
- **No tool restriction on reviewers** - Codex doesn't have a `--tools` allowlist; reviewers rely on the read-only sandbox to prevent writes.
- **Token tracking - Codex-specific ctx formula.** `cached_input_tokens` from `turn.completed.usage` is mapped to `TokenUsage.cacheRead`; `cacheCreate` is never populated. **OpenAI's `cached_input_tokens` is a SUBSET of `input_tokens`** (not disjoint like Anthropic's three input flavours), so `input_tokens` already IS the full prompt size. The client's `contextTokens(usage, 'codex')` returns just `input` - adding cacheRead would double-count the cached portion. The hover tooltip still shows the cacheRead breakdown for visibility ("input X - of which Y from cache"). See [`GOTCHAS.md`](GOTCHAS.md) "Codex" section for why the formula is split per provider.
- **Context-window policy + reporting.** Codex's account-scoped `models_cache.json` carries `context_window`, `max_context_window`, and `effective_context_window_percent`. Arco defaults `WorkflowConfig.codexContextPolicy` to `max` and passes the selected model/account's live `max_context_window` as `model_context_window` on both transports; `standard` omits that override. The CONFIG tab shows both effective values. Missing or malformed catalog metadata fails safe to Codex's default. Codex then emits the authoritative operational window via either `turn.completed` or `event_msg::token_count.info.model_context_window`; the ContextMeter prefers this reported value, then the account catalog estimate, then static metadata. At the 2026-09-11 catalog values, Astra's STANDARD is 258.4K effective (272K × 95%) and MAX is 828.4K effective (872K × 95%). Auto-handoff reads the latest rollout snapshot, and compact clears stale local context signals.
- **Token usage - rich Codex fields.** Beyond `input`, `output`, and `cacheRead`, Codex's `turn.completed.usage` may also carry `reasoning_output_tokens` (subset of output: hidden reasoning trace, rolls forward into next turn's prompt) and `total_tokens` (provider-reported total). Both surface on `TokenUsage.reasoningOutput` and `TokenUsage.total` and appear in the ContextMeter hover and the per-worker `tokenHoverTitle`.
- **Rollout-file tail capture (post-settle).** `codex exec --json`'s `turn.completed.usage` aggregates across internal LLM calls within one operator turn - useful for billing, misleading for context-window-fill. Server tails the workflow's rollout file (`~/.codex/sessions/<y>/<m>/<d>/rollout-*-<thread_id>.jsonl`) after each turn settles, parses the latest `event_msg::token_count.info`, and broadcasts a `codex_token_snapshot` with the per-call `last_token_usage` plus `model_context_window`. Client uses these to override `lastTurnTokens` (so the CTX bar reflects the per-call reality) and to populate `modelContextWindow` (so the dot flips ●). `totalTokens` cumulative is left alone - it stays the billing-accurate aggregated number. Code: `server/src/workflows/transcripts.ts` wrapping `server/src/codexRolloutTokens.ts`; post-turn threshold refresh lives in `server/src/ws/turnEngine.ts`.
- **No concurrent-writer guard (yet).** Probe (2026-04-26) showed every rollout filename carries a unique UUID - strong evidence that `codex exec` and `exec resume` create new rollout files rather than appending. Risk is treated as low; the Claude-style guard is documented as the port target if a real corruption surfaces. Details in [`GOTCHAS.md`](GOTCHAS.md).
- **Tool verbs.** Codex emits snake_case item names (`apply_patch`, `shell_call`, `function_call`, `update_plan`, etc.); `command_execution` is normalized to `Bash` upstream in `codex-stream.ts`. The Activity tab's `TOOL_VERBS` map (`PrimaryStatus.tsx`) covers both naming conventions, so live status reads naturally on Codex tabs (`Patching`, `Running`, `Calling`, `Planning`, ...) instead of the raw snake_case fallback.

### `app-server` transport

A status update for an existing tool call updates its original Activity card
without splitting an assistant reply that is still streaming. New tool calls
still separate reply segments. The same ordering applies after reload or event
replay; tool cards keep their starting position when they complete or fail.
Cursor reasoning and operator steering still separate reply segments.

Settled app-server results now carry the last token-usage notification's
`lastPromptTokens` for ordinary workers as well as Incognito. Computer scripts
read that final-request prompt and the reported window directly for context
conditions; summed turn billing usage and delayed rollout files are not a
substitute. Transport lifecycle, model/effort and the single approved Computer
voice MCP configuration are unchanged.

`server/src/providers/codex-appserver/` - + 6b adds the long-lived transport alongside the per-turn `exec` worker; Arco ships the CONFIG-tab toggle. Unlocks non-destructive mid-turn steer (`turn/steer`) and structured cancel (`turn/interrupt`).

Bindings pinned against **codex-cli 0.128.0** (the installed CLI is newer - 0.156.x as of 2026-09; new fields are validated against it before use). Vendored TS bindings under `server/src/providers/codex-appserver/bindings/` are regenerated via `codex app-server generate-ts --out ... --experimental` - see plan doc 11.

#### Lifecycle

One `codex app-server` child per workflow tab, kept alive across turns. Spawned lazily on the first turn (handshake: `initialize` → `thread/start` for fresh, `thread/resume` with `excludeTurns: true` + `persistExtendedHistory: true` for warm). Subsequent turns reuse the same JSON-RPC connection and the same Codex thread. Disposed via `disposeProviderResources` from `handleRemoveWorkflow` on tab close.

The saved Computer chat also retires its idle child at an operator-requested
fresh-context boundary (default 50% fullness, after the full turn/queue drain).
`voice/computerContext.ts` archives the old session and clears its active ledger
before announcing the boundary; the next request uses `thread/start` with no
summary or old transcript. KEEP CONTEXT/OFF pause automatic resets. This is
separate from Codex compaction, which remains the fallback within a long turn.

The child is long-lived, but `WorkerConfig` is per-turn. The per-turn wrapper refreshes the cached worker with the current config before `ensureStarted()` / `beginTurn()`, then `beginTurn()` converts fitted images into `localImage` input items. Documents and notebooks provide decoded text alongside `[attached file: <path>]` labels; other binaries provide a note. This is what makes images attached to a cluster member/broadcast arrive in Codex app-server as actual image inputs instead of merely persisting on the Arco chat echo.

Arco passes a minimal thread config override on both `thread/start` and `thread/resume`: `web_search: "live"` (Chat tabs send `"live"` or `"disabled"` per the web toggle). Exec and exec resume explicitly send the same search policy: Agent tabs use live search; Chat follows its web toggle. This makes web search available when the model chooses to look online, without changing approvals, sandboxing, model, profile, or MCP wiring. Do not set `tools.web_search` from the vendored 0.128 bindings without revalidating against the installed Codex CLI; Codex 0.131 rejects the stale generated shape during thread bootstrap.

Reviewers and handoff seed turns always run on `exec` regardless of the tab's transport. The dispatcher branch in `server/src/providers/index.ts` only takes the appserver path when `config.codexTransport === 'appserver'`; reviewer / seed paths leave that field unset.

#### Wire protocol

NDJSON over the child's stdio (one JSON message per line). No `jsonrpc: "2.0"` envelope:
- requests `{id, method, params}`
- responses `{id, result}` or `{id, error}`
- notifications `{method, params}` (no id)

Implemented in `jsonRpc.ts`. Message names locked in vendored bindings - methods like `thread/start`, `turn/start`, `turn/steer`, `turn/interrupt`; notifications like `item/agentMessage/delta`, `item/reasoning/textDelta`, `turn/completed`, `thread/tokenUsage/updated`, `error`.

#### Mid-turn steer

The `WorkerConfig.drainSteer` callback fires on every `item/completed` notification while a turn is in flight (any item type - `commandExecution`, `fileChange`, `mcpToolCall`, etc.). When the bucket is non-empty, the worker sends `turn/steer` with `expectedTurnId: currentTurnId` and text plus any fitted `localImage` input items. Codex's protocol enforces the precondition - if the turn ended in the round-trip window the steer fails loudly rather than landing in the next turn.

The drain is destructive (server-side `splice(0)`); the worker re-enqueues on three failure shapes via the new `WorkerConfig.requeueSteer` hook:

- `activeTurnNotSteerable {turnKind: 'review' | 'compact'}` → re-enqueue to **steer** bucket. The next operator turn picks them up as steer.
- Mismatched `expectedTurnId` (turn ended) → re-enqueue as **follow-up**. The post-turn merge path picks them up.
- Other RPC / transport errors → re-enqueue as **follow-up** *plus* a `system_notice` so the operator sees the slip.

Re-broadcasts `queue_update` after the re-enqueue (the original drain emitted a snapshot showing the bucket empty). The originator's optimistic chat row stays cleared from the prior `queued_messages_drained`; PENDING is the source of truth for "items waiting" until the next drain succeeds.

Steer attachments use the same decoder as initial attachments: fitted images become `localImage` items, documents and notebooks provide text, and other binaries provide a note. Path labels identify each attachment. Local providers likewise prepare steering attachments and check vision support before sending images.

#### Cancel

Two-step. Operator hits cancel → `turn/interrupt` RPC → wait up to 5s for `turn/completed { status: 'interrupted' }` → settle. If the ack times out or the RPC errors, fall through to SIGKILL the app-server child and emit a fatal; the next operator turn re-enters `ensureStarted()` and re-resumes the thread on disk via `thread/resume`. Different from exec mode (`killProcessTree` of a per-turn child) but the operator-visible contract is identical: cancel always settles cleanly.

#### Native compact (`⊟ COMPACT` / `thread/compact/start`)

Operator-triggered native compaction - the in-Arco equivalent of `/compact` in Codex CLI. Codex owns the thread history server-side, so this is a single `thread/compact/start` RPC against the live thread (`compactThread()` in `worker.ts`, reached via `compactCodexAppServerThread(workflowId)` in `index.ts`, dispatched from the `compact_workflow` WS message in `compactHandlers.ts`). Codex summarizes earlier history into its rollout; the next operator turn continues against the compacted thread and the CTX bar drops. Persists automatically in Codex's on-disk rollout - no fresh worker, no portable doc, no resume re-feed, so it's far cheaper than a Handoff (which stays the heavier escape hatch for a clean break or provider swap).

Codex also **auto-compacts on its own** near the window ceiling (~258k usable on gpt-5.5) - that's the `thread/compacted` notification firing mid-turn, surfaced as `[codex] Thread context was compacted internally.`, and the cause of a sudden CTX drop (e.g. 250k → 42k) that is *correct tracking*, not a bug. The manual button just lets the operator trigger the same drop on demand at an idle moment.

Isolation invariant (load-bearing): because the `Turn` binding has no `turnKind`, a compact's own internal turn is indistinguishable from an operator turn. The `compacting` flag isolates it, `compactTurnId` captures its `turn/started`, and only the matching `turn/completed` unlocks the tab. `thread/compacted` is not sufficient - it can precede actual idle - and the 10-minute hard ceiling fails + recycles the app-server instead of claiming success. See [Gotchas: Codex](GOTCHAS.md#codex). Tests: `npm run test:codex-compact-lifecycle`; smoke: `npm run smoke:codex-compact` (guards only; live compaction needs a real Codex thread).

#### Thread-item handling (`emitToolUseFromItem`)

`item/started` and `item/completed` notifications carry a `ThreadItem` (the discriminated union in `bindings/v2/ThreadItem.ts`). `emitToolUseFromItem(item, status)` is the **sync** mapper from item → Arco `tool_use` event (`commandExecution → Bash`, `fileChange → apply_patch`, `webSearch`, `mcpToolCall`, `plan → update_plan`, `imageGeneration → image_generation`-started). It must stay sync/void: the `item/completed` case calls it and then fires `tryDrainSteer()` in the same tick - making the mapper async would reorder the drain hook (a load-bearing invariant).

**`imageGeneration`.** When Codex runs an `image_generation_call`, the app-server surfaces an `imageGeneration` item (`{ status, revisedPrompt, result, savedPath? }` - `result` is base64 image bytes; `savedPath`, when present, is an absolute path the app-server already wrote). Handling:

- `emitToolUseFromItem` surfaces only a **`started`** `image_generation` tool_use (Activity-tab visibility).
- On `item/completed`, the handler kicks off `handleImageGeneration(item)` **fire-and-forget** (`void` - never awaited) *before* `tryDrainSteer()`, so the persist's async fs work runs out-of-band and **the drain hook fires synchronously, unchanged**. The persist is purely additive - it touches no lifecycle / cancel / steer / drain code.
- `handleImageGeneration` calls the pure `resolveGeneratedImageTarget(cwd, item)` (`codex-appserver/imageGen.ts`): an in-cwd `savedPath` is surfaced as-is; otherwise the base64 `result` is decoded and written to `codex-image-<shortId>.png` confined with `resolveWithinCwd`. An escaping `savedPath` falls back to decoding the bytes in-cwd - it never surfaces an out-of-cwd path. Pure fs (`wx` write, suffix-bumped on collision); no subprocess. On success it emits a `primary_artifact` (`kind:'image'`, cwd-relative `path`, `openInEditor:true`) + a terminal `completed` tool_use; on any failure it emits a `failed` tool_use + a `system_notice` and never throws out of the notification handler.

**Live-shape caveat:** the `image_generation_call` RPC shape is flagged "unproven" upstream. The handler is coded against the vendored binding and **validated against a synthetic fixture** (`scripts/smoke/image-gen-codex.ts` drives `resolveGeneratedImageTarget` + an fs write), **not** a live Codex generation - live-shape validation is pending an operator running a real Codex image-gen turn. See [Media studio: H4](MEDIA_STUDIO.md#h4-image-generation-codex-only-route-shipped).

#### Throttle / auth

Protocol-level. `error.codexErrorInfo` drives `markThrottled('codex', ...)` on `usageLimitExceeded` or an explicit HTTP 429. `serverOverloaded` does **not** change provider quota state: Codex uses it for model-scoped capacity failures such as "Selected model is at capacity," which remain visible turn errors that the operator can retry or route to another model. This distinction is pinned so a single-model capacity miss is not promoted to a provider-wide 30-minute throttle. `unauthorized` surfaces as `[AUTH:codex]` system_notice (re-login UX). `contextWindowExceeded` emits a system_notice recommending Handoff. Stderr `parseCodexThrottle` regex stays as a fallback for any signal the protocol leaks differently.

#### Settings

Three layers, in priority order:

1. **Per-tab override** - `WorkflowConfig.codexTransport` (`'exec'` or `'appserver'`). Edited from the CONFIG tab's TRANSPORT row on Codex tabs. Persisted to `meta.json` (`codexTransport`) so it survives reload + server restart. Source of truth for the active tab.
2. **Cascade default** - `codex.transport` in `~/.arco/settings.json` or `<cwd>/.arco/settings.json`:

   ```json
   { "codex": { "transport": "appserver" } }
   ```

   Sanitized in `server/src/settings.ts:sanitizeCodexConfig`. Provides the default for tabs that don't carry a per-tab override.
3. **Compatibility fallback when no cascade setting exists** - `'exec'`. New Arco homes set `codex.transport` to `appserver`.

Cascade + per-tab resolution happens once per primary-turn invocation in `handleUserMessage`; an HMR-driven settings change between turns won't re-toggle the transport mid-loop. **Toggle latency**: flipping the toggle does not affect the in-flight turn or kill an already-running app-server child. The next operator turn picks up the new transport: appserver→exec leaves the existing child idle until tab close (cheap; ~100 MB RSS); exec→appserver spawns a fresh child on the next turn.

The first-time-enable warning is a global flag - `settings.codex.appserverWarningSeen` - set to `true` after dismissal, reset to `false` whenever any tab is flipped back to `exec` so a subsequent re-enable re-shows the warning.

#### Live model catalog

`server/src/providers/codex-appserver/catalog.ts` mirrors the Claude catalog pattern: spawns a short-lived `codex app-server` once an hour to call the JSON-RPC `model/list` method, distills the response into a flat picker shape (`supportedReasoningEfforts` ascending, `description`, `defaultReasoningEffort`, `supportsImageInput`, `supportsPersonality`, `additionalSpeedTiers`), and caches in-memory for `REFRESH_INTERVAL_MS = 60 * 60 * 1000`. Refresh is lazy (next request after expiry); `?force=1` on `GET /api/codex/catalog` bypasses the cache.

**Per-account (multi-profile).** Codex is the only provider with per-account auth profiles (HOME / WORK), and model *availability* is entitlement-gated per account - a higher-tier WORK plan sees e.g. `gpt-5.6-sol` where HOME sees only Terra/Luna. So the cache is a `Map` keyed by `codexHome`: each profile is fetched by spawning app-server with that `CODEX_HOME` (the same seam `probeCodexLoggedIn` and both turn transports use). `GET /api/codex/catalog?account=<profileId>` resolves via `resolveProviderAccount('codex', id)` → `codexHome` (omit → ambient `~/.codex`; unknown id → first configured account). Client-side, `App.tsx` polls each configured profile into the `codexCatalogByAccount` store map; account-aware pickers read it via the `useCodexCatalogFor(accountRef)` hook (ConfigTab, TerminalInput, SpawnDialog, WorkflowCreator, AddWorkerSection), so flipping the ACCOUNT PROFILE toggle re-filters the model list live. The plain `codexCatalog` slice remains the default-account fallback for account-less surfaces (Handoff / Review / RunAs / TabContextMenu). Model *capabilities* (efforts, image input) are account-independent, so `getCachedCodexModelCapabilities` unions across every cached snapshot.

Two consumers:

1. **Picker** - client polls `/api/codex/catalog` (per profile, see above) every 30 minutes. WorkflowCreator, SpawnDialog, HandoffDialog, ReviewDialog, RunAsPicker, RightPanel, and the TerminalInput chip popover all read from `codexCatalog` (or the account-scoped `useCodexCatalogFor`) with the static `CODEX_MODELS` list as cold-start fallback. The catalog's `description` field surfaces as the picker subline / pill `title=` tooltip ("Frontier model for complex coding...", "Ultra-fast coding model.", etc).

2. **Effort gating** - `getCachedCodexModelCapabilities(modelId)` is consulted by `mapEffort` (`codex-appserver/worker.ts`) and `mapEffortToReasoning` (`codex.ts`). If the picker sends an effort the active model doesn't advertise, the mapper downgrades to the highest supported effort instead of letting the appserver 400.

Cold-start, fetch failure, or operator typo → `null` from the cache; mappers fall through to a safe pass-through (mapping in `baseMapEffort` / `baseMapEffortToReasoning`). The probe script at `server/scripts/probe-codex-catalog.ts` is the operator-facing "is the catalog reachable" check - `cd server && npx tsx scripts/probe-codex-catalog.ts`.

### Cluster mode

Cluster mode also supports Codex (`exec` and `app-server`) members alongside Claude. Both transports register the same `arco-cluster` MCP stdio child Claude CLI uses (`server/src/mcp/clusterMcpServer.ts`), but via Codex's `-c key=value` TOML override flag instead of a JSON config file (Codex CLI has no `--mcp-config <path>` flag). The override pair lives in `server/src/mcp/mcpConfigWriter.ts` as `buildCodexMcpOverrides(clusterId, workflowId, port)` - emits two `-c` argv entries:

```text
-c mcp_servers.arco-cluster.command="npx"
-c mcp_servers.arco-cluster.args=["tsx","<abs path to clusterMcpServer.ts>","<clusterId>","<workflowId>","<port>"]
```

Operator's `~/.codex/config.toml` is left untouched - `-c` overrides only set the specific dotted keys, every other operator-configured `[mcp_servers.*]` entry flows through unchanged. No TOML merge logic, no temp config file, no operator state mutation.

### Registry MCP

Both Codex transports register enabled MCP registry servers through `-c mcp_servers.<key>.*` overrides. Codex 0.167 and later receive `disabled_tools` for explicitly disabled tools and cached dangerous tools that were not ticked. Older or unknown versions keep server-level wiring and show a per-tool enforcement warning in CONFIG. Registry denylist changes recycle app-server before the next turn. See `docs/MCP_REGISTRY.md` for probe and compatibility limits.

#### `exec` lifecycle

Per-turn - symmetric with Claude CLI. `codex.ts buildArgs()` appends the two `-c` overrides whenever `WorkerConfig.clusterId` is set; codex spawns the MCP child for the duration of the `codex exec` invocation, both die together. The plan body + role hint + drained mailbox prologue ride through `WorkerConfig.appendSystemPrompt`, which `codex.ts` already folds into the prompt prefix at `${appendSystemPrompt}\n\n---\n\n${prompt}` shape (existing prefix-cache pattern). No new code path for that.

#### `app-server` lifecycle

Per-appserver-process - the MCP child lives for the full lifetime of the long-lived `codex app-server` child, NOT per-turn. Asymmetric with `exec` and Claude CLI. `CodexAppServerWorker.ensureStarted()` injects the `-c` overrides into the `codex app-server` argv at bootstrap; `currentMcpSignature` records the bootstrap context (cluster id, board attachment, codebase-memory index, account, Codex home, access mode, role, model, context policy and tool surface).

When the operator joins / detaches a workflow from a cluster mid-conversation, or another part of that context changes, the cached worker's `currentMcpSignature` no longer matches the signature computed from the next turn's config (`computeMcpSignature`). The dispatcher (`codex-appserver/index.ts acquireWorker`) detects the mismatch, retires the cached worker, and re-bootstraps with (or without) the MCP child wired in. Codex thread state survives via `thread/resume`, so the conversation continues unbroken - only the MCP wiring flips.

Per-turn injection (plan + role + mailbox prologue) flows through `beginTurn(prompt, appendSystemPrompt)` and lands in the `UserInput[]` payload's trailing text element. Same `${appendSystemPrompt}\n\n---\n\n${prompt}` shape as `exec`. App-server has a separate bounded 48 KB cluster fold because JSON-RPC stdin has no argv ceiling; this admits the full 32 KB maximum plan plus the small cluster blocks. The 16 KB cap remains on CLI transports. Repeating a large plan consumes thread context, so 48 KB remains a ceiling rather than becoming unlimited.

For Codex cluster members, the stable operator-assigned role, code-mode tool mapping, and derived Director operating contract also ride `developerInstructions` on `thread/start` / `thread/resume`. Role or model changes recycle the app-server child and resume the same thread so those developer instructions stay current. Mutable plan content remains per-turn input.

#### Code-mode models (gpt-5.6 and GPT-6 families) - cluster addendum

The gpt-5.6 models (sol / terra / luna) and the GPT-6 models (astra / sol / luna) run OpenAI's own multi-agent "code mode" harness: the model is `/root` in a team of agents, gets native `spawn_agent` / `send_message` tools, and its tool surface becomes a JS `exec` code cell. The arco-cluster MCP tools survive but move INSIDE the exec cell's `tools` namespace under `tools.mcp__arco_cluster__<tool>` - note **dash → underscore**, unlike Claude CLI's `mcp__arco-cluster__peer_send` wire name. A code-mode member told "use peer_send" can't find any such tool and defaults to the harness's own coordination surface. Fix: `turnEngine` folds `codexCodeModeClusterAddendum()` (`server/src/providers/codexCodeMode.ts`) into the cluster blocks for Codex members whose model the codex catalog (`$CODEX_HOME/models_cache.json` `tool_mode` / `multi_agent_version`) marks as code-mode - catalog-driven, fail-open on unknown. App-server additionally sets the role/tool mapping as developer instructions, preventing Codex's `/root` framing from outranking the Arco role. Verified prompt contract: `npm run smoke:astra-cluster-director`. Full original investigation + repro: `docs/CODEX_GPT56_CLUSTER_INCOMPAT.md`.

#### Acceptance

- `npm run smoke:cluster-4` covers Codex `exec` cluster create + plan/role/peer round-trip; Codex `appserver` cluster create + plan/role/peer round-trip; mixed Native Claude + Codex `exec` cluster via REST.
- Real Codex CLI invocation (real Codex API spend) requires the manual recipe in DEVLOG.

---

### Interactive operator questions across transports

Claude Native Agent keeps its existing inline `AskUserQuestion` form. Codex
**app-server** captures `item/tool/requestUserInput` and async
`agentMessage { delivery: 'async', questions }` items. The installed 0.162.1
schema was inspected for these fields; older RPC requests without `isBlocking`
default to blocking. Vendored 0.128 bindings are extended narrowly at the reader.

Questions appear inline and under the composer's **? N QUESTIONS** button in
Agent and saved Chat. Multiple questions retain IDs, option descriptions,
freeform/secret flags and explicit submission (no default is automatically sent).
RPC answers return on the original request ID; async message answers enter the
normal user-message/steer queue, including after the original turn settles.
Permission/command approvals still use the existing deterministic declines.
Exec is headless and has no question/reply bridge; choose APPSERVER in CONFIG.

`codex-appserver/operatorQuestions.ts` owns bounded live handles (16 per worker)
and publishes structured `operator_question` states through a server-injected
publisher, so async questions remain answerable after the per-turn wrapper
unwires. Events persist through the normal workflow broadcaster; secret answers
are redacted before publishing. Incognito transport/privacy rules are unchanged.
RPC questions close on turn settlement or upstream `serverRequest/resolved`;
async message cards survive successful settlement. Explicit cancel, worker
retirement and connection death close pending handles. Late/duplicate replies
are rejected, and ordinary async replies cannot cross a changed provider/session.
Reconnect snapshots reconcile live questions and close orphaned replay cards
after a server restart. Pending cards stay hot within the existing 500-row cap.

Validation: `test:operator-questions`, `test:operator-questions-ui`, and
`smoke:operator-questions` (isolated source server + fake executable, never live
inference). Browser acceptance: `scripts/smoke/operator-questions-browser.py`
against isolated Vite with all API/WebSocket traffic stubbed.

## Cursor

ACP and print output decode UTF-8 across pipe chunks, preserving multibyte text and filenames. Cancelling native compression finishes its cancellation wait when compression settles; its fallback timer cannot kill a later turn.

`server/src/providers/cursor/` - a long-lived per-workflow ACP worker (`worker.ts`) driving
`cursor-agent acp` over JSON-RPC (`acpJsonRpc.ts`), a per-turn wrapper + worker cache (`index.ts`),
a `cursor-agent models` catalog (`catalog.ts`), and a stateless `cursor-agent -p --mode ask` one-shot
for read-only primitives (`print.ts`). Cursor is a metered subscription fronting ~150 models across
every major lab behind one login. **This section covers auth recovery, usage, compression, the model picker and cluster membership.**
Chat tabs route Cursor to the `print` transport with transcript replay; Cursor is refused for
Incognito (its CLI has no ephemeral-session flag). Attachments: the ACP worker sends native `image`
content blocks when `initialize` advertises `promptCapabilities.image` (cursor-agent 2026.09 does);
`print` (Chat + read-only primitives) has no image flag, so it passes path refs and `--add-dir`s the
upload dir so ask-mode's read tool can open them. Non-images are path refs on both.

### Auth and stale ACP recovery

`GET /api/auth-status` reads `~/.config/cursor/auth.json` fresh, while each workflow's long-lived
`cursor-agent acp` child keeps the credentials and CLI binary it started with. A successful
`cursor-agent login` or CLI update therefore does not repair an already-running ACP process by itself.
Cursor reports this condition as the ordinary assistant text `Please sign in to continue`, not as an
ACP error. `CursorAcpTurn` narrowly recognizes that exact response, withholds only its short candidate
prefix from the normal stream, emits `[AUTH:cursor]` for the shared inline re-login UI, and disposes the
cached worker. After the operator completes login and resends, `acquireWorker` starts the current CLI
with the current credentials and attempts the normal `session/load` resume. Any longer answer that only
mentions signing in falls through as normal assistant text.

Connections > Cursor runs `cursor-agent login` inside Arco (`authLoginSession.ts`, with
`NO_OPEN_BROWSER=1`) and shows the link it prints; the CLI finishes on its own once the page confirms.
`POST /api/auth-login?provider=cursor` still returns the terminal command as a fallback.

A readable token is not proof of a working sign-in. `providers/cursor/authState.ts` remembers the last
rejection (`Authentication required` from `session/new`, the sign-in reply above, a `401` from the usage
API, or an authentication error from the catalog refresh) with a fingerprint of the token it was seen
with. While that token is unchanged, the Cursor status reads not signed in with `signInRejected` and
Connections offers Sign in again; a new token (a fresh login) clears it. Status polls make no network
call; the explicit Connections check also runs `cursor-agent status` once.

Sign-in failures never count toward the start-failure breaker in `index.ts` (three failed starts in a
row stop a tab from retrying until HANDOFF): they show the `[AUTH:cursor]` sign-in notice instead, so
signing in again and resending is enough. A start that fails also ends its `cursor-agent acp` child.

### Model selection

`cursor-agent acp` ignores `--model`: every `session/new` reports `currentModelId: "default[]"`,
whatever was passed (captured in `providers/cursor/fixtures/acp-models.json`). ACP advertises one id
per model, carrying the settings saved for that model in the Cursor CLI, for example
`grok-4.7[context=256k,reasoning_effort=high,fast=true]`, and `session/set_model` and
`session/set_config_option` accept only those ids. The catalog that Arco's picker shows lists every
variant separately (`grok-4.7-medium`, `grok-4.7-high-fast`).

After every `session/new` and `session/load`, and whenever the CONFIG model changes, the worker maps
the catalog id to the advertised id by model name, effort, fast and thinking (`modelMap.ts`), selects
it with `session/set_config_option` (or `session/set_model` on a CLI without it) and checks the
returned `currentValue`. When the advertised id carries other settings than the chosen variant, the
session runs that variant and a notice names both models and how to change the saved setting (choose
the variant once in the Cursor CLI with `/model`, then HANDOFF). A model Cursor does not offer, a
refused or an unconfirmed switch also produce a notice naming the model the session runs on. The model
chip shows the effective model. Selecting a model over ACP also saves it as the Cursor CLI's default
model. The print transport passes the catalog id with `--model`, `auto` included, so a chat on Auto
does not run the CLI's saved default. The Smart AUTO-PICKUP Cursor evaluator selects and confirms the
exact model the same way and refuses (`startup_model_unavailable`, `startup_model_unconfirmed`)
otherwise.

### Usage

Cursor's ACP `result` carries **no per-turn tokens**, so Cursor never emits `primary_turn_token_usage`
and never appears in the per-project Usage aggregation. Instead `server/src/cursorUsage.ts` polls the
**authed dashboard API** (`GET /api/cursor-usage`, 3-min cache; reads `~/.config/cursor/auth.json` fresh
each poll, decodes the JWT `sub`, builds the `WorkosCursorSessionToken` cookie) for month-to-date charged-$
+ token totals + per-`kind` counts + the `get-hard-limit` `hardCapped` flag. The client polls it into the
`cursorUsage` store field and renders `CursorUsageCard` at the top of the Usage tab - it shows even when
the per-project aggregation is empty (Cursor-only projects have no per-turn events). The card is labelled
"· polled · not live" so a blank in-tab live meter reads as expected, not broken. `401/403` →
`needsLogin` + a `cursor-agent login` nudge.

The worker header deliberately renders **`CTX: Cursor-managed`**, not an invented percentage. Cursor's
ACP adapter currently returns only `{ stopReason }` from `session/prompt` and emits neither per-turn
usage nor the standard `usage_update { used, size }` notification, even though the ACP schema knows
those optional shapes. Dashboard events are billing totals across internal calls, not a retained
prompt snapshot, so they are not a valid substitute for context fill.

Incomplete Cursor usage pages never appear as complete monthly totals. A page cap or an early end before the reported event count makes the snapshot unavailable with an incomplete-usage message and a dashboard link.

### Context compression

Cursor automatically summarizes older history as its context fills. Arco also exposes an idle-only
**COMPACT** button (and `/compress` composer shortcut) that invokes Cursor's documented native
`/compress` command against the live ACP session. `CursorAcpWorker.compressConversation()` sends it as
the **entire single text block** in `session/prompt`: it must not pass through `beginTurn()`, because
that path prepends north-star + cluster plan/role/doctrine and Cursor would treat the resulting text as
an ordinary model prompt instead of a slash command. `available_commands_update` is cached outside an
active turn; when Cursor has supplied an authoritative snapshot, Arco refuses rather than guessing
if `compress` is absent. The underlying Cursor session persists the summary. Arco records the action
through the existing `ctx_action` + system-notice compact path; Handoff remains the clean-session escape
hatch. Cursor has no Arco auto-handoff: ACP does not report Cursor's own compressions, so Arco cannot count them.

**Included-allocation gauge.** `cursorUsage.ts` also GETs `/api/usage-summary` (the endpoint the Spending
page calls) → `CursorIncludedUsage` (`used`/`limit`/`remaining` cents, `totalPercentUsed` /
`autoPercentUsed` / `apiPercentUsed`, billing-cycle bounds, on-demand state). `CursorIncludedGauge`
(`client/src/components/CursorIncludedGauge.tsx`) renders it as an "Included in Pro - $X / $Y · resets ..."
bar in BOTH the Usage-tab card and the header-dot hover. The bar fill uses Cursor's own blended
`totalPercentUsed` (Cursor weights first-party vs API differently - it is NOT `used/limit`), so the gauge
matches cursor.com exactly rather than a synthesized percentage. The compact header-dot variant additionally
shows Cursor's **Other Models** quota as a separate bar driven directly by `apiPercentUsed`. Absent (endpoint drift) → the card falls
back to the charged-$/hard-cap line. The other candidate endpoints don't exist for individual accounts
(`get-hard-limit` returns only `noUsageBasedAllowed`; the legacy `/api/usage` `maxRequestUsage` is `null`
on usage-based plans) - `/api/usage-summary` is the one that carries the real allocation denominator.

### Model catalog & family × effort picker

`cursor-agent models` returns ~189 ids that are really **family × effort × flag** permutations dumped
flat (`gpt-5.3-codex-high-fast`, `claude-opus-4-8-thinking-xhigh`, ...). Rather than a 189-option wall,
the picker groups by family and offers only the efforts/flags that exist for the chosen family. The
grammar is genuinely irregular - do not "simplify" the parser without re-checking `cursor-agent models`:
effort is a trailing token OR absent (bare id = the family's default slot); `gpt-5.5` spells extra-high
as two tokens `-extra-high`; `-fast` is trailing everywhere except grok (`grok-4.5-fast-xhigh`, mid-id);
`-thinking` sits before the effort for opus-4-8 but after it for sonnet-4.6; a family name can itself end
in an effort word (`gpt-5.1-codex-max` is a family, `-max-low` = that family at low), so only ONE
trailing effort token is ever stripped; `(NO ZDR)` is a per-family display property (fable), not a
selectable variant.

- **Parser (`shared/src/protocol/models.ts`).** `parseCursorModelId(id) → {family, effort, fast,
  thinking}` (pure, total - unknown ids degrade, never throw); `buildCursorModelIndex(models)` groups the
  catalog into `CursorFamily[]` (label = word-common-prefix of member display names, so grok's offset
  effort labels don't corrupt it) + a `byKey` resolve map; `resolveCursorModelId` / `cursorEffortsFor`
  read it back. **The load-bearing rule: the UI never *synthesizes* an id - it looks up the exact id the
  catalog advertises.** Proven by `cursorModels.test.ts` (`npm run test:cursor-models`): parse is
  injective over the full live catalog (no two ids collide on a selection key) and every id round-trips
  (`resolve(parse(id)) === id`). So it's structurally impossible to send `xhigh` when the operator picked
  `high`.
- **UI (`client/src/components/CursorModelSelect.tsx`).** Drop-in for the old flat `<select>` - identical
  `{value: catalogId, onChange: (catalogId) => ...}` contract - rendering family `<select>` × effort
  `<select>` × FAST / THINK chips (+ NO-ZDR badge, + an "Auto picks model & effort" note when family is
  `auto`). Toggling a flag that removes the current effort snaps to the nearest real one. Wired into all
  six pickers (WorkflowCreator primary, ConfigTab live-swap, SpawnDialog, TerminalInput composer popover,
  cluster AddWorkerSection + ClusterMembersSection). `config.model` still stores/sends the exact flat id,
  so the worker + persistence are unchanged.
- **Effort chip honesty.** The Cursor worker's `resolveModelId()` ignores `config.primaryEffort` (effort
  lives only in the id), so `PrimaryStatus.tsx` reads the effort **back out of the resolved id** for
  Cursor and hides the chip for `auto` / bare-default ids - never the stored `primaryEffort`, which would
  be a lie.

### Cluster mode

Cursor is a `ClusterMemberProvider` - a Cursor member can hold any role at any model. Its peer tools
ride a mechanism unique among the providers: an **in-process loopback StreamableHTTP MCP server**, not
the stdio child Claude-CLI/Codex members spawn. Cursor ACP advertises `mcpCapabilities:{http:true,
sse:true}` and **no stdio** (spike-8; a stdio `mcpServers` entry was accepted but never called), so a
network transport is mandatory. An SSE micro-probe (`scripts/cursor-sse-mcp-probe.ts`, throwaway)
confirmed a loopback MCP's tools appear + are callable over ACP on both streamable-HTTP and legacy SSE;
streamable-HTTP is the chosen transport.

- **Shared tool factory.** The arco-cluster tool set (6 peer/plan tools + 11 board-gated task tools)
  was extracted from the stdio child into `server/src/mcp/clusterMcpTools.ts`
  (`registerClusterTools(server, ctx)`). Both the stdio child (`clusterMcpServer.ts`, for Claude-CLI /
  Codex) and the loopback manager (`clusterMcpLoopback.ts`, for Cursor) call it - one source of truth
  for the tool names + descriptions + REST wiring, so they can't drift.
- **Per-member listener.** `clusterMcpLoopback.ts` stands up one HTTP listener **per member**
  (workflowId) bound to `127.0.0.1:<ephemeral>` at an unguessable `/mcp/<random-token>` path,
  stateless-per-request (a fresh `McpServer` per request reads the current mutable ctx, so a mid-life
  task-board attach/detach is reflected on the next tool call). Not per-cluster: `peer_send` stamps
  `from: workflowId`, so each member needs its own baked identity - and N Cursor members can't share a
  URL. `cursor/worker.ts` calls `ensureClusterLoopbackMcp` at bootstrap when `config.clusterId` is set,
  injects `{type:'http', name:'arco-cluster', url, headers:[]}` into both `session/new` and
  `session/load` `mcpServers`, refreshes ctx each `beginTurn`, and `closeClusterLoopbackMcp` on dispose.
- **Plan/role/doctrine.** Folded into `appendSystemPrompt` via `turnEngine.ts` `needsStringFormCluster`
  (which already listed `'cursor'`), same as Claude-CLI / Codex - string-form, not a forced
  block. Cursor is not a local provider, so it does NOT go through `buildLocalClusterSystemPrompt`.
- **Model→provider inference** (`clusterHandlers.ts`). Bare `auto` + `grok-*` → `cursor`. Because Cursor
  **proxies** the claude-\*/gpt-\*/glm-\* families, those prefixes can't distinguish Cursor by id, so
  `resolveClusterOverrideProvider` skips the provider/model-mismatch check when the operator explicitly
  picked `cursor` (a Cursor member on a proxied model id is legit, not a mismatch).
- **Fresh-only (v1 limitation).** A Cursor member must be spawned already inside the cluster - its
  `session/new` carries the loopback URL at bootstrap, and `mcpServers` is fixed there. A standalone
  Cursor tab added via `AddWorkerSection`'s EXISTING mode is deliberately **excluded**: joining it would
  produce a mute member (session opened without the MCP). Fresh members (cluster creator + FRESH-spawn)
  work immediately.

**Smoke:** `npm run smoke:cursor-phase-6` (4/4 headless - no metered turns): resolver + inference, the
board-gated factory (6 vs 17 tools), and the loopback lifecycle (ensure → tools/list over a real
StreamableHTTP MCP client → idempotent re-ensure same URL, board-attach flips 6→17 → close tears the
listener down).

---

## Ollama

Stateless local replay keeps the brief and later exchanges after a completed handoff, without reintroducing the archived prefix. Failed or cancelled handoffs preserve earlier context. Messages containing literal USER or AGENT role labels use a tagged JSON-string representation internally so those lines, their whitespace and their backslashes stay inside the original message. Existing plain rendered transcripts remain readable.

`server/src/providers/ollama.ts` + `server/src/providers/ollamaTools.ts`. Pure HTTP, no subprocess.

> **Operator health readout.** The System modal's **Models** tab (A3 - `docs/DIAGNOSTICS.md`  Local model health panel) surfaces the resolved base URL, reachability, installed-model count + names, and the daemon version for Ollama, reusing `probeOllama()` / `getOllamaBase()`. Read-only, operator-triggered.

### Spawn

`fetch(\`${OLLAMA_URL_BASE}/api/chat\`, { method: 'POST', body: JSON.stringify({ model, messages, stream: true, keep_alive: '10m', tools }) })`. No subprocess; the response is an NDJSON stream. Fitted image attachments ride the final user message's `images` field when the model reports vision support; otherwise the message contains an image note. Documents and notebooks provide decoded text alongside `[attached file: <path>]` labels, while other binaries provide a note.

**Image fitting.** `providers/attachments.ts` uses the shared portable decoder
for upload copies. It fits images within 2,000 pixels per side and 5 MB base64,
including large GIFs. ImageMagick and macOS sips are optional accelerators.
Project files and their text references remain unchanged; derived model copies use
PNG or JPEG as needed. Managed JPEG and PNG uploads follow the replacement
policy below before model fitting. Path-based adapters select a copy through
`modelImagePath` or `awaitModelImage`. Claude Native prepares typed attachment
content through `readFileContent` directly. See
[Native file reads and attachments](#native-file-reads-and-attachments) for
formats, document ranges and decoder limits.

`OLLAMA_URL_BASE` defaults to `http://localhost:11434`. Override it with the env var. `settings.ollama.baseUrl` supports DD12 config-value interpolation (`!cmd ...` runs a command; `${ENV}` reads an env var) through `resolveConfigValue`, so the endpoint can be derived at resolve time. `keep_alive` is per request (`'10m'`), long enough for consecutive turns and short enough to return VRAM when a tab is idle; see Quirks.

### Multi-backend routing + resilience

`server/src/providers/ollamaResilience.ts` is the decision surface; `ollama.ts` owns the fetch/parse. The chat path can fan out across **multiple Ollama daemons** that serve overlapping model sets. The optional `modelHostMap` can pin specific models to a configured backend. Backend selection uses Arco's local resilience logic; no external router package is required.

**Config (`settings.ollama`, settings-file-only - no HTTP endpoint in v1):**

```jsonc
"ollama": {
  "baseUrl": "http://localhost:11434",          // legacy single-backend (still works)
  "backends": [                                  // multi-backend routing - supersedes baseUrl for chat when non-empty
    { "baseUrl": "http://127.0.0.1:11434", "weight": 3, "label": "primary" },
    { "baseUrl": "http://127.0.0.1:11435", "weight": 1, "label": "secondary" }
  ],
  "modelHostMap": { "qwen3-vl": ["primary"] } // optional affinity hint (model to backend labels)
}
```

Each backend: `{ baseUrl, weight?, enable?, label?, tailscaleHost? }`. **Back-compat (degenerate one-backend case):** when `backends` is empty/unset the provider synthesizes a single backend from the `baseUrl`→`OLLAMA_URL_BASE`→localhost cascade - an operator who never configures `backends` sees IDENTICAL behavior to the previous single-backend setup.

**Selection** (`selectBackend`): weighted-shuffle (cumulative-weight roll, RNG injectable for tests) over the *healthy* backends that serve the requested model. Per-backend model knowledge comes from a one-shot `/api/tags` fan-out per turn ∪ the `modelHostMap` hint (the hint only narrows). Unknown serves-model (probe failed / not fetched) is treated optimistically. The chosen host + reason land in `events.jsonl` via `system_notice`.

**Per-backend num_ctx (backend-specific probe):** the trusted num_ctx ceiling is probed on the *chosen* backend's `/api/show` - a model can be loaded with a different window per host. The result event's `modelContextWindow` reflects the host that produced the answer.

**Cooldown** (`reportFailure`): reactive, SHORT TTL - 12s remote / 6s local (a restarting local daemon recovers fast; rate-limit `Retry-After` honored up to 60s). Lazy recovery, no background prober. **Load-bearing: never cool the only/last healthy backend** (the `cooldown_skip_last` guard - see GOTCHAS).

**Retry/failover** (`backoffMs`): on a retryable error, re-select. **Instant zero backoff when a healthy peer exists**; jittered exponential (`0.5·2^n` cap 8s + ≤0.75s jitter) only when forced onto the last/only host. Retryability table (`classifyOllamaError`): conn errors (refused/timeout/reset/DNS) + 5xx/429 = retryable+cool; 4xx incl. 400 context-overflow = neither (400 is the transcript's fault - context-window fallback owns it, not a cooldown). A mid-stream drop *after bytes were emitted* does NOT fail over (would double-emit) - it surfaces as terminal.

**Connect timeout** (`OLLAMA_CONNECT_TIMEOUT_MS`, default 3s, env `ARCO_OLLAMA_CONNECT_TIMEOUT_MS`): a second AbortController aborts if response *headers* don't arrive in time, then is cleared once streaming starts (decode stays unbounded). A dead host fails in ~3s instead of hanging. The timeout abort carries `CONNECT_TIMEOUT_MARKER` so it's classified retryable, distinct from operator abort.

**Tailscale fallback (BEST-EFFORT):** on a DNS failure (`ENOTFOUND`), `resolveViaTailscale` shells out (`execFile`, argv-only, no shell) to `tailscale status --json` to resolve the host to its tailnet IP and retries once against the IP. **Cross-platform:** tries `tailscale` on PATH + `/usr/bin/tailscale` (Linux) + the macOS app-bundle path; tight 2.5s timeout; **fails soft** - a missing/erroring Tailscale never breaks normal operation. Loopback hosts are never tailscale-resolved.

### Per-model param presets

`server/src/providers/ollamaParams.ts` is the typed cast/allowlist boundary every request's params flow through (ported from open-webui `apply_model_params_to_body_ollama`). A persisted `ollamaParams` blob lives on `WorkflowConfig` / `WorkerConfig` / `WorkflowMeta` and rides `UpdatePrimaryConfigMessage`, so an operator's per-tab params survive restarts and live-edit from CONFIG without a respawn. Absorbs Hardening (`num_ctx`).

- **`OLLAMA_PARAM_SPEC`** - the allowlist table. Each key carries a `placement` (`'options'` vs request `'root'`) and a fail-closed `coerce`. Allowed keys: `num_ctx, keep_alive, num_gpu, temperature, top_p, top_k, min_p, num_predict, repeat_penalty, repeat_last_n, seed, num_batch, num_thread, num_keep` (plus `stop`). Anything unmapped is **dropped** (prevents Ollama "invalid option" warnings); a value that fails to coerce is dropped, not guessed. `keep_alive` lifts to the request root; sampler/`num_ctx` keys go under `options`.
- **Trusted-only `num_ctx` (`clampNumCtx`).** The operator may type any `num_ctx` in the UI, but it is **clamped to the model's probed `/api/show` Modelfile ceiling** - guessing high risks daemon OOM, guessing low truncates. If no trusted probe exists, `num_ctx` is **omitted entirely** and the daemon's 2048 default applies (the conservative arm of the trusted-only rule). multi-backend routing re-probes this ceiling on the *chosen* backend per turn.
- **CONFIG-tab ADVANCED PARAMS.** Collapsed-by-default section exposing the `OLLAMA_PRESET_UI_KEYS` menu (`num_ctx`, `keep_alive`, `num_gpu`, `temperature`); the rest live in the raw JSON blob for power users. Each turn emits a `system_notice` of the effective keys so the applied preset is visible in `events.jsonl`.

The applied `options` envelope is the **single insertion point** and is prefix-cache-load-bearing - see GOTCHAS.

### Structured output via `format`

`server/src/primitives/reviewSchema.ts` routes the Review primitive's structured verdict through Ollama's sampler-constrained `format` field instead of regex-scraping free text - the single biggest reliability win for small models inside primitives. `OllamaChatRequest` gains a top-level `format` field (a JSON schema), **mutually exclusive with `tools` on the wire** (`format` is only sent when no tools are advertised - `format` suppresses `tool_calls`).

- **`REVIEW_FORMAT_SCHEMA`** - a deliberately small enum-locked schema: `verdict` ∈ `PASS|MINOR|BLOCKING`, finding `severity` ∈ `info|warning|error`, every property `required` so the sampler can't drop a field. `enum` on verdict + severity is what kills the single biggest source of verdict-detection misses.
- **Two-phase reviewer (open-webui pattern).** The reviewer tool-loop runs free (native tools), then ONE schema-constrained synthesis turn produces the guaranteed-valid JSON; the verdict badge / on-disk artifact / findings are reconstructed straight from it (`StructuredReview`), no re-scrape.
- **Ollama-gated.** No other provider exposes a sampler-level `format`; the free-text fallback is preserved for them. `parsePlan` is deliberately left as deterministic human-text parsing (the plan body is operator prose, not model output).

### Token accounting

`server/src/providers/ollamaTokens.ts` tracks per-workflow input-token fill so the CTX bar lights up for Ollama and gives context compaction and context-window fallback a fill signal to gate on.

- **Ground truth** is Ollama's `prompt_eval_count` on the `done:true` line (the actual prompt count the daemon saw) → carried on the result event as `lastPromptTokens`.
- **`estimatePromptTokens`** is the forward-looking pre-turn estimate. It **counts tool-call arguments** (a tool-only assistant turn has `content:null` with the whole payload in `tool_calls[].function.arguments` - naïve counting undershoots ~20-30% and the compaction gate goes blind), plus tool results and the advertised tool schemas (sent every turn).
- Compaction estimates first apply the serving model's vision support and request image budget. Admitted images use pixel dimensions through the same pure helper as Native context management. Compression size does not alter this visual estimate. Unknown or incomplete headers use a bounded conservative image cost. The daemon's later `prompt_eval_count` remains the measured context figure.
- Reuses the existing `ContextUsageMessage` → CTX bar; the denominator is the per-backend probed `num_ctx` (`OLLAMA_DEFAULT_WINDOW` = 2048 fallback). Context compaction reads `context_usage.percentOfWindow` (post-turn) + `estimatePromptTokens()` (forward-looking) to decide whether to compact.

### Auto-compaction

`server/src/providers/ollamaRecovery.ts` ports `llamacppRecovery.ts`'s auto-compaction to Ollama, adapted to the stateless-per-turn worker shape. Persists an `ollama_compacted` event (before/after byte + token counts) to `events.jsonl` so replay re-seeds correctly and transcript review shows where history was cut.

- **Gates.** Hard compact at **0.85** fill (`ARCO_OLLAMA_COMPACT_THRESHOLD`), early **0.75** warn-only `system_notice` (`ARCO_OLLAMA_COMPACT_WARN`) suggesting Handoff before the lossy local summary fires, max **1** auto-compaction per operator turn. Because the Ollama worker is stateless per turn, `maybeCompact` fires at the **front edge** of `run()` (before the tool-loop). (llama.cpp no longer compacts; it only warns.)
- **Transform.** Keep the leading system block + current turn + last-10 messages verbatim (`ARCO_OLLAMA_COMPACT_KEEP_LAST`); summarize the older half on the utility-model summarization seam (`runUtilitySummaryJob`); deterministic structural digest (`deterministicDigest`) when the summary call returns `null` - **fails open, never closed**.
- **Tool-message invariants (load-bearing - see GOTCHAS).** `sanitizeToolMessages` repairs/drops the orphaned `role:'tool'` / dangling `tool_calls` a front-cut creates (Ollama pairs positionally - no `tool_call_id`). `truncateToolCallArgs` shrinks an oversized single tool turn to a `{_truncated_for_context: N}` placeholder, preserving name/type so pairing survives.
- Scoped **out** of utility JSON formatting one-shots; defers to context-window fallback on unknown-window or at-keep-tail-floor.

### Context-window fallback

`server/src/providers/ollamaCtxFallback.ts` `planCtxEscalation` - on a detected overflow, re-dispatch to a larger window instead of failing. Builds on multi-backend routing. Emits a `context_window_fallback` `system_notice` (from→to). **Escalate, don't re-compact** - context compaction owns the transcript; this is the escape hatch when even compaction isn't enough or a bigger window exists.

- **Order:** (1) `numctx_bump` - same backend/model, request the **full probed ceiling**, only when it's `>` the failing window; (2) `peer_backend` - a different backend whose probed window for the same model is known-larger.
- Reuses multi-backend routing's `contextOverflow` classification (only explicit context-overflow detail in a 400 triggers widening; unrelated 400 errors remain validation failures). Bounded re-dispatch (max 2 hops, `MAX_CTX_ESCALATIONS`, no re-pick), with a mid-stream guard so a re-dispatch can't double-emit.

### Relevant-tool subsetting

`server/src/providers/ollamaToolSubset.ts` (pure) caps the advertised tool catalog so large schema payloads don't degrade small-model tool selection (Hardening 7 - heuristic, no embeddings).

- **`OLLAMA_CORE_TOOLS`** = `Read/Grep/Glob/Bash` (+ cluster peer/plan tools when the workflow is a member) - never trimmed. The remainder is ranked by term-overlap relevance against the **stable system-block signal** (not the volatile last message - see prefix-cache invariant in GOTCHAS), capped at **9** (`ARCO_OLLAMA_TOOL_CAP`, floored at the core size), plus a separate allowance for the advertised cluster coordination tools.
- Computed **once per turn** from a stable signal → byte-identical `tools[]` across turns = prefix-cache-safe. Passthrough below the cap; disable entirely with `ARCO_OLLAMA_TOOL_SUBSET=0`. The chosen subset is logged to `events.jsonl`.

### Capability-gated tool handling

`server/src/providers/ollamaFencedTools.ts` makes non-tool-capable models agentic via a fenced JSON-object protocol, superseding Hardening Arco's fenced fallback.

- **`resolveToolMode`** gates on the model's probed `tools` capability (`/api/show`): `'native'` (advertise `tools[]`, parse native `tool_calls` - behavior before native tool-call support for capable models), `'fenced'` (inject the protocol, parse fenced blocks), `'none'` (no tools - no cwd / one-shot / structured `format`). Override: `ARCO_OLLAMA_TOOL_MODE = auto|native|fenced`.
- **Protocol.** A ` ```tool ` / ` ~~~tool ` fenced block holding a JSON object, folded **into the system block** (prefix-cache-stable + counted by the context-fill estimator for free - the fenced-prompt text rides every request where native schemas would). `buildFencedToolPrompt` is a **pure** function of the (already-subsetted, already-stable) tool list.
- Only explicit `tool` fences or recognized tool-call shapes request an action. Ordinary code and JSON examples remain answer text; malformed explicit tool blocks still return an argument error. `cluster_plan_tick` stays callable because changing a checkbox is a mutation, while plan readers remain injected context.
- Robust parser (fence → brace-slice → key-drift → bare-JSON fallback, with `argError` feedback). Parsed calls reuse the native `dispatchToolCalls` path; results are reframed as labeled `role:'user'` messages. The action-vs-context split: context-reader tools stay prompt-injected rather than exposed as callable tools.

### Model-lifecycle console

Turns "why did my model unload / why is VRAM full" into visible operator state. Two endpoints + a CONFIG-tab section.

- **`GET /api/ollama-ps`** - on-demand poll that fans `/api/ps` across the configured backends, fail-soft per backend (a down host shows `reachable:false` + an error, never crashes the aggregation), with the router connect-timeout and a `cooling` flag mirroring the resilience cooldown Map. Each loaded-model row carries `secondsUntilExpiry` (computed server-side from the RFC3339 `expiresAt`; `null` = forever-loaded) + `sizeVram` / `size`. See `OllamaPsAggregate` / `OllamaPsBackend` / `OllamaPsModel` in `shared/src/protocol/usage.ts`.
- **`POST /api/ollama-unload`** - the `keep_alive:0` trick (open-webui's `/api/unload`) targeting the model's **specific** backend (the console knows it from the aggregation row). Reversible (next turn reloads from disk); logged to the tab's `events.jsonl` when a `workflowId` is supplied.
- **CONFIG-tab MODEL LIFECYCLE** - collapsible per-backend loaded-models list with VRAM, a live eviction countdown, and an UNLOAD button. Polls **only while open**. Reuses `ollamaParams.keep_alive` from the parameter editor read-only with a deep-link (no fork).

### VRAM budget + auto context-sizer (`ollamaVram.ts`)

`server/src/providers/ollamaVram.ts` adds hardware awareness to the CONFIG tab via two **read-only, fail-soft** probes (both wrap `probeHardware()` + `fit.ts` estimator). All numbers are framed as estimates, never guarantees; macOS / no `nvidia-smi` ⇒ `available:false`, a down daemon ⇒ `daemonUp:false`, an unprobeable model ⇒ `found:false` - never throws.

- **`GET /api/ollama/vram` (`computeVramReport`)** - the LOCAL board's GPU VRAM (`nvidia-smi` via the hardware probe) vs what the local Ollama daemon currently has resident (`/api/ps` `size_vram`). Powers the **VRAM BUDGET** readout. Local-only by design. Returns `OllamaVramReport` (`shared/src/protocol/usage.ts`).
- **`POST /api/ollama/fit` (`computeOllamaFit`)** provides a predictive estimate. It sizes the primary model's largest `num_ctx` with room for an optional local utility model. A utility pinned to a remote `baseUrl` uses no local VRAM (`utilityRemote:true`). The report powers the `set to fit` control and primary/utility coexistence warning. Writes still go through `updatePrimaryConfig` so prefix-cache invalidation is logged. `OllamaFitReport.estimateMethod` is `measured-live` when the model is loaded; otherwise it reports `sliding-window`, `needs-load`, or `unknown`.

### Utility / task model

`server/src/providers/ollamaUtility.ts` is a **separate, non-streaming, JSON-only, capped** call shape for discrete BACKGROUND jobs - distinct from the interactive `streamOneTurn`. A configurable cheap/small model (e.g. a 3B) runs the context compaction summary (its most important consumer) and, when their operator-armed triggers ship, model-titles + recall summaries - keeping the expensive primary free.

**Config (`settings.ollama.utility`; set in Settings > Providers and models > Sign-in, accounts and local endpoints, field OLLAMA COMPACTION UTILITY MODEL, or in the settings file):**

```jsonc
"ollama": {
  "utility": { "model": "qwen3:3b", "baseUrl": "http://127.0.0.1:11434" }  // baseUrl optional (pins a warm host)
}
```

**OFF by default.** When `utility` (or `utility.model`) is unset, `runUtilityJob` returns `{ ok:false, reason:'unconfigured' }` and every caller falls back to its existing behavior (no utility model ⇒ no change). `baseUrl` optionally pins the small model to a dedicated host; unset ⇒ it weighted-shuffles across the configured `backends` like a normal turn (reusing `ollamaResilience`'s selection/cooldown/failover).

**`runUtilityJob({ job, system?, prompt?|messages?, format?, maxTokens?, windowMessages?, maxInputBytes?, onNotice? })`** - one round-trip, **`stream:false`**, **`think:false`** (a thinking-capable model left to its default would burn the whole `num_predict` budget on `message.thinking`), a hard **`num_predict`** OUTPUT cap (default 512, ceiling 4096), a **windowed INPUT** (last-N messages + a total-byte cap, oldest dropped first; a leading system message is exempt), and an optional JSON-schema **`format`** (JSON-format reuse - the result is parsed and handed back as `json`). **Two-stage timeout:** a cheap **liveness probe** (`/api/version` under the short connect timeout) fast-fails a dead/hung host before committing to the generous **180 s total round-trip budget** - that budget must cover a COLD model load PLUS the full non-streaming generation (with `stream:false` Ollama sends nothing until the whole answer is ready, so the interactive 3 s connect timeout can't apply). **Fail-soft**: never throws; a down/erroring backend ⇒ `{ ok:false, reason:'error' }`. **Visible**: every invocation emits a `system_notice` (job name, model, backend, in/out token counts) → `events.jsonl`.

**Why this is NOT a `distill` (CLAUDE.md fence):** operator-configured + opt-in (OFF by default), bounded by deterministic rules (cap + window + single shot), per-call-logged, reversible (unset the model ⇒ gone). It runs for discrete, NAMED jobs - never an automatic per-turn pass.

**utility-model summary seam:** `runUtilitySummaryJob({ messages, maxTokens?, framing?, onNotice? }) → Promise<string | null>`. Context compaction passes the **pre-sliced older-half messages** + a cap; this returns the summary text, or `null` when the utility model is unconfigured/failed. **Context compaction supplies the deterministic fallback** (a structural digest) for the `null` case - this seam never invents one, so the "never fails closed" guarantee lives in context compaction.

**Pause switch (2026-09-29):** `settings.ollama.utility.enabled: false` (Settings > Providers and models > OLLAMA COMPACTION UTILITY MODEL > ENABLED) makes `resolveUtilityConfig` return null - every job behaves as unconfigured (compaction → deterministic digest, titles skip, the fit calculator reserves nothing) while model/host/titles stay saved. Absent ⇒ enabled. The Settings save path carries `enabled`/`titles` through its whole-object replace (it used to drop them).

**Session titles (opt-in, 2026-09-29):** `settings.ollama.utility.titles: true` (default OFF - arming the utility model for compaction does NOT arm titles) makes `workflows/modelTitles.ts` generate a 5-8-word RESUME-picker title after a workflow's turns: one-shot per session, first ≤4 operator messages, 32-token cap, job `session-title` (visible `system_notice`), applied through `applyModelTitle` (logged to `title-events.jsonl`; an operator rename always outranks). Fire-and-forget after the session-index upsert in `writeMeta`; failure leaves the derived title. Tab labels (`config.name`) are operator-owned and never touched. `npm run test:model-titles`.

### Request shape

```json
{
  "model": "qwen3.6-coder",
  "messages": [
    { "role": "system",    "content": "..." },
    { "role": "user",      "content": "first turn..." },
    { "role": "assistant", "content": "<think>...</think>response" },
    { "role": "tool",      "content": "(Read result)" },
    { "role": "user",      "content": "current turn + safety footer" }
  ],
  "stream": true,
  "keep_alive": "10m",
  "options": {},
  "tools": [ { "type": "function", "function": { "name": "Read", "description": "...", "parameters": {...} } }, ... ]
}
```

`messages` is built from three sources:

1. `WorkerConfig.systemPrompt` → single `{role:'system'}`. Static across the workflow (Ollama-as-primary uses `OLLAMA_PRIMARY_SYSTEM_PROMPT` from `index.ts`).
2. `WorkerConfig.appendSystemPrompt` (the rendered `USER:`/`AGENT:` transcript) → `parseRenderedTranscript()` walks it back into structured `user`/`assistant` messages.
3. The new turn's user prompt + safety footer → final `{role:'user'}`.

Items 1 and 2 must be byte-stable across turns within a workflow - Ollama's prefix cache hits on `(1)+(2)` and only re-prefills the new tail. Inline sampler/`num_ctx` overrides are intentionally **not** plumbed (would invalidate the cache); those live in the operator-side Modelfile.

### Event parsing

NDJSON response. Each line carries either `message.content` deltas or, atomically, a `message.tool_calls` array; the final line has `done: true` plus `prompt_eval_count` / `eval_count` / `total_duration`.

- `message.thinking` (native parser) maps directly to the `thinking` event. Models with `RENDERER qwen3.5` / `PARSER qwen3.5` (or `qwen3-vl-thinking`, deepseek3, gpt-oss) emit reasoning here, separate from content. Request `think` comes from `ollamaThinkParam()` (`shared/src/protocol/ollamaThinking.ts`): boolean-only models get `effort !== 'low'`; models whose `/api/show` advertises `thinking.values` get the supported level string. `low` sends `false` when the model allows it (else its lowest level); a stored `high` on a model with no `high` level sends `true` (model default) so pre-level tabs don't escalate; other missing levels step down. The picker (`effortsForModel`, then `ollamaEffortsFor`) reads the levels from `authStatus.ollama.installedModelCapabilities[model].thinkingLevels`.
- `message.content` (plain) → `text`
- `message.content` inside `<think>...</think>` → `thinking` (handled by `ThinkSplitter` - fallback for legacy non-native-parser models like heretic-tools / qwopus that still embed `<think>` tags in content. Supports paired, orphan-close, and plain text. No-op for native-parser models since their content is already think-stripped.)
- `message.tool_calls[]` → `tool_use` event per call + executed via the server-side runtime (see Tool runtime below)
- final `done: true` → `result` with token counts (`prompt_eval_count` → `input`, `eval_count` → `output`; `total_duration` ns → `durationMs`) plus `modelContextWindow` from a parallel `/api/show` probe

### Tool runtime (server-side)

Plan 5.4 / 8.1 Path A. Ollama's HTTP API is stateless: when the model emits `tool_calls`, the *caller* executes them and feeds results back as `role:'tool'` messages. `OllamaWorkerProcess.run()` is therefore a tool-loop:

1. stream one assistant message
2. if `tool_calls` is non-empty → dispatch each via `executeOllamaTool()`, append a `role:'tool'` message per call, loop
3. if the assistant produced final text with no tool_calls → run the bounded false-final / cluster-report guards, then emit `result` and exit

Capped at `MAX_TOOL_TURNS = 50` per primary turn by default (`ARCO_OLLAMA_MAX_TOOL_TURNS`, max 200) - high enough that real coding work won't trip it, low enough that a runaway loop terminates in bounded time.

The v1 allowlist (`server/src/providers/ollamaTools.ts`):

| Tool | Args | Notes |
|---|---|---|
| `Read` | `file_path`, optional `offset` (1-based start line) / `limit` (max lines) | 32 KB byte cap, refuses directories. Tighter than Claude's 256 KB because local model windows are smaller; chunk via `offset`/`limit` for larger files. |
| `Glob` | `pattern`, optional `path` | Bounded matching under the cwd or `path`: 1,000 results, 20,000 visited entries or 1,000 milliseconds. Skips ignored folders and nested checkouts; reports results truncated. Individually ignored files and explicit ignored-folder scopes remain searchable. |
| `Grep` | `pattern`, optional `path` / `case_insensitive` / `files_only` | JavaScript content search without a ripgrep dependency; supports a single-file `path`. Skips ignored folders and nested checkouts, retaining individually ignored files and explicit ignored-folder scopes. Stops at 5,000 files, 20,000 entries or 1,000 milliseconds; 64 KB output cap and truncation notices. |
| `Write` | `file_path`, `content` | mkdir -p parents, refuses to clobber a directory. |
| `Bash` | `command`, optional `description` / `timeout` | `/bin/sh -c` (Git Bash on Windows, see `commandShell.ts`; on Windows without Git Bash it is the `PowerShell` tool, as in Claude Code) in the workflow cwd. Stdin closed (no hangs). Combined stdout+stderr cap 64 KB, default 60s timeout, hard ceiling 600s. Spawned `detached:true` so timeout / abort / output-cap kills the whole process tree. Footer reminders apply. |
| `WebSearch` | `query`, optional `max_results` (1-10, default 5) | Hits the operator's local SearXNG instance (`ARCO_SEARXNG_URL`, default `http://127.0.0.1:8888`). Returns a markdown list of `title - url\n  snippet`. SearXNG bang syntax (`!g foo`) routes to specific engines. 10s timeout. |
| `WebFetch` | `url`, optional `mode` (`auto` / `fast` / `stealth`) | Fast path: native `fetch()` with browser UA, 10s timeout, HTML→text strip. Stealth path: shells out to `/opt/camoufox/bin/python` (configurable via `ARCO_CAMOUFOX_PYTHON`) and uses Camoufox's `inner_text("body")`, 30s timeout. Auto mode tries fast, falls back to stealth on Cloudflare/403/empty signals. SSRF guard blocks loopback / RFC1918 / link-local hosts (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, IPv6 loopback / unique-local / link-local). |

STOP ends the active local Bash tree. Closing or handing off its tab also ends active local shells and drains tree cleanup and pipe closure for up to 15 seconds. This runtime is shared by Ollama, llama.cpp, LM Studio, Strata and DeepSeek; it does not expose Native's `run_in_background` API. A fully redirected background job whose command has already returned is outside this active-shell tracking.

The web tools are the only network-touching ones in v1. SSRF guard is intentional - operators who genuinely need to fetch a localhost URL can use `Bash + curl` in AUTO mode (their explicit choice).

**Path validation.** Arco-managed file tools stay within the workflow folder and reject links that leave it. Browser file views use a separate allowed-root policy that refuses private folders. That private-folder list does not apply inside project folders, so agent file tools can read project content such as `.claude` or `.codex`. Claude Native also asks before writes to a small set of sensitive targets; that approval is not a read filter. These checks are not a shell sandbox. In AUTO, local-model Bash commands execute; SAFE returns a denial. Provider CLI tools follow their own sandbox and approval settings.

**AUTO vs SAFE.** AUTO mode (`WorkerConfig.skipPermissions = true`) executes tools server-side. SAFE mode (default) returns a denial string the model sees as the tool result, so the loop converges without a new operator-approval protocol surface - the operator can always cancel mid-turn. Per 5.4 design choice (a).

**Reviewer slot.** Two paths.

- *No-cwd spawns* (legacy single-shot, e.g. heretic-as-uncensored-text) get tools omitted from the request - preserves pre-5.4 behavior.
- *Reviewer spawns from `runReviewer`* pass `tools: READ_ONLY_OLLAMA_TOOLS = ['Read','Grep','Glob','WebSearch','WebFetch']` AND override `skipPermissions: true`. The first restricts the registry; the second forces AUTO mode so tools execute (SAFE would return denial strings, defeating a code-reading reviewer). Allowlist is the safety net - Write and Bash aren't on the menu, so AUTO/SAFE doesn't apply. The reviewer also receives `LOCAL_REVIEWER_ADDENDUM` framing - a per-provider prompt addendum that explicitly tells the local reviewer to use those tools (not just opine on the diff text). See [Primitives: Review  Local-reviewer addendum](PRIMITIVES.md#local-reviewer-addendum). The same allowlist + addendum apply to llama.cpp reviewers (`READ_ONLY_LLAMACPP_TOOLS`).

When `config.tools` is set, `ollama.ts` intersects it with the registry to determine what's advertised. When `config.tools` is undefined, the spawn gets the full kit (the primary's normal flow).

**Chat web-only path.** An armed Ollama Chat receives exactly `WebSearch` and
`WebFetch`; an offline Chat receives no tools. Because Chat has no Agent AUTO
toggle, the armed pair executes directly. `ollamaToolCallAllowed()` repeats the
allowlist at dispatch so a hallucinated known tool such as `Bash` cannot cross
the projectless Chat boundary merely by naming itself in a native or fenced
tool call. Chat replay omits preserved hidden thinking because an offline turn
can contain the former no-web instruction verbatim; an armed turn also appends
a current-capability reminder after history so old visible refusals cannot pin
the model to that obsolete state.

### Session resume

**None.** Ollama is stateless; each turn is a fresh HTTP request. Multi-turn memory comes from `appendSystemPrompt` carrying the rendered workflow transcript - the prefix cache hits cleanly and only the new turn pays prefill cost. Verified ~5500 → +275 input-token delta on a real 3-turn run (see plan 12 History).

### Auth

None. Ollama is a local daemon - Arco just probes `${OLLAMA_URL_BASE}/api/tags` to confirm it's reachable and to list installed models.

### Capability detection

`probeOllama()` fetches `/api/tags`, returns the list of installed models. Model alias resolution is substring-based, case-insensitive. Example: requesting `"heretic"` matches the installed model `qwen3.5:35b-heretic`; `"coder"` matches `qwen3.6-coder:latest`.

### Quirks

- **Tool-loop cap.** `MAX_TOOL_TURNS = 50` by default (`ARCO_OLLAMA_MAX_TOOL_TURNS`, max 200). A workflow that needs more is suspect; split the task or open an issue.
- **False-final recovery.** Local thinking models sometimes answer with preparation text ("let me check...", "step 1...") and no tool calls. `OllamaWorkerProcess.run()` detects short preparatory-only replies and injects up to two private continuation prompts so the model actually calls tools or gives a real answer.
- **Cluster completion guard.** In cluster member turns, non-director Ollama workers get one bounded continuation if they try to finish without `peer_send`. The coaching prompt tells them to send a concise PASS/FAIL or DONE/BLOCKED report to the assigning peer before ending. This is a deterministic backstop for local models that understand the task but forget the peer-report tool.
- **Mid-turn steer.** Operator messages typed while an Ollama tool-loop is running are queued to the steering bucket and delivered at the next iteration boundary - `OllamaWorkerProcess.run` calls `WorkerConfig.drainSteer` after `messages.push(...toolResults)` and before the next `streamOneTurn`, appending each drained item as a `role:'user'` message. Drains the *whole* steering bucket per hook fire (not one-at-a-time); follow-up bucket is untouched and still drains as the merged post-turn turn. Steers landing while the worker is mid-API-call deliver on the *next* iteration - Arco does not abort in-flight calls. Persistence shape is unchanged: the `user_message_echo` with `kind: 'steer'` was emitted at enqueue time in `handleUserMessage`, so transcript replay shows the steer at its enqueue position. The drain-time broadcasts are `queue_update` (updates PENDING) + `queued_messages_drained` (clears the originator's queued optimistic).
- **Single-slot daemon.** `OLLAMA_NUM_PARALLEL=1` + `OLLAMA_MAX_LOADED_MODELS=1` are required for prefix-cache reliability; concurrent workflows hitting the same daemon will serialize.
- **Polite eviction.** `keep_alive` defaults to `'10m'` per request - long enough that consecutive turns never reload, short enough that walking away from a workflow returns VRAM to other GPU consumers (Resolve, games). Override via daemon-level `OLLAMA_KEEP_ALIVE` env if you want forever-loaded; per-request value still wins.
- **Cache invariance.** Anything that mutates the system prompt, transcript bytes, or `options` between turns flushes the prefix cache. Don't inject timestamps / random ids into system prompts.
- **Think handling, two paths.** Native-parser models (qwen3.5/3.6 with RENDERER+PARSER qwen3.5, qwen3-vl-thinking, deepseek3, gpt-oss) emit reasoning into `message.thinking`; ThinkSplitter is a fallback for legacy `<think>`-in-content models (heretic-tools, qwopus). Request body must send `think` for native-parser models - `ollama.ts` sends `ollamaThinkParam(effort, levels)` (a boolean, or a level string on level-capable models). Don't ship a hand-rolled TEMPLATE that omits the qwen3.5 RENDERER/PARSER directives or capability detection breaks (`thinking` won't be advertised) and reasoning silently disappears.
- **Max output cap.** Same `MAX_WORKER_OUTPUT_BYTES` ceiling (50 MB default). Output beyond cap aborts the stream with a truncation notice.
- **No retry / throttle.** Local daemon doesn't rate-limit; no quota tracking or system_notice retry path.

### Endpoint auto-discovery

Instead of hand-typing a base URL for an Ollama daemon on a private network, the CONFIG tab's **DISCOVER ENDPOINTS** button probes for reachable OpenAI-compatible / Ollama model-list endpoints and surfaces them as one-click suggestions that fill `settings.ollama.baseUrl`. The prober lives in `server/src/providers/endpointDiscovery.ts` (`discoverEndpoints()`); the route is `GET /api/endpoints/discover` (`server/src/http/endpointDiscoveryRoutes.ts`, returns `{ endpoints, tailscaleAvailable, cached }`).

What it probes - a **bounded** candidate set, deliberately **not** a port scanner:

- **Hosts:** discovered Tailscale peers and `localhost` only. LAN `/24` scanning is deferred because it would probe 254 hosts at each port. Peers come from `tailscale status --json` via `execFile('tailscale', ['status', '--json'])`, using an argv array rather than a shell. Offline peers (`Online:false`) are dropped.
- **Ports:** a fixed 12-port list - `11434` (Ollama) + `8000`-`8010` (OpenAI-compatible). There is no other port set.
- **Private ranges only (the SSRF-equivalent fence):** every candidate host must pass `isPrivateHost()` - loopback, tailnet CGNAT `100.64/10`, and RFC1918 (`10/8`, `172.16/12`, `192.168/16`). A **public IP is never probed** - a peer with a routable IP is rejected before it becomes a target.
- **Probe:** each `{host,port}` races `GET /api/tags` (Ollama, `{models:[{name}]}`) then `/v1/models` (OpenAI, `{data:[{id}]}`) against a ~700 ms per-probe timeout, with ≤ 8 probes in flight and an ~8 s overall deadline. A 200 with a parseable model list is a hit (recorded with `api`, `modelCount`, sample names); anything else is "not discovered". A closed port fails fast (connection refused) and a stall is bounded by the timeout.

Fences (four-question test - operator-initiated, deterministic fixed rules, visible result, reversible suggestion):

- **Operator-triggered, not a daemon.** Discovery runs only when the operator clicks the button (the route call). There is **no `setInterval`** continuously probing the tailnet.
- **Suggestions only - never auto-switches.** A discovered endpoint just fills the base-URL draft; the operator still Saves. The route never mutates settings.
- **60s result cache + per-host dead-host cooldown.** Repeat calls inside 60 s return the cached result (`cached:true`); a host where no port answered enters a 60 s cooldown so it isn't re-probed every click.
- **`tailscale`-absent is graceful.** ENOENT / any CLI error ⇒ `tailscaleAvailable:false`, peers skipped, `localhost` still probed. Never crashes; cross-platform safe.

### RAG injection discipline

`server/src/providers/ragInjection.ts` holds **pure, retriever-agnostic** injection primitives ported from open-webui's RAG layer. It is **discipline-only**: a survey at ship time confirmed Arco has **no scored retrieval-injection path today** - recall is backward-looking FTS5 archive search (never injected), `buildKnowledgeBlock` is an unranked pinned-facts dump, and codebase-memory is an external MCP tool. So nothing currently feeds these primitives a ranked candidate list.

When a retriever lands, it calls `fuseRRF` (`Σ 1/(k+rank)`, `RRF_DEFAULT_K`=60 - for hybrid BM25+vector) → `selectTopK` (`RAG_DEFAULT_TOP_K`=3 + relevance floor + dedup) → `tagSources`/`formatSources` (`<source id=N from=...>`) + `ragSystemTemplate` (the `RAG_CITATION_TEMPLATE` - cite `[N]`, don't invent) → `buildRagBlock` (8 KB `RAG_DEFAULT_BLOCK_BUDGET` cap + an omitted-count notice, never silent truncation). The wiring site is the `turnEngine.ts` knowledge-injection point (≈ the `buildKnowledgeBlock` fold). **Don't mistake `buildKnowledgeBlock` for a ranked retriever** - it isn't, and these primitives aren't wired to it yet.

---

## LM Studio

Standard cluster members using LM Studio, Strata or DeepSeek receive the same shared plan, assigned role and coordination instructions as the other local HTTP providers, once each. Blind members keep the existing restricted context and do not receive the shared plan.

`server/src/providers/lmstudio.ts`. Pure HTTP, no subprocess - a standalone module that talks LM Studio's **OpenAI-compatible** REST API .

**Standing verdict: OpenAI-compat endpoint, NOT the SDK.** LM Studio is a *runtime* (an Ollama competitor), not a frontend; its app/engine are closed-source and only the client SDKs are public. It exposes an OpenAI-compatible API on `http://localhost:1234/v1` (`/chat/completions`, `/models`, `/embeddings`). Adding it as a configurable OpenAI-compat endpoint reuses Arco's existing HTTP plumbing for near-zero cost - adopting the native `lmstudio.js` `ws://` SDK would add a dependency tracking LM Studio's app version for features Arco already owns (its own tool-loop). It is **not** modeled on llama.cpp's lifecycle-coupled worker either; it's its own module.

### Spawn

One streaming `POST ${baseUrl}/chat/completions` per turn (SSE `data:` lines, `[DONE]` terminator). No subprocess. The module **reuses the shared Ollama runtime** - `ThinkSplitter`, `parseRenderedTranscript`, the `ollamaTools` tool runtime, and `deterministicSummary` - so the tool-loop, think-handling, and transcript reconstruction behave the same as Ollama.

### Base-URL cascade

`getLmstudioBase()` resolves `settings.lmstudio.baseUrl`, then `LMSTUDIO_URL_BASE`, then defaults to `http://localhost:1234/v1`. The configured value supports DD12 config-value interpolation (`!cmd ...` and `${ENV}`) through `resolveConfigValue` before `normalizeBase`. A bare `host:port` gets `/v1` appended; for example, `http://localhost:1234` works.

### Capability detection

`probeLmstudio()` hits `/v1/models` to populate the CONFIG-tab model dropdown (this also fixed a latent empty-dropdown gap on the llama.cpp path). **The OpenAI `/v1/models` surface omits vision/tool/ctx capability metadata** - a thin optional `lms`-CLI probe could enrich those flags later; that enrichment is **stubbed today** (documented follow-up).

### Registration

`lmstudio` is a first-class provider registered across the full stack: providers/models/settings types, dispatch, auth, `turnEngine`, and all client pickers + the SettingsPanel endpoint editor. It surfaces in `GET /api/auth-status` (`apiProvider: "lmstudio:<base>"`, `subscriptionType: "local"`, `installedModels` from the probe).

### Not a cluster member

LM Studio is **not** wired as a cluster member, unlike Ollama and llama.cpp (which run peer tools in-process, capped per cluster by the local runtime capacity setting in Connections, default one member). Cluster peer tools are not registered for it. It is supported in Chat (including Incognito).

---

## Strata

Operator setup, memory tiers, assets, provenance and recovery: [STRATA.md](STRATA.md).

`server/src/providers/strata.ts`. Standalone inference service, separate from
Ollama, LM Studio and Arco's managed llama.cpp daemon. The selectable **STRATA**
provider defaults to `http://127.0.0.1:8081/v1`; configure
`settings.strata.baseUrl` (Settings → STRATA ENDPOINT) or `STRATA_URL_BASE`.
Existing provider endpoints/defaults are preserved. Strata user services own the memory limits; Arco never resizes them.
The operator can unload its model with the header FREE VRAM button; the next
request reloads it through Strata.

**Discovery/auth.** `GET /models` supplies model IDs, `meta.n_ctx` (the configured
context), and `architecture.input_modalities` (vision only when `image` is
advertised). `GET /api/auth-status` adds `strata` with `apiProvider: strata:<base>`,
`subscriptionType: local`, installed models and capabilities. No login/API key is
required for the standalone service.

**Prepared profiles.** An optional operator registry at
`~/.arco/strata-profiles.json` (`ARCO_STRATA_PROFILES` overrides the path)
adds installed profiles even while the engine is unloaded/stopped. It contains
`baseUrl`, `launcher: { python, script }` (absolute paths), and `profiles` entries
with `id`, `model`, `label`, `unit`, `config`. Only an exactly matching loopback
HTTP endpoint is managed. Each configuration must match its model ID and have
readable engine, tokenizer, pack, native/Ple GGUF and image-encoder files.
Inactive context/vision come from those prepared configs; live `/models`
capabilities take precedence. Auth status carries `installedModelLabels` without
changing the exact IDs sent to inference.

Selection takes effect on the next message and retains the conversation. A
serial Strata turn slot (mandatory even with `ARCO_LOCAL_PROVIDER_SERIAL_QUEUE=0`)
covers loading and the entire tool loop. Before a different profile starts,
Arco refuses active other local providers or external Strata requests,
verifies the endpoint belongs to a registered active service, and runs the
launcher's read-only `check-switch <id>` (GPU-workload/Ollama guards). It then stops
only the old registered unit, starts the selected unit, and verifies its live
model ID/loaded state. The target service repeats its full RAM/VRAM/startup
preflight. FREE VRAM and new local turns are blocked during the switch.
Failures/cancellation restore the old profile (including its unloaded state)
before releasing the switch guard; notices are persisted in the transcript.
Unregistered/remote connections retain HTTP-only operation.

The registry exposes only profiles installed for the configured service.
Profile names, model IDs, context windows and vision support vary by
installation. One profile is resident at a time; alternating tabs reloads their
selected weights. Other providers remain available. The registry is local
configuration and stays outside Git.

**Transport.** Reuses `OpenAIHttpWorkerProcess` in `lmstudio.ts`: streaming SSE,
fragmented indexed tool calls, usage, image data URLs, transcript replay and a
bounded server-side tool loop. `reasoning_content` streams to thinking and is
preserved inside tool-call round trips. Strata exposes `none`, `low`, `medium`, and `high` directly; `none`
disables reasoning and Strata maps `high` to Qwen xhigh. Legacy higher effort
values normalize to `high`. Final usage carries the discovered context and last prompt tokens.
One serial Strata slot avoids concurrent Arco requests to the single-request
engine. Cancel aborts HTTP and settles the worker; Strata remains running.
The shared loop's `ARCO_LMSTUDIO_*` turn/stall bounds apply to both HTTP
connections. Strata retains the shared runtime result (Read: 32K; other tools:
64K), matching Ollama. It skips LM Studio's extra compacting pass (6K
head/tail or 200 Read lines), so middle lines and fetched evidence survive
within those runtime caps. LM Studio keeps its existing compacting policy.

**Speed/version/lifecycle.** Native SSE `timings` supplies decode and fresh-prefill
tokens and milliseconds, summed across tool rounds. `primary_complete.genSpeed`
drives the Agent and Chat composer readout after each turn, excluding tool time.
PROVIDERS displays the installed engine from `/v1/status` and compares GitHub
releases at boot and every four hours; newer releases turn yellow and link to
upstream release notes. FREE VRAM uses `/v1/unload` only on loopback, refuses
active local turns and reviewers, and blocks new local turns during unloading.
It also unloads local Ollama, managed llama.cpp and LM Studio LLMs, including
providers hidden in the picker. No model files or configured limits change.

**Tools/privacy.** Agent uses the existing local tool registry (including
SearXNG-backed `WebSearch` and `WebFetch`) and honors AUTO/SAFE plus primitive
allowlists. Saved Chat uses `chatWebArmed()`; armed Chat exposes and executes
exactly the web pair, and repeats the allowlist check at dispatch. Offline Chat
omits tools. No project tools, skills, shell or MCP in Chat. No Incognito:
Strata's independent request logs and encoded-image cache cannot meet the strict
boundary. Strata is not a cluster member.

**Vision depends on the configured profile.** A profile may enable an image
encoder and set its device, thread count, and token cap. Resource limits and
encoder settings belong to the Strata service; Arco does not resize them. After
a profile change, restart Strata and check its live capabilities. Arco does not
infer vision from a model name.

**Validation.** `npm run test:strata-provider` exercises discovery, SSE chunks,
reasoning, image payloads, web tool round trips and hallucinated project-tool
rejection. `test:strata-profiles` checks refusal/rollback/cancellation and prepared configs;
`smoke:strata-profiles` uses isolated fake services to verify discovery, serial
turns, same-tab switching and conversation retention. `smoke:strata-controls` boots an isolated source server with a fake
runtime and exercises capabilities, None effort, speed WS events and the HTTP
unload busy/idle paths. `test:local-model-unload` covers runtime protocols and
local-turn guards; `test:strata-ui` checks rates and effort choices. Existing
`smoke:lmstudio-provider` remains green. Opt-in
`smoke:strata-live` drives actual Chat WebSearch/WebFetch, an attached image
question, reasoning, context accounting, and Agent WebSearch over WebSocket (requires a Strata service,
SearXNG, `STRATA_SMOKE_IMAGE`, and a throwaway Arco with auth off). Live tests
must isolate `os.homedir()` too: a second server sharing the production PID
registry would reap the first server's workers.

---

## DeepSeek (Xolotl)

`server/src/providers/deepseek.ts` reuses `OpenAIHttpWorkerProcess` with its own
identity, endpoint and prepared profile manager. See [DEEPSEEK.md](DEEPSEEK.md)
for installation-specific assets, memory limits, registration and recovery.

**Transport/replay.** Streaming Chat Completions at loopback port 8150. Arco
rebuilds conversation history and owns the normal bounded tool loop; saved Chat
gets only its armed web pair. Strict Incognito, clusters and Computer selection
are not enabled. Prepared vision configs forward native OpenAI image parts;
text-only configs reject images before loading. Live modality readiness must
match the prepared profile. The native reasoning
channel and assistant reasoning for tool rounds are preserved; request effort
is none/low/medium/high, with an 8192 thinking budget and 16384 total output cap.
Context size comes from the configured service model and includes input, history,
thinking and output. The worker uses runtime timings and the final round's prompt
count for measured context and rates.

**Discovery/auth.** `settings.deepseek.baseUrl` → `DEEPSEEK_URL_BASE` →
`http://127.0.0.1:8150/v1`. A matching validated operator registry populates
`authStatus.deepseek` and both Exact/Light labels/capabilities while stopped;
`loggedIn` means prepared availability, not loaded residency. `/api/deepseek`
reports actual service/engine state. Xolotl's `--ctx`/Engram schema is separate
from Qwen's Strata registry.

**Lifecycle.** Whole turns are always serialized. The shared local-operation
guard excludes profile switches, FREE VRAM and new local turns. Only the
registered guarded launcher may start/stop `deepseek-flash@exact/light.service`;
Arco never spawns the engine or stops other GPU workloads. Before a switch, verify service
identity and external request inactivity; check those workloads before stopping the old
profile, then let guarded start run its full asset/mount/resource checks. Verify
the selected served identity, actual context and text-only state. Failure/cancel
cleans up the target and attempts guarded restoration of the previous loaded
profile. Idle-unloaded engines restart through this guard too. Explicit unload
stops the whole service cgroup and verifies inactive state plus endpoint loss.

**Version tracking.** `runtimeVersions.ts` reads registered Xolotl checkout HEAD
without loading an engine; `capabilities.xolotlRevision` is compared to upstream
HEAD through `latestVersions.xolotl`. Strata and Xolotl version rows open
in-app release/source-history views, with GitHub only as an explicit link.
Matching Xolotl revisions show up-to-date without requesting a self-comparison. Source drift is not semver ordering or a
binary build guarantee. Strata's installed version now falls back to local
`engine/BUILD.json` while its endpoint is stopped. Neither path auto-updates.

**Verification.** `test:deepseek`, `smoke:deepseek`, existing Strata/unload/Chat
regressions and help/doc checks run without real GPU services. Live model tests
require operator coordination and leave both profiles stopped afterward.

---

## llama.cpp

A managed server exit or process error clears ready state; the next request can load a replacement.

Endpoint overrides in `extraArgs`, including the suggested `--port 8081` fix, use one host and port for listener checks, health polling, loaded state and inference. The final `--host` or `--port` flag wins; malformed port overrides are refused before launch.

`server/src/providers/llamacpp.ts` (provider) + `server/src/providers/llamacppManager.ts` (lifecycle) + `server/src/llamacppCatalog.ts` (operator-declared model registry).

Supported in Chat (tools omitted) but rejected for Incognito: the shared daemon always writes `~/.arco/llamacpp.log`.

Why this provider exists alongside Ollama: vision-capable architectures often land in `llama.cpp` weeks before Ollama wires up the multimodal projector path. Qwen3.6 was the motivating case (Ollama issue 14730: `unknown model architecture: 'qwen35moe'` on the multimodal path). The text-only ergonomic edge of Ollama is unchanged; llama.cpp is the escape hatch when you need a feature Ollama hasn't shipped yet.

**Fit engine.** The fit engine sizes GGUF models against *detected* hardware - `server/src/hardware/fit.ts` estimates VRAM (weights + KV-cache + overhead), the max context that fits, throughput, and a fit verdict/score for a given `{params, quant, arch}` on the box's probed GPU(s)/VRAM. On Apple Silicon the engine derives the Metal GPU's bandwidth from the probed GPU-core count against published unified-memory figures and sizes against a unified-memory VRAM budget, so a Metal GPU now scores a real verdict instead of an automatic `NO`.

> **Operator health readout.** The System modal's **Models** tab (A3 - `docs/DIAGNOSTICS.md`  Local model health panel) surfaces, for llama.cpp: the `llama-server` binary path, registered loadouts, the lifecycle-manager snapshot (state / alias / port / pid), the **last launch args** (an additive `lastLaunchArgs` field on `LlamacppManagerStatus`, retained on the existing spawn path - read-only forensics, never read back by spawn/keepalive/reap) and a **last-stderr tail** of `~/.arco/llamacpp.log`. For model files it surfaces the detected hardware profile, downloaded GGUFs under `~/.arco/models`, and **fit-score mismatch warnings** - registered loadouts scored against the detected hardware with the same pure `scoreFit` used here (verdict `NO`/`TIGHT`). When a `llama-server` launch fails, `llamacppServeDiagnose.ts` classifies the failure against an ordered registry of known causes (binary-missing, port-in-use, OOM, ctx-too-large, ...) and returns a structured diagnosis - cause + human message + one-click fixes that lower `ctxSize` / `ngl` or add a `--port` / `extraArgs` escape hatch - surfaced in the same panel under `model-health.llamacpp-*` keys. It is read-only and **never spawns a model or changes lifecycle**.

Two non-obvious differences from Ollama:

1. **Operator-declared model registry, not auto-discovery.** llama-server is one model per process and needs explicit `-m` / `--mmproj` / `-c` / `-ngl` flags. The catalog at `~/.arco/llamacpp.json` names each loadout up front; the lifecycle manager spawns `llama-server` with the right flags on first use.
2. **Arco owns the daemon process.** Ollama runs as its own systemd / homebrew daemon; llama-server is spawned + babysat by Arco. Switching models is SIGTERM old → wait → spawn new. Idle eviction reclaims VRAM after `ARCO_LLAMACPP_KEEPALIVE_MS` (default 10 minutes).

Catalog edits and deletions use the version that was reviewed. Duplicate aliases are refused, including renames. If another change wins first, reload the registry and review the pending edit again. A diagnosis fix follows the same rule and does not reload a model when its catalog save conflicts.

### Spawn

`POST /v1/chat/completions` with `stream: true`. OpenAI SSE format (not Ollama NDJSON). Workers always go through `llamacppManager.ensureLoaded(alias)` first, which blocks 20-30s on the cold-start of a 17GB GGUF and is a no-op once loaded.

### Lifecycle manager

Singleton in `llamacppManager.ts`:

- `ensureLoaded(alias)` - start / switch as needed. Concurrent callers requesting the same alias share one spawn (de-duped via `loadingPromise`). Different-alias-during-load waits for the in-flight load to finish before triggering the switch.
- `unload()` - operator-facing eviction (POST `/api/llamacpp-unload`). Frees VRAM without waiting for the idle timer.
- `shutdown()` - wired into the SIGTERM/SIGINT handler in `server/src/index.ts` so spawned llama-server processes don't outlive Arco.
- Idle timer - re-checks `lastUsedAt` at fire time and re-arms if the deadline moved (concurrent ensureLoaded calls bump it).
- **Stale orphan reaping** - before each load/unload cycle the manager walks `pgrep -af llama-server` for descendants of dead Arco PIDs and `kill -9`s them. Crash-recovery aside (orphan reaping at boot handles that), this catches the case where a previous `llama-server` survived a partial server-restart with its IPC channel detached; without the reap the next `ensureLoaded` would race two listeners against the same port.
- **Version cache busted on binary mtime change.** `--version` parsing is cheap but not free; the manager caches the parsed version keyed on the binary's mtime. Replacing `/usr/local/bin/llama-server` (package upgrade, manual rebuild, etc.) bumps the mtime and the next call re-probes - no need to restart Arco to pick up a fresh build.

`llama-server` stdout/stderr piped to `~/.arco/llamacpp.log` for debugging hung loads.

### Model registry

`~/.arco/llamacpp.json`. Bootstrapped on first server start with a stub:

```json
{
  "$example": {
    "alias": "qwen3.6-vl",
    "ggufPath": "/path/to/Qwen3.6-27B-UD-Q4_K_XL.gguf",
    "mmprojPath": "/path/to/mmproj-BF16.gguf",
    "ctxSize": 32768,
    "ngl": 999,
    "capabilities": { "tools": true, "vision": true, "thinking": true }
  },
  "models": []
}
```

| Field | Purpose |
|---|---|
| `alias` | Operator-chosen identifier. Shows in the model picker, used as the `model` field in the chat-completion request, displayed on the worker badge. |
| `ggufPath` | Absolute path to the GGUF. Must be readable by the Arco server process. |
| `mmprojPath` | Absolute path to the vision projector GGUF. Required for vision; declaring `capabilities.vision: true` without an mmproj silently drops images and emits a system_notice. |
| `ctxSize` | `-c` flag. Picks `llama-server`'s built-in default if unset (often 4096 - usually too small for modern models, set this explicitly). |
| `ngl` | `-ngl` flag. `999` = offload everything to GPU. Drop to a positive integer if you need to keep some layers on CPU for VRAM headroom. |
| `chatTemplate` | Override for the embedded GGUF chat template. Rare - only set when the embedded one is wrong. |
| `extraArgs` | Escape-hatch for raw `llama-server` flags (`--rope-freq-base`, `--top-k`, etc.). |
| `capabilities` | Operator-declared `{tools, vision, thinking}`. Mirrored to AuthStatus so the model picker badges match Ollama's. |

The first entry is the default model.

### Vision

OpenAI multimodal shape - `content` becomes an array:

```json
{
  "role": "user",
  "content": [
    {"type": "text", "text": "what's in this screenshot?"},
    {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
  ]
}
```

Same 5 MB cap and `.png/.jpg/.jpeg/.gif/.webp` allowlist as the Ollama path.

### Tool runtime

Reused from `ollamaTools.ts` - the local-tool runtime (Bash/Read/Write/etc.) is provider-agnostic, and every local provider decides each call through `decideLocalToolCall` in `localToolDispatch.ts` with its own rules. AUTO mode executes; SAFE mode returns a denial string the model treats as the tool result so the loop converges without an operator-approval ping-pong. `isKnownOllamaTool()` is a strict allowlist gate; tools the model invents are rejected.

OpenAI fragment-assembly: tool calls arrive across multiple SSE events, partial by `index`. Reassembled in `partialToolCalls` map, emitted as a single `ToolCall[]` once `finish_reason === 'tool_calls'`.

**XML tool-call fallback.** Some Qwen builds emit `<tool_call>{...}</tool_call>` XML markup in `reasoning_content` instead of structured `delta.tool_calls[]`. The provider sniffs for this fallback and parses the XML payload as a synthetic tool call so the loop still progresses. Without this fallback the model would emit a tool-shaped reasoning block and then hang waiting on a tool result that never comes.

**Thinking coalescing.** `reasoning_content` deltas can fire many times per second; we coalesce them on a `~ARCO_LLAMACPP_THINKING_FLUSH_MS` interval before emitting `primary_thinking_chunk` events to avoid saturating the WebSocket send buffer.

**Reviewer-mode tool allowlist.** When `runReviewer.ts` dispatches a llama.cpp reviewer, it injects `READ_ONLY_LLAMACPP_TOOLS` (Read, Grep, Glob, WebSearch, WebFetch - same shape as Ollama's READ_ONLY_OLLAMA_TOOLS) instead of the full primary-mode set. Plus a `LOCAL_REVIEWER_ADDENDUM` framing addendum explicitly tells the reviewer to use those tools to verify diff claims against the live tree, not just opine on the diff text. See [Primitives: Review  Local-reviewer addendum](PRIMITIVES.md#local-reviewer-addendum).

### Auth

`probeLlamacpp()`: `llama-server` found on `PATH` (`llama-server.exe` on Windows; override via `ARCO_LLAMACPP_BIN`) AND `~/.arco/llamacpp.json` parses cleanly. No login flow - local + auth-less like Ollama.

### Capability detection

Operator-declared in the catalog; no `--show`-equivalent on llama-server. Setting `capabilities.vision: true` without an `mmprojPath` is allowed (the validator doesn't reject it) but the provider drops images and emits a system_notice - guard at the UI layer where useful.

### Quirks

- **Cold-start latency.** First turn after a switch is 20-30s for a 17GB GGUF (mmap + VRAM transfer). UI shows nothing useful during this window today; status is queryable via `GET /api/llamacpp-live`.
- **One model at a time.** Switching aliases mid-workflow forces a kill + reload. Operators who want concurrent models should run multiple Arco-external `llama-server` instances; this manager owns exactly one.
- **`--jinja` always on.** Required for OpenAI-style tool calling. Cheap on non-tool turns; mandatory on tool turns. Not configurable.
- **Effort mapping.** `low` prepends `/no_think` to the system prompt (same Qwen-family convention as Ollama). Other efforts leave native thinking on. The two-value picker (`low` / `high`) matches Ollama's.
- **CPU fallback.** If Vulkan / CUDA isn't available at runtime, `llama-server` falls back to CPU silently. Inference will be unusably slow; check `~/.arco/llamacpp.log` if a model loads but each turn takes minutes.
- **Vision projector compatibility.** mmproj files are model-specific. The Qwen3.6 mmproj won't work with Qwen3-VL or any other model. Pull the projector from the same HuggingFace repo as the GGUF.
- **No retry / throttle.** Same as Ollama - local backend, no quota tracking.
- **Mid-turn steer.** Same hook shape as the Ollama path. `LlamacppWorkerProcess.run` calls `WorkerConfig.drainSteer` after `messages.push(...toolResults); toolTurn++;` and *before* the recovery checks (tool-loop coach termination, tool-cap auto-continue). Drains the whole steering bucket each fire; follow-up bucket is left alone. Recovery arms above the hook (reasoning runaway / stall / wall_clock / empty completion) `continue` from their own arms and never reach the hook within their iteration - by design; they are conversation-repair flows that own their own injected user message. Tool-cap auto-continue sits below the hook and runs on the same iteration if both fire, so the steer + recap both reach the next call. The drain is destructive (splice), so a same-iteration re-call returns `[]` - no double-deliver under any retry path.

### Auto-recovery

Local thinking models fail in three specific ways that the lifecycle alone can't handle: reasoning runaway (model emits `reasoning_content` for minutes without ever committing), tool-cap exhaustion (50-turn cap fires on legitimately long work), and context fill (96K cap is small compared to Claude). The provider runs an in-place auto-recovery system that keeps the conversation going without operator intervention.

Distinct from the heavyweight Handoff primitive (which spawns a fresh workflow with a chosen summarizer model - tuned for Claude/Codex flows). Auto-recovery operates inside the same worker on the same workflow, just intelligently resetting the in-memory message stack when something goes sideways.

Four detection paths, all gated by `ARCO_LLAMACPP_AUTO_RECOVER` (default on):

| Trigger | Detection | Recovery |
|---|---|---|
| Reasoning runaway | `reasoning_content` exceeds `ARCO_LLAMACPP_REASONING_BUDGET` tokens (default 8000) with no `content` or `tool_calls` arrived | Abort stream, inject a fake assistant + user pair telling the model to commit to action. Continue. |
| Stream stall | No SSE event for `ARCO_LLAMACPP_STALL_TIMEOUT_MS` (default 90s) | Abort stream, build deterministic summary of progress so far, inject as user message, continue. |
| Tool-cap hit | `MAX_TOOL_TURNS` (default 50) exhausted without final answer | Build deterministic recap of tool calls + files, inject as user message asking to continue or wrap up, reset counter. |
| Context fill | `lastInputTokens / ctxSize >= ARCO_LLAMACPP_COMPACT_THRESHOLD` (default 0.85), checked at clean turn boundaries only | Warn-only `system_notice` suggesting Handoff. The old in-turn compaction was removed 2026-09-25: it replaced a local message array (the next turn rebuilt the full transcript and overflowed again), streamed its summary into the persisted answer, and paid a generation every over-threshold turn. |

The three recovering paths share one budget (the context-fill row only warns and no longer spends it): `ARCO_LLAMACPP_MAX_RECOVERIES` (default 2 per operator turn). Once exhausted, the provider falls through to the normal failure path. Each recovery emits a `system_notice` so the operator sees what happened without having to dig through logs.

The deterministic-summary path (used by stall + tool-cap recovery) walks the message stack and extracts: tools used + counts, files read, files written, last 10 Bash commands, last 3 substantial assistant text snippets. No LLM call required - works even when the model is unresponsive.

The compaction path (context fill) does require a model call. The model summarizes its own work with a structured prompt anchored on the operator's original ask. The summary becomes the new conversation seed; the original tool history is dropped.

### Environment overrides

| Var | Default | Purpose |
|---|---|---|
| `ARCO_LLAMACPP_BIN` | `/usr/local/bin/llama-server` | Binary path (for other installs) |
| `ARCO_LLAMACPP_PORT` | `8923` | Port the manager spawns llama-server on |
| `ARCO_LLAMACPP_HOST` | `127.0.0.1` | Bind host |
| `ARCO_LLAMACPP_KEEPALIVE_MS` | `600000` (10 min) | Idle eviction window. `0` = never evict. |
| `ARCO_LLAMACPP_MAX_TOOL_TURNS` | `50` | Tool-loop iterations per operator turn before recovery (or failure if recovery exhausted) |
| `ARCO_LLAMACPP_AUTO_RECOVER` | `true` | Master kill-switch for auto-recovery system |
| `ARCO_LLAMACPP_REASONING_BUDGET` | `8000` | Reasoning tokens before runaway intervention |
| `ARCO_LLAMACPP_COMPACT_THRESHOLD` | `0.85` | Context fill fraction that raises the suggest-Handoff notice |
| `ARCO_LLAMACPP_MAX_RECOVERIES` | `2` | Total auto-recovery actions per operator turn |
| `ARCO_LLAMACPP_STALL_TIMEOUT_MS` | `90000` | SSE event timeout before stall-recovery fires |
| `ARCO_LOOP_COACH_THRESHOLD` | `2` | Identical (tool, args) calls before loop coach fires (shared with Ollama) |

---

## External MCP integrations

External MCP servers that Arco surfaces as operator-attachable per-tab options. CONFIG > MCP SERVERS is available on Claude Native and CLI, Codex exec and app-server, Cursor Agent, Ollama, llama.cpp, LM Studio, Strata and DeepSeek Agent tabs. The registry list is shared across tabs; enablement and tool choices belong to each tab. Standard and BLIND cluster members have the same controls. Chat tabs and isolated members do not receive configured servers and do not show this section. Unlike the in-process per-cluster MCP server (Cluster + scope), these are operator-installed binaries running on the same machine. Arco's job is the UX (toggle, status, re-index button) + persistence of intent + spawn-time wiring to inject the server entry into the worker's `--mcp-config`.

Each entry below follows the same shape: install path → operator surface → fences → persistence shape.

### `codebase-memory-mcp` (`DeusData/codebase-memory-mcp`)

Tree-sitter → SQLite knowledge graph (Cypher-ish queries + BM25 + vector). 14 MCP tools including `search_graph`, `detect_changes` (git-diff blast radius), and `manage_adr`. **Deterministic, no LLM in the server itself** - the binary's value is structural code understanding, not curated memory. The only LLM-write surface in the entire package is `manage_adr`, and it is operator-prompted only (the model writes an ADR when the operator types "make an ADR for this") - passing the no-LLM-curated-memory test.

**Install path.** Single static binary. Operator-installed once per machine; see `docs/OPERATIONS.md`. **Hard invariant**: Arco ALWAYS invokes the binary with `--skip-config` because the binary's default install/run behavior auto-edits agent config files (`~/.claude/settings.json` and similar). The flag is wired into the one-shot reindex spawn at `server/src/index.ts` and must persist into the deferred F9 spawn-site wiring.

**Operator surface.**
- **CONFIG tab → `INDEXES & MEMORY` section** (`client/src/components/RightPanel/CodebaseMemorySection.tsx`). Per-tab "Attach codebase memory" checkbox, operator-typed index-path field (defaults to the workflow's cwd), status line, "Re-index now" button.
- **FILES tab → `BLAST RADIUS` sub-tab** (`client/src/components/RightPanel/BlastRadiusTab.tsx`). Shown only when memory is attached. Renders `detect_changes` output for the current `git diff` against the index (full rendering ships with the F9 follow-up - placeholder today).

**Wire shape.** Three WS messages - `attach_codebase_memory { workflowId, indexPath? }` / `detach_codebase_memory { workflowId }` (client→server), and `codebase_memory_state { workflowId, attached, indexPath?, lastIndexedAt?, fileCount? }` (server→client, fires on attach / detach / reindex). One HTTP route: `POST /api/workflows/:wfId/codebase-memory/reindex { indexPath? }` → 200 with `{ lastIndexedAt, fileCount? }` on success, 503 `binary_not_installed` when the binary isn't on PATH.

**Persistence.** `WorkflowConfig.codebaseMemory` + `WorkflowMeta.codebaseMemory` (same shape) carry the operator's intent across server restart. Detach retains `indexPath` so re-attaching is one click.

**Spawn-site wiring (deferred - F9).** The actual `--mcp-config` write-in at CLI spawn time piggybacks on Cluster Arco's `mcpConfigWriter`. 's attach toggle records intent only; the worker never invokes the MCP today. This spawn-site wiring remains deferred.

**Hard fences (autonomy four-question test).** (1) Operator-initiated - every action is a click. (2) Deterministic - tree-sitter + BM25 + SQL queries; no LLM in the loop on Arco's side. (3) Visible in `events.jsonl` - `codebase_memory_state` rides `broadcastWorkflow` which seq-stamps + persists. (4) Reversible - detach toggle is one click; the on-disk index is operator-managed.

### Adding a new external MCP

Future entries (e.g. operator-installed Linear / Jira MCPs) should follow the same shape: per-tab toggle on the CONFIG tab, intent persisted to `WorkflowConfig`/`WorkflowMeta`, a single workflow-scoped `<name>_state` push, optional HTTP one-shot endpoint for operator-initiated actions, spawn-site wiring through whatever `mcpConfigWriter` exists at the time. The brief lives here; the implementation lives in its own slice.

---

## Comparison matrix

| | Claude (CLI) | Claude (Native) | Codex (exec) | Codex (appserver) | Ollama | llama.cpp | LM Studio |
|---|---|---|---|---|---|---|---|
| Spawn | subprocess per turn | in-process SDK (long-lived) | subprocess per turn | subprocess long-lived (one per tab) | HTTP | HTTP (Arco-managed daemon) | HTTP (OpenAI-compat `/v1`) |
| Stream format | NDJSON | SSE (Anthropic Messages) | NDJSON (`--json`) | NDJSON over stdio (no `jsonrpc:"2.0"` envelope) | NDJSON | OpenAI SSE | OpenAI SSE |
| Session resume | UUID `--resume` | replay-from-`events.jsonl` (Arco-internal; no rollout file; append-only prefix + preserved thinking) | thread_id `exec resume` | `thread/resume` JSON-RPC | none | none | none |
| Native session file | `~/.claude/projects/.../X.jsonl` | - | `~/.codex/sessions/.../rollout-X.jsonl` | `~/.codex/sessions/.../rollout-X.jsonl` | - | - | - |
| Tool use | yes (rich) | yes (in-process Bash/Read/Edit/Grep/Glob/KillShell/TodoWrite/Task/AskUserQuestion/EnterPlanMode) | yes | yes | yes (server-side allowlist) | yes (server-side allowlist) | yes (shared Ollama server-side runtime) |
| Reasoning blocks | yes | yes (interleaved when model supports) | yes | yes | yes (`message.thinking` native + `<think>` fallback) | yes (OpenAI `reasoning_content`) | yes (OpenAI `reasoning_content` + `<think>` fallback) |
| Effort levels | up to 5 | up to 5 | model/catalog-driven; Astra: low through ultra | model/catalog-driven; Astra: low through ultra | per model (low=off + `thinking.values` levels; else low / high) | 2 (low / high) | 2 (low / high) |
| Auth | subscription / API key | OAuth subscription (`~/.arco/auth.json`) | subscription / API key | subscription / API key | none | none | none |
| Throttle detection | yes (regex + Retry-After) | yes (structured Anthropic error envelope) | yes (30 min cooldown) | yes (`error.codexErrorInfo`) | n/a | n/a | n/a |
| Retry on transient errors | yes (15/30/60s) | yes (header-aware `retry-after`, 15/30/60s fallback) | no | no | no | no | no |
| Mid-turn cancel | yes (SIGKILL) | yes (loop-abort, in-process) | yes (SIGKILL) | yes (`turn/interrupt` + 5s ack; SIGKILL fallback) | yes (abort fetch) | yes (abort fetch) | yes (abort fetch) |
| Mid-turn steer | post-turn drain | drain hook between tool-result append + next API call | post-turn drain | `turn/steer` RPC (precondition: `expectedTurnId`) | yes (between tool-loop iterations) | yes (between tool-loop iterations) | yes (between tool-loop iterations) |
| Concurrent-writer guard | yes | n/a (Arco-internal session) | no | no | n/a | n/a | n/a |
| Auto-handoff support (after N compactions) | yes (CLI `compact_boundary`) | yes (`native_compacted`; needs auto-compaction) | no (exec reports no compactions) | yes (`contextCompaction` / `thread/compacted`) | yes (durable compaction; needs auto-compaction) | no - in-place auto-recovery instead (context fill / stall / tool-cap / reasoning runaway) | no |
| Server-side context-mgmt | n/a | operator-armed (`compact` OFF by default - CONFIG ADVANCED Claude API compaction (beta) toggle, gated on catalog support; `clear_thinking` / `clear_tool_uses` intentionally off) | n/a | n/a | n/a | n/a | n/a |
| Cluster peer tools | per-spawn stdio MCP child via `--mcp-config` | registered in-process | per-turn stdio MCP child via `-c mcp_servers.*` TOML overrides | per-appserver-process stdio MCP child via `-c mcp_servers.*` TOML overrides | in-process tool registry (`localClusterCapacity`, default 1) | in-process tool registry (`localClusterCapacity`, default 1) | no |
| Chat tabs | yes (+ web) | yes (+ web) | yes (+ web) | yes (+ web) | yes (+ web) | yes (not Incognito) | yes |
| Single-consumer | no | no | no | no | no | one model at a time per Arco (manager-owned) | no |
| Best at | long sessions, terminal interop, reviewers, handoff destinations | low-latency tool-loop work, server-side context mgmt, plan-mode + sandbox tools, Task fan-out | second-opinion review, primary work | primary work with mid-turn steer + structured cancel | local single-shot, sub-tasks | local multimodal, architectures Ollama hasn't shipped yet | local models via the LM Studio runtime (OpenAI-compat) |

**Cursor** (one of the eight primary providers) is likewise not a matrix column: a long-lived per-workflow ACP worker (`server/src/providers/cursor/`) driving `cursor-agent acp` - subprocess long-lived, JSON-RPC/ACP stream, `session/load` resume, `session/set_model` live swap, `session/cancel` + 5s hard-kill, post-turn steer drain, no per-turn tokens on the wire (Usage tab is authoritative). It IS a cluster member (`cursor` ∈ `ClusterMemberProvider`) - **cluster peer tools: in-process loopback StreamableHTTP MCP server** (Cursor ACP honors http/sse only, not stdio; fresh-only membership). See the [Cursor](#cursor) section above.

---

## Error-classifier taxonomy

`server/src/providers/errorClassifier.ts` maps a provider error to a
`FailoverReason` and a `FailoverAction`. It complements `quota.ts`: quota
tracks provider *availability*, the classifier decides the *action* the
retry/fallback layer should take. Pure and side-effect-free  -
`classifyError(provider, err)` matches on both numeric status codes
(401/402/403/404/413/422/429/5xx) and case-insensitive substrings against the
flattened error message/type/code. It handles raw strings, `Error` objects, and
nested `{ status, error: { type, message } }` / Codex `codexErrorInfo` shapes.

> **Scope:** C1 ships the classifier module + its smoke only. The first consumer
> that wires `action` into control flow is **C2 - provider fallback chains**
> (below). C1/C2 do **not** rewire the live single-provider error path: the
> existing `markThrottled` parsing in `claude.ts` / `codex.ts` and
> the live primary turn are untouched, and a live primary turn never falls back.

`classifyError(provider: ProviderName, err: unknown) → { reason, action, permanent }`.
`permanent` is true when retrying the *same* request against the *same* provider
can never succeed (C2 fails closed fast rather than burning the backoff ladder).

| Reason | Action | Permanent | Trigger examples | Providers |
|---|---|---|---|---|
| `auth` | `rotate` | no | 401, `Unauthorized`, `token expired` / `reauthenticate` | all |
| `auth_permanent` | `fail` | yes | `invalid_api_key`, `authentication_error`, `revoked`, 403 `permission_error` | Claude, Codex |
| `billing` | `rotate` | yes | 402, `insufficient_quota`, `credit balance too low`, `past_due` | Claude, Codex |
| `rate_limit` | `backoff_then_rotate` | no | 429, `rate_limit_error`, `usage limit reached`, `too many requests` | Claude, Codex |
| `overloaded` | `backoff` | no | `overloaded_error`, 503/529, `service unavailable`, `capacity` | Claude |
| `context_overflow` | `compress` | no | `prompt is too long`, `context_length_exceeded`, 413, `request too large` | Claude, Codex |
| `model_not_found` | `fallback` | no | `model_not_found`, `does not exist`, `has been deprecated`, 404 on a model route | Claude, Codex |
| `content_policy_blocked` | `no_retry` | yes | `content policy`, `safety` / `responsible ai` filter, `output_blocked` | Claude |
| `oauth_long_context_beta_forbidden` | `fail` | yes | Anthropic `oauth_long_context_beta` beta forbidden for an OAuth/subscription account | Claude (Native) |
| `invalid_request` | `no_retry` | yes | 400/422, malformed request not otherwise classified | all |
| `server_error` | `backoff` | no | generic 5xx | all |
| `network` | `backoff` | no | `ECONNRESET`, `ETIMEDOUT`, `fetch failed`, `socket hang up` | all |
| `unknown` | `backoff` | no | anything unmatched (conservative - a transient blip gets a retry, not a fatal verdict) | all |

Smoke: `npm run smoke:error-classify` (pure unit - no WS, no server boot).

---

## Provider fallback chains

HTTP provider error envelopes retain their status when passed through text results. A 429 can advance to the next configured bounded-job provider; a 413 stays on context recovery, and transient server errors retain their retry classification. Ordinary prose containing an HTTP example does not supply a status.

`server/src/providers/fallbackChain.ts` runs a **bounded job** (a reviewer or a
research leg - never a live operator conversation) across an ordered list of
provider "legs". It spawns leg 0; if that leg fails with a classified error
whose `action` says "this provider can't serve us, move on", it advances to the
next leg. The first leg that succeeds wins; if every leg is exhausted, the
**last** leg's error result is returned verbatim so the caller's existing
error-surfacing path fires unchanged.

This is a **higher-level construct than** `WorkerManager`'s per-spawn
`fallbackModel` (a same-provider model swap inside one spawn). The chain is a
sequence of full `spawn()` calls across different `{provider, model}` legs; the
two compose (each leg may carry its own `fallbackModel`).

**Which `FailoverAction`s advance the chain** (single source of truth:
`ADVANCING_ACTIONS` in `fallbackChain.ts`):

| Action | Advance? | Why |
|---|---|---|
| `fallback` | **yes** | a model/provider swap is exactly what the chain is for (`model_not_found`) |
| `rotate` | **yes** | "this provider/account can't serve us" (transient `auth`, `billing`) |
| `backoff_then_rotate` | **yes** | the binding case: a throttle (`rate_limit`). A bounded job moves on rather than sitting in an in-place backoff. |
| `backoff` | no | a *bare* backoff (`overloaded` / `server_error` / `network` / `unknown`) is a same-leg retry concern - C2 surfaces it, no in-place retry |
| `compress` | no | `context_overflow` routes to compaction/handoff, **never** fallback - a sibling provider has the same window problem with the same payload |
| `no_retry` | no | `content_policy_blocked` / `invalid_request` - a verbatim retry anywhere fails the same way |
| `fail` | no | `auth_permanent` / `oauth_long_context_beta_forbidden` - a human step; surface it |

Note the deliberate split: `backoff_then_rotate` advances (the throttle case),
but a bare `backoff` does not. Advancing is a **pure rule** - `classifyError`'s
action is in the advancing set AND another leg exists. No LLM decides anything.

**Operator config (no UI in C2).** Per-role chains live under `fallbackChains`
in `~/.arco/settings.json` (the standard defaults → global → project cascade,
sanitized in `settings.ts`). The server **reads** them and never writes them
back - the "config read, not write" fence. Shape:

```jsonc
{
  "fallbackChains": {
    "reviewer": [
      { "provider": "codex",  "model": "gpt-5",  "effort": "high" },
      { "provider": "ollama", "model": "qwen3-coder" }
    ],
    "research": [
      { "provider": "claude", "model": "sonnet" }
    ]
    // "seed" is reserved but NOT consumed in C2 (see fence below)
  }
}
```

For a job, the **effective chain** is `[primaryLeg, ...the role's configured
legs minus a leg equal to the primary]`. When the role is unset/empty the chain
is just `[primaryLeg]` - i.e. **today's behavior, no fallback, no regression**.
Each advance emits a `provider_fell_back` event (chat system-notice +
`events.jsonl`); see [`PROTOCOL.md`](PROTOCOL.md).

**Wired call sites:** the reviewer (`runReviewer.ts`, role `reviewer`) and the
deep-research leg (`runResearch.ts`, role `research`),
resolved in `workflowHandlers.ts` (`resolveFallbackLegs`, which resolves Codex
accounts per leg and drops a leg it can't authenticate).

**Fence (bounded-only + logged + no live swap):**

- The **live primary turn never falls back.** It runs through `seedWorker.ts`'s
  `runPrimaryTurn`, which is *not* routed through the chain. A live primary turn
  fails closed and surfaces to the operator. The handoff seed also runs through
  `runPrimaryTurn` (it *is* the primary-turn primitive, just with a seed prompt),
  so the `seed` chain role is **deferred** - wiring it would mean routing the
  primary path through the chain, which the fence forbids.
- Every advance is **logged** (`provider_fell_back` → `events.jsonl`).
- The chain is **operator-opted-in** (hand-configured) and **reversible**
  (remove the chain → fallback stops; a failed run still surfaces the last leg's
  error). Clears the four-question test in `CLAUDE.md`.

Smoke: `npm run smoke:fallback` (pure unit - no WS, no server boot, no live
providers; stubs a throttle on leg 0 and asserts leg 1 runs + one
`provider_fell_back` fires, plus the `compress`/single-leg negatives).

---

## Cross-references

- The provider abstraction interface: `server/src/providers/types.ts`
- Factory: `server/src/providers/index.ts`
- How providers plug into the primitive flows: [`PRIMITIVES.md`](PRIMITIVES.md)
- The protocol messages providers emit: [`PROTOCOL.md`](PROTOCOL.md) (`worker_*` and `primary_*` groups)
- Capability detection: `server/src/capabilities.ts`
- Auth flows: `server/src/auth.ts`
- Quota / throttle tracking: `server/src/quota.ts`
- Error-classifier taxonomy: `server/src/providers/errorClassifier.ts` (see the taxonomy table above)
- "Don't regress X" invariants: [`GOTCHAS.md`](GOTCHAS.md)

Strata 0.2 separates app/Terminal and engine versions. `latestVersions.strata`
tracks engine packages from the component feed (release-note/legacy fallbacks),
not the app tag; current details are in [STRATA.md](STRATA.md#engine-and-component-updates).

## Retired provider history

Z.ai, Antigravity, and Gemini support have been removed. Existing workflow
metadata, transcripts, artifacts and provider identity remain readable through
the normal history tools. A retired provider cannot start or resume work; choose
a supported provider explicitly for new work. Arco does not uninstall external
applications or delete their profiles or credentials.

For Antigravity and Gemini, updating unrelated settings preserves retired
defaults until they are explicitly changed. Z.ai is different: legacy Z.ai
settings, including a Z.ai default provider and its model, are ignored when
settings are read, while existing secret files are left in place. Anything that
still names Z.ai (a saved template, a create request, a login or update-check
request) gets the Z.ai removal notice rather than a generic unsupported-provider
error.

## Related links

- [Feature reference](FEATURES.md)
- [Settings](SETTINGS.md)
- [Gotchas](GOTCHAS.md)
- [Documentation style](STYLE.md)

HANDOFF starts a fresh session and can help when changing to an unrelated task, correcting a worker on a wrong track, switching provider or model, or using a provider without compaction. Compaction is lossy but has no fixed limit. Plans, board, goal, artifacts and Git remain outside the conversation. QUICK builds a deterministic seed; ORIGINAL WORKER writes a reflection; FRESH SUMMARIZER uses a separate worker.

## Request completion bounds

OpenAI-compatible generation includes waiting for response headers in its stall deadline. llama.cpp uses the smaller of the recovery stall and turn budgets while recovery is enabled. Discovery keeps its three-second deadline through model-list JSON parsing. WebSearch keeps its deadline and operator cancellation active through JSON parsing.

OpenAI-compatible streams finish at `[DONE]`; Ollama streams finish at `done: true`, even when the HTTP body remains open. Claude CLI snapshots track text by message and block so repeated snapshots do not hide later blocks or shorter final answers.

Claude Native token-count telemetry has a five-second deadline and is cancelled by STOP. A cancelled or failed count falls back to response usage so turn completion does not wait on telemetry.

Claude Native checks MCP session health and launch settings at each turn boundary. Failed or closed sessions reconnect, and a changed command, arguments or environment replaces the previous session. Healthy unchanged sessions stay open.

FOLD and S-FOLD can restore a saved Claude Native conversation after a server restart, before its next turn. Deterministic Fold replays the saved log without needing provider credentials; Server Fold retains its normal request and fallback behavior.

Deterministic Fold keeps the newest complete question and answer together, even when that exchange exceeds the tail token target or is the whole saved conversation.

Claude CLI session watching belongs to the current workflow and session generation. A delayed load from an older reconnect or handoff cannot replay rows or replace a newer watcher.

Automatic Claude CLI calibration starts only while the same session remains idle. A new primary turn or cancellation during estimation or probe admission prevents a concurrent context probe.

STOP also revokes a normal message still preparing prompt or file context. It cannot enter a queue or start a provider turn after that cancellation.

A busy message resolves its selected one-shot skills before entering the queue. The same skill context is delivered once whether the provider consumes it as mid-turn steering or the queue runs it after the turn.

## Local-model recovery and cluster tools

A successful larger context window is retained for later tool requests on that backend during the same turn. Peer escalation sends the larger window explicitly. Only identified context-overflow errors trigger widening; other request validation errors retain their original explanation.

Transient backend failures receive bounded retries even with one backend. DNS lookup failures can use the configured hostname fallback. A rejected structured review synthesis keeps the completed free-text review and reports the fallback.

Cluster coordination tools have a separate allowance from action tools, so joining a cluster does not remove file-writing and web-research tools. Local-model peer messages can retry with confirm after a status-confirmation response; the first-send guard still applies.

Claude Native file guards use the same resolved file identity as Read, Write and Edit. A linked project folder or an in-project file alias preserves the partial-read warning and first-edit tracking. Configuration protection checks both the requested name and the resolved target. These checks do not expand which folders file tools may access.

### Bounded file discovery

Claude Native and local-model Glob, and JavaScript Grep when used instead of ripgrep, skip Git-ignored directories and nested Git checkouts or worktrees below the search root. Each walk has an entry and time budget; a limited response says "results truncated" and asks for a narrower path or pattern. Individually ignored files and explicitly selected ignored folders stay searchable. Useful hidden folders remain searchable, including explicit `.github/**` patterns. Grep can also target a single file. Selecting a nested checkout itself as the search root searches that checkout normally. Ripgrep keeps its existing Git-ignore behavior and execution limit.

Claude Native and local-model Glob can return a directory alias for a directory-only pattern such as `src-link/`. The alias must resolve within the project and pass the path checks. Glob does not walk through directory aliases.

## Reading files and attachments

Arco decodes file contents before sending them to a model. Local providers use
this reader for `Read`; Claude CLI, Codex and Cursor can use the read-only
`read_file` MCP tool for files in their workflow folder. It fits images,
extracts document text and reads notebook cells without extra software.
Other binary files produce a named-file note instead of raw bytes.

The same decoding applies to operator attachments, including Chat tabs that
have no file tools. Claude Native and Claude CLI send PDF text by default; scanned pages provide fitted images. The attachment receipt explains how to request visual pages.

Larger PDFs send a bounded range and a notice; use `read_file` with `pages` for another range. For layout, charts or figures, use `pdf_mode: "visual"` with an explicit `pages` range. Word, Excel, PowerPoint,
OpenDocument and RTF files become text. Other local and CLI transports
receive extracted PDF text and fitted scanned-page images.

Large documents are bounded; use
`pages` on `Read` or `read_file` to select PDF pages, spreadsheet sheets,
presentation slides or notebook cells, for example `1-3,5`. Text files retain
line addressing through `offset` and `limit`.

Images use the selected transport's native image input. Ollama checks the
serving model's reported vision capability for every request. llama.cpp needs
both a vision-capable catalog entry and its projector. LM Studio uses native
model metadata when available; Strata and DeepSeek use their reported model
capabilities. An unknown or text-only model receives a clear image note.
MCP image results follow the same capability checks.

Codex exec, Codex app-server and Claude CLI receive file-reading guidance only
when the workflow file server is attached. Chat omits that guidance. Cursor ACP
uses its loopback file server in solo tabs too; cluster membership alone without
a working folder does not advertise file tools.

Codex enables its local image tool on both transports. Arco inspects `codex
features list`: CLIs advertising `view_image` receive `features.view_image=true`;
older CLIs retain `tools.view_image=true`. The probe is cached for one minute. Cursor ACP exposes the
file reader in solo and cluster tabs and avoids decoding binary bytes in its
text-file callback. Cursor print Agent turns use a temporary read-only file-reader
plugin in a private nested temporary folder, which meets Cursor's minimum plugin-path depth. When a workflow identity is supplied, it also exposes only `plan_list`,
`plan_ref_list` and `plan_ref_read` through a separate plan server. It receives
no plan writers, cluster board tools or configured registry tools. Chat turns
omit the project plugin and file-tool guidance while retaining decoded operator
attachments. Agent turns keep ask mode and the original workflow folder, and
remove the temporary plugin when the subprocess ends. It does not change saved Cursor MCP configuration or
approve unrelated MCP servers.


Claude CLI streaming input uses the documented `SDKUserMessage.message`
content blocks. Images and PDFs precede the request text. See the
[Claude SDK input schema](https://code.claude.com/docs/en/agent-sdk/typescript#sdkusermessage).

### Public URL files

Native `read_url`, local `WebFetch` and the read-only `fetch_file` tool in the Claude CLI, Codex and
Cursor file servers share the public URL reader. Fetched images become fitted
image blocks. PDFs provide selected page text or scanned-page images; Native `read_url` and `fetch_file` accept `pdf_mode: "visual"` with `pages` for selected visual pages. MCP tools return fitted images for visual pages. `pages`, such as `2-4`, also selects supported document ranges.
The range selects decoded content; the downloaded source still has a byte cap.

The direct reader accepts HTTP(S), checks every resolved address and rechecks
each redirect before following it. Loopback, private and link-local targets are
refused. Text downloads have a 128 KiB budget; media and document sources have
the shared 512 MiB limit. The direct request and decoding deadline is 10,000 ms.
Cancellation releases the response reader. Local WebFetch can use its existing
browser fallback for bot-protected text pages.

Native `read_url` returns PDF text and scanned-page images by default. Use `pdf_mode: "visual"` with `pages` for selected native PDF pages. It follows
Chat web access and the agent tool posture. WEB LOOKUPS / TURN also sets its
separate per-turn call cap, including failed attempts; the default is 15.
Its image and document results share Native context media limits. Reload keeps
the source URL and a receipt so the model can call `read_url` again.

### Local cluster board tools

Ollama, llama.cpp, LM Studio, Strata and DeepSeek expose all eleven `cluster_task_*` tools to standard-access cluster members with an attached task board. These tools list, show, create, claim, update, heartbeat, comment, link, unlink, block and submit completion reports through the existing cluster board API. Completion submits to review; done and archived remain operator-only.

The BOARD mode takes effect on the next turn. Detached boards and BLIND members receive no board tools, and execution repeats those checks. Local execution still requires AUTO mode and a workflow folder. Explicit tool allowlists still apply. Ollama keeps attached board tools in its coordination core, outside relevance trimming; its tool cap grows by the attached coordination-tool count. Native and local providers share the board descriptions and argument schemas.

### Workflow plan tools on Native and local providers

Claude Native, Ollama, llama.cpp, LM Studio, Strata and DeepSeek offer `plan_create`, `plan_attach`, `plan_list`, `plan_ref_write`, `plan_ref_list` and `plan_ref_read` in Agent tabs with a workflow folder and identity. These are workflow plan tools, separate from cluster shared-plan tools and Native plan mode. Ordinary Chat tabs and ISOLATED Native members do not receive them. Local execution requires AUTO mode; explicit local tool allowlists still apply.

The schemas, descriptions, structure checks, reference slug validation and REST operations live in `server/src/planTools.ts`. MCP, Native and local adapters share them. Creating a plan attaches it to the calling workflow; model-supplied arguments cannot replace that identity or its project folder. Replacing a plan body or deleting a plan remains outside this tool family. Ollama ranks these tools as ordinary relevance candidates by default. Plan-related task context or an explicit plan request keeps all six for that turn, adding their count to the normal cap.

### MCP response media accounting

The MCP reader retains up to 20 decoded image blocks per tool response; PDF resources are decoded to text and scanned-page images. Encoded text resources use the bounded text path and do not consume that media count. A PDF document block can contain several pages; provider request guards count its actual pages separately. Source decoding remains bounded to 100 response entries and the per-source byte limit.

### Uploaded image storage

Uploaded JPEG and PNG files over 1 MiB (1,048,576 bytes) or 2,000 pixels on their long edge are optimized inside Arco's managed uploads folder. A successfully written, decoded and dimension-checked smaller file replaces the larger upload at the same path. The larger uploaded copy is deleted by that replacement; messages, event logs, saved file context and handoff/replay references continue to resolve. Arco does not keep a full-size upload backup.

Source format determines encoding: JPEG photos stay JPEG at quality 90, retaining EXIF orientation metadata; PNG screenshots stay PNG. PNG pixels are reduced only above the 2,000-pixel edge limit. Images are never enlarged. Files at or below both thresholds stay byte-identical. A failed write, verification or replacement, or an encoded result that is not smaller, leaves the upload untouched.

Only regular files beneath the managed uploads folder qualify. Symlinked files, linked folders, escaping realpaths and files outside that folder are refused. Project images read through Read, file references or a request to inspect a path are never rewritten, replaced or deleted, and no copy is written beside them. PDF, Word and other non-image uploads are unchanged. Other image formats retain the existing model-copy behavior without replacing their uploaded originals.

Animated and 16-bit PNG uploads remain unchanged. The smaller copy keeps the picture, but PNG text chunks and colour profiles, and JPEG metadata other than EXIF, are not carried over. When the uploads folder is reached through a linked folder, nothing is shrunk and uploads stay as sent.

Model fitting does not enlarge images. JPEG, PNG, GIF and WebP uploads that already fit the 2,000-pixel edge and 3.75 MiB model byte limits need no model-copy sibling; optional image converters are checked against the source dimensions.

### Earlier conversations after a handoff

Successful Handoff and Spawn operations save their source conversation and the event boundary used for the transfer. The latest seed and HANDOFFS panel show **From** and earlier sources. Opening one selects or reopens that conversation in HISTORY, limited to the recorded boundary; **Show full history** removes that display filter. Closing a tab preserves the source. Deleted or archived sources remain unavailable until a retained archive is restored through Storage.

Source links survive restart and chains of handoffs, including a handoff within the same tab. Chat, incognito, BLIND and ISOLATED conversations do not receive these links. The links contain references, not copied transcripts. Agent retrieval through a dedicated tool is a separate integration; a source control alone does not give the agent that tool.
