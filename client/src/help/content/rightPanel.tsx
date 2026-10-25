import { C } from './shared';
import type { HelpEntry } from './shared';

export const rightPanelHelp: Record<string, HelpEntry> = {
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
  // I2 — second-level grouping. The right-panel tabs are grouped by purpose;
  // the group selector is the top row, the active group's tabs the second.
  'rightpanel.group.workspace': {
    title: 'WORKSPACE group',
    body: <p>The where + scaffold surfaces: <C>FILES</C> (explorer, changes, source, remote) and <C>GENESIS</C> (project ideation). Click a group to jump to its first tab; the active tab pins you to its group.</p>,
  },
  'rightpanel.group.agent': {
    title: 'AGENT group',
    body: <p>What the primary agent is doing + the operator primitives over it: <C>ACTIVITY</C>, <C>REVIEW</C>, <C>RESEARCH</C>, <C>HANDOFFS</C>, <C>PLAN</C>, <C>BAKE-OFF</C>, and <C>TASKS</C> (when there are Task children).</p>,
  },
  'rightpanel.group.memory': {
    title: 'MEMORY group',
    body: <p>Durable knowledge + history: <C>KNOWLEDGE</C> (codebase memory), <C>LEDGER</C> (project task ledger), <C>HISTORY</C> (event scrub), <C>USAGE</C> (token/cost).</p>,
  },
  'rightpanel.group.runtime': {
    title: 'RUNTIME group',
    body: <p>Live runtime surfaces: <C>PREVIEW</C> (dev-server viewport), <C>CONFIG</C> (per-workflow settings), <C>GITHUB</C>. A red dot on the group header means CONFIG has unseen CLI changes.</p>,
  },
  'rightpanel.tab.files': {
    title: 'FILES',
    body: <p>File explorer for the workflow's cwd. Click to open in the viewer modal. Honors <C>.gitignore</C>.</p>,
  },
  'rightpanel.tab.genesis': {
    title: 'GENESIS',
    body: <p>Project ideation for this tab: walks a vague idea through <C>Spark → Concept → Case → Build-direction</C> with an advisory readiness readout, an editable staged seed, and an operator-confirmed create-&amp;-scaffold step (plus Creative mode inside an existing project). Nothing advances or touches disk without your click.</p>,
    manualSection: 'genesis-workflow',
  },
  'rightpanel.files.live': {
    title: 'LIVE',
    body: (
      <p>
        Live view of this workflow&apos;s git working tree — changed files
        grouped <C>CHANGING</C> / <C>NEW FILES</C> / <C>STAGED</C>, auto-polling
        (~1.2s) so an agent&apos;s edits surface as they land (freshly-touched
        rows flash a <C>LIVE</C> marker). Click a file to see its changed lines
        highlighted inline. Arco&apos;s own <C>.archon</C> state files are
        hidden; shows an empty state when the tree is clean or the cwd isn&apos;t
        a git repo.
      </p>
    ),
  },
  'rightpanel.genesis.readiness': {
    title: 'Genesis — stage readiness',
    body: (
      <p>
        Genesis moves a vague idea through four stages — <C>Spark → Concept →
        Case → Build-direction</C>. This panel shows the current stage, what's
        still missing to advance, and the next question to answer. Readiness is
        advisory — you decide when to move on and when to scaffold.
      </p>
    ),
    manualSection: 'genesis-workflow',
  },
  'rightpanel.genesis.seed': {
    title: 'Genesis — the seed',
    body: (
      <p>
        The staged seed for this project. Edit the fields as the idea takes
        shape; each downstream field is anchored to the one above it. Edits save
        automatically and shape the agent's next turn. Nothing is invented for
        you — empty fields stay unknown.
      </p>
    ),
    manualSection: 'genesis-workflow',
  },
  'rightpanel.genesis.scaffold': {
    title: 'Genesis — create & scaffold',
    body: (
      <p>
        Operator-confirmed. Creates the project folder under the parent you pick
        (default <C>~/Projects</C>), writes seed docs (<C>README</C>/<C>SPEC</C>/
        <C>TODO</C>/<C>CLAUDE.md</C>), optionally a GitHub repo, then binds this
        workflow to the new folder (carrying the transcript over) and seeds a
        plan. Creates files on disk — irreversible.
      </p>
    ),
    manualSection: 'genesis-workflow',
  },
  'rightpanel.genesis.creative': {
    title: 'Genesis — Creative mode',
    body: (
      <p>
        Run the Genesis process <em>inside</em> an existing project to explore an
        alternative direction. Arming snapshots the current project as grounding
        context (it's never invented). Creative mode never edits your project — a
        scaffold lands in a sibling <C>ALTERNATIVE/</C> folder with its own plan,
        and an established codebase shows a warning. If the idea diverges, use
        <C>SPAWN</C> to fork it into a fresh tab.
      </p>
    ),
    manualSection: 'genesis-workflow',
  },
  'rightpanel.files.changes': {
    title: 'CHANGES',
    body: (
      <p>
        Working-tree diff for this workflow's cwd — what's changed since the
        last commit (<C>git diff</C> vs <C>HEAD</C>), rendered per-file and
        collapsible with a <C>UNIFIED</C> / <C>SPLIT</C> toggle. Same renderer
        the GIT dialog uses for its pre-commit preview. Shows an empty state
        when the tree is clean or the cwd isn't a git repo.
      </p>
    ),
    manualSection: 'changes-diff',
  },
  'rightpanel.files.source': {
    title: 'SOURCE',
    body: (
      <p>
        Source-Control-style file list for this cwd — changed files grouped{' '}
        <C>STAGED</C> / <C>CHANGES</C> / <C>UNTRACKED</C>. Click a file to view
        just its diff in the same renderer. Backed by <C>GET /api/git/diff</C>.
        Binary / oversized files degrade to a hint; a clean or non-git cwd shows
        an empty state.
      </p>
    ),
    manualSection: 'source-changes',
  },
  'rightpanel.files.remote': {
    title: 'REMOTE',
    body: (
      <p>
        Local ↔ remote comparison for this cwd's current branch vs its upstream
        (<C>@{'{u}'}</C>) — a <C>↑N to push / ↓M to pull</C> summary with an
        expandable commit list each direction and the per-direction diff in the
        same renderer. <C>FETCH</C> runs <C>git fetch</C> (remote-tracking refs
        only — never merges or moves <C>HEAD</C>) then re-reads. Read-only
        otherwise; the mutating push/pull lands in a later phase. Backed by{' '}
        <C>GET /api/git/compare</C> + <C>POST /api/git/fetch</C>.
      </p>
    ),
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
        <C>TOKEN USAGE</C>'s per-turn rows collapse — click the header.
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
        <C>rust-analyzer</C> for Rust) — absent ⇒ no diagnostics, no error.
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
        reaches the normal Activity stream — so this panel tails the fleet's own
        transcripts instead. The header strip (<C>N/M done · K running</C>)
        answers "is it still going?"; each row is one subagent — its task label,
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
        Read-only artifacts from past Reviews — verdict (PASS / MINOR /
        BLOCKING), reviewer model, body. <C>↳ SEND TO AGENT</C> pre-fills the
        composer with the review body.
      </p>
    ),
    manualSection: 'review-action',
  },
  'rightpanel.tab.research': {
    title: 'RESEARCH',
    body: (
      <p>
        Cited research reports written by the <C>⌕ RESEARCH</C> button — each row
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
    body: (
      <p>
        Handoff documents written when sessions in this tab were rotated. They
        live forever in <C>.archon/workflows/&lt;wfid&gt;/handoffs/</C>. An
        in-flight handoff shows a <C>✕</C> on its <C>RUN…</C> row to cancel it
        (kills the worker and frees the tab) — hidden for Antigravity, whose RPC
        has no stop method.
      </p>
    ),
    manualSection: 'handoff-action',
  },
  'rightpanel.tab.plan': {
    title: 'PLAN',
    body: (
      <>
        <p>
          Plans available in this cwd. Active plans inline, completed ones behind
          a toggle. Click any to attach to the current workflow. Checkboxes are
          bidirectional — flip in the panel and the agent sees it next turn.
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
          Race the same implementation prompt through 2–5 ordinary agent tabs.
          Every attempt starts at the same commit on its own managed git
          worktree and branch. Open a tab for its transcript or inspect its
          candidate diff here.
        </p>
        <p>
          Nothing chooses or merges a winner automatically. <C>PROMOTE</C> is
          an explicit operator action: Arco refuses a dirty or moved source
          checkout, commits project changes on the candidate branch, excludes{' '}
          <C>.archon</C> state, and performs a no-fast-forward merge. Cleanup
          removes managed worktrees but preserves their branches.
        </p>
      </>
    ),
  },
  'rightpanel.tab.config': {
    title: 'CONFIG',
    body: (
      <>
        <p>
          Live-editable per-workflow settings — model, effort, sandbox (Codex),
          tool allowlist (Claude), auto-handoff thresholds, RSS guard opt-out.
          A red dot means the underlying CLI's capability surface changed
          since you last viewed it.
        </p>
        <p>
          Antigravity tabs show read-only RPC diagnostics instead of controls
          Arco does not own: desktop reachability, default/signed-in vs
          isolated/custom profile mode, configured model/display model, cascade
          state, <C>CTX: Antigravity-managed</C>, artifacts partial, and
          <C>clusterTools false</C>. If unavailable, check the binary path,
          profile, model, and restart semantics in the manual.
        </p>
        <p>
          Claude tabs have a TRANSPORT toggle (<C>cli</C> per-turn spawn vs{' '}
          <C>native</C> long-lived in-process worker via <C>@anthropic-ai/sdk</C>).
          Native unlocks server-side <C>compact</C> + auto-handoff,
          operator-armed plan-mode, and{' '}
          <C>Task</C> subagent fan-out. Codex tabs have a parallel toggle
          (<C>exec</C> vs <C>app-server</C>) that unlocks structured{' '}
          <C>turn/interrupt</C> cancel and non-destructive <C>turn/steer</C>.
          Reviewers and handoff seeds always run on the default transport.
        </p>
        <p>
          Claude Native, Codex app-server, and Z.ai tabs also expose an <C>OUTPUT STYLE</C> picker:{' '}
          <C>normal</C> (default), <C>lite</C> (drop fillers, hedging, pleasantries),
          and <C>terse</C> (also drop articles, fragments OK — was{' '}
          <C>caveman</C> before 2026-05-10; renamed for honest expectations
          after measuring on Opus 4.7). Cuts <em>output</em> tokens, not input;
          measured at ~10–25% reduction on Opus 4.7, less than upstream
          caveman's 65–75% claim because Opus is more resistant to extreme
          persona instructions than the smaller models the upstream benchmarks
          targeted. Code blocks, error strings, and file paths are preserved
          verbatim by the addendum text. Review / Handoff / DOCS / GIT
          primitives always run as <C>normal</C> regardless. The New-tab
          picker carries the operator's preferred default for future supported
          tabs (saved to <C>workflowDefaults.outputStyle</C>). Claude CLI,
          Codex exec, and Gemini operators install upstream{' '}
          <a href="https://github.com/JuliusBrussee/caveman" target="_blank" rel="noopener noreferrer">caveman</a>{' '}
          (MIT) themselves — Arco doesn't ship a wrapper for those transports.
        </p>
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
          session — they take effect immediately on the following turn. The list
          is the live provider catalog. Strata also lists prepared local profiles,
          including Original and SC117 Abliterated; loading happens on the next
          message and only one is resident. To change <em>provider</em>, use Handoff
          (same tab) or Spawn (new tab) instead.
        </p>
        <p>
          Cursor applies the swap <em>in-session</em> via <code>session/set_model</code>{' '}
          (no respawn) and posts a "model swapped" notice on the next turn. Because
          Cursor bakes reasoning effort into the model id, the picker splits into
          <b>family</b> + <b>effort</b> (plus optional FAST / THINK) and resolves to
          the exact catalog id — the EFFORT row below stays a note. The status chip's
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
        reasoning; HIGH maps to Qwen xhigh. Gemini / Antigravity / Cursor show no picker — Cursor
        bakes effort into the model id; the others expose no effort flag.
      </p>
    ),
    manualSection: 'live-config-swap',
  },
  'rightpanel.config.auto-handoff': {
    title: 'Auto-handoff',
    body: (
      <p>
        Arco auto-rotates to a fresh session at a context-fill threshold
        (warn-at / auto-at percentages, editable here). Disable to lean on
        Anthropic's <C>compact</C> (Native only) or to manage context by hand.
      </p>
    ),
    manualSection: 'auto-handoff',
  },
  'rightpanel.config.auto-fold': {
    title: 'Auto-fold (Native)',
    body: (
      <p>
        Operator-armed, Claude-Native-only, off by default. Before a handoff is
        recommended, Arco deterministically folds older transcript history into
        a digest and keeps a verbatim recent tail — same session, instant,{' '}
        <em>no model round</em>. The raw transcript stays in <C>events.jsonl</C>.
        Fires when the context budget crosses <C>FOLD AT</C> (kept below the
        auto-handoff <C>WARN</C> level). The composer's <C>FOLD</C> button forces
        one immediately regardless.
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
          <C>native</C> (long-lived in-process worker — unlocks server-side
          compact, plan-mode arming, and <C>Task</C> fan-out). Codex:{' '}
          <C>exec</C> vs <C>app-server</C> (unlocks structured interrupt + steer).
          Reviewers and handoff seeds always run on the default transport.
        </p>
        <p>
          <strong>Ultracode</strong> (toggle below): sticky deep multi-agent
          mode — Claude authors a <C>Workflow</C> that fans out a subagent fleet,
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
        back to Codex defaults.
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
        This is an <strong>Archon-set ceiling, not an Anthropic account limit</strong> —
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
        Terseness picker for Claude Native, Codex app-server, and Z.ai:{' '}
        <C>normal</C> (default),{' '}
        <C>lite</C> (drop fillers, hedging, pleasantries), or <C>terse</C>{' '}
        (also drop articles; fragments OK). Cuts output tokens, not input. Code
        blocks, error strings, and file paths are preserved verbatim. Review /
        Handoff / DOCS / GIT primitives always run as <C>normal</C>.
      </p>
    ),
    manualSection: 'config-tab',
  },
  'rightpanel.config.north-star': {
    title: 'North star',
    body: (
      <p>
        A durable, per-tab objective pinned into the system prompt every turn
        until you clear it — it steers priorities and what "done" looks like.
        Operator-only write, model read-only; capped at <C>2048</C> bytes
        (trimmed on save). Pure context, <strong>not</strong> an instruction to
        act autonomously — it never loops, grades work, or spawns anything.
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
          composer while a run is armed — click it to stop.
        </p>
        <p>
          The optional token cap is in millions and stops the run when crossed;
          blank means iterations are the only limit. A run also stops on a turn
          error, a rate-limited provider, context past 92%, or a cleared north
          star — each announced with its reason. Your own messages do{' '}
          <strong>not</strong> stop it, so you can steer mid-run.
        </p>
        <p>
          Composer equivalents: <C>/goal run 10</C>, <C>/goal run</C> for status,{' '}
          <C>/goal run stop</C>. Counters aren&apos;t persisted, so a server
          restart ends any armed run. The loop continues because budget remains
          and stops because it doesn&apos;t — it never asks the model whether the
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
          skills (<C>.archon/skills</C>), and <C>.archon/settings.json</C> into
          the model turn. Untrusted repos have those suppressed — a repo you
          clone can&apos;t inject instructions into your agent before you&apos;ve
          read them. The turn still runs either way.
        </p>
        <p>
          <C>TRUSTED</C> folds them in from the next turn; <C>BLOCKED</C>{' '}
          suppresses silently; <C>ASK</C> forgets the decision and re-arms the
          one-time composer prompt. Decisions are keyed by <em>directory</em>{' '}
          (nearest ancestor wins), so setting it here covers every tab and every
          cluster member pointed at the same cwd. Recorded in{' '}
          <C>~/.archon/trust.json</C>; manage all of them at once in SETTINGS →
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
        Register external <C>MCP</C> servers once (machine-global) and enable
        them per tab. Enabling a server exposes all its tools <em>except</em>{' '}
        dangerous ones (write / delete / exec / shell / post …), which stay OFF
        until you tick them per tab. <C>probe</C> connects, lists the tools, and
        flags the dangerous ones. On CLI Claude the denylist is enforced via{' '}
        <C>--disallowedTools</C> (composes with skip-permissions). Codex has no
        per-tool gate — an enabled server exposes <strong>all</strong> its
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
        <C>THRESHOLD</C> fill % Arco summarizes the older half of the
        transcript <em>in place</em> on the local model so the next turn fits
        the window (with a <C>WARN</C> level below it). This is a{' '}
        <strong>global</strong> setting (applies to every Ollama tab); the
        composer <C>⊟ COMPACT</C> button forces a round on the next turn
        regardless. The summary framing prompt is editable in Settings →
        Handoff prompts.
      </p>
    ),
    manualSection: 'config-tab',
  },
  'rightpanel.config.ollama-params': {
    title: 'Advanced params (Ollama)',
    body: (
      <p>
        Per-tab Ollama generation params merged into <C>/api/chat</C> through a
        typed allowlist: <C>num_ctx</C> (trusted-only — clamped to the model's
        probed window, a higher value is dropped), <C>keep_alive</C>,{' '}
        <C>num_gpu</C> (GPU layers; 0 = CPU-only), <C>temperature</C>, plus
        power-user keys (<C>top_p</C>, <C>num_predict</C>, …) accepted on the
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
    body: (
      <p>
        Task children spawned by the Native worker's <C>Task</C> tool. Each card
        shows the child workflow's status (<C>running</C> / <C>done</C> /{' '}
        <C>error</C> / <C>cancelled</C>), elapsed time, and a <C>PROMOTE</C>{' '}
        button to flip a child into the top tab strip. Tab visibility is gated
        on this workflow having Task fan-out; depth-1 only.
      </p>
    ),
    manualSection: 'tasks-tab',
  },
  'rightpanel.tab.ledger': {
    title: 'LEDGER',
    body: (
      <>
        <p>
          The project task ledger — a durable, cwd-scoped task list that persists
          across sessions, stored at <C>.archon/project/tasks.json</C>. Distinct
          from PLAN (plan-scoped review) and TASKS (in-turn subagent children):
          the ledger is the cross-session backbone tasks attach to.
        </p>
        <p>
          The JSON is a versioned, rebuildable projection over{' '}
          <C>events.jsonl</C> — every mutation appends an event, and the
          snapshot is reconstructed from the log if ever lost. <C>DONE</C> and{' '}
          <C>ARCHIVED</C> require explicit operator actions in the status
          picker; nothing auto-marks a task terminal.
        </p>
      </>
    ),
  },
  'rightpanel.ledger.add': {
    title: 'Add task',
    body: <p>Create a new task in this project folder's ledger. New tasks always start as <C>TODO</C> — there is no create-as-done path.</p>,
  },
  'rightpanel.ledger.status': {
    title: 'Task status',
    body: <p>Set the task's status: <C>TRIAGE</C> / <C>TODO</C> / <C>READY</C> / <C>IN PROGRESS</C> / <C>BLOCKED</C> / <C>REVIEW</C> / <C>DONE</C> / <C>ARCHIVED</C>. This is the only way to mark a task done or archived, and it's always an explicit operator action — Arco never infers terminal status.</p>,
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
          <C>ISOLATE</C> spins an isolated <C>git worktree</C> for this task — a
          separate checkout on its own <C>archon/task/…</C> branch off the current
          HEAD — so parallel work on one repo doesn't collide. It lives under a
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
          ledger update event — the reverse direction (which tasks point at a
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
          live head back to a prior point (Claude Native only; the current branch
          is kept and can be returned to, so the rewind is itself reversible —
          two-click confirm). A <C>REWINDS</C> filter category surfaces the
          fork / leaf-move events. Filter strip persists per-workflow.
        </p>
        <p>
          Click an event row to scroll-and-flash the corresponding chat row
          (when the event has a chat message id — user sends + assistant
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
          checkpoint (<C>checkpoint ref</C> vs the live working tree).
        </p>
        <p>
          <C>REVERT TO HERE</C> restores the working tree to that checkpoint —
          faithfully, so files created after it are removed. It is safe: Arco
          ALWAYS takes a fresh <C>pre-revert</C> checkpoint first, so the revert
          is itself undoable (revert to that pre-revert marker to undo). A
          confirm dialog shows the file count before anything changes. Can't
          revert while a turn is running — cancel it first.
        </p>
      </>
    ),
    manualSection: 'history-tab',
  },
  'rightpanel.history.purge': {
    title: 'PURGE CONVERSATION',
    body: (
      <>
        <p>
          Permanently delete this entire conversation and everything Arco wrote
          for it — transcript (<C>events.jsonl</C>), <C>meta.json</C>, checkpoints,
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
          Per-provider, per-day token-volume + cache-hit-ratio trends for every
          conversation under this project's cwd — a quota-pressure read of{' '}
          <em>which tab/model is eating your rolling window</em>, framed as token
          volume (never cost). Backed by <C>GET /api/usage-stats</C>, a read-only
          deterministic aggregation of the <C>primary_turn_token_usage</C> events
          already in each workflow's <C>events.jsonl</C> — no new capture, nothing
          mutated.
        </p>
        <p>
          Each provider block shows a hand-drawn SVG sparkline of daily prompt
          volume, a cache-hit-ratio bar, and a per-day breakdown. Cache-hit ratio
          uses the provider-correct denominator (Claude's input/cache fields are
          disjoint; Codex's <C>cacheRead</C> is a subset of <C>input</C>).
        </p>
      </>
    ),
  },
  'rightpanel.usage.refresh': {
    title: 'REFRESH',
    body: <p>Re-runs the read-only aggregation against disk — pick up turns recorded since you opened the tab.</p>,
  },
  'rightpanel.tab.preview': {
    title: 'PREVIEW',
    body: (
      <>
        <p>
          Live iframe of this workflow's dev server. Bind a port (manual or
          auto-detected from the agent's <C>npm run dev</C>) and the iframe
          loads <C>/api/preview/&lt;wfid&gt;/</C> — Arco's per-workflow proxy
          onto <C>127.0.0.1:&lt;port&gt;</C>. HMR keeps working through the
          tunnel; you don't need to forward the dev port separately.
        </p>
        <p>
          Iframe is rendered at a fixed 1920-wide logical viewport (height per
          the operator-selected 4:3 / 16:10 / 16:9 aspect ratio) and CSS-scaled
          to the largest box-of-that-ratio the pane can hold — never clipped in
          either axis. Aspect persists to localStorage globally.
        </p>
      </>
    ),
    manualSection: 'preview-tab',
  },
  'rightpanel.tab.github': {
    title: 'GITHUB (workflow-scoped)',
    body: (
      <>
        <p>
          The GitHub browser opened in the right pane against this workflow's
          cwd. Browse the repo backing this project, view PRs / issues /
          Actions runs, jump to any file. Same surface as the full-screen
          <C>◆ GITHUB</C> in the header, but scoped to the active workflow's
          repo by default — useful for keeping the chat visible while you
          glance at a PR or check CI.
        </p>
        <p>
          Auth is shared with the header GitHub view (your local{' '}
          <C>gh auth</C>); no extra login.
        </p>
      </>
    ),
    manualSection: 'github',
  },

  // ----------------------------------------------------------- KNOWLEDGE (B3)
  'rightpanel.tab.knowledge': {
    title: 'KNOWLEDGE',
    body: (
      <p>
        Per-project knowledge base — durable facts, gotchas, and links stored as
        markdown under <C>.archon/knowledge/</C>. Mark an article{' '}
        <em>always include</em> to fold it into every turn's system prompt
        (within a bounded byte budget); leave it on-demand to keep it readable
        here only. Articles are operator-authored or agent-drafted, but nothing
        saves without an explicit <C>Save</C>.
      </p>
    ),
    manualSection: 'knowledge-base',
  },
  'rightpanel.knowledge.add': {
    title: 'ADD ARTICLE',
    body: <p>Open the "Add from…" wizard: a blank article, a manual quick link, or an agent-drafted "distill from this session". All converge on editable fields you <C>Save</C>.</p>,
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
    body: <p>Remove this article from the knowledge base (deletes its markdown file under <C>.archon/knowledge/</C>).</p>,
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
    body: <p>Paste a URL and write a short summary. The URL is <em>not</em> auto-fetched (deferred-SSRF posture, same as <C>@url:</C>) — you supply the title/summary.</p>,
    manualSection: 'knowledge-base',
  },
  'rightpanel.knowledge.add-distill': {
    title: 'Distill from this session',
    body: <p>An agent <em>drafts</em> an article from the current transcript. The agent only proposes — it has no write tool. You edit the draft and explicitly <C>Save</C>; nothing is auto-saved.</p>,
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
    body: <p>The markdown body — the durable fact, steps, or gotcha worth remembering across sessions.</p>,
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
    body: <p>Persist the article to the knowledge base. <strong>This is the only path that saves</strong> — a distilled draft is never saved until you click here.</p>,
    manualSection: 'knowledge-base',
  },
};
