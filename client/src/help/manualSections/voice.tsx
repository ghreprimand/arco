import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Example, Kbd, Sub } from '../../components/UserManual/components';

// Hands-free voice and the Computer operator. Kept in step with docs/VOICE.md
// § How Computer works today; change both.
export const voice: Section[] = [{
  id: 'hands-free-voice', group: 'Power features', title: 'Hands-free voice control',
  body: <>
  <p>
  Hands-free voice lets you speak to Arco without touching the keyboard. It
  listens for "Computer", captures a spoken directive, and hands it to the
  Computer operator after a closing word.
  </p>

  <Sub>Set up and turn on</Sub>
  <p>
  Install local CPU speech once with <Code>arco voice setup</Code> (package
  install) or <Code>npm run voice:setup</Code> (source checkout). Then click{' '}
  <Code>VOICE</Code> in the header to turn hands-free on, or press{' '}
  <Kbd>Ctrl/Cmd+Shift+Space</Kbd>. Microphone access needs localhost or HTTPS.
  </p>
  <p>
  <strong>Settings &gt; Voice &gt; Voice setup</strong> is the guided setup. It shows the
  voice home, <Code>uv</Code> and Python status, installed packages, model
  status and sizes, and model notices.
  </p>
  <ul>
  <li><strong>INSTALL</strong> or <strong>REINSTALL / REPAIR</strong> runs voice setup with a live log and a cancel control.</li>
  <li><strong>TEST MICROPHONE</strong> shows the input level without recording or sending audio.</li>
  <li><strong>SAY A PHRASE</strong> checks a short sample with the local recognizer and displays the result.</li>
  </ul>
  <p>
  In Docker, the section explains that voice requires the native run and
  disables these actions.
  </p>

  <Sub>On, off and the strip</Sub>
  <p>
  Off means no microphone, no recognizer and no wake-word listening. Closing or
  reloading the page, or losing the connection, turns it off. Re-enabling
  always needs the button or the shortcut because nothing listens while off.
  </p>
  <p>
  While enabled, a compact strip under the workflow tabs shows what is
  happening and reserves its own space. DETAILS expands the settings, the
  pending directive and the Last heard diagnostics; LESS collapses them.
  QUIET, END CAPTURE, CANCEL CAPTURE and DISABLE stay in the strip.
  </p>

  <Sub>Microphone and sensitivity</Sub>
  <p>
  Automatic microphone gain control is off, so Arco does not ask the browser to
  change system input volume. Echo cancellation and noise suppression remain
  enabled. After an update to capture settings, reload Arco and re-enable
  hands-free to apply them.
  </p>
  <p>
  <strong>Speech sensitivity</strong> in Voice Controls changes how quiet a
  sound can be before capture starts. Higher sensitivity catches quieter words
  and more room noise; the adaptive noise floor still applies. The preference
  survives reload and applies immediately, and it does not change system
  microphone volume.
  </p>
  <ul>
  <li>Low: 6‰ RMS</li>
  <li>Very low: 10‰</li>
  <li>Normal: 3.5‰</li>
  <li>High: 2‰</li>
  <li>Very high: 1‰</li>
  </ul>
  <p>
  Compare Input peak with Speech onset. If Last heard shows "older" or "over
  it", capture reached recognition but the word was misheard: pause and say
  "over" on its own, or use "End capture".
  </p>

  <Sub>Giving a directive</Sub>
  <p>
  Say "Computer". A quiet <strong>Soft double pulse</strong> (230 ms) plays only
  once the transcriber has verified that word, about half a second later. A word
  that merely sounds like it never plays the cue, and a slightly garbled
  "computer" still counts. Anything said right after the word is kept.
  </p>
  <p>
  Then speak naturally, with pauses. The directive stays pending until you say
  a closing word on its own after a pause.
  </p>
  <ul>
  <li><strong>over</strong> sends it ("execute", "engage" and "make it so" also work).</li>
  <li><strong>cancel</strong> or <strong>belay that</strong>, on their own, discards it.</li>
  </ul>
  <p>
  A closing word inside a sentence ("move it over there") stays literal. Two
  minutes of silence expires the capture without acting. After the capture
  starts, "computer" is ordinary text.
  </p>
  <p>
  The double pulse means capture is ready. It plays at its quiet audition level
  without a volume boost, and speech can continue while it plays. It is
  included with Arco; no TNG sound file or speech synthesis is needed.
  </p>

  <Sub>Changed your mind?</Sub>
  <p>
  Pause, then say <strong>cancel</strong> on its own, or say{' '}
  <strong>Cancel capture</strong>. The unsent recording is discarded
  immediately; no "over" is needed. Hands-free stays on, waiting for "Computer"
  again. This does not change rules or stop workers.
  </p>
  <p>
  The phrase can append after dictating: "Computer, tell the builder to change
  the tests, actually, cancel capture." It discards the whole directive,
  including earlier words. "Oh cancel" is not a capture boundary; if it reaches
  Computer, an unclear cancellation must prompt a question before changing any
  rule or worker. To end a standing script, specify it: "cancel that
  conditional script".
  </p>

  <Sub>Interrupting Computer</Sub>
  <p>
  Say "Computer" while it is talking and it stops and waits, the way a person
  would. Then say "stop" (or "quiet") to leave it there, or carry on with
  whatever was wanted: "Computer, switch to COMET, over" interrupts and acts in
  one breath.
  </p>
  <ul>
  <li>A bare "stop" or "quiet" without the name also cuts the speech.</li>
  <li>"Computer, stop" said as one phrase is instant.</li>
  <li>"Stop listening" ("turn off hands free") releases the microphone instantly. Everything else goes to Computer, below.</li>
  </ul>
  <p>
  The speech pauses the moment the wake detector hears something like
  "Computer". If the transcript then shows it was another word, the sentence
  resumes from its start.
  </p>
  <p>
  While Computer is itself saying the word "Computer" (this section, read
  aloud), a wake during that sentence is ignored as its own voice; "stop" still
  works. Inside a directive, "stop" and "quiet" are ordinary
  words. They only close a capture when they are the first thing said after
  "Computer".
  </p>

  <Sub>Last heard</Sub>
  <p>
  Last heard shows the transcript of each phrase; a correction made by the
  phrase recognizer is shown with an arrow. DETAILS shows the input peak, the
  learned room floor and the speech onset. A word whose peak stays under the
  onset is not heard, which usually means raising the sensitivity. Recognition,
  interpretation and first-audio timings are shown separately.
  </p>
  </>,
}, {
  id: 'computer-voice-options', group: 'Power features', title: "Choosing Computer's voice",
  body: <>
  <p>
  Choose which Microsoft neural voice reads Computer's spoken replies, without
  changing the selected agent or microphone session.
  </p>
  <p>
  Open the voice controls' DETAILS and choose <strong>Reply voice</strong>. All
  24 English female voices are grouped and labeled by accent: American,
  Australian, British, Canadian, Filipino, Hong Kong, Indian, Irish, Kenyan, New
  Zealand, Nigerian, Singaporean, South African and Tanzanian.
  </p>
  <ul>
  <li>The American group includes Ava and Emma's multilingual variants.</li>
  <li>Indian Neerja also has an expressive variant.</li>
  <li>Ana and Maisie are labeled as child voices.</li>
  <li>The system default is Sonia (British) unless configured otherwise.</li>
  </ul>
  <p>
  These are standard Microsoft neural speech voices. Computer's conversation
  comes from the selected agent and its interruption and playback controls,
  independently of which voice reads the answer.
  </p>

  <Sub>Trying a voice</Sub>
  <p>
  LISTEN plays a short sample without a model call. Audition works with the
  microphone off. When hands-free is enabled, wait until speech and any pending
  capture finish; samples then use the same interruptible playback as replies,
  including QUIET.
  </p>
  <p>
  Choosing a voice keeps the current microphone session, pending words, selected
  project and conversation. An answer already playing finishes in its original
  voice, and the next reply uses the choice.
  </p>

  <Sub>Saving and fallback</Sub>
  <p>
  The voice preference is saved for this browser; reloading still turns
  hands-free off. Online speech sends reply text to Microsoft and returns audio;
  it needs no local GPU. If that service fails, local Kokoro speech remains the
  fallback. A sample failure is reported rather than substituting another voice.
  A TNG clone is not installed by this picker.
  </p>
  </>,
}, {
  id: 'computer-conversation', group: 'Power features', title: 'Talking to Computer',
  body: <>
  <p>
  Everything after "Computer" goes as free text to the Computer agent; there is
  no fixed phrase list. Computer decides from the wording whether you gave it a
  task or started a conversation.
  </p>
  <p>
  Computer is a projectless chat using the selected agent (Codex Luna at low
  effort by default). It sees open tabs (every cluster, member, workflow and
  chat with its role) and has Arco's operator surface as tools, the way a person
  sitting between the operator and the screen would.
  </p>

  <Sub>A task</Sub>
  <p>
  A task is an instruction to Arco or to a worker. Computer does it with the
  tools (a click, a typed message, or a sequence of them, in the order they
  would have been done), says nothing, and the result appears in the window. The
  strip shows "Done.".
  </p>
  <Example label="TASKS">
  <ul>
  <li>"open settings"</li>
  <li>"switch to Ember"</li>
  <li>"tell the builder to start on the import first"</li>
  <li>"nudge the reviewer"</li>
  <li>"close that"</li>
  <li>"ask the director what's blocking it"</li>
  </ul>
  </Example>
  <p>
  A message to a worker is typed in the operator's words and intent, tidied the
  way a person passing it on would. Misheard names are matched to the roster:
  "harbour hyphen maint" is HARBOR-MAINT, and "re lay" is Relay.
  </p>
  <p>
  Follow-ups use the conversation. After asking about Relay's mail and
  hearing about its one Builder, "nudge the builder" refers to that worker, even
  if another cluster is selected. An explicit new project or recipient changes
  the topic.
  </p>
  <p>
  Computer asks which one only when multiple members still fit within the
  relevant cluster; unrelated builders in other tabs do not count. With two
  builders in that cluster, it asks "Which one: A or B?" and never guesses from
  activity or mail count.
  </p>
  <p>
  "Open", "bring up" or "show" a dialog opens it and stops: "bring up the nudge
  dialog" shows the picker and sends nothing.
  </p>

  <Sub>A conversation</Sub>
  <p>
  A conversation is a question or a remark aimed at Computer, about Arco, about
  a project, about what is on screen, or about anything at all. It answers by
  voice in a few sentences, after looking things up where they live, silently.
  </p>
  <ul>
  <li><strong>How Arco works or what a feature does</strong> comes from this manual. Computer opens the manual to the section and reads it, so "how does Strata work?" also puts the Strata section on screen.</li>
  <li><strong>What a project or member is doing</strong>, where it stands or what it last said comes from that project's recent messages and status (a cluster's Director).</li>
  <li><strong>What is on screen</strong> is read from the screen.</li>
  <li><strong>General knowledge</strong> is simply answered.</li>
  </ul>
  <p>
  "Can you tell me what's going on with this project?" is answered to the
  operator, not typed to the worker. Only a question addressed to a worker ("ask
  the director...", "have the builder explain...") is typed to it, and its answer
  is read in the window. A mixed utterance ("switch to COMET and tell me what's
  going on") does the task and then answers.
  </p>
  <p>
  Computer keeps the same model thread between requests until a fresh start.
  Within that context it remembers the conversation: follow-ups such as "and the
  second one?" or "is that different from Ollama?" need no repeated subject. To
  read something aloud, ask for it ("read me the section on Strata"); asking to
  summarize gets a summary.
  </p>

  <Sub>The COMPUTER panel</Sub>
  <p>
  VOICE CONVERSATION AND MEMORY, in the VOICE menu of the top bar, opens a
  dedicated panel for the voice conversation, tool calls and usage. It stays
  separate from project tabs and ordinary chats. It can be reviewed with the
  microphone off, and opening or closing it keeps the current project selected.
  CLOSE or Escape returns to the workbench, and VOICE CONTROLS opens the
  microphone controls.
  </p>
  <p>
  Type requests, corrections or answers in the message field at the bottom of
  COMPUTER. Enter sends; Shift+Enter adds a line. Typed requests use the same
  conversation and tools with the microphone off. Opening the panel alone does
  not authorize actions.
  </p>
  <p>
  While Computer is processing, <strong>STOP REQUEST</strong> appears in its
  fixed header and the voice strip. Stop before sending a correction; actions
  already dispatched may have happened. Pause or cancel standing scripts
  separately under CONDITIONAL SCRIPTS. A script holding for input is separate
  from a Computer turn, and its reason appears beside its controls.
  </p>

  <Sub>Choosing the agent</Sub>
  <p>
  In COMPUTER, choose Provider, Model, Effort and History, then USE AGENT.
  Codex, Claude (including Haiku and Sonnet), Ollama and Strata use the same
  bounded Computer tools. Choices come from Arco's model catalogs.
  </p>
  <p>
  Each provider, model and effort selection has a separate context. Switching
  waits for the current turn and queue, and no earlier messages are copied to
  another selection. Switching back to a saved selection resumes its own
  context. The speech voice and microphone controls are independent of the
  agent.
  </p>

  <Sub>No history (Incognito)</Sub>
  <p>
  Choose this for a memory-only conversation on Codex, Claude or Ollama. It
  starts separately from saved history and writes no Arco transcript, browser
  conversation snapshot, voice diagnostics or provider session file.
  </p>
  <ul>
  <li>CLEAR CONTEXT discards both its context and visible transcript.</li>
  <li>Leaving no-history mode, changing its model, reloading, closing or restarting also loses that private context.</li>
  <li>Strata is saved-only because its standalone service keeps logs and cache.</li>
  <li>Cloud inference and online Microsoft speech still receive the text they process.</li>
  <li>Messages sent to workers use the destination's normal history.</li>
  </ul>

  <Sub>Controlling Computer by voice</Sub>
  <p>
  The agent and history controls also work by voice. Computer looks up real model
  IDs and asks when several fit. No-history changes apply after that request
  finishes; wait for the new active mode before dictating private content.
  </p>
  <Example label="SAY">
  <ul>
  <li>"Computer, clear your context, over"</li>
  <li>"Computer, use Haiku instead, over"</li>
  <li>"Computer, switch to my Qwen in Ollama, over"</li>
  <li>"Computer, go incognito, over"</li>
  <li>"Computer, save our conversations again, over"</li>
  </ul>
  </Example>

  <Sub>Context and fresh starts</Sub>
  <p>
  The COMPUTER panel shows current context fullness separately from accumulated
  token usage, plus the last recorded Codex compaction. By default Computer
  starts a fresh context at 50% of the reported window for Codex and Claude, or
  75% for local Ollama and Strata models. It does so after its turn, tool calls
  and queued follow-ups have all finished, and no running turn is interrupted.
  Choose 25%, 50%, 75% or OFF.
  </p>
  <ul>
  <li><strong>KEEP CONTEXT</strong> pauses automatic resets when continuity across several requests is wanted, including an announced dictation.</li>
  <li><strong>CLEAR CONTEXT</strong> starts over immediately when idle.</li>
  <li><strong>CLEAR AFTER TURN</strong> requests a reset once the current work and queue finish.</li>
  </ul>
  <p>
  In saved mode, a fresh start archives the old model session and keeps the
  visible transcript, with a marker showing the boundary. It carries no earlier
  messages or summary into the new context, so follow-ups after that point need
  their subject stated again. These controls never send a prompt or enable the
  microphone. Computer's voice, tools and selected project stay the same.
  </p>

  <Sub>If Computer stalls</Sub>
  <p>
  Codex Computer stops after 90 seconds of silent startup, 60 seconds without
  progress, or five minutes in one turn. It replaces its own connection, cancels
  queued requests and tells you by voice when hands-free is enabled. It never
  repeats the directive automatically: some actions may already have happened,
  so check before repeating it.
  </p>
  <p>
  Saved history stays available for the next request. A lost no-history context
  is cleared, including its visible transcript. This limit does not interrupt
  project workers, ordinary chats or local model loading.
  </p>
  </>,
}, {
  id: 'computer-dictation', group: 'Power features', title: 'Dictating exact text',
  body: <>
  <p>
  Use dictate (verbatim) mode when a worker message must be sent character for
  character as transcribed.
  </p>
  <p>
  Normally Computer rewords a message for a worker in the operator's words and
  intent. To send exact text, say <strong>dictate</strong> (or "verbatim", "word
  for word", "exactly this"). Everything after that word is sent character for
  character as transcribed, fillers, repetitions and odd grammar included, with
  nothing shortened, tidied, completed or added.
  </p>
  <Example>
  <p>
  "Computer, send a message to Builder 2, dictate: I'd like you to search the
  web for, um, llama.cpp speculative decoding, over" sends exactly "I'd like you
  to search the web for, um, llama.cpp speculative decoding".
  </p>
  </Example>
  <p>
  Dictation can also be announced first: "Computer, I want to dictate a message
  to Builder 3, over". Computer resolves the target (and asks if it is
  ambiguous) and replies "Go ahead.". The whole next utterance, up to its "over",
  is then sent to that worker verbatim.
  </p>
  <p>
  Punctuation comes from the transcriber, so speak it where it matters.
  </p>
  </>,
}, {
  id: 'computer-tools', group: 'Power features', title: 'What Computer can do',
  body: <>
  <p>
  Computer's named tools cover common Arco moves; everything else uses a generic
  mouse and keyboard over numbered on-screen controls.
  </p>

  <Sub>Named tools</Sub>
  <ul>
  <li>Select a tab, cluster or member.</li>
  <li>Open a right-panel tab or a global surface (settings, the manual, the knowledge panel).</li>
  <li>Open a dialog without using it (nudge, broadcast, review, handoff, spawn, plan, docs, git, tune-up, research, transcript).</li>
  <li>Type a message to a worker (steer or follow-up), nudge, or cancel a turn.</li>
  <li>Read a worker's latest reply, or glance at a project (state, current tool, plan, the last few messages).</li>
  <li>Report busy-or-idle status and subscription quota.</li>
  <li>Set one-shot completion watches and bounded conditional mailbox rules.</li>
  </ul>
  <p>
  When Computer selects a worker or sends a voice message or nudge to the
  selected worker, its transcript jumps to the latest output and follows the
  reply. Scroll up to pause following. Sending to another worker does not move
  the conversation being read.
  </p>

  <Sub>Quota</Sub>
  <p>
  "What percentage of my Codex quota have I used?" reads Arco's actual quota
  snapshot, including its age, used and remaining windows and reset information.
  Claude and Cursor usage are also available when connected. Missing data is
  reported as unavailable, and token totals and throttle status are separate from
  quota percentage.
  </p>

  <Sub>Completion watches</Sub>
  <p>
  "Let me know when Builder 1 in Relay finishes" watches exactly that
  worker's current turn and queued messages. Builder 2 finishing does not
  trigger it. Name the whole cluster to capture its currently busy members; idle
  or new members and future runs are excluded.
  </p>
  <p>
  A watch reports that current work stopped running, without judging project
  completion. Already idle means no watch is armed. State updates arrive by
  WebSocket on change, without a browser refresh timer.
  </p>
  <p>
  COMPUTER shows an active count and current watches; stopped watches are under
  collapsed History, where an expanded record shows its targets and dates.
  Review targets and status, ask what watches are active, or cancel one here or
  by voice. Watching makes no model calls and sends no prompts to workers.
  </p>
  <p>
  Saved watches survive context and model changes and reloads. They show up in
  the bell when fired, and hands-free with spoken feedback announces them after
  capture or current speech finishes. The Computer watches bell mute suppresses
  notifications and speech. Errors and cancellations are reported accurately,
  and a server restart marks unfinished watches interrupted.
  </p>
  <p>
  No-history watches remain memory-only and are scoped to that private Computer
  context. They never reach saved logs or external notification services, and
  they disappear on a full clear or leaving that context.
  </p>

  <Sub>Live activity</Sub>
  <p>
  ACTIVITY &amp; CONDITIONS in COMPUTER shows recent worker and mailbox facts
  and an agent inbox. Saved Computer settings load when its chat is restored
  after reload; speaking first or pressing USE AGENT is not required. These
  controls also work with the mic off. Loading and connection errors are shown;
  use RETRY ACTIVITY if a read fails.
  </p>
  <p>
  Arco reports activity automatically when it happens; no worker has to remember
  to report it. Conditions check those events immediately, with no polling or
  monitoring model calls. Worker finish means its complete current turn and
  queued messages ended.
  </p>
  <p>
  The recent ledger is bounded metadata, not another copy of every conversation:
  200 public records retained, 100 displayed. Computer's own activity and private
  chats are excluded.
  </p>

  <Sub>Optional agent updates</Sub>
  <p>
  Choose OFF, Matched conditions only, or Worker completions + matched
  conditions. This lets the selected Computer agent, including Luna, remember
  factual updates for follow-up questions. Updates wait while it is busy, then
  arrive in a visible read-only model turn: no operator tools or worker messages
  are allowed. Own directives queue as normal follow-ups.
  </p>
  <p>
  Normal provider usage applies, capped at 12 update turns per rolling hour, 10
  events per batch and 50 pending facts. Overflow, delivery and failure states
  are visible. CLEAR QUEUED UPDATES discards waiting updates. Failed or
  interrupted updates are not automatically retried. Worker reports themselves
  cost no model calls.
  </p>
  <p>
  These settings belong to this Computer context. Switching agents turns off the
  old feed and cancels its waiting updates; enable the new feed separately if
  wanted. Saved conditions keep running independently. No-history settings,
  inbox and matched-condition data remain memory-only and disappear on a full
  private clear or leaving that context. Saved activity uses Arco's local
  persistence; no extra service is needed.
  </p>

  <Sub>Conditional scripts</Sub>
  <p>
  Describe the policy wanted, and Computer translates it into conditions and
  independent actions. Scripts can combine busy or idle state, queued messages,
  pending mail, human-input holds, context fullness, compaction and event counts
  across exact worker sets. AND, OR, NOT, group and count comparisons,
  recurrence and ordered clauses let behavior be composed without a predefined
  Director handoff.
  </p>
  <p>
  Unknown facts are shown as unknown, never guessed. After restart, saved token
  readings are restored without prompting workers. Compaction invalidates old
  readings until the provider reports a fresh measurement; billing totals are
  never used as context size.
  </p>
  <Example label="EXAMPLES">
  <ul>
  <li>"Keep nudging the builders for new mail, leave Director alone, and let me know when those builders are idle with empty queues and mailboxes" does not require any Director action.</li>
  <li>"Compact Builder 1 at 40%, wait for compaction, then tell it to continue" uses the actual worker context and compaction lifecycle.</li>
  </ul>
  </Example>
  <p>
  Native compaction preserves a summary; Ollama arms it for the next turn, and
  the requested continuation starts that turn, which compacts before working.
  Unsupported transports are refused. Worker nudges, exact messages and
  compaction run on the server, including with the mic off; scripted screen
  actions need the owning hands-free browser.
  </p>

  <Sub>Human-input holds</Sub>
  <p>
  Scripts hold for human questions by default, optionally for an exact subset of
  workers. Structured questions and approvals are immediate facts. Ordinary
  changed replies use a tool-free Luna LOW check, capped at 24 batches per
  rolling hour and 16 replies per batch; normal Codex usage applies.
  </p>
  <p>
  The observer never answers a question or grants approval. Uncertain,
  unavailable or truncated text holds the script. Human answers allow a new
  check, and review or resume can retry an unknown result. Restoring the latest
  reply scans saved reply events, so later board or activity records do not hide
  a short response. Incomplete or oversized replies still hold, with the reason
  shown in the panel.
  </p>

  <Sub>Managing scripts</Sub>
  <p>
  CONDITIONAL SCRIPTS shows the exact declaration, targets, holds, action counts
  and expiry. Its heading counts active and paused scripts separately; "0
  active" means no active scripts, and paused ones stay visible so they can be
  resumed. Armed scripts show their reason and pause, resume and cancel
  controls. Stopped scripts are under collapsed <strong>History</strong> and
  cannot run.
  </p>
  <p>
  Expand a script for full details, or How scripts work for explanations and
  input-check usage. Pause, resume and cancel here or by voice; the activity
  master switch pauses scripts too.
  </p>
  <p>
  New scripts have <strong>no expiry, total-action limit or per-worker-turn
  limit</strong> unless one is requested. For example: "Allow 100 turns per
  worker and stop after six hours." Compaction and continuation each count as a
  worker action. Cooldown defaults to 30 seconds; ask to change it, including
  zero.
  </p>
  <p>
  The panel shows total and per-worker counts, numeric limits or "no limit",
  expiry or "No expiry", and cooldown. Idle checks, human-input holds and mail
  deduplication still apply. STOP and error stop scripts unless handling those
  events is explicitly requested; membership changes always stop. Saved scripts
  survive context changes, but a restart interrupts them without replay.
  No-history scripts remain memory-only and disappear on full clear or leaving
  that context.
  </p>

  <Sub>Changing a script</Sub>
  <p>
  Conditions can be added or changed by voice: "Update that script to also
  compact Builder 1 at 40%." Computer updates the existing script, retaining its
  counts, handled mail and matching completed actions. Existing saved scripts
  retain their limits until changed.
  </p>
  <p>
  "Remove the time and turn limits from that script" changes it in place without
  resetting usage or resending work. Unrelated edits preserve expiry;
  explicitly changing the time limit starts that duration from the update.
  Removing it gives the script no expiry.
  </p>

  <Sub>Legacy mailbox rules</Sub>
  <p>
  Older fixed-sequence rules remain manageable in LEGACY MAILBOX RULES, shown
  only when there are records or an error. Active and paused counts are
  separate; stopped records are collapsed History. New conditional directives use
  scripts.
  </p>
  <Example>
  <p>
  "Nudge Builder 1 in Relay, keep nudging it when new mail arrives, then
  once only the Director has mail, nudge the Director and let me know."
  </p>
  </Example>
  <p>
  Computer binds those exact members, nudges an idle selected worker for pending
  mail, then repeats only for new mail. The final recipient must have mail and be
  idle. Every other cluster member, including unselected workers, must have an
  empty mailbox and be idle with no queued messages. Then the final nudge is
  dispatched, a notification is sent, and the rule stops.
  </p>
  <p>
  This confirms a nudge, not successful work or project completion.
  </p>
  <p>
  Monitoring uses no model calls, and each nudge starts a normal worker turn.
  Limits are <strong>two hours, a 30-second cooldown and eight nudges per
  selected worker</strong>, up to 16 selected workers and one active rule per
  cluster.
  </p>
  <ul>
  <li>Unchanged unread mail never repeats; an all-empty cluster waits until the final condition or expiry.</li>
  <li>Rules do not interrupt busy workers or queue extra nudges.</li>
  <li>They stop on worker failure or STOP, membership changes, mailbox errors, restart, expiry or the nudge limit.</li>
  <li>AUTO-PICKUP must be off; enabling it stops the rule. Computer never changes it silently.</li>
  </ul>
  <p>
  In COMPUTER, LEGACY MAILBOX RULES shows identities, status, counts, cooldown,
  expiry and <strong>PAUSE/RESUME/CANCEL RULE</strong>. Enable event automations
  pauses mailbox actions and optional agent updates for this Computer context;
  completion watches still resolve normally. Expiry continues while paused.
  </p>
  <p>
  Ask "What mailbox rules are active?", "Pause that mailbox rule", "Resume that
  rule" or "Cancel that mailbox rule." Cancelling prevents future nudges;
  started turns continue. Saved rules keep running with the browser closed and
  survive context and model changes, but a restart requires re-arming.
  Notifications and spoken feedback use the Computer watches mute.
  </p>
  <p>
  Private rules stay in memory, disappear on a full private clear or leaving that
  context, and never publish their metadata to saved logs or external
  notifications. Requested nudges still enter the normal destination worker's
  history.
  </p>

  <Sub>Mouse and keyboard</Sub>
  <p>
  For everything else Computer has a generic mouse and keyboard. It can look at
  the screen and get every visible control numbered and labelled (buttons, tabs,
  fields, toggles, dropdowns, links), grouped by open dialog or area with its
  state.
  </p>
  <ul>
  <li>Click, toggle, type into or select any control by number or label.</li>
  <li>Inspect dropdown options and set bounded numeric or slider values.</li>
  <li>Hover, double-click, open right-click menus, focus fields, scroll inside a dialog or panel, and press navigation and editing keys.</li>
  <li>Read the words on screen, the whole open dialog, or just the section whose heading matches a word.</li>
  </ul>
  <p>
  Labels come from the controls themselves and their contextual-help titles, so
  new parts of Arco are reachable without any voice-specific work. Modals
  without an accessibility role still count as dialogs.
  </p>
  <p>
  Controls whose label says delete, remove, discard, purge, kill, wipe, detach,
  reset, rewind, overwrite or force are marked destructive and refuse until yes
  has been said.
  </p>

  <Sub>What it cannot reach</Sub>
  <p>
  Every tool call appears in the COMPUTER panel's transcript, and the tools act
  on the selected project or chat. Settings, themes, providers, models, task
  boards, file views and Git controls are reachable through Arco's interface.
  Computer checks the controls before claiming a capability is unavailable.
  Normal confirmations stay in place.
  </p>
  <p>
  It has no arbitrary host shell or filesystem tool. Browser protected actions
  such as choosing a local upload still need operator input. A request outside
  Arco's interface can be delegated to a worker when asked.
  </p>
  </>,
}, {
  id: 'computer-privacy-troubleshooting', group: 'Power features', title: 'Voice: quota, privacy and troubleshooting',
  body: <>
  <p>
  Recognition runs locally; spoken replies use Microsoft Edge neural voices
  online or Kokoro offline; Computer thinking uses the selected provider.
  </p>

  <Sub>Privacy</Sub>
  <ul>
  <li>Recognition (Parakeet, plus a small phrase recognizer for the wake word and closings) runs locally.</li>
  <li>Spoken replies use Microsoft Edge neural voices when online and Kokoro offline.</li>
  <li>Computer's thinking uses the selected provider (Codex or Claude subscription, or local Ollama or Strata), and its usage shows in the COMPUTER panel.</li>
  <li>No audio is stored.</li>
  <li>Utterances and replies are saved only in saved-history mode; messages sent to workers use those workflows' history.</li>
  <li>Incognito tabs cannot be messaged by voice.</li>
  </ul>

  <Sub>Troubleshooting</Sub>
  <p>
  If Computer says the page needs a reload, or a yellow RELOAD banner appears at
  the top, this tab is running an older build than the server (Arco was rebuilt
  and restarted under it). "Computer, reload the page, over" or the button fixes
  it.
  </p>
  <p>
  In saved mode, voice decisions and tool relays are in the server journal, so a
  missed wake word or a wrong action can be read back rather than guessed at.
  No-history mode suppresses them. On a Linux service install:{' '}
  <Code>journalctl --user -u arco.service | grep '\[voice'</Code>
  </p>
  </>,
}];
