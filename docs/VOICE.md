# Computer and hands-free voice control

Canonical reference for Arco’s voice operator: everyday use, speech and
microphone settings, selectable agents, context/privacy, tools, activity,
conditional scripts, recovery and verification. Current behavior reviewed
2026-10-24. Start with the contract below; the later implementation history
records earlier designs and does not override it.

## How Computer works today (2026-10-17) — read this first

Everything below this section is the chronological record (and `## Commands`
is a capability table from the command-list era, not phrases the client
recognizes). This section is the current contract; the in-app manual
(`client/src/help/manualSections/voice.tsx`) says the same thing for operators.

### Start here

1. Run `npm run voice:setup` once, then open the header’s voice controls and
   enable hands-free (or press Ctrl/Cmd+Shift+Space). Use localhost or HTTPS.
2. Say “Computer”, wait for the soft double pulse, speak, then pause and say
   “over” on its own to submit. Silence never sends a directive.
3. To discard an unsent directive, say “Cancel capture”, including after words
   already dictated. To stop listening entirely, say “Stop listening”.
4. Open **COMPUTER** in the top bar for the agent, conversation, context,
   activity, watches and scripts. **VOICE CONTROLS → DETAILS** holds voice
   auditions, speech sensitivity and capture diagnostics. Reload disarms the mic.
5. To type instead, use the message field at the bottom of COMPUTER. If no
   conversation exists, choose an agent and press **USE AGENT** first. The
   microphone can remain off. Use **STOP REQUEST** while processing, or the
   script's **PAUSE** / **CANCEL SCRIPT** controls for a standing automation.

### Find a topic

| Topic | Current reference |
|---|---|
| Wake word, acknowledgement, submission and abort | [Capture flow](#capture-flow) |
| Quiet words, mic gain and recognition | [Microphone sensitivity](#microphone-sensitivity) |
| Interrupting spoken answers | [Speech interruption](#speech-interruption) |
| Tasks, questions, conversation and dictation | [Computer chat and intent handling](#computer-chat-and-intent-handling), [follow-up recipients](#follow-up-recipients) |
| Providers, models and history selection | [Agent selection](#agent-selection) |
| Context fullness, automatic fresh starts and manual clear | [Context lifecycle](#context-lifecycle) |
| Saved vs no-history behavior and cloud processing | [No history and privacy](#no-history-and-privacy), [reply voices](#reply-voices) |
| Female voices, accents and auditions | [Reply voices](#reply-voices) |
| Worker mail/status, quota, screen controls and other actions | [Operator tools](#operator-tools), [quota and interface access](#quota-and-interface-access) |
| Worker output following selection or nudges | [Worker transcript follow](#worker-transcript-follow) |
| Live events and optional reports to the agent | [Live activity and agent updates](#live-activity-and-agent-updates) |
| Conditional nudges, messages, compaction and notifications | [Conditional scripts](#conditional-scripts), [script budgets and updates](#script-budgets-and-updates), [human-input holds](#human-input-holds) |
| One-shot completion notifications | [Completion watches](#completion-watches) |
| Older fixed-sequence automations | [Legacy mailbox rules](#legacy-mailbox-rules) |
| Stalls, errors, reloads and restart behavior | [Tool relay and fault recovery](#tool-relay-and-fault-recovery), [operations and verification](#operations-and-verification) |
| Implementation entry points and related references | [Source map](#source-map) |

### Capture flow

AudioWorklet (`client/public/voice-capture.js`) → onset/release
segmentation → the first three seconds of each utterance stream to
`POST /api/voice/wake` (Vosk grammar, `server/src/voice/recognizer.py`) while
the full segment goes to `POST /api/voice/audio` (Parakeet text + Vosk
phrases) → `reservedVoiceText` (wake-word repair tolerates near misses,
closing-phrase repair) → `VoiceCommandBuffer` → the Computer chat. The quiet
**Soft double pulse** acknowledgement (230 ms)
plays only after the full transcript verified "Computer" as the first word;
the fast wake only opens the capture so the words right after it are kept.
The original cue is bundled as `server/src/voice/capture-ready.wav` and served
by `/api/voice/ready-sound`. It is mastered at peak 0.065 (the audition's
default 65% volume), played at unity gain with no normalization or extra
boost. It never blocks capture or waits for speech synthesis. No local TNG
asset is needed, and existing personal reference files are left alone.
Submit with a standalone **over** (execute / engage / make it so), discard
with **cancel** / **belay that** on their own, or **Cancel capture** at the
end. This discards only the unsent capture and returns to waiting for Computer;
it never cancels a standing rule or stops a worker, and needs no “over”. It
works after an already dictated message and in the same utterance: “Computer,
tell the builder to change the tests, actually, cancel capture.” The whole
unsent directive is discarded. Bare “cancel” within “tell the worker to cancel
the test” stays literal. Two
minutes of silence also expires the capture. Fillers such as “oh cancel” are
ordinary captured text; if they reach Computer, it must clarify the intended
object before cancelling/pausing a script, watch or worker. Recent conversation
about a rule is not enough authority to cancel it. “Cancel that conditional
script” is a specific instruction; “discard this voice request, keep the script
running” changes no automation.
Instant words, the only client-side matching: quiet / stop / stop talking /
stop speaking / stop reading, and stop listening / turn off hands free.

### Microphone sensitivity

Voice Controls offers Very high/High/Normal/Low/Very low
speech sensitivity: minimum onset RMS 0.001/0.002/0.0035/0.006/0.01.
Production capture and the standalone microphone preview request browser
automatic gain control OFF (`autoGainControl:false`), retaining echo
cancellation and noise suppression. Arco does not automatically adjust the
operator's system mic gain. This capture constraint applies when enabling the
microphone; after deployment, reload and re-enable hands-free.
`voiceStore.speechThreshold` persists as `archon.voice.threshold.v1` and is
posted to the live worklet; adaptive onset remains max(minimum, noise × 2.2).
This does not change system mic gain. Compare input peak, floor and onset.
If Last heard contains “older” or “over it”, the segment reached ASR but was
misrecognized; lower gating is not a correction for wrong text. Pause before
a standalone “over”, or use “End capture”. Never promote Vosk’s isolated
“over” hypothesis over a longer transcript: it could be ordinary dictation.

### Worker transcript follow

Voice selection (including selecting the same
worker again or going back) opens its latest output and resumes following.
A successful voice message/nudge to the selected worker also resumes following
its reply. Scrolling up afterwards pauses following as usual. A send to another
worker does not move the current transcript or change selection.

### Live activity and agent updates

COMPUTER’s ACTIVITY & CONDITIONS
section shows a bounded recent ledger and the agent inbox.
Saved Computer selection binds on reload as its chat is restored, without an
utterance or USE AGENT. Activity controls work with the microphone off; loading,
disconnects and errors are explicit, with RETRY ACTIVITY for a failed read.
Arco emits factual worker-start/finished/error/STOP/removal, queue, mailbox and cluster-change events
at their mutation sites. Worker finish is the authoritative complete busy/queue
boundary, not the earlier provider turn-end. Workers make no extra model calls
to report themselves, and Computer’s own turns/private chats never enter the
public worker stream. The saved recent ledger retains 200 public metadata
records (100 displayed), not copies of worker conversation text; ordinary saved
workflow transcripts retain their existing history.

Enable event automations pauses/resumes this Computer owner’s scripts and mailbox actions
and optional agent updates. It cancels waiting agent updates when disabled.
Individual mailbox conditions also have PAUSE/RESUME/CANCEL; expiry keeps running
while paused. Completion watches still resolve normally; already started turns
continue. The agent-update selector defaults OFF and can forward matched
conditions only, or worker completions/errors/interruptions plus matches. These
settings belong to this Computer context. Switching model/provider/history turns
off the old agent’s update feed and cancels its waiting updates; the new agent
opts into its own feed. Saved conditions remain armed independently.

Agent updates use the selected existing provider/model/effort; Luna remains LOW
by default. They queue while Computer is busy or finishing its full turn/reset
boundary, then batch up to ten facts into a visible read-only turn. The model
records facts for follow-up questions and replies Done; the server refuses ALL
operator tools in these background turns. Operator directives arriving during an
update enter the follow-up queue and run with normal tools afterwards. Automated
updates do not replace or speak over operator answers. No worker content is
interpreted as an operator directive or an authorization to create conditions.

Monitoring/condition evaluation uses no model calls. Enabling agent updates
spends normal selected-provider usage: at most 12 update turns per rolling hour,
with up to 50 pending facts. Overflow is recorded as cancelled, rate-limited
updates wait for one actual deadline, and queued/delivering/delivered/failed/
interrupted/cancelled states remain visible. CLEAR QUEUED UPDATES discards waiting
updates without stopping workers or conditions. No automatic retry/replay after
a failed update or server restart. A locked durable atomic file
`~/.archon/computer-activity.json` holds public recent facts/settings/inbox/rate
counters. Private settings, inbox, matched-condition facts and counters stay in
memory, disappear on a full private clear/removal, and never enter saved logs or
external notifications. Public worker metadata remains public when a private
Computer subscribes to it. WebSockets push invalidations; no Redis or additional
service is required.

Voice controls: “Enable worker updates to you”, “Only send you matched condition
updates”, “Stop sending activity to your agent”, “Pause all my mailbox
automations”, “Resume them”, “Show recent activity”, “Clear queued activity
updates”, “Pause that mailbox rule” and “Resume that rule”. `archon_activity`
status/configure/cancel-queued and `archon_mail_rule` pause/resume implement these
through the shared model-interpreted tool catalog, without phrase matching.

### Conditional scripts

`archon_condition` is the general event-driven scripting
surface. Luna translates the operator's requested policy into a validated
declaration; the server evaluates it against real state. This replaces the
fixed mailbox recipe for new directives. No Director action is implicit.
`capabilities` returns the grammar and available controls; `state` returns the
actual scoped workers' facts. Unknown information is reported as null, never
invented or treated as permission to act. The compiler is the selected Computer
agent; Luna remains LOW by default. There is no utterance/role phrase parser.

Facts include busy, queued message count, pending mail, `has_work` (busy OR
queued OR pending mail), human-input state, context tokens/window/percentage,
native-compaction capability and progress, and counts of completed/failed/
interrupted turns, finished Archon-requested in-place compactions and mail arrivals since server boot. `has_work` is operational
state, not a project-quality verdict or a claim that all assigned work is done.
The last app-server request's prompt usage is exposed for ordinary workers too;
aggregate turn usage is never substituted for context fullness. Unreported
context is unknown. After restart, scripts restore the latest saved final-request
measurement; older Codex records fall back to the selected account/current
session's rollout `last_token_usage`. This is a read, never another worker turn.
Compaction/handoff/rewind boundaries invalidate earlier readings until a fresh
measurement; billing totals never substitute for context. Absolute token
thresholds can work even when a provider has not reported its window.
Expressions compose AND/OR/NOT, individual comparisons,
all/any/none over exact worker sets, and counts. Cross-cluster scripts can pin
up to four clusters/32 members; membership changes stop them.

Each named clause has a predicate and an ordered action list: standard nudge,
nudge only for new mail, send the operator's exact instruction, compact a worker,
notify, or invoke
an existing operator UI tool with its ordinary validation/confirmations.
Worker actions run on the server at an idle/empty-queue boundary. Mailbox locks
cover the last state check through the actual busy claim, including compaction.
UI actions require the owning hands-free browser; missing/failed delivery stops
the script without replay. Durable tool targets must be exact scoped IDs and
screen controls must use stable labels. Scripts cannot create more automations
or change Computer configuration. Normal project tools/shell access remain absent.

Clauses can run once or on changes of their referenced/watched facts; new-mail
nudges also deduplicate actual message IDs. `after` waits for all action targets
of an earlier clause to dispatch at least once. State-only finishing conditions
must not depend on optional mail nudges unless the operator asked for that
ordering: already-idle/empty workers can satisfy the condition immediately.
A started once-clause completes
its ordered actions even if its own effects change the trigger, retaining
input/idle/cancellation guards. A finishing clause stops after its actions;
dispatch is never described as successful project completion. Wait predicates
must describe the new state: after compaction, wait for compacting=false/idle,
not for the old 40% trigger to remain true. Provider-native compaction preserves
a summary; Ollama instead arms it at the next turn. Its requested continuation
starts that turn, which compacts before doing the work; never wait on the
in-place `compactions_finished` counter before starting that Ollama turn.
Unsupported transports are
refused. Script continuation is explicit; the manual Native auto-continue toggle
does not inject an extra continuation into a scripted compact.

“Keep nudging the builders for new mail, leave Director alone, and notify me
when those builders are idle with empty queues and mailboxes” produces separate
recurring mail actions and a notify-only finishing predicate. Director mail
does not force a Director nudge. “Compact Builder 1 at 40%, then continue after
compaction” can use different clauses, observations and actions without a new
hardcoded routine. Conditions are checked on committed events, with a dirty
latch through async work. Only actual cooldown/expiry deadlines use timers.

### Human-input holds

Scripts default to holding when a scoped worker needs
the operator or that fact is uncertain. `hold_worker_ids` narrows this to exact
workers when others are excluded. Native questions/gates and Codex structured
questions are authoritative immediately. For ordinary reply text, an armed
script batches changed completed public worker replies through an isolated, tool-free,
ephemeral Luna LOW observer. On restart/first use, the latest reply is restored
by streaming relevant saved events and retaining at most 32000 characters, so
large later activity/board records cannot hide a complete short reply. Missing
turn boundaries, unreadable history and genuinely oversized replies hold with
an explanation; explicit resume can retry unknown restored history. A history
check never starts or answers a worker turn. It only returns needs-input true/false/unknown;
it never answers, grants approval, routes work, or judges project quality.
At most 24 observation batches per owner/rolling hour, 16 replies/batch, normal
Codex subscription usage. The panel and saved audit show usage. Classification
is fallible: unknown, unavailable, truncated or oversized replies hold actions,
not silently continue. An unfinished ordinary reply stays unknown; the busy
worker is already ineligible for nudges, and its unknown fact is not changed to
false. Structured questions hold immediately even while busy. Once idle, unknown
input state holds before actions/completion notices. No automatic retry for the same failed observation;
operator review/resume can retry an unknown fact. An actual human answer starts
a new observation; ordinary idle state never releases a known input hold.
Explicit needs-input notification clauses can alert the operator while held.

### Script budgets and updates

Time/action budgets are operator-controlled. New scripts have **no default
expiry, total-action limit or per-worker-turn limit**: `ttl_minutes`,
`max_actions` and `max_worker_turns` default to null. They continue until their
finishing condition, cancellation or an applicable failure/STOP guard. Optional
positive whole-number limits can be as large as requested (within supported
numeric/date ranges): “allow 100 turns per worker and expire after six hours”
uses 100/360, with no invented total-action cap. Compaction and continuation
each count as a worker action. Cooldown defaults to 30 seconds and can be changed
by voice, including zero; idle checks, input holds and mail deduplication still
apply. Existing saved scripts retain their numeric limits until explicitly
changed. “Remove that script's time and turn limits” updates it in place with
null limits, retaining counters and already handled mail. Recurring compaction
watches completed runs; continuation after each compaction watches compactions_finished. There
are at most 16 active/100 retained scripts, eight clauses/128 expression nodes
and an 8000-character declaration. STOP/error stop scripts by default; explicit
error/interruption handling can opt out of that stop and use those facts.
Membership removal always stops. AUTO-PICKUP and legacy mailbox rules cannot
coexist with scripts in the same cluster. No retries after uncertain action
delivery, failure or restart. Already dispatched actions continue after cancel.

COMPUTER → CONDITIONAL SCRIPTS shows the exact declaration, scope, current
hold/reason, total/per-worker counts, each numeric limit or “no limit”, expiry
or “No expiry”, cooldown and PAUSE/RESUME/CANCEL. The heading separates active
and paused counts. Armed scripts stay visible with their reason and controls;
finished/cancelled/expired/interrupted/limited/failed scripts appear only under
collapsed **History**, never as active work. “0 active” and the empty-state
message mean nothing is currently armed to run (paused items are counted
separately). Expand a script for its declaration, full counts and limits;
**How scripts work** holds explanations and input-observation usage.
Disabling the activity master switch shows armed scripts as paused, while
completion watches remain active. The activity master switch
also pauses these scripts. Saved scripts use locked durable atomic
`~/.archon/computer-conditions.json`, survive saved context/model changes and
browser closure for server actions, and become interrupted on restart. Private
definitions/state/notifications remain memory-only and clear with the private
context; they never enter saved audits or external notices. Worker replies used
by the observer stay in volatile memory; no extra transcript copy is persisted.
Normal destination worker actions retain that destination's ordinary history.
Notification speech uses the Computer watches category, one-claim delivery and
the existing capture/playback queue. WebSocket invalidations refresh all four
activity/watch/legacy-rule/script projections; no browser polling.

To add or change conditions later, Computer reads the existing script and uses
`update` with its ID/current revision and the complete revised declaration. This
retains counters, handled mail and already dispatched matching actions; it does
not cancel/recreate the script or re-send completed messages. An unchanged
`ttl_minutes` retains the absolute expiry; explicitly changing it starts that
duration from the update, or removes expiry when null. Unrelated edits preserve
existing limits. Removing limits never resets usage counters.
Omitting budget/cooldown fields on an update also preserves the saved settings;
use explicit null to remove a budget.
A revision fence rejects stale edits and stale in-flight preflight callbacks.
Changing cluster scope requires a separate script.
The settings and automation area scrolls independently so expanded records do
not squeeze the conversation out of the panel.

### Legacy mailbox rules

Existing fixed-sequence rules remain
manageable with `archon_mail_rule`. New directives use the scripts above. The
compatibility HTTP API retains the finite sequence with
`archon_mail_rule` create/list/cancel. Example: “Nudge Builder 1 in SignalQueue,
keep nudging it when more mail arrives, then once only the Director has mail,
nudge the Director and let me know.” The model resolves exact cluster, selected
worker and final-recipient IDs once; the server checks mailbox IDs and busy/queue
state when worker, queue, mailbox or cluster events arrive, without model calls.
Only expiry and cooldown deadlines schedule timers; there is no recurring scan. A worker with pending mail gets a
standard mailbox reminder once idle; unchanged unread mail does not repeat.
New mail can trigger another nudge after a 30-second cooldown. Each nudge starts
a normal worker model turn, with a maximum of eight per selected worker (up to
16 selected workers). Every rule expires after two hours; Computer states these
limits when arming. No worker is interrupted or given extra queued nudges.

The final recipient must be idle with pending mail, and **every other pinned
cluster member**, including unselected members, must be idle with an empty
mailbox and queue. The final recipient is nudged once, then the rule notifies you
and stops. This confirms the nudge was dispatched, not that its work succeeded
or the project is complete. All-empty mailboxes simply wait for the condition or
expiry; there is no invented final mail or project-completion judgment.

Review selected identities, nudge counts, reason, cooldown, expiry, PAUSE/RESUME
and CANCEL RULE in COMPUTER. “What mailbox rules are active?” and “Cancel that mailbox
rule” work by voice. Cancellation prevents future nudges; already started turns
continue. One active rule per cluster; cluster AUTO-PICKUP must be off, and is
never silently changed. Membership changes, a stopped/failed member turn,
AUTO-PICKUP being enabled, mailbox errors, limit/expiry and server restart stop
the rule visibly. Mailbox snapshot plus final busy claim share the mailbox lock;
a cancelled or stale preflight cannot quietly enqueue a nudge.

Saved rules use `~/.archon/computer-mail-rules.json` and durable lifecycle/dispatch
notices; they survive context/model changes and browser closure, but restart
marks active rules interrupted and requires re-arming. Private rules stay in
memory, are visible only to their private Computer owner, and clear with that
private context. Their metadata never reaches saved logs or external notices;
a requested standard nudge still belongs to its normal destination worker’s
history. Final/stopped notifications use the existing Computer watches bell
category and queued spoken feedback, with one server claim across windows.
This is a specific operator-armed mailbox policy, not arbitrary conditional
scripting or a model polling workers.

### Completion watches

`archon_watch` create/list/cancel arms an explicit
one-shot notification. Resolve exact IDs via `archon_targets`: “Builder 1 in
SignalQueue” pins only that member, while the cluster ID snapshots currently
busy members. The server binds each ID to its busy-claim generation. Only the
complete user-turn drain loop (including queued messages) reports finished;
provider `primary_turn_ended` is too early. Cancellation/removal is interrupted,
errors are failed, newer generations/new members cannot trigger or extend a
watch. This is run completion, never a project quality/completion judgment.
Already idle refuses to arm. There is no model polling or worker prompt.
The panel shows an active watch count and only current watches by default;
terminal watches move into collapsed History with their targets and dates.
Legacy mailbox rules follow the same active/paused/history grouping, and their
section is omitted when no legacy records/errors exist. New directives use
conditional scripts, not that legacy section. Historical records cannot run.
Saved watches (32 active, 100 total records) use durable atomic writes under
`~/.archon/computer-watches.json`, survive model/context changes and reloads,
and become interrupted after server restart. Computer shows targets/status and
Cancel Watch; saved lifecycle notices enter its transcript and the bell’s
`computer-watch` category. Transient `computer_activity_changed` WebSocket invalidations refresh state on
change, initial selection and reconnect. The browser has no refresh interval.
A server-side announcement claim prevents duplicate speech across windows;
speech waits for capture/playback, respects the category mute and microphone/
spoken-feedback preferences, and remains interruptible. Existing notification
transports apply only to saved watches. Incognito watches are owner-scoped,
memory-only, never logged/pushed externally, and discarded on full clear or
private-context removal. Speech delivery is best-effort; terminal state remains
reviewable even if the microphone is off or a reload interrupts playback.

### Quota and interface access

`archon_usage` reads Codex/Claude/Cursor/Z.ai
usage snapshots, their freshness/errors, and separate throttling state. Codex
uses the existing cached `/api/codex-usage` endpoint without forcing scraping
or opening login. Percentages are derived only from explicit used/remaining
rows, never token counts or throttling. Profile paths/raw account text are not
returned. Computer may operate settings, themes, model/provider controls,
workflows, clusters, task boards, files, Git and dialogs through the UI; the
old prompt restriction against settings changes is removed. It checks the
screen before refusing. Browser protected actions (file chooser, privileged
clipboard, browser chrome) still require the operator; no arbitrary host shell,
filesystem or arbitrary HTTP tool is exposed.

### Speech interruption

Saying "Computer" while it talks stops it, the
way it does with a person. The wake detector stays armed during playback;
a fast-wake hit HOLDS the speech (`holdSpeech`, the sentence stops
mid-word) rather than killing it, because the phrase grammar has heard
Computer in "Thank you": the full transcript then either verifies the word
— playback ends, the double pulse plays, a capture opens and waits — or does not,
and the held sentence replays from its start (`releaseSpeech`). After the
interrupt, "stop" / "quiet" as the first thing said close the empty capture
with nothing; any directive works as usual, so "Computer, switch to ORBIT,
over" interrupts and acts in one breath. A bare "stop" / "quiet" with no name
also cuts playback — during playback nothing without the name can be a
directive, so the words cannot collide with one. Inside a capture that
already holds words, "stop" and "quiet" are literal (the buffer only treats
them as closings while the capture is empty). One guard: while the sentence
being spoken contains the word "Computer" (the manual's voice section
does), a wake or wake-led segment is ignored as probably its own voice
(`speakingItsOwnName`); the bare "stop" still works there. Diag events:
`speech-held`, `speech-released`, `wake-ignored reason:own-name`.

### Computer chat and intent handling

A projectless Chat with `WorkflowConfig.voiceOperator`; Codex
app-server (gpt-6-luna, low) remains the default. Its one MCP child `archon-voice`
(`server/src/mcp/voiceMcpServer.ts`, `default_tools_approval_mode="approve"`)
relays each tool call to the browser that owns the hands-free session:
`POST /api/voice/tool` → WS `voice_tool_call` → `VoiceExecutor.runTool` →
`voice_tool_result`. Every utterance is prefixed with an `[Archon context]`
roster line. The prompt (`server/src/voice/operatorPrompt.ts`) classifies
each utterance as TASK (do it, reply "Done." which the client swallows), ASK
(ambiguous target or an error that could not be worked around: one question
or the error text), or CONVERSATION (answer by voice in two to five sentences
after looking things up silently), plus DICTATION (verbatim text after
"dictate" / "verbatim" / "word for word", or the whole next utterance after
"I want to dictate a message to X" → "Go ahead."). Where it looks: how Arco
works → `archon_open manual` + `archon_read_text` filter; a project's state →
`archon_read_recent` / `archon_status` on it or its Director; the screen →
`archon_read_text`; general knowledge → just answers. A question *about* a
project is answered; only a question *addressed to* a worker is typed to it.

### Follow-up recipients

Resolve explicit targets in the current utterance
first, then clear references from the current conversation (including the
answer/tool facts just read), then the selected cluster if no topic is
established. Count candidates inside that scope, not globally. “Any mail in
SignalQueue?” → “Director has 15, Builder has 2” → “Nudge the builder” means
SignalQueue's unique builder, even if another cluster is selected. Use an
exact workflow ID or a qualified tool target to preserve that scope; look up
IDs through `archon_targets` if needed. A question followed by a directive does
not automatically change topics. A new explicit project/recipient supersedes
the earlier topic. Two matching builders within the relevant cluster still
require a short question naming only those builders; busy state, mail count
and list order never choose one. This is model-side reference resolution,
with no deterministic phrase matching or client-maintained topic memory.

Memory is the current agent context, resumed between requests until a fresh
context boundary. **COMPUTER in the top bar** opens its dedicated transcript panel
(conversation, tool calls and usage), separate from project tabs and ordinary
chats. Opening it never changes the selected project or enables the microphone;
CLOSE / Escape returns to the workbench, and VOICE CONTROLS opens the microphone
controls. The existing saved thread is retained. The `voiceOperator` flag,
not the chat's name, keeps it out of the tab strip, tab search and PAST CHATS.

The message field at the bottom sends typed requests, corrections and answers
to the same Computer conversation. Enter sends; Shift+Enter adds a line. The
microphone can stay off. A typed request authorizes browser tools only for
that request, until its full turn/queue boundary settles; opening the panel
alone does not authorize tools. Drafts stay in memory when closing the panel.
While Computer is processing, **STOP REQUEST** is in the fixed panel header
and the voice strip. Stop before sending a correction; started actions may
already have happened. Pause/cancel standing scripts separately under
CONDITIONAL SCRIPTS. The strip uses the same busy/queue/reset state as the
panel, and directs you to Computer when an old working message outlives its
request. A blocked script is distinct from an active Computer turn.

### Agent selection

COMPUTER offers provider/model/effort/history
and USE AGENT. Codex, Claude Native (Haiku/Sonnet/etc.), Ollama and Strata share
the same `toolDefinitions.ts` schema catalog and browser executor. Codex uses
the sole `archon-voice` MCP child; Native/local APIs call the same relay directly.
No project tools are exposed. Saved contexts are separate per provider/model/
effort; switching back resumes that selection. No messages are copied between
selections or into saved history. `ComputerConversation` waits for the server's
`computer_context_updated {settled:true}` clean boundary, not an intermediate
provider `primary_turn_ended`, before switching. Preferences alone persist in
`archon.computer.selection.v1`; the microphone stays off on reload.

### No history and privacy

No-history mode reuses strict Chat Incognito: Codex app-server `thread/start {ephemeral:true}`
(with the sole voice MCP and a pathless, memory-only thread), Claude Native, or
Ollama. No transcript/events/meta, browser job snapshot, operational logs, PID
records or provider session file. The transcript and tools live in memory until
a clear, model/privacy switch, page close/reload, or service restart. A clear
empties the visible transcript and pending capture too. Late recognition from
the previous context is rejected; the microphone stays armed. Strata is explicitly saved-only while its
standalone service logs/image cache persist. Selecting it never silently disables
privacy. Voice recognition requests carry `X-Archon-Voice-Private: 1`; server
recognition/diagnostic logs and private tool-relay logs are suppressed. Privacy
is bound to audio at capture time so a late response cannot leak after a switch.
Cloud inference and Microsoft speech still receive the text they process;
messages sent to another worker retain the destination's history rules.

`archon_computer` offers status/models/switch/reset/privacy. It lists real model
IDs/efforts before switching and asks about ambiguous variants; no client phrase
matching. “Clear your context” means full reset, “use Haiku” means switch, “go
incognito” means history none, “save our conversations again” means saved.
All changes are operator-requested bounded tool actions. The browser uses the
same controller for panel and voice requests; it rejects unknown IDs and
unsupported privacy combinations. Pending changes are visible; the armed voice strip also shows NO HISTORY. No new requests
are sent while switching; late recognition across a selection boundary is dropped.

### Reply voices

The default is Microsoft Edge's standard
`en-GB-SoniaNeural` (`ARCHON_VOICE_EDGE_VOICE` overrides the server default),
not a special voice file or a TNG clone. Recognition stays local. Spoken
reply text goes to Microsoft, which returns MP3; local Kokoro Emma is the
offline fallback. The selected agent supplies the conversational text independently.
DETAILS → Reply voice offers all 24 English female voices in the Edge catalog
verified on 2026-10-17, grouped and labeled by accent, plus the server default:
American (Ana, Aria, Ava, Ava multilingual, Emma, Emma multilingual, Jenny,
Michelle), Australian (Natasha), British (Libby, Maisie, Sonia), Canadian
(Clara), Filipino (Rosa), Hong Kong (Yan), Indian (Neerja, Neerja expressive),
Irish (Emily), Kenyan (Asilia), New Zealand (Molly), Nigerian (Ezinne),
Singaporean (Luna), South African (Leah), Tanzanian (Imani). Ana and Maisie
are child voices and labeled as such. The catalog is shared by the picker
and server validation; no new speech backend or runtime catalog fetch. Only
that preference persists in browser storage (`archon.voice.output.v1`); reload still disarms the mic.
Changing it preserves the lease, current capture and conversation, applies
to the next reply, and never cuts an ongoing reply or changes its prefetched
sentences. Sentence playback, prefetch and barge-in use the existing path.
LISTEN auditions a fixed short line with no model call: when off, a bounded
`POST /api/voice/preview` worker creates no voice lease/recognizer; when on,
normal interruptible playback is used after any capture/speech finishes.
Samples report failures rather than silently playing the fallback voice.

### Tool relay and fault recovery

Screen labels/readings are bounded
without splitting UTF-16 emoji pairs. The server also repairs malformed Unicode
at the shared tool-result/error boundary, including its own 16,000-character cap.
The 2026-10-17 failure was a label cut after a high surrogate: JavaScript accepted
the result, but Codex's Rust MCP path waited for its 300-second internal timeout. A direct JS MCP probe
returned it in 23 ms; a real Luna replay stalled for two minutes, then completed
in 5.7 s after repairing the same payload. The model selection was correct.

Codex Computer has an end-to-end watchdog: 90 seconds for silent startup,
60 seconds without generated text/thinking or a real browser-tool round trip,
and a five-minute absolute turn limit. CPU activity, token receipts and code-runner
`wait` calls do not renew it. A timeout fences late tools, resolves pending relays,
replaces only that Computer's provider connection, and cancels dependent queued
requests with a visible notice. The error is spoken when hands-free is enabled.
It never retries the directive or rolls back actions: a dispatched action may
already have happened, so its message says to check before repeating. Saved
threads resume on the next operator request; a lost private thread gets an
explicit full clear, discarding its browser transcript before reuse. Ordinary
Chat, project agents and local-model loads do not use this Codex-only watchdog.

### Context lifecycle

The panel shows the latest input-token count / reported
window and fullness, separately from cumulative usage, plus the last Codex
compaction notice in loaded history. The operator-requested default is a fresh
context at **50% for subscription models (Codex/Claude)** or **75% for local
models (Ollama/Strata)**, using the actual reported/configured window. For example,
828,400 at 50% is 414,200 tokens; 262,144 at 75% is 196,608 tokens. An absent
`resetAtPercent` selects this provider default; existing explicit policies persist.
Choices: OFF / 25% / 50% / 75%; KEEP CONTEXT pauses automatic resets
for multi-request continuity (including an announced dictation). A threshold
only fires at the server's clean boundary after the complete turn and its
follow-up/steering queue finish; it never interrupts tools or a running turn,
and never asks the model to judge completion. CLEAR CONTEXT is manual; while
busy it becomes CLEAR AFTER TURN and persists a pending request. Saved policy and
reset metadata live in `meta.computerContext` and survive restart; Incognito
state lives only in memory. No timer
executes work. Codex's own compaction remains its fallback if a long turn
reaches the provider limit before the clean boundary.

`server/src/voice/computerContext.ts` retires the idle Codex/Native worker, atomically
archives its session id in `meta.history`, clears the active Codex session
ledger and records a visible boundary. The same Arco workflow/transcript is
kept in saved mode; Incognito discards it. The next request has the Computer
prompt and current roster only — no old transcript or summary. Native cold
replay and stateless local replay obey the persisted sequence boundary
(`lastResetSeq`; timestamps are only a legacy fallback). Local
Computer history retains structured tool calls/results, not text-only Done
replies; ordinary Chat replay is unchanged. Local Computer auto-compaction is
disabled in favor of these full resets. A restart before that
request must not resurrect the archived thread. `computerResetting` keeps a
new prompt queued even if STOP releases the busy claim during the metadata
write. `computer_context_control` / `computer_context_updated` are operator
WS controls, not model tools. Proof: `npm run smoke:computer-context` (isolated
server + fake Codex, no paid inference).

### Operator tools

`shared/src/protocol/voiceOperator.ts` defines the tool names;
`server/src/voice/toolDefinitions.ts` owns their schemas and descriptions.
Tools include `archon_condition`, `archon_compact`, `archon_activity`, `archon_mail_rule`, `archon_watch`, `archon_usage`, `archon_computer`, `archon_targets`,
`archon_select`, `archon_open_panel`, `archon_open` (settings / manual /
knowledge…), `archon_open_dialog` (nudge, broadcast, review, handoff, spawn,
plan, docs, git, tuneup, research, transcript — opens, never acts),
`archon_send_message` (steer / follow-up; a cluster target routes to its
single Director), `archon_nudge`, `archon_cancel_turn`, `archon_read_latest`,
`archon_read_recent`, `archon_status`, and the generic layer in
`client/src/voice/screen.ts`: `archon_screen` (every visible control,
numbered and labelled from aria-label / label / text / help title, grouped by
open dialog or area, with state; role-less fixed full-viewport overlays count
as dialogs), `archon_act` (click / toggle / type / select / press / options / focus / hover /
double_click / context_menu / scroll; DANGER
labels need `confirm`), `archon_read_text` (the open dialog's text, or one
section by heading, or passages mentioning a word).

### Source map

| Responsibility | Entry points |
|---|---|
| Browser audio capture and speech segmentation | [`voice-capture.js`](../client/public/voice-capture.js), [`recognizer.py`](../server/src/voice/recognizer.py) |
| Wake/capture boundaries, playback and interruption | [`reservedPhrases.ts`](../client/src/voice/reservedPhrases.ts), [`commandBuffer.ts`](../client/src/voice/commandBuffer.ts), [`runtime.ts`](../client/src/voice/runtime.ts) |
| Intent handling and the shared tool catalog | [`operatorPrompt.ts`](../server/src/voice/operatorPrompt.ts), [`toolDefinitions.ts`](../server/src/voice/toolDefinitions.ts) |
| Approved MCP child and HTTP/browser relay | [`voiceMcpServer.ts`](../server/src/mcp/voiceMcpServer.ts), [`voiceRoutes.ts`](../server/src/http/voiceRoutes.ts), [`executor.ts`](../client/src/voice/executor.ts) |
| Generic screen controls and text reading | [`screen.ts`](../client/src/voice/screen.ts) |
| Agent/context controls and Computer panel | [`computerControl.ts`](../client/src/voice/computerControl.ts), [`computerContext.ts`](../server/src/voice/computerContext.ts), [`ComputerPanel.tsx`](../client/src/components/ComputerPanel.tsx) |
| Conditional grammar, evaluation and guarded dispatch | [`conditionSchema.ts`](../server/src/voice/conditionSchema.ts), [`conditionStore.ts`](../server/src/voice/conditionStore.ts), [`conditions.ts`](../server/src/voice/conditions.ts) |
| Worker facts, restored context/replies and input checks | [`conditionFacts.ts`](../server/src/voice/conditionFacts.ts), [`conditionContext.ts`](../server/src/voice/conditionContext.ts), [`conditionReply.ts`](../server/src/voice/conditionReply.ts), [`inputObservation.ts`](../server/src/voice/inputObservation.ts) |
| Activity, one-shot watches and legacy mailbox rules | [`activity.ts`](../server/src/voice/activity.ts), [`watches.ts`](../server/src/voice/watches.ts), [`mailRules.ts`](../server/src/voice/mailRules.ts) |
| Operator-facing manual and contextual help | [`voice.tsx`](../client/src/help/manualSections/voice.tsx), [`header.tsx`](../client/src/help/content/header.tsx) |

For integration details, see [architecture](ARCHITECTURE.md),
[voice HTTP endpoints](HTTP_API.md#hands-free-voice-apivoice),
[protocol](PROTOCOL.md), [persistence](PERSISTENCE.md#computer-conditional-scripts),
and [voice invariants](GOTCHAS.md#hands-free-voice).
Keep this contract, the in-app manual/contextual help and the
[README overview](../README.md#hands-free-voice) in step when behavior changes.

### Operations and verification

`[voice <sid>]` journal lines carry every client decision
(`POST /api/voice/diag`) and recognizer result; `[voice tool] name args → ok|ERROR
ms` logs every relay. Prod serves `client/dist` from disk: after a rebuild +
restart, open tabs get a yellow RELOAD banner (`client/src/buildCheck.ts`) and
Computer reports "the page needs a reload" instead of "Unknown tool.".
For live diagnostics (private recognition/tool logs remain suppressed):

```bash
journalctl --user -u archon.service -f | rg '\[voice|voice tool'
```

Source edits are not live in production. Deploy only on an explicit operator
request, check active turns before restarting, and follow
[dev vs prod](../CLAUDE.md#dev-vs-prod--read-this-before-editing-source).
Restart interrupts active scripts without replay; it does not re-arm them.

| Check | Coverage |
|---|---|
| `npm run test:voice` | Client/server units, capture, screen tools, relay, scripts, restoration and privacy |
| `npm run smoke:voice-luna` | Real Luna LOW on an isolated server with canned tools: intent, routing, conversation, dictation, scripts and budget edits; normal subscription usage |
| `npm run smoke:computer-conditions` | Isolated canned workers with real turn/mailbox flow: execution, optional limits, human-input holds, compaction, updates, persistence and restart |
| `npm run smoke:condition-input` | Isolated semantic input observation |
| `npm run smoke:computer-activity` | Live facts, full queue boundaries, optional agent updates, batching, tool denial, pause/resume, private clear and restart |
| `npm run smoke:computer-mail-rules` | Legacy mailbox sequences, cancellation, no-history, disk failure, AUTO-PICKUP conflict and restart |
| `npm run smoke:computer-context` | Codex full resets, cold reconnect, private storage boundaries and durable-private handshake rejection |
| `npm run smoke:computer-modes` | Fake Ollama/Strata streams: local 75% boundary, structured tools, clear/replay and private storage/log exclusion |
| `npm run smoke:computer-panel` | Chromium against an isolated Vite fixture: panel/history, numeric/no-limit settings, agent switches, voice choices, theme fonts and zero mic/provider calls |
| `npm run smoke:voice-scroll` | Actual virtualized conversation following after voice selection/send/nudge, with isolated APIs |

For the panel browser fixture, first run
`ARCHON_CLIENT_PORT=5193 npm run dev:client`; its APIs and WebSocket are mocked.
`scripts/voice/check-phrases.py` exercises synthetic TTS → recognizer wake/closing
regressions. Microphone echo and real-room barge-in still need live testing;
the canned model suite does not exercise audio capture.

The real-agent suite accepts `ARCHON_VOICE_PROVIDER=ollama|claude|codex`,
`ARCHON_VOICE_MODEL`, optional `ARCHON_VOICE_PORT`, and
`ARCHON_VOICE_INCOGNITO=1`; default remains Luna LOW. Existing Native Claude
auth is used only as a temporary access-token copy (never refresh production
auth). Real-agent scenarios use canned tools, never real worker/UI actions.

## Historical implementation notes

The following sections retain earlier implementation and research details.
Use the [current contract](#how-computer-works-today-2026-10-17--read-this-first)
above for present behavior, tools and limits.

**Shipped and deployed (2026-10-16).** Voice controls the open
Arco window. It is off on every load and requires an explicit operator gesture.

## Enable and disable

Run `npm run voice:setup` once. It installs a private Python 3.12 environment,
CPU-only sherpa-onnx and Vosk, a small English reserved-phrase model, an English
Moonshine fallback, the preferred Linux Parakeet v3 INT8 transcription model, and Kokoro British
female speech-output voices under `~/.archon/voice`. Emma is the offline default;
the microphone test page can audition Emma and Isabella without enabling its
microphone. An existing Piper installation remains a fallback when Kokoro is
absent. `uv` is required for installation.
`ARCHON_VOICE_HOME` can select a different asset directory. Installation starts
no listener, microphone capture or model service.

Setup on Linux, macOS and Windows: `npm run voice:setup` runs
`scripts/voice/run.mjs`, which starts `scripts/voice/setup.py` through
`uv run --python 3.12`, so no system Python is required; uv downloads a Python
3.12 runtime when none is present. The voice home is `ARCO_VOICE_HOME`, then
`ARCHON_VOICE_HOME`, then `voice` inside the Arco home (`ARCO_HOME`, then
`ARCHON_HOME`, then `~/.archon`, which is `%USERPROFILE%\.archon` on Windows).
The venv interpreter is `venv/bin/python`, or `venv\Scripts\python.exe` on
Windows. Each model archive is downloaded from its upstream release and
checked against a SHA-256 pinned in `setup.py`; a mismatch stops the install
before anything is unpacked into the voice home. Parakeet v3 is skipped on
Windows, where the recognizer keeps Moonshine. Every run prints and rewrites
`NOTICES.md` in the voice home: each model with its license, upstream source
and checksum, plus every Python package in the voice environment with the
license it declares. Arco downloads these components at the operator's request
and does not redistribute them. Re-running the command skips models already
present. About 1 GB is downloaded on a first Linux or macOS run.

Open **VOICE OFF** in the header and choose **ENABLE
HANDS-FREE**. Allow microphone access. The page must use localhost or HTTPS.
`Ctrl/Cmd+Shift+Space` also toggles the mode. The indicator remains visible in
focus mode. The controls show status, dictation recipient, errors and live
Luna usage. Spoken feedback and unfamiliar-command interpretation can each
be disabled independently.

**DISABLE · MIC OFF**, “Computer, stop listening”, page close/reload, microphone
loss or an Arco WebSocket disconnect stops the microphone and session.
Re-enabling requires a button or shortcut: the off state does not listen for
a wake word. Voice status occupies a compact row beneath the workflow tabs, reserving its
own space rather than covering the workspace. DETAILS expands settings and
diagnostics within that layout; LESS collapses them. Enabling collapses
details automatically. Disable, Quiet and pending-capture controls remain in
the strip. Closing details alone does not disable an armed mode.

## Everyday workflow

1. “Computer, open Atlas cluster. End capture.”
2. “Computer, show member two. End capture.”
3. “Computer, open activity. End capture.”
4. “Computer, message this worker. End capture.”
5. Dictate the message without a command prefix; pause and think as needed.
6. “Computer, finish message. End capture.”
7. “Computer, read draft. End capture.”
8. “Computer, send now. End capture” or “Computer, send as a follow-up.
   End capture.”

Say **Computer** as the first word. It can stand alone: wait for the computer
acknowledgement and green **CAPTURE ARMED** indicator, then take up to two minutes before
giving the first instruction. Continue speaking through pauses; each recognized
phrase renews that two-minute allowance. The text remains a visible pending
directive. Silence expiry discards it and returns to waiting for Computer;
it never submits anything.

Say **End capture** to stop collecting and submit the complete directive, or
**Cancel capture** to discard it. These are reserved whole phrases at the end
of the captured speech. They may be in the same audio segment or a later one,
including split across segments. Words such as end, cancel, capture and execute
by themselves are ordinary text. No parsing, Luna call, navigation or send
happens before End capture. Computer is a wake word only while idle. Once
capture is armed, later uses of computer are literal text, including at the
start of another ASR segment; they do not reset text, play another
acknowledgement or rebind the starting selection. Quiet/off retain their
explicit global interruption behavior. Cancel capture, End capture and the
idle timeout end the current capture; a subsequent Computer can arm a new one.

The local Vosk streaming phrase detector checks 40 ms PCM chunks and can acknowledge
Computer before the full recognizer waits for its 350 ms silence endpoint.
This acknowledgement uses a provisional first-word hypothesis; final
recognition and the capture buffer still gate every command. The full acoustic
grammar includes hey/a/the Computer and unknown speech, so preceding words are
retained rather than treating a later mention as a wake word. The full overlapping
audio remains intact, including words spoken immediately after Computer.
The detector scans only the opening three seconds of an utterance, stops while
capture is active or feedback is playing, and consumes no subscription quota.
Missing/failed wake detection falls back to ordinary full recognition. The
acknowledgement chime plays only once the full transcript has verified
Computer as the first word (the fast wake's grammar guessed "computer" for
"Thank you" live), so it arrives about half a second after the word. The
general recognizer often writes a spoken Computer as "Computers", "Commuter",
"Computed" or "Come here"; the first word is accepted when it is one edit from
"computer", or within three edits (two fused tokens allowed) when the phrase
grammar or the fast wake also heard Computer first. A preamble ("Hey
Computer") still does not wake. When verification fails, the Last heard line
shows both the transcript and what the phrase grammar heard. The
TNG buffer is preloaded, normalized to an audible level and played before the
UI state update, using an interactive AudioContext. Bluetooth output buffering
can still add delay after the browser schedules playback.

A separate final phrase hypothesis accompanies raw Moonshine text. Only reserved
boundaries may be repaired: an independently verified opening Computer can
remove a hallucinated A/The prefix; an armed command can accept terminal
And capture when the acoustic grammar independently recognizes End capture.
An empty general transcript can use a verified standalone Computer or an
armed standalone End/Cancel capture. The body stays verbatim, including later
Computer and ordinary unarmed dictation. No generic And capture alias exists.
Last heard shows raw → corrected text; these diagnostics remain memory-only.
The reduced vowel in spoken end/and may be acoustically indistinguishable;
this is contextual reserved-phrase recognition, not perfect vowel separation.

Case and colon/comma punctuation are
accepted; “Arco”, “hey Computer” and mentions of Computer later in a sentence
do not arm commands or invoke Luna. Recognition of that prefix is local;
ambient utterances outside pending commands/dictation are discarded. Unprefixed
speech continues a pending command when one is armed; otherwise, during
explicitly started dictation, it becomes draft text and cannot execute a command.
Speech endpointing splits audio into segments but never submits a command or
workflow message. Only “Computer, quiet” and “Computer, stop listening” act
immediately; cancel also clears a pending command without execution.
The recipient stays
fixed during dictation even if the operator changes the visible pane. A
selection change while a command is pending or being recognized/interpreted invalidates that
command rather than redirecting it. Removed targets and disconnects preserve
the draft and refuse the send.

### Single-word closings (2026-10-16)

The operator found “End capture” too cumbersome in natural speech. A capture now also
closes on a **standalone** word: pause, then say **over** (alternates:
**execute**, **engage**, **make it so**) to submit, or **cancel** / **belay
that** / **never mind** to discard. The rule is deterministic:
the word counts when it is the *entire* recognized phrase
(`standaloneClosing()` in `commandBuffer.ts`), and — for **over** only — when
it is the last word of a phrase (“open the plan, over”; `trailingSubmit()`,
added 2026-10-17 because the operator does not pause before it). “over there” or
“execute the tests” inside a directive stay literal; a directive whose final
word is literally “over” submits there, a trade-off accepted knowingly. The Vosk phrase
grammar lists the words so a lone “Oval.” from the general recognizer with
grammar agreement on “over” is repaired. “Computer, over” ends empty. “End
capture” / “Cancel capture” keep working anywhere at the end of the text, and
the END/CANCEL CAPTURE buttons are unchanged. With nothing armed, a lone word
is ambient speech and does nothing.

## Commands

> These are capabilities, not keywords. Everything after "Computer" goes to the
> Computer chat as free text; Luna matches names against the open tabs
> (phonetic spellings and spoken punctuation included) and acts through tools.

Submit each ordinary command below with “End capture”. The END CAPTURE
button is an equivalent explicit submission. Quiet/off are immediate;
Cancel capture only discards pending text. The buffer is memory-only, bounded
to 8,000 characters, and cleared on disable/disconnect/close.

| Say after arming with “Computer” | Effect |
| --- | --- |
| `end capture` | Close capture and submit the complete directive exactly once |
| `cancel capture` | Close capture and discard the pending directive |
| `open <name>` / `open <name> cluster` | Select workflow, chat or cluster |
| `show member two` / `show <name>` | Select a cluster member or named workflow |
| `open activity` / `open plan` / `open config` | Open a supported right-panel tab |
| `go back` | Restore the previous voice navigation selection |
| `message this worker` / `message <name>` | Start dictation into that workflow's existing draft |
| `finish message` | End dictation without sending |
| `read draft` / `read that back` | Speak the draft and its recipient |
| `send now` / `send message` | Send the draft; active workers receive steer input where supported |
| `send as a follow-up` / `send after this turn` | Send after the worker's current turn |
| `scratch that` | Remove the last sentence of the draft |
| `new paragraph` | Append a paragraph break |
| `replace <old> with <new>` | Replace one unique matching phrase |
| `literal <text>` | Append exact text while dictating, including words that resemble commands |
| `discard draft` | Clear draft text |
| `nudge <member>` | Send the shared idle/active mailbox reminder through normal chat |
| `read latest response` | Speak latest assistant text; code blocks are omitted and long replies capped |
| (status, progress, "what's going on", "is it stuck") | No fast path: Computer reads the project through `archon_read_recent` and answers in its own words |
| `call this <alias>` | Assign a temporary spoken alias |
| `choose two` | Resolve the current spoken ambiguity list |
| `scroll up/down/top/bottom` | Scroll the visible conversation |
| `open settings/manual/recall` / `open new workflow` | Open existing workbench surfaces |
| `open focus mode` | Toggle focus mode |
| `cancel <worker>` | Cancel a worker with no queued messages; queued work requires the ordinary cancel UI |
| `quiet` / `stop reading` | Interrupt speech playback |
| `stop listening` | Disable hands-free entirely |
| `help` | Open help and speak a short acknowledgement |

Names resolve to live stable IDs; current-cluster names/roles take precedence.
Ambiguous names produce numbered choices, never an automatic best guess.
`member one`, `member two`, etc. refer to the current roster order. Preset role
aliases such as `builder one` are also supported. Qualify a name with
`reviewer in Atlas` to address another cluster. Aliases are held in memory.

Recognition captured during speech playback: a bare "stop" / "quiet" (or
"stop listening") acts; anything else without the name is dropped, so
read-out responses can never navigate or send; "Computer …" cuts playback
and is handled as an ordinary directive (see § Interrupting Computer at the
top). A headset and microphone echo cancellation improve recognition while
audio is playing.

## Quota and privacy

Recognition runs locally on CPU; audio stays in memory. Every submitted
Computer directive, question and dictation goes to the selected agent, except
immediate mic controls and canceled/empty captures. Codex/Claude use existing
subscription authentication; Ollama/Strata use their configured endpoints.
Online speech sends reply text to Microsoft; Kokoro is the local fallback.

Saved mode keeps Computer's ordinary transcript and logs diagnostics/tool
relays. No history is the strict Incognito branch described at the top: memory
only, no voice text diagnostics or provider session file, discarded on clear,
switch or page/service lifetime end. Provider-side cloud retention is outside
Arco's disk policy. Sending to a worker creates its ordinary message history.
Strata cannot honor strict Incognito and is refused rather than downgraded.
Only non-content agent/output preferences persist. Closing/reloading disarms
the microphone; it is never restored armed. Explicit audition scripts save only
their fixed sample audio under `~/.archon/voice/audition-logs`.


## Architecture and lifecycle

- `shared/src/voice.ts`: command allowlist, bounded context and runtime validator.
- `client/src/voice/commands.ts`: deterministic parsing and target resolution.
- `commandBuffer.ts`: first-word Computer gate, accumulation across pauses and
  explicit execution; shared by the live runtime and microphone test.
- `executor.ts`: existing app/draft store actions and normal chat senders.
- `runtime.ts` + `public/voice-capture.js`: explicit microphone ownership,
  CPU audio endpointing with an adaptive room-noise floor, epoch cancellation,
  speech playback and input queue. A live meter and the single latest heard
  phrase are memory-only and cleared on disable. Recognition and speech output warm before
  LISTENING; there is no spoken startup tutorial masking an immediate Computer.
- `speech.ts`: sentence/phrase-aware speech chunks, preserved punctuation and
  abbreviation/decimal handling; one-sentence prefetch and punctuation pauses.
- `store.ts`: non-persisted live state; `panels.ts`: typed panel request bridge.
- `modes.ts` + `conversation.ts`: global spoken mode switches, projectless
  Computer Chat, remembered control selection and bounded response readback.
- `reservedPhrases.ts`: bounded acoustic agreement for reserved-word repairs.
- `VoiceControl.tsx`: compact layout strip, expandable settings, shortcut and
  disconnect cleanup; no floating overlay.
- `server/src/http/voiceRoutes.ts`: authenticated, origin-gated HTTP endpoints.
- `server/src/voice/`: leased sessions, isolated Codex interpreter and CPU
  recognizer/output processes. No workflow registration or persistence cwd.

Session leases expire after 45 seconds without a heartbeat; the enabled page
renews every 15 seconds. Deletion aborts interpretation, kills speech processes
and invalidates the lease. Web Locks prevent duplicate microphone ownership
within the same browser origin where supported (Arco also has a main-tab
single-instance guard). The client invalidates its epoch before closing
tracks/connections so delayed permission grants, audio, model responses and
speech synthesis cannot execute after disable. At most two windows can own
sessions on one server. No service or OS-wide listener is installed.

## Recognition and latency follow-up (2026-10-16)

**Deployed 2026-10-16 23:00 CDT** (together with the capture-state fixes
below) after the operator confirmed the last cluster worker had finished.
Run `npm run voice:preview` and open `http://127.0.0.1:5194/` for the updated
standalone microphone test with explicit enable and no worker effects/Luna calls.

Parakeet v3 INT8 replaces Moonshine tiny on supported Linux installs after
`voice:setup`; older installations and Windows retain Moonshine. Both ASR and
Kokoro prepare while enabling, so the first response does not cold-load TTS.
The worklet uses 350 ms endpoint silence, a quieter onset threshold, 400 ms
pre-roll and a short room-noise calibration. Segments remain buffered through
pauses until End/Cancel capture; shortening endpoint silence never submits a
partial directive. A failed recognition request cancels the pending capture.

A trailing acoustic-grammar window helps recover closing phrases missed after
long directives. It only supplies reserved-boundary metadata; it never rewrites
the captured body. Direct navigation and combined project updates avoid Luna.
Luna still uses one fresh ephemeral low-effort turn when interpretation is
needed; completed results no longer wait for CLI shutdown. No background
model inference or quota-consuming speculative requests are introduced.

DETAILS shows the recognizer, last segment's endpoint and recognition times,
interpretation time (or direct/no model call), and time to first speech audio.
All are memory-only.

**Capture-state review (2026-10-16, second pass).** Three gaps found while
reviewing the handoff's capture-state concerns, all fixed and covered by unit
and browser tests:

- *Noise floor learned from near-threshold speech.* The idle floor tracker was
  a symmetric 135 ms EMA, so breath/lip noise just under the onset in the half
  second before a word raised the onset above ordinary quiet speech. Synthetic
  samples with digital silence between words never showed it. The tracker is
  now asymmetric with time constants (50 ms down; 1.3 s up while idle, 2.5 s
  up inside a segment, capped at 0.006 there) and runs inside segments too, so
  steady fan noise that starts after enable is absorbed within a few seconds
  instead of holding one segment open to the 22-second cap. The 160 ms enable
  calibration is unchanged: it must absorb steady noise above the threshold,
  and the capture node is only created after model warm-up, so speech inside
  that window is not a realistic case. Not a measured claim for the operator's room.
- *END/CANCEL CAPTURE buttons during in-flight audio.* A click used to submit
  the buffer immediately while the last phrase could still be waiting for
  endpoint silence in the worklet or in flight to the recognizer, executing a
  directive without its final words. The runtime now posts `flush` to the
  worklet, which delivers any held speech as a segment and then confirms; the
  control queues behind every pending segment and only then runs. With nothing
  armed a click is a no-op (it cannot dictate the phrase). The spoken closing
  phrase needs none of this because it is itself the last segment.
- *Blank transcripts during capture* were silently dropped. They now show
  "(nothing recognized)" and a repeat prompt while leaving the directive
  untouched; only End/Cancel capture closes it. A blank *middle* segment
  followed by a recognized End capture still submits what was heard, so the
  visible pending text remains the operator's check before the closing phrase.

DETAILS and the standalone preview also show the input peak, learned floor and
speech onset (thousandths of full scale) so a quiet word that never crosses the
onset is visible rather than inferred. Synthetic quiet/faster phrases measured 73–125 ms for the
complete Parakeet-plus-grammar path on this host. A live Luna routing probe
measured 3.27 seconds; network/model latency remains variable. The complete
isolated browser pipeline also passed normal and faster/quieter speech at 12%
gain, retaining a ten-second initial pause and opening Plan only after the
closing phrase. Browser recognition requests measured 49–63 ms after 352 ms
endpoint silence, with no Luna call and no page errors. Evidence:
`/tmp/archon-voice-user-test-49pgwqfn/parakeet-browser-1-result.json` and
`parakeet-browser-0.12-result.json`. All 49 voice tests, five HTTP smoke steps,
browser lifecycle/routing checks, help checks, workspace typechecks and isolated
shared/server/client compilation passed. Synthetic sample results do not
establish accuracy with the operator's speech.

## Verification and current limits

For a standalone real-microphone check, run `npm run voice:preview`
and open `http://127.0.0.1:5194/`. This standalone loopback test uses the same
capture worklet, local recognizer, command buffer and direct-command parser. Enable its
microphone explicitly, speak, and pause for a second. It displays only the
latest phrase, pending command, submitted command match and recognition latency; commands have no
workflow effects and never invoke Luna. Stop, close or reload to disarm it.
Speech sensitivity can be changed live between Normal, Quiet voice (default)
and Very quiet voice. Quiet voice halves the original detection threshold;
a lower release threshold preserves soft word endings. Very quiet voice can
also pick up more background noise.
The preview starts no Arco workflow server and does not touch production.
Real sample recognition and fake-device browser enable/stop/reload checks
passed on 2026-10-16; the operator's actual microphone accuracy remains to be assessed.

- `npm run test:voice`: parsing, targeting, draft/recipient invariants, late
  responses, playback restrictions, leases, limits and interpreter isolation.
- `npm run smoke:voice`: isolated source server, Native workflow, deterministic
  Codex fixture, real local sample recognition/output, history/log absence and
  expired-session refusal. Requires `npm run voice:setup`.
- `python3 scripts/smoke/voice-browser.py`: isolated Vite (`:5193` by default),
  actual fake-device browser microphone/worklet lifecycle and stubbed API/WS;
  navigation, pinned dictation, normal follow-up send, live usage, late
  permission/results, disable and reload. No production workflows are touched.

Verification on 2026-10-16 passed: all 44 unit tests, all five isolated server
smoke steps, browser acceptance with a fake microphone, workspace typechecks,
help/documentation checks, and shared/server/client production compilation to
`/tmp/archon-voice-build.R6DmBt`. That staged verification left the production build and service untouched;
The operator subsequently authorized deployment once workers finished. The browser check also verifies that another
window cannot claim the microphone while the first window owns it.

Production was then built and archon.service restarted on 2026-10-16. Health
returned live; the real production browser loaded the voice controls, streaming
worklet and TNG WAV with localSpeech/fastWake available, no page errors, and
zero microphone requests before enable. Refresh an existing page after deploy.
Follow-up Computer/End capture checks also passed: pending commands survive
multiple audio segments and pauses, cancellation/disable clears them, no Luna
request precedes execution, starting selection cannot change underneath a
pending command, and repeated execution cannot repeat the action. Local sample
recognition and Kokoro voice generation passed without cloud inference; the
preview's pending/submitted UI passed in a browser. The closing-phrase
recognition limitation below remains distinct from those state-machine checks.

The implemented version covers navigation, composing/correcting/sending,
mailbox nudges, readback, status and basic workspace controls. Voice-specific
structured-question/approval forms, task/plan mutations, Review/Handoff/Spawn
configuration, direct document editing and numbered arbitrary-control overlays
remain follow-on work. Opening those panels is supported; their action forms
are not silently activated by an interpreter command. No general shell,
delete, Git push or deploy action exists in the voice command allowlist.

The local recognizer is English, uses a microphone threshold (adjustable in the test page) and requires
testing with the operator's own microphone, accent, room noise and real project
names. Synthetic/sample audio and browser fixtures establish pipeline behavior,
not a claim of measured recognition accuracy for the operator's microphone.

General transcription can render End capture as And capture,
including with synthetic Piper speech. The independent final Vosk phrase grammar
now permits the bounded correction described above. Recognition still needs
operator testing with actual speech and noise. The END CAPTURE button remains
an explicit fallback; a sample test does not establish microphone accuracy.

The original implementation used an optional local `~/.archon/voice/computer-ready.wav`.
The operator's former sample was TNG “Ready for input 1”
(0.852 seconds), restored by [Star Trek Dimension](https://stdimension.org/MediaLib/computere.htm).
Original sound copyrights remain with their respective holders. The sample
and attribution are local assets rather than repository-distributed media.
The selected bundled Soft double pulse now replaces it (current contract above).
An unavailable cue still leaves the visual capture acknowledgement and a notice.

The local voices are Kokoro synthesis reading Luna text, not Luna producing
native audio. Sentence-aware playback improves the local path but does not
establish lifelike conversational quality. Native Codex voice remains research,
not enabled. The installed Codex 0.163.0 successfully listed realtime voices. A bounded
subscription-auth integration probe then failed with "realtime conversation
requires API key auth"; no audio session was established. No API-key fallback
is enabled. Official
[ChatGPT Voice documentation](https://learn.chatgpt.com/docs/features/voice)
describes GPT-Live managing voice while the selected task model handles work.
[Pricing](https://learn.chatgpt.com/docs/pricing#how-much-does-voice-cost) states
$0.05/minute from the existing Codex budget plus task-model usage; credit-based
usage is 1.25 credits/minute. Desktop subscription voice is not established as an embeddable Arco
transport. Any future integration must preserve the explicit Computer/End capture
boundary, enforce a strict usage cap and retain the same privacy limits.

The initial streaming Zipformer detector was replaced after operator feedback
with [Vosk's small English model](https://alphacephei.com/vosk/models). Its
restricted grammar retains unknown/prefix speech and exposes fast partial
hypotheses; partial word timestamps are deliberately disabled because they
wait for stable words and add substantial delay. Final phrase recognition
confirms reserved boundaries alongside general transcription. All inference
runs locally, without a subscription or speech API charge.

`~/.archon/voice/venv/bin/python scripts/voice/check-phrases.py` generates fixed
synthetic speech in memory and checks normal plus faster/quieter Computer,
prefix/later-mention rejection, End/Cancel capture and a directive with the
closing phrase. No microphone, audio files or provider calls. This complements
the runtime/browser tests rather than measuring the operator's microphone.

After the wake-path changes, a full browser check against the isolated :5195
build fed synthetic Piper “Computer” through a fake microphone, the real
worklet, real local ASR and capture buffer. It armed capture and played the
0.852-second TNG sample, with no startup TTS or Luna call, then disabled cleanly.
The initial Zipformer streaming check played the acknowledgement 508 ms before the
full-ASR request for standalone Computer, and 1414 ms before the request for
Computer open the plan. The latter retained the complete directive, emitted
one acknowledgement and accepted manual End capture, with zero Luna calls.
These are pipeline timings for synthetic speech, not a human wake-latency
measurement. Evidence: `/tmp/archon-voice-user-test-49pgwqfn/fast-wake-check.py`
and `fast-wake-initial-result.json` in the same directory. This validates
the actual audio path for that sample, not the operator's microphone accuracy.

After the Vosk/layout update, the actual browser fake-microphone pipeline
completed Computer, open the plan, End capture and opened the Plan pane, with
no Luna call. Production verification also passed: one TNG sound 977 ms before
the full-ASR request, final phrase metadata, a 33 px strip whose bottom exactly
meets the workspace top, and no browser errors. Evidence in the same temporary
directory: `closing-result.json`, `compact-voice.png` and
`production-fast-wake-result.json`. These checks use synthetic speech, not
recorded operator audio. Full build/restart deployed the update on 2026-10-16.

## Voice audition (2026-10-16)

**2026-10-17 acknowledgement auditions.** The operator wanted an almost
inaudible macOS-like UI tap rather than a chime or the TNG effect. Three
original, non-tonal filtered-noise transients are available locally under
`~/.archon/voice/audition-logs/edge-comparison/quiet-taps/`: soft tap (55 ms),
dry tick (35 ms), muted thup (75 ms), plus an `index.html` comparison with
volume control, served by the existing :5196 audition server. Peaks are
0.065/0.050/0.075; no borrowed macOS recordings. No application behavior
changed at that stage. The old `runtime.start` boosted the TNG sample toward
0.65 peak (up to 4×); the selected integration below removes that normalization
so the subtle replacement retains its audition level. Wake verification and
capture timing stay the same.

The operator rejected the taps as too click-like: the sound must be recognizable as
"capture is ready". A second audition, `scripts/voice/audition-capture-cues.py`,
generates rounded rise (180 ms), airy rise (200 ms), and a soft same-pitch
double pulse (230 ms), with smooth onsets/offsets instead of a hard click or
bell tail. `--serve` opens a standalone comparison on :5197; the current
comparison is also at `http://localhost:5196/capture-cues/`. Original synthesis,
no model/service. Waveform-edge and browser playback checks passed.

**Selected: Soft double pulse.** The operator chose this cue. The bundled 230 ms,
48 kHz mono PCM16 WAV uses two cushioned 470 Hz pulses, with the audition's
default 65% level baked in (peak 0.065). Export it reproducibly with
`python3 scripts/voice/audition-capture-cues.py --export-double-pulse server/src/voice/capture-ready.wav`.
The server build copies it alongside `recognizer.py`; the existing ready-sound
route serves it without local installation or a model call. Runtime playback
uses the authored samples directly; the old TNG normalization and 0.8 gain
stage are removed. Playback remains gated on verified wake and never delays
following speech. Deployed on the operator's restart instruction at 17:30 CDT;
production delivery verified byte-for-byte at 230 ms / peak 0.065.

**2026-10-17 update.** The operator prefers preserving conversational flow over a
TNG clone and asks for a soothing woman's voice, without an accent requirement.
The in-app Reply voice picker above uses the existing Edge path. A standalone
comparison is also reproducible with
`~/.archon/voice/venv/bin/python scripts/voice/audition-edge.py --serve`:
Jenny/Ava/Clara/Michelle and current-default Sonia, with short and conversational
samples, MP3 plus timing metadata and a local listening page on :5196. No mic,
GPU, model call, activation or service restart. First check (10 calls): short
sample generation 0.64–2.25 s; longer 1.24–2.77 s. These are individual online
measurements, not a latency guarantee. TNG cloning trials were stopped before
generation; the existing production voice and all conversation logic stayed.
The notes below describe the earlier GPU experiments, not the live speaker.

The operator finds the Kokoro British voices (Emma, grade B-; Isabella, grade C in
Kokoro's own voice table) too robotic. The preview page's **Voice audition**
now compares them against two local GPU engines, each in its own venv under
`~/.archon/voice/` so the production voice venv is untouched:

| Option | Engine | venv | Needs |
|---|---|---|---|
| Chatterbox · built-in voice | Resemble Chatterbox (MIT) | `venv-chatterbox` (Python 3.11, torch cu128) | nothing |
| Chatterbox · TNG computer clone | Chatterbox, `audio_prompt_path` | `venv-chatterbox` | `reference/tng-computer.wav` |
| Qwen3-TTS · designed British female | Qwen3-TTS 1.7B VoiceDesign (Apache 2.0) | `venv-qwen` (Python 3.12, torch cu128) | nothing |
| Qwen3-TTS · TNG computer clone | Qwen3-TTS 1.7B Base, `generate_voice_clone` | `venv-qwen` | `reference/tng-computer.wav` + `.txt` transcript |

`scripts/voice/audition.py` is the one-shot generator (model load per call;
the timing header separates load from generate so the GPU-under-mining cost is
visible). Models download from Hugging Face on first use. The TNG computer
voice (Majel Barrett) is cloned only from a clip the operator places locally;
like the acknowledgement sample it is personal-use media and is never bundled
or committed. The operator mines on the GPU continuously: VRAM is not the constraint
(both engines fit in a few GB of 32 GB) but compute is time-sliced with the
miner, so generation latency is measured under that load, not idle.

First measurements (2026-10-16, SRBMiner holding the GPU at 100%, models
already downloaded): Chatterbox loaded in 10.9 s and generated 6.4 s of speech
in 6.6 s (about real time); Qwen3-TTS 1.7B VoiceDesign loaded in 5.7 s and
generated 8.6 s of speech in 26.8 s (about three times slower than real time).
Both are quality auditions, not live-feedback latencies. Under the miner,
Chatterbox is the only one near real time; Chatterbox Turbo and the Qwen 0.6B
variant are the untested faster options. Generated samples are cached in
`~/.archon/voice/audition-logs/<voice>.wav` (+ `.json` timing) and replayed by
the preview; **Regenerate** makes a fresh one.

Warm short-reply benchmark ("Opened the plan.", three calls in one process,
miner at 100%): Chatterbox cloned from the Qwen TNG sample 8.5 s cold then
**1.0–1.1 s** warm for 1.4 s of audio; Qwen 1.7B 6.5 s then 5.4 s and it ran
to the length cap (4.1 s of audio for a 1.4 s phrase); Qwen 0.6B 10.8 s then
2.8–4.1 s, also past natural length. Uncapped, the Qwen 1.7B clone once
produced 655 s of babble for that phrase (no EOS); `audition.py` now caps
`max_new_tokens` by text length. Conclusion: under the miner Qwen is neither
fast nor reliable on short text; Chatterbox warm is about one second per short
reply. The operator prefers the sound of the Qwen TNG rendering, so the live plan is
Chatterbox resident, cloned from Qwen's rendering (`audition-logs/qwen-tng.wav`
as `audio_prompt_path`, exaggeration 0.3 / cfg 0.4), plus a phrase cache of
Arco's fixed control strings pre-rendered once by Qwen itself.

Idle-GPU warm benchmark (miner off, same phrase, three calls): Chatterbox
2.3 s cold then **0.42–0.46 s**; Chatterbox Turbo 1.3 s cold then **0.21 s**;
Qwen 1.7B 5.0 s cold then 1.9 s, and still ran to the cap (4.1 s of audio for
a 1.3 s phrase). Turbo is about five times faster than standard Chatterbox
and the only engine measured under 0.25 s per short reply; it needs a
reference clip (no built-in voice). Variants auditioned for the accent drift
The operator heard in the Chatterbox-from-10-s-Qwen-sample clone: standard Chatterbox
from the show clips with flatter delivery (exaggeration 0.3 / cfg 0.3), from a
31 s Qwen-rendered reference (`reference/tng-computer-qwen-long.wav`), and
Turbo from each of those references.

**Why Qwen ran away, and the fix (2026-10-16, idle GPU).** The runaway is
specific to in-context cloning from the *stitched show-clip* reference (ten
separate lines with gaps, 22.5 s): "Opened the plan." produced 12–32 s of audio
every time. Two prompt modes stop correctly and are fast: in-context cloning
from Qwen's own 31 s rendering (`reference/tng-computer-qwen-long.wav`):
0.5 s for a short reply, 1.4 s for a 3 s sentence; and speaker-embedding-only
mode (`x_vector_only_mode=True`) from the show clips: 0.5–0.6 s / 1.7 s.
`non_streaming_mode=True` (whole text up front instead of simulated streaming
text input) also bounds the show-clip mode (2.2 s for the short reply, still
over-long audio). The live speaker therefore uses full-text mode, one of the
two fast prompt modes (the operator's ear decides between `qwen-tng-long` and
`qwen-tng-xvec` on the preview), the per-text token cap, and a resident
model. Chatterbox is dropped from the live plan: every Chatterbox clone of the
Qwen rendering drifted in accent, because it imitates a speaker embedding
rather than replaying a voice.

The audition only produces samples. Adopting an engine for live feedback means
a resident worker (model loaded once per voice session, as the Kokoro
`LocalRecognizer(true)` child is today), sentence-chunked streaming and a CPU
fallback when the GPU is unavailable; that is follow-on work after the operator picks a
voice.

## Spoken Computer conversation

**Implemented.** The mode indicator says ARCHON CONTROL
or COMPUTER CHAT. Both modes accept these global switches, with no extra Execute:

- “Computer, let's talk about my question. End capture” enters conversation and
  sends the first question in the same capture.
- “Computer, let's talk. End capture” resumes conversation without sending.
- “Computer, let's spitball about … End capture” and “let's brainstorm” enter the
  same conversation mode, keeping discussion separate from project actions.
- “Computer, back to Arco. End capture” restores the previous workflow/cluster
  and focused member, preserving all drafts.
- “Computer, back to Arco, switch to PS5. End capture” returns and runs the
  following command in one capture.

In conversation, subsequent Computer-prefixed captures go directly to the same
projectless `Computer` Chat using Codex Luna low, without an interpreter call.
Even text resembling a control command is conversation until the explicit
return phrase. Quiet/off remain global and immediate. Capture/closing rules
remain identical in both modes. Readback waits for a new settled assistant
answer from that chat, is bounded to two minutes, and is cancelled on disable
or return to control. Speech waits while another directive is being captured.
During playback, say Computer quiet first to interrupt before a mode switch.

Chat creation uses the existing `create_workflow` path with `kind:'chat'`, no
project cwd, web disabled initially, and normal Chat tool isolation. No new
protocol messages or provider permissions. A late creation cannot send a
question after disable. A removed/changed chat, changed selection, busy chat
or staged attachments refuses the send. Duplicate matching Computer chats
require the operator to close/rename one; the voice layer never guesses.

Unit checks cover spoken switch-plus-request, no routing calls in conversation,
preserved worker drafts/cluster focus, same-chat reuse, late creation after
disable, and new-answer readback cancellation. Browser acceptance exercised
the actual App/create-workflow/send path with a fake microphone and stubbed WS,
both directions, a combined return command, same-chat reuse and visible mode.
These checks do not establish real speech recognition accuracy.

## Natural intent routines — implemented subset and next design

**Project status goes through Computer (2026-10-17).** The earlier
deterministic "switch to X and tell me where we're at" routine (a canned status
prompt plus spoken readback) was removed. Voice replaces the mouse and
keyboard: "Computer, switch to ORBIT and find out what's going on, over" makes
Computer select ORBIT and type the question to its Director in the operator's words;
the Director's answer appears in the window and nothing is spoken (Computer
replies `Done.`, which the client swallows and shows as status). Computer
speaks only to ask back ("Which builder: Opus Builder or SOL Builder?"), to
report a tool error, or to answer a question aimed at itself — general
knowledge, or a glance at the workspace through `archon_read_recent`
(working/idle and since when, current tool, queued messages, plan, mailbox,
last few messages): "is GroundTruth busy?" → "Yes, about seven minutes".
`archon_status` is the one-line busy/idle check and `archon_read_latest` is
"what did it say". Spaced names such as Fire light and P S five still match
Firelight and PS5 without fuzzy guessing.

The remaining rows below are design work unless explicitly described as shipped.
The current interpreter returns one action. This extension needs
bounded action sequences, verbatim drafts, clarification and manual-aware
how-to assistance. Spoken Computer conversation above is implemented separately.
This extension remains separate from the authorized core deployment.

End capture is the submission boundary: there is no additional Execute step.
It submits an intent, which can mean navigation, preparing draft text, sending
when explicitly asked, answering a question, or requesting clarification.

| Captured request | Intended outcome |
| --- | --- |
| Switch to PS5 | Select that live workflow/cluster; send nothing |
| Switch to Firelight and tell me where we're at | Computer selects Firelight and types the question to its worker (cluster: Director); the answer appears in the window, nothing is spoken (shipped 2026-10-17) |
| Please do a git pull on this project | Put the exact captured text in the current workflow's composer (cluster: director); keep it as a draft |
| Tell the PS5 director to do a git pull | Route an explicit message through normal worker chat; Luna never runs git itself |
| Let's talk about a question outside Arco | Enter the dedicated Computer Chat and ask the question |
| How do I use a feature in Arco? | Answer using bounded, relevant manual excerpts; do not operate the feature |
| Back to Arco, switch to PS5 | Leave Computer conversation, select PS5 in the same voice request |

The two modes are visible **CONTROL** and **CONVERSATION**. Global spoken
switches such as “Computer, let's talk about … End capture” and “Computer,
back to Arco, … End capture” include the first request, so no click or
separate mode-change turn is needed. “Ask/tell the PS5 director …” is explicit
worker routing. A how-to question stays a question. Ambiguous intent causes a
clarification, never a guessed send or target.

Control mode uses one Codex-subscription Luna low-effort interpretation per
completed natural-language capture, with a small stable schema and live roster
only. No calls while waiting, speaking or pausing; no effort escalation or
automatic retry. Replace the one-action result with an allowlisted plan of at
most four steps (navigate, select member/panel, prepare verbatim draft, explicit
send, request status, read, enter conversation, clarify). Resolve and validate
the complete plan against live IDs before applying any step. Preserve exact
message text as a validated span of the captured utterance; do not let the
interpreter silently rewrite it. Routine status questions can use a fixed
template. Only normal chat senders dispatch to workers.

For a cluster, select a unique operator-defined director role/preset or an
operator-confirmed temporary voice alias. Never assume the first member is the
director. Missing/ambiguous directors produce a question. Status routines wait
for a new reply from that exact recipient, with a bounded wait and no model
polling/summarization loop. If the operator is capturing another command,
defer speech readback and show that the reply is ready.

Clarification is a pending, memory-only question card plus optional speech;
a transient toast alone is insufficient because it can disappear before an
answer. Voice feedback off retains the card. Resolve known numbered/named
options locally; a free-form clarification may make one further bounded Luna
call with only the pending request/question. Off/cancel discards pending plans.
No partial plan executes before a required answer arrives.

Computer conversation reuses a normal projectless Codex Chat tab at Luna low,
with the existing no-project-tools and Incognito boundaries. In conversation
mode, ordinary turns go directly to that Chat rather than paying a second
interpreter call per reply. Explicit global spoken mode switches remain
available. Normal Chat history holds this deliberately opened conversation;
control utterances/plans retain no separate history. Incognito remains an
explicit memory-only choice. How-to help can attach only relevant, bounded
manual context through the existing visible chat input path.

Speech is separate from intent understanding: Kokoro's British female voices
Emma (`bf_emma`, speaker 21) and Isabella (`bf_isabella`, speaker 22) run locally
on CPU using the GB lexicon. They require no Codex quota or speech API key.
Voice selection and quality should be judged by audition. The source model
lists both as British female voices; Emma has the stronger training-data
rating: [Kokoro voice catalog](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md).
The [sherpa Kokoro integration](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/kokoro.html)
documents the local model, lexicons and speaker IDs.

Acceptance for this extension must cover the examples above, one-call intent
classification, no-send draft default, unique/ambiguous director routing,
preflight failure without partial actions, clarification with speech disabled,
spoken mode switches carrying their first request, chat/project isolation,
and readback of the new recipient response only. The multi-action, draft/send,
director, clarification and manual-context cases remain future checks. Spoken
mode switching and normal Computer Chat have the implemented checks above.

Upstream runtime/model references: [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx),
[Moonshine models](https://k2-fsa.github.io/sherpa/onnx/moonshine/models.html),
[Piper voice](https://k2-fsa.github.io/sherpa/onnx/tts/all/English/vits-piper-en_US-lessac-medium.html).

## Agent handoff (2026-10-16)

The operator requested a different agent take over. Continue the voice task; do not
start another broad feature rewrite before validating recognition with him.
The latency changes and the capture-state fixes are deployed (restart at
23:00 CDT on 2026-10-16, PID 1688765). The standalone preview on :5194 was
left running for the operator's microphone trial. The last live audit
covered four standalone snapshots and six cluster states / 24 members; one
cluster member was busy (`aabd0983-50ea-4ae2-ba98-dc0bddbe66fa`). Recheck before
any deployment. Earlier authorization allows deployment when ready, but a
restart kills active turns; leave it running while workers are active.

Working tree: `main`, with many tracked modifications and untracked voice files
from this entire conversation (including earlier mailbox-nudge work). No commit
or push. `git diff` alone omits most of the voice implementation because it is
untracked. Preserve everything; `ready-agent` is user-owned and untouched.

### Files and current implementation

- Client: `client/src/voice/{runtime,commandBuffer,reservedPhrases,commands,
  executor,modes,conversation,speech,store}.ts`, `client/public/voice-capture.js`,
  `client/src/components/VoiceControl.tsx`.
- Server: `server/src/voice/{recognizer.py,localRecognizer.ts,luna.ts,sessions.ts}`,
  `server/src/http/voiceRoutes.ts`; action allowlist: `shared/src/voice.ts`.
- Setup/test: `scripts/voice/{setup.py,preview.ts,preview.html,check-phrases.py}`,
  `scripts/smoke/{voice.ts,voice-browser.py}`, voice unit tests.
- Latest changes (second pass): asymmetric time-constant noise floor that also
  runs inside segments; `flush`-ordered END/CANCEL CAPTURE buttons (app and
  preview); blank-transcript status during capture; floor/onset diagnostics in
  DETAILS and the preview; browser smoke step for the END button. 54 voice
  tests. See § Recognition and latency follow-up, "Capture-state review".
- Earlier changes: Parakeet v3 INT8 on Linux; 350 ms endpoint, quieter threshold
  0.0035, 400 ms pre-roll, 160 ms noise calibration; ASR/TTS warm at enable;
  trailing Vosk closing check; failed HTTP recognition clears the capture;
  common combined switch-and-status routine, spaced spoken names, brief help,
  spitball/brainstorm aliases; memory-only stage timings; Luna returns at
  turn.completed with additional context/tool flags disabled.

Privacy/interaction requirements: explicit enable and open window; OFF owns no
mic/models. First Computer arms; long pauses allowed (two minutes between
recognized phrases); End capture submits; Cancel capture discards; repeated
Computer during capture stays literal. No control/audio history. Normal worker
messages and deliberate Computer Chat retain normal history. Keep selection
pinning, ambiguity choices, no guessed sends/directors, and bounded tools.
Use existing Codex subscription gpt-6-luna at low, with no extra paid API or
speculative background model calls. TNG acknowledgement; compact strip under
tabs. British female conversational voice remains a quality goal; current
output is Kokoro synthesis reading text, not native Luna audio.

### Evidence and current limits

49 voice tests, five isolated HTTP smoke steps, fake-microphone browser
lifecycle/routing checks, help checks and workspace typechecks passed. Full
isolated compiled-browser/worklet/real-ASR tests passed both normal and
1.25x-speed / 12%-gain synthetic speech, a ten-second initial pause, closing
capture and Plan navigation. Recognition requests were 49–63 ms after 352 ms
endpoint silence. Standalone preview separately passed the quiet/faster sample
and showed `Would execute: panel · plan · 62 ms recognition`. The initial
standalone test used an incorrect expected label and timed out; corrected
selector passed. None of this establishes accuracy with the operator's microphone.

Evidence lives in `/tmp/archon-voice-user-test-49pgwqfn/`, especially
`parakeet-browser-{1,0.12}-result.json`, `parakeet-browser.py` and
`parakeet-preview-check.py`. The isolated compiled tree is
`/tmp/archon-voice-build.R6DmBt`; it predates the final minor parser guard/Luna
instruction edits, so rebuild it before relying on it as the latest source.
Temporary servers on 5193, 5194 and 5195 were stopped during handoff. Production
3001 was not restarted. The private test HOME is in the same evidence directory;
never use production HOME/workspace for a destructive smoke.

Assets are in `~/.archon/voice/`: Parakeet v3 INT8 and existing Moonshine, Vosk,
Kokoro/Piper models. faster-whisper 1.2.1 and small.en were installed for an
isolated comparison but are not used by Arco. No microphone/OS listener was
installed. `voice:setup` installs assets without listening.

Review candidates before calling this done:

1. Test the operator's ordinary quiet speech and real project names; synthetic samples
   have repeatedly looked better than his experience. Keep diagnostics visible.
2. Wake acknowledgement is still provisional: the real command buffer waits for
   full first-word verification. A missed first word can revoke an acknowledged
   capture. Preserve rejection of incidental/prefixed Computer mentions while
   evaluating this interaction.
3. Reviewed (second pass): the floor tracker, blank transcripts and the manual
   End/Cancel buttons are fixed as described above. Immediate speech inside
   the 160 ms enable calibration remains untested by design (the node starts
   after warm-up); a blank middle segment is reported but cannot be detected
   as missing at End capture.

4. Typical direct commands bypass Luna. A baseline live interpreter probe took
   3.27s / 7660 input tokens; a leaner, simpler probe took 1.97s / 6894. This was
   not a controlled comparison. Avoid promising instant arbitrary natural
   language routing or spending quota on repeated benchmarks.
5. Busy-worker status requests queue normally and do not auto-read a reply; idle
   status readback cancels on off, navigation/mode or the next executed command.
   Verify the new routine in the real UI when safe to deploy.

### Research already done

Current releases checked October 16: RealtimeSTT 1.1.2 (August 30), Pocket TTS
3.3.0 (September 24), Pipecat 1.12.0 (September 26). RealtimeSTT's current CPU
profile uses Nemotron streaming plus Parakeet final decoding and explicit
finalization; Pocket TTS is a candidate local voice audition; Pipecat offers
broader turn/interruption plumbing. These are candidates, not adopted backends.
Parakeet was integrated directly through existing sherpa-onnx instead of adding
a whole framework. Verify current versions/docs again before further decisions.

The bounded subscription-voice probe with installed Codex 0.163.0 listed voices
but realtime start failed: `realtime conversation requires API key auth`. No
successful audio session or paid speech API fallback. Desktop subscription
voice documentation does not establish an embeddable Arco transport. Claude
and Cursor document voice inside their own products; no supported reusable
subscription speech interface was verified. The operator prefers investigating
subscription voice only with a strict cap; do not turn on separately billed
speech services without his choice.

Useful commands: `npm run test:voice`, `npm run smoke:voice`,
`npm run test:help-docs`, `npm run typecheck`; start a Vite client on 5193 before
`python3 scripts/smoke/voice-browser.py`. The HTTP smoke uses its own server/HOME
and fixture Codex. `npm run voice:preview` offers recognition-only testing on
5194, with the mic off until explicit enable. Full production deployment is
`npm run build` followed by an authorized safe `archon.service` restart; inspect
busy workers first and warn about interruption. Never use `scripts/archon start`
for smoke tests. Do not print the systemd unit/overrides: they contain a secret.

## Mouse-and-keyboard tools and stale tabs (2026-10-17)

When no named `archon_*` tool does exactly what was said, Computer uses the
screen: `archon_screen` lists every visible control (numbered, labelled,
grouped by open dialog or area, with state) and `archon_act` clicks, toggles,
types into or selects one, or presses Escape, Enter, Tab or an arrow. Dialogs
without a `role="dialog"` (most of Arco's modals: DOCS, GIT, SPAWN, REVIEW,
HANDOFF, SYSTEM, the nudge picker) still count as dialogs: any fixed
full-viewport overlay that takes pointer events is reported by its heading.
`archon_read_text` reads the words on screen (the open dialog, or the page), or
just the section whose heading matches a word: "Computer, read me the section on
Strata from the manual, over" opens the manual, finds the section and reads it
back in full; ask for a summary if you want one.
Controls whose label says delete, remove, discard, purge, kill, wipe, detach,
reset, rewind, overwrite or force are marked `!` and refuse until you have
said yes.

Prod serves the built client from disk, so a rebuild changes the bundle under
an open tab. After the server restarts, a tab on an older bundle shows a
yellow RELOAD banner at the top (the button is labelled, so "Computer, reload
the page, over" works), and Computer says the page needs a reload instead of
asking you to do something by hand. Every tool call and its answer is in the
journal as `[voice tool] name args → ok|ERROR ms`.

## Talking to Computer (2026-10-17)

Computer decides from the wording whether you gave it a task or started a
conversation. An instruction ("open settings", "tell the builder to…", "ask the
director what's blocking it") is done silently and you see the result in the
window. A question or remark is answered by voice in a few sentences, and
Computer goes and looks first when the answer lives in Arco: "how does Strata
work?" opens the user manual, reads the Strata section and explains it; "what's
going on with SignalQueue?" reads that cluster's Director and tells you; "what
does this button do?" reads the screen. It only types a question to a worker
when you address the worker.

The Computer chat is one continuous thread (the COMPUTER tab holds the
transcript, persisted like any chat), so follow-ups ("and the second one?",
"is that different from Ollama?") carry the context, and a new subject is
picked up as a new subject.
