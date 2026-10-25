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
    title: 'Computer conversation', manualSection: 'computer-conversation',
    body: <p>Open your voice and text conversation with Computer, including its
      replies, tool calls and usage. Type requests or clarifications with the microphone off;
      Enter sends and Shift+Enter adds a line. STOP REQUEST appears in the panel
      header and voice strip while Computer is processing. Pause or cancel
      standing scripts separately under CONDITIONAL SCRIPTS. The panel keeps your
      project selected. Close it with CLOSE or Escape; VOICE CONTROLS opens
      the microphone controls. Choose the agent and saved/no-history mode here.
      Computer remembers requests within the current context, including
      recipients from recent questions and answers: SignalQueue mail followed
      by “nudge the builder” refers to SignalQueue’s unique builder. Multiple
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
    body: <><p>Ask “Let me know when Builder 1 in SignalQueue finishes” to watch
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
  'header.archon-mark': {
    title: 'ARCO',
    body: <p>The wordmark. Decorative — clicking does nothing.</p>,
  },
  'header.free-vram': {
    title: 'Free local model VRAM',
    body: <p>Unload local Ollama, Strata, DeepSeek/Xolotl, Archon-managed llama.cpp and LM Studio
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
    title: 'Providers popover',
    body: (
      <>
        <p>
          Folds the per-provider version chips behind one trigger so the header
          carries status, not clutter. The dot on the trigger turns
          warning-color when <em>any</em> provider has an update available;
          click to open the full per-provider grid.
        </p>
        <p>
          Disabled / un-installed providers drop out of both the dot and the
          grid. See the grid help for what clicking a chip does.
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
          Live version of each detected provider CLI (Claude / Gemini / Codex) plus
          Ollama and Strata chips when their servers are reachable, a llama.cpp build chip, and
          a Cursor chip, shown in the Providers popover. Each chip compares against the upstream latest (npm registry
          for the three CLIs, GitHub Releases for Ollama and Strata, refreshed every 4
          hours). When the installed version is older than the upstream latest,
          the chip border + version text turn warning-color and the tooltip
          reads <C>outdated: vX → vY</C>.
        </p>
        <p>
          Click on Claude / Gemini / Codex runs the upstream installer
          (<C>claude update</C> or a resolved npm package version) and flashes
          back as <C>v… (latest)</C> or <C>→ vNEW</C>. Click on Ollama opens an
          in-app modal with the last ~10 GitHub releases (themed; markdown notes;
          your installed version is highlighted) — Arco can't auto-update
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
    title: 'Workflow status chip',
    body: (
      <>
        <p>
          One compact chip folding the two pieces of urgent runtime state:{' '}
          <strong>context fill</strong> for the active workflow (<C>◔ %</C>,
          escalating green → amber → red as the window fills) and{' '}
          <strong>provider quota</strong> (<C>⚠ N</C> when any provider is
          throttled).
        </p>
        <p>
          Click for details — exact context tokens / window size with a fill
          bar, plus per-provider quota status and reset times. Hidden entirely
          when there's no active-workflow context reading and nothing is
          throttled.
        </p>
      </>
    ),
  },
  'header.knowledge': {
    title: 'Knowledge menu',
    body: (
      <p>
        Folds the knowledge surfaces behind one trigger — <C>Recall</C> (search
        every past conversation by keyword) and <C>Cookbook</C> (the fit-scored
        local-model catalog). Click to open; pick an item to launch it. See each
        item's own help for detail.
      </p>
    ),
    manualSection: 'header',
  },
  'header.tools': {
    title: 'Tools menu',
    body: (
      <>
        <p>
          Folds the content + integration surfaces behind one trigger —{' '}
          <C>Media</C> (image/audio/video studio), <C>GitHub</C> (the repo
          browser), and <C>Terminal</C> (a PTY in the active workflow root).
        </p>
        <p>
          The trigger shows an accent dot when something inside is active (e.g.
          the GitHub browser is open). Terminal is disabled until a workflow is
          open. See each item's own help for detail.
        </p>
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
        <p>
          Shows whether this instance is linked to a remote-management hub over
          the tailnet. A <strong>filled dot</strong> (<C>●</C>) means connected;
          hollow (<C>○</C>) means configured but disconnected. <C>N monitored</C>{' '}
          is how many of your workflows are opted in to remote — only those appear
          in the mobile console and push phone notifications (toggle per workflow
          with <C>◉ REMOTE</C> in the composer).
        </p>
        <p>
          Click to <C>disconnect</C> (a local kill switch that severs all remote
          control until you reconnect), or to reconnect. Only appears when a hub
          is configured (<C>ARCHON_HUB_URL</C>).
        </p>
      </>
    ),
  },
  'header.github': {
    title: 'GitHub browser',
    body: (
      <p>
        Toggles the full-screen GitHub browser — repos, file trees, PRs, issues,
        Actions runs, branches, commits, clone, and opening a new PR. Uses your
        local <C>gh auth</C>.
      </p>
    ),
    manualSection: 'github',
  },
  'header.terminal': {
    title: 'Terminal launcher',
    body: (
      <p>
        Opens a real PTY-backed terminal in a floating window, rooted at the
        active workflow's directory. The shell is a long-lived workflow
        resource: <strong>closing the window detaches</strong> (a{' '}
        <C>npm run dev</C> keeps running) — reopening re-attaches and repaints.
        Only <C>KILL</C> ends it. Operator-only; the agent can never drive it.
        Disabled until a workflow is open. See "The integrated terminal".
      </p>
    ),
    manualSection: 'integrated-terminal',
  },
  'header.settings': {
    title: 'Settings',
    body: (
      <p>
        Operator-global settings — provider toggles, auth, themes, operator name,
        catalog. Per-workflow config lives in the CONFIG tab of the right pane.
      </p>
    ),
    manualSection: 'settings-providers',
  },
  'header.manual': {
    title: 'User manual',
    body: <p>Opens the full user manual — every feature, every quirk, indexed.</p>,
    manualSection: 'help-system',
  },
  'header.notifications': {
    title: 'Notifications',
    body: (
      <>
        <p>
          Workbench event notices — a long turn finished, a provider's quota
          recovered, a terminal exited non-zero, and more. A badge counts unread
          notices; each also flashes a transient toast. Click the bell for the
          durable history.
        </p>
        <p>
          <strong>Mute per category</strong> from the dropdown's MUTE section —
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
        <p>
          Hides secondary chrome for a full-width chat while an agent works: the
          right panel (+ its splitter), the providers popover / live-status dots
          / auth chip, the KNOWLEDGE / TOOLS dropdowns, the ⌸ ARCHIVE button, and Settings / Manual.
        </p>
        <p>
          Urgent state stays — the workflow status chip (context + quota),
          connection health, the ⏻ system menu, and this toggle (now{' '}
          <C>◳ EXIT FOCUS</C>). Operator-armed and fully reversible; the choice
          persists across reloads.
        </p>
      </>
    ),
  },
  'header.connection-status': {
    title: 'Connection status',
    body: (
      <>
        <p>Three states:</p>
        <ul style={{ margin: '4px 0', paddingLeft: '18px' }}>
          <li><strong>● ONLINE</strong> — WS connected, all workflows replayed.</li>
          <li><strong>● SYNCING…</strong> — connected, replaying persisted workflows.</li>
          <li><strong>● OFFLINE</strong> — WS down. <C>RECONNECT</C> and <C>RESTART</C> actions appear.</li>
        </ul>
      </>
    ),
    manualSection: 'offline',
  },
  'header.power': {
    title: 'System menu (⏻)',
    body: (
      <>
        <p>
          Opens the System modal. Tabs: <C>Actions</C> (restart / quit Arco —
          restart preserves all workflows; they replay from <C>events.jsonl</C>),
          <C>Diagnostics</C> (read-only health + exposure-posture checks),{' '}
          <C>Models</C> (Ollama / llama.cpp / Cookbook readout), and <C>Services</C>
          (machine-wide local web/dev service browser).
        </p>
        <p>Disabled when offline.</p>
      </>
    ),
  },
  'header.live-status': {
    title: 'Live provider status',
    body: (
      <>
        <p>
          A compact dot per authed/enabled provider — green ● = live, hollow ○ =
          ready/idle, red ● = down. <C>C</C> Claude, <C>G</C> Gemini, <C>X</C>{' '}
          Codex, <C>Z</C> Z.ai, <C>R</C> Cursor, <C>O</C> Ollama.
        </p>
        <p>
          Hover a dot for the full detail it used to show as a boxed pill:
          Claude's 5-hour + weekly burn (polled every 3 minutes), Codex's usage
          scrape, Cursor's included-plan gauge plus its separate Other Models
          quota bar, or Ollama's loaded-model list with unload times. Hidden when no
          provider is authed.
        </p>
      </>
    ),
  },
  'header.archive': {
    title: 'Archive',
    body: (
      <>
        <p>
          Opens the standalone <strong>ARCHIVE</strong> window — a chromeless,
          read-only project-artifact explorer in its own browser window
          (<C>?app=explorer</C>). Four lenses: <C>ARTIFACTS</C> (project cards +
          agent-produced artifacts, the landing home), <C>RECENTS</C> (recently
          written / changed files), <C>PLANS</C> (every plan across projects —
          the plans library), and <C>TREE</C> (the raw file tree).
        </p>
        <p>
          Opens as a same-browser popup so it inherits the correct per-monitor
          DPI; if the popup is refused it falls back to a server-spawned
          chromeless window, then a plain new tab. Read-only apart from plan
          edits in PLANS — zero model authority.
        </p>
      </>
    ),
    manualSection: 'archive-explorer',
  },
  'header.plans': {
    title: 'All plans',
    body: (
      <p>
        Opens the ARCHIVE window on its <C>PLANS</C> lens — every plan across
        every known project, filterable by active / completed. Review, edit,
        tick, complete, or delete a plan and read its reference docs without
        attaching it to a workflow.
      </p>
    ),
    manualSection: 'plans-library',
  },
};
