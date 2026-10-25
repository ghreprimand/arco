import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Pre, Note } from '../../components/UserManual/components';

export const workflows: Section[] = [
  {
    id: 'what-is-workflow',
    group: 'Workflows & sessions',
    title: 'What is a workflow?',
    body: (
      <>
        <p>
          An <strong>Agent workflow</strong> is one project tab. It bundles:
        </p>
        <ul>
          <li>A working directory (cwd) — the project root.</li>
          <li>A primary provider, model, effort, and (for Claude) tool allowlist.</li>
          <li>A primary CLI session id (Claude UUID or Codex thread_id, where the provider supports resume).</li>
          <li>A persistent log at <Code>&lt;cwd&gt;/.arco/workflows/&lt;wfid&gt;/events.jsonl</Code>.</li>
          <li>A meta file <Code>meta.json</Code> tracking session history, attached plan, calibration, etc.</li>
          <li>Optional artifacts under <Code>artifacts/</Code> and <Code>handoffs/</Code> alongside.</li>
        </ul>
        <p>
          Workflows persist across server restarts. The server reloads them on boot;
          the client rehydrates from localStorage and the server replays anything it
          missed.
        </p>
      </>
    ),
  },
  {
    id: 'sessions-and-resume',
    group: 'Workflows & sessions',
    title: 'Native sessions & resume',
    body: (
      <>
        <p>
          Where the provider supports it, Arco's session is a <em>real</em> CLI
          session. You can leave Arco and continue from a terminal:
        </p>
        <Pre>{`# Claude — resume by UUID
claude --resume <session-uuid>

# Codex — resume by thread id
codex exec resume <thread-id> "next prompt"

# Gemini — resume by index (Arco stores the UUID and resolves to index)
gemini -r <index>`}</Pre>
        <p>
          And vice versa — start a session in a terminal, then pick it up in Arco
          via the <strong>RESUME</strong> picker in the workflow creator. Arco owns
          the tab state; the provider owns the conversation state.
        </p>
        <Note kind="warn">
          <strong>Concurrent writer guard.</strong> If a foreign{' '}
          <Code>claude --resume</Code> terminal starts appending to a session Arco
          has open, Arco detects non-<Code>sdk-cli</Code> entrypoint writes, fires a
          chat warning, and refuses new turns for 60 seconds rather than interleave
          writes. Recover with <strong>Handoff</strong>.
        </Note>
        <p>
          <strong>Session-less providers:</strong> Gemini supports resume by index;
          the local HTTP providers (Ollama, llama.cpp, LM Studio) and Antigravity are
          session-less in different ways. The local providers re-feed the rendered
          transcript on every turn (the prefix cache makes this cheap).
          Antigravity resumes by cascade id; starting without a stored cascade creates a fresh one.
        </p>
      </>
    ),
  },
  {
    id: 'persistence',
    group: 'Workflows & sessions',
    title: 'Persistence layout',
    body: (
      <>
        <p>Project workflow records live under the project's cwd. Saved Chat uses
          its own directory under <Code>~/.arco/chats</Code>; Incognito has no
          persistent record. Global settings, clusters and indexes are also separate.</p>
        <Pre>{`<cwd>/.arco/
  workflows/
    <workflowId>/
      events.jsonl      # append-only event log; lossless replay source
      meta.json         # session ids, history, attached plan, calibration
      handoffs/         # handoff-<ts>.md artifacts
      artifacts/        # review-<ts>.md artifacts
  plans/                # <planId>.md briefs (cwd-scoped)`}</Pre>
        <p>
          The native CLI session files live with the provider:
        </p>
        <Pre>{`~/.claude/projects/<cwd-hash>/<sessionId>.jsonl     # Claude
~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl  # Codex
~/.gemini/tmp/<dir>/chats/session-*.json            # Gemini`}</Pre>
        <p>
          Atomic tmp+rename writes are used for everything but{' '}
          <Code>events.jsonl</Code>, which is append-only.
        </p>
        <p>
          Cluster state lives separately, in <Code>~/.arco/clusters/&lt;clusterId&gt;/</Code>:
        </p>
        <Pre>{`~/.arco/clusters/<clusterId>/
  meta.json                           # cluster name, members, plan, idle nudger
  mailbox/
    <recipientWfid>/<msgId>.json      # per-recipient peer-message inbox`}</Pre>
        <p>
          The mailbox is a budgeted file-per-message inbox keyed by the recipient's
          workflowId. Drains destroy the file; the durable record of each peer
          exchange lives in the sender's and recipient's <Code>events.jsonl</Code>.
        </p>
      </>
    ),
  },
  {
    id: 'context-window',
    group: 'Workflows & sessions',
    title: 'Context window & calibration',
    body: (
      <>
        <p>
          The footer shows <Code>CTX: N K / N K · NN%</Code>. The denominator is
          the model's context window; the numerator is Arco's running estimate of
          how full the prompt is.
        </p>
        <ul>
          <li>
            <strong>Claude CLI</strong> — uses the CLI session's latest context
            snapshot when available, with session JSONL byte-size calibration as a
            fallback. The dot indicator next to the percentage is <Code>○</Code>{' '}
            (estimate) until the first calibration/snapshot runs, then <Code>●</Code>.
          </li>
          <li>
            <strong>Claude Native</strong> — uses Anthropic{' '}
            <Code>messages.countTokens()</Code> on the retained next-turn prompt
            with model-specific retention rules. Fable/Mythos 5.1 and Opus 5.5 retain thinking
            and a frozen request prefix; the latest assistant message and referenced
            server-tool calls are protected from end-of-turn pruning on all models.
            Server web-search/fetch turns may show very large Activity{' '}
            <Code>prompt</Code>, <Code>cache-read</Code>, and <Code>cache-write</Code>
            figures; those are per-turn processing telemetry, not retained context.
          </li>
          <li>
            <strong>Codex</strong> — uses Codex token counts with OpenAI semantics:
            <Code>input_tokens</Code> is the full prompt/context size, while{' '}
            <Code>cached_input_tokens</Code> is a subset used for cache-hit reporting,
            not an additive context term. Indicator is <Code>●</Code> when Codex reports
            <Code>model_context_window</Code>, <Code>○</Code> when falling back to the
            model metadata estimate.
          </li>
          <li>
            <strong>Antigravity</strong> — shown as <Code>CTX: Antigravity-managed</Code>.
            Arco does not have trustworthy context-fill or cache numbers for the
            desktop cascade.
          </li>
          <li>
            <strong>Gemini / Ollama / llama.cpp / LM Studio</strong> — compact token readout only
            when usage is reported; no Arco percentage threshold.
          </li>
        </ul>
        <p>
          <strong>Claude CLI calibration</strong> runs on idle moments when a turn
          crosses an uncalibrated zone (E/A/B/C = 8–15% / 20–30% / 45–55% / 70–80%).
          It runs <Code>/context</Code> against the live session via a background pty,
          captures the ground-truth count, and stores the byte→token ratio in{' '}
          <Code>meta.json</Code>. Click the CTX cluster in the footer to recalibrate
          a CLI session on demand.
        </p>
      </>
    ),
  },
  {
    id: 'auto-handoff',
    group: 'Workflows & sessions',
    title: 'Auto-handoff at threshold',
    body: (
      <>
        <p>
          When context fill reaches the configured ceiling (default 90%), Arco
          automatically generates a handoff document and rotates the tab to a fresh
          session. A warning fires at a lower threshold (default 75%) so you can
          choose to <strong>Handoff manually</strong>, finish the current task and
          rotate, or just bump the threshold.
        </p>
        <p>
          Both thresholds are per-tab, configurable from the CONFIG pane.
        </p>
        <Note kind="warn">
          Auto-handoff only runs when Arco has a trusted context-fill signal for the
          active provider. Claude uses session or Native counts; Codex app-server and
          Z.ai use the latest rollout token snapshot; Ollama uses the daemon prompt
          count. Antigravity owns its cascade context/cache/compaction, so Arco offers
          only a manual fresh-cascade reset, not percentage-triggered handoff.
        </Note>
      </>
    ),
  },
  {
    id: 'fold-context',
    group: 'Workflows & sessions',
    title: 'Fold — in-place context trim',
    body: (
      <>
        <p>
          <strong>Fold</strong> is the cheapest of Arco's three context-relief
          tools. It deterministically folds older transcript history into a digest
          and keeps a verbatim recent tail, in the same session, instantly — no
          model round-trip. Compare: <strong>Compact</strong> summarizes the
          conversation via a model call; <strong>Handoff</strong> rotates to a fresh
          worker with a written doc. The raw transcript always stays in{' '}
          <Code>events.jsonl</Code>.
        </p>
        <p>
          Fold runs manually via the <Code>⊞ FOLD</Code> button in the composer
          (between turns only), or automatically: arm <strong>AUTO-FOLD (NATIVE)</strong>{' '}
          in the CONFIG pane and set a <Code>FOLD AT</Code> threshold. Auto-fold
          fires when context pressure crosses <Code>FOLD AT</Code>, which is kept
          below the handoff <Code>WARN</Code> threshold so the cheap in-place trim
          happens before a handoff is recommended.
        </p>
        <Note kind="info">
          Fold and auto-fold are Claude Native only, and auto-fold is off by default
          (operator-armed). The trigger reads Arco's token-budget meter — the
          usable-input pressure against the effective context window (real window
          minus reserved output) — emitted each turn as a <Code>context_budget</Code>{' '}
          signal.
        </Note>
      </>
    ),
  },
  {
    id: 'rewind-conversation',
    group: 'Workflows & sessions',
    title: 'Rewind & forks',
    body: (
      <>
        <p>
          From the <strong>HISTORY</strong> tab, select any past event and click{' '}
          <Code>REWIND CONVERSATION</Code> (two-click confirm) to move the live head
          back to that point. The abandoned branch is never deleted — it stays in{' '}
          <Code>events.jsonl</Code> on disk, and "undo the undo" is just another
          rewind. The server forks a child of the selected seq and stamps a{' '}
          <Code>leaf_move</Code> event; subsequent turns continue from the rewound
          point.
        </p>
        <Note kind="warn">
          Rewind is Claude Native only in v1. CLI / Codex resume is summarizer-backed,
          so a true byte-identical rewind would silently no-op — Arco rejects the
          request rather than lie. You also cannot rewind mid-turn; cancel the active
          turn first.
        </Note>
      </>
    ),
  },
  {
    id: 'genesis-workflow',
    group: 'Workflows & sessions',
    title: 'Genesis — idea to scaffolded project',
    body: (
      <>
        <p>
          <strong>Genesis</strong> starts a project from a vague idea instead of a
          folder. Pick <Code>GENESIS</Code> in the new-workflow mode toggle, give a
          working name and a <em>Spark</em> (the raw idea), and launch — no working
          directory required.
        </p>
        <p>
          The workflow runs in a hidden scratch space while you and the agent shape
          the idea through four stages, tracked in the right-panel <Code>GENESIS</Code> tab:
        </p>
        <ul>
          <li><strong>Spark</strong> — the raw idea, in your words.</li>
          <li><strong>Concept</strong> — what it is, in plain language (built from the Spark).</li>
          <li><strong>The Case</strong> — why building it is worth it; who it's for; where scope stops.</li>
          <li><strong>Build-direction</strong> — stack, scope boundaries, first concrete steps.</li>
        </ul>
        <p>
          Each downstream field is anchored to the one above it, and the agent never
          invents audiences, tech, or scope you haven't stated. When you're ready,
          <Code>CREATE &amp; SCAFFOLD</Code> creates the real project folder (default
          <Code>~/Projects</Code>), writes seed docs (<Code>README</Code> / <Code>SPEC</Code> /
          <Code>TODO</Code> / <Code>CLAUDE.md</Code>), optionally a GitHub repo, then binds
          the workflow to the new folder — carrying the transcript over — and seeds a plan.
        </p>
        <Note kind="info">
          The seed lives in the workflow config until scaffold, so you can pause and resume
          ideation across sessions. Scaffolding creates files on disk and is operator-confirmed.
        </Note>
      </>
    ),
  },

  // -------------------------------------------------------------- CLUSTERS
];
