import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Pre, Note, Kbd } from '../../components/UserManual/components';

export const powerFeatures: Section[] = [
  {
    id: 'tasks-tab',
    group: 'Power features',
    title: 'The TASKS tab — Native sub-agent fan-out',
    body: (
      <>
        <p>
          When a Claude Native tab calls the <Code>Task</Code> tool, the spawned sub-agent
          runs as a first-class Arco workflow that's <em>scoped to its parent</em>. Three
          surfaces make that visible:
        </p>
        <ul>
          <li><strong>Inline TaskCard</strong> on the parent's <Code>Task</Code> tool_use chat row. Renders the child workflow's status (<Code>running</Code> / <Code>done</Code> / <Code>error</Code> / <Code>cancelled</Code>), elapsed time, child workflow id, and a <Code>PROMOTE</Code> button to flip the child into the top tab strip.</li>
          <li><strong>TASKS tab</strong> in the right pane, gated on this workflow having Task fan-out (<Code>job.taskChildren</Code>). Lists every Task child with the same controls.</li>
          <li><strong>TabBar filter</strong> — parented children that haven't been promoted are hidden from the top tab strip so a fan-out turn doesn't flood the bar. <Code>PROMOTE</Code> exposes one explicitly.</li>
        </ul>
        <p>
          <strong>Parallel dispatch.</strong> When the model emits multiple <Code>Task</Code> calls in one turn, Arco's tool loop fires them concurrently (<Code>Promise.all</Code>) — Task children share no filesystem state, so concurrent dispatch is safe and substantially faster on fan-out turns. Other tools stay sequential because they often share the cwd's filesystem state.
        </p>
        <p>
          <strong>Depth-1 only.</strong> Children spawn with <Code>claudeNativeTaskDisabled</Code>, so the <Code>Task</Code> tool is dropped from the child's tool registry. By design — Arco's non-goals explicitly forbid autonomous orchestration trees, and depth-1 is the right ceiling for an operator-visible spawn-from-here UX.
        </p>
        <p>
          <strong>Cancel of the parent cascades</strong> into <Code>childManager.killAll()</Code> and rejects the awaiting Promise on the parent so the agent loop sees a clean cancellation. <Code>SubagentStop</Code> hooks fire on settle (success or error).
        </p>
      </>
    ),
  },

  {
    id: 'history-tab',
    group: 'Power features',
    title: 'The HISTORY tab — read-only timeline',
    body: (
      <>
        <p>
          The HISTORY tab in the right pane is a read-only, seq-stamped timeline of
          this workflow's narrative events. Filter strip at the top lets you scope to{' '}
          <Code>ALL</Code> / <Code>TURNS ONLY</Code> / <Code>TOOL CALLS</Code> /{' '}
          <Code>LABELS</Code> / <Code>HANDOFFS</Code> / <Code>REVIEWS</Code> /{' '}
          <Code>CHECKPOINTS</Code> / <Code>REWINDS</Code>. <Code>REWINDS</Code>{' '}
          scopes to the <Code>fork</Code> category emitted by conversation
          rewinds (<Code>leaf_move</Code> events). Filter choice persists per
          workflow.
        </p>
        <p><strong>Checkpoints &amp; one-click revert.</strong> Each <Code>CHECKPOINT ●</Code> row is a working-tree snapshot Arco took automatically before a file-mutating turn (a hidden git ref — your real HEAD / branch / staged index are never touched). Two actions appear when a checkpoint row is selected:</p>
        <ul>
          <li><strong>VIEW DIFF VS NOW</strong> — opens the diff viewer comparing the checkpoint's tree against the live working tree (<Code>git diff &lt;checkpoint ref&gt;</Code> vs <Code>WORKTREE</Code>), reusing the same renderer as the Files CHANGES sub-tab.</li>
          <li><strong>REVERT TO HERE</strong> — restores the working tree to that checkpoint <em>faithfully</em>: files created after it are removed, not just overwritten. It is always reversible — Arco takes a fresh <Code>pre-revert</Code> checkpoint of the current tree <em>first</em> (and aborts the whole operation if that safety snapshot fails), so you can undo a revert by reverting to the pre-revert marker that appears right after it. A confirm dialog shows the file count before anything changes. The user's HEAD / branch / real index are never moved — the restored tree shows up as ordinary uncommitted working-tree changes. Reverting is blocked while a turn is in progress (cancel it first). Non-git workspaces are checkpointed into a private shadow git store under <Code>~/.arco/checkpoints/</Code> (your directory stays non-git), so revert there has the same real-tree semantics. Scope caps apply to that shadow store: files over 32 MiB are skipped and counted, and a snapshot whose included total exceeds 1 GiB is skipped — large models/videos are out of checkpoint scope by design. Older tar checkpoints remain revertible.</li>
        </ul>
        <p><strong>Click a row</strong> to scroll-and-flash the corresponding chat row when the event has a chat message id (user sends + assistant completes today). Tool calls / handoffs / reviews are listed but don't flash — they're navigation entry points, not chat positions.</p>
        <p><strong>Three operator actions</strong> on every row (when applicable):</p>
        <ul>
          <li><strong>LABEL THIS</strong> — pin a free-text note (≤ 200 chars) to a prior event by its <Code>seq</Code>. The label is persisted to <Code>events.jsonl</Code> as an <Code>operator_label</Code> event so it survives replay; v1 is append-only (no edit/delete — re-label freely). Pinned labels render anchored to their target event in the timeline.</li>
          <li><strong>REVIEW FROM HERE</strong> — opens the Review dialog with the SCOPE row collapsed to a locked <Code>FROM hh:mm:ss — &lt;label&gt;</Code> chip and the VERIFY/CRITIQUE picker hidden. Server-side this is the <Code>since-event</Code> ContextRef variant — slices the transcript from the chosen <Code>seq</Code> onward and runs the standard reviewer machinery. When the anchor is itself an <Code>operator_label</Code> event, the label's text is lifted into the reviewer's framing.</li>
          <li><strong>SPAWN FROM HERE</strong> — opens the Spawn dialog with <Code>cutoffEventSeq</Code> pre-set to the chosen row's <Code>seq</Code>. The new tab boots with the parent's transcript truncated at the cutoff. Honored by fresh-summarizer mode and Native original-worker; CLI original-worker silently ignores it (<Code>claude --resume</Code> carries the parent's full session and there's no clean way to retroactively trim its view — the dialog tells you to choose fresh-summarizer if the cutoff matters).</li>
          <li><strong>REWIND CONVERSATION</strong> (Claude Native only) — moves the live conversation head back to the selected row, forking a fresh branch at that <Code>seq</Code> while leaving the abandoned branch intact on disk. Because the old branch is kept, a rewind is itself reversible — undoing it is just another rewind — and the abandoned branches show up under the <Code>REWINDS</Code> filter (fork markers). Two-click inline confirm (the button flips to <Code>CONFIRM REWIND ↩</Code>, with a CANCEL escape); blocked while a turn is in flight (cancel first). Server-side this is the <Code>revert_to_point_request</Code> handler (server appends a <Code>leaf_move</Code> event and sets <Code>meta.leafSeq</Code>) with a Native-first gate that rejects rewind on CLI Claude and Codex; the button is hidden for non-Claude providers. <strong>This is the conversation timeline, not the git working tree</strong> — the checkpoint-row <Code>REVERT TO HERE</Code> restores files; <Code>REWIND CONVERSATION</Code> restores transcript state.</li>
        </ul>
        <p><strong>Why the events re-broadcast on rehydrate.</strong> Lifecycle events (<Code>task_started</Code> / <Code>task_status</Code> / <Code>operator_label</Code>) are re-broadcast by the server on every rehydrate <em>regardless</em> of <Code>clientLastSeq</Code> — without that, a workflow whose only Task fan-out happened pre-refresh would come up showing <Code>0s · RUNNING</Code> forever. The corresponding store actions are idempotent so re-broadcast is safe.</p>
      </>
    ),
  },

  {
    id: 'plan-mode-arming',
    group: 'Power features',
    title: 'Operator-armed plan mode (Claude Native)',
    body: (
      <>
        <p>
          Above the composer, Native Claude tabs show a checkbox:{' '}
          <Code>⛔ PLAN MODE — GATE WRITE TOOLS FOR NEXT TURN</Code>. Tick it, and the
          next turn starts with the worker's <Code>planMode</Code> flag set to{' '}
          <Code>true</Code>: <Code>Write</Code> and <Code>Edit</Code> short-circuit
          with <Code>[error] write tools disabled until ExitPlanMode</Code>, and the
          system prompt is nudged to call <Code>EnterPlanMode</Code> for the
          operator's task.
        </p>
        <p><strong>Single-turn arming.</strong> The flag is consumed by the next turn dispatch and cleared. A reload, tab swap, or cancelled send all clear it without firing. The placeholder text shifts to <Code>Type your task — plan mode armed for next turn</Code> when armed; no banner.</p>
        <p><strong>Visibility gating.</strong> The checkbox renders only when <Code>job.config.primaryProvider === 'claude'</Code> AND the resolved transport is <Code>'native'</Code>. On every other provider/transport the row renders nothing — no reserved space.</p>
        <p><strong>What's gated and what isn't.</strong> Plan mode short-circuits <Code>Write</Code> and <Code>Edit</Code> only. <Code>Bash</Code> is intentionally <em>not</em> gated — detecting "write intent" in arbitrary shell commands generically (<Code>sed -i</Code>, redirection, <Code>rm</Code> pipelines, in-place git) would be a regex arms race with high false-positive cost. Operators relying on plan mode as a hard write barrier should use the surrounding sandbox or CI contract; the per-tool gate is for the common footgun of the model patching files before sketching a plan, not a universal write firewall.</p>
        <p><strong>Plan-parser advisories</strong> surface from <Code>EnterPlanMode</Code> as part of the tool result (warnings only, never reject — the model corrects on the next turn). The plan body is dry-run through the same <Code>parsePlan</Code> invariants the Plan tab uses for per-section review.</p>
      </>
    ),
  },

  {
    id: 'tool-postures',
    group: 'Power features',
    title: 'Tool postures (Claude Native)',
    body: (
      <>
        <p>
          A <strong>posture pill</strong> on the composer (Native Claude tabs
          only) cycles the tab through four toolsets that scope which tools are
          exposed to the model: <Code>full</Code> → <Code>coding</Code> →{' '}
          <Code>review</Code> → <Code>chat</Code>. Where plan-mode arming gates{' '}
          <Code>Write</Code>/<Code>Edit</Code> for a single turn, a posture
          shapes the <em>whole exposed toolset</em> for the tab — fewer tool
          definitions means fewer tokens and less attention spread.
        </p>
        <ul>
          <li><Code>full</Code> — the default and a no-op (keeps everything). Existing tabs are byte-identical until you change it.</li>
          <li><Code>coding</Code> — drops web research (WebFetch / WebSearch), keeps the edit/run core.</li>
          <li><Code>review</Code> — read / inspect / run only: no <Code>Write</Code> / <Code>Edit</Code> / <Code>Task</Code> / web.</li>
          <li><Code>chat</Code> — read-only lookup.</li>
        </ul>
        <p>
          The posture is <strong>session-local</strong> and takes effect on the
          next turn: it lives on <Code>WorkflowState</Code>, is logged to{' '}
          <Code>events.jsonl</Code> (not <Code>meta.json</Code>), and reverts to{' '}
          <Code>full</Code> on reload. Dynamic opt-in tools (<Code>mcp__*</Code> /{' '}
          <Code>peer_*</Code> / <Code>ctx_*</Code>) are never stripped by a
          posture. The protocol surface is{' '}
          <Code>set_tool_posture</Code> / <Code>tool_posture_set</Code>.
        </p>
      </>
    ),
  },

  {
    id: 'review-safe-gate',
    group: 'Power features',
    title: 'Review-safe mode — durable approval gate (Claude Native)',
    body: (
      <>
        <p>
          A per-tab <Code>REVIEW SAFE-MODE</Code> toggle in CONFIG (the{' '}
          <Code>reviewSafeMode</Code> flag, default <Code>OFF</Code>, Native-only
          in v1). When on, the worker <strong>parks sensitive tool calls</strong>{' '}
          as pending gates and emits <Code>gate_required</Code> instead of
          running them — an editable <strong>GateApprovalNotice</strong> card
          appears in chat.
        </p>
        <ul>
          <li><strong>Edit-then-approve.</strong> The card pre-fills the proposed tool input in a textarea; you can edit it, then approve (<Code>gate_reply</Code>) or deny / revoke (<Code>gate_revoke</Code>). The server broadcasts <Code>gate_resolved</Code>.</li>
          <li><strong>Standing approval.</strong> On an <em>unedited</em> approve you can arm "approve all like this" (<Code>gate_standing</Code>): the server stores a non-lossy signature of what ran and re-evaluates future calls against it live, skipping the gate only on an exact match.</li>
          <li><strong>Durable.</strong> Gates and standing rules persist in a gateStore sidecar (<Code>&lt;cwd&gt;/.arco/workflows/&lt;wfid&gt;/gate-approvals.json</Code>) so they survive restart / rehydrate.</li>
        </ul>
        <Note>
          Fence-clearance: operator-armed (default OFF), a deterministic
          classifier decides what to park, every gate and resolution lands in{' '}
          <Code>events.jsonl</Code>, and any standing rule is revocable.
        </Note>
      </>
    ),
  },

  {
    id: 'preview-tab',
    group: 'Power features',
    title: 'The PREVIEW tab — live dev-server iframe',
    body: (
      <>
        <p>
          The PREVIEW tab in the right pane loads the workflow's dev server
          (Vite, Next, Astro, Nuxt, plain Node, etc.) inside an iframe so you
          can see the agent's output without leaving Arco — and without
          forwarding extra ports if you're using Arco over SSH.
        </p>
        <p><strong>Header controls.</strong></p>
        <ul>
          <li><strong>PORT</strong> — input box. Type the dev-server port (e.g. <Code>5173</Code> for Vite, <Code>3000</Code> for Next).</li>
          <li><strong>BIND</strong> — bind that port to this workflow. Persisted; survives restarts. Marks the binding as <Code>manual: true</Code> — auto-detect will never overwrite it.</li>
          <li><strong>RELOAD</strong> — remount the iframe. Cheaper than fiddling with src; survives any backend that doesn't honor cache-control.</li>
          <li><strong>OPEN</strong> — open the preview URL in a new tab. Useful when you want a full-window view.</li>
          <li><strong>UNBIND</strong> — clear the binding. Iframe goes away; meta state is removed.</li>
          <li><strong>4:3 / 16:10 / 16:9</strong> — iframe aspect ratio. Logical viewport width is fixed at 1920 (Full-HD-ish); height tracks the chosen ratio (1440 / 1200 / 1080). Choice persists to localStorage globally — applies to every workflow's PREVIEW tab.</li>
        </ul>
        <p><strong>RECENT pills.</strong> Below the controls, recently-bound ports for this workflow appear as click-to-rebind pills (most-recent first, capped at 5). Click one to jump back to that service after an UNBIND. The client probes the upstream first — if the dev server is no longer running, a modal opens listing every other service currently listening on the box (Linux only) so you can pick one to bind to instead. Arco's own server is filtered out of that list; everything else (including dev servers spawned by other workflows) is shown.</p>
        <p><strong>Auto-detection.</strong> When the agent runs <Code>npm run dev</Code> / <Code>vite</Code> / <Code>next dev</Code> / etc., Arco notices in two ways and races them:</p>
        <ul>
          <li><strong>Layer 1</strong> — Bash-command sniff in <Code>seedWorker</Code> matches a regex of common dev-server invocations, then HTTP-probes the conventional ports (5173, 3000, 4321, 5174, 8080, …). First port that responds wins.</li>
          <li><strong>Layer 2</strong> (Linux only) — when the agent uses <Code>run_in_background: true</Code>, Arco tracks the spawned PID, walks <Code>/proc/&lt;pid&gt;/fd</Code> for socket inodes, and cross-references <Code>{'/proc/net/tcp{,6}'}</Code> LISTEN entries. Attributes the listening port directly to the agent's process tree — no probing.</li>
          <li>The two layers race; whichever produces a valid port first commits.</li>
          <li><strong>Cross-workflow conflict filter</strong> — if another tab already bound this port, the auto-detector skips it. Two workflows running dev servers simultaneously won't fight over each other's ports.</li>
          <li><strong>Manual override</strong> — a <Code>BIND</Code> click is sticky. Auto-detect can suggest other ports but never replaces a manual binding.</li>
        </ul>
        <p><strong>Auto-flip.</strong> On the first fresh bind for this tab, the right pane auto-switches to PREVIEW once. Hydration replays after a server restart never trigger the flip — the <Code>freshlyBound</Code> protocol flag distinguishes real binds from re-broadcasts.</p>
        <p><strong>Viewport sizing.</strong> The iframe always renders at a fixed logical viewport (width 1920; height 1440 / 1200 / 1080 depending on the operator-selected aspect ratio) and is CSS-scaled to the largest box-of-that-ratio that fits the right pane, then centered in the pane both axes. Width-constrained when the pane is wider than tall; height-constrained when taller. <strong>Never clipped in either axis.</strong> If you want the dev server to lay out at a specific viewport size, that fixed logical width is what it sees, regardless of how big the Arco window is.</p>
        <p><strong>Why the proxy exists.</strong> The iframe loads <Code>/api/preview/&lt;workflowId&gt;/</Code> — Arco's per-workflow proxy onto <Code>127.0.0.1:&lt;port&gt;</Code>. A naked iframe pointing at <Code>http://localhost:&lt;port&gt;</Code> would resolve against your laptop's localhost, not the box Arco runs on. Same-origin proxy means the preview works regardless of port-forwarding setup, and HMR keeps working because WebSocket upgrades are forwarded to the dev server's HMR endpoint too.</p>
        <Note>
          Iframe sandbox is <Code>allow-same-origin allow-scripts allow-forms allow-popups allow-modals</Code>.{' '}
          <Code>allow-top-navigation</Code> is intentionally omitted so a misbehaving page can't navigate the Arco shell away.
        </Note>
      </>
    ),
  },

  {
    id: 'security-trust',
    group: 'Power features',
    title: 'Security & trust controls',
    body: (
      <>
        <p>
          A few operator-facing guards keep model-reachable inputs from being
          trusted by default. None of them make a model judgment — they gate on
          deterministic signals and put the operator in the loop.
        </p>
        <ul>
          <li>
            <strong>Project-trust gate.</strong> When a tab's cwd ships a{' '}
            <Code>CLAUDE.md</Code>, project skills, or project{' '}
            <Code>settings.json</Code> from a repo Arco hasn't seen vouched,
            those files are <strong>suppressed</strong> — the turn runs without
            them and a prompt appears on the composer. Trusting (recorded in{' '}
            <Code>~/.arco/trust.json</Code>) folds them into future turns.
            Reversible: CONFIG → PROJECT TRUST sets TRUSTED / BLOCKED / ASK for
            the tab&apos;s directory (nearest ancestor wins, so it covers every
            tab and cluster member on that cwd), and SETTINGS → PROJECT TRUST
            lists, flips, forgets or adds decisions in one place.
          </li>
          <li>
            <strong>Skill security audit.</strong> The skill editor's{' '}
            <Code>AUDIT</Code> button (and <Code>/api/skills/audit</Code>) runs an
            operator-triggered scan for invisible-unicode and known threat
            patterns. <strong>Diagnostic only</strong> — it never blocks a save.
          </li>
          <li>
            <strong>MCP malware pre-check.</strong> Adding an MCP server from the
            registry runs an OSV (osv.dev) lookup on the referenced package and{' '}
            <strong>blocks-with-override</strong> when it hits a known-malicious{' '}
            <Code>MAL-</Code> advisory (the operator must explicitly override).
            It is <strong>fail-open</strong>: an unreachable OSV never blocks an
            add.
          </li>
        </ul>
        <Note kind="info">
          MCP children no longer inherit Arco's Claude OAuth token or your
          GitHub PAT — the MCP env is allowlisted rather than passed through
          wholesale.
        </Note>
      </>
    ),
  },

  // -------------------------------------------------------------- POWER FEATURES
  {
    id: 'github',
    group: 'Power features',
    title: 'GitHub browser',
    body: (
      <>
        <p>
          Click <Code>◆ GITHUB</Code> in the header to open the full-screen GitHub
          browser. It uses your local <Code>gh</Code> auth — log in with{' '}
          <Code>gh auth login</Code> in a terminal first.
        </p>
        <p>What you can do without leaving Arco:</p>
        <ul>
          <li>Browse your repos and orgs.</li>
          <li>Walk file trees and read source files.</li>
          <li>Open and read PRs (with diffs) and issues.</li>
          <li>Inspect Actions runs (jobs, logs, status).</li>
          <li>Clone a repo to a chosen local path.</li>
        </ul>
        <Note>
          The GitHub browser is read-mostly (and clone). It deliberately does NOT
          let you create / merge / close PRs from inside Arco — those actions are
          the operator's responsibility via <Code>gh</Code> or the website.
        </Note>
      </>
    ),
  },
  {
    id: 'help-system',
    group: 'Power features',
    title: 'In-app help system',
    body: (
      <>
        <p>
          Arco has two in-app documentation surfaces. <Code>ⓘ MANUAL</Code> in
          the header opens this full operator reference. The floating{' '}
          <Code>?</Code> button at bottom-right toggles contextual help mode.
        </p>
        <p>
          In help mode, annotated UI elements get a 2px dashed outline on hover.
          Click an outlined element to open a popover with a short explanation.
          When the popover has a manual link, <Code>READ MORE IN MANUAL</Code>{' '}
          opens this modal at the linked section.
        </p>
        <p>
          Inline file references opened from chat, help, or rendered markdown use
          the stacked DocViewer/FileViewer modal. The raw/formatted toggle lets
          you switch between highlighted/rendered output and exact file text.
        </p>
        <Note>
          Help mode intercepts clicks on annotated elements while it is active.
          Press <Kbd>Esc</Kbd> or click <Code>?</Code> again to exit before using
          the underlying control normally.
        </Note>
      </>
    ),
  },
  {
    id: 'tool-pills',
    group: 'Power features',
    title: 'Inline tool-call pills',
    body: (
      <>
        <p>
          When the primary invokes Bash / Read / Grep / Edit / Write / WebFetch /
          WebSearch / Glob / etc., each call renders as a compact row between
          assistant bubbles. Click to expand the full JSON input. Click a file path
          inside to open it in the file viewer modal.
        </p>
        <p>Status icon per tool call:</p>
        <ul>
          <li>● spinning — in progress.</li>
          <li>✓ — completed.</li>
          <li>✗ — failed (with the error inline).</li>
        </ul>
        <Note>
          Inline pills are <strong>Claude-only</strong> for now — they're driven by
          the Claude session JSONL watcher. Codex's tool calls land in the ACTIVITY
          tab on the right but don't intermix with chat bubbles. Other providers'
          tool calls surface as ACTIVITY entries only.
        </Note>
      </>
    ),
  },
  {
    id: 'token-tracking',
    group: 'Power features',
    title: 'Token & cost tracking',
    body: (
      <>
        <p>The footer below the composer shows context and usage:</p>
        <ul>
          <li><strong>CTX</strong> — context fill (see Context window section).</li>
          <li><strong>Last turn</strong> — prompt / cacheRead / cacheCreate / output for the most recent turn when the provider reports them.</li>
          <li><strong>Speed (Ollama / Strata)</strong> — last completed turn decode tok/s and fresh-prefill PP from engine timings. Hover for counts/durations. Tool, load and network time are excluded; cached prefix is excluded from fresh prefill. Missing timings show no readout.</li>
          <li><strong>Cost</strong> — total cost USD when the provider reports it (Claude/Codex). Cumulative across the workflow.</li>
        </ul>
        <p>
          In the ACTIVITY tab, <strong>Token Usage</strong> separates retained{' '}
          <Code>ctx</Code> from processing telemetry. Claude Native server web tools
          can produce large <Code>cache-read</Code>, <Code>cache-write</Code>, or
          <Code>server tools</Code> byte counts during a turn without inflating the
          next-turn <Code>CTX</Code> footer.
        </p>
        <p>
          The per-turn breakdown under <strong>Token Usage</strong> is collapsed
          by default — click the <Code>TOKEN USAGE · N turns</Code> header to
          expand it. The session summary line stays visible either way, and the
          expanded list scrolls inside its own box so it never pushes the live
          tool/thinking feed off the pane. The <Code>CHECKPOINTS · N</Code>{' '}
          section above it works the same way: one checkpoint lands per
          file-mutating turn, so the list scrolls inside a short box (about five
          rows, newest first) and its header toggles ▾/▸ to hide it entirely —
          the choice is remembered across tabs. HISTORY still owns revert and
          view-diff.
        </p>
        <p>
          The header&apos;s <strong>live-status dots</strong> are separate — hover
          the <Code>C</Code> dot for Claude&apos;s 5-hour-window and weekly
          subscription burn (not cost, polled every 3 minutes against the
          Anthropic usage endpoint), or the <Code>R</Code> dot for Cursor&apos;s
          included-plan and Other Models quota bars.
        </p>
        <p>
          <strong>Fold (Claude Native).</strong> As the budget fills, a{' '}
          <Code>context_budget</Code> event reports the fill percent and which
          zone it crossed. When you want to reclaim room without a full Handoff,
          the composer's <Code>⊞ FOLD</Code> button (and the per-tab AUTO-FOLD
          toggle in CONFIG, default OFF) deterministically trims older history
          into a digest in place and keeps a verbatim recent tail — a local,
          no-LLM reduction logged via <Code>context_folded</Code>, distinct from
          Handoff (the raw transcript stays in <Code>events.jsonl</Code>). Tool
          results can also be evicted per-turn when their aggregate spills the
          budget (<Code>tool_evicted</Code>). See the Context window section.
        </p>
      </>
    ),
  },
  {
    id: 'safety-rails',
    group: 'Power features',
    title: 'Safety rails on workers',
    body: (
      <>
        <p>Arco enforces the following on every spawned worker:</p>
        <ul>
          <li>
            <strong>5 MB output cap per turn.</strong> Beyond that, a truncation
            notice fires and the worker is forced to settle. Prevents runaway loops
            from filling memory with text.
          </li>
          <li>
            <strong>32 GB tree-RSS auto-kill.</strong> The activity poller measures
            the entire worker process tree's resident memory. Crossing the threshold
            kills the tree and surfaces the kill in chat. (This exists because of
            the 2026-04-16 OOM incident where a runaway <Code>find /</Code>
            ballooned a worker to 63 GB.)
          </li>
          <li>
            <strong>Process-tree cleanup on cancel.</strong> When you click cancel,
            the entire descendant tree is killed — not just the top-level process.
            Detached spawns ensure even orphaned children come down.
          </li>
          <li>
            <strong>API overload retry.</strong> Transient overload errors get up to
            3 retries with 15s/30s/60s backoff against the same session id (idempotent).
          </li>
          <li>
            <strong>Concurrent-writer guard.</strong> See Native sessions &amp; resume.
          </li>
          <li>
            <strong>Stuck-worker breaker.</strong> An error-persistence detector
            watches for a worker getting the byte-identical (fuzzy-normalized)
            failing result back and pressing on anyway. On a sustained loop it
            surfaces a structured <Code>worker_stuck</Code> event (plus a{' '}
            <Code>system_notice</Code>) rather than letting the worker burn
            turns. Loop detection keys on persistent <em>errors</em>, not raw
            action repetition (paging / polling stay legitimate).
          </li>
          <li>
            <strong>Hardline command floor (Claude Native).</strong> Native Bash
            refuses a small, non-overridable set of catastrophic commands —
            restarting or killing Arco itself, and <Code>rm -rf</Code> of the
            repo root / <Code>$HOME</Code> / <Code>/</Code> — even when other
            gates would allow them. It's a floor, not a sandbox: the blocked
            command emits a <Code>[blocked by hardline-command-floor]</Code>{' '}
            tool result.
          </li>
          <li>
            <strong>In-turn tool-loop guardrail.</strong> Within a single
            turn, the model's tool loop is watched for an identical{' '}
            <Code>(tool, args)</Code> call (and especially identical{' '}
            <Code>(tool, args, output)</Code>) repeated past a threshold. Default
            posture is warnings-only (a <Code>tool_loop_warning</Code> event +{' '}
            <Code>system_notice</Code>); a hard stop is opt-in via{' '}
            <Code>ARCO_TOOL_LOOP_GUARD=stop</Code>. Catches a wedged turn in a
            handful of iterations instead of waiting for the 1000-iteration
            ceiling.
          </li>
        </ul>
        <p>
          You can opt a workflow out of the RSS guard from CONFIG (for legitimate
          high-memory work). The output cap and tree cleanup are not opt-out-able.
        </p>
      </>
    ),
  },
  {
    id: 'remote',
    group: 'Power features',
    title: 'Remote-friendly operation',
    body: (
      <>
        <p>
          Arco is designed around a <strong>single forwarded port</strong>. Run it
          on your dev box; access it from anywhere via SSH port forwarding.
        </p>
        <Pre>{`# Forward only the client port (5173):
ssh -L 5173:localhost:5173 you@dev-box

# Then open http://localhost:5173 locally.
# /ws and /api/* proxy to 3001 server-side, so you don't need to forward 3001.`}</Pre>
        <p>
          The Vite dev server proxies <Code>/ws</Code> and <Code>/api/*</Code> to the
          server on <Code>3001</Code>, so a single forwarded port covers everything
          you need from a browser. Uploads go through the same proxy.
        </p>
        <h4>Remote management (hub link + REMOTE opt-in)</h4>
        <p>
          A separate, much narrower path lets you <strong>check on workflows and
          answer / stop / continue them from a phone</strong> without exposing the
          full UI. When <Code>ARCO_HUB_URL</Code> is set, this instance connects
          outbound (tailnet-only) to an <Code>arco-management</Code> hub and
          registers itself. The header shows a <strong>hub-link chip</strong> with
          connection state and last-heartbeat; click it for a one-click local kill
          switch.
        </p>
        <p>
          Remote control is <strong>default-OFF</strong>. Standalone workflows
          opt in with
          the <Code>◎ REMOTE: OFF</Code> / <Code>◉ REMOTE</Code> toggle on the
          composer (only shown when this instance is hub-linked) flips a workflow's{' '}
          <Code>remoteEnabled</Code>. A cluster instead has one <Code>◉ REMOTE</Code>{' '}
          switch in its header; that switch shares the cluster and every member as
          one unit, regardless of member-level flags.
        </p>
        <p>
          The phone console supports ongoing chat plus bounded worker controls
          (stop, handoff, compact, fold, queued-message cancellation, parked-question
          answers, and separately armed review-gate resolution). Cluster cards add
          member messaging and broadcast, manual nudges, stop-all, efficiency /
          auto-pickup / idle-nudger controls, and read-only mailbox, plan, board, and
          merged-activity views. The hub only <em>routes</em> this fixed allowlist,
          and the local
          instance <strong>re-validates every action against live state</strong>{' '}
          before applying it. No file browser, no shell, no git push, no credential
          management; notifications inform but never command. Every remote action
          lands in <Code>events.jsonl</Code>.
        </p>
        <p>
          Remote gate approval is a <strong>second, default-OFF arming</strong>{' '}
          (<Code>⛨ GATES</Code>). Without it, gates are visible but read-only on the
          phone. Cluster members follow the cluster-level REMOTE and GATES switches;
          their individual toggles are ignored while clustered.
        </p>
      </>
    ),
  },

  {
    id: 'notifications',
    group: 'Power features',
    title: 'Notifications — the header bell + ntfy push',
    body: (
      <>
        <p>
          The <strong>bell</strong> in the header (always visible, even in focus
          mode) opens a durable notice center with an unread badge. It collects the
          "agent finished / something broke" signals you'd otherwise miss while
          looking at another tab. Categories: <Code>turn-finished</Code>,{' '}
          <Code>quota-recovered</Code>, <Code>auth-expired</Code>,{' '}
          <Code>terminal-exited</Code>, <Code>preview-failed</Code>,{' '}
          <Code>pr-status</Code>, <Code>cluster-nudge</Code>, and <Code>backup</Code>.
          Each category has a{' '}
          <strong>mute toggle</strong> (persisted server-side); opening the center
          clears the unread badge, and CLEAR wipes the history.
        </p>
        <p>
          <strong>External push (ntfy).</strong> Set <Code>ARCO_NTFY_URL</Code> to
          a topic URL and surviving notices are also POSTed to ntfy as
          fire-and-forget pushes (title / body / priority + a click-through link),
          so you get phone notifications away from the desk. It's inert unless that
          env var is set, and it is a one-way <em>prompt</em>, never a command
          channel — answering a notice always goes through the UI or the tailnet
          console, never a tappable payload.
        </p>
      </>
    ),
  },

  {
    id: 'command-palette',
    group: 'Power features',
    title: 'The command palette — Ctrl/Cmd+P',
    body: (
      <>
        <p>
          Press <Kbd>Ctrl/Cmd+P</Kbd> anywhere (including while focus is in the
          composer) to open a fuzzy palette over four sources. Press it again to
          close, or <Kbd>Esc</Kbd>. <Kbd>↑</Kbd>/<Kbd>↓</Kbd> navigate,{' '}
          <Kbd>↵</Kbd> activates the highlighted row.
        </p>
        <ul>
          <li><strong>Commands</strong> — the toolbar actions (new tab, Settings, Manual, GitHub).</li>
          <li><strong>Tabs</strong> — every open workflow; activating one switches to it.</li>
          <li><strong>Transcript</strong> — rows of the active workflow's chat. Activating one switches to that tab and scrolls the row into view with a brief highlight (the same jump-and-flash the HISTORY tab uses).</li>
          <li><strong>Files</strong> — files in the active workflow's cwd (top level). Activating one opens it in the file viewer.</li>
        </ul>
        <p>
          <strong>Content search.</strong> Prefix the query with <Code>&gt;</Code> to
          switch into ripgrep content-search over the workflow's cwd — e.g.{' '}
          <Code>&gt;TODO</Code>. Each hit shows <Code>file:line</Code> and the matched
          text, and clicks through to the file viewer. The search respects the
          standard ignore set (<Code>node_modules</Code>, <Code>.git</Code>,{' '}
          <Code>dist</Code>, …) and <Code>.gitignore</Code>.
        </p>
        <Note kind="info">
          Content search needs <Code>ripgrep</Code> (<Code>rg</Code>) on the server's
          PATH — the same soft dependency the Grep tool uses. If it isn't installed,
          the palette says so instead of failing; the other three sources still work.
        </Note>
      </>
    ),
  },

  {
    id: 'integrated-terminal',
    group: 'Power features',
    title: 'The integrated terminal',
    body: (
      <>
        <p>
          A real PTY-backed terminal inside Arco — run system commands as you
          would in Ghostty, without leaving the workbench. It opens in a{' '}
          <strong>floating, draggable, resizable window</strong> that stays on
          top and never reflows the two-column layout (drag the title bar; resize
          from the bottom-right corner).
        </p>
        <ul>
          <li>
            <strong>Two ways in.</strong> The <Code>&gt;_ TERMINAL</Code> button in
            the header opens a shell in the active workflow's root. In the FILES
            tab, the <Code>&gt;_</Code> header icon opens one at the Files root, and{' '}
            <strong>right-clicking any directory</strong> opens one rooted at that
            folder. All converge on the same floating window.
          </li>
          <li>
            <strong>The shell outlives the window.</strong> The session is a
            workflow resource, not a window. <strong>Closing the window
            detaches</strong> — a <Code>npm run dev</Code> or a <Code>sleep 30</Code>{' '}
            keeps running. Reopening re-attaches and repaints the scrollback. Only{' '}
            <Code>KILL</Code> (or closing the tab / quitting Arco) ends a session.
          </li>
          <li>
            <strong>Stays inside the workflow.</strong> Every session is rooted
            inside the workflow directory — a path that escapes the root is
            refused (the same guard the file-write tools use).
          </li>
          <li>
            <strong>"Run in terminal" from the chat.</strong> When an agent's
            reply contains a shell code block (<Code>bash</Code> /{' '}
            <Code>sh</Code> / <Code>shell</Code> / <Code>console</Code> /{' '}
            <Code>zsh</Code>), a <Code>▶ RUN IN TERMINAL</Code> chip appears on
            it. Clicking it opens the terminal and{' '}
            <strong>pre-fills the command on the prompt — it does NOT run</strong>.
            You review, edit, and press Enter yourself. The agent only suggested
            the command; nothing executes without your keystroke.
          </li>
        </ul>
        <Note kind="info">
          <strong>Operator-only.</strong> This terminal is a human surface — the
          model can <em>never</em> drive it (agents have their own per-turn Bash).
          What lands in <Code>events.jsonl</Code> is session lifecycle
          (open / kill, with cwd + shell) and the operator's command lines; the
          raw byte stream is deliberately excluded (too chatty) and travels on a
          separate <Code>/terminal</Code> WebSocket channel.
        </Note>
        <Note kind="warn">
          <strong>Remote-shell caveat.</strong> When Arco is tunneled (e.g. over
          Tailscale), this endpoint is a <em>remote shell on the workstation</em>.
          It honors the same access posture as the rest of Arco (loopback bind
          by default); exposing Arco remotely exposes the terminal too. The
          terminal does not sandbox you — your commands' effects are yours, as in
          any shell.
        </Note>
      </>
    ),
  },

  // -------------------------------------------------------------- RECALL SEARCH
  {
    id: 'recall-search',
    group: 'Power features',
    title: 'Recall — cross-session conversation search',
    body: (
      <>
        <p>
          <strong>Recall</strong> is a top-level search surface (the header
          <Code>⌕ RECALL</Code> button, or the command palette's "Recall: search
          conversations") over <em>every conversation Arco has ever run</em>,
          across all projects and providers — not just the open tabs. It answers
          "find the conversation from two weeks ago about X."
        </p>
        <p>
          It's backed by the machine-global recall index (<Code>~/.arco/recall/recall.db</Code>)
          and a <strong>deterministic</strong> search engine — there is{' '}
          <strong>no LLM in the loop</strong>, no AI ranking or summarization:
        </p>
        <ul>
          <li>
            <strong>Titles / summaries / tags</strong> are searched via SQLite{' '}
            <Code>FTS5</Code> (bm25 relevance ranking + highlighted snippets).
            Always on; this is the must-have.
          </li>
          <li>
            <strong>Transcript full-text</strong> is an operator toggle
            (default OFF — a bigger scan). When on, the query also runs as a{' '}
            <Code>ripgrep</Code> pass over each conversation's{' '}
            <Code>events.jsonl</Code>, surfacing keywords that appear only in the
            body. Reuses the same ripgrep engine as the in-session content search
            (Cmd/Ctrl+P → <Code>&gt;</Code>); disabled when <Code>rg</Code> isn't
            installed. Keeping transcripts out of the DB keeps it small.
          </li>
        </ul>
        <p>
          Filter by project, provider, and last-active date range. Each result
          shows the title, meta, a match snippet, and which field matched.
        </p>
        <p><strong>Result actions:</strong></p>
        <ul>
          <li>
            <strong>Jump to transcript / Resume</strong> — if the conversation is
            an open tab, switches to it. An archived conversation that isn't open
            points you to its project folder to resume.
          </li>
          <li>
            <strong>Open summary</strong> — opens the saved summary. Summaries
            ship in <strong>F2</strong>; until then this shows a "no summary yet"
            hint rather than erroring.
          </li>
          <li>
            <strong>Reference in current tab</strong> — will inject an excerpt as
            context into the active tab. <em>Deferred</em> to <strong>D1</strong>{' '}
            context references; the button is present but disabled.
          </li>
        </ul>
        <Note>
          Fence-clearance: this is operator-driven retrospective recall over your
          own conversations — a deterministic projection of <Code>meta.json</Code>{' '}
          + <Code>events.jsonl</Code>, never a model of the operator. The index is
          rebuildable from disk; delete <Code>recall.db</Code> and the next
          backfill reconstructs it.
        </Note>
      </>
    ),
  },

  {
    id: 'knowledge-base',
    group: 'Power features',
    title: 'The KNOWLEDGE tab — operator-curated project facts',
    body: (
      <>
        <p>
          A per-project, <strong>operator-owned</strong> knowledge base stored on
          disk under <Code>.arco/knowledge/</Code> (a small <Code>index.json</Code>{' '}
          plus one markdown file per article — hand-editable / diff-able). Think
          of it as a curated companion to <Code>CLAUDE.md</Code>: repo layout,
          gotchas, deploy steps, conventions you build up instead of
          re-explaining each session.
        </p>
        <ul>
          <li>Each article is a <strong>title + markdown body + tags</strong> with an <strong>always-include / on-demand</strong> flag.</li>
          <li>Articles flagged <strong>always include</strong> fold into every turn's system prompt as a <strong>bounded block</strong>. The tab shows a budget bar — the running always-include total against the injection budget. Over budget, the block is truncated with an explicit notice (the KB can never silently bloat the turn's context).</li>
          <li>List / search / edit / delete are plain operator CRUD over <Code>/api/knowledge</Code>.</li>
        </ul>
        <p>
          <strong>The "Add from…" wizard</strong> offers three sources: a blank
          article; a <em>quick link</em> (paste a URL and write a short summary —
          the URL is <em>not</em> auto-fetched, matching the deferred-SSRF posture
          of <Code>@url:</Code>); and <em>distill from this session</em>, where an
          agent <strong>drafts</strong> an article from the current transcript.
        </p>
        <Note>
          <strong>The fence.</strong> Nothing is ever auto-saved to the knowledge
          base by an LLM. The distill step only <em>drafts</em> — the agent has no
          write tool and no access to the store; the draft lands in editable
          fields and you must explicitly <strong>Save</strong> it. This is the
          sanctioned, operator-in-the-loop cousin of the rejected self-writing
          memory: operator-driven CRUD, with the only model involvement being an
          optional drafting assist always followed by a human Save.
        </Note>
      </>
    ),
  },

  // -------------------------------------------------------------- TROUBLESHOOTING
];
