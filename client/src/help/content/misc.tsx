import { C } from './shared';
import type { HelpEntry } from './shared';

export const miscHelp: Record<string, HelpEntry> = {
  // -------------------------------------------------------------- CHAT PANEL
  'chat.panel': {
    title: 'Chat panel',
    body: (
      <>
        <p>
          The conversation with this tab's primary agent. Renders tail-first
          (last 200 entries) — use the <C>↑ LOAD EARLIER</C> pill at the top to
          page back further. Scroll position is preserved.
        </p>
        <p>
          Streams tokens during a turn. Tool calls render as inline pills
          between assistant bubbles (Claude only). Computer selecting this worker,
          or sending it a voice message/nudge while selected, resumes following
          the latest output. Scroll up to pause; background recipients leave
          your reading position alone.
        </p>
      </>
    ),
    manualSection: 'chat-panel',
  },
  'chat.message.user': {
    title: 'Operator message',
    body: <p>Your prompt. Long messages collapse to a preview with an expand toggle.</p>,
  },
  'chat.message.agent': {
    title: 'Agent reply',
    body: <p>The primary's reply. Streams token-by-token while the turn is in flight.</p>,
  },
  'chat.message.thinking': {
    title: 'Reasoning trace',
    body: (
      <p>
        Reasoning output from Claude / Codex / Ollama (when the model exposes
        it), streamed into the ACTIVITY feed rather than the main chat.
        Consecutive deltas coalesce into one block. Counts toward context but
        isn't part of the visible reply.
      </p>
    ),
  },
  'chat.tool-pill': {
    title: 'Tool call',
    body: (
      <p>
        The agent invoked a tool (Bash / Read / Edit / etc.). Click to expand
        the JSON input and result. Click any file path inside to open it in the
        viewer modal. Status: ● running, ✓ done, ✗ failed.
      </p>
    ),
    manualSection: 'tool-pills',
  },
  'chat.compacting': {
    title: 'Compacting…',
    body: (
      <p>
        This Claude-native tab is running a compaction — summarizing the
        conversation in place so the next turn starts against a smaller prompt.
        The whole chat area is taken over and the composer is disabled while it
        runs (one summarization round, between turns). It clears on success, on
        failure, or when the next turn starts. The folded transcript stays in{' '}
        <C>events.jsonl</C>; a <C>▸ CONTINUE</C> affordance resumes the work
        afterward.
      </p>
    ),
  },
  'chat.task-card': {
    title: 'Task sub-agent (Native)',
    body: (
      <p>
        The Native worker called the <C>Task</C> tool — this card represents a
        first-class child workflow scoped to its parent. Status:{' '}
        <C>running</C> / <C>done</C> / <C>error</C> / <C>cancelled</C>; the{' '}
        <C>PROMOTE</C> button surfaces the child into the top tab strip.
        Depth-1 only (children can't call <C>Task</C> themselves). Parallel{' '}
        <C>Task</C> calls within one turn dispatch concurrently.
      </p>
    ),
    manualSection: 'tasks-tab',
  },
  'creator.tool-filter': {
    title: 'Tool-result filter',
    body: (
      <p>
        Claude Native efficiency control. Conservative filters trim noisy tool
        output before it enters the next model call; reductions are logged so
        transcript review can see what changed.
      </p>
    ),
    manualSection: 'config-tab',
  },
  'creator.output-style': {
    title: 'Output style default',
    body: (
      <p>
        Default response style for new Claude Native, Codex app-server, and
        Z.ai tabs: <C>normal</C>, <C>lite</C>, or <C>terse</C>. Applies to
        primary turns; Review / Handoff / DOCS / GIT stay normal.
      </p>
    ),
    manualSection: 'config-tab',
  },
  'preview.port': {
    title: 'PREVIEW · PORT',
    body: <p>Type the dev-server port and press Enter or click <C>BIND</C>. Vite defaults to 5173, Next 3000, Astro 4321.</p>,
    manualSection: 'preview-tab',
  },
  // ------------------------------------------------- RUNTIME RECOVERY (§C2)
  'runtime.cancel-turn': {
    title: 'RUNTIME · CANCEL TURN',
    body: (
      <p>
        The worker has emitted no output for a while and may be hung. There's no
        safe way to poke a stuck provider awake, so the honest recovery is to{' '}
        <C>CANCEL TURN</C> (kills this workflow's in-flight turn) and re-send your
        prompt.
      </p>
    ),
    manualSection: 'offline',
  },
  'runtime.dismiss-recovered': {
    title: 'RUNTIME · DISMISS',
    body: (
      <p>
        Acknowledge the replay-recovered notice — this tab's context was
        rehydrated from disk after a reconnect/restart. <C>DISMISS</C> clears the
        badge immediately; it also auto-clears once its window elapses or on your
        next interaction.
      </p>
    ),
    manualSection: 'offline',
  },
  'preview.reprobe': {
    title: 'PREVIEW · RE-PROBE',
    body: (
      <p>
        Re-check whether the currently-bound dev-server port is still listening.
        If it's gone, the dead-service picker opens so you can bind a
        currently-listening service instead of hunting for the port.
      </p>
    ),
    manualSection: 'preview-tab',
  },
  'preview.bind': {
    title: 'PREVIEW · BIND',
    body: <p>Bind the typed port to this workflow. Persisted in <C>meta.json</C>. Marks the binding as <C>manual: true</C> — auto-detect will never overwrite it.</p>,
    manualSection: 'preview-tab',
  },
  'preview.reload': {
    title: 'PREVIEW · RELOAD',
    body: <p>Remount the iframe. Cheaper than fiddling with <C>src</C>, and survives any backend that doesn't honor cache-control.</p>,
    manualSection: 'preview-tab',
  },
  'preview.open': {
    title: 'PREVIEW · OPEN',
    body: <p>Open the preview in a new browser tab — useful for full-window viewing.</p>,
    manualSection: 'preview-tab',
  },
  'preview.unbind': {
    title: 'PREVIEW · UNBIND',
    body: <p>Clear the binding. Removes <C>meta.preview</C> and hides the iframe. Operator-driven — auto-detect can re-bind on the next agent dev-server spawn.</p>,
    manualSection: 'preview-tab',
  },
  'preview.verify': {
    title: 'PREVIEW · VERIFY',
    body: (
      <p>
        Operator-triggered capture of the running preview via a headless system
        Chrome/Chromium. <C>CAPTURE SCREENSHOT</C> grabs the rendered page;{' '}
        <C>CHECK CONSOLE</C> collects console errors + warnings; <C>CHECK NETWORK</C>{' '}
        lists failed and 4xx/5xx requests. Each writes a report (and screenshot)
        artifact under the workflow's <C>artifacts/</C> dir — inspectable evidence,
        not autonomous browsing. Needs a system browser installed (or{' '}
        <C>ARCHON_CHROME_BINARY</C> set); none bundled.
      </p>
    ),
    manualSection: 'preview-tab',
  },
  'preview.captures': {
    title: 'PREVIEW · capture result',
    body: <p>The latest capture: page title, console-error / failed-request counts, a screenshot thumbnail (click to open full size), and <C>VIEW REPORT</C> for the full markdown report. Artifacts persist on disk.</p>,
    manualSection: 'preview-tab',
  },
  'preview.viewport': {
    title: 'PREVIEW · capture viewport',
    body: (
      <p>
        Device-class viewport the <C>VERIFY</C> capture renders at:{' '}
        <C>DESKTOP</C> (1280×800), <C>TABLET</C> (834×1112), <C>MOBILE</C>{' '}
        (390×844). Tablet and mobile also emulate touch and a device pixel ratio
        so responsive breakpoints fire the way they would on the real device.
        Every capture also collects basic layout/accessibility notes (horizontal
        overflow, missing alt text / labels, <C>lang</C>, headings). Distinct
        from the iframe aspect ratio (which only scales the live view). Persists
        to localStorage.
      </p>
    ),
    manualSection: 'preview-tab',
  },
  'preview.captureActions': {
    title: 'PREVIEW · send capture to an agent',
    body: (
      <p>
        <C>SEND TO AGENT</C> seeds this tab's composer with an <C>@file</C> ref to
        the capture report plus a framing line — the current agent reads the
        actual report when you send. <C>ATTACH TO REVIEW</C> fires a Review over
        the report (reusing this tab's primary provider/model/effort): a
        read-only reviewer judges the running UI from the captured evidence and
        files a verdict in the REVIEW tab.
      </p>
    ),
    manualSection: 'preview-tab',
  },
  'preview.aspect': {
    title: 'PREVIEW · aspect ratio',
    body: (
      <p>
        Iframe aspect ratio. Logical viewport width is fixed at 1920 (Full-HD-ish);
        height derives from the chosen ratio (<C>4:3</C> → 1920×1440,{' '}
        <C>16:10</C> → 1920×1200, <C>16:9</C> → 1920×1080). The iframe is then
        CSS-scaled to the largest box-of-this-ratio that fits the pane and
        centered both axes. Choice persists to localStorage and applies to
        every workflow's PREVIEW tab.
      </p>
    ),
    manualSection: 'preview-tab',
  },
  // ----------------------------------------- WORKFLOW CREATOR / RESUME
  'creator.cluster-mode': {
    title: 'Mode — Agent, Chat, Cluster or Genesis',
    body: (
      <>
        <p>
          Top-of-form toggle. <strong>SINGLE WORKFLOW</strong> creates one tab
          with one project agent. <strong>CHAT</strong> is a conversation with no
          project; <strong>GENESIS</strong> starts from an idea before scaffolding
          a project. <strong>CLUSTER</strong>{' '}
          creates N member tabs pinned to the same working directory, each
          configurable per-member (provider / model / effort / role / tier).
        </p>
        <p>
          In CLUSTER mode the field stack above re-labels as{' '}
          <strong>DEFAULT FOR NEW MEMBERS</strong> — those values seed any new
          row you add. Expand a member row to override its individual settings.
          Clusters require at least 2 members and only support providers with
          peer-tool wiring. Claude/Codex are wired through native/MCP paths;
          local providers use Arco's local tool registry when enabled.
        </p>
        <p>
          Members can exchange notes between turns via the peer tool
          (peer_list / peer_send / peer_read). Set a per-member <em>role</em>{' '}
          for human-readable framing ("director", "tester") and a per-member{' '}
          <em>tier</em> (light / standard / heavy) so other members reading
          peer_list can pick the right capability for a sub-task. Tiers are
          pure metadata — Arco does no hidden autonomous routing.
        </p>
      </>
    ),
    manualSection: 'create-cluster-from-new',
  },
  'creator.cluster-presets': {
    title: 'Cluster presets',
    body: (
      <>
        <p>
          A <strong>preset</strong> is an operator-saved snapshot of the
          per-member configs (provider / model / effort / role / tier /
          display name / permissions / fast-mode / filter / output style) plus
          the optional CLUSTER NAME, captured under a name you pick. Cwd is
          intentionally <em>not</em> saved — presets are project-agnostic so
          the same shape can be applied to any working directory.
        </p>
        <p>
          Click a pill to apply that preset: it overwrites the MEMBERS list,
          and (only if the CLUSTER NAME field is blank) seeds it from the
          preset's name template. Click <C>×</C> to delete after a confirm.
          Click <C>+ SAVE AS PRESET</C> to save the current cluster shape
          under a new name — the button is disabled until you have ≥2 members
          each with a model.
        </p>
      </>
    ),
    manualSection: 'cluster-presets',
  },

  'creator.templates': {
    title: 'Templates (recipes)',
    body: (
      <>
        <p>
          A <strong>template</strong> is the single-tab analogue of a cluster
          preset: an operator-saved snapshot of this tab's config (provider /
          model / effort / permissions / fast-mode / tool-filter / output
          style) plus an <em>optional</em> working directory, captured under a
          name you pick. Bake the cwd in for a project-pinned recipe ("new
          Ledger tab"), or omit it for a portable one that applies to whatever
          directory you pick next.
        </p>
        <p>
          Click a pill to apply that template — it pre-fills the form fields
          (and the cwd only if the recipe saved one). Click <C>×</C> to delete
          after a confirm. Click <C>+ SAVE AS TEMPLATE</C> to save the current
          config under a new name. If a template carries a seed prompt or plan,
          applying it <em>pre-fills</em> the new tab's composer and PLAN tab —
          it is never auto-sent.
        </p>
      </>
    ),
    manualSection: 'creating-workflow',
  },
  'creator.cluster-members': {
    title: 'Cluster members',
    body: (
      <>
        <p>
          One row per member. Rows are collapsed by default and show a
          one-line summary (display name, provider, model, effort, role, tier).
          Click <C>↓ EDIT</C> to expand into the full editor; <C>↑ COLLAPSE</C>{' '}
          to fold back. <C>× REMOVE</C> drops the row.
        </p>
        <p>
          <C>+ ADD MEMBER</C> appends a fresh row seeded from the
          DEFAULT FOR NEW MEMBERS group above. Cluster requires ≥2 members.
        </p>
      </>
    ),
  },
  'creator.cwd': {
    title: 'Working directory',
    body: (
      <p>
        The project root the agent operates against. Type a path, click a
        folder in the picker below, or use the <C>↑ UP</C> button to navigate.
        All persistence (<C>events.jsonl</C>, <C>meta.json</C>, artifacts)
        lives under <C>&lt;cwd&gt;/.archon/</C>.
      </p>
    ),
  },
  'creator.name': {
    title: 'Workflow name',
    body: (
      <p>
        Short label for this tab — what shows in the tab bar. Optional; the
        cwd basename is used when blank. Doesn't affect persistence (workflows
        are keyed by id, not name) so renaming later is harmless.
      </p>
    ),
  },
  'creator.genesis-spark': {
    title: 'The Spark',
    body: (
      <p>
        Genesis mode starts a project from a raw idea instead of a folder. The
        Spark is that raw idea in your own words — what sparked it, what it might
        do, what's unresolved. No working directory yet: Genesis ideates in a
        scratch space, and <C>CREATE &amp; SCAFFOLD</C> (in the GENESIS tab) later
        creates the real project folder and binds it.
      </p>
    ),
  },
  'creator.permissions': {
    title: 'Permissions — AUTO vs SAFE',
    body: (
      <>
        <p>
          Controls how the primary's tool calls are gated.
        </p>
        <ul style={{ margin: '4px 0', paddingLeft: '18px' }}>
          <li>
            <strong>AUTO</strong> — passes <C>--dangerously-skip-permissions</C>
            {' '}(Claude) / unrestricted sandbox to the primary. Tools execute
            without per-call approval. The agent can write files, run Bash,
            etc. autonomously. Faster, but the agent has full system access
            within the cwd.
          </li>
          <li>
            <strong>SAFE</strong> — every privileged tool call requires
            explicit approval. Slower in interactive use; appropriate when you
            don't yet trust the agent on this codebase, or when running an
            untested model.
          </li>
        </ul>
        <p>
          Reviewers always run with restrictive permissions regardless of this
          setting (Read/Grep/Glob only for Claude; <C>read-only</C> sandbox for
          Codex).
        </p>
      </>
    ),
    manualSection: 'safety-rails',
  },
  'creator.fast-mode': {
    title: 'Fast mode',
    body: (
      <>
        <p>
          Claude only. A per-tab toggle that biases the primary toward faster,
          lower-latency replies on simple tasks — at some cost to depth.
        </p>
        <p>
          Useful when you want chat-like back-and-forth on simple tasks.
          Leave OFF for complex / multi-step work where reasoning quality
          matters more than time-to-first-token.
        </p>
      </>
    ),
  },
  'creator.ultracode': {
    title: 'Ultracode',
    body: (
      <>
        <p>
          Claude only. Starts the tab in <strong>sticky ultracode</strong> — the
          same deep multi-agent mode as <C>ultracode</C> in the Claude CLI. Each
          turn, Claude authors a <C>Workflow</C> that fans out a fleet of
          subagents (find → verify → synthesize) and the harness runs it in the
          background. Enabling it pins effort to <C>XHIGH</C> and forces the{' '}
          <C>cli</C> transport (the WorkflowTool lives only in the{' '}
          <C>claude</C> binary — Native can't host it).
        </p>
        <p>
          Stays on every turn until you turn it off (in CONFIG → TRANSPORT);
          your base transport is remembered and restored when you do. It runs a
          fleet of agents <strong>unattended with full system access</strong> and
          spends heavily — a per-turn cost, not a one-off. Per-subagent actions
          live in the harness workflow journal; the full Workflow script is shown
          inline in the Activity tab.
        </p>
      </>
    ),
    manualSection: 'config-tab',
  },
  'creator.advanced': {
    title: 'Advanced options',
    body: (
      <p>
        Collapsible section for less-common settings — additional directories
        (cross-project tool access) and a fallback model that kicks in when
        the primary is overloaded.
      </p>
    ),
  },
  'creator.additional-dirs': {
    title: 'Additional directories',
    body: (
      <>
        <p>
          Extra paths the primary's tools can read/write — passed via{' '}
          <C>--add-dir</C>. One per line or comma-separated.
        </p>
        <p>
          Useful when this workflow needs to reference a sibling repo, a
          shared library directory, or your home dotfiles. Without entries
          here, tools are scoped to the cwd.
        </p>
      </>
    ),
  },
  'creator.fallback-model': {
    title: 'Fallback model',
    body: (
      <>
        <p>
          Claude only. When the primary model returns an overload error, the
          CLI automatically retries with this model. Passed via{' '}
          <C>--fallback-model</C>.
        </p>
        <p>
          Common pattern: primary <C>opus</C>, fallback <C>sonnet</C> — keeps
          work flowing during peak hours when Opus is throttled.
        </p>
      </>
    ),
  },
  'creator.save-defaults': {
    title: 'Save as defaults',
    body: (
      <p>
        Persists the current picker state — provider, model, effort,
        permissions, fast mode, fallback — to{' '}
        <C>~/.archon/settings.json</C> so the next workflow pre-selects the
        same. The cwd is <em>not</em> saved (each workflow has its own).
      </p>
    ),
  },
  'creator.launch': {
    title: 'Launch workflow',
    body: (
      <p>
        Creates the tab and starts the workflow with the picker state above.
        Requires a connection and model. A project workflow also needs a working
        directory; Chat does not. Chat launches a saved or Incognito conversation
        according to the checkbox. Genesis and Cluster have their own form gates.
      </p>
    ),
    manualSection: 'creating-workflow',
  },
  'creator.provider': {
    title: 'Provider',
    body: (
      <p>
        Pick which AI back-end runs this tab. Ten providers (Claude / Codex /
        Gemini / Z.ai / Cursor / Ollama / llama.cpp / LM Studio / Strata / Antigravity); the picker hides ones disabled
        in Settings or without auth. Local providers (Ollama, llama.cpp) require
        installed models — empty catalogs hide the option. In cluster creation,
        only providers with peer-tool wiring are eligible. Chat excludes Gemini
        and Antigravity; Incognito additionally excludes Cursor, llama.cpp and Strata.
      </p>
    ),
    manualSection: 'providers-overview',
  },
  'creator.model': {
    manualSection: 'live-config-swap',
    title: 'Model',
    body: (
      <p>
        Specific model within the provider. Populated from the capability
        probe. Agent tabs can change it later from CONFIG; Chat tabs swap it
        from the header model picker (same provider). Strata adds prepared Original
        and SC117 Abliterated profiles; the next message loads the chosen profile
        and retains history, with only one model resident. For <b>Cursor</b>, this is a two-part picker: choose the model
        <i>family</i> (Opus, Grok, GPT-5.x Sol, …) then its <i>effort</i>, with
        optional <b>FAST</b> / <b>THINK</b> toggles — Cursor bakes effort into
        the model id, so the picker only offers combinations Cursor actually
        advertises (no invalid selections). <b>Auto</b> lets Cursor's router
        pick model and effort itself.
      </p>
    ),
  },
  'creator.effort': {
    manualSection: 'live-config-swap',
    title: 'Effort',
    body: (
      <p>
        Reasoning budget. Claude has 5 levels (low/medium/high/xhigh/max),
        Codex follows the selected model's catalog (Astra and Sol: low through ultra; Luna stops at max;
        older models may stop at xhigh), Strata offers none/low/medium/high (none
        disables reasoning; high maps to Qwen xhigh), other local models expose low/high as a thinking toggle, and
        Gemini has none. Higher effort = more thinking tokens = more cost /
        more time. <b>Cursor</b> has no separate effort here — it's baked into
        the model id, so set it in the MODEL picker above.
      </p>
    ),
  },
  'creator.resume': {
    title: 'Resume native session',
    body: (
      <p>
        Lists CLI sessions already on disk for this cwd (
        <C>~/.claude/projects</C>, <C>~/.codex/sessions</C>,{' '}
        <C>~/.gemini/tmp</C>). Pick one to continue inside Arco — the session
        remains a real native CLI session you can also resume from a terminal.
      </p>
    ),
    manualSection: 'sessions-and-resume',
  },
  // ----------------------------------------------------- ACTION BUTTONS
  'actions.review': {
    title: 'Review',
    body: (
      <p>
        Spawns an ephemeral reviewer (any provider/model) over a slice of the
        conversation. Output is a read-only artifact in the REVIEW tab.
        Reviewer permissions are restrictive (read-only / sandbox).
      </p>
    ),
    manualSection: 'review-action',
  },
  'actions.handoff': {
    title: 'Handoff',
    body: (
      <p>
        Rotates this tab's session. The current agent writes a handoff
        document; a fresh session starts with that doc as its seed. For
        Antigravity, this means a fresh cascade seeded with handoff text, not
        compaction of Antigravity's internal context. <C>Original-worker</C>{' '}
        (the primary self-reflects) only applies to Claude, Codex, and Z.ai; other
        providers — Antigravity, Gemini, Cursor, Ollama, llama.cpp, LM Studio — auto-fall back to{' '}
        <C>fresh-summarizer</C>.
      </p>
    ),
    manualSection: 'handoff-action',
  },
  'actions.spawn': {
    title: 'Spawn from here',
    body: (
      <p>
        Forks the conversation to a new tab with configurable model/effort and
        an optional new direction. The original tab continues in parallel —
        useful for "what if?" branches.
      </p>
    ),
    manualSection: 'spawn-action',
  },
  // ------------------------------------------------------ REVIEW DIALOG
  'review.provider': {
    title: 'Reviewer provider',
    body: (
      <p>
        Which back-end runs the review. Pick a different family from the
        primary for genuine cross-checking — the whole value of Review is
        getting a second opinion that doesn't share the primary's blind spots.
      </p>
    ),
    manualSection: 'review-action',
  },
  'review.account': {
    title: 'Reviewer account',
    body: (
      <p>
        Which Codex profile (CODEX_HOME) runs the review. Only shown when the
        reviewer provider is Codex and you have more than one profile configured
        in Settings. Lets you bill the review to a separate account from the
        primary.
      </p>
    ),
    manualSection: 'review-action',
  },
  'review.model': {
    title: 'Reviewer model',
    body: (
      <p>
        Specific model within the chosen provider. Lower-tier reviewers are
        often fine — review is a read + critique task, lighter than the
        primary's work.
      </p>
    ),
  },
  'review.effort': {
    title: 'Reviewer effort',
    body: (
      <p>
        Reasoning budget for the reviewer. <C>medium</C>+ is recommended for
        substantive reviews; <C>low</C> tends to produce surface-level checks
        that miss subtle issues.
      </p>
    ),
  },
  'review.scope': {
    title: 'Review scope',
    body: (
      <>
        <p>What slice of the conversation to review:</p>
        <ul style={{ margin: '4px 0', paddingLeft: '18px' }}>
          <li><strong>last-turn</strong> — just the most recent agent reply.</li>
          <li><strong>last-N</strong> — last N turns (you set N).</li>
          <li><strong>current-session</strong> — everything since the most recent handoff seed.</li>
          <li><strong>full</strong> — the entire <C>events.jsonl</C>.</li>
          <li><strong>git-diff-only</strong> — just <C>git diff HEAD</C>; no chat context.</li>
        </ul>
        <p>
          Optional <strong>INCLUDE GIT DIFF</strong> appends{' '}
          <C>git diff HEAD</C> to the chat slice (skipped when scope already
          implies it).
        </p>
        <p>
          When the dialog is opened from the Plan tab (REVIEW PLAN, ▷ REVIEW phase
          pill, CUSTOM REVIEW), this row is replaced with a locked plan reference
          and a MODE row (VERIFY / CRITIQUE).
        </p>
      </>
    ),
  },
  'review.dispatch': {
    title: 'Who does the review?',
    body: (
      <>
        <p>
          In a cluster, choose <C>SUB-WORKER</C> for a disposable reviewer that
          writes a markdown artifact, or choose a cluster member to send the
          review task as a real turn in that member&apos;s chat.
        </p>
        <p>
          Member-routed reviews do not auto-forward findings. Use{' '}
          <C>→ TRANSCRIPT</C> from the reviewer member when another member needs
          the result.
        </p>
      </>
    ),
    manualSection: 'cluster-routed-reviews',
  },
  'review.mode': {
    title: 'Review mode',
    body: (
      <p>
        Plan reviews can run as <C>CRITIQUE</C> (audit plan structure and
        ordering) or <C>VERIFY</C> (audit claimed-done work against the tree and
        diff). Some cluster-plan buttons lock the mode by intent.
      </p>
    ),
    manualSection: 'plan-review',
  },
  'review.cancel': {
    title: 'Cancel',
    body: <p>Closes the dialog without running a review.</p>,
  },
  'review.run': {
    title: 'Run review',
    body: (
      <p>
        Spawns the reviewer worker with the chosen scope + model. Output is
        a markdown artifact in the REVIEW tab; verdict (PASS / MINOR /
        BLOCKING) is parsed from the tail and surfaced as a chip on the
        artifact row.
      </p>
    ),
  },
  // ----------------------------------------------------- HANDOFF DIALOG
  'handoff.mode': {
    title: 'Handoff mode',
    body: (
      <>
        <p>How the handoff document is generated:</p>
        <ul style={{ margin: '4px 0', paddingLeft: '18px' }}>
          <li>
            <strong>ORIGINAL WORKER</strong> — the current primary
            self-reflects via <C>--resume &lt;sessionId&gt;</C> and writes the
            handoff itself. Highest fidelity. Default for Claude/Codex/Z.ai.
          </li>
          <li>
            <strong>FRESH SUMMARIZER</strong> — an ephemeral worker reads the
            rendered transcript and writes the doc. Lower fidelity. Required
            for non-resumable primaries (Ollama, Antigravity).
          </li>
        </ul>
      </>
    ),
    manualSection: 'handoff-action',
  },
  'handoff.provider': {
    title: 'Post-handoff provider',
    body: (
      <p>
        Optionally swap to a different provider after the handoff. Leave
        unchanged to keep the current primary. Useful when the current
        provider is throttled or you want to try a different family on the
        rotated session. Local providers appear when enabled and when their
        model catalog is non-empty.
      </p>
    ),
  },
  'handoff.summarizer.provider': {
    title: 'Summarizer provider',
    body: (
      <p>
        Provider for the temporary worker that writes the handoff document in
        fresh-summarizer mode. This does not change the provider used by the
        rotated session.
      </p>
    ),
    manualSection: 'handoff-action',
  },
  'handoff.summarizer.model': {
    title: 'Summarizer model',
    body: (
      <p>
        Model for the temporary handoff-writer worker. Use a model that can read
        the transcript reliably; the new session&apos;s model is configured
        separately below.
      </p>
    ),
    manualSection: 'handoff-action',
  },
  'handoff.summarizer.effort': {
    title: 'Summarizer effort',
    body: (
      <p>
        Effort level for the temporary handoff-writer worker. Higher effort can
        produce a more careful handoff document, but it does not affect the
        rotated session&apos;s effort.
      </p>
    ),
    manualSection: 'handoff-action',
  },
  'handoff.account': {
    title: 'Post-handoff account',
    body: (
      <p>
        Which Codex profile (CODEX_HOME) the rotated session runs under. Only
        shown when the post-handoff provider is Codex and you have more than one
        profile configured in Settings.
      </p>
    ),
    manualSection: 'handoff-action',
  },
  'handoff.model': {
    title: 'Post-handoff model',
    body: <p>Model for the new session. Defaults to the current model.</p>,
  },
  'handoff.effort': {
    title: 'Post-handoff effort',
    body: <p>Effort level for the new session. Defaults to the current effort.</p>,
  },
  'handoff.cancel': {
    title: 'Cancel',
    body: <p>Closes without rotating the session.</p>,
  },
  'handoff.confirm': {
    title: 'Rotate (or Rotate & Swap)',
    body: (
      <p>
        Generates the handoff document and rotates the tab to a fresh
        session. If you changed the provider/model/effort, the button reads{' '}
        <C>ROTATE & SWAP</C> — both happen atomically.
      </p>
    ),
  },
  // ------------------------------------------------------- SPAWN DIALOG
  'spawn.name': {
    title: 'New workflow name',
    body: <p>Label for the new tab. Defaults to a derivative of the parent's name.</p>,
  },
  'spawn.provider': {
    title: 'Spawned-tab provider',
    body: (
      <p>
        Provider for the forked tab — different from the parent if you want
        to try a different family on the side path. The original tab continues
        unchanged.
      </p>
    ),
    manualSection: 'spawn-action',
  },
  'spawn.account': {
    title: 'Spawned-tab account',
    body: (
      <p>
        Which Codex profile (CODEX_HOME) the forked tab runs under. Only shown
        when the spawned-tab provider is Codex and you have more than one
        profile configured in Settings.
      </p>
    ),
    manualSection: 'spawn-action',
  },
  'spawn.model': {
    title: 'Spawned-tab model',
    body: (
      <p>
        Model for the forked tab. For Cursor, pick the family then its effort
        (with optional FAST / THINK) — effort is baked into the model id.
      </p>
    ),
  },
  'spawn.effort': {
    title: 'Spawned-tab effort',
    body: <p>Effort level for the forked tab. Cursor has none here — it's baked into the model id (set it in the MODEL picker).</p>,
  },
  'spawn.direction': {
    title: 'New direction (optional)',
    body: (
      <p>
        Free-form text appended after the handoff doc in the new tab's seed.
        Use it to redirect the forked agent — <em>"focus on the migration
        path; ignore the test refactor"</em>. Leave blank to let it pick up
        where the parent left off.
      </p>
    ),
  },
  'spawn.plan': {
    title: 'Include attached plan',
    body: (
      <p>
        Whether the parent's attached plan (if any) carries over to the new
        tab. Toggle off when the side branch shouldn't be bound by the
        parent's plan.
      </p>
    ),
  },
  'spawn.cluster': {
    title: 'Cluster target',
    body: (
      <p>
        For cluster phase spawns, the spawned workflow stays tied to the same
        cwd and starts from the selected phase block. Use this when a phase
        should become its own focused worker.
      </p>
    ),
    manualSection: 'cluster-plan',
  },
  'spawn.cancel': {
    title: 'Cancel',
    body: <p>Closes without spawning a new tab.</p>,
  },
  'spawn.confirm': {
    title: 'Spawn',
    body: (
      <p>
        The current primary self-reflects with full session context, writes a
        handoff doc, and a new tab opens with that doc + your new direction
        as its seed. The parent tab is untouched.
      </p>
    ),
  },
  // ------------------------------------------------ PLAN COMPOSER + TAB
  'plan.draft-review': {
    title: 'Draft → I\'ll review',
    body: (
      <p>
        The agent's next reply will be its draft of the plan. A banner
        appears offering <C>SAVE & ATTACH</C> — read first, save only if
        happy. Slower but inspection-friendly.
      </p>
    ),
    manualSection: 'plan-creation',
  },
  'plan.draft-autosave': {
    title: 'Draft & auto-save',
    body: (
      <p>
        The agent's reply is captured as the plan automatically — no review
        step. Faster but no chance to redirect before commit. Best for quick
        plan drafts on simple workflows. <strong>Cluster members:</strong>{' '}
        AUTOSAVE re-routes through the choice banner (REVIEW mode) so you can
        pick between attaching to the worker or the cluster's shared PLAN.
      </p>
    ),
  },
  'plan.new': {
    title: 'New plan',
    body: (
      <p>
        Open the inline plan editor — type a title and body, then click{' '}
        <C>CREATE & ATTACH</C> to save and attach in one step. Bypasses the
        agent draft flow.
      </p>
    ),
  },
  'plan.toggle-completed': {
    title: 'Show completed plans',
    body: <p>Reveals/hides the archive of plans marked complete. Click any to reopen if needed.</p>,
  },
  'plan.edit': {
    title: 'Edit plan',
    body: (
      <p>
        Opens the title + body editor for the active plan. Save commits to{' '}
        <C>.archon/plans/&lt;id&gt;.md</C>; the body re-injects on the next
        turn so the agent sees your edits.
      </p>
    ),
  },
  'plan.detach': {
    title: 'Detach plan',
    body: (
      <p>
        Removes the plan from this workflow. The plan stays on disk and can
        be reattached later — detach just stops it from being injected into
        the next turn's prompt.
      </p>
    ),
  },
  'plan.review-plan': {
    title: 'Review plan (critique)',
    body: (
      <p>
        Spawns a reviewer over the entire plan in <C>CRITIQUE</C> mode —
        every item is shown with check state preserved, and the reviewer
        evaluates the <em>plan itself</em>: gaps, ordering, missing
        considerations. Use <C>VERIFY WORK</C> for the audit-the-claims
        flow. The dialog's MODE row lets you flip to VERIFY before running.
      </p>
    ),
    manualSection: 'plan-review',
  },
  'plan.verify-work': {
    title: 'Verify work',
    body: (
      <p>
        Spawns a reviewer over the plan in <C>VERIFY</C> mode with
        <C>INCLUDE GIT DIFF</C> pre-ticked. Only <C>[x]</C> items are
        shown, framed as the worker's claimed-completed work; the reviewer
        cross-checks each claim against the actual <C>git diff HEAD</C>
        and the code in the tree using its tools. Partial-completion
        signals (a <C>[x]</C> parent with <C>[ ]</C> subtasks) get flagged.
      </p>
    ),
    manualSection: 'plan-review',
  },
  'plan.custom-review': {
    title: 'Custom review',
    body: (
      <p>
        Opens a picker that lets you choose any subset of plan items
        (across phases) to send to the reviewer. Useful when only a few
        scattered items are relevant — e.g., reviewing one cross-cutting
        feature spread across multiple phases. Mode (VERIFY / CRITIQUE) is
        chosen on the resulting dialog.
      </p>
    ),
    manualSection: 'plan-review',
  },
  'plan.refs': {
    title: 'Reference docs',
    body: (
      <p>
        Long-form docs attached to this plan (<C>.archon/plans/&lt;id&gt;.refs/</C>).
        Keep the plan a checklist and link detail from a task as{' '}
        <C>[label](ref:slug)</C> — the link renders as a chip that opens the doc.
        <C> + REF</C> adds one; the viewer edits or deletes it. Agents write refs
        with <C>plan_ref_write</C>, and are told to read the refs a task links
        before working it.
      </p>
    ),
    manualSection: 'plan-refs',
  },
  'plan.library': {
    title: 'All plans',
    body: (
      <p>
        Opens the plans library (ARCHIVE → PLANS): every plan across all
        projects, reviewable without attaching one to this tab.
      </p>
    ),
    manualSection: 'plans-library',
  },
  'plan.move': {
    title: 'Move plan to another project',
    body: (
      <p>
        Relocates the plan's <C>.md</C> file from the current tab's project
        directory to a different one. Pick from the list of other open
        tabs, or paste an absolute path. Plan id is preserved; attachments
        in the source cwd are dropped (they refer to a workflow that won't
        exist at the destination). The source tab's PLAN tab clears once
        the move completes.
      </p>
    ),
  },
  'plan.mark-complete': {
    title: 'Mark complete',
    body: (
      <p>
        Archives the plan and auto-detaches it from any attached workflows.
        Lives in the completed list (toggle to view); reopenable if needed.
      </p>
    ),
  },
  'plan.delete': {
    title: 'Delete plan',
    body: (
      <p>
        Permanently deletes the plan file from disk. Confirmation required.
        Use <C>MARK COMPLETE</C> instead if you want to keep the history.
      </p>
    ),
  },
  // -------------------------------------------------------- CHAT SURFACES
  'chat.message.system': {
    title: 'System notice',
    body: (
      <p>
        Out-of-band status from the server — rate-limit warnings, retry
        backoffs, calibration completion, threshold crossings, the
        concurrent-writer guard, etc. Italic, dimmer than chat messages.
      </p>
    ),
  },
  'chat.seed-pill.handoff': {
    title: 'Handoff seed',
    body: (
      <p>
        The first user message in a handoff-rotated session, carrying the
        handoff document. Collapsed to a one-line pill so a 300-line
        document doesn't fill the chat. Click to expand the full body.
      </p>
    ),
    manualSection: 'handoff-action',
  },
  'chat.seed-pill.spawn': {
    title: 'Spawn seed',
    body: (
      <p>
        The first user message in a spawned tab, carrying the parent's
        reflection + your "new direction" if you supplied one. Same one-line
        pill as Handoff seeds.
      </p>
    ),
    manualSection: 'spawn-action',
  },
  'chat.load-earlier': {
    title: 'Load earlier messages',
    body: (
      <p>
        Chat hydrates tail-first — the last 200 messages are visible on
        first open. Click here to page further back. Scroll position is
        preserved across loads.
      </p>
    ),
  },
  'chat.jump-to-bottom': {
    title: 'Jump to latest',
    body: (
      <p>
        Appears when you've scrolled up. Click to snap back to the most
        recent message. Auto-hides once you're already at the bottom.
      </p>
    ),
  },
  'chat.prior-sessions': {
    title: 'Prior sessions',
    body: (
      <p>
        Collapsed history of earlier sessions in this tab — every Handoff
        creates a new session, and the old ones live behind this toggle.
        Click to expand and see the chat from those sessions inline.
      </p>
    ),
  },
  'chat.conversation-menu': {
    title: 'Conversation menu',
    body: (
      <>
        <p>Per-tab actions:</p>
        <ul style={{ margin: '4px 0', paddingLeft: '18px' }}>
          <li><strong>NEW</strong> — start a fresh session in this tab (current archived to history).</li>
          <li><strong>RESUME</strong> — pick a different session for this cwd. Rows show the
            session title, subtitle (where it left off), provider/account tag and last-active.
            Each row can be <strong>pinned</strong> (★, sorts to top), <strong>renamed</strong> (✎,
            a manual title that wins over the auto-generated one and survives refreshes), or
            <strong>archived</strong> (⊘, hidden behind the ARCH toggle).</li>
          <li><strong>EXPORT</strong> — write the rendered transcript to a markdown file.</li>
        </ul>
        <p>Disabled while a turn is in flight — cancel first.</p>
      </>
    ),
  },
  'chat.resume-filter': {
    title: 'Filter sessions',
    body: (
      <p>
        Live-filters the resume list by title, subtitle, or provider tag. Pinned
        sessions still sort to the top of the matches. Archived sessions stay hidden
        unless the <C>ARCH</C> toggle is on.
      </p>
    ),
  },
  // -------------------------------------------------------- GIT DIALOG
  'gitdialog.diff-preview': {
    title: 'Working-tree diff preview',
    body: (
      <p>
        Expands the exact <C>git diff</C> vs <C>HEAD</C> for this repo so you
        can confirm what's about to be committed before dispatching the GIT
        prompt. Collapsed by default; per-file with a <C>UNIFIED</C> /{' '}
        <C>SPLIT</C> toggle. Same renderer as the Files <C>CHANGES</C> sub-tab.
      </p>
    ),
    manualSection: 'changes-diff',
  },
  // -------------------------------------------------------- FILES VIEW
  'files.refresh': {
    title: 'Refresh file tree',
    body: (
      <p>
        Re-reads the cwd from disk. Useful after the agent ran a command
        that created or moved files outside Arco's view (e.g. shell-out
        `git checkout`).
      </p>
    ),
  },
  'files.open-terminal': {
    title: 'Open terminal here',
    body: (
      <p>
        Opens the floating terminal in this folder (the Files root). You can
        also <strong>right-click any directory</strong> in the tree to root a
        terminal there. The shell outlives the window — closing detaches,
        reopening re-attaches. Operator-only; never an agent surface. See "The
        integrated terminal".
      </p>
    ),
    manualSection: 'integrated-terminal',
  },
  'terminal.kill': {
    title: 'Kill the shell',
    body: (
      <p>
        Ends the PTY session — the process tree, not just the window. This is
        the <em>only</em> action that stops a session (closing the window just
        detaches; the shell keeps running). The terminal's <em>commands'</em>{' '}
        effects are yours, as in any shell — Arco does not sandbox the operator.
      </p>
    ),
    manualSection: 'integrated-terminal',
  },
  'terminal.new': {
    title: 'New shell session',
    body: (
      <p>
        Opens a <strong>fresh</strong> shell session in a new floating window
        (§K2 — several sessions per workflow: a dev server in one, commands in
        another). Unlike the header / Files launchers, this always spawns a new
        session rather than re-attaching the existing one. Each session outlives
        its window; only <em>Kill</em> ends it.
      </p>
    ),
    manualSection: 'integrated-terminal',
  },
  'terminal.popout': {
    title: 'Pop out',
    body: (
      <p>
        Detaches this shell into its own OS-level browser window (drag it to a
        second monitor / tile it). The pop-out attaches to the{' '}
        <em>same live session</em> — typing in either window drives the same
        shell (§K2 multi-listener). It never spawns a new session, and closing
        the pop-out just detaches that view; the shell keeps running until you{' '}
        <em>Kill</em> it. This in-app window stays open too. The session is gone
        if the server restarts (PTYs don't survive one).
      </p>
    ),
    manualSection: 'integrated-terminal',
  },
  'terminal.switcher': {
    title: 'Session switcher',
    body: (
      <p>
        Picks which shell session this window views. Sessions are
        workflow-scoped, long-lived resources; two windows may point at the same
        session (both render the same live output). The list survives a client
        reconnect — the server re-sends it on rehydrate.
      </p>
    ),
    manualSection: 'integrated-terminal',
  },
  'terminal.send-to-composer': {
    title: 'Send to composer',
    body: (
      <p>
        Inserts the <em>selected</em> terminal output into this workflow's
        composer as a quoted block (a fenced dump under a{' '}
        <C>Terminal output:</C> header). Enabled only when text is selected. It{' '}
        <em>appends</em> to whatever you were already typing — it never clobbers
        the draft — and it is <em>inserted, not sent</em>: you still press send.
        This is the operator-only bridge for "here's the stack trace I just got"
        without giving the agent terminal control or auto-feeding it output.
      </p>
    ),
    manualSection: 'integrated-terminal',
  },
  'chat.run-in-terminal': {
    title: 'Run in terminal',
    body: (
      <p>
        Appears on shell code blocks (<C>bash</C> / <C>sh</C> /{' '}
        <C>shell</C> / <C>console</C> / <C>zsh</C>) in an
        agent's reply. Clicking it opens the floating terminal for this workflow
        and <strong>pre-fills the command on the prompt — it does NOT run it</strong>.
        You review and edit it, then press Enter yourself. The agent only{' '}
        <em>suggested</em> the command; nothing executes without your keystroke.
        Operator-in-the-loop by design.
      </p>
    ),
    manualSection: 'integrated-terminal',
  },
  'fileviewer.toggle-raw': {
    title: 'Raw / Formatted toggle',
    body: (
      <p>
        Switches between syntax-highlighted view and the raw file bytes.
        Formatted is the default for code/markdown; raw is useful when
        you suspect the file's actual content differs from what the
        renderer shows (encoding issues, BOM markers, etc.).
      </p>
    ),
    manualSection: 'help-system',
  },
  'fileviewer.toggle-edit': {
    title: 'Edit / Lock toggle',
    body: (
      <p>
        Files open <strong>Locked</strong> (read-only) by default so you can't
        modify one by accident. Click <strong>EDIT</strong> to make the buffer
        writable in a CodeMirror editor; a <strong>SAVE</strong> button appears
        and an <strong>● UNSAVED</strong> marker shows once you've typed. Save
        writes the file (path-escape guarded server-side) and flips back to
        Locked; <strong>LOCK</strong> discards edits and returns to the viewer.
        Closing with unsaved edits asks first. Only shown for text files opened
        from the FILES explorer.
      </p>
    ),
    manualSection: 'editing-a-file',
  },
  // -------------------------------------------------------- AI-EDIT (A7)
  'aiedit.ask': {
    title: 'Ask AI (scoped edit)',
    body: (
      <p>
        Select a region in the editor (or use <strong>SELECT ALL</strong> for a
        whole-doc edit), then click this to ask an AI agent to rewrite{' '}
        <em>just that selection</em>. You type an instruction and pick the agent
        with the RUN AS picker; the agent proposes a replacement you preview as a
        diff. The agent has no write access — Accept changes the buffer only, and
        the existing SAVE is the only thing that writes to disk.
      </p>
    ),
    manualSection: 'ai-edit',
  },
  'aiedit.selectall': {
    title: 'Select all (whole-doc edit)',
    body: (
      <p>
        Selects the entire document so an <strong>✦ ASK AI</strong> request
        rewrites the whole file (e.g. "fix all formatting/spelling"). Otherwise
        the edit is scoped to whatever you highlighted.
      </p>
    ),
    manualSection: 'ai-edit',
  },
  'aiedit.instruction': {
    title: 'Edit instruction',
    body: (
      <p>
        What you want the agent to do to the selection — "tighten this
        paragraph", "fix the formatting", "rewrite in my voice". One bounded turn
        per proposal; no back-and-forth loop. The agent returns text only.
      </p>
    ),
    manualSection: 'ai-edit',
  },
  'aiedit.accept': {
    title: 'Accept proposal',
    body: (
      <p>
        Splices the agent's proposed replacement into the editor{' '}
        <strong>buffer</strong> at exactly the selected range — nothing on disk
        yet. The existing <strong>SAVE</strong> button persists it through the
        path-guarded write endpoint. Reversible: Reject before Accept, and the
        save itself is checkpoint-covered.
      </p>
    ),
    manualSection: 'ai-edit',
  },
  'aiedit.reject': {
    title: 'Reject proposal',
    body: (
      <p>
        Discards the proposed replacement and leaves the buffer untouched. Select
        a different region or revise the instruction and try again.
      </p>
    ),
    manualSection: 'ai-edit',
  },
  // -------------------------------------------------------- ACTIVITY VIEW
  'activity.worker-card': {
    title: 'Worker card',
    body: (
      <p>
        One short-lived worker process spawned by a primitive (reviewer,
        handoff summarizer, primary turn). Shows status, last tool, model.
        Click to open the detailed view with full output and event log.
      </p>
    ),
  },
  // -------------------------------------------------- SHORTCUT CHEAT SHEET
  'shortcuts.cheatsheet.close': {
    title: 'Close the cheat sheet',
    body: (
      <p>
        Dismisses the keyboard-shortcut cheat sheet. Open it any time with{' '}
        <C>Ctrl/Cmd+?</C> (or the <C>Keyboard shortcuts</C> command in the
        palette); <C>Esc</C> also closes it. The list is read-only — a
        documentation surface, not the handlers themselves.
      </p>
    ),
    manualSection: 'shortcuts',
  },
  // ------------------------------------------------- SYSTEM MODAL / DIAGNOSTICS
  'system.tab.actions': {
    title: 'System · Actions',
    body: (
      <p>
        Lifecycle controls for the Arco server: <C>RESTART</C> (stop + come
        back up; this tab reconnects automatically) and <C>QUIT</C> (stop the
        server and close the tab). Both confirm first, and warn if workflows are
        running.
      </p>
    ),
    manualSection: 'diagnostics',
  },
  'system.tab.diagnostics': {
    title: 'System · Diagnostics',
    body: (
      <p>
        Grouped, read-only status checks answering "what's actually working on
        this machine?" — Core, Providers, Local Tools, Workbench, Storage. Each
        row expands to a detail line + remediation hint. Operator-triggered: the
        report runs on open and on <C>↻ REFRESH</C>, never on a timer.
      </p>
    ),
    manualSection: 'diagnostics',
  },
  'diagnostics.refresh': {
    title: 'Refresh diagnostics',
    body: (
      <p>
        Re-runs every diagnostic probe and replaces the report. Each probe is a
        deterministic, read-only check (a version flag, a directory round-trip, a
        daemon ping); nothing here mutates state. Probes run concurrently and are
        individually time-bounded, so one slow binary can't hang the panel.
      </p>
    ),
    manualSection: 'diagnostics',
  },
  'diagnostics.check-row': {
    title: 'Diagnostic check',
    body: (
      <p>
        One probe result. The glyph + status colour is the verdict —{' '}
        <strong>OK</strong> (green) the thing works, <strong>WARN</strong>{' '}
        (amber) degraded or an optional dependency is absent,{' '}
        <strong>ERROR</strong> (red) something that should work doesn't,{' '}
        <strong>SKIPPED</strong> (grey) not probed on this platform/config. Click
        to expand the detail line, any remediation hint, and the check id.
      </p>
    ),
    manualSection: 'diagnostics',
  },
  'diagnostics.support-bundle': {
    title: 'Copy support bundle',
    body: (
      <p>
        Copies a paste-ready, <strong>redacted</strong> snapshot of this machine
        — the diagnostics report + Arco version / git rev / platform / runtime
        — to the clipboard, ready to drop in an issue or hand to another agent.
        Built from a safe-field <em>allowlist</em>: home paths collapse to{' '}
        <C>~</C> and a secret-scrub strips any token-shaped string. It contains{' '}
        <strong>no</strong> tokens, env secrets, or private paths. If the
        clipboard is blocked, the text appears in a selectable box to copy by
        hand.
      </p>
    ),
    manualSection: 'diagnostics',
  },
  'system.tab.model-health': {
    title: 'System · Model Health',
    body: (
      <p>
        A model-operator readout answering "what can I run now / what's running /
        what failed last time / is my config stale?". Three subsystems —{' '}
        <strong>Ollama</strong>, <strong>llama.cpp</strong>, and{' '}
        <strong>Cookbook</strong> — each with a roll-up status and concrete
        fields. Read-only and operator-triggered: it fetches on open and on{' '}
        <C>↻ REFRESH</C>, never on a timer, and never spawns a model.
      </p>
    ),
    manualSection: 'diagnostics',
  },
  'model-health.refresh': {
    title: 'Refresh model health',
    body: (
      <p>
        Re-runs the three subsystem probes (Ollama daemon ping + tags, the
        llama.cpp lifecycle-manager snapshot + catalog + log tail, the Cookbook
        hardware probe + fit scoring). All read-only; one failing subsystem
        degrades to a <strong>WARN</strong> sub-report rather than blanking the
        panel.
      </p>
    ),
    manualSection: 'diagnostics',
  },
  'model-health.ollama': {
    title: 'Ollama health',
    body: (
      <p>
        The Ollama daemon: resolved base URL, whether it's reachable, the
        installed-model count + names (with tools/vision/thinking capability
        hints), and the server version when cheaply available. A daemon that
        isn't running is a <strong>WARN</strong>, not an error — you may simply
        not use Ollama.
      </p>
    ),
    manualSection: 'diagnostics',
  },
  'model-health.llamacpp': {
    title: 'llama.cpp health',
    body: (
      <p>
        The llama.cpp lifecycle manager: the <C>llama-server</C> binary path,
        registered loadouts (from <C>~/.archon/llamacpp.json</C>), the manager
        state (idle/loading/ready/failed), the currently-loaded alias + port +
        pid, the <strong>last launch args</strong>, and a tail of the last
        <C> ~/.archon/llamacpp.log</C> stderr. A failed last launch is the one
        <strong> ERROR</strong> case; the stderr tail is where to look.
      </p>
    ),
    manualSection: 'diagnostics',
  },
  'model-health.cookbook': {
    title: 'Cookbook health',
    body: (
      <p>
        The detected hardware profile (backend / VRAM / RAM / cores / GPUs), the
        GGUFs downloaded under <C>~/.archon/models</C>, and{' '}
        <strong>fit-score mismatch warnings</strong> — registered llama.cpp
        loadouts that won't fit this hardware on GPU at a useful context (scored
        with the same engine the Cookbook catalog uses). A mismatch is an
        actionable <strong>WARN</strong> with a hint, never an error.
      </p>
    ),
    manualSection: 'diagnostics',
  },
  'model-health.llamacpp-diagnosis': {
    title: 'llama.cpp serve-failure diagnosis',
    body: (
      <p>
        Appears when the last <C>llama-server</C> launch failed. Arco
        classifies the stderr against an ordered registry of known causes
        (port-in-use, OOM, ctx-too-large, gguf-missing, unsupported-arch, …) and
        shows the matched <strong>cause</strong>, a plain-language explanation,
        and concrete <em>suggestions</em>. Read-only diagnosis; only the
        one-click <strong>fix</strong> buttons below it mutate config.
      </p>
    ),
    manualSection: 'diagnostics',
  },
  'model-health.llamacpp-fix': {
    title: 'Apply one-click fix',
    body: (
      <p>
        A concrete remediation derived from the diagnosed cause — e.g. halve the
        context size, offload fewer GPU layers, or add an{' '}
        <C>--port</C>/<C>extraArgs</C> flag. Each button writes that change to
        the loaded loadout's catalog entry and reloads <C>llama-server</C>.
        Disabled when no alias is currently loaded — apply it by hand in
        CONFIG → llama.cpp instead.
      </p>
    ),
    manualSection: 'diagnostics',
  },
  // ----------------------------------------------------- SYSTEM · SERVICES
  'system.tab.services': {
    title: 'System · Services',
    body: (
      <>
        <p>
          Machine-wide browser of the local web/dev services running right now —
          every listening TCP socket mapped to its process / cwd / framework.
          Compact rows: framework emoji, friendly name, <C>:port</C>, process,
          pid. Hover a row for its working directory; click to expand the full
          cmdline / cwd / pid / host and the action set. Backed by the read-only{' '}
          <C>GET /api/services</C>; refreshed on open + a bounded ~5s auto-poll
          while the tab is open.
        </p>
        <p>
          It lives here (not the right panel) because it's project-agnostic —
          the same list regardless of which workflow is focused. Pinned services
          float to the top and survive restarts (global settings, keyed by{' '}
          <C>cwd + port</C>); a pinned-but-stopped service shows as a dimmed{' '}
          <C>OFFLINE</C> row.
        </p>
      </>
    ),
    manualSection: 'diagnostics',
  },
  'services.refresh': {
    title: 'REFRESH',
    body: <p>Re-scan listening sockets now — pick up services that started or stopped since the last poll.</p>,
  },
  'services.webonly': {
    title: 'Web-only filter',
    body: <p>Toggle between web/dev services only (<C>WEB</C>, the default) and every local listener (<C>ALL</C>). Local UI state, not persisted.</p>,
  },
  'services.health': {
    title: 'Health probe',
    body: (
      <p>
        Toggle per-service liveness dots — <C>OFF</C> by default because probing
        spawns a network request to each listed port. When armed, each row's port
        is probed via <C>GET /api/preview/probe</C> on every poll tick: a green dot
        means responding, red means not responding, dim means probing. Local UI
        state, not persisted.
      </p>
    ),
  },
  'services.preview': {
    title: 'Open in Live Preview',
    body: (
      <p>
        Bind this service's port to the <em>focused</em> workflow's preview proxy
        (<C>set_preview_port</C>) and switch that workflow's right panel to{' '}
        <C>PREVIEW</C>. Disabled for an offline (pinned-not-running) service or when
        no workflow tab is focused — focus a workflow tab to preview there.
      </p>
    ),
  },
  'services.open': {
    title: 'OPEN',
    body: <p>Open the service's URL (<C>http://localhost:&lt;port&gt;/</C>) in a new browser tab.</p>,
  },
  'services.copy': {
    title: 'COPY URL',
    body: <p>Copy the service's <C>http://localhost:&lt;port&gt;/</C> URL to the clipboard.</p>,
  },
  'services.pin': {
    title: 'PIN / UNPIN',
    body: <p>Pin a service to the machine-level inventory (global settings, keyed by <C>cwd + port</C>) so it stays listed across restarts — a pinned-but-stopped service shows as an offline row. UNPIN removes it.</p>,
  },
  'services.kill': {
    title: 'KILL',
    body: (
      <p>
        Send <C>SIGTERM</C> — a graceful terminate — to the service's process via{' '}
        <C>DELETE /api/services/:pid</C>. Two-step: the first click arms a{' '}
        <C>CONFIRM?</C> button. The server re-scans and only signals a pid that
        currently owns a listening socket (and never the Arco server itself).
        SIGTERM only — there is <em>no</em> SIGKILL escalation; a process that
        ignores SIGTERM keeps running.
      </p>
    ),
    manualSection: 'diagnostics',
  },
  // ----------------------------------------------------- HELP SYSTEM SELF
  'help.toggle': {
    title: 'Contextual help mode',
    body: (
      <>
        <p>
          When active, click any highlighted element to read what it does. Each
          popover may link into the full Manual for deeper coverage.
        </p>
        <p>
          Press <C>Esc</C> or click the <C>?</C> again to exit.
        </p>
      </>
    ),
    manualSection: 'help-system',
  },
};
