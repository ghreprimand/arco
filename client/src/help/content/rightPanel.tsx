import { C } from './shared';
import type { HelpEntry } from './shared';

export const rightPanelHelp: Record<string, HelpEntry> = {
  'rightpanel.outputs': {
    title: 'Workspace Outputs',
    body: <p>Outputs stays beside Files in Workspace. It collects this workflow's artifact files, supported generated-file events and scoped editor/media exports. Cluster Outputs includes only its members and identifies each producer. By default it lists what was made for you (generated media, top-level documents, reports and exports); tick <C>All files</C> to include code and files in artifact subfolders. Search or filter Images, Documents, Audio, Video and Other. Image entries show a wide uncropped preview above the title. Long titles clamp to two lines with <C>SHOW FULL TEXT</C> / <C>SHOW LESS</C>; the full title stays in the hover tip, File information and search. Preview and Open in editor reuse the existing viewers without changing the producing workflow context. Unsupported formats offer file information and Download. Save a copy retains the original; Move reviews source and destination, refuses collisions and preserves output links. The result stays in the dialog until it is closed. Choose Create folder to show the new-folder fields; resize or maximize the picker to see more. Closing a preview never removes an output. Missing files keep their provenance. Ordinary changed files are not automatically classified as generated.</p>,
  },
  'rightpanel.outputs.transfer': {
    title: 'Move or copy output', manualSection: 'archive-explorer',
    body: <p>Choose a destination in your home folder or an already approved project or media folder. Arco refuses protected state, existing files and unsafe links. Save a copy keeps the original and creates an owner-only file on systems with POSIX permissions; Move removes the original only after saving the new location. The dialog keeps the result visible until it is closed.</p>,
  },
  'rightpanel.outputs.download': {
    title: 'Download output', manualSection: 'archive-explorer',
    body: <p>Download this output through the browser. The file stays in its current location.</p>,
  },
  'rightpanel.outputs.all-files': {
    title: 'All files',
    body: <p>Off by default. Outputs then shows only what was made for you: generated images, audio and video, documents at the top level of the artifacts folder, and reports and exports. <C>All files</C> adds working files such as code and anything inside an artifact subfolder. A note says how many are hidden.</p>,
  },
  'rightpanel.outputs.name': {
    title: 'Open an output',
    body: <p>Click an output's name or image. Files with a preview open the viewer; types without one (PDF, office documents) open in the computer's default app. Programs and scripts are never opened from here; use <C>Download</C>.</p>,
  },
  'architecture-review.candidates': {
    title: 'CANDIDATES',
    body: <p><C>CANDIDATES</C> appears on an architecture review report (<C>architecture-review-DATE.md</C>). It lists the report's candidates with their files, problem, proposed change and strength, and offers <C>ADD TO PLAN</C> and <C>RECORD DECISION</C> for each.</p>,
    manualSection: 'architecture-review',
  },
  'architecture-review.dialog': {
    title: 'Architecture review candidates',
    body: <p>The candidates of one review report. Both actions write to the plan attached to this conversation, or to its cluster's plan; without one, attach a plan first. Nothing else in the project changes.</p>,
    manualSection: 'architecture-review',
  },
  'architecture-review.add-to-plan': {
    title: 'ADD TO PLAN',
    body: <p><C>ADD TO PLAN</C> asks first, then adds the candidate to the attached plan as one unticked item under "Architecture review", linked to a new reference doc that holds its files, problem, proposed change and expected benefit. A board task follows from the plan item the usual way.</p>,
    manualSection: 'architecture-review',
  },
  'architecture-review.record-decision': {
    title: 'RECORD DECISION',
    body: <p><C>RECORD DECISION</C> records why a candidate is not pursued. Type the reason and select <C>RECORD</C>; it is added to the attached plan's <C>decisions</C> reference doc with the date and files. Later reviews read that doc and do not suggest the candidate again.</p>,
    manualSection: 'architecture-review',
  },
  'rightpanel.outputs.open': {
    title: 'OPEN',
    body: <p><C>OPEN</C> hands the file to the default app of the computer Arco runs on. It is hidden when Arco has no desktop (Docker, headless) and for programs and scripts, which stay downloadable. Each open is logged.</p>,
  },
  'rightpanel.outputs.title-expand': {
    title: 'Show full output title',
    body: <p>Long generation prompts and other titles stay clamped to two lines in the Outputs list. <C>SHOW FULL TEXT</C> expands that entry only; <C>SHOW LESS</C> clamps it again. The full title remains available as the hover tip, under File information and in search.</p>,
  },
  'rightpanel.config.fact-force': {
    title: 'Fact-force first edit', manualSection: 'config-tab',
    body: <p>Claude Native, off by default. When enabled, the first file mutation
      asks the model to state importers, API surface and the operator instruction
      before retrying. Arco does not independently verify that recital. Existing
      explicit on settings remain honored; turn it off here to remove this layer.</p>,
  },
  'rightpanel.config.thinking-visibility': {
    title: 'Thinking visibility', manualSection: 'provider-recovery',
    body: <p>Native-only display preference, effective next turn. Omitted hides
      thinking; summarized requests a visible summary; updates requests short
      progress notes on supported models (Fable 5.x, Mythos 5.1, Opus 5.5). Notes are not guaranteed. This
      does not delete retained thinking or change the model's reasoning budget.</p>,
  },
  // ----------------------------------------------------------- RIGHT PANEL
  // I2: second-level grouping. The right-panel tabs are grouped by purpose;
  // the group selector is the top row, the active group's tabs the second.
  'rightpanel.group.workspace': {
    title: 'WORKSPACE group',
    body: <p>Where this tab works: <C>FILES</C> (the project folder, outputs and changes) and <C>GENESIS</C> (shaping a new project idea). Click a group to open its first tab; the open tab keeps its group selected.</p>,
  },
  'rightpanel.group.agent': {
    title: 'AGENT group',
    body: <p>What this tab&apos;s agent is doing and the tools that steer it: <C>ACTIVITY</C>, <C>REVIEW</C>, <C>RESEARCH</C>, <C>HANDOFFS</C>, <C>PLAN</C>, <C>BAKE-OFF</C>, and <C>TASKS</C> when the agent has started subtasks.</p>,
  },
  'rightpanel.group.memory': {
    title: 'MEMORY group',
    body: <p>What this tab keeps over time. In a single-worker or chat tab: <C>KNOWLEDGE</C> (saved notes and links), <C>LEDGER</C> (the project task list), <C>HISTORY</C> (past events) and <C>USAGE</C> (tokens and cost; also MEASURE STORAGE / MEASURE ARCO FOLDER). Cluster tabs show <C>HISTORY</C> (of the member in view) and <C>USAGE</C> (for the whole project folder) under MEMORY; for disk space from anywhere use ARTIFACTS &gt; STORAGE.</p>,
  },
  'rightpanel.group.runtime': {
    title: 'RUNTIME group',
    body: <p><C>PREVIEW</C> (a live view of a local app), <C>CONFIG</C> (this tab&apos;s settings) and <C>GITHUB</C>. A red dot on the group means CONFIG noticed a change in the provider&apos;s command-line tool since you last looked.</p>,
  },
  'rightpanel.tab.files': {
    title: 'FILES',
    body: <p>Browse this tab&apos;s project folder. <C>OUTPUTS</C> lists what was made for you (hidden in Incognito); <C>LIVE</C>, <C>CHANGES</C>, <C>SOURCE</C> and <C>REMOTE</C> show the work in progress and how it compares with the remote. Click a file to open it. Files ignored by git stay hidden.</p>,
  },
  'rightpanel.tab.genesis': {
    title: 'GENESIS',
    body: <p>Project ideation for this tab: walks a vague idea through <C>Spark → Concept → Case → Build-direction</C> with an advisory readiness readout, an editable staged seed, and an operator-confirmed SAVE PLAN for an existing-folder draft or CREATE &amp; SCAFFOLD for a new project (plus Creative mode for alternative directions). Nothing advances or touches disk without your click.</p>,
    manualSection: 'genesis-workflow',
  },
  'rightpanel.files.live': {
    title: 'LIVE',
    body: <p>Files changing right now in this project, grouped as <C>CHANGING</C>, <C>NEW FILES</C> and <C>STAGED</C>, refreshed about every second so the agent&apos;s edits appear as they land. Recently touched rows flash a <C>LIVE</C> marker. Click a file to see its changed lines. Arco&apos;s own <C>.arco</C> state files are hidden. Empty when nothing has changed or the folder is not a git repository.</p>,
  },
  'rightpanel.genesis.readiness': {
    title: 'Genesis: stage readiness',
    body: (
      <p>
        Genesis moves a vague idea through four stages: <C>Spark → Concept →
        Case → Build-direction</C>. This panel shows the current stage, what's
        still missing to advance, and the next question to answer. Readiness is
        advisory: you decide when to move on, save an existing-folder plan, or scaffold a new project.
      </p>
    ),
    manualSection: 'genesis-workflow',
  },
  'rightpanel.genesis.seed': {
    title: 'Genesis: the seed',
    body: (
      <p>
        The staged seed for this project. Edit the fields as the idea takes
        shape; each downstream field is anchored to the one above it. Edits save
        automatically and shape the agent's next turn. Pending edits are sent when leaving the tab and before scaffolding. Nothing is invented for
        you: empty fields stay unknown.
      </p>
    ),
    manualSection: 'genesis-workflow',
  },
  'rightpanel.genesis.scaffold': {
    title: 'Genesis: save plan or scaffold',
    body: (
      <p>
        Operator-confirmed. Pending seed edits are sent first, and seed controls are disabled while saving the public-project choice.
        For an existing-folder plan draft, SAVE PLAN saves a checklist and reference documents. SPEC.md and TODO.md are created only when missing; existing files stay unchanged and README.md is not written. The public-project box uses the folder's saved choice and Git remote suggestion, remembers the selection, and adds privacy guardrails when selected. For a new project, creates the project folder under the parent you pick
        (default <C>~/Projects</C>), writes seed docs (<C>README</C>/<C>SPEC</C>/
        <C>TODO</C>/<C>CLAUDE.md</C>), optionally a GitHub repo, then binds this
        workflow to the new folder (carrying the transcript over) and seeds a
        plan. Select the public-project box to include privacy guardrails in the plan. Creates files on disk: irreversible.
      </p>
    ),
    manualSection: 'genesis-workflow',
  },
  'rightpanel.genesis.creative': {
    title: 'Genesis: Creative mode',
    body: (
      <p>
        Run the Genesis process <em>inside</em> an existing project to explore an
        alternative direction. Arming snapshots the current project as grounding
        context (it's never invented). Creative mode never edits your project: a
        scaffold lands in a sibling <C>ALTERNATIVE/</C> folder with its own plan,
        and an established codebase shows a warning. <C>DISARM</C> is shown
        whenever Creative mode is armed and keeps the idea fields. If the idea
        diverges, use <C>SPAWN</C> to fork it into a fresh tab.
      </p>
    ),
    manualSection: 'genesis-workflow',
  },
  'rightpanel.files.changes': {
    title: 'CHANGES',
    body: <p>Everything that differs from the last commit, file by file. Each file folds open, and <C>UNIFIED</C> or <C>SPLIT</C> chooses the layout; it is the same view the GIT dialog shows before a commit. Empty when nothing has changed or the folder is not a git repository.</p>,
    manualSection: 'changes-diff',
  },
  'rightpanel.files.source': {
    title: 'SOURCE',
    body: <p>Changed files in one list, grouped as <C>STAGED</C>, <C>CHANGES</C> and <C>UNTRACKED</C> (new files git does not know yet). Click a file to see only its changes. Binary or very large files show a note instead. Empty when nothing has changed or the folder is not a git repository.</p>,
    manualSection: 'source-changes',
  },
  'rightpanel.files.remote': {
    title: 'REMOTE',
    body: <p>How this branch compares with its remote copy: commits to push and commits to pull, each with an expandable list and its changes. <C>FETCH</C> downloads the latest remote information only; it never merges or changes your files. Otherwise this view is read-only.</p>,
    manualSection: 'remote-compare',
  },
  'rightpanel.tab.activity': {
    title: 'ACTIVITY',
    body: (
      <p>
        Live stream of tool-use, thinking, and long-running activity from this
        workflow. Capped at 500 entries. The feed resets at the start of each
        turn and isn't persisted across reloads; the sticky sections above it
        (fleet / diagnostics / checkpoints / token usage / background jobs)
        survive. <C>CHECKPOINTS</C> scrolls inside a short fixed-height box so it
        can't push the live feed off-screen; click its header to hide it.{' '}
        <C>TOKEN USAGE</C>'s per-turn rows collapse: click the header.
      </p>
    ),
  },
  'rightpanel.activity.diagnostics': {
    title: 'DIAGNOSTICS',
    body: (
      <p>
        Semantic errors/warnings from the project's language server, surfaced
        after the agent writes a file. A count badge plus an expandable per-file
        list; click a row to open the file. Requires the matching LSP server on{' '}
        <C>PATH</C> (<C>typescript-language-server</C> for TS/JS,{' '}
        <C>pyright-langserver</C> for Python, <C>gopls</C> for Go,{' '}
        <C>rust-analyzer</C> for Rust): absent ⇒ no diagnostics, no error.
        Native transport only.
      </p>
    ),
  },
  'rightpanel.activity.fleet': {
    title: 'FLEET',
    body: (
      <p>
        Live readout of an <C>ultracode</C> background fleet. When an ultracode
        turn fans out, its subagents run in the background and their work never
        reaches the normal Activity stream: so this panel tails the fleet's own
        transcripts instead. The header strip (<C>N/M done · K running</C>)
        answers "is it still going?"; each row is one subagent: its task label,
        a <C>◐</C>/<C>●</C> running/done dot, and the last tool it invoked.
        Running agents sort to the top. Live-only (not replayed after a restart);
        clears when the next turn starts.
      </p>
    ),
  },
  'rightpanel.tab.review': {
    title: 'REVIEW',
    body: (
      <p>
        Read-only artifacts from past Reviews: verdict (PASS / MINOR /
        BLOCKING), reviewer model, body. <C>↳ SEND TO AGENT</C> appends the review body to the
        composer, preserving any unsent draft.
      </p>
    ),
    manualSection: 'review-action',
  },
  'rightpanel.tab.research': {
    title: 'RESEARCH',
    body: (
      <p>
        Cited research reports written by the <C>⌕ RESEARCH</C> button: each row
        expands to the full markdown report (fetched from the artifact endpoint).
        In-flight runs show a live <C>searching (n/cap)</C> note and a CANCEL
        button. Open a finished report and use <C>⌕ DIG DEEPER</C> to append a
        cited addendum without re-running the whole search.
      </p>
    ),
    manualSection: 'research-action',
  },
  'rightpanel.research.dig-deeper': {
    title: 'Dig deeper',
    body: (
      <p>
        Ask a follow-up against the report's gathered sources (e.g. "expand point
        3", "find counter-evidence"). Runs a bounded mini-round seeded with the
        existing report and appends a dated addendum to the <em>same</em> artifact
        rather than starting fresh.
      </p>
    ),
    manualSection: 'research-action',
  },
  'rightpanel.tab.handoffs': {
    title: 'HANDOFFS',
    body: <p>Handoff notes written when this tab moved to a fresh session. They are kept with the tab&apos;s saved work. A handoff still running shows a cancel mark on its row; cancelling stops it and frees the tab.</p>,
    manualSection: 'handoff-action',
  },
  'rightpanel.tab.plan': {
    title: 'PLAN',
    body: (
      <>
        <p>
          Plans available in this cwd. Active plans inline, completed ones behind
          a toggle. Click any to attach to the current workflow. Checkboxes are
          bidirectional: flip in the panel and the agent sees it next turn.
        </p>
        <p>
          When a plan is attached, review surfaces appear at whole-plan and
          per-phase granularity: <C>REVIEW PLAN</C> / <C>VERIFY WORK</C>, phase
          review/verify pills, and <C>CUSTOM REVIEW</C> (operator-picked items
          via tree picker). REVIEW means CRITIQUE; VERIFY means audit claimed
          done work against the tree and diff.
        </p>
      </>
    ),
    manualSection: 'plan-review',
  },
  'rightpanel.tab.bakeoff': {
    title: 'BAKE-OFF',
    body: (
      <>
        <p>
          Race the same implementation prompt through 2-5 ordinary agent tabs.
          Every attempt starts at the same commit on its own managed git
          worktree and branch. Enter an optional <C>NAME</C> and the{' '}
          <C>TASK PROMPT</C>, choose the number of <C>ATTEMPTS</C> and the agent
          for each, then <C>START BAKE-OFF</C>; the source checkout must be
          clean and the source tab idle. On each attempt, <C>OPEN TAB</C> shows
          its transcript and <C>VIEW DIFF</C> shows its candidate diff.
        </p>
        <p>
          Nothing chooses or merges a winner automatically. <C>PROMOTE</C> is
          an explicit operator action: Arco refuses a dirty or moved source
          checkout, commits project changes on the candidate branch, excludes{' '}
          <C>.arco</C> state, and performs a no-fast-forward merge. Cleanup
          removes managed worktrees but preserves their branches:{' '}
          <C>REMOVE LOSING WORKTREES</C> after a winner is promoted, or{' '}
          <C>REMOVE ALL WORKTREES</C>. Both ask for confirmation.
        </p>
      </>
    ),
  },
  'rightpanel.tab.config': {
    title: 'CONFIG',
    body: (
      <>
        <p>Settings for this tab that apply while it runs: model, effort, Codex sandbox, Claude tool list, auto-handoff after a number of compactions and the memory guard. A red dot means the provider&apos;s command-line tool changed what it supports since you last looked.</p>
        <p>Claude tabs choose a <C>TRANSPORT</C>: <C>cli</C> starts the command-line tool for each turn, while <C>native</C> keeps a long-running worker that adds compaction, automatic handoff, plan mode and subtasks. Codex tabs choose <C>exec</C> or <C>app-server</C>; app-server adds clean interrupts and steering during a turn. Reviews and handoff notes for Claude and Codex always use the command-line tool.</p>
        <p>Every tab has <C>OUTPUT STYLE</C>: <C>NORMAL</C>, <C>PLAIN</C> (clear sentences with the answer first, and a complete final reply) and <C>TERSE</C> (short sentences, no summary). It changes how replies are written, not what is sent. Plain is the default: a tab without a saved choice uses it, and a tab saved as Lite before 0.1.5 uses Plain. Code, error text and file paths stay exact, and Review, Handoff, DOCS and GIT always use Normal.</p>
      </>
    ),
    manualSection: 'config-tab',
  },
  'rightpanel.config.model': {
    title: 'Model (live swap)',
    body: (
      <>
        <p>
          Switch the model for the next turn. Same-provider swaps don't rotate the
          session: they take effect immediately on the following turn. The list
          is the live provider catalog. If the Codex CLI is missing, its picker
          uses the last available catalog or a fallback list, and the server
          keeps running. Strata also lists its prepared local
          profiles; loading happens on the next
          message and only one is resident. To change <em>provider</em>, use Handoff
          (same tab) or Spawn (new tab) instead.
        </p>
        <p>
          Cursor applies the swap <em>in-session</em> (no respawn), confirms it, and
          posts a "model swapped" notice on the next turn. Cursor runs each model
          with the settings saved for it in the Cursor CLI; when the chosen variant
          differs, a notice names both models and the model chip shows the one in
          use. Choosing a Cursor model also makes it the Cursor CLI's default. Because
          Cursor bakes reasoning effort into the model id, the picker splits into
          <b>family</b> + <b>effort</b> (plus optional FAST / THINK) and resolves to
          the exact catalog id: the EFFORT row below stays a note. The status chip's
          effort is read back out of that id, so it's always the real one.
        </p>
      </>
    ),
    manualSection: 'live-config-swap',
  },
  'rightpanel.config.effort': {
    title: 'Effort (live swap)',
    body: (
      <p>
        Reasoning budget for the next turn. The available levels come from the
        selected model's catalog entry. On Ollama, LOW turns thinking off and the
        rest are the model's own advertised thinking levels (LOW / HIGH on models
        without levels). Strata uses NONE / LOW / MEDIUM / HIGH: NONE disables
        reasoning; HIGH maps to Qwen xhigh. Cursor has no separate effort picker; it
        bakes effort into the model id; the others expose no effort flag.
      </p>
    ),
    manualSection: 'live-config-swap',
  },
  'rightpanel.config.auto-compaction': {
    title: 'Auto-compaction',
    body: <p>Choose a worker override or inherit its cluster default. Enabled policies use a 30-95% threshold separately for each worker. Claude Native and Codex app-server compact between turns; Ollama compacts before dispatch. Other transports are unavailable for this policy. Ollama summarizes verified completed executions before the next turn and reuses saved summaries. Legacy or partial history defers safely; raw events remain available. Auto-handoff counts these compactions. Explicit Off stops automatic compaction, and auto-handoff then shows that it needs auto-compaction. Provider uses Arco compaction near 90% for Claude Native and Ollama; Claude CLI and Codex compact themselves. Claude Native also compacts inside a long turn: when a request reaches the threshold (70% under Provider) it summarizes the earlier history, keeps the tool call in progress, and the same turn continues; chat shows Compacting automatically and then Compacted, continuing. Off turns this off too, and so does Claude API compaction. Fold is deterministic, while handoff starts a fresh session.</p>,
    manualSection: 'auto-handoff',
  },
  'rightpanel.config.claude-api-compaction': {
    title: 'Claude API compaction (beta)',
    body: <p>Optional Claude server compaction for this tab. It is off for new tabs. COMPACT and Provider auto-compaction use Arco's own compaction and do not need it. When enabled, Claude's servers shrink long conversations themselves.</p>,
    manualSection: 'auto-handoff',
  },
  'rightpanel.config.auto-handoff': {
    title: 'Auto-handoff',
    body: (
      <p>
        Hand off after N compactions: auto-compaction keeps the context in check,
        and after this many compactions in one conversation (default 5, 1 to 20)
        Arco starts a fresh session at the end of a turn, in the chosen mode
        (QUICK, ORIGINAL WORKER or FRESH SUMMARIZER). Off by default. Nothing is
        shown before it; afterwards one chat line says how many compactions there
        were and links the handoff document. The count starts again with the new
        session. A Fold does not count. Claude Native and Ollama need
        auto-compaction on; Claude CLI and Codex app-server report their own
        compactions. Where Arco cannot count (Cursor, Codex exec, providers without
        compaction) the control is unavailable and says why.
      </p>
    ),
    manualSection: 'auto-handoff',
  },
  'rightpanel.config.auto-fold': {
    title: 'Auto-fold (Native)',
    body: (
      <p>
        Operator-armed, Claude-Native-only, off by default. Arco
        deterministically folds older transcript history into a digest and keeps
        a verbatim recent tail: same session, instant,{' '}
        <em>no model round</em>. The raw transcript stays in <C>events.jsonl</C>.
        Fires when the context budget crosses <C>FOLD AT</C>. A Fold is not
        counted toward auto-handoff. The composer's <C>FOLD</C> button forces one
        immediately regardless.
      </p>
    ),
    manualSection: 'auto-handoff',
  },
  'rightpanel.config.transport': {
    title: 'Transport',
    body: (
      <>
        <p>
          Per-tab transport toggle. Claude: <C>cli</C> (per-turn spawn) vs{' '}
          <C>native</C> (long-lived in-process worker: unlocks server-side
          compact, plan-mode arming, and <C>Task</C> fan-out). Codex:{' '}
          <C>exec</C> vs <C>app-server</C> (unlocks structured interrupt + steer).
          For Claude and Codex, reviewer and handoff-seed work uses CLI or exec regardless of the tab transport.
        </p>
        <p>
          <strong>Ultracode</strong> (toggle below): sticky deep multi-agent
          mode: Claude authors a <C>Workflow</C> that fans out a subagent fleet,
          like <C>ultracode</C> in the Claude CLI. While on it forces <C>cli</C>{' '}
          + the Workflow tool + <C>xhigh</C>; the transport buttons above are
          your base for when it's off. Runs unattended with full access and
          spends heavily; takes effect next turn; reversible.
        </p>
      </>
    ),
    manualSection: 'config-tab',
  },
  'rightpanel.config.codex-context': {
    title: 'Codex context window',
    body: (
      <p>
        Codex only, per tab. <C>MAX</C> (the Arco default) asks Codex for the
        largest window the selected model + account accepts, read live from that
        account&apos;s <C>models_cache.json</C> (<C>max_context_window</C>);{' '}
        <C>STANDARD</C> leaves Codex at its conservative default. Button labels show
        the effective size. Applies next turn on both exec and app-server (an
        app-server child recycles and resumes the same thread). The CTX meter
        prefers Codex&apos;s own reported window; missing catalog metadata falls
        back to Codex defaults. The metadata home follows the selected account, then <C>CODEX_HOME</C>, then the CLI default.
      </p>
    ),
    manualSection: 'config-tab',
  },
  'rightpanel.config.web-budget': {
    title: 'Web lookups / turn',
    body: (
      <p>
        Native-only. A per-turn cap on the Claude Native <C>web_search</C> +{' '}
        <C>web_fetch</C> server tools (the Anthropic <C>max_uses</C> parameter).
        This is an <strong>Arco-set ceiling, not an Anthropic account limit</strong>:
        it resets every turn, and when a turn exhausts it the model reports web
        access ran out. Default <C>15</C>; raise it for research-heavy tabs.
        Takes effect on the next turn. CLI Claude ignores this (it routes web
        tooling through the <C>claude</C> binary, which budgets itself).
      </p>
    ),
    manualSection: 'config-tab',
  },
  'rightpanel.config.output-style': {
    title: 'Output style',
    body: (
      <p>
        How this tab&apos;s replies are written, on every provider.{' '}
        <C>PLAIN</C>, the default, asks for clear sentences with the answer
        first, and ends every turn with a complete reply: what was done,
        checked and found, assumptions, risks, what is left and what needs
        you. A tab without a saved choice uses it. <C>TERSE</C> asks for
        short sentences of about 20 words and leaves out that summary. <C>NORMAL</C> adds
        no instruction. Negations, numbers, code, error text and file paths
        stay exact, and code, files, commits and messages to other agents are
        written in full. Review, Handoff, DOCS and GIT always use{' '}
        <C>NORMAL</C>. A tab saved as Lite before 0.1.5 uses Plain.
      </p>
    ),
    manualSection: 'config-tab',
  },
  'rightpanel.config.north-star': {
    title: 'North star',
    body: (
      <p>
        A durable, per-tab objective pinned into the system prompt every turn
        until you clear it: it steers priorities and what "done" looks like.
        Operator-only write, model read-only; capped at <C>2048</C> bytes
        (trimmed on save). Pure context, <strong>not</strong> an instruction to
        act autonomously: it never loops, grades work, or spawns anything.
        Inherited by Review / Handoff / Spawn / DOCS / GIT. Also settable via the{' '}
        <C>/goal</C> composer command or the always-visible NORTH STAR chip above
        the composer.
      </p>
    ),
    manualSection: 'config-tab',
  },
  'rightpanel.config.goal-run': {
    title: 'Goal run',
    body: (
      <>
        <p>
          Keeps this tab working toward its north star without you retyping
          &quot;continue&quot;. Armed for a fixed number of iterations; after each
          turn settles, one automatic continuation turn is dispatched. Every
          iteration is an ordinary visible turn in the transcript, and a{' '}
          <C>RUN n/N</C> chip with the running token spend sits above the
          composer while a run is armed: click it to stop.
        </p>
        <p>
          Codex cached input counts once toward the token cap. The optional token cap is in millions and stops the run when crossed;
          blank means iterations are the only limit. A run also stops on a turn
          error, a rate-limited provider, context past 92%, or a cleared north
          star: each announced with its reason. Your own messages do{' '}
          <strong>not</strong> stop it, so you can steer mid-run.
        </p>
        <p>
          Composer equivalents: <C>/goal run 10</C>, <C>/goal run</C> for status,{' '}
          <C>/goal run stop</C>. Counters aren&apos;t persisted, so a server
          restart ends any armed run. The loop continues because budget remains
          and stops because it doesn&apos;t: it never asks the model whether the
          work is finished.
        </p>
      </>
    ),
    manualSection: 'config-tab',
  },
  'rightpanel.config.project-trust': {
    title: 'Project trust',
    body: (
      <>
        <p>
          Whether this tab&apos;s repo may fold its own <C>CLAUDE.md</C>, project
          skills (<C>.arco/skills</C>), and <C>.arco/settings.json</C> into
          the model turn. Untrusted repos have those suppressed: a repo you
          clone can&apos;t inject instructions into your agent before you&apos;ve
          read them. The turn still runs either way.
        </p>
        <p>
          <C>TRUSTED</C> folds them in from the next turn; <C>BLOCKED</C>{' '}
          suppresses silently; <C>ASK</C> forgets the decision and re-arms the
          one-time composer prompt. Decisions are keyed by <em>directory</em>{' '}
          (nearest ancestor wins), so setting it here covers every tab and every
          cluster member pointed at the same cwd. Recorded in{' '}
          <C>~/.arco/trust.json</C>; manage all of them at once in SETTINGS →
          PROJECT TRUST.
        </p>
      </>
    ),
    manualSection: 'config-tab',
  },
  'rightpanel.config.mcp': {
    title: 'MCP servers',
    body: (
      <p>
        Claude Native retries failed or closed connections at the next turn and reconnects changed launch settings. Register external <C>MCP</C> servers once (machine-global) and enable
        them per tab. Enabling a server exposes all its tools <em>except</em>{' '}
        dangerous ones (write / delete / exec / shell / post and similar), which stay OFF
        until you tick them per tab. <C>probe</C> connects, lists the tools, and
        flags the dangerous ones. On CLI Claude the denylist is enforced via{' '}
        <C>--disallowedTools</C> (composes with skip-permissions). Codex has no
        per-tool gate: an enabled server exposes <strong>all</strong> its
        tools. No hidden, model-selected expansion: only servers you enable.
      </p>
    ),
    manualSection: 'config-tab',
  },
  'rightpanel.config.ollama-lifecycle': {
    title: 'Model lifecycle (Ollama)',
    body: (
      <p>
        Ollama-tab readout of which models the local (and remote) daemon
        currently holds resident, with a <C>↻</C> refresh. The header count is
        how many are loaded. The <C>keep_alive</C> line (how long an idle model
        stays in VRAM) is set under ADVANCED PARAMS.
      </p>
    ),
    manualSection: 'config-tab',
  },
  'rightpanel.config.ollama-compaction': {
    title: 'Auto-compaction (Ollama)',
    body: (
      <p>
        Ollama tabs have no resident session to compact, so at the{' '}
        <C>THRESHOLD</C> fill % Arco summarizes older messages{' '}
        <em>in place</em>, keeping the newest <C>KEEP LAST</C> messages, so the
        next turn fits the window (<C>WARN</C> only flags fill near the
        threshold). The summary uses the Ollama utility model from Settings,
        or a deterministic digest when none is set. This is a{' '}
        <strong>global</strong> setting (applies to every Ollama tab); the
        composer <C>⊟ COMPACT</C> button forces a round on the next turn
        regardless. The summary uses the OLLAMA COMPACTION UTILITY MODEL from
        Settings &gt; Providers and models &gt; Sign-in, accounts and local
        endpoints when one is set; otherwise Arco writes a deterministic
        digest. The summary framing prompt is editable in Settings &gt; Agents
        and clusters &gt; Handoff prompts.
      </p>
    ),
    manualSection: 'config-tab',
  },
  'rightpanel.config.ollama-params': {
    title: 'Advanced params (Ollama)',
    body: (
      <p>
        Per-tab Ollama generation params merged into <C>/api/chat</C> through a
        typed allowlist: <C>num_ctx</C> (trusted-only: clamped to the model's
        probed window, a higher value is dropped), <C>keep_alive</C>,{' '}
        <C>num_gpu</C> (GPU layers; 0 = CPU-only), <C>temperature</C>, plus
        power-user keys (<C>top_p</C>, <C>num_predict</C> and others) accepted on the
        wire. Takes effect next turn; <C>RESET</C> clears them back to the
        Modelfile / daemon defaults.
      </p>
    ),
    manualSection: 'config-tab',
  },
  'rightpanel.config.ollama-vram': {
    title: 'VRAM budget (Ollama)',
    body: (
      <p>
        Hardware-awareness readout for Ollama tabs on a local NVIDIA box: a
        used / total VRAM headroom bar (from <C>nvidia-smi</C> via{' '}
        <C>GET /api/ollama/vram</C>) plus a predictive context-sizer (<C>POST
        /api/ollama/fit</C>) for the largest <C>num_ctx</C> the primary can use
        on this GPU, reserving headroom for a local utility model. Degrades to a
        notice when no CUDA GPU is present (a remote daemon costs zero local
        VRAM).
      </p>
    ),
    manualSection: 'config-tab',
  },
  'rightpanel.tab.tasks': {
    title: 'TASKS',
    body: <p>Subtasks the agent started with its Task tool. Each card shows whether the subtask is running, done, failed or cancelled, how long it has run, and <C>PROMOTE</C> to open it as its own tab. The tab appears only when this agent has started subtasks; subtasks of subtasks are not shown.</p>,
    manualSection: 'tasks-tab',
  },
  'rightpanel.tab.ledger': {
    title: 'LEDGER',
    body: (
      <>
        <p>The project&apos;s task list: tasks for this project folder that last across sessions and tabs. It is separate from PLAN (a plan and its reviews) and TASKS (subtasks the agent starts within a turn); work from either can attach to a ledger task.</p>
        <p>Every change is recorded, so the list can be rebuilt if its saved copy is lost. Only you can mark a task <C>DONE</C> or <C>ARCHIVED</C>, from the status picker; nothing does it automatically.</p>
      </>
    ),
  },
  'rightpanel.ledger.add': {
    title: 'Add task',
    body: <p>Create a new task in this project folder's ledger. New tasks always start as <C>TODO</C>: there is no create-as-done path.</p>,
  },
  'rightpanel.ledger.status': {
    title: 'Task status',
    body: <p>Set the task's status: <C>TRIAGE</C> / <C>TODO</C> / <C>READY</C> / <C>IN PROGRESS</C> / <C>BLOCKED</C> / <C>REVIEW</C> / <C>DONE</C> / <C>ARCHIVED</C>. This is the only way to mark a task done or archived, and it's always an explicit operator action: Arco never infers terminal status.</p>,
  },
  'rightpanel.ledger.edit': {
    title: 'Edit task',
    body: <p>Edit the task title and notes inline. Changes persist to the ledger and append an event to the durable log.</p>,
  },
  'rightpanel.ledger.delete': {
    title: 'Delete task',
    body: <p>Remove the task from the ledger. Recorded as a delete event in <C>events.jsonl</C> so the projection stays rebuildable.</p>,
  },
  'rightpanel.ledger.worktree': {
    title: 'Task worktree',
    body: (
      <>
        <p>
          <C>ISOLATE</C> spins an isolated <C>git worktree</C> for this task: a
          separate checkout on its own <C>arco/task/…</C> branch off the current
          HEAD: so parallel work on one repo doesn't collide. It lives under a
          managed path outside your project tree; shadow-git checkpoints work
          inside it and share the repo's object store.
        </p>
        <p>
          <C>REMOVE</C> tears the checkout down and prunes it, but <strong>keeps
          the branch</strong> so any committed work is preserved. Needs a git repo
          with at least one commit.
        </p>
      </>
    ),
  },
  'rightpanel.ledger.worktree-required': {
    title: 'Worktree required',
    body: (
      <p>
        Marks this task as needing an isolated checkout before automated
        dispatch runs it. The flag does not create a worktree by itself; use{' '}
        <C>ISOLATE</C> manually or arm the board&apos;s <C>AUTO WORKTREE</C>{' '}
        dispatcher setting.
      </p>
    ),
  },
  'rightpanel.ledger.link': {
    title: 'Task links',
    body: (
      <>
        <p>
          Bidirectional references from this task to a plan item, a review, a
          workflow, or a URL. Click a chip to jump to it: <C>PLAN</C> opens the
          Plan tab, <C>REVIEW</C> opens History, <C>WORKFLOW</C> selects that
          tab if it's still open, <C>URL</C> opens a new browser tab.
        </p>
        <p>
          Attach with <C>+ LINK</C> (pick a kind, enter the ref, optional label)
          and remove with the <C>×</C> on a chip. Both persist through the same
          ledger update event: the reverse direction (which tasks point at a
          given plan/review/workflow) is queryable server-side.
        </p>
      </>
    ),
  },
  'rightpanel.tab.history': {
    title: 'HISTORY',
    body: (
      <>
        <p>
          Read-only timeline of seq-stamped narrative events for this workflow.
          Four operator actions: <C>LABEL THIS</C> pins a free-text label
          to a prior event (persisted, survives replay), <C>REVIEW FROM HERE</C>{' '}
          dispatches a since-event Review, <C>SPAWN FROM HERE</C> opens a
          cutoff-aware Spawn dialog, and <C>REWIND CONVERSATION</C> moves the
          live head back to a prior point for Claude Native workers (the current
          branch is kept and can be returned to, so the rewind is itself
          reversible: two-click confirm; for other providers and the Claude CLI
          the button stays visible, disabled, with the reason beside it). A{' '}
          <C>REWINDS</C> filter category surfaces the
          fork / leaf-move events. The filter strip (<C>ALL</C>, <C>TURNS ONLY</C>,{' '}
          <C>TOOL CALLS</C>, <C>LABELS</C>, <C>HANDOFFS</C>, <C>REVIEWS</C>,{' '}
          <C>CHECKPOINTS</C>, <C>REWINDS</C>) persists per workflow. Selecting an
          event shows the label field and the action buttons for that point.
         Replay keeps the original saved event time.</p>
        <p>
          Click an event row to scroll-and-flash the corresponding chat row
          (when the event has a chat message id: user sends + assistant
          completes today; tool calls / handoffs / reviews are listed but
          don't flash).
        </p>
      </>
    ),
    manualSection: 'history-tab',
  },
  'rightpanel.history.checkpoint': {
    title: 'CHECKPOINT REVERT',
    body: (
      <>
        <p>
          Each <C>CHECKPOINT ●</C> row is a working-tree snapshot Arco took
          before a file-mutating turn (your real git HEAD / index are never
          touched). <C>VIEW DIFF VS NOW</C> shows what's changed since that
          checkpoint, in Git and non-Git folders alike.
        </p>
        <p>
          <C>REVERT TO HERE</C> restores the working tree to that checkpoint:
          faithfully, so files created after it are removed. Before anything
          changes, the confirm dialog counts the files it would change back,
          remove and restore, or says that nothing would change. It is safe: Arco
          ALWAYS takes a fresh <C>pre-revert</C> checkpoint first, so the revert
          is itself undoable (revert to that pre-revert marker to undo). Can't
          revert while a turn is running: cancel it first.
        </p>
        <p>
          Only files go back. The conversation, the task board and other cluster
          members stay as they are; use <C>REWIND CONVERSATION</C> for the
          conversation. In a cluster the checkpoint covers the whole folder,
          including files other members changed. Afterwards a result line and the{' '}
          <C>REVERTED</C> row show the counts; <C>VIEW CHANGES</C> on either shows
          the diff of what the revert changed.
        </p>
      </>
    ),
    manualSection: 'history-tab',
  },
  'rightpanel.history.rewind': {
    title: 'REWIND CONVERSATION',
    body: (
      <p>
        Moves the selected worker&apos;s conversation head back to the selected
        event; the current branch is kept and can be returned to, so a rewind is
        reversible. Two clicks confirm. It works for Claude Native workers only.
        For other providers and the Claude CLI the button stays visible but
        disabled, with the reason beside it. It does not touch files; use{' '}
        <C>REVERT TO HERE</C> on a checkpoint row for those.
      </p>
    ),
    manualSection: 'history-tab',
  },
  'rightpanel.history.purge': {
    title: 'PURGE CONVERSATION',
    body: (
      <>
        <p>
          Permanently delete this entire conversation and everything Arco wrote
          for it: transcript (<C>events.jsonl</C>), <C>meta.json</C>, checkpoints,
          artifacts, handoffs, the recall entry. <strong>There is no undo.</strong>
          {' '}The tab closes on success.
        </p>
        <p>
          Two tiers: <C>ARCO DATA ONLY</C> leaves the provider's own session
          file (the bare CLI could still resume it); <C>☢ NUCLEAR</C> also deletes
          the underlying Claude/Codex session files so it's gone from those tools
          too. Nuclear requires typing the conversation name to confirm.
        </p>
      </>
    ),
  },
  'rightpanel.tab.usage': {
    title: 'USAGE',
    body: (
      <>
        <p>
          Open from <C>MEMORY &gt; USAGE</C> in a single-worker, chat or cluster tab
          (a cluster tab covers all members, since they share one folder). Per-provider,
          per-day token-volume + cache-hit-ratio trends for every conversation under
          this project's cwd: a quota-pressure read of{' '}
          <em>which tab/model is eating your rolling window</em>, framed as token
          volume (never cost). Backed by <C>GET /api/usage-stats</C>, a read-only
          deterministic aggregation of the <C>primary_turn_token_usage</C> events
          already in each workflow's <C>events.jsonl</C>: no new capture, nothing
          mutated.
         Failed or invalid reads show an error; reopen USAGE to retry.</p>
        <p>
          Each provider block shows a hand-drawn SVG sparkline of daily prompt
          volume, a cache-hit-ratio bar, and a per-day breakdown. Cache-hit ratio
          uses the provider-correct denominator (Claude's input/cache fields are
          disjoint; Codex's <C>cacheRead</C> is a subset of <C>input</C>).
        </p>
      </>
    ),
  },
  'storage.move-project': { title: 'MOVE TO PROJECT', manualSection: 'archive-explorer', body: <p>Choose KEEP IT PRIVATE or review a copy into a project folder. Create folder reveals the new-folder fields. The original stays. Git status, repository visibility, size and text findings appear before the copy; binary files other than images and recordings are scanned for readable text only and listed as not fully scanned, as are files past the findings limit. Arco never stages or commits the copy.</p> },
  'storage.keep-artifact': { title: 'KEEP artifact', manualSection: 'archive-explorer', body: <p>Keep the artifact in Arco and protect it from cleanup, archive and later size warnings.</p> },
  'storage.choose-folder': { title: 'CHOOSE ANOTHER FOLDER', manualSection: 'archive-explorer', body: <p>Choose a different destination inside this project and review its checks. Create folder reveals the new-folder fields; resize or maximize the picker to see more.</p> },
  'storage.ignore-copy': { title: 'ADD TO .GITIGNORE', manualSection: 'archive-explorer', body: <p>Add a rule for this destination to the project's ignore file, then check it again. This does not stage or commit anything.</p> },
  'storage.copy-confirm': { title: 'Copy into project', manualSection: 'archive-explorer', body: <p>Copy after reviewing Git status, visibility, size and findings. Files not fully scanned are listed: binary files other than images and recordings (only their readable text is scanned), and files past the findings limit (1,000 per file, 2,000 per copy). Copying them to a public repository outside Git ignore requires a second confirmation. Projects opened through a linked parent folder are supported, but links inside artifacts are refused. The original stays in Arco; existing files are never overwritten. A failed copy can leave partial files at the destination. The temporary folder must be outside the project and Git repositories.</p> },
  'storage.warning': { title: 'Large artifacts', manualSection: 'archive-explorer', body: <p>Warns when artifact files or totals cross the configured thresholds. KEEP protects the item from storage cleanup and archive.</p> },
  'storage.warning-keep': { title: 'KEEP artifact', manualSection: 'archive-explorer', body: <p>Protect the warned item from cleanup, archive and later size warnings.</p> },
  'storage.warning-dismiss': { title: 'Dismiss warning', manualSection: 'archive-explorer', body: <p>Dismiss this warning without protecting the item.</p> },
  'rightpanel.storage.scan': {
    title: 'MEASURE STORAGE', manualSection: 'right-panel',
    body: <p>Under MEMORY &gt; USAGE in a single-worker, chat or cluster tab, measure the current project's saved state without changing it. Every byte is listed under one heading: conversation logs, artifacts, handoffs, checkpoints, scratch files, plans, task boards, worktrees and isolated copies, archived conversations, or other. MEASURE AGAIN refreshes the cached result. Large files and incomplete scans are marked; shared checkpoint data is listed separately. From anywhere, ARTIFACTS &gt; STORAGE also measures with MEASURE AGAIN.</p>,
  },
  'rightpanel.storage.home': {
    title: 'MEASURE ARCO FOLDER', manualSection: 'right-panel',
    body: <p>Under MEMORY &gt; USAGE in a single-worker, chat or cluster tab, measure Arco's own folder without changing it: voice and media models, caches and browser profiles, provider account data, shared checkpoints, task worktrees, saved clusters, server logs and other files. Chat and Genesis project folders inside it are skipped here and counted with their own projects. Click again to refresh. From anywhere, ARTIFACTS &gt; STORAGE also measures with MEASURE AGAIN.</p>,
  },
  'rightpanel.usage.refresh': {
    title: 'REFRESH',
    body: <p>Re-runs the read-only aggregation against disk: pick up turns recorded since you opened the tab.</p>,
  },
  'rightpanel.tab.preview': {
    title: 'PREVIEW',
    body: (
      <>
        <p>A live view of this tab&apos;s local app. Bind its port by hand, or let Arco pick it up when the agent starts a dev server; Arco then shows the app through its own address, so live reload keeps working without forwarding the port. Each automatic candidate request has a 500 ms deadline.</p>
        <p>The view is drawn at a fixed desktop width and scaled to fit the panel without cropping, in the aspect ratio you pick. The ratio is remembered in this browser for every tab.</p>
      </>
    ),
    manualSection: 'preview-tab',
  },
  'rightpanel.tab.github': {
    title: 'GITHUB',
    body: (
      <>
        <p>The GitHub browser for this tab&apos;s project folder, inside the right panel. Browse the repository, pull requests, issues and Actions runs, or jump to a file, while the chat stays in view. It is the same browser as the header GitHub view, opened on this project.</p>
        <p>It uses the same GitHub sign-in as the header view; no separate login.</p>
      </>
    ),
    manualSection: 'github',
  },

  // ----------------------------------------------------------- KNOWLEDGE (B3)
  'rightpanel.tab.knowledge': {
    title: 'KNOWLEDGE',
    body: (
      <p>
        Per-project knowledge base: durable facts, gotchas, and links stored as
        markdown under <C>.arco/knowledge/</C>. Mark an article{' '}
        <em>always include</em> to fold it into every turn's system prompt
        (within a bounded byte budget); leave it on-demand to keep it readable
        here only. Articles are operator-authored or agent-drafted, but nothing
        saves without an explicit <C>Save</C>.
      </p>
    ),
    manualSection: 'knowledge-base',
  },
  'rightpanel.knowledge.add': {
    title: '+ ADD',
    body: <p>Opens <C>ADD ARTICLE</C> with three sources: <C>Blank article</C>, <C>Quick link</C> (a URL and a summary you write) or <C>Distill from this session</C> (an agent drafts from the transcript). Each ends in editable fields you <C>SAVE</C>.</p>,
    manualSection: 'knowledge-base',
  },
  'rightpanel.knowledge.budget': {
    title: 'Injection budget',
    body: <p>Running total of always-include article bytes vs the bounded injection budget. Always-include articles fold into every turn's system prompt; over budget, the block truncates with a notice so the KB can never silently bloat context.</p>,
    manualSection: 'knowledge-base',
  },
  'rightpanel.knowledge.search': {
    title: 'Search knowledge',
    body: <p>Case-insensitive filter over article titles and tags.</p>,
    manualSection: 'knowledge-base',
  },
  'rightpanel.knowledge.toggle-always': {
    title: 'Always include / on-demand',
    body: <p>Toggle whether this article folds into every turn's system prompt (always include) or stays operator-readable here only (on-demand).</p>,
    manualSection: 'knowledge-base',
  },
  'rightpanel.knowledge.delete': {
    title: 'Delete article',
    body: <p>Remove this article from the knowledge base (deletes its markdown file under <C>.arco/knowledge/</C>).</p>,
    manualSection: 'knowledge-base',
  },
  'rightpanel.knowledge.backlinks': {
    title: 'Linked conversations',
    body: (
      <p>
        Conversations the operator linked to this article (via Recall's "Distill
        to KB"). Each is a click-through that opens the conversation tab when it's
        open. Read-only here; manage links from the Recall view.
      </p>
    ),
    manualSection: 'knowledge-base',
  },
  'rightpanel.knowledge.add-blank': {
    title: 'Blank article',
    body: <p>Start an empty article and write it yourself.</p>,
    manualSection: 'knowledge-base',
  },
  'rightpanel.knowledge.add-link': {
    title: 'Quick link',
    body: <p>Paste a URL and write a short summary. The URL is <em>not</em> auto-fetched (deferred-SSRF posture, same as <C>@url:</C>): you supply the title/summary.</p>,
    manualSection: 'knowledge-base',
  },
  'rightpanel.knowledge.add-distill': {
    title: 'Distill from this session',
    body: <p>An agent <em>drafts</em> an article from the current transcript. The agent only proposes: it has no write tool. You edit the draft and explicitly <C>Save</C>; nothing is auto-saved. Unsent or disconnected pending requests show an error; retry when connected.</p>,
    manualSection: 'knowledge-base',
  },
  'rightpanel.knowledge.link-url': {
    title: 'Quick-link URL',
    body: <p>The source URL. Pasted into the article body verbatim; not fetched server-side.</p>,
    manualSection: 'knowledge-base',
  },
  'rightpanel.knowledge.field-title': {
    title: 'Article title',
    body: <p>A short, specific title for this knowledge-base article.</p>,
    manualSection: 'knowledge-base',
  },
  'rightpanel.knowledge.field-body': {
    title: 'Article body',
    body: <p>The markdown body: the durable fact, steps, or gotcha worth remembering across sessions.</p>,
    manualSection: 'knowledge-base',
  },
  'rightpanel.knowledge.field-tags': {
    title: 'Tags',
    body: <p>Comma-separated tags for search and organization.</p>,
    manualSection: 'knowledge-base',
  },
  'rightpanel.knowledge.always-include': {
    title: 'Always include in context',
    body: <p>When checked, this article folds into every turn's system prompt (within the bounded injection budget). Otherwise it stays operator-readable in the tab only.</p>,
    manualSection: 'knowledge-base',
  },
  'rightpanel.knowledge.save': {
    title: 'Save article',
    body: <p>Persist the article to the knowledge base. <strong>This is the only path that saves</strong>: a distilled draft is never saved until you click here.</p>,
    manualSection: 'knowledge-base',
  },
  'rightpanel.workspace-rename': {
    title: 'Workspace name',
    body: <p>Shows this workspace's name. <C>RENAME</C> opens a dialog: enter up to 64 characters and <C>SAVE</C>, or leave the field blank to reset to the default name. The rename keeps the workflow's identity, saved work and any running turn.</p>,
  },
  'rightpanel.files.blast-radius': {
    title: 'BLAST RADIUS',
    body: <p>Shown when codebase memory is attached to this tab. Lists what the current uncommitted changes may affect, such as importers, call sites and routes, from the codebase index. Re-index from CONFIG &gt; Indexes and memory when the index is out of date.</p>,
  },
  'rightpanel.files.sandbox': {
    title: 'SANDBOX',
    body: <p>Shown when the efficiency sandbox is on for this tab. Lists the most recent large tool outputs stored in the sandbox instead of the conversation, with their language, size and a preview.</p>,
  },
  'rightpanel.config.codebase-memory': {
    title: 'Indexes and memory',
    body: <p>Attach codebase memory to this tab records that the tab should use the local codebase index. <C>INDEX PATH</C> chooses the folder to index (the working folder by default), and <C>Re-index now</C> rebuilds the index once. The status line shows the indexed file count and the last sync. Indexing is deterministic and uses no model.</p>,
  },
};
