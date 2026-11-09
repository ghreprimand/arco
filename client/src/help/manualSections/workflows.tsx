import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Pre, Note, Sub } from '../../components/UserManual/components';
export const workflows: Section[] = [
  {
  id: 'what-is-workflow',
  group: 'Workflows & sessions',
  title: 'What is a workflow?',
  body: (
  <>
  <p>
  An <strong>Agent workflow</strong> is one project tab: a folder, a provider
  session and a durable event log. Workflows persist across server restarts.
  </p>
  <p>Each workflow bundles:</p>
  <ul>
  <li>A working directory (cwd), which is the project root.</li>
  <li>A primary provider, model, effort and (for Claude) tool allowlist.</li>
  <li>A primary CLI session id (a Claude UUID or Codex thread id, where the provider supports resume).</li>
  <li>A persistent log at <Code>&lt;cwd&gt;/.arco/workflows/&lt;wfid&gt;/events.jsonl</Code>.</li>
  <li>A <Code>meta.json</Code> file tracking session history, the attached plan, calibration and similar settings.</li>
  <li>Optional artifacts under <Code>artifacts/</Code> and <Code>handoffs/</Code> alongside.</li>
  </ul>
  <p>
  The server reloads workflows on boot. The client rehydrates from local storage,
  and the server replays anything it missed.
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
  <p>Changing the creator folder clears the selected session. RESUME requires a session from the current folder after its list finishes loading. A missing selection never launches a new conversation silently.</p>
  <p>Summaries and automatic titles update the current provider session. Older session titles stay intact. Live native-session history waits for complete records, including text written in several chunks.</p>
  <p>The Resume index follows the selected project. A slower reply from a previously selected project cannot replace its titles, pins or archive metadata.</p>
  <p>
  Where the provider supports it, Arco's session is a real CLI session. It can
  leave Arco and continue in a terminal, or the reverse. Arco owns the tab state;
  the provider owns the conversation state.
  </p>
  <Pre>{`# Claude - resume by UUID
claude --resume <session-uuid>
# Codex - resume by thread id
codex exec resume <thread-id> "next prompt"
`}</Pre>
  <p>
  To go the other way, start a session in a terminal, then pick it up in Arco with
  the <strong>RESUME</strong> picker in the workflow creator.
  </p>
  <Note kind="warn">
  <strong>Concurrent writer guard.</strong> If a separate{' '}
  <Code>claude --resume</Code> terminal starts writing to a session Arco has open,
  Arco detects it, shows a chat warning, and refuses new turns for 60 seconds
  rather than interleave writes. Recover with <strong>Handoff</strong>.
  </Note>
  <Sub>Providers without sessions</Sub>
  <p>
  Local HTTP providers (Ollama, llama.cpp, LM Studio) have no session. Arco
  re-feeds the rendered transcript on every turn, and prefix caching reduces the
  repeated prompt work.
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
  <p>
  Project workflow records live under the project's folder. Saved Chat, global
  settings, clusters and indexes use separate homes. Saved Chat uses its own
  directory under <Code>~/.arco/chats</Code>, and Incognito has no persistent
  record.
  </p>
  <Sub>Per project</Sub>
  <Pre>{`<cwd>/.arco/
  workflows/
  <workflowId>/
  events.jsonl  # append-only event log; lossless replay source
  meta.json  # session ids, history, attached plan, calibration
  handoffs/  # handoff-<ts>.md artifacts
  artifacts/  # review-<ts>.md artifacts
  plans/  # <planId>.md briefs (cwd-scoped)`}</Pre>
  <p>
  Everything is written atomically (temporary file, then rename) except{' '}
  <Code>events.jsonl</Code>, which is append-only.
  </p>
  <Sub>Provider session files</Sub>
  <p>The native CLI session files live with the provider:</p>
  <Pre>{`~/.claude/projects/<cwd-hash>/<sessionId>.jsonl  # Claude
~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl  # Codex`}</Pre>
  <Sub>Clusters</Sub>
  <p>Cluster state lives separately, in <Code>~/.arco/clusters/&lt;clusterId&gt;/</Code>:</p>
  <Pre>{`~/.arco/clusters/<clusterId>/
  meta.json  # cluster name, members, plan, idle nudger
  mailbox/
  <recipientWfid>/<msgId>.json  # per-recipient peer-message inbox`}</Pre>
  <p>
  The mailbox is a budgeted inbox with one file per message, keyed by the
  recipient's workflow id. Draining it deletes the file. The durable record of each
  peer exchange lives in the sender's and the recipient's <Code>events.jsonl</Code>.
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
  The worker header shows <Code>CTX: N K / N K · NN%</Code>. The denominator is the
  model's context window; the numerator is Arco's running estimate of how full the
  prompt is. How that estimate is made depends on the provider.
  </p>
  <Sub>Claude CLI</Sub>
  <p>
  Arco uses the CLI session's latest context snapshot when available, with a
  calibration from the session file's size as a fallback. The dot next to the
  percentage is <Code>○</Code> (estimate) until the first calibration or snapshot
  runs, then <Code>●</Code>.
  </p>
  <Sub>Claude Native</Sub>
  <p>
  Arco counts tokens on the retained next-turn prompt using Anthropic's token
  counter, with model-specific retention rules. Fable/Mythos 5.2 / 5.1 and Opus 5.5
  retain thinking and a frozen request prefix. On all models, the latest assistant
  message and referenced server-tool calls are protected from end-of-turn pruning.
  </p>
  <p>
  Server web search and fetch turns may show very large Activity{' '}
  <Code>prompt</Code>, <Code>cache-read</Code> and <Code>cache-write</Code>{' '}
  figures. Those are per-turn processing telemetry, not retained context.
  </p>
  <Sub>Codex</Sub>
  <p>
  Arco uses Codex token counts with OpenAI semantics. <Code>input_tokens</Code> is
  the full prompt or context size, while <Code>cached_input_tokens</Code> is a
  subset used for cache-hit reporting, not an additive term. The indicator is{' '}
  <Code>●</Code> when Codex reports its context window and <Code>○</Code> when
  Arco falls back to the model metadata estimate.
  </p>
  <Sub>Claude CLI calibration</Sub>
  <p>
  Calibration runs at idle moments when a turn crosses an uncalibrated zone (E, A,
  B or C, at 8-15%, 20-30%, 45-55% and 70-80%). It runs <Code>/context</Code>{' '}
  against the live session through a background terminal, captures the true count,
  and stores the bytes-to-tokens ratio in <Code>meta.json</Code>.
  </p>
  <p>
  Click the CTX readout in the worker header to recalibrate a CLI session on
  demand.
  </p>
  </>
  ),
  },
  {
  id: 'auto-handoff',
  group: 'Workflows & sessions',
  title: 'Auto-handoff after compactions',
  body: (
  <>
  <p>
  Auto-compaction keeps a long conversation inside the context window, and each
  compaction loses some detail. Auto-handoff starts a fresh session once a
  conversation has been compacted a set number of times. It is off by default.
  </p>
  <p>
  Turn it on in the CONFIG pane under AUTO-HANDOFF: tick <strong>Hand off
  after</strong> and set the number of compactions (default 5, from 1 to 20).
  The handoff runs only at the end of a turn, in the chosen mode: QUICK,
  ORIGINAL WORKER or FRESH SUMMARIZER. The count starts again with the new
  session.
  </p>
  <p>
  Nothing is shown before the handoff. Afterwards one chat line says, for
  example, Handed off after 5 compactions, and links the handoff document.
  A Fold does not count as a compaction.
  </p>
  <Sub>Where Arco can count</Sub>
  <ul>
  <li>Claude Native and Ollama: Arco's own compactions, so auto-compaction must be on.</li>
  <li>Claude CLI and Codex app-server: the compactions they report, including their own.</li>
  <li>Cursor, Codex exec and providers without compaction: not countable. The control is unavailable and says why.</li>
  </ul>
  <Note kind="info">
  Tabs saved with the earlier WARN and AUTO percentages keep their on or off
  state and hand off after 5 compactions.
  </Note>
  </>
  ),
  },
  {
  id: 'fold-context',
  group: 'Workflows & sessions',
  title: 'Fold - in-place context trim',
  body: (
  <>
  <p>
  <strong>Fold</strong> is the cheapest of Arco's three context-relief tools: a
  deterministic in-place trim with no model round-trip. It folds older transcript
  history into a digest and keeps a verbatim recent tail, in the same session,
  instantly.
  </p>
  <Sub>Fold, Compact and Handoff</Sub>
  <ul>
  <li><strong>Fold</strong> trims in place with no model call.</li>
  <li><strong>Compact</strong> summarizes the conversation with a model call.</li>
  <li><strong>Handoff</strong> rotates to a fresh worker with a written document.</li>
  </ul>
  <p>
  The raw transcript always stays in <Code>events.jsonl</Code>.
  </p>
  <Sub>Running a fold</Sub>
  <p>
  Fold runs manually with the <Code>⊞ FOLD</Code> button in the composer (between
  turns only). It can also run automatically: arm <strong>AUTO-FOLD (NATIVE)</strong>{' '}
  in the CONFIG pane and set a <Code>FOLD AT</Code> threshold. Auto-fold fires when
  context pressure crosses that threshold. A Fold is not counted as a
  compaction for auto-handoff.
  </p>
  <Note kind="info">
  Fold and auto-fold are Claude Native only, and auto-fold is off by default
  (operator-armed). The trigger reads Arco's token-budget meter, which is the
  usable-input pressure against the effective context window (the real window minus
  reserved output), updated each turn.
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
  Rewind moves the live conversation back to a past event without deleting the
  abandoned branch. Use it to try a different direction from an earlier point.
  </p>
  <ol>
  <li>From the <strong>HISTORY</strong> tab, select any past event.</li>
  <li>Click <Code>REWIND CONVERSATION</Code> (two-click confirm).</li>
  </ol>
  <p>
  Arco forks a new branch from the selected event, and later turns continue from the
  rewound point. The abandoned branch is never deleted. It stays in{' '}
  <Code>events.jsonl</Code> on disk, and undoing a rewind is just another rewind.
  </p>
  <Note kind="warn">
  Rewind is Claude Native only for now. CLI and Codex resume is summarizer-backed, so
  a true byte-identical rewind would silently do nothing, so for them the
  button stays visible but disabled, with the reason beside it. Rewind during a turn is also refused, so cancel the active
  turn first.
  </Note>
  </>
  ),
  },
  {
  id: 'genesis-workflow',
  group: 'Workflows & sessions',
  title: 'Genesis - idea to scaffolded project',
  body: (
  <>
  <p>Field assistance uses a separate provider session while keeping the selected transport and account. Suggestions belong to this Genesis tab, while the primary conversation keeps its existing context and worker.</p>
  <p>
  <strong>Genesis</strong> starts a project from a vague idea instead of a folder.
  Pick <Code>GENESIS</Code> in the new-workflow mode toggle, give a working name and
  a <em>Spark</em> (the raw idea), and launch. No working directory is required.
  </p>
  <p>Seed controls are temporarily disabled while SAVE PLAN or CREATE ALTERNATIVE saves the public-project choice. Seed edits save automatically. Pending edits are sent when leaving GENESIS and before SAVE PLAN, CREATE &amp; SCAFFOLD or CREATE ALTERNATIVE.</p>
  <p>Build-direction readiness checks every required stage, even when that stage was selected early. An empty Spark, working name, Concept or Case still appears as missing. The readout is advisory.</p>
  <Sub>The four stages</Sub>
  <p>
  The workflow runs in a hidden scratch space while the idea is shaped through four
  stages, tracked in the right-panel <Code>GENESIS</Code> tab:
  </p>
  <ul>
  <li><strong>Spark</strong> - the raw idea, in your words.</li>
  <li><strong>Concept</strong> - what it is, in plain language, built from the Spark.</li>
  <li><strong>The Case</strong> - why building it is worth it, who it is for, and where scope stops.</li>
  <li><strong>Build-direction</strong> - stack, scope boundaries and first concrete steps.</li>
  </ul>
  <p>
  Each downstream field is anchored to the one above it, and the agent never invents
  audiences, tech or scope that have not been stated.
  </p>
  <Sub>Scaffolding</Sub>
  <p>
  When ready, <Code>CREATE &amp; SCAFFOLD</Code> creates the real project folder
  (default <Code>~/Projects</Code>), writes seed docs (<Code>README</Code>,{' '}
  <Code>SPEC</Code>, <Code>TODO</Code>, <Code>CLAUDE.md</Code>), and optionally
  creates a GitHub repo. It then binds the workflow to the new folder, carrying the
  transcript over, and seeds a plan. Select the public-project box to include
  privacy guardrails in that plan.
  </p>
  <Note kind="info">
  The seed lives in the workflow config until scaffold, so ideation can pause and
  resume across sessions. Scaffolding creates files on disk and needs your
  confirmation.
  </Note>
  <p>
  Scaffolding reserves the conversation until its history has moved and the active
  folder is ready. Another scaffold is refused. New messages are refused before acknowledgement; resend them after the active folder is ready. STOP keeps the storage move
  reserved until it finishes. Errors release the reservation too.
  </p>
  <Sub>Save a plan in an existing folder</Sub>
  <p>
  An existing-folder Genesis draft follows the same stages. <Code>SAVE PLAN</Code>
  saves a checklist and reference documents for the concept, case, build direction,
  first steps and generated spec. <Code>SPEC.md</Code> and <Code>TODO.md</Code> are
  created only when missing. Existing files stay unchanged; <Code>README.md</Code>
  is not written. Generated content remains in the references.
  </p>
  <p>
  The public-project box uses this folder's saved choice and remote suggestion.
  Selecting it adds privacy guardrails to the plan and remembers the choice.
  </p>
  <Sub>Creative mode in an existing project</Sub>
  <p>Outside Git, file counting skips nested checkouts and uses entry and time budgets. An incomplete count keeps a conservative existing-codebase warning and says Results truncated; it never treats an unscanned folder as empty.</p>
  <p>
  On any tab with a real project folder, the <Code>GENESIS</Code> tab offers{' '}
  <Code>ARM CREATIVE MODE</Code> to explore an alternative direction. Creative mode
  never edits the project: <Code>CREATE ALTERNATIVE</Code> writes into a sibling{' '}
  <Code>ALTERNATIVE/</Code> folder with its own plan. An established codebase shows a
  warning when you arm. <Code>DISARM</Code> is shown whenever Creative mode is armed;
  it returns the tab to normal turns and keeps the idea fields.
  </p>
  </>
  ),
  },
];
