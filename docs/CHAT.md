# Chat and Incognito

How projectless Chat and Incognito work: providers, web access, attachments,
persistence and privacy boundaries.

## Operator guide

Choose **+ NEW → CHAT** for conversation without a project. Pick a name, provider,
model and supported effort, then launch. Chat has no Agent CONFIG/right panel,
file tree, skills, Review/Handoff/Spawn or project actions - use an Agent tab when
you need those. Claude Native's `chat` **tool posture** is different: it is a
limited tool set inside a project Agent, not a Chat tab.

| Mode | Providers | Local persistence | Reopen |
|---|---|---|---|
| Saved Chat | Claude, Codex, Cursor, Ollama, llama.cpp, LM Studio, Strata, DeepSeek | Arco event/meta files and provider session storage where supported | + NEW → CHAT → PAST CHATS |
| Incognito Chat | Claude, Codex, Ollama, LM Studio | Memory-only in Arco; provider-local session persistence disabled | None after close/refresh/restart |

For Chat tabs, provider enablement, authentication, and model availability gates
apply. Cursor's CLI has no ephemeral-session flag and llama.cpp's shared daemon
always logs to `~/.arco/llamacpp.log`, so both are rejected for Incognito. Strata
and DeepSeek are also excluded from Incognito because their request logs or
caches persist outside Arco.

**Header.** Shows the tab name, a **model + effort picker** (same provider only;
applies to the next message, the conversation carries over; an off-catalog model
shows as `(unlisted)`), the web toggle, and a `SAVED` / `INCOGNITO · NOT SAVED`
status. Provider swaps are not offered - start a new chat.

**Composer.** Enter sends; Shift+Enter inserts a line; Ctrl+K kills from the
cursor to end of line (same binding as the Agent composer). The box grows with
the message up to 200px, then scrolls. The send control becomes Stop while busy.

**Row actions.** Hovering a message shows **COPY**, **EDIT** (loads that text
into the composer - it does not rewrite history) and, on the last answer,
**RETRY**, which re-sends the message that produced it as a *new* turn. The model
still sees its previous answer; RETRY is not a rewind.

PAST CHATS sorts saved conversations by latest activity, showing name, timestamp,
last user-message preview, provider and model. A row reopens its original workflow
ID and config via normal replay. REFRESH reloads the list. Closing a saved tab
does not delete it; an HTTP load error is not an empty history. Incognito is never
listed. The native-session RESUME picker is a separate project-based surface.

## Web access

For prepared Strata profile switching, CPU vision, memory limits and recovery,
see [STRATA.md](STRATA.md). Same-provider switches preserve Chat history and load
on the next message; one Strata profile is resident at a time.

Strata saved Chats use the same SearXNG `WebSearch` / `WebFetch` pair as Ollama.
The header toggle defaults on; switching it off removes tools. Dispatch also
rejects all project tools, even if the model invents an unadvertised tool call.

A per-tab toggle (`WorkflowConfig.chatWebAccess`) arms web search + fetch, including Native `read_url` for public file links, and
nothing else - no local file tools, shell, MCP or project. Absent means **on for a saved
chat, off for Incognito** (a search query leaves the machine, so Incognito opts
in explicitly). `chatWebArmed()` in `server/src/chatMode.ts` is the single
decider; every transport states the mode outright rather than inheriting a
provider default:

| Provider | Armed | Disarmed |
|---|---|---|
| Claude CLI | `--tools WebSearch,WebFetch` + `--strict-mcp-config` | `--tools ""` |
| Claude Native | `buildChatWebTools()` - server `web_search` + `web_fetch` and portable `read_url` (no `code_execution`) | empty `tools` |
| Codex exec / app-server | `web_search="live"` | `web_search="disabled"` |
| Ollama | Arco's local SearXNG-backed `WebSearch` / `WebFetch` pair, re-checked at dispatch (`ollamaToolCallAllowed`) | no tools |
| Strata | Same local web pair, with advertisement and dispatch allowlists | no tools |
| Everything else | - (header shows `NO WEB`) | - |

The shared direct URL reader accepts public HTTP(S) sources. Text downloads stop
at 128 KiB; image and document sources have a 512 MiB limit before decoding.
Private, loopback and link-local addresses, and unsafe redirects, are refused.
The local WebFetch browser fallback remains available for bot-protected text
pages.

`chatSystemPrompt(armed)` moves the system prompt with the toolset. Ollama chat
replay drops preserved hidden thinking and armed turns append a current-capability
reminder, because an old offline turn otherwise talks the model out of using the
tools it now has.

## Attachments

Attach with **+**, paste, or drop anywhere on the view (the app-wide
DragOverlay dispatches `arco:attach-files`; `ChatModeView` listens for it just
as `TerminalInput` does on Agent tabs). Uploads go through `POST /upload`. A
failed upload shows an inline notice instead of vanishing. Send is held while an
upload is still in flight, so a pasted screenshot can't miss its message.
Incognito hides the control, a paste/drop shows "attachments are off", and the
server fences attachments for incognito workflows (an upload would touch disk).
RETRY resends the prompt's attachments and EDIT re-stages them.

Arco prepares attachments before sending, including Chat tabs without file
tools. PDFs, Office documents and notebooks provide decoded content; other
binaries provide a readable note. Path labels retain the original attachment
name and accompany the content. Images are fitted to the transport's limits:

| Provider | Images |
|---|---|
| Claude CLI / Native | native image content blocks |
| Codex exec / app-server | native (`-i <path>` / `localImage` input) |
| Ollama | base64 `images` on vision-capable models |
| llama.cpp | OpenAI `image_url` parts when the loadout declares vision + `mmprojPath`; otherwise an image note |
| LM Studio | OpenAI `image_url` parts when native model metadata confirms vision; otherwise an image note |
| Cursor (Chat -> `print`) | path reference + `--add-dir <upload dir>`; `--mode ask`'s read tool opens the image (verified with a live turn) |
| Cursor (Agent -> ACP) | native ACP `image` blocks when `initialize` advertises `promptCapabilities.image`; otherwise an image note |

Chat does not need a file tool to receive decoded attachment content. Cursor
print uses a fitted local image path and read-only access to its upload folder.

**Image fitting.** Arco uses bundled image codecs to fit supported images within
2,000 pixels per side and 5 MB base64. Large GIFs are fitted too. SVG attachments include source text. Image-capable models also receive a fitted preview when rendering succeeds; text-only models receive an image-omission note. The original
upload stays unchanged; file references keep its name. ImageMagick or macOS
sips can accelerate decoding, but neither is required.

`POST /upload` starts `queueModelImage` without delaying the upload response.
When needed, `providers/attachments.ts` writes a fitted `.model.png` or
`.model.jpg` sibling. Claude Native prepares attachments through `readFileContent`, retaining typed
image and document blocks. Local and CLI adapters use
`prepareProviderAttachments` for fitted images and decoded document text.
Codex and Cursor print retain managed fitted-image paths for their image tools.
Malformed or unsupported content receives a readable note from the decoder.

Supported formats and document ranges are described in
[Native file reads and attachments](PROVIDERS.md#native-file-reads-and-attachments).

## Persistence and privacy boundaries

Saved Chat uses `~/.arco/chats/<wfid>` as a **persistence cwd**, not a project.
The existing store layout is nested beneath that:

```text
~/.arco/chats/<wfid>/.arco/workflows/<wfid>/
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
stdin; Codex is forced to `exec --ephemeral` (the Computer voice agent instead
uses an ephemeral app-server thread for Codex and Native for Claude), without
overwriting global transport preferences. The only config edits an incognito
chat accepts are `INCOGNITO_SAFE_CONFIG_FIELDS` (model / effort / chatWebAccess) -
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
- `docs/PROVIDERS.md` -> Chat-mode execution contract: per-transport enforcement.
- `docs/GOTCHAS.md` -> Provider / worker plumbing: load-bearing privacy invariants.
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

## Implementation history

Non-normative. Behavior was checked against `server/src/chatMode.ts`, the
workflow creator, `ChatModeView`, workflow persistence and provider dispatch
on 2026-09-25. Before that date, Cursor Chat dropped attachments outright.
