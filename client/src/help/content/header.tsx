import { C } from './shared';
import type { HelpEntry } from './shared';

export const headerHelp: Record<string, HelpEntry> = {
  'computer.scripts': {
    title: 'Computer conditional scripts', manualSection: 'computer-tools',
    body: <><p>Describe your conditions and actions in your own words. Computer
      builds a declaration over actual worker state: busy, queues, mail, human
      input, context fullness and compaction. Compose AND/OR/NOT, group/count
      checks, recurrence and ordered steps. Director actions are optional. To discard an unsent voice request, say
      “cancel” alone or “Cancel capture”; that leaves scripts unchanged. An
      unclear “oh cancel” must be clarified before changing a rule.
      Saved token measurements restore after restart without worker prompts;
      compaction invalidates older readings until a fresh measurement.</p>
      <p>The heading separates active and paused counts. Armed scripts show
      their reason and controls; stopped scripts are collapsed History and
      cannot run. Expand a script for targets, counts, expiry and its exact
      declaration; How scripts work contains explanations and input-check usage.
      Add or change
      conditions by voice; updates retain counts and handled mail. Unrelated
      edits preserve expiry; explicitly changing the time limit starts that
      duration from the update, or removes expiry.
      Worker actions run server-side; screen actions need the owning voice
      browser. Unknown facts hold. Structured questions and bounded Luna LOW
      checks of changed replies identify human-input holds; the observer never
      answers. Checks use normal Codex usage, capped at 24 batches/hour. Saved reply
      checks ignore later board/activity payloads; incomplete or oversized
      replies hold with an explanation. Review/resume can retry unknown history.</p>
      <p>Pause/resume/cancel by voice or here; the activity master switch pauses
      scripts too. New scripts have no expiry or action/worker-turn limit
      unless you ask for one. “Allow 100 turns per worker and stop after six
      hours” sets those limits; “Remove the limits from that script” removes
      them in place without resetting counts or resending work. Existing
      numeric limits stay until changed. The panel shows no-limit settings
      and actual counts. Compaction and continuation each count as a worker
      action. Cooldown defaults to 30 seconds and can be changed, including
      zero. Restart interrupts without replay. Private scripts stay in
      memory and disappear with that private context.</p></>,
  },
  'header.computer': {
    title: 'Voice conversation and memory', manualSection: 'computer-conversation',
    body: <p>In the VOICE menu, VOICE CONVERSATION AND MEMORY opens your voice and text conversation with Computer, including its
      replies, tool calls and usage. Type requests or clarifications with the microphone off;
      Enter sends and Shift+Enter adds a line. STOP REQUEST appears in the panel
      header and voice strip while Computer is processing. Pause or cancel
      standing scripts separately under CONDITIONAL SCRIPTS. The panel keeps your
      project selected. Close it with CLOSE or Escape; VOICE CONTROLS opens
      the microphone controls. Choose the agent and saved/no-history mode here.
      Computer remembers requests within the current context, including
      recipients from recent questions and answers: Relay mail followed
      by “nudge the builder” refers to Relay’s unique builder. Multiple
      matching members within that cluster still require clarification.
      Clearing starts fully fresh, without a summary.</p>,
  },
  'computer.activity': {
    title: 'Computer live activity and agent inbox', manualSection: 'computer-tools',
    body: <><p>Arco emits worker, queue and mailbox facts as they happen.
      Conditions react immediately; no recurring scan or browser refresh
      timer. Recent activity is a bounded metadata ledger, not worker text.
      Saved settings load on chat restoration after reload, without speaking
      or pressing USE AGENT, and work with the mic off. Loading/disconnection
      and errors are explicit; RETRY ACTIVITY reloads a failed read.</p>
      <p>Enable event automations pauses this Computer context’s scripts and mailbox actions
      and optional agent updates; waiting updates are cancelled.
      Completion watches still resolve. Agent updates default OFF. Choose
      matched conditions only or worker completions plus matches to send facts
      to this agent, including Luna. They queue while busy and use read-only
      model turns, capped at 12/hour, 10 events/batch and 50 pending facts.
      Normal provider usage applies. Review delivery/overflow/error state or
      clear queued updates here. Background updates cannot use operator tools.</p>
      <p>Switching agents disables the old feed; the new agent opts in
      separately. Private settings and inbox stay in memory and clear with the
      private context. Restart interrupts queued/in-flight updates, without
      replaying them. Existing saved conditions remain independent of context.</p></>,
  },
  'computer.mail-rules': {
    title: 'Computer conditional mailbox rules', manualSection: 'computer-tools',
    body: <><p>Ask Computer to keep nudging named workers for new mail, then
      nudge a named final recipient once only that member has mail. Exact IDs
      bind the rule. Every other cluster member must be idle with an empty
      mailbox and no queued messages; the final recipient must be idle with
      mail. It is nudged once, you are notified, and the rule stops.</p>
      <p>Two-hour limit, 30-second cooldown, eight nudges per selected worker;
      each nudge starts a normal model turn. Monitoring uses no model calls.
      Unchanged mail does not repeat. Event changes trigger checks; cooldown/expiry
      use one-shot deadlines. The section appears only when legacy records
      or errors exist. Active and paused counts are separate; stopped records
      live in collapsed History and cannot run. Review counts and expiry here; pause/resume or cancel
      here or by voice. Already started turns continue. Worker errors/STOP,
      membership changes, AUTO-PICKUP, mailbox errors and restart stop rules.
      AUTO-PICKUP must be off and is never silently changed. Saved rules
      survive browser closure/context changes; private rules stay in memory
      and disappear with their private context. Notifications and speech use
      the Computer watches mute.</p></>,
  },
  'computer.watches': {
    title: 'Computer completion watches', manualSection: 'computer-tools',
    body: <><p>Ask “Let me know when Builder 1 in Relay finishes” to watch
      exactly that worker, or name the cluster to watch all its currently busy
      members. A one-shot watch waits for current turns and queued messages;
      it does not judge whether a project is complete or send workers prompts.
      The active count and current watches are shown first; stopped watches
      move into collapsed History and cannot run. Expand one for targets and
      dates. Review targets and cancel watches here or by voice.</p>
      <p>Saved watches survive context/model changes and reloads. A server restart
      marks unfinished watches interrupted. Failed or cancelled work is never
      announced as success. No-history watches stay in memory, belong to that
      private Computer context, and disappear on a full clear or leaving it.
      Notices appear in the bell; enabled spoken feedback announces them after
      capture/playback finishes. The Computer watches notification mute also
      suppresses speech.</p></>,
  },
  'voice.sensitivity': {
    title: 'Speech sensitivity', manualSection: 'hands-free-voice',
    body: <p>Higher sensitivity lowers the minimum sound level required to start
      a speech segment. Normal is 3.5‰ RMS; High is 2‰; Very high is 1‰.
      Adaptive room-noise rejection still applies. Input peak, room floor and
      speech onset show the actual levels. This preference survives reload and
      applies immediately, without changing system microphone gain. Browser
      automatic gain control is off; echo cancellation and noise suppression
      stay enabled. Capture changes require reload and re-enabling the mic.
      If Last heard
      shows “older” or “over it” instead of “over”, that is a transcription error:
      pause and say “over” separately, or use “End capture”.</p>,
  },
  'computer.context': {
    title: 'Computer context', manualSection: 'computer-conversation',
    body: <><p>The meter shows current context, separate from accumulated usage.
      Full clears default to 50% of the actual window for Codex/Claude, or 75%
      for local Ollama/Strata, after the turn, tools and queued requests finish.
      Pick OFF, 25%, 50% or 75%; KEEP CONTEXT pauses automatic clears.
      CLEAR CONTEXT starts over now; CLEAR AFTER TURN waits while busy.
      Saved transcripts remain available; no-history clears discard them.
      Neither carries old messages or a summary into the new context.
      The panel also shows the last recorded Codex compaction.</p>
      <p>Codex Computer stops after 90 seconds of silent startup, 60 seconds
        without progress, or five minutes in one turn. It replaces its own
        connection, cancels queued requests and speaks the error when hands-free
        is enabled. Actions are never retried automatically; check what already
        happened before repeating a request. Saved history survives recovery;
        a lost private context is cleared visibly. Project workers, ordinary
        chats and local model loads are outside this watchdog.</p></>,
  },
  'voice.hands-free': {
    title: 'Hands-free voice control', manualSection: 'hands-free-voice',
    body: <p>Enable voice here or with Ctrl/Cmd+Shift+Space; off means no
      listening, and close/reload or disconnect turns it off. Say “Computer”,
      wait for the soft double pulse, speak naturally with pauses, then “over” on its own
      to submit (“cancel” discards). Everything goes to Computer and its selected
      agent, with Arco’s controls as tools: an instruction is carried out
      silently like your mouse and keyboard; a question is answered by voice
      after Computer looks it up (the manual, a project’s recent activity, the
      screen, subscription quota); “dictate” sends the exact words. Ask for a
      completion watch by naming a worker or cluster, or a bounded mailbox rule
      to nudge selected workers for new mail before nudging a final recipient. Settings and other Arco
      controls are available through the screen tools. Say “Computer” while it talks to
      stop it and wait; “stop” / “quiet” cut speech and “stop listening”
      releases the microphone, all instantly. Recognition is local; spoken
      reply text goes to Microsoft for online speech, with local Kokoro fallback.
      Choose the agent in COMPUTER; Codex Luna LOW is the default. Cloud agents
      use your existing login; Ollama/Strata use your configured local service.
      See the manual’s Hands-free voice sections.</p>,
  },
  'computer.agent': {
    title: 'Computer agent and history', manualSection: 'computer-conversation',
    body: <p>Choose Codex, Claude, Ollama or Strata and a model/effort. USE AGENT
      waits for the current turn and queue, then uses that selection’s separate
      context. Switching back resumes saved history; no earlier messages are
      copied. No history keeps transcripts in memory until cleared, left,
      reloaded or closed; cloud inference and online speech still receive what
      they process. Strata is saved-only because its service retains logs/cache.
      These controls also work by voice: ask Computer to switch model, clear
      its context, go incognito or save conversations again.</p>,
  },
  'voice.output': {
    title: 'Computer reply voice', manualSection: 'computer-voice-options',
    body: <p>Compare 24 English female voices, grouped and labeled by accent, using
      the same speech service as the current Computer voice. Your choice is saved for this
      browser and applies to the next reply; changing it keeps the current
      conversation, microphone and pending directive. LISTEN plays a short
      sample without a model call or enabling the microphone. When hands-free
      is on, finish the current speech/capture first; the sample uses normal
      interruptible playback. Online speech sends reply text to Microsoft;
      Kokoro remains the offline fallback.</p>,
  },
  // ----------------------------------------------------------------- HEADER
  'header.arco-mark': {
    title: 'ARCO',
    body: <p>The wordmark. Decorative; clicking does nothing.</p>,
  },
  'header.free-vram': {
    title: 'Free local model VRAM',
    body: <p>Unload local Ollama, Strata, DeepSeek/Xolotl, Arco-managed llama.cpp and LM Studio
      models. Finish or cancel active local turns first. Remote endpoints are
      skipped. No model files are deleted; a later request reloads from disk.
      The result reports which runtimes were unloaded, idle or unavailable. It refuses
      during a managed model switch. DeepSeek is stopped; Strata leaves its Python service available for
      reload. It does not schedule an unload for later or stop other applications.</p>,
    manualSection: 'strata-recovery',
  },
  'header.xolotl-version': {
    title: 'Xolotl source version', manualSection: 'deepseek',
    body: <p>Tracks the installed Xolotl checkout revision, including while stopped.
      Compared with upstream HEAD at boot and every four hours. Yellow means the
      revisions differ. Click opens source history inside Arco; equal revisions show
      UP TO DATE. GitHub links are explicit external actions. It does not establish
      the binary build revision or automatically update, rebuild or load anything.</p>,
  },
  'header.strata-version': {
    title: 'Strata engine version', manualSection: 'provider-updates',
    body: <p>Installed engine version from the running Strata service, or the prepared
      engine's BUILD.json while stopped. No model is loaded for the check. Upstream
      engine versions come from the component feed, with release-note/legacy fallbacks,
      at boot and every four hours. App/Terminal 0.2 versions are separate. Click
      opens release notes inside Arco; GitHub is an explicit external link.
      Engine updates are manual and separate from Arco updates. Preserve
      profiles and memory limits, and finish active Strata work before restarting.</p>,
  },
  'header.providers': {
    title: 'Provider dots and Providers panel',
    body: (
      <>
        <p>
          The provider dots show live status; hover one for usage. Click a dot
          to open the Providers panel: per-provider CLI and runtime versions,
          links to the provider usage pages, <C>FREE VRAM</C> (only when a local
          runtime is enabled) and <C>CONNECTIONS</C>.
        </p>
        <p>
          Disabled and un-installed providers drop out of the panel. See the
          panel rows' help for what clicking a version does.
        </p>
      </>
    ),
    manualSection: 'header',
  },
  'header.cli-versions': {
    title: 'CLI version chips',
    body: (
      <>
        <p>
          Live version of each detected provider CLI (Claude / Codex) plus
          Ollama and Strata chips when their servers are reachable, a llama.cpp build chip, and
          a Cursor chip, and XOLOTL / STRATA when installed or enabled, shown in the
          Providers popover. Each chip compares against the upstream latest (npm
          registry for the Claude and Codex CLIs, GitHub Releases for Ollama and
          Strata, refreshed every 4 hours). When the installed version is older than
          the upstream latest,
          the chip border + version text turn warning-color and the tooltip
          reads <C>outdated: vX → vY</C>.
        </p>
        <p>
          Click on Claude / Codex runs the upstream installer
          (<C>claude update</C> or a resolved npm package version) and flashes
          back as <C>v… (latest)</C> or <C>→ vNEW</C>. Click on Ollama opens an
          in-app modal with the last ~10 GitHub releases (themed; markdown notes;
          your installed version is highlighted): Arco can't auto-update
          Ollama since the install path varies by OS. Strata uses the same in-app
          release view, keeping engine and app versions distinct. Xolotl opens
          recent source history in-app and shows UP TO DATE when revisions match.
          GitHub links are explicit external actions. Runtime updates remain manual.
        </p>
        <p>For npm CLIs with their own platform package, Arco checks that the
          matching binary is published before installing. It can keep or select an
          older installable version and show <C>v… (!)</C>; hover for the notice.
          A broken installed executable is distinct from a missing CLI.</p>
        <p>
          Chips for providers you've disabled in Settings or for un-installed
          CLIs are hidden automatically.
        </p>
      </>
    ),
    manualSection: 'provider-updates',
  },
  'header.workflow-status': {
    title: 'Provider throttling',
    body: (
      <p>
        This warning appears when a provider is throttled. Open it to see the
        affected providers and their known reset times. It remains visible in
        focus mode. Context usage remains in each worker header.
      </p>
    ),
  },
  'header.knowledge': {
    title: 'Knowledge menu',
    body: (
      <p>
        Folds the knowledge surfaces behind one trigger: <C>Recall</C> (search
        every past conversation by keyword), <C>Plans</C> (every plan across
        projects) and <C>Artifacts</C> (the read-only window of what agents produced).
        Click to open; pick an item to launch it. See each item's own help for
        detail.
      </p>
    ),
    manualSection: 'header',
  },
  'header.tools': {
    title: 'Tools menu',
    body: (
      <>
        <p><C>Terminal</C> (a terminal in the active tab&apos;s folder), <C>GitHub</C> (the repository browser) and <C>Media</C> (image, audio and video studio) in one menu.</p>
        <p>The button shows a dot while something inside is open, such as the GitHub browser. Terminal is unavailable until a tab is open. See each item&apos;s own help for detail.</p>
      </>
    ),
    manualSection: 'header',
  },
  'header.auth-chip': {
    title: 'Auth chip',
    body: (
      <p>
        Claude CLI auth status. Appears only when <code>claude auth status</code>{' '}
        actually reports logged out (a failed status check never counts), and clears
        on its own once the login is back. Click for the login command, run in
        Arco's terminal.
      </p>
    ),
  },
  'header.hub-link': {
    title: 'Hub link',
    body: (
      <>
        <p>Shows whether this Arco is linked to a remote management hub. A <strong>filled dot</strong> means connected; a hollow dot means set up but disconnected. <C>N monitored</C> is how many of your tabs are shared with the phone console; only those appear there and send phone notifications. Share a tab with <C>REMOTE</C> in its message box.</p>
        <p>Click to <C>disconnect</C>, which cuts all remote control until you reconnect, or to reconnect. Shown only when a hub is configured (<C>ARCO_HUB_URL</C>).</p>
      </>
    ),
  },
  'header.github': {
    title: 'GitHub browser',
    body: (
      <p>
        Toggles the full-screen GitHub browser: repos, file trees, PRs, issues,
        Actions runs, branches, commits, clone, and opening a new PR. Uses your
        local <C>gh auth</C>. The breadcrumb trail (<C>REPOS</C> and the path
        below it) returns to an earlier level, and <C>CLOSE</C> leaves the
        browser. When the GitHub CLI is not signed in, <C>OPEN SETTINGS TO LOG IN</C>{' '}
        opens Settings, where the GitHub sign-in lives.
      </p>
    ),
    manualSection: 'github',
  },
  'header.terminal': {
    title: 'Terminal launcher',
    body: <p>Opens a real terminal in a floating window, starting in the active tab&apos;s project folder. <strong>Closing the window leaves the shell running</strong>, so a dev server keeps going; reopening shows it again. Only <C>KILL</C> ends it. The terminal is yours alone; the agent cannot type into it. Unavailable until a tab is open. See &quot;The integrated terminal&quot;.</p>,
    manualSection: 'integrated-terminal',
  },
  'header.settings': {
    title: 'Settings',
    body: <p>Settings for all of Arco: providers and sign-in, themes, your name in chat, model lists and more. Settings for one tab live in that tab&apos;s CONFIG panel.</p>,
    manualSection: 'settings-providers',
  },
  'header.help': {
    title: 'Help menu',
    body: <p>Three entries: <C>POINT AT THINGS</C> (contextual help mode: click any control to see what it does, Esc exits), <C>USER MANUAL</C> and <C>KEYBOARD SHORTCUTS</C>.</p>,
    manualSection: 'help-system',
  },
  'header.shortcuts': {
    title: 'Keyboard shortcuts',
    body: <p>Opens the shortcut cheat sheet. Ctrl or Cmd + ? toggles it from anywhere.</p>,
    manualSection: 'help-system',
  },
  'header.manual': {
    title: 'User manual',
    body: <p>In the HELP menu: opens the full user manual, every feature, every quirk, indexed.</p>,
    manualSection: 'help-system',
  },
  'header.question-toast': {
    title: 'Question notification',
    body: <p>Select the notification to open the worker waiting for an answer.</p>,
    manualSection: 'tab-bar',
  },
  'header.notifications': {
    title: 'Notifications',
    body: (
      <>
        <p>
          Workbench event notices: a long turn finished, a provider's quota
          recovered, a terminal exited non-zero, and more. A badge counts unread
          notices; each also flashes a transient toast. Click the bell for the
          durable history.
        </p>
        <p>
          <strong>Mute per category</strong> from the dropdown's MUTE section:
          muting is enforced server-side (a muted category never broadcasts) and
          persists across restarts. Inform-only: notifications never accept
          commands.
        </p>
      </>
    ),
  },
  'header.focus': {
    title: 'Focus mode',
    body: (
      <>
        <p>Hides secondary controls so the chat can use the full width while an agent works: the right panel, provider status, the KNOWLEDGE and TOOLS menus, Help and Settings.</p>
        <p>Urgent items stay: the provider throttling warning, connection status, the system menu, and this button (now <C>EXIT FOCUS</C>). Fully reversible; the choice is remembered across reloads.</p>
      </>
    ),
  },
  'header.connection-status': {
    title: 'Connection status',
    body: <p><strong>ONLINE</strong>: connected and every tab loaded, shown as a small light with no label. <strong>SYNCING</strong>: connected and still loading saved tabs. <strong>OFFLINE</strong>: the connection to Arco is down, and <C>RECONNECT</C> and <C>RESTART</C> appear. The light and label grow only when the connection is not healthy.</p>,
    manualSection: 'offline',
  },
  'header.power': {
    title: 'System menu',
    body: (
      <>
        <p>Opens the System window. <C>Actions</C> restarts or quits Arco; a restart stops running turns, and saved tabs come back from their history. <C>Diagnostics</C> runs read-only health and exposure checks. <C>Models</C> shows local models for Ollama and llama.cpp. <C>Services</C> lists local web and dev services on this computer.</p>
        <p>After an unclean stop, Arco checks leftover worker and terminal processes against their start times before cleaning up. On Windows that check gives up after eight seconds; a process whose start time is unknown is left alone and checked again later.</p>
        <p>Unavailable while offline.</p>
      </>
    ),
  },
  'header.version': {
    title: 'Arco version',
    manualSection: 'arco-updates',
    body: (
      <>
        <p>
          Sits left of the power button and always shows the running Arco
          version. When the release check finds a newer release it turns into
          an accent box with an up arrow, the new version and a dot, and stays
          that way until Arco is on the latest release; DISMISS on the large
          notice only hides the notice.
        </p>
        <p>
          Click it with an update available to open the Confirm update dialog
          (or the copyable command on installs that cannot update themselves).
          Otherwise it opens the running and latest known version, the last
          check time, <C>CHECK NOW</C>, a release-notes link and a link to
          Settings &gt; Advanced &gt; CLI and runtime versions. While an update
          runs it reads <C>UPDATING</C>. With release checks off it shows the
          running version only.
        </p>
      </>
    ),
  },
  'header.live-status': {
    title: 'Live provider status',
    body: (
      <>
        <p>
          Compact provider dots show live, ready or down status. <C>C</C> is
          Claude, <C>X</C> Codex, <C>R</C> Cursor and <C>O</C> Ollama.
        </p>
        <p>
          Hover or keyboard-focus a dot for the full detail it used to show as a boxed pill:
          Claude's 5-hour + weekly burn (polled every 3 minutes), Codex subscription quota from its app-server, Cursor's included-plan gauge plus its separate Other Models
          quota bar, or Ollama's loaded-model list with unload times. Hidden when no
          enabled provider is signed in. Providers disabled in Settings show no dot or popover.
        </p>
        <p>Claude and Codex include a refresh button beside the provider name. Sign-in and account detail is in Connections and Settings.</p>
        <p>The Claude dot itself still shows the selected transport's sign-in state. Usage-limits errors describe the meter and do not invalidate execution authentication. Recovery follows the selected Claude transport.</p>
        <p>A usage limits snapshot is retained as stale only for unchanged credentials, and the refresh button asks for a fresh check. CLI refresh remains owned by Claude CLI.</p>
      </>
    ),
  },
  'header.archive': {
    title: 'Artifacts',
    body: (
      <>
        <p>
          Opens the standalone <strong>ARTIFACTS</strong> window: a chromeless,
          read-only project-artifact explorer in its own browser window
          (<C>?app=explorer</C>). Four lenses: <C>ARTIFACTS</C> (project cards +
          agent-produced artifacts, the landing home), <C>RECENTS</C> (recently
          written / changed files), <C>PLANS</C> (every plan across projects:
          the plans library), and <C>TREE</C> (the raw file tree).
        </p>
        <p>
          Opens as a same-browser popup so it inherits the correct per-monitor
          DPI; if the popup is refused it falls back to a server-spawned
          chromeless window, then a plain new tab. Read-only apart from plan
          edits in PLANS: zero model authority.
        </p>
      </>
    ),
    manualSection: 'archive-explorer',
  },
  'header.plans': {
    title: 'All plans',
    body: (
      <p>
        Opens the ARTIFACTS window on its <C>PLANS</C> lens: every plan across
        every known project, filterable by active / completed. Review, edit,
        tick, complete, or delete a plan and read its reference docs without
        attaching it to a workflow.
      </p>
    ),
    manualSection: 'plans-library',
  },
  'voice.panel': {
    title: 'Hands-free controls', manualSection: 'hands-free-voice',
    body: <p>The strip below the header shows what voice is doing. ENABLE HANDS-FREE starts listening and DISABLE · MIC OFF stops it; QUIET stops the current spoken reply. During a capture, END CAPTURE submits what was heard and CANCEL CAPTURE discards it. OPEN COMPUTER shows Computer's conversation while it works. DETAILS (LESS to hide) shows the last phrase heard, speech sensitivity, the Spoken feedback checkbox for spoken replies, and the checkbox that sends everything that is not a dictation to Computer and its selected agent. When voice asks a question, its choices appear as buttons.</p>,
  },
};
