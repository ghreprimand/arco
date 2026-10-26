import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Note, Kbd, Table } from '../../components/UserManual/components';

export const workspace: Section[] = [
  {
    id: 'header',
    group: 'The workspace',
    title: 'The top header',
    body: (
      <>
        <p>The header sits at the top of every screen. Left-to-right:</p>
        <ul>
          <li>
            <strong>ARCO</strong> — the wordmark. Click it does nothing — it's
            decoration. When a hub is configured, a <strong>hub-link chip</strong>{' '}
            sits beside it.
          </li>
          <li>
            <strong>Workflow status chip</strong> — one chip carrying context
            fill (◔ %) for the active workflow and provider quota (⚠ N when any
            provider is throttled). Click for exact context tokens/window plus
            per-provider quota status and reset times. Stays visible in focus mode.
          </li>
          <li>
            <strong>Providers popover</strong> — folds the per-provider version
            chips (Claude / Gemini / Codex, plus Ollama when the daemon is
            reachable, a llama.cpp build chip and a Cursor chip) behind one trigger whose dot turns warning-color when any
            provider has an update. Open it to see the grid; each chip compares
            against the upstream latest — npm registry for the three CLIs, GitHub
            Releases for Ollama, refreshed every 4 hours. When the installed
            version is older than the upstream latest, the chip turns
            warning-color and the tooltip reads <Code>outdated: vX → vY</Code>.
            <br />
            Clicking a Claude / Gemini / Codex chip runs the upstream installer
            (<Code>claude update</Code> or a resolved npm package version) and
            flashes back as <Code>v… (latest)</Code> or <Code>→ vNEW</Code>.
            If an npm platform binary is not yet published, an older installable
            version can be retained/selected with a <Code>v… (!)</Code> notice.
            See Provider updates for broken-versus-missing status and recovery.
            Clicking Ollama opens an in-app modal listing the last ~10 GitHub
            releases (themed; markdown-rendered notes; your installed version is
            highlighted) — Arco can't auto-update Ollama because the install
            path varies by OS (Linux <Code>install.sh</Code>, macOS{' '}
            <Code>.dmg</Code>, etc.).
            <br />
            Chips are hidden for providers you've disabled in Settings or for
            CLIs that aren't installed.
          </li>
          <li>
            <strong>Live-status dots</strong> — when at least one provider is
            authed, a compact dot per provider (<Code>C</Code> Claude,{' '}
            <Code>G</Code> Gemini, <Code>X</Code> Codex, <Code>Z</Code> Z.ai,{' '}
            <Code>R</Code> Cursor, <Code>O</Code> Ollama): green ● live, hollow ○
            idle, red ● down. Hover a dot for its usage detail — Claude&apos;s
            5-hour and weekly burn (polled every 3 minutes), Codex and Z.ai usage,
            Cursor&apos;s included-plan and Other Models bars, or Ollama&apos;s
            loaded models.
          </li>
          <li>
            <strong>Auth chip</strong> — at-a-glance status of Claude auth. Pulses when
            re-login is needed; click to start the re-login flow.
          </li>
          <li>
            <strong>KNOWLEDGE dropdown</strong> — RECALL (search past
            conversations) + COOKBOOK (local-model catalog).
          </li>
          <li>
            <strong>TOOLS dropdown</strong> — MEDIA (image/audio/video studio),{' '}
            <strong>◆ GITHUB</strong> (toggles the GitHub browser: repos, PRs,
            issues, Actions, clone), and TERMINAL (a PTY in the active workflow
            root; disabled until a workflow is open).
          </li>
          <li>
            <strong>⌸ ARCHIVE</strong> — opens the standalone chromeless
            read-only file-explorer window (agent artifacts, recents, tree).
          </li>
          <li>
            <strong>⚙ SETTINGS</strong> — opens the settings modal.
          </li>
          <li>
            <strong>ⓘ MANUAL</strong> — this manual.
          </li>
          <li>
            <strong>● ONLINE / SYNCING / OFFLINE</strong> — three-state connection
            indicator. ONLINE = WS connected and all persisted workflows have replayed.
            SYNCING = WS up but some workflow is still catching up. OFFLINE = WS down.
            A <Code>RECONNECT</Code> button appears in OFFLINE.
          </li>
          <li>
            <strong>Notification bell</strong> — durable workbench-notice history
            with per-category mute. Stays visible in focus mode.
          </li>
          <li>
            <strong>◳ FOCUS</strong> — hides the right panel + secondary header
            chrome for a full-width chat (reversible; persists).
          </li>
          <li>
            <strong>⏻</strong> — opens the System modal: Actions (restart / quit
            Arco), Diagnostics (read-only health + exposure-posture checks),
            Models (Ollama / llama.cpp / Cookbook readout), and Services
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
          One tab per workflow (Agent or Chat). Each tab shows the workflow name, a
          pulsing dot while a turn is running (idle tabs show no dot), and — on Codex
          tabs bound to a named account profile — a short account badge. Click a tab to
          focus it; drag tabs to reorder them. Click the <Code>×</Code> on a tab to
          close it: Arco asks for confirmation first, and the prompt calls out an
          in-progress turn (it will be cancelled) or an unsaved Incognito chat (it will
          be lost). A saved workflow's <Code>events.jsonl</Code> stays on disk under{' '}
          <Code>&lt;cwd&gt;/.arco/workflows/</Code> — closing does not delete it;
          reopen it through RESUME (project sessions) or PAST CHATS (saved chats).
        </p>
        <p>
          The trailing <Code>+</Code> button opens the workflow creator (same as{' '}
          <Kbd>Ctrl/Cmd+K</Kbd>).
        </p>
        <p>
          A second tab kind, the <strong>cluster parent</strong>, hosts N member
          workflows pinned to one cwd. Cluster parent tabs are created by
          right-clicking a regular tab (CREATE WITH EXISTING / CREATE WITH FRESH);
          they show their members as a row of sub-tabs underneath. See the Clusters
          group for details.
        </p>
        <p>
          <strong>Tabs follow the server, not the browser.</strong> The set of open
          tabs lives on the Arco server, so every computer and browser pointed at
          it (the host itself, the MacBook over the tailnet, …) shows the same tabs,
          transcripts, and CONFIG settings. Opening or closing a tab anywhere does
          the same everywhere, live; tab order is shared too. Which tab is
          <em> focused</em> stays per-browser, and Incognito chats stay in the browser
          that opened them (they are never stored on the server). The first time a
          browser connects after this shipped, any tabs it had locally are merged in.
        </p>
        <Note kind="warn">
          Within one browser Arco still refuses a second window against the same
          server — it gets the <em>Duplicate Tab</em> overlay. Different browsers or
          computers are fine and mirror each other.
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
          <Code>HOME</Code> is the project landing page. It lists open work and
          projects, including saved sessions for each project. Select{' '}
          <Code>HOME</Code> in the tab bar to return to this view. Search filters
          projects by name or folder; press <Kbd>/</Kbd> when not typing to focus
          project search.
        </p>
        <p>
          Add an existing folder or create a project folder from Home. A project
          card can start a new session or cluster with its folder prefilled, open
          saved sessions, and manage its display name, pin, archive state, or
          location. Relocation updates the folder reference; it does not move the
          folder. Removing a project from the list does not delete its files.
        </p>
        <p>
          Use <Code>Settings &gt; Projects</Code> to manage registered, scanned,
          and recent folders, choose the default working folder for new workflows,
          and configure project trust. Home is for resuming work and starting from
          a project card. The full category and control map is in{' '}
          <Code>docs/SETTINGS.md</Code>.
        </p>
        <Note kind="tip">
          If a folder is missing, its project card offers <Code>Relocate...</Code>.
          Saved work stays associated with the project record; choose the folder's
          new location to resume from it.
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
        <p>
          The chat panel takes the left two-thirds of the screen. It renders the
          conversation tail-first: on first open, the last 200 entries are shown, with
          an <Code>↑ LOAD EARLIER MESSAGES</Code> pill at the top to page further back.
          Scroll position is preserved when paging.
        </p>
        <p>
          <strong>Message types you'll see:</strong>
        </p>
        <ul>
          <li>
            <strong>You</strong> — the operator's prompts. Long messages collapse to a
            preview with an expand toggle.
          </li>
          <li>
            <strong>Agent</strong> — the primary's reply. Streams token-by-token while
            the turn is in flight.
          </li>
          <li>
            <strong>Thinking</strong> — collapsible reasoning block from Claude / Codex /
            Ollama (when the model exposes it).
          </li>
          <li>
            <strong>Tool-call pills</strong> — inline rows between assistant bubbles for
            Bash / Read / Grep / WebFetch / etc. Click to expand the JSON input. Click
            a file path inside to open the viewer modal. (Claude-only for now — uses the
            Claude session JSONL.)
          </li>
          <li>
            <strong>Inline artifacts</strong> — fenced{' '}
            <Code>```arco-artifact</Code> blocks the agent emits. Render as
            click-to-expand pills.
          </li>
          <li>
            <strong>HANDOFF SEED / SPAWN SEED</strong> — the first user message in a
            rotated session. Collapsed to a one-line pill so you don't see a 300-line
            user bubble. Click to expand.
          </li>
          <li>
            <strong>System notices</strong> — out-of-band warnings (rate-limits, retries,
            concurrent-writer warnings, calibration completion, threshold crossings).
          </li>
        </ul>
        <Note kind="tip">
          Links the agent emits open in a new browser tab — clicking a URL never
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
        <p>
          The composer sits at the bottom of the chat panel. It has two modes:
        </p>
        <ul>
          <li>
            <strong>Idle</strong> — when the agent is waiting. <Kbd>Enter</Kbd> sends.{' '}
            <Kbd>Shift+Enter</Kbd> inserts a newline. <Kbd>Ctrl+K</Kbd> deletes from
            the cursor to the end of the line (readline-style, no clipboard).
          </li>
          <li>
            <strong>Queue (busy turn)</strong> — when a turn is in flight, the
            composer routes to a structured queue with two intents:{' '}
            <Kbd>Enter</Kbd> queues as <strong>steer</strong> ("do this now /
            change direction") and <Kbd>Alt+Enter</Kbd> queues as{' '}
            <strong>follow-up</strong> ("after the current task lands"). Steer
            is delivered mid-turn on Claude Native, Codex app-server, Ollama,
            llama.cpp, and LM Studio; other transports drain queued messages
            after the current turn settles. <Kbd>Alt+↑</Kbd>{' '}
            recalls the most recent queued message into the editor. For Claude
            and Codex, <Code>SEND</Code> keeps the ordinary Enter behavior;
            <Kbd>Ctrl/Cmd+Enter</Kbd> or the adjacent <Code>INTERRUPT &amp; SEND</Code>
            interrupts the turn and sends the draft next in the same conversation,
            preserving queued messages and completed changes.{' '}
            <Kbd>Esc</Kbd> cancels the in-flight turn (drops the queue too;
            <Kbd>Shift+Esc</Kbd> skips the confirm). The strip above the
            composer shows pending items with their kind pills.
          </li>
        </ul>
        <p>
          <strong>Slash commands &amp; references.</strong>{' '}
          <Code>/goal &lt;objective&gt;</Code> sets the tab&apos;s north star
          (<Code>/goal</Code> shows it, <Code>/goal clear</Code> removes it) and{' '}
          <Code>/goal run N</Code> / <Code>/goal run stop</Code> arm or stop a goal
          run — none of these sends a turn. On Cursor, <Code>/compress</Code> runs
          Cursor&apos;s native compaction. Claude Code terminal-only commands
          (<Code>/login</Code>, <Code>/clear</Code>, <Code>/model</Code>, …) are
          intercepted with a hint instead of wasting a turn. Context references
          such as <Code>@file:src/x.ts</Code>, <Code>@diff</Code>,{' '}
          <Code>@staged</Code> and <Code>@git:N</Code> expand into the prompt.
        </p>
        <p>
          <strong>Attachments:</strong> drop files anywhere on the window, paste an
          image or file from the clipboard, or click <Code>+ FILE</Code>.
          Images are sent as native attachments where the provider supports them
          (Claude); other files are appended as{' '}
          <Code>[file: &lt;path&gt;]</Code> references in the prompt.
        </p>
        <p>
          <strong>The footer below the composer</strong> shows live state:
        </p>
        <ul>
          <li>
            <Code>CTX: NN K / NN K · NN%</Code> — context fill estimate, color-coded
            against the model's window.
          </li>
          <li>Last-turn token usage and cost (if reported by the provider).</li>
          <li>The current model and effort. Live-editable from the CONFIG tab.</li>
          <li>
            A <Code>FOLD</Code> button (Claude Native) — deterministically trims
            older history into a digest and keeps a verbatim recent tail in the
            same session, instantly with no model round. Cheaper than Compact (no
            summarization call) and Handoff (no fresh worker); the raw transcript
            stays in <Code>events.jsonl</Code>.
          </li>
          <li>
            An <Code>S-FOLD</Code> button (Claude Native Agent tabs) — one
            Anthropic on-demand compaction call replaces older turns with a
            signed server summary and keeps the last two turns verbatim,
            thinking included. The call&apos;s token spend shows in the notice;
            if the API refuses it, the deterministic Fold runs instead. Undo via
            HISTORY rewind.
          </li>
          <li>
            A <Code>COMPACT</Code> button — summarizes the conversation in place
            and continues with a smaller prompt; same idea as Claude Code's{' '}
            <Code>/compact</Code>. (Claude Native, Codex app-server, Z.ai, and
            Ollama, each via their native compaction path.)
          </li>
          <li>
            A tool-<Code>POSTURE</Code> button — cycles full / coding / review /
            chat to scope which tools are exposed for the next turn (session-local,
            reverts to full on reload), cutting tool-definition tokens.
          </li>
          <li>
            A <Code>PLAN</Code> button — opens the Plan composer (see Plans).
          </li>
        </ul>
        <p>
          <strong>Untrusted-project banner.</strong> When you open a workflow on a
          repo Arco hasn't seen, any project <Code>CLAUDE.md</Code>, project
          skills, and <Code>.arco/settings.json</Code> are suppressed from the
          turn — the cloned-repo prompt-injection vector. An{' '}
          <Code>⚠ UNTRUSTED PROJECT</Code> banner appears above the composer
          listing what was held back; clicking <strong>TRUST</strong> records the
          repo in <Code>~/.arco/trust.json</Code> and folds those resources into
          future turns. It's operator-prompt only (no auto-grant) and reversible:
          change it per tab in CONFIG → PROJECT TRUST (TRUSTED / BLOCKED / ASK) or
          manage every decision in SETTINGS → PROJECT TRUST.
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
          The right one-third has tabs. Each workflow remembers its own active tab
          (stored in localStorage as a per-workflow map); fresh workflows default to
          FILES. The splitter between chat and panel is draggable; that position is
          global and also persists.
        </p>
        <p>
          The tabs are grouped by purpose into four families so the strip stays
          scannable: <strong>WORKSPACE</strong> (Files, Genesis),{' '}
          <strong>AGENT</strong> (Activity, Review, Research, Handoffs, Plan, Bake-off, Tasks),{' '}
          <strong>MEMORY</strong> (Knowledge, Ledger, History, Usage), and{' '}
          <strong>RUNTIME</strong> (Preview, Config, GitHub). On a narrow split the
          second-level row collapses into a grouped <Code>&lt;select&gt;</Code> so
          every tab stays reachable.
        </p>
        <Table
          headers={['Tab', 'What it shows']}
          rows={[
            [
              <strong key="f">FILES</strong>,
              <>File explorer for the workflow's cwd, with LIVE / CHANGES / SOURCE / REMOTE sub-tabs (plus BLAST RADIUS when codebase memory is attached, SANDBOX when on). Click to open in a viewer modal. Honors <Code>.gitignore</Code>.</>,
            ],
            [
              <strong key="gen">GENESIS</strong>,
              <>Idea-to-project ideation: moves a vague idea through Spark → Concept → Case → Build-direction with an advisory readiness readout and an editable staged seed, then an operator-confirmed create &amp; scaffold. Shown for from-nothing Genesis tabs and any real-cwd tab (where it offers Creative mode — an alternative direction scaffolded into a sibling folder). See "Genesis" under Workflows &amp; sessions.</>,
            ],
            [
              <strong key="a">ACTIVITY</strong>,
              <>Live stream of tool-use, thinking, and long-running activity, capped at 500 entries and reset each turn. Sticky sections above it — ultracode FLEET, LSP DIAGNOSTICS, CHECKPOINTS, TOKEN USAGE, background jobs — survive; CHECKPOINTS and the per-turn TOKEN USAGE rows collapse behind their headers and scroll in short boxes so the live feed stays visible.</>,
            ],
            [
              <strong key="r">REVIEW</strong>,
              <>Read-only artifacts produced by past Reviews. Each entry shows verdict (PASS / MINOR / BLOCKING) and reviewer model. <Code>↳ SEND TO AGENT</Code> pre-fills the composer with the review body.</>,
            ],
            [
              <strong key="rs">RESEARCH</strong>,
              <>Cited markdown reports from past RESEARCH runs. Expand a row to read the report; in-flight runs show <Code>searching (n/cap)</Code> + CANCEL, and the DIG DEEPER composer appends a dated addendum.</>,
            ],
            [
              <strong key="h">HANDOFFS</strong>,
              <>The handoff documents written when a session was rotated. Click any to view; they live forever in <Code>.arco/workflows/&lt;wfid&gt;/handoffs/</Code>. An in-flight handoff has a <Code>✕</Code> on its <Code>RUN…</Code> row to cancel it (not shown for Antigravity, whose desktop has no stop hook).</>,
            ],
            [
              <strong key="p">PLAN</strong>,
              <>Plans attached to this workflow + other plans available in this cwd. See the Plans section.</>,
            ],
            [
              <strong key="bo">BAKE-OFF</strong>,
              <>Run one implementation prompt through 2–5 provider/model attempts in isolated git worktrees. Compare their tabs and diffs, then explicitly promote one; Arco never picks the winner. Cleanup removes worktrees while preserving branches.</>,
            ],
            [
              <strong key="t">TASKS</strong>,
              <>Claude Native <Code>Task</Code> children. Hidden until this workflow has child tasks; promote one to expose it in the top tab strip.</>,
            ],
            [
              <strong key="kn">KNOWLEDGE</strong>,
              <>Operator-owned project knowledge base under <Code>.arco/knowledge/</Code> — articles you write, quick links, or agent-drafted distills you explicitly save. Always-include articles fold into every turn within a bounded budget. See "The KNOWLEDGE tab" under Power features. (Codebase-memory RAG attach/detach lives in CONFIG.)</>,
            ],
            [
              <strong key="ld">LEDGER</strong>,
              <>Project task ledger (TRIAGE / TODO / READY / IN PROGRESS / BLOCKED / REVIEW / DONE / ARCHIVED) with linked plans, reviews, workflows, and URLs. Cwd-scoped, persists across sessions.</>,
            ],
            [
              <strong key="h2">HISTORY</strong>,
              <>Read-only seq-stamped timeline with LABEL THIS, REVIEW FROM HERE, SPAWN FROM HERE, and REWIND CONVERSATION actions, plus a REWINDS filter and fork markers. REWIND CONVERSATION (Claude Native only) moves the live head back to a past point — the current branch is kept and can be returned to, so it's reversible; a two-click confirm guards it and it's blocked while a turn is in flight.</>,
            ],
            [
              <strong key="us">USAGE</strong>,
              <>Per-workflow token / cost accounting and the context (CTX) breakdown for this session.</>,
            ],
            [
              <strong key="pv">PREVIEW</strong>,
              <>Live iframe of the workflow's dev server. PORT input + BIND/UNBIND. The agent's <Code>npm run dev</Code> is auto-detected; manual binds always win. See "The PREVIEW tab" for details.</>,
            ],
            [
              <strong key="c">CONFIG</strong>,
              <>Live-editable model, effort, transport (plus ultracode), Codex context window, sandbox, tool allowlist, output style, north star and goal run, project trust, context controls, auto-handoff and auto-fold thresholds, and the review-safe-mode HITL gate toggle. Changes take effect on the next turn — no rotation needed for same-provider swaps.</>,
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
    id: 'changes-diff',
    group: 'The workspace',
    title: 'The CHANGES sub-tab — in-app diffs',
    body: (
      <>
        <p>
          The <strong>CHANGES</strong> sub-tab under FILES shows the working-tree
          diff for the workflow's cwd — everything that's changed since the last
          commit (<Code>git diff</Code> vs <Code>HEAD</Code>). It answers the
          question you ask constantly: <em>what did the agent actually change?</em>
        </p>
        <ul>
          <li>
            <strong>Per-file, collapsible.</strong> Each changed file is a
            collapsible block with an add/delete line count. Click the header to
            fold a file away.
          </li>
          <li>
            <strong>UNIFIED / SPLIT toggle.</strong> Unified shows one column with
            <Code>+</Code>/<Code>−</Code> lines; split shows old and new
            side-by-side. Intra-line edits are word-highlighted.
          </li>
          <li>
            <strong>Empty states.</strong> A clean tree shows{' '}
            <em>"No changes since HEAD"</em>; a non-git cwd shows{' '}
            <em>"Not a git working tree"</em> — neither is an error.
          </li>
        </ul>
        <p>
          The same renderer powers the <strong>GIT dialog's</strong>{' '}
          <Code>▸ SHOW WORKING-TREE DIFF</Code> preview, so you can eyeball the
          diff right before committing. The diff data comes from{' '}
          <Code>GET /api/workflows/diff</Code>, which can also compare two shadow
          checkpoint refs (used by later checkpoint-revert surfaces) — the viewer
          itself is source-agnostic and renders any unified-diff patch.
        </p>
        <Note kind="tip">
          The diff endpoint never mutates anything — it's read-only{' '}
          <Code>git diff</Code> under the hood, and runs against a separate code
          path from the agent's own git access.
        </Note>
      </>
    ),
  },

  {
    id: 'source-changes',
    group: 'The workspace',
    title: 'The SOURCE sub-tab — file-by-file working-tree changes',
    body: (
      <>
        <p>
          The <strong>SOURCE</strong> sub-tab (next to CHANGES) is a
          Source-Control-style file list. It groups the working tree's changed
          files into <strong>STAGED</strong> (index vs <Code>HEAD</Code>),{' '}
          <strong>CHANGES</strong> (working tree vs index), and{' '}
          <strong>UNTRACKED</strong> (new files git isn't tracking yet). Click any
          file to render just that file's diff in the same viewer the CHANGES tab
          uses.
        </p>
        <ul>
          <li>
            <strong>Per-file diffs.</strong> A staged entry shows its staged diff,
            an unstaged entry its working-tree diff, and an untracked file its
            full new-file content as an all-added diff.
          </li>
          <li>
            <strong>Graceful degradation.</strong> Binary or oversized files show
            a hint instead of dumping bytes; a clean tree shows{' '}
            <em>"Working tree clean"</em> and a non-git cwd{' '}
            <em>"Not a git working tree"</em>.
          </li>
        </ul>
        <p>
          Backed by <Code>GET /api/git/diff</Code> (distinct from the CHANGES
          tab's <Code>/api/workflows/diff</Code>) — read-only{' '}
          <Code>git status</Code> / <Code>git diff</Code> under the hood.
        </p>
      </>
    ),
  },

  {
    id: 'remote-compare',
    group: 'The workspace',
    title: 'The REMOTE sub-tab — what will I push / pull',
    body: (
      <>
        <p>
          The <strong>REMOTE</strong> sub-tab compares this cwd's current branch
          against its upstream (<Code>@{'{u}'}</Code>) so you can see exactly
          what a push or pull would move — no blind <Code>git push</Code>. It
          shows a <strong>↑N to push / ↓M to pull</strong> summary, an
          expandable commit list each direction, and the per-direction diff in
          the same A3 renderer the CHANGES / SOURCE tabs use.
        </p>
        <ul>
          <li>
            <strong>FETCH</strong> runs <Code>git fetch</Code> against the
            upstream's remote (falling back to <Code>origin</Code>), then
            re-reads the comparison. It updates remote-tracking refs only —{' '}
            <em>never</em> merges, rebases, or moves <Code>HEAD</Code>.
          </li>
          <li>
            <strong>Graceful states.</strong> No upstream configured, a detached
            <Code>HEAD</Code>, a clean "in sync" tree, and a non-git cwd each
            show a plain explanation rather than an error.
          </li>
        </ul>
        <Note>
          REMOTE is read-only except for the explicit FETCH button. The mutating
          push / pull / merge operations arrive in a later workbench phase; this
          tab is for <em>seeing</em> the state first.
        </Note>
        <p>
          Backed by <Code>GET /api/git/compare</Code> +{' '}
          <Code>POST /api/git/fetch</Code> (+ <Code>GET /api/git/compare/diff</Code>{' '}
          for the per-direction patch).
        </p>
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
          don't warrant an agent turn. Open any text file from the{' '}
          <strong>FILES</strong> explorer and it lands <strong>Locked</strong>{' '}
          (read-only) — you can't change it by accident.
        </p>
        <ul>
          <li>
            <strong>EDIT</strong> (top-right, beside RAW) makes the buffer
            writable in a CodeMirror editor with syntax highlighting and a{' '}
            <strong>SAVE</strong> button. An <Code>● UNSAVED</Code> marker
            appears once the buffer diverges from disk.
          </li>
          <li>
            <strong>SAVE</strong> writes the file and flips back to Locked.{' '}
            <strong>LOCK</strong> discards your edits and returns to the
            formatted viewer. Closing the modal with unsaved edits prompts
            first.
          </li>
        </ul>
        <Note kind="warn">
          Saves go through <Code>POST /api/files/write</Code>, which resolves
          the path against the workflow's cwd with the same path-escape guard
          the agent's Write/Edit tools use — a path that escapes the cwd is
          rejected and nothing is written. The editor is the only operator
          write path that skips an agent turn.
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
        <p>
          Inside the editor (after <strong>EDIT</strong>), the AI-edit affordance
          turns a selection into a scoped, reviewable rewrite — the everyday
          "tighten this paragraph / fix the formatting of this block / rewrite
          this in my voice" loop, without spending a full conversational turn or
          hand-editing.
        </p>
        <ul>
          <li>
            Select a region (or hit <strong>SELECT ALL</strong> for a whole-doc
            edit), then click <strong>✦ ASK AI</strong> (top-right of the
            editor). Type an instruction and pick the agent with the same{' '}
            <strong>RUN AS</strong> picker used by Review / Handoff / Research.
          </li>
          <li>
            <strong>PROPOSE EDIT</strong> dispatches one bounded turn. The agent
            returns a replacement for <em>just the selection</em> — you preview
            it as a diff (selection-before vs proposed-after).
          </li>
          <li>
            <strong>ACCEPT</strong> splices the replacement into the editor
            buffer; <strong>REJECT</strong> discards it. Accept one region,
            select the next, repeat.
          </li>
        </ul>
        <Note kind="info">
          The agent <strong>proposes, you approve — twice.</strong> The doc-edit
          agent has <strong>no Write tool</strong> and never touches disk: its
          whole output is the proposed text. Accept changes the in-memory buffer
          only; the existing <strong>SAVE</strong> button is the one and only
          path that writes to disk, through the same{' '}
          <Code>resolveWithinCwd</Code>-guarded endpoint as a manual edit.
          Reject discards; nothing is irreversible until you Save.
        </Note>
      </>
    ),
  },

  // -------------------------------------------------------------- WORKFLOWS & SESSIONS
];
