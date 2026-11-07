import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Note, Kbd, Table } from '../../components/UserManual/components';

export const workspace: Section[] = [
  {
    id: 'header',
    group: 'The workspace',
    title: 'The top header',
    body: (
      <>
        <p>
          The header is the persistent chrome at the top of every screen. Left
          to right:
        </p>
        <p>
          Dialogs open at sizes suited to their content. Drag Resize or use its
          arrow keys to change the size. Maximize fills the window; Restore
          returns to the previous size. Arco remembers the size for that kind
          of dialog in this browser. Reset size or Home restores the default.
        </p>
        <ul>
          <li>
            <strong>ARCO</strong> - the wordmark. On Home it is hidden in the
            header while Home shows a greeting; elsewhere it is
            decoration. When a hub is configured, a{' '}
            <strong>hub-link chip</strong> sits beside it.
          </li>
          <li>
            <strong>Layout switch</strong> - beside the wordmark. It shows the
            current layout (for example <Code>AUTO: COMPACT</Code>) and each click
            moves to the next choice: Automatic, Standard, Compact, Narrow. See
            Window size and layout.
          </li>
          <li>
            <strong>Provider throttling</strong> - appears only when a provider
            is throttled. Open it for affected providers and known reset times.
            The warning stays visible in focus mode. Context usage stays in
            each worker header.
          </li>
          <li>
            <strong>Providers panel</strong> - click a provider dot (see
            Live-status dots) to open it. It folds the per-provider version
            chips (Claude / Codex, plus Ollama when the daemon is reachable, a
            llama.cpp build chip, a Cursor chip, and XOLOTL / STRATA when
            installed or enabled) into one grid, and also holds links to
            the provider usage pages, <Code>FREE VRAM</Code> (shown only while a
            local runtime such as Ollama, llama.cpp, LM Studio, Strata or Xolotl
            is enabled and connected) and <Code>CONNECTIONS</Code>. Each chip compares against the upstream latest - npm registry
            for the Claude and Codex CLIs, GitHub Releases for Ollama and
            Strata, refreshed every 4 hours. When the installed version is older
            than the upstream latest, the chip turns warning-color and the
            tooltip reads <Code>outdated: vX → vY</Code>.
            <br />
            Clicking a Claude / Codex chip runs the upstream installer (
            <Code>claude update</Code> or a resolved npm package version) and
            flashes back as <Code>v... (latest)</Code> or <Code>→ vNEW</Code>.
            If an npm platform binary is not yet published, an older installable
            version can be retained/selected with a <Code>v... (!)</Code>{' '}
            notice. See Provider updates for broken-versus-missing status and
            recovery. Clicking Ollama, Strata or Xolotl opens an in-app releases
            modal; Arco does not auto-update those runtimes.
            <br />
            Chips are hidden for providers disabled in Settings or for CLIs that
            are not installed.
          </li>
          <li>
            <strong>Live-status dots</strong> - when at least one provider is
            authed, a compact dot per provider (<Code>A</Code> Claude,{' '}
            <Code>C</Code> Codex, <Code>X</Code> Cursor, <Code>O</Code> Ollama):
            green ● live, hollow ○ idle, red ● down. Click a dot to open the
            Providers panel. Hover a dot for its usage detail - Claude&apos;s 5-hour and weekly burn (polled every 3
            minutes), Codex usage, Cursor&apos;s included-plan and Other Models
            bars, or Ollama&apos;s loaded models.
          </li>
          <li>
            <strong>Auth chip</strong> - at-a-glance status of Claude auth.
            Pulses when re-login is needed; click to start the re-login flow.
            A click outside its panel or Escape closes the panel.
          </li>
          <li>
            <strong>KNOWLEDGE dropdown</strong> - RECALL (search past
            conversations), PLANS (every plan across projects) and ARTIFACTS
            (the standalone chromeless file-explorer window: agent
            artifacts, recents, plans, storage, tree).
          </li>
          <li>
            <strong>TOOLS dropdown</strong> - TERMINAL (a PTY in the active
            workflow root; disabled until a workflow is open),{' '}
            <strong>◆ GITHUB</strong> (toggles the GitHub browser: repos, PRs,
            issues, Actions, clone) and MEDIA (image/audio/video studio).
          </li>
          <li>
            <strong>VOICE</strong> - one control: the left part turns the
            microphone on or off (or opens voice setup when speech models are not
            installed); the arrow opens VOICE CONVERSATION AND MEMORY, VOICE
            CONTROLS and, when needed, SET UP VOICE.
          </li>
          <li>
            <strong>Connection light</strong> - a small light: green = WS
            connected and all persisted workflows have replayed, amber{' '}
            <Code>SYNCING…</Code> = WS up but some workflow is still catching up,
            red <Code>OFFLINE</Code> = WS down (the label, <Code>RECONNECT</Code>{' '}
            and <Code>RESTART</Code> appear only then).
          </li>
          <li>
            <strong>Notification bell</strong> - durable workbench-notice
            history with per-category mute. Stays visible in focus mode.
          </li>
          <li>
            <strong>◳ FOCUS</strong> - hides the right panel + secondary header
            chrome for a full-width chat (reversible; persists).
          </li>
          <li>
            <strong>HELP</strong> - POINT AT THINGS (contextual help mode),
            USER MANUAL (this manual) and KEYBOARD SHORTCUTS.
          </li>
          <li>
            <strong>⚙ SETTINGS</strong> - opens the settings modal. The version
            box follows it.
          </li>
          <li>
            <strong>⏻</strong> - opens the System modal: Actions (restart / quit
            Arco), Diagnostics (read-only health + exposure-posture checks),
            Models (Ollama / llama.cpp / model-files readout), and Services
            (machine-wide local web/dev service browser).
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'tab-bar',
    group: 'The workspace',
    title: 'The tab bar',
    body: (
      <>
        <p>
          The tab bar holds one tab per open workflow and keeps that set on the
          server so every client sees the same tabs.
        </p>
        <p>
          One tab per workflow (Agent or Chat). Each tab shows the workflow
          name and a status dot: Working while a turn runs, Needs you while a
          worker waits for an answer or an idle member has mail, and New reply
          when a turn finished while you were elsewhere.
        </p>
        <p>
          Idle has no dot. Hover
          over the tab for its status. New reply clears when you open the
          tab; cluster tabs combine their members. Home Continue cards show the
          status in words.
        </p>
        <p>
          On Codex tabs bound to a named account profile, a
          short account badge also appears. Click a tab to focus it; drag tabs to
          reorder them.
        </p>
        <p>
          Click the <Code>×</Code> on a tab to close it: Arco asks for
          confirmation first, and the prompt calls out an in-progress turn (it
          will be cancelled) or an unsaved Incognito chat (it will be lost).{' '}A
          saved workflow stays on disk when the tab closes. Reopen it through
          RESUME (project sessions) or PAST CHATS (saved chats).
        </p>
        <p>
          The trailing <Code>+</Code> button opens the workflow creator (same as{' '}
          <Kbd>Ctrl/Cmd+K</Kbd>).
        </p>
        <p>
          A second tab kind, the <strong>cluster parent</strong>, hosts N member
          workflows pinned to one cwd. Cluster parent tabs are created by
          right-clicking a regular tab (CREATE WITH EXISTING / CREATE WITH
          FRESH); they show their members as a row of sub-tabs underneath. See
          the Clusters group for details.
        </p>
        <h4 className="manual-sub">Tabs follow the server, not the browser</h4>
        <p>
          The set of
          open tabs lives on the Arco server, so every computer and browser
          pointed at it (the host itself, a laptop on the same private network, ...)
          shows the same tabs, transcripts, and CONFIG settings.
        </p>
        <p>
          Opening or
          closing a tab anywhere does the same everywhere, live; tab order is
          shared too. Which tab is <em>focused</em> stays per-browser, and
          Incognito chats stay in the browser that opened them (they are never
          stored on the server).
        </p>
        <p>
          The first time a browser connects after this
          shipped, any tabs it had locally are merged in.
        </p>
        <Note kind="warn">
          Within one browser Arco still refuses a second window against the same
          server - it gets the <em>Duplicate Tab</em> overlay. Different
          browsers or computers are fine and mirror each other.
        </Note>
      </>
    ),
  },
  {
    id: 'home',
    group: 'The workspace',
    title: 'Home and projects',
    body: (
      <>
        <p>
          Home greets the operator by the name entered in Welcome and shows provider,
          running work, waiting questions and version status. The start tiles open
          chat, session and cluster creators; More ways to start offers Genesis.
        </p>
        <h4 className="manual-sub">Continue and projects</h4>
        <p>
          Getting started tracks provider connection, a project folder and a first conversation (any chat, session or cluster), and HIDE keeps it hidden on this browser. If browser storage is unavailable, HIDE applies until this view reloads.
          Continue lists open work with waiting questions first and current steps for
          running work. Resume returns to a tab; Show all expands the two-row list.
        </p>
        <p>
          The project grid lists available location folders and bookmarks alphabetically. Recently used lists existing folders separately by activity. Pinned shows pinned folders. Temporary folders are excluded.
          It shows two rows; Show all opens the rest, and a search lists every match.
        </p>
        <p>
          Filter by location or search by name or path (press <Kbd>/</Kbd>).
          New session opens a creator with the folder prefilled. The project menu
          offers New cluster, Saved sessions, Pin and Manage. A display name appears below the folder name.
        </p>
        <h4 className="manual-sub">Locations and terminal sessions</h4>
        <p>
          Add a location or open another folder from Home. Relocation changes the reference without
          moving files; removing a bookmark does not delete files or sessions.
          When local Claude Code or Codex history matches a project, the project menu
          offers Continue a session from the terminal.
        </p>
        <p>
          The session creator offers it too. OPEN starts the matching provider
          session; close the terminal first to avoid concurrent writes. Claude uses
          the connected CLI; Codex uses the terminal account. Discovery reads history
          in place; Docker needs the provider history folders mounted.
        </p>
        <p>
          Use <Code>Settings &gt; Projects</Code> to manage registered, scanned,
          and recent folders, choose the{' '}
          <strong>Default browsing location</strong> (where folder navigation
          starts), and configure project trust. Home is for resuming work and
          starting from a project card. The full category and control map is in{' '}
          <Code>docs/SETTINGS.md</Code>.
        </p>
        <Note kind="tip">
          Settings &gt; Projects &gt; Bookmarked folders can relocate a missing folder reference. Saved work stays associated with the project
          record; choose the folder&apos;s new location to resume from it.
        </Note>
      </>
    ),
  },
  {
    id: 'chat-panel',
    group: 'The workspace',
    title: 'The chat panel',
    body: (
      <>
  <p>Selecting a HISTORY message expands PRIOR SESSIONS when needed, then scrolls to and highlights the requested message.</p>
  <p>Claude Native questions offer complete answer options, including literal pipes and backslashes. Choose an option or type an answer to resume the waiting agent.</p>
<p>Application JSON remains visible even when it uses workers, stateMutations or qualityVerdicts keys. Valid legacy internal envelopes and arco-artifact fences use compact summaries. Windows drive and UNC filenames work as file references.</p>
        <p>
          After a file-changing turn, a changed-files line opens that turn's
          captured checkpoint diff. UNDO THIS TURN uses the existing restore
          confirmation and safety snapshot; restoring also reverts later work
          in that folder. After it runs the line reads Undone and
          UNDO THIS TURN stays disabled.
        </p>
        <h4 className="manual-sub">Chat controls</h4>
        <p>
          When another managed writer overlapped, the line
          names that fact and offers VIEW DIFF only. External writers are not
          detected, and Git-ignored files are outside the checkpoint. Slow or
          failed captures produce no line; isolated scratch members do not use
          project checkpoint actions.
        </p>
        <p>
          The chat panel is the transcript for the focused workflow. It takes
          the left two-thirds of the screen. It renders the conversation
          tail-first: on first open, the last 200 entries are shown, with an{' '}
          <Code>↑ LOAD EARLIER MESSAGES</Code> pill at the top to page further
          back. Scroll position is preserved when paging.
        </p>
        <p>
          <strong>Message types:</strong>
        </p>
        <ul>
          <li>
            <strong>You</strong> - the operator&apos;s prompts. Long messages
            collapse to a preview with an expand toggle.
          </li>
          <li>
            <strong>Agent</strong> - the primary&apos;s reply. Streams
            token-by-token while the turn is in flight.
          </li>
          <li>
            <strong>Thinking</strong> - collapsible reasoning block from Claude
            / Codex / Ollama (when the model exposes it).
          </li>
          <li>
            <strong>Tool-call pills</strong> - inline rows between assistant
            bubbles for Bash / Read / Grep / WebFetch / etc. Click to expand the
            JSON input. Click a file path inside to open the viewer modal.
            (Claude CLI only - they come from the Claude session file; on other transports tool calls show in ACTIVITY.)
          </li>
          <li>
            <strong>Inline artifacts</strong> - fenced{' '}
            <Code>```arco-artifact</Code> blocks the agent emits. Render as
            click-to-expand pills.
          </li>
          <li>
            <strong>HANDOFF SEED / SPAWN SEED</strong> - the first user message
            in a rotated session. Collapsed to a one-line pill so a 300-line
            user bubble is not shown. Click to expand.
          </li>
          <li>
            <strong>System notices</strong> - out-of-band warnings (rate-limits,
            retries, concurrent-writer warnings, calibration completion,
            threshold crossings).
          </li>
        </ul>
        <Note kind="tip">
          Links the agent emits open in a new browser tab - clicking a URL never
          navigates the whole Arco app away.
        </Note>
      </>
    ),
  },
  {
    id: 'composer',
    group: 'The workspace',
    title: 'The composer (terminal input)',
    body: (
      <>
  <p>SEND waits until all attachment upload batches finish. A second paste or drop does not release that guard early.</p>
      <p>While Genesis moves conversation storage, new messages are refused before acknowledgement. Wait for the active folder to be ready, then resend. STOP does not interrupt this storage move.</p>
  <p>Follow-ups are associated with the turn that actually receives them. Inputs dispatched together stay together in restored context and reviews. Steering retains its delivery position; a late acknowledgement does not move it into a newer turn.</p>
        <p>
          The composer is the prompt box at the bottom of the chat panel. It has
          two modes. A status line groups the north star, pending messages,
          compaction continuation and selected skills. Hover a chip for details;
          select PENDING to inspect or cancel messages.
        </p>
        <ul>
          <li>
            <strong>Idle</strong> - when the agent is waiting. <Kbd>Enter</Kbd>{' '}
            sends. <Kbd>Shift+Enter</Kbd> inserts a newline. <Kbd>Ctrl+K</Kbd>{' '}
            deletes from the cursor to the end of the line (readline-style, no
            clipboard).
          </li>
          <li>
            <strong>Queue (busy turn)</strong> - when a turn is in flight, the
            composer routes to a structured queue with two intents:{' '}
            <Kbd>Enter</Kbd> queues as <strong>steer</strong> (&quot;do this now
            / change direction&quot;) and <Kbd>Alt+Enter</Kbd> queues as{' '}
            <strong>follow-up</strong> (&quot;after the current task
            lands&quot;). Steer is delivered mid-turn on Claude Native, Codex
            app-server, Ollama, llama.cpp, and LM Studio; other transports drain
            queued messages after the current turn settles. The PENDING chip opens their details and cancellation controls. <Kbd>Alt+↑</Kbd>{' '}
            recalls the most recent queued message into the editor. For Claude
            and Codex, <Code>SEND</Code> keeps the ordinary Enter behavior;{' '}
            <Kbd>Ctrl/Cmd+Enter</Kbd> or the adjacent{' '}
            <Code>INTERRUPT &amp; SEND</Code> interrupts the turn and sends the
            draft next in the same conversation, preserving queued messages and
            completed changes. <Kbd>Esc</Kbd> cancels the in-flight turn (drops
            the queue too; <Kbd>Shift+Esc</Kbd> skips the confirm). The PENDING list shows each message as Queued until delivery is confirmed, then Delivered until the next agent text or turn end. A provider without a delivery signal stays Queued until turn end. The working indicator and cluster member cards show the current tool, the first line of a shell command, and elapsed step time. Steps over 60 seconds are marked long-running. Hover over a shortened composer step to see its full name.
          </li>
        </ul>
        <h4 className="manual-sub">Slash commands &amp; references</h4>
        <p><Code>/prompt name args</Code> expands a saved template. Inserted argument text remains literal; <Code>$$1</Code> in the template produces literal <Code>$1</Code>.</p>
        <p>
          <Code>/goal &lt;objective&gt;</Code> sets the tab&apos;s north star (
          <Code>/goal</Code> shows it, <Code>/goal clear</Code> removes it) and{' '}
          <Code>/goal run N</Code> / <Code>/goal run stop</Code> arm or stop a
          goal run - none of these sends a turn.
        </p>
        <p>
          On Cursor,{' '}
          <Code>/compress</Code> runs Cursor&apos;s native compaction. Claude
          Code terminal-only commands (<Code>/login</Code>,{' '}
          <Code>/clear</Code>, <Code>/model</Code>, ...) are intercepted with a
          hint instead of wasting a turn. Context references such as{' '}
          <Code>@file:src/x.ts</Code>, <Code>@diff</Code>, <Code>@staged</Code>{' '}
          and <Code>@git:N</Code> expand into the prompt.
        </p>
        <p>
          <strong>Attachments:</strong> drop files anywhere on the window, paste
          an image or file from the clipboard, or click <Code>+ FILE</Code>.
          Images are sent as native attachments where the provider supports them
          (Claude, Codex, Cursor, and local models with vision); other files are
          appended as <Code>[attached file: &lt;path&gt;]</Code> references in
          the prompt.
        </p>
        <p>
          <strong>The worker header</strong> shows the context fill estimate and cumulative output. The footer below the composer shows other live state:
        </p>
        <ul>
          <li>The current model and effort. Live-editable from the CONFIG tab.</li>
          <li>
            A <Code>FOLD</Code> button (Claude Native) - deterministically trims
            older history into a digest and keeps a verbatim recent tail in the
            same session, instantly with no model round. Cheaper than Compact
            (no summarization call) and Handoff (no fresh worker); the raw
            transcript stays available in the workflow history.
          </li>
          <li>
            An <Code>S-FOLD</Code> button (Claude Native Agent tabs) - one
            Anthropic on-demand compaction call replaces older turns with a
            signed server summary and keeps the last two turns verbatim,
            thinking included. The call&apos;s token spend shows in the notice;
            if the API refuses it, the deterministic Fold runs instead. Undo via
            HISTORY rewind.
          </li>
          <li>
            A <Code>COMPACT</Code> button - summarizes the conversation in place
            and continues with a smaller prompt; same idea as Claude Code&apos;s{' '}
            <Code>/compact</Code>. (Claude Native, Codex app-server, and
            Ollama, each via their native compaction path.)
          </li>
          <li>
            A tool-<Code>POSTURE</Code> button - cycles full / coding / review /
            chat to scope which tools are exposed for the next turn
            (session-local, reverts to full on reload), cutting tool-definition
            tokens.
          </li>
          <li>
            A <Code>PLAN</Code> button - opens the Plan composer (see Plans).
          </li>
        </ul>
        <h4 className="manual-sub">Untrusted-project banner</h4>
        <p>
          When a workflow opens on a
          repo Arco has not seen, any project <Code>CLAUDE.md</Code>, project
          skills, and <Code>.arco/settings.json</Code> are suppressed from the
          turn - the cloned-repo prompt-injection vector.
        </p>
        <p>
          An{' '}
          <Code>⚠ UNTRUSTED PROJECT</Code> banner appears above the composer
          listing what was held back; clicking <strong>TRUST</strong> records
          the repo in <Code>~/.arco/trust.json</Code> and folds those resources
          into future turns. It is operator-prompt only (no auto-grant) and
          reversible: change it per tab in CONFIG → PROJECT TRUST (TRUSTED /
          BLOCKED / ASK) or manage every decision in SETTINGS → PROJECT TRUST.
        </p>
      </>
    ),
  },
  {
    id: 'right-panel',
    group: 'The workspace',
    title: 'The right panel',
    body: (
      <>
        <p>
          The right panel holds per-workflow tools grouped into four families.
          Each workflow remembers its active tab and starts with FILES.
        </p>
        <h4 className="manual-sub">Panel groups</h4>
        <p>
          Drag the splitter to resize the panel. The splitter position is shared
          across workflows and persists in the browser, once for each layout
          range (see Window size and layout).
        </p>
        <p>
          The tabs are grouped by purpose into four families so the strip stays
          scannable: <strong>WORKSPACE</strong> (Files including Outputs,
          Genesis), <strong>AGENT</strong> (Activity, Review, Research,
          Handoffs, Plan, Bake-off, Tasks), <strong>MEMORY</strong> (Knowledge,
          Ledger, History, Usage - single-worker and chat tabs; cluster tabs show
          History and Usage under MEMORY), and <strong>RUNTIME</strong> (Preview,
          Config, GitHub).
        </p>
        <p>
          On a narrow split the second-level row collapses into
          a grouped <Code>&lt;select&gt;</Code> so every tab stays reachable.
        </p>
        <Table
          headers={['Tab', 'What it shows']}
          rows={[
            [
              <strong key="f">FILES</strong>,
              <>File explorer for the workflow&apos;s cwd, with <strong>OUTPUTS</strong> (artifacts, generated-file events and scoped exports; hidden in Incognito), LIVE / CHANGES / SOURCE / REMOTE sub-tabs (plus BLAST RADIUS when codebase memory is attached, SANDBOX when on). Click to open in a viewer modal. Honors <Code>.gitignore</Code>.</>,
            ],
            [
              <strong key="gen">GENESIS</strong>,
              <>Idea-to-project ideation: moves a vague idea through Spark → Concept → Case → Build-direction with an advisory readiness readout and an editable staged seed, then SAVE PLAN for an existing-folder draft or CREATE &amp; SCAFFOLD for a new project. Other real-folder tabs offer Creative mode - an alternative direction scaffolded into a sibling folder. See &quot;Genesis&quot; under Workflows &amp; sessions.</>,
            ],
            [
              <strong key="a">ACTIVITY</strong>,
              <>Live stream of tool-use, thinking, and long-running activity, capped at 500 entries and reset each turn. Sticky sections above it - ultracode FLEET, LSP DIAGNOSTICS, CHECKPOINTS, TOKEN USAGE, background jobs - survive; CHECKPOINTS and the per-turn TOKEN USAGE rows collapse behind their headers and scroll in short boxes so the live feed stays visible.</>,
            ],
            [
              <strong key="r">REVIEW</strong>,
              <>Read-only artifacts produced by past Reviews. Each entry shows verdict (PASS / MINOR / BLOCKING) and reviewer model. <Code>↳ SEND TO AGENT</Code> appends the review body to the composer, preserving any unsent draft.</>,
            ],
            [
              <strong key="rs">RESEARCH</strong>,
              <>Cited markdown reports from past RESEARCH runs. Expand a row to read the report; in-flight runs show <Code>searching (n/cap)</Code> + CANCEL, and the DIG DEEPER composer appends a dated addendum.</>,
            ],
            [
              <strong key="h">HANDOFFS</strong>,
              <>The handoff documents written when a session was rotated. Click any to view; they live forever in <Code>.arco/workflows/&lt;wfid&gt;/handoffs/</Code>. An in-flight handoff has a <Code>✕</Code> on its <Code>RUN...</Code> row to cancel it.</>,
            ],
            [
              <strong key="p">PLAN</strong>,
              <>Plans attached to this workflow + other plans available in this cwd. See the Plans section.</>,
            ],
            [
              <strong key="bo">BAKE-OFF</strong>,
              <>Run one implementation prompt through 2-5 provider/model attempts in isolated git worktrees. Compare their tabs and diffs, then explicitly promote one; Arco never picks the winner. Cleanup removes worktrees while preserving branches.</>,
            ],
            [
              <strong key="t">TASKS</strong>,
              <>Claude Native <Code>Task</Code> children. Hidden until this workflow has child tasks; promote one to expose it in the top tab strip.</>,
            ],
            [
              <strong key="kn">KNOWLEDGE</strong>,
              <>Operator-owned project knowledge base under <Code>.arco/knowledge/</Code> - articles written by the operator, quick links, or agent-drafted distills explicitly saved. Always-include articles fold into every turn within a bounded budget. See &quot;The KNOWLEDGE tab&quot; under Power features. (Codebase-memory RAG attach/detach lives in CONFIG.)</>,
            ],
            [
              <strong key="ld">LEDGER</strong>,
              <>MEMORY &gt; LEDGER in a single-worker or chat tab. Project task ledger (TRIAGE / TODO / READY / IN PROGRESS / BLOCKED / REVIEW / DONE / ARCHIVED) with linked plans, reviews, workflows, and URLs. Cwd-scoped, persists across sessions. Cluster work uses AGENT &gt; BOARD instead.</>,
            ],
            [
              <strong key="h2">HISTORY</strong>,
              <>MEMORY &gt; HISTORY (single-worker, chat and cluster tabs; a cluster follows the member in view). Read-only seq-stamped timeline with LABEL THIS, REVIEW FROM HERE, SPAWN FROM HERE, and REWIND CONVERSATION actions, plus a REWINDS filter and fork markers. REWIND CONVERSATION moves the live head back to a past point for Claude Native workers - the current branch is kept and can be returned to, so it is reversible; a two-click confirm guards it and it is blocked while a turn is in flight. For other providers and the Claude CLI the button stays visible, disabled, with the reason beside it.</>,
            ],
            [
              <strong key="us">USAGE</strong>,
              <>MEMORY &gt; USAGE in a single-worker, chat or cluster tab (a cluster tab covers all members). Token usage trends for the project. Failed or invalid usage reads show an error; reopen USAGE to retry. MEASURE STORAGE measures the project's saved state without changing it and lists every byte under one heading, such as conversation logs, artifacts or worktrees. MEASURE ARCO FOLDER does the same for Arco's own folder. MEASURE AGAIN refreshes the cached result; large files and read errors are marked. From anywhere, ARTIFACTS &gt; STORAGE also offers MEASURE AGAIN.</>,
            ],
            [
              <strong key="pv">PREVIEW</strong>,
              <>Live iframe of the workflow&apos;s dev server. PORT input + BIND/UNBIND. The agent&apos;s <Code>npm run dev</Code> is auto-detected; manual binds always win. See &quot;The PREVIEW tab&quot; for details.</>,
            ],
            [
              <strong key="c">CONFIG</strong>,
              <>Live-editable model, effort, transport (plus ultracode), Codex context window, sandbox, tool allowlist, output style, north star and goal run, project trust, context controls, auto-compaction, auto-handoff after N compactions, auto-fold FOLD AT, and the review-safe-mode HITL gate toggle. Changes take effect on the next turn - no rotation needed for same-provider swaps.</>,
            ],
            [
              <strong key="g">GITHUB</strong>,
              <>The full-screen GitHub browser is launched from the header; this tab is contextual to the workflow when relevant.</>,
            ],
          ]}
        />
      </>
    ),
  },

  {
    id: 'window-layout',
    group: 'The workspace',
    title: 'Window size and layout',
    body: (
      <>
        <p>
          <strong>Layout</strong> (Settings, Appearance) offers Automatic,
          Standard, Compact and Narrow. Automatic picks by window width: Narrow
          under 1500, Compact from 1500, Standard from 2000 (interface pixels:
          window width divided by the text size). Fixed choices apply at every width.
          The top-bar layout switch cycles the choices and shows the current layout.
        </p>
        <Table
          headers={['Layout', 'What changes']}
          rows={[
            ['Narrow', 'The member list becomes a rail of initials and the right panel a strip of buttons. Both open over the chat; View in Outputs opens the right panel at Outputs.'],
            ['Compact', 'Member cards are one row with a one-line reply. The member list starts at 250 px, the right panel at 320 px in a cluster and 360 px in a single tab.'],
            ['Standard', 'The original layout, with full member cards and panels.'],
          ]}
        />
        <p>
          Outside Standard, the cluster settings above the right panel fold into
          one summary line with <strong>SETTINGS</strong> to open them, the
          no-plan hint is one line with <strong>MORE</strong>, and the composer
          tools stay on one line: tools that do not fit move into{' '}
          <strong>MORE</strong>. FILE, PLAN and BRIEF always stay.
        </p>
        <p>
          A dragged splitter is remembered for each layout, so a laptop window
          and a desktop window keep their own widths. Standard keeps the
          original saved width. The choice is kept in this browser and applies
          at once; the command palette has Layout: Automatic, Standard, Compact
          and Narrow.
        </p>
        <p>
          Menus, dropdowns, usage cards and notices stay inside the window in
          every layout and at every interface text size. A menu that would run
          past an edge opens on the other side of its button or moves along
          the edge, keeping a small gap. A menu taller than the room left
          scrolls inside itself. Resizing the window or changing the text size
          places it again.
        </p>
      </>
    ),
  },
  {
    id: 'changes-diff',
    group: 'The workspace',
    title: 'The CHANGES sub-tab - in-app diffs',
    body: (
      <>
        <p>
          CHANGES shows the working-tree diff for the workflow&apos;s cwd so
          agent edits can be inspected without leaving Arco. The{' '}
          <strong>CHANGES</strong> sub-tab under FILES shows everything that has
          changed since the last commit (<Code>git diff</Code> vs{' '}
          <Code>HEAD</Code>).
        </p>
  <p>Filenames containing spaces stay complete, including renamed and conflicted files. A failed, oversized or timed-out Git comparison reports an error; a partial patch is never shown as complete.</p>
        <h4 className="manual-sub">Reading changes</h4>
        <ul>
          <li>
            <strong>Per-file, collapsible.</strong> Each changed file is a
            collapsible block with an add/delete line count. Click the header to
            fold a file away.
          </li>
          <li>
            <strong>UNIFIED / SPLIT toggle.</strong> Unified shows one column
            with <Code>+</Code>/<Code>-</Code> lines; split shows old and new
            side-by-side. Intra-line edits are word-highlighted.
          </li>
          <li>
            <strong>Empty states.</strong> A clean tree shows{' '}
            <em>&quot;No changes since HEAD&quot;</em>; a non-git cwd shows{' '}
            <em>&quot;Not a git working tree&quot;</em> - neither is an error.
          </li>
        </ul>
        <p>
          The same renderer powers the <strong>GIT dialog&apos;s</strong>{' '}
          <Code>EXPAND FILE DIFFS</Code> preview, so the diff can be
          inspected before committing. The same viewer can compare two
          checkpoints and display unified-diff patches.
        </p>
        <Note kind="tip">
          The diff endpoint never mutates anything - it is read-only{' '}
          <Code>git diff</Code> under the hood, and runs against a separate code
          path from the agent&apos;s own git access.
        </Note>
      </>
    ),
  },

  {
    id: 'source-changes',
    group: 'The workspace',
    title: 'The SOURCE sub-tab - file-by-file working-tree changes',
    body: (
      <>
        <p>
          SOURCE is a Source-Control-style file list of staged, unstaged, and
          untracked changes. The <strong>SOURCE</strong> sub-tab (next to
          CHANGES) groups the working tree&apos;s changed files into{' '}
          <strong>STAGED</strong> (index vs <Code>HEAD</Code>),{' '}
          <strong>CHANGES</strong> (working tree vs index), and{' '}
          <strong>UNTRACKED</strong> (new files git is not tracking yet).{' '}Click
          any file to render just that file&apos;s diff in the same viewer the
          CHANGES tab uses.
        </p>
        <ul>
          <li>
            <strong>Per-file diffs.</strong> A staged entry shows its staged
            diff, an unstaged entry its working-tree diff, and an untracked file
            its full new-file content as an all-added diff.
          </li>
          <li>
            <strong>Graceful degradation.</strong> Binary or oversized files
            show a hint instead of dumping bytes; a clean tree shows{' '}
            <em>&quot;Working tree clean&quot;</em> and a non-git cwd{' '}
            <em>&quot;Not a git working tree&quot;</em>.
          </li>
        </ul>
        <p>
          SOURCE reads Git status and diffs without changing the repository.
        </p>
      </>
    ),
  },

  {
    id: 'remote-compare',
    group: 'The workspace',
    title: 'The REMOTE sub-tab - what will I push / pull',
    body: (
      <>
        <p>
          REMOTE compares the current branch to its upstream so a push or pull
          is not blind. The <strong>REMOTE</strong> sub-tab compares this
          cwd&apos;s current branch against its upstream (<Code>@{'{u}'}</Code>)
          so exactly what a push or pull would move is visible - no blind{' '}
          <Code>git push</Code>.
        </p>
        <h4 className="manual-sub">Remote comparison</h4>
        <p>
          It shows a{' '}
          <strong>↑N to push / ↓M to pull</strong> summary, an expandable commit
          list each direction, and the per-direction diff in the same A3
          renderer the CHANGES / SOURCE tabs use.
        </p>
        <ul>
          <li>
            <strong>FETCH</strong> runs <Code>git fetch</Code> against the
            upstream&apos;s remote (falling back to <Code>origin</Code>), then
            re-reads the comparison. It updates remote-tracking refs only -{' '}
            <em>never</em> merges, rebases, or moves <Code>HEAD</Code>.
          </li>
          <li>
            <strong>Graceful states.</strong> No upstream configured, a detached{' '}
            <Code>HEAD</Code>, a clean &quot;in sync&quot; tree, and a non-git
            cwd each show a plain explanation rather than an error.
          </li>
        </ul>
        <Note>
          REMOTE is read-only except for the explicit FETCH button. Push and pull
          are separate, explicit buttons in the git actions bar of the SOURCE
          sub-tab; this tab is for <em>seeing</em> the state first.
        </Note>

      </>
    ),
  },

  {
    id: 'editing-a-file',
    group: 'The workspace',
    title: 'Editing a file',
    body: (
      <>
        <p>
          The file viewer doubles as a light editor for quick hand-tweaks that
          do not warrant an agent turn. Open any text file from the{' '}
          <strong>FILES</strong> explorer and it lands <strong>Locked</strong>{' '}
          (read-only) - it cannot be changed by accident.
        </p>
        <ol>
          <li>
            Click <strong>EDIT</strong> (top-right, beside RAW) to make the
            buffer writable in a CodeMirror editor with syntax highlighting and
            a <strong>SAVE</strong> button. An <Code>● UNSAVED</Code> marker
            appears once the buffer diverges from disk.
          </li>
          <li>
            <strong>SAVE</strong> writes the submitted text. If more text was typed while saving, it stays visible and unsaved; otherwise the viewer returns to Locked.{' '}
            <strong>LOCK</strong> discards edits and returns to the formatted
            viewer. Closing the modal with unsaved edits prompts first.
          </li>
        </ol>
        <Note kind="warn">
          Saves stay within the workflow&apos;s project folder. A path outside
          that folder is rejected and nothing is written. The editor lets the
          operator save without starting an agent turn.
        </Note>
      </>
    ),
  },

  {
    id: 'ai-edit',
    group: 'The workspace',
    title: 'AI-collaborative editing',
    body: (
      <>
  <p>ASK AI keeps its proposal attached to the original editor request while the server assigns an id. Unsent or disconnected pending requests show an error; PROPOSE EDIT can be retried when connected.</p>
        <p>
          AI-collaborative editing turns a selection into a scoped, reviewable
          rewrite without a full conversational turn. Inside the editor (after{' '}
          <strong>EDIT</strong>), the AI-edit affordance covers the everyday
          &quot;tighten this paragraph / fix the formatting of this block /
          rewrite this in my voice&quot; loop, without spending a full
          conversational turn or hand-editing.
        </p>
        <ol>
          <li>
            Select a region (or hit <strong>SELECT ALL</strong> for a whole-doc
            edit), then click <strong>✦ ASK AI</strong> (top-right of the
            editor). Type an instruction and pick the agent with the same{' '}
            <strong>RUN AS</strong> picker used by Review / Handoff / Research.
          </li>
          <li>
            <strong>PROPOSE EDIT</strong> dispatches one bounded turn. The agent
            returns a replacement for <em>just the selection</em> - preview it
            as a diff (selection-before vs proposed-after).
          </li>
          <li>
            <strong>ACCEPT</strong> splices the replacement into the editor
            buffer; <strong>REJECT</strong> discards it. Accept one region,
            select the next, repeat.
          </li>
        </ol>
        <Note kind="info">
          The agent <strong>proposes, the operator approves - twice.</strong>{' '}
          The doc-edit agent has <strong>no Write tool</strong> and never
          touches disk: its whole output is the proposed text. Accept changes
          the in-memory buffer only; the existing <strong>SAVE</strong> button
          is the one and only path that writes to disk, through the same
          protected save path as a manual edit. Reject discards the
          proposal; nothing is written until SAVE.
        </Note>
      </>
    ),
  },

  // -------------------------------------------------------------- WORKFLOWS & SESSIONS
];
