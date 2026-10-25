import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Kbd } from '../../components/UserManual/components';

// Hands-free voice and the Computer operator. Kept in step with docs/VOICE.md
// § How Computer works today; change both.
export const voice: Section[] = [{
  id: 'hands-free-voice', group: 'Power features', title: 'Hands-free voice control',
  body: <>
    <p>Install local CPU speech once with <Code>npm run voice:setup</Code>, then
      open <Code>VOICE OFF</Code> in the header and enable hands-free, or press
      <Kbd>Ctrl/Cmd+Shift+Space</Kbd>. Microphone access needs localhost or
      HTTPS. Off means no microphone, no recognizer and no wake-word listening;
      closing or reloading the page, or losing the connection, turns it off.
      Re-enabling always needs the button or the shortcut because nothing
      listens while off.</p>
    <p>While enabled, a compact strip under the workflow tabs shows what is
      happening and reserves its own space. DETAILS expands the settings, the
      pending directive and the Last heard diagnostics; LESS collapses them.
      QUIET, END CAPTURE, CANCEL CAPTURE and DISABLE stay in the strip.</p>
    <p>Automatic microphone gain control is off, so Arco does not ask the
      browser to change your system input volume. Echo cancellation and noise
      suppression remain enabled. After an update to capture settings, reload
      Arco and re-enable hands-free to apply them.</p>
    <p><strong>Speech sensitivity</strong> in Voice Controls changes how quiet
      a sound can be before capture starts. Normal is 3.5‰ RMS, High 2‰,
      Very high 1‰, Low 6‰ and Very low 10‰. Higher sensitivity catches
      quieter words and more room noise; the adaptive noise floor still applies.
      The preference survives reload and applies immediately. This does not
      change your system microphone volume. Compare Input peak with Speech onset.
      If Last heard shows “older” or “over it”, capture reached recognition but
      the word was misheard: pause and say “over” on its own, or use “End capture”.</p>
    <p>Say “Computer”. A quiet <strong>Soft double pulse</strong> (230 ms)
      plays only once the transcriber has verified
      that word, about half a second later; a word that merely sounds like it
      never plays the cue, and a slightly garbled “computer” still counts. Anything
      you say right after the word is kept. Then speak naturally, with pauses:
      the directive stays pending until you say <strong>over</strong> on its
      own after a pause (“execute”, “engage” and “make it so” also work), and
      <strong>cancel</strong> or <strong>belay that</strong> on their own
      discards it. A closing word inside a sentence (“move it over there”)
      stays literal. Two minutes of silence expires the capture without
      acting. After the capture starts, “computer” is ordinary text.</p>
    <p><strong>Changed your mind?</strong> Pause, then say <strong>cancel</strong>
      on its own, or say <strong>Cancel capture</strong>. The unsent recording
      is discarded immediately; no “over” is needed. You can append the phrase
      after dictating: “Computer, tell the builder to change the tests, actually,
      cancel capture.” It discards the whole directive, including earlier words.
      Hands-free stays on,
      waiting for “Computer” again. This does not change rules or stop workers.
      “Oh cancel” is not a capture boundary; if it reaches Computer, an unclear
      cancellation must prompt a question before changing any rule or worker.
      To end a standing script, specify it: “cancel that conditional script”.</p>
    <p>The double pulse means capture is ready. It plays at its quiet audition
      level without a volume boost, and you can speak while it plays. It is
      included with Arco; no TNG sound file or speech synthesis is needed.</p>
    <p><strong>Interrupting it.</strong> Say “Computer” while it is talking
      and it stops and waits, the way a person would. Then say “stop” (or
      “quiet”) to leave it there, or carry on with whatever you wanted:
      “Computer, switch to ORBIT, over” interrupts and acts in one breath. A
      bare “stop” or “quiet” without the name also cuts the speech, and
      “Computer, stop” said as one phrase is instant. The speech pauses the
      moment the wake detector hears something like “Computer”; if the
      transcript then shows it was another word, the sentence resumes from
      its start. While Computer is itself saying the word “Computer” (this
      section, read aloud), a wake during that sentence is ignored as its
      own voice; “stop” still works. Inside a directive, “stop” and “quiet”
      are ordinary words — they only close a capture when they are the first
      thing you say after “Computer”.</p>
    <p>“Stop listening” (“turn off hands free”) releases the microphone
      instantly. Everything else goes to Computer, below.</p>
    <p>Last heard shows the transcript of each phrase; a correction made by
      the phrase recognizer is shown with an arrow. DETAILS shows the input
      peak, the learned room floor and the speech onset: a word whose peak
      stays under the onset is not heard, which usually means raising the
      sensitivity. Recognition, interpretation and first-audio timings are
      shown separately.</p>
  </>,
}, {
  id: 'computer-voice-options', group: 'Power features', title: 'Choosing Computer’s voice',
  body: <>
    <p>Open the voice controls’ DETAILS and choose <strong>Reply voice</strong>.
      All 24 English female voices are grouped and labeled by accent:
      American, Australian, British, Canadian, Filipino, Hong Kong, Indian,
      Irish, Kenyan, New Zealand, Nigerian, Singaporean, South African and
      Tanzanian. The American group includes Ava and Emma’s multilingual
      variants; Indian Neerja also has an expressive variant. Ana and Maisie
      are labeled as child voices. The system default is Sonia (British)
      unless configured otherwise.
      These are standard Microsoft neural speech voices; Computer’s conversation
      comes from your selected agent and its interruption/playback controls, independently of
      which voice reads the answer.</p>
    <p>LISTEN plays a short sample without a model call. You can audition with
      the microphone off. When hands-free is enabled, wait until speech and
      any pending capture finish; samples then use the same interruptible
      playback as replies, including QUIET. Choosing a voice keeps the current
      microphone session, pending words, selected project and conversation.
      An answer already playing finishes in its original voice, and the next
      reply uses your choice.</p>
    <p>The voice preference is saved for this browser; reloading still turns
      hands-free off. Online speech sends reply text to Microsoft and returns
      audio; it needs no local GPU. If that service fails, local Kokoro speech
      remains the fallback. A sample failure is reported rather than substituting
      another voice. A TNG clone is not installed by this picker.</p>
  </>,
}, {
  id: 'computer-conversation', group: 'Power features', title: 'Talking to Computer',
  body: <>
    <p>Nothing you say is matched against a phrase list. Everything after
      “Computer” goes as free text to <Code>Computer</Code>, a projectless
      chat using your selected agent (Codex Luna at low effort by default) that sees your open tabs (every cluster,
      member, workflow and chat with its role) and has Arco’s operator
      surface as tools. It decides from your wording what you want, the way a
      person sitting between you and the screen would.</p>
    <p><strong>A task</strong> is an instruction to Arco or to a worker:
      “open settings”, “switch to Firelight”, “tell the builder to start on the
      import first”, “nudge the reviewer”, “close that”, “ask the director
      what’s blocking it”. Computer does it with the tools (a click, a typed
      message, or a sequence of them, in the order you would have done them),
      says nothing, and you see the result in the window; the strip shows
      “Done.”. A message to a worker is typed in your words and intent,
      tidied the way a person passing it on would. Misheard names are matched
      to the roster (“atlantus hyphen maint” is ATLANTIS-MAINT, “signal cue”
      is SignalQueue). Follow-ups use the conversation: after asking about
      SignalQueue’s mail and hearing about its one Builder, “nudge the builder”
      refers to that worker, even if another cluster is selected. An explicit
      new project or recipient changes the topic. Computer asks which one only
      when multiple members still fit within the relevant cluster; unrelated
      builders in other tabs do not count. With two builders in that cluster,
      it asks “Which one: A or B?” and never guesses from activity or mail count. “Open”, “bring up” or “show” a dialog opens it and stops: “bring
      up the nudge dialog” shows the picker and sends nothing.</p>
    <p><strong>A conversation</strong> is a question or a remark aimed at
      Computer, about Arco, about a project, about what is on screen, or
      about anything at all. It answers by voice in a few sentences, after
      looking things up where they live, silently: how Arco works or what a
      feature does comes from this manual (it opens the manual to the section
      and reads it, so “how does Strata work?” also puts the Strata section on
      screen); what a project or member is doing, where it stands or what it
      last said comes from that project’s recent messages and status (a
      cluster’s Director); what is on screen is read from the screen; general
      knowledge is simply answered. “Can you tell me what’s going on with this
      project?” is answered to you, not typed to the worker. Only a question
      addressed to a worker (“ask the director…”, “have the builder
      explain…”) is typed to it, and you read its answer in the window. A
      mixed utterance (“switch to ORBIT and tell me what’s going on”) does the
      task and then answers.</p>
    <p>COMPUTER in the top bar opens a dedicated panel for your voice
      conversation, tool calls and usage. It stays separate from project tabs
      and ordinary chats. You can review it with the microphone off; opening
      or closing it keeps your current project selected. CLOSE or Escape
      returns to the workbench, and VOICE CONTROLS opens the microphone controls.</p>
    <p>Type requests, corrections or answers in the message field at the bottom
      of COMPUTER. Enter sends; Shift+Enter adds a line. Typed requests use the
      same conversation and tools with the microphone off. Opening the panel
      alone does not authorize actions. While Computer is processing,
      <strong> STOP REQUEST</strong> appears in its fixed header and the voice
      strip. Stop before sending a correction; actions already dispatched may
      have happened. Pause or cancel standing scripts separately under
      CONDITIONAL SCRIPTS. A script holding for input is separate from a
      Computer turn, and its reason appears beside its controls.</p>
    <p><strong>Choosing the agent.</strong> In COMPUTER, choose Provider, Model,
      Effort and History, then USE AGENT. Codex, Claude (including Haiku and
      Sonnet), Ollama and Strata use the same bounded Computer tools. Choices
      come from Arco’s model catalogs. Each provider/model/effort selection
      has a separate context; switching waits for the current turn and queue.
      No earlier messages are copied to another selection. Switching back to a
      saved selection resumes its own context. The speech voice and microphone
      controls are independent of the agent.</p>
    <p><strong>No history (Incognito).</strong> Choose this for a memory-only
      conversation on Codex, Claude or Ollama. It starts separately from saved
      history and writes no Arco transcript, browser conversation snapshot,
      voice diagnostics or provider session file. CLEAR CONTEXT discards both
      its context and visible transcript. Leaving no-history mode, changing its
      model, reloading, closing or restarting also loses that private context.
      Strata is saved-only because its standalone service keeps logs/cache.
      Cloud inference and online Microsoft speech still receive the text they
      process; messages you send to workers use the destination’s normal history.</p>
    <p>These controls also work by voice: “Computer, clear your context, over”,
      “Computer, use Haiku instead, over”, “Computer, switch to my Qwen in
      Ollama, over”, “Computer, go incognito, over”, and “Computer, save our
      conversations again, over”. Computer looks up real model IDs and asks
      when several fit. No-history changes apply after that request finishes;
      wait for the new active mode before dictating private content.</p>
    <p>Computer keeps the same model thread between requests until you start
      fresh. Within that context it remembers the conversation: follow-ups such as “and the second one?” or
      “is that different from Ollama?” need no repeated subject. To read
      something aloud, ask for it (“read me the section
      on Strata”); asking to summarize gets a summary.</p>
    <p><strong>Context and fresh starts.</strong> The COMPUTER panel shows
      current context fullness separately from accumulated token usage, plus
      the last recorded Codex compaction. By default Computer starts a fresh
      context at 50% of the reported window for Codex/Claude, or 75% for local Ollama/Strata models, after its turn, tool calls and
      queued follow-ups have all finished. You can choose 25%, 50%, 75% or OFF.
      No running turn is interrupted. KEEP CONTEXT pauses automatic resets
      when you want continuity across several requests, including an announced
      dictation. CLEAR CONTEXT starts over immediately when idle; CLEAR AFTER
      TURN requests a reset once the current work and queue finish.</p>
    <p>In saved mode, a fresh start archives the old model session and keeps the visible
      transcript, with a marker showing the boundary. It carries no earlier
      messages or summary into the new context, so follow-ups after that point
      need their subject stated again. These controls never send a prompt or
      enable the microphone. Computer’s voice, tools and selected project stay
      the same.</p>
    <p><strong>If Computer stalls.</strong> Codex Computer stops after 90 seconds
      of silent startup, 60 seconds without progress, or five minutes in one
      turn. It replaces its own connection, cancels queued requests and tells
      you by voice when hands-free is enabled. It never repeats the directive
      automatically: some actions may already have happened, so check before
      repeating it. Saved history stays available for your next request. A lost
      no-history context is cleared, including its visible transcript. This
      limit does not interrupt project workers, ordinary chats or local model
      loading.</p>
  </>,
}, {
  id: 'computer-dictation', group: 'Power features', title: 'Dictating exact text',
  body: <>
    <p>Normally Computer rewords a message for a worker in your words and
      intent. When you want the exact text sent, say <strong>dictate</strong>
      (or “verbatim”, “word for word”, “exactly this”): everything after that
      word is sent character for character as transcribed, fillers,
      repetitions and odd grammar included, with nothing shortened, tidied,
      completed or added. “Computer, send a message to Opus Builder, dictate:
      I’d like you to search the web for, um, llama.cpp speculative decoding,
      over” sends exactly “I’d like you to search the web for, um, llama.cpp
      speculative decoding”.</p>
    <p>You can also announce it first: “Computer, I want to dictate a message
      to SOL Builder, over”. Computer resolves the target (and asks if it is
      ambiguous), replies “Go ahead.”, and your whole next utterance, up to
      its “over”, is sent to that worker verbatim. Punctuation comes from the
      transcriber, so speak it where it matters.</p>
  </>,
}, {
  id: 'computer-tools', group: 'Power features', title: 'What Computer can do',
  body: <>
    <p>The named tools cover the common moves: select a tab, cluster or member;
      open a right-panel tab or a global surface (settings, the manual, the
      knowledge panel); open a dialog without using it (nudge, broadcast,
      review, handoff, spawn, plan, docs, git, tune-up, research, transcript);
      type a message to a worker (steer or follow-up); nudge; cancel a turn;
      read a worker’s latest reply; glance at a project (state, current tool,
      plan, the last few messages); busy-or-idle status; subscription quota;
      one-shot completion watches; and bounded conditional mailbox rules.</p>
    <p><strong>Quota.</strong> “What percentage of my Codex quota have I used?”
      reads Arco’s actual quota snapshot, including its age, used/remaining
      windows and reset information. Claude, Cursor and Z.ai usage are also
      available when connected. Missing data is reported as unavailable;
      token totals and throttle status are separate from quota percentage.</p>
    <p><strong>Completion watches.</strong> “Let me know when Builder 1 in
      SignalQueue finishes” watches exactly that worker’s current turn and
      queued messages. Builder 2 finishing does not trigger it. Name the whole
      cluster to capture its currently busy members; idle/new members and
      future runs are excluded. This reports that current work stopped running,
      without judging project completion. Already idle means no watch is armed.
      State updates arrive by WebSocket on change, without a browser refresh timer.
      COMPUTER shows an active count and current watches; stopped watches are
      under collapsed History. Expand a record for its targets and dates.
      Review targets and status, ask what watches are active, or
      cancel one here or by voice. Watching makes no model calls and sends
      no prompts to workers.</p>
    <p>Saved watches survive context/model changes and reloads. They show up in
      the bell when fired, and hands-free with spoken feedback announces them
      after capture or current speech finishes. The Computer watches bell mute
      suppresses notifications and speech. Errors and cancellations are reported
      accurately; a server restart marks unfinished watches interrupted.
      No-history watches remain memory-only, are scoped to that private Computer
      context, never reach saved logs or external notification services, and
      disappear on a full clear or leaving that context.</p>
    <p><strong>Live activity.</strong> ACTIVITY &amp; CONDITIONS in COMPUTER
      shows recent worker/mailbox facts and an agent inbox. Saved Computer
      settings load when its chat is restored after reload; you do not need to
      speak first or press USE AGENT. These controls also work with the mic off.
      Loading and connection errors are shown; use RETRY ACTIVITY if a read fails.
      Arco reports
      activity automatically when it happens; no worker has to remember to
      report it. Conditions check those events immediately, with no polling or
      monitoring model calls. Worker finish means its complete current turn
      and queued messages ended. The recent ledger is bounded metadata, not
      another copy of every conversation: 200 public records retained, 100
      displayed. Computer’s own activity and private chats are excluded.</p>
    <p><strong>Optional agent updates.</strong> Choose OFF, Matched conditions
      only, or Worker completions + matched conditions. This lets your selected
      Computer agent, including Luna, remember factual updates for follow-up
      questions. Updates wait while it is busy, then arrive in a visible
      read-only model turn: no operator tools or worker messages are allowed.
      Your own directives queue as normal follow-ups. Normal provider usage
      applies, capped at 12 update turns per rolling hour, 10 events per batch
      and 50 pending facts; overflow, delivery and failure states are visible.
      CLEAR QUEUED UPDATES discards waiting updates. Failed/interrupted updates
      are not automatically retried. Worker reports themselves cost no model calls.</p>
    <p>These settings belong to this Computer context. Switching agents turns
      off the old feed and cancels its waiting updates; enable the new feed
      separately if wanted. Saved conditions keep running independently.
      No-history settings, inbox and matched-condition data remain memory-only
      and disappear on a full private clear or leaving that context. Saved
      activity uses Arco’s local persistence; no extra service is needed.</p>
    <p>When Computer selects a worker or sends a voice message/nudge to the
      selected worker, its transcript jumps to the latest output and follows
      the reply. Scroll up to pause following. Sending to another worker does
      not move the conversation you are reading.</p>
    <p><strong>Conditional scripts.</strong> Describe the policy you want;
      Computer translates it into conditions and independent actions. It can
      combine busy/idle, queued messages, pending mail, human-input holds,
      context fullness, compaction and event counts across exact worker sets.
      AND/OR/NOT, group/count comparisons, recurrence and ordered clauses let
      you compose behavior without a predefined Director handoff. Unknown
      facts are shown as unknown, never guessed. After restart, saved token
      readings are restored without prompting workers. Compaction invalidates
      old readings until the provider reports a fresh measurement; billing
      totals are never used as context size.</p>
    <p>“Keep nudging the builders for new mail, leave Director alone, and let me
      know when those builders are idle with empty queues and mailboxes” does
      not require any Director action. “Compact Builder 1 at 40%, wait for
      compaction, then tell it to continue” uses the actual worker context and
      compaction lifecycle. Native compaction preserves a summary; Ollama arms
      it for the next turn; the requested continuation starts that turn, which
      compacts before working. Unsupported transports are refused. Worker nudges,
      exact messages and compaction run on the server, including with the mic
      off; scripted screen actions need the owning hands-free browser.</p>
    <p>Scripts hold for human questions by default, optionally for an exact
      subset of workers. Structured questions/approvals are immediate facts;
      ordinary changed replies use a tool-free Luna LOW check, capped at
      24 batches per rolling hour, 16 replies per batch. Normal Codex usage
      applies. The observer never answers a question or grants approval.
      Uncertain, unavailable or truncated text holds the script. Human answers
      allow a new check; review/resume can retry an unknown result. Restoring the
      latest reply scans saved reply events, so later board/activity records
      do not hide a short response. Incomplete or oversized replies still hold,
      with the reason shown in the panel.</p>
    <p>CONDITIONAL SCRIPTS shows the exact declaration, targets, holds, action
      counts and expiry. Its heading counts active and paused scripts
      separately. Armed scripts show their reason and pause/resume/cancel
      controls; stopped scripts are under collapsed <strong>History</strong>
      and cannot run. “0 active” means no active scripts; paused ones stay
      visible so you can resume them. Expand a script for full details, or
      How scripts work for explanations and input-check usage. Pause/resume/cancel here or by voice; the activity
      master switch pauses scripts too. New scripts have <strong>no expiry,
      total-action limit or per-worker-turn limit</strong> unless you request
      one. For example, “Allow 100 turns per worker and stop after six hours.”
      Compaction and continuation each count as a worker action. Cooldown
      defaults to 30 seconds; ask to change it, including zero. The panel shows
      total and per-worker counts, numeric limits or “no limit”, expiry or
      “No expiry”, and cooldown. Idle checks, human-input holds and mail
      deduplication still apply. STOP/error
      stop scripts unless you explicitly ask for handling those events;
      membership changes always stop. Saved scripts survive context changes
      but restart interrupts them without replay. No-history scripts remain
      memory-only and disappear on full clear/leaving that context.</p>
    <p>You can add or change conditions by voice: “Update that script to also
      compact Builder 1 at 40%.” Computer updates the existing script, retaining
      its counts, handled mail and matching completed actions. Existing saved
      scripts retain their limits until you change them. “Remove the time and
      turn limits from that script” changes it in place without resetting
      usage or resending work. Unrelated edits preserve expiry; explicitly
      changing the time limit starts that duration from the update. Removing
      it gives the script no expiry.</p>
    <p><strong>Legacy mailbox rules.</strong> Older fixed-sequence rules remain
      manageable in LEGACY MAILBOX RULES, shown only when there are records or
      an error. Active and paused counts are separate; stopped records are
      collapsed History. New conditional directives use scripts. Say “Nudge Builder 1 in
      SignalQueue, keep nudging it when new mail arrives, then once only the
      Director has mail, nudge the Director and let me know.” Computer binds
      those exact members, nudges an idle selected worker for pending mail,
      then repeats only for new mail. The final recipient must have mail and
      be idle; every other cluster member, including unselected workers, must
      have an empty mailbox and be idle with no queued messages. Then the final
      nudge is dispatched, you are notified, and the rule stops. This confirms
      a nudge, not successful work or project completion.</p>
    <p>Monitoring uses no model calls. Each nudge starts a normal worker turn.
      Limits are <strong>two hours, a 30-second cooldown and eight nudges per
      selected worker</strong>, up to 16 selected workers and one active rule
      per cluster. Unchanged unread mail never repeats; an all-empty cluster
      waits until the final condition or expiry. Rules do not interrupt busy
      workers or queue extra nudges. They stop on worker failure/STOP, membership
      changes, mailbox errors, restart, expiry or the nudge limit. AUTO-PICKUP
      must be off; enabling it stops the rule. Computer never changes it silently.</p>
    <p>In COMPUTER, LEGACY MAILBOX RULES shows identities, status, counts, cooldown,
      expiry and <strong>PAUSE/RESUME/CANCEL RULE</strong>. Enable event automations
      pauses mailbox actions and optional agent updates for this Computer context; completion watches still
      resolve normally. Expiry continues while paused. Ask “What mailbox rules are active?”
      or “Pause that mailbox rule”, “Resume that rule” or “Cancel that mailbox rule.” Cancelling prevents future nudges; started
      turns continue. Saved rules keep running with the browser closed and
      survive context/model changes, but restart requires re-arming. Notifications
      and spoken feedback use the Computer watches mute. Private rules stay in
      memory, disappear on a full private clear or leaving that context, and
      never publish their metadata to saved logs or external notifications.
      Requested nudges still enter the normal destination worker’s history.</p>
    <p>For everything else Computer has a generic mouse and keyboard. It can
      look at the screen and get every visible control numbered and labelled
      (buttons, tabs, fields, toggles, dropdowns, links) grouped by open
      dialog or area with its state; click, toggle, type into or select any of
      them by number or label; inspect dropdown options; set bounded numeric or
      slider values; hover, double-click, open right-click menus, focus fields,
      scroll inside a dialog/panel, press navigation/editing keys; and read
      the words on screen, the whole open dialog or just the section whose
      heading matches a word. Labels come from the controls themselves and
      their contextual-help titles, so new parts of Arco are reachable
      without any voice-specific work. Modals without an accessibility role
      still count as dialogs. Controls whose label says delete, remove,
      discard, purge, kill, wipe, detach, reset, rewind, overwrite or force
      are marked destructive and refuse until you have said yes.</p>
    <p>Every tool call appears in the COMPUTER panel’s transcript, and the tools
      act on your selected project or chat.
      Settings, themes, providers, models, task boards, file views and Git
      controls are reachable through Arco’s interface. Computer checks the
      controls before claiming a capability is unavailable. Normal confirmations
      stay in place. It has no arbitrary host shell or filesystem tool. Browser
      protected actions such as choosing a local upload still need your input;
      a request outside Arco’s interface can be delegated to a worker when you ask.</p>
  </>,
}, {
  id: 'computer-privacy-troubleshooting', group: 'Power features', title: 'Voice: quota, privacy and troubleshooting',
  body: <>
    <p>Recognition (Parakeet, plus a small phrase recognizer for the wake word
      and closings) runs locally; spoken replies use Microsoft Edge neural
      voices when online, Kokoro offline. Computer’s thinking uses
      the selected provider (Codex/Claude subscription or local Ollama/Strata), and its usage shows in the
      COMPUTER panel. No audio is stored. Utterances and replies
      are saved only in saved-history mode; messages sent to workers use
      those workflows’ history. Incognito tabs cannot be messaged by voice.</p>
    <p>If Computer says the page needs a reload, or a yellow RELOAD banner
      appears at the top, this tab is running an older build than the server
      (Arco was rebuilt and restarted under it). “Computer, reload the page,
      over” or the button fixes it. In saved mode, voice decisions and
      tool relays are in the server journal; no-history mode suppresses them:
      <Code>journalctl --user -u archon.service | grep '\[voice'</Code>, so a
      missed wake word or a wrong action can be read back rather than
      guessed at.</p>
  </>,
}];
