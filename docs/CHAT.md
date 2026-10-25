# Chat and Incognito

Current behavior checked against `server/src/chatMode.ts`, the workflow creator,
`ChatModeView`, workflow persistence and provider dispatch on 2026-09-25.

## Operator guide

Choose **+ NEW → CHAT** for conversation without a project. Pick a name, provider,
model and supported effort, then launch. Chat has no Agent CONFIG/right panel,
file tree, skills, Review/Handoff/Spawn or project actions — use an Agent tab when
you need those. Claude Native's `chat` **tool posture** is different: it is a
limited tool set inside a project Agent, not a Chat tab.

| Mode | Providers | Local persistence | Reopen |
|---|---|---|---|
| Saved Chat | Claude, Codex, Z.ai, Cursor, Ollama, llama.cpp, LM Studio, Strata | Arco event/meta files and provider session storage where supported | + NEW → CHAT → PAST CHATS |
| Incognito Chat | Claude, Codex, Z.ai, Ollama, LM Studio | Memory-only in Arco; provider-local session persistence disabled | None after close/refresh/restart |

Gemini and Antigravity are Agent-only: the creator filters them and the server
rejects a crafted request. Provider enabled/auth/model availability gates also
apply. Cursor's CLI has no ephemeral-session flag and llama.cpp's shared daemon
always logs to `~/.archon/llamacpp.log`, so both are rejected for Incognito. Strata is also excluded because its standalone
request logs and encoded-image cache persist outside Arco.

**Header.** Shows the tab name, a **model + effort picker** (same provider only;
applies to the next message, the conversation carries over; an off-catalog model
shows as `(unlisted)`), the web toggle, and a `SAVED` / `INCOGNITO · NOT SAVED`
status. Provider swaps are not offered — start a new chat.

**Composer.** Enter sends; Shift+Enter inserts a line; Ctrl+K kills from the
cursor to end of line (same binding as the Agent composer). The box grows with
the message up to 200px, then scrolls. The send control becomes Stop while busy.

**Row actions.** Hovering a message shows **COPY**, **EDIT** (loads that text
into the composer — it does not rewrite history) and, on the last answer,
**RETRY**, which re-sends the message that produced it as a *new* turn. The model
still sees its previous answer; RETRY is not a rewind.

PAST CHATS sorts saved conversations by latest activity, showing name, timestamp,
last user-message preview, provider and model. A row reopens its original workflow
ID and config via normal replay. REFRESH reloads the list. Closing a saved tab
does not delete it; an HTTP load error is not an empty history. Incognito is never
listed. The native-session RESUME picker is a separate project-based surface.

## Web access

For prepared Original/SC117 switching, CPU vision, memory limits and recovery,
see [STRATA.md](STRATA.md). Same-provider switches preserve Chat history and load
on the next message; one Strata profile is resident at a time.

Strata saved Chats use the same SearXNG `WebSearch` / `WebFetch` pair as Ollama.
The header toggle defaults on; switching it off removes tools. Dispatch also
rejects all project tools, even if the model invents an unadvertised tool call.

A per-tab toggle (`WorkflowConfig.chatWebAccess`) arms web search + fetch and
nothing else — no files, shell, MCP or project. Absent means **on for a saved
chat, off for Incognito** (a search query leaves the machine, so Incognito opts
in explicitly). `chatWebArmed()` in `server/src/chatMode.ts` is the single
decider; every transport states the mode outright rather than inheriting a
provider default:

| Provider | Armed | Disarmed |
|---|---|---|
| Claude CLI | `--tools WebSearch,WebFetch` + `--strict-mcp-config` | `--tools ""` |
| Claude Native | `buildChatWebTools()` — Anthropic `web_search` + `web_fetch` only (no `code_execution`) | empty `tools` |
| Codex exec / app-server | `web_search="live"` | `web_search="disabled"` |
| Ollama | Arco's local SearXNG-backed `WebSearch` / `WebFetch` pair, re-checked at dispatch (`ollamaToolCallAllowed`) | no tools |
| Strata | Same local web pair, with advertisement and dispatch allowlists | no tools |
| Everything else | — (header shows `NO WEB`) | — |

`chatSystemPrompt(armed)` moves the system prompt with the toolset. Ollama chat
replay drops preserved hidden thinking and armed turns append a current-capability
reminder, because an old offline turn otherwise talks the model out of using the
tools it now has.

## Attachments

Attach with **＋**, paste, or drop anywhere on the view (the app-wide
DragOverlay dispatches `archon:attach-files`; `ChatModeView` listens for it just
as `TerminalInput` does on Agent tabs). Uploads go through `POST /upload`. A
failed upload shows an inline notice instead of vanishing. Send is held while an
upload is still in flight, so a pasted screenshot can't miss its message.
Incognito hides the control, a paste/drop shows "attachments are off", and the
server fences attachments for incognito workflows (an upload would touch disk).
RETRY resends the prompt's attachments and EDIT re-stages them.

How an attached image reaches the model depends on the provider. Non-image files
always fold as `[attached file: <path>]` text references. Images cap at 5 MB on
every transport (`server/src/providers/attachments.ts` for the newer ones):

| Provider | Images |
|---|---|
| Claude CLI / Native | native image content blocks |
| Codex exec / app-server | native (`-i <path>` / `localImage` input) |
| Ollama | base64 `images` on vision-capable models |
| llama.cpp | OpenAI `image_url` parts when the loadout declares vision + `mmprojPath`; otherwise skipped with a notice |
| LM Studio | OpenAI `image_url` parts (the backend rejects/ignores them on a non-vision model) |
| Cursor (Chat → `print`) | path reference + `--add-dir <upload dir>`; `--mode ask`'s read tool opens the image (verified with a live turn) |
| Cursor (Agent → ACP) | native ACP `image` blocks when `initialize` advertises `promptCapabilities.image` (cursor-agent 2026.09 does); path reference otherwise |
| Z.ai | path reference + a `system_notice` — every catalog GLM is text-only, so the image is not seen |

Before 2026-09-25 Cursor and Z.ai (and Gemini on Agent tabs) dropped attachments
outright. Most chats have no file tools, so a model that only receives a path
reference cannot open it — Cursor's ask mode is the exception.

**Image downscaling.** `/upload` fires `queueModelImage` after the write (the
response doesn't wait). A PNG/JPEG/WEBP over 2000px on the long edge or over
3.75 MB raw (the 5 MB base64 API cap) gets a sibling `<path>.model.<ext>`
fitted to 2000×2000; still over the cap ⇒ JPEG q85 with alpha flattened onto
white (`.model.jpg`). GIFs are left alone. The original is never modified, and
`[attached file: …]` refs and `path` fields keep naming it — only the bytes
the model receives change. Async turn starts (Codex app-server, Cursor ACP,
Ollama, llama.cpp, LM Studio, Antigravity) `awaitModelImage` (≤5 s; an
upload that predates this, in `./uploads`, derives on demand); sync ones
(Claude CLI / Native, Codex exec) take `modelImagePath` — the sibling if it's
on disk. Media type follows the derived file. Tooling is detected once:
ImageMagick `magick` → `convert` (absolute fallbacks, since the systemd PATH
lacks `~/.local/bin`), then macOS `sips`; none, or any failure, ⇒ the
original goes through as before.

## Persistence and privacy boundaries

Saved Chat uses `~/.archon/chats/<wfid>` as a **persistence cwd**, not a project.
The existing store layout is nested beneath that:

```text
~/.archon/chats/<wfid>/.archon/workflows/<wfid>/
  meta.json
  events.jsonl
```

`kind:'chat'` reaches provider workers as `interactionMode:'chat'`. Native/local
HTTP workers omit tools (except the armed web pair above); Claude CLI uses an
explicit `--tools` allowlist plus strict MCP configuration. Cursor uses its
stateless `-p --mode ask` transport with transcript replay. Codex runs a
read-only sandbox in the isolated cwd, because its CLI has no universal tool
allowlist. The conversation-only interface is not a claim that every provider
implements an identical security sandbox.

Incognito additionally suppresses Arco transcript/meta/index writes, operational
logs, notifications, hub reporting, worker PID registration and browser-persisted
chat/drafts. Claude CLI uses `--no-session-persistence` with its private framing on
stdin; Codex is forced to `exec --ephemeral`, and Z.ai to Native, without
overwriting global transport preferences. The only config edits an incognito
chat accepts are `INCOGNITO_SAFE_CONFIG_FIELDS` (model / effort / chatWebAccess) —
they choose what the next turn spawns and persist nothing. Never attach a real
project or run consequential diagnostics against an Incognito workflow.

Closing or refreshing the browser, or restarting the server, loses Incognito.
The 10-second observerless grace supports brief reconnects; it is not a durable
restore mechanism. Remote provider retention remains provider-controlled. This
feature does not promise provider-side deletion, anonymity or secure memory wiping.

## Maintainer references

- `server/src/chatMode.ts`: provider sets (`CHAT_PROVIDERS`, `INCOGNITO_CHAT_PROVIDERS`,
  `CHAT_WEB_PROVIDERS`), `chatWebArmed()`, `chatSystemPrompt()`, storage root,
  saved-chat listing.
- `client/src/components/ChatModeView.tsx`: projectless view, composer, header pickers.
- `server/src/chatMode.test.ts` (`npm run test:chat-mode`) and
  `scripts/smoke/chat-mode.ts` (`npm run smoke:chat-mode`): privacy/dispatch checks.
- `docs/PROVIDERS.md` → Chat-mode execution contract: per-transport enforcement.
- `docs/GOTCHAS.md` → Provider / worker plumbing: load-bearing privacy invariants.
- In-app manual: `chat-mode`, `past-chats`, `incognito-chat`; help registry:
  `client/src/help/content/chat.tsx`.


### Computer voice agent and privacy

Computer's dedicated header panel selects Codex, Claude Native, Ollama or
Strata, with the same bounded browser tools and no project toolset. Each
provider/model/effort has separate saved context. Switching waits for the
server's complete turn/queue boundary and copies no transcript. No history
uses strict Incognito on Codex/Claude/Ollama; clearing discards the visible and
server memory transcript, and leaving removes the private workflow. Strata
remains saved-only because its standalone logs/cache persist. Provider-side
cloud retention and messages sent to workers keep their respective rules.
Defaults: full context clear at 50% subscription / 75% local of the actual
configured window. [VOICE.md](VOICE.md) is the current contract.
Codex Computer also detects stalled turns, replaces only its own connection,
speaks the failure and cancels dependent queued requests without retrying actions.
Saved history remains resumable. A lost private context clears visibly with
reason `recovery`; ordinary chats and local model loads are not affected.
