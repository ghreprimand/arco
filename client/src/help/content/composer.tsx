import { C } from './shared';
import type { HelpEntry } from './shared';

export const composerHelp: Record<string, HelpEntry> = {
  // ---------------------------------------------------------------- COMPOSER
  'composer.input': {
    title: 'Composer',
    body: (
      <>
        <p>
          Type your prompt and click <strong>SEND</strong> or press <C>Enter</C> to send. <C>Shift+Enter</C> for
          a newline, <C>Ctrl+K</C> to kill to end of line. Drop or paste
          attachments (images go native on Claude; others are referenced by
          path). <C>/goal …</C> sets the north star or arms a goal run without
          sending a turn.
        </p>
        <p>
          While the agent is busy, the composer routes to a queue:{' '}
          <C>Enter</C> queues as <strong>steer</strong> (do this now);{' '}
          <C>Alt+Enter</C> queues as <strong>follow-up</strong> (after the
          current task). For Claude and Codex, <C>Ctrl/Cmd+Enter</C> interrupts
          and sends immediately after cancellation settles. <C>Alt+↑</C> recalls the most recent queued message;{' '}
          <C>Esc</C> cancels the turn (asks before dropping queued messages;{' '}
          <C>Shift+Esc</C> skips the prompt).
        </p>
      </>
    ),
    manualSection: 'composer',
  },
  'composer.send': {
    title: 'Send normally',
    body: <p>Same as <C>Enter</C>: starts a turn when idle, or steers the running
      agent at its next supported input boundary. Use <strong>INTERRUPT &amp; SEND</strong>
      {' '}to stop the current turn and deliver the draft next.</p>,
    manualSection: 'composer',
  },
  'composer.interrupt': {
    title: 'Interrupt & send',
    body: <p>Interrupts the active Claude or Codex turn, then sends your draft in
      the same conversation. <C>Ctrl/Cmd+Enter</C> does the same. Earlier queued
      messages run afterward; completed edits remain in place.</p>,
    manualSection: 'composer',
  },
  'composer.cancel': {
    title: 'Cancel turn',
    body: (
      <p>
        Stops the active turn. The server unconditionally fires{' '}
        <C>turn_cancelled</C> + <C>primary_turn_ended</C>, which unsticks the UI
        even if the worker has gone "ghost" (silently exited mid-turn).
      </p>
    ),
    manualSection: 'recovery',
  },
  'composer.attach': {
    title: 'Attach file',
    body: (
      <p>
        Add a file to your next message. Images ride as native content blocks
        on Claude; other files are appended as <C>[file: &lt;path&gt;]</C>{' '}
        references in the prompt text.
      </p>
    ),
  },
  'composer.remote': {
    title: 'Remote monitoring',
    body: (
      <>
        <p>
          Opt this workflow in to the management hub. <strong>Off by default.</strong>{' '}
          When on (<C>◉ REMOTE</C>), the workflow appears in the tailnet console
          (your phone), can carry an ongoing conversation, and exposes the bounded
          stop / handoff / compact / fold / queue / parked-question controls.
          When off, it's invisible to the hub and silent — no remote control, no
          notifications.
        </p>
        <p>
          Only shown when this instance is hub-linked (the <C>HUB</C> chip is
          present). The header's <C>N monitored</C> count is the number of
          workflows currently opted in. Cluster members instead follow the
          cluster-level <C>◉ REMOTE</C> switch; their individual setting is ignored
          while clustered.
        </p>
      </>
    ),
    manualSection: 'remote',
  },
  'composer.remote-gates': {
    title: 'Remote gate approvals',
    body: (
      <>
        <p>
          Second arming on top of <C>◉ REMOTE</C>: allow parked review gates
          (REVIEW SAFE-MODE) to be <strong>approved or rejected from the phone
          console</strong>. <strong>Off by default</strong> — remote conversation
          never implies remote approval authority.
        </p>
        <p>
          When off (<C>⛨ GATES: DESK</C>), the console still shows pending gates
          but read-only, labeled "resolve at desk". Only rendered when the
          workflow is remote-shared AND review safe-mode is on. Remote approvals
          run the proposed call <em>as-is</em> — argument editing stays a desktop
          action.
        </p>
      </>
    ),
    manualSection: 'remote',
  },
  'composer.compact': {
    manualSection: 'provider-recovery',
    title: 'Native compact',
    body: (
      <>
        <p>
          <C>⊟ COMPACT</C> is the in-Arco equivalent of the provider CLI's{' '}
          <C>/compact</C> — it summarizes the conversation so the next turn
          starts against a smaller prompt. Far cheaper than a Handoff (same tab,
          no portable doc, no fresh worker); Handoff stays the heavier escape
          hatch for a clean break or a provider swap.
        </p>
        <p>
          <strong>Codex (app-server):</strong> fires Codex's native{' '}
          <C>thread/compact/start</C>; Codex summarizes earlier history into its
          rollout server-side. Arco stays locked until the compact turn actually
          completes, not merely until its summary arrives. Large threads can take
          several minutes. A 10-minute ceiling is a visible failure that recycles
          the worker, never a success. On success the stale <C>CTX</C> signal is
          cleared until the next provider snapshot.
        </p>
        <p>
          <strong>Claude (native):</strong> runs one summarization round, then
          replaces the worker's in-memory history with the summary and continues
          in the same tab. The summary is persisted so it survives a reload.
        </p>
        <p>
          <strong>Cursor (ACP):</strong> sends Cursor's native <C>/compress</C>{' '}
          command as an isolated ACP prompt. Arco deliberately omits the normal
          cluster, north-star, and standing-context prefix so Cursor recognizes
          the command instead of treating it as an ordinary request. Typing{' '}
          <C>/compress</C> in the composer routes through this same safe path.
        </p>
        <p>
          Shown only on Codex-app-server, Cursor, Claude-native, and Ollama
          tabs. Runs between turns — disabled while a turn is in flight.
        </p>
      </>
    ),
  },
  'composer.compact-continue': {
    title: 'Continue after compaction',
    body: (
      <>
        <p>
          <C>▸ CONTINUE</C> appears after a Claude-native compaction folds the
          conversation into a summary. Click it to resume the work from the
          compacted seed — it sends a short continuance prompt so the model
          picks the task back up against the smaller context. The <C>×</C>
          dismisses it without resuming.
        </p>
        <p>
          Resume is manual by default: between-turn compaction has already ended
          the operator turn, so Arco does not auto-continue. Turn on{' '}
          <C>COMPACTION AUTO-CONTINUE</C> in CONFIG to have the continuance
          prompt fire automatically instead.
        </p>
      </>
    ),
  },
  'composer.context-refs': {
    title: 'Context refs',
    body: (
      <>
        <p>
          Type an <C>@</C>-ref inline and Arco expands it into the turn's
          context at send time (server-side): <C>@file:src/x.ts</C> (file
          contents, bounded + truncated with a notice past 64 KB),{' '}
          <C>@diff</C> / <C>@staged</C> (<C>git diff [--cached]</C>),{' '}
          <C>@git:3</C> (last N commits, capped at 50).
        </p>
        <p>
          Each ref shows a chip with a <C>×</C> to remove it. Your chat message
          stays compact (the raw <C>@file:…</C> text); the expanded blocks ride
          the model prompt under a <C>--- Context (…) ---</C> header and are
          logged to the event stream. <C>@url:…</C> is recognized but{' '}
          <strong>not yet supported</strong> (it expands to a deferral notice —
          a safe SSRF-guarded fetch is a separate sub-phase).
        </p>
      </>
    ),
  },
  'composer.plan': {
    title: 'Plan button',
    body: (
      <p>
        Draft a plan for this workflow. The plan body re-injects on every turn
        so the agent stays oriented. Two modes: <em>Draft → I'll review</em>{' '}
        (manual save) or <em>Draft &amp; auto-save</em>. This is the reliable
        path — it saves and attaches for you. You can also just ask the agent
        in prose ("create a plan and attach it to this workflow"): every
        plan-less turn now carries the create+attach endpoint and the required
        body shape, so the agent can do it itself instead of writing a loose
        markdown file that Arco never sees.
      </p>
    ),
    manualSection: 'plan-creation',
  },
  'composer.north-star': {
    title: 'North star',
    body: (
      <>
        <p>
          A standing, always-visible objective for this tab. Click the strip to
          edit in place — <C>Enter</C> saves, <C>Esc</C> cancels. Empty shows a
          muted <C>set a north-star…</C> affordance. You can also set it from the
          CONFIG tab's <C>NORTH STAR</C> field or with <C>/goal &lt;text&gt;</C> in
          the composer (<C>/goal clear</C> removes it); all three write the same
          value.
        </p>
        <p>
          Once set, it folds into the system prompt on <strong>every turn</strong>{' '}
          so the agent stays oriented on the ultimate goal. Operator-only write,
          model read-only. Capped at 2048 bytes (soft-warns past 1536). Pure
          context — it carries no model authority and grants no autonomy.
        </p>
        <p>
          <strong>Goal run.</strong> By itself a north star only steers what the
          agent does inside turns <em>you</em> start. To have Arco keep the tab
          moving toward it, arm a goal run: <C>/goal run 10</C> dispatches one
          automatic continuation turn after each settled turn, for up to ten
          iterations. <C>/goal run</C> shows status, <C>/goal run stop</C> stops
          it, and while a run is armed a <C>RUN n/N</C> chip with the running
          token spend appears on this strip — click it to stop.
        </p>
        <p>
          A run also stops on its own if a turn errors, the provider is
          rate-limited, context passes 92%, or the north star is cleared. Every
          iteration is an ordinary visible turn in the transcript, and a server
          restart ends any armed run. Sending your own message mid-run does not
          stop it, so you can steer without re-arming.
        </p>
      </>
    ),
  },
  'composer.docs': {
    title: 'DOCS button',
    body: (
      <>
        <p>
          Sends the agent a structured prompt to update repo markdown docs (README,
          DEVLOG, CLAUDE.md, <C>docs/**/*.md</C>) based on recent git activity.
          Hard-coded constraint: <strong>does not modify anything under{' '}
          <C>.arco/plans/</C></strong> — plan files have load-bearing structure
          the Plan tab parses for per-phase review.
        </p>
        <p>
          Optional operator note appended verbatim. The dialog has a RUN AS picker
          to dispatch in-tab or to a freshly spawned new tab under a different
          model.
        </p>
      </>
    ),
    manualSection: 'composer-docs',
  },
  'composer.git': {
    title: 'GIT button',
    body: (
      <>
        <p>
          Live git status, branch picker (with <C>+ NEW BRANCH</C>), action picker
          (commit / +push / +PR via <C>gh pr create</C>), protected-branch
          warnings, per-repo localStorage prefs. Branch switch dispatches
          server-side <em>before</em> the agent prompt; refuses on dirty trees.
        </p>
        <p>
          Builds a structured prompt with branch context, action steps, pause-and-ask
          rules, and expected deliverables. RUN AS picker to escalate to a different
          model in a new tab.
        </p>
      </>
    ),
    manualSection: 'composer-git',
  },
  'composer.tuneup': {
    title: 'TUNE MD button',
    body: (
      <p>
        Opens the agent-instruction tune-up flow for files like{' '}
        <C>CLAUDE.md</C>, <C>AGENTS.md</C>, and <C>GEMINI.md</C>. Arco
        proposes a tightened diff; you approve it, and the original is backed
        up before writing.
      </p>
    ),
    manualSection: 'composer',
  },
  'composer.research': {
    title: 'RESEARCH button',
    body: (
      <>
        <p>
          Runs a bounded Deep Research turn: the agent plans web-search queries,
          searches, reads results, and writes a <strong>cited markdown report</strong>{' '}
          into the RESEARCH tab. One bounded turn — the round cap is a hard ceiling
          on web-search rounds (mechanical on Claude Native via the web-tool{' '}
          <C>max_uses</C> budget; prompt-stated on Codex, which exposes no per-turn
          cap). The model's "sufficient" signal is advisory.
        </p>
        <p>
          Agent-agnostic (Claude / Codex / Ollama / llama.cpp). RUN AS picker
          dispatches in-tab or to a freshly spawned new tab. Open a finished report
          and use <em>DIG DEEPER</em> to append a cited addendum without re-running
          the whole search.
        </p>
      </>
    ),
    manualSection: 'composer-research',
  },
  'composer.research.topic': {
    title: 'Research topic',
    body: (
      <p>
        The research question or brief. Be specific — the agent plans its queries
        from this. Required.
      </p>
    ),
  },
  'composer.research.rounds': {
    title: 'Round cap',
    body: (
      <p>
        Hard ceiling on web-search rounds (clamped <C>1–10</C>, default <C>4</C>).
        Enforced mechanically on Claude Native (web-tool <C>max_uses</C>); on Codex
        it is stated in the prompt as the non-negotiable stop.
      </p>
    ),
  },
  'composer.compare': {
    title: 'COMPARE button',
    body: (
      <>
        <p>
          Race ONE prompt across 2–6 providers side-by-side. Each leg is a fresh,{' '}
          <strong>read-only, no-tools</strong> run with <em>no shared session</em> —
          the legs never see each other and never touch disk. Answers stream into
          their own panes.
        </p>
        <p>
          Optionally <strong>blind</strong> the labels until you vote a winner, then
          have one leg synthesize a combined answer. The winner is always{' '}
          <em>your</em> vote — nothing auto-picks, no LLM judges. No cost framing:
          "cheap" here means tool-free.
        </p>
      </>
    ),
    manualSection: 'composer-compare',
  },
  'composer.compare.prompt': {
    title: 'Compare prompt',
    body: (
      <p>
        The single prompt every leg answers. Required. Each leg sees only this — no
        transcript, no other leg's output.
      </p>
    ),
  },
  'composer.run-as': {
    title: 'RUN AS picker',
    body: (
      <>
        <p>
          In the GIT and DOCS dialogs. Override the current tab's primary
          provider/model/effort for the one-off prompt:
        </p>
        <ul style={{ paddingLeft: '16px', margin: '4px 0' }}>
          <li>Same as tab's primary → dispatches in-tab as a regular turn.</li>
          <li>
            Different → spawns a new tab with that config and runs the work there;
            current chat untouched.
          </li>
        </ul>
        <p>
          Useful when a local model is doing the actual coding but you want a
          frontier model for the git/docs sweep.
        </p>
      </>
    ),
    manualSection: 'run-as-picker',
  },
  'composer.footer.ctx': {
    title: 'Context fill',
    body: (
      <>
        <p>
          Estimated context-window usage. <C>●</C> = ground-truth (reported by
          provider or calibrated locally), <C>○</C> = estimate.
        </p>
        <p>
          Click here to recalibrate on demand (Claude only — runs <C>/context</C>{' '}
          against the live session via a background pty).
        </p>
      </>
    ),
    manualSection: 'context-window',
  },
  'composer.questions': {
    title: 'Pending agent questions',
    body: <p>Open questions from Codex app-server without scrolling back through the transcript. Pick an option or type an answer, then SEND ANSWERS. Blocking questions wait for you; async questions let the agent continue. Cancelled or expired questions cannot be answered.</p>,
    manualSection: 'provider-codex',
  },
  'composer.footer.tokens': {
    title: 'Cumulative output',
    body: (
      <p>
        Total output tokens generated across this workflow (<C>↑ OUT</C>),
        accumulated turn over turn. Distinct from the CTX fill to its left,
        which tracks the live context-window usage for the next turn.
      </p>
    ),
    manualSection: 'token-tracking',
  },
  'composer.footer.speed': {
    title: 'Local generation speed', manualSection: 'token-tracking',
    body: <p>Ollama/Strata engine timings for the last completed turn. tok/s is
      decode; PP is fresh prompt prefill. Hover for counts and durations.
      Tokens/time are summed across tool rounds; cached prompt prefixes are
      excluded from fresh prefill, and loading, tool and network time are
      excluded from these rates. Missing timings show no readout.</p>,
  },
  'composer.footer.model': {
    title: 'Current model & effort',
    body: (
      <>
        <p>
          The model + effort used for the next turn. Live-editable from the
          CONFIG tab on the right pane <em>or</em> by clicking the chip
          itself — both surfaces open the same picker. Claude reads from the
          live Anthropic <C>/v1/models</C> catalog; Codex reads from the live
          <C>codex app-server model/list</C> catalog. Both refresh hourly,
          with per-model effort gating against the catalog's reported support.
          Codex pills show each model's one-line description on hover. Takes
          effect on the next turn; same-provider swaps don't rotate the session.
          Strata lists prepared Original/SC117 profiles: one is resident at a
          time, and the next message loads your selection after the current
          Strata turn and its tools finish.
          Provider swaps need a Handoff because the CLI session UUID is
          provider-specific.
        </p>
      </>
    ),
    manualSection: 'live-config-swap',
  },
  'composer.plan-cluster-member': {
    title: 'Cluster member — autosave routes through banner',
    body: (
      <p>
        Cluster members never auto-attach plans. Clicking{' '}
        <C>DRAFT &amp; AUTO-SAVE</C> here lands on the same PlanCandidateBanner
        as <C>DRAFT → I'LL REVIEW</C> so you can pick{' '}
        <C>SAVE &amp; ATTACH TO WORKER</C>, <C>ATTACH TO CLUSTER</C>, or{' '}
        <C>DISCARD</C>. The Native <C>EnterPlanMode</C> tool routes through
        the same banner.
      </p>
    ),
    manualSection: 'cluster-attach-from-banner',
  },
  'composer.fold': {
    title: 'Fold transcript',
    body: (
      <>
        <p>
          <C>⊞ FOLD</C> deterministically trims older history into a digest and
          keeps a verbatim recent tail — same session, instantly, with{' '}
          <strong>no model round</strong>. Cheaper than <C>⊟ COMPACT</C> (which
          spends a summarization call) and far cheaper than a Handoff (no fresh
          worker).
        </p>
        <p>
          The raw transcript stays intact in <C>events.jsonl</C>; only the
          worker's in-memory prompt shrinks. Claude-native only. Runs between
          turns — disabled while a turn is in flight. An auto-fold toggle (default
          OFF) lives in CONFIG.
        </p>
      </>
    ),
    manualSection: 'context-window',
  },
  'composer.serverFold': {
    title: 'Server Fold',
    body: (
      <>
        <p>
          <C>⊞ S-FOLD</C> sends <strong>one</strong> Anthropic on-demand
          compaction call: older turns are replaced by a signed server-written
          summary and the last two turns stay verbatim — thinking included, so
          Opus 5.5 / Fable 5.1 keep their reasoning. Seconds, not the 5–10
          minutes of a Handoff; richer than the deterministic <C>⊞ FOLD</C>.
        </p>
        <p>
          Costs one summarization call — the token spend is shown in the
          notice and added to the tab&apos;s token total. If the API refuses the
          beta (account/model) or no summary comes back, it falls back to the
          deterministic Fold automatically. Claude Native Agent tabs only,
          between turns. Undo: HISTORY → rewind to before the fold; the full
          transcript stays in <C>events.jsonl</C>.
        </p>
      </>
    ),
    manualSection: 'context-window',
  },
  'composer.posture': {
    title: 'Tool posture',
    body: (
      <>
        <p>
          Scopes which tools are exposed to the model for the next turn, cutting
          tool-definition tokens and attention. Click to cycle:{' '}
          <C>full</C> (all tools) → <C>coding</C> (no web research) →{' '}
          <C>review</C> (read / inspect / run only — no Write / Edit / Task / web)
          → <C>chat</C> (read-only lookup).
        </p>
        <p>
          Session-local and reversible: reverts to <C>full</C> on reload.
          Claude-native only.
        </p>
      </>
    ),
    manualSection: 'tool-pills',
  },
  'composer.project-trust': {
    title: 'Untrusted project',
    body: (
      <>
        <p>
          This repo ships agent-facing resources — <C>CLAUDE.md</C>, project
          skills, <C>.arco/settings.json</C> — that Arco{' '}
          <strong>suppressed from the turn</strong> because the project isn't yet
          trusted (the cloned-repo prompt-injection vector). The turn already ran
          without them.
        </p>
        <p>
          <C>▸ TRUST</C> records the repo as trusted in{' '}
          <C>~/.arco/trust.json</C> and folds those resources into future turns
          (reversible — edit trust.json to revoke). <C>NEVER</C> keeps them
          suppressed and stops prompting. Operator-only; nothing auto-grants.
        </p>
      </>
    ),
    manualSection: 'safety-rails',
  },
  // -------------------------------------------------------- COMPOSER EXTRA
  'composer.toolbox': {
    title: 'Provider skills',
    body: (
      <p>
        Shows the active provider runtime's real skill catalog. Claude CLI
        inserts <C>/skill-name</C>; Codex inserts <C>$skill-name</C>. Claude
        Native and providers without a native skill runtime explain that limit
        instead of advertising skills they cannot run. Use <C>+SKILL</C> for
        Arco-managed playbooks: apply once to the next turn or pin one to
        the tab so its current instructions apply every turn until removed.
      </p>
    ),
  },
  'composer.back-to-cluster': {
    title: 'Back to cluster',
    body: (
      <p>
        Visible only when the current workflow is a cluster member. Click to
        flip the active tab back to the parent cluster.
      </p>
    ),
    manualSection: 'cluster-back-to-cluster',
  },
};
