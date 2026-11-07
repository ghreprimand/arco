import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Pre, Note, Table, Sub} from '../../components/UserManual/components';

export const troubleshooting: Section[] = [
  {
  id: 'browser-rendering-gpu-activity',
  group: 'Troubleshooting',
  title: 'Browser rendering and GPU activity',
  body: (
  <>
  <p>
  Compare GPU activity between views or browsers under controlled conditions
  before treating it as a defect.
  </p>
  <p>
  Compare the same Arco instance and view in one browser first. Keep these
  conditions the same:
  </p>
  <ul>
  <li>theme and viewport</li>
  <li>browser zoom and interface scale</li>
  <li>other visible effects</li>
  </ul>
  <p>
  Change one condition at a time and let pointer-driven effects settle
  before comparing. If needed, repeat the same comparison in another
  browser.
  </p>
  <p>
  To check Phosphor decoration, temporarily turn off{' '}
  <strong>Phosphor effects</strong> in Settings &gt; Appearance, then
  restore the previous choice after the comparison. This is reversible
  and does not require changing other appearance choices.
  </p>
  <p>
  When Phosphor effects are enabled, Arco may show a short in-app hint
  for recognized non-Chromium browser identities. Detection is
  best-effort; on iOS, differently branded browser apps may use the same
  WebKit engine.
  </p>
  <Note>
  Browser compositing draws the workbench and its visual effects. Local
  model inference is separate and occurs while a local model is
  processing a request. GPU activity by itself does not identify which
  work is responsible, and an effects-off comparison is a
  troubleshooting clue rather than proof of a browser or Arco defect.
  </Note>
  </>
  ),
  },
  {
  id: 'diagnostics',
  group: 'Troubleshooting',
  title: 'Diagnostics tab',
  body: (
  <>
  <p>
  The System modal's Diagnostics, Models and Services tabs report what is
  working on this machine without background polling.
  </p>
  <p>
  The <strong>System</strong> modal (the ⏻ menu in the header) has four
  tabs:
  </p>
  <ul>
  <li><strong>Actions</strong> - RESTART and QUIT.</li>
  <li><strong>Diagnostics</strong> - grouped status checks, described here.</li>
  <li><strong>Models</strong> - Model Health, below.</li>
  <li><strong>Services</strong> - Local Services, below.</li>
  </ul>
  <p>Diagnostics and Model Health show a read error for failed or invalid server responses. <strong>↻ REFRESH</strong> retries the request.</p>
  <Sub>Diagnostics checks</Sub>
  <p>
  Diagnostics is grouped, read-only status checks that answer "what's
  actually working on this machine?". The report runs on open and on{' '}
  <strong>↻ REFRESH</strong>; there is no background polling.
  </p>
  <p>Six groups:</p>
  <ul>
  <li>
  <strong>Core</strong> - data/config dir read+write, an{' '}
  <Code>events.jsonl</Code> append+read round-trip (against a throwaway
  temp file, never a real workflow log), settings-cascade parse, and
  the workflow-recovery registry.
  </li>
  <li>
  <strong>Providers</strong> - Claude CLI / Native, Codex,
  Ollama, llama.cpp version/auth/reachability.
  </li>
  <li>
  <strong>Local Tools</strong> - <Code>gh</Code> auth, ffmpeg, ffprobe,
  LSP servers on PATH, and node-pty (terminal) importability.
  </li>
  <li>
  <strong>Workbench</strong> - preview proxy, recall index, knowledge
  index, hardware probe.
  </li>
  <li>
  <strong>Storage</strong> - <Code>~/.arco</Code> size (per-project{' '}
  <Code>.arco</Code> is workflow-scoped, so reported{' '}
  <Code>skipped</Code> from the global report).
  </li>
  <li>
  <strong>Security &amp; Exposure</strong> - server bind address,
  remote-access exposure, integrated-terminal / git-ops / preview-proxy
  reach, writable cwd roots, provider-credential and local-model-endpoint
  exposure. These flow into the shareable support bundle, so they bite
  on misconfiguration.
  </li>
  </ul>
  <p>Each check reports one of four statuses:</p>
  <Table
  headers={['Status', 'Meaning']}
  rows={[
  [<strong>OK</strong>, 'Works.'],
  [<strong>WARN</strong>, 'Degraded, or an optional dependency is absent (for example ffmpeg or the TS language server not installed).'],
  [<strong>ERROR</strong>, "Something that should work doesn't."],
  [<strong>SKIPPED</strong>, 'Not probed on this platform or configuration.'],
  ]}
  />
  <Note>
  A probe that throws is reported as an error with its message. It never
  crashes the report.
  </Note>
  <Sub>Support bundle</Sub>
  <p>
  <strong>Copy support bundle</strong>, beside REFRESH, copies a
  paste-ready, <strong>redacted</strong> text snapshot suitable for an
  issue or another agent. It holds the diagnostics report plus Arco
  version, git rev, platform, and runtime (node version and best-effort
  service mode).
  </p>
  <p>
  Redaction follows a safe-field <strong>allowlist</strong>, never a
  denylist. The bundle is assembled from hand-picked fields only, and its
  free text is scrubbed:
  </p>
  <ul>
  <li>
  Every free-text detail or hint has its home path collapsed to{' '}
  <Code>~</Code>.
  </li>
  <li>
  Any other absolute path, including Windows drive and UNC paths with spaces, is reduced to a{' '}
  <Code>&lt;path&gt;/basename</Code> placeholder.
  </li>
  <li>
  A final secret-scrub replaces any token-shaped string (GitHub, OpenAI
  or Anthropic keys, Bearer headers, JWTs, long hex/base64 runs) with{' '}
  <Code>&lt;redacted&gt;</Code>.
  </li>
  </ul>
  <p>
  The bundle contains <strong>no</strong> tokens, env secrets, auth
  material, or private directory layouts. If the browser blocks clipboard
  access (an insecure context), the text drops into a selectable box to
  copy by hand.
  </p>
  <Sub>Code-skew check</Sub>
  <p>
  Prod runs the compiled build (<Code>node server/dist/index.js</Code>),
  which does not watch source. A commit visible in <Code>git log</Code> is
  therefore not live until rebuild and restart.
  </p>
  <p>
  The Core check <Code>core.code-skew</Code> compares the git HEAD the
  running build booted from with the on-disk HEAD. When the running dist
  is stale it reports <strong>WARN</strong> ("running build is N commits
  behind on-disk HEAD"). The fix is <Code>npm run build</Code> +{' '}
  <Code>systemctl --user restart arco.service</Code>.
  </p>
  <p>
  Under the <Code>tsx watch</Code> dev runtime, source is already live, so
  the check reports <Code>skipped</Code>.
  </p>
  <Note>Code-skew compares Git revisions captured at startup, not compiled
  file contents. Committing an already-deployed change or changing only
  documentation can produce a warning without an undeployed runtime fix.
  Check build/deploy records before restarting active workers.</Note>
  <Sub>Model Health tab</Sub>
  <p>
  The <strong>MODELS</strong> tab answers the model-operator question
  "what can I run now / what's running / what failed last time / is my
  config stale?". It is a richer, structured sibling of Diagnostics, with
  three subsystems that each have a roll-up status and concrete fields:
  </p>
  <ul>
  <li>
  <strong>Ollama</strong> - resolved base URL, reachability, installed
  models (count, names and capability hints), and the daemon version when
  cheap. A daemon that isn't running is <strong>WARN</strong>, not error.
  </li>
  <li>
  <strong>llama.cpp</strong> - the <Code>llama-server</Code> binary path,
  registered loadouts (<Code>~/.arco/llamacpp.json</Code>), the
  lifecycle-manager state, the loaded alias/port/pid, the{' '}
  <strong>last launch args</strong>, and a tail of{' '}
  <Code>~/.arco/llamacpp.log</Code> (the last stderr). A failed last
  launch is the one <strong>ERROR</strong> case.
  </li>
  <li>
  <strong>Model files</strong> - the detected hardware profile (backend,
  VRAM, RAM, cores, GPUs), downloaded GGUFs under{' '}
  <Code>~/.arco/models</Code>, and{' '}
  <strong>fit-score mismatch warnings</strong>. A mismatch is a registered
  loadout that won't fit this hardware on GPU at a useful context, scored
  with the same fit engine. It is an actionable <strong>WARN</strong>,
  never an error.
  </li>
  </ul>
  <p>
  When a llama.cpp launch fails, Model Health runs a deterministic
  diagnosis over the stderr tail and names a likely{' '}
  <strong>cause</strong>: port-in-use, gguf-missing, ctx-too-large, OOM,
  binary-missing, or unsupported-arch. It is an ordered regex pass, not a
  model verdict, so it stays readable and reviewable.
  </p>
  <p>
  The diagnosis comes with plain-text suggestions and{' '}
  <strong>one-click fixes</strong> that write straight into the catalog
  editor's ctx / ngl / extraArgs fields. Examples are halving the context,
  offloading fewer GPU layers, or serving on another port.
  </p>
  <Note>
  The Model Health panel is read-only and operator-triggered. It fetches
  on open and Refresh, and <strong>never spawns a model</strong>, mutates a
  catalog, or changes the llama.cpp manager lifecycle. The last-launch-args
  field is additive metadata the manager retains on its existing spawn
  path; the stderr tail is a read of the existing log file.
  </Note>
  <Sub>Services tab</Sub>
  <p>Automatic service scans wait for the previous request to finish before polling again. Slow scans remain visible when they complete. Closing Services aborts its pending read.</p>
<p>
  The <strong>SERVICES</strong> tab is a machine-wide browser of the local
  listening web/dev services Arco discovers. It lives here, not in the
  per-workflow right panel, because it is project-agnostic.
  </p>
  <p>
  Compact rows show each service; click a row to expand it to cmdline,
  cwd, pid and host. The tab fetches on open and REFRESH, with a ~5s
  auto-poll while open. The one mutation is a two-step{' '}
  <strong>KILL</strong> (server-guarded SIGTERM).
  </p>
  <p>
  A service can be <strong>pinned</strong> by its stable cwd+port identity,
  so a pinned service that has stopped shows as an offline row.{' '}
  <strong>Open in Live Preview</strong> binds a service's port to the
  focused workflow's preview proxy.
  </p>
  </>
  ),
  },
  {
  id: 'recovery',
  group: 'Troubleshooting',
  title: 'Stuck workflows & recovery',
  body: (
  <>
  <p>During a Genesis storage move, STOP is refused until the operation finishes. New messages are also refused before acknowledgement; resend them when the active folder is ready.</p>
  <p>
  Escape a tab stuck in the busy state with cancel, then Handoff, then
  restart - and watch the stuck-worker breaker for repeated failing tools.
  </p>
  <p>If a tab gets stuck in the busy state with no apparent activity:</p>
  <ol>
  <li>
  Click <strong>✕ CANCEL</strong> in the composer. The server
  ends an active turn even if the worker has gone "ghost"
  (silently exited mid-turn). This is the standard escape hatch.
  </li>
  <li>
  If cancel does not unstick it, click <strong>Handoff</strong>. That writes
  a fresh-summarizer doc against the rendered transcript and rotates to a
  new session.
  </li>
  <li>
  Last resort: <strong>RESTART</strong> from the ⏻ menu. Workflows
  persist; on reboot the client rehydrates from{' '}
  <Code>events.jsonl</Code>.
  </li>
  </ol>
  <Sub>Stuck-worker breaker</Sub>
  <p>
  If a worker repeats the <em>identical failing</em> tool call with no
  progress, the breaker fires. It is deterministic (a counter over the
  tool name, input and output, not a model judgement):
  </p>
  <ul>
  <li>
  Three identical calls in a row surface a one-time nudge notice
  (escalation <Code>detected</Code>).
  </li>
  <li>
  Five in a row recommend a reversible <strong>pause</strong> (escalation{' '}
  <Code>persist</Code>).
  </li>
  <li>
  A single successful tool call, or the next turn, clears the latch
  (escalation <Code>recovered</Code>).
  </li>
  </ul>
  <p>
  The chat shows a notice reading <Code>Stuck-worker breaker: ...</Code>.
  The breaker <strong>never kills or re-prompts the worker itself</strong>;
  the operator acts on the signal.
  </p>
  <p>
  The breaker is cross-provider (Claude Native and Codex). The in-turn
  tool-loop guardrail is the tighter same-turn sibling.
  </p>
  </>
  ),
  },
  {
  id: 'review-gate',
  group: 'Troubleshooting',
  title: 'Review-safe gate stuck / after restart',
  body: (
  <>
  <p>
  Recover a parked review-safe gate by acting on its approval card; after
  restart, approve re-issues the action as the next turn.
  </p>
  <p>
  <Code>reviewSafeMode</Code> is a per-tab CONFIG flag, default{' '}
  <strong>OFF</strong>, and <strong>Claude Native only</strong> in v1. When
  on, a sensitive tool call parks behind an approval card.
  </p>
  <p>To recover a parked gate, act on the card:</p>
  <ul>
  <li><strong>approve</strong></li>
  <li><strong>edit-then-approve</strong></li>
  <li><strong>reject</strong></li>
  <li>
  "approve all like this" to record a standing approval. It re-evaluates
  against the non-lossy signature, and the set lives in the CONFIG list
  where it can be revoked.
  </li>
  </ul>
  <Note>
  Across a server restart the parked in-process tool-loop is gone, so the
  card re-surfaces on first rehydrate. An approve then{' '}
  <strong>re-issues the action as the next-turn input</strong>: an honest
  re-run, not a seamless continuation. If the gate looks stuck after a
  restart, that is expected: act on the re-surfaced card.
  </Note>
  </>
  ),
  },
  {
  id: 'rewind',
  group: 'Troubleshooting',
  title: 'Rewind the conversation',
  body: (
  <>
  <p>
  Use HISTORY's REWIND CONVERSATION to move the live head back when a turn
  went wrong (Claude Native only).
  </p>
  <p>
  The <strong>HISTORY</strong> tab's <strong>REWIND CONVERSATION</strong>{' '}
  action sits on transcript rows and moves the live head back to an
  earlier point. The <strong>REWINDS</strong> filter preset lists prior
  forks. It is a two-click confirm (<Code>CONFIRM REWIND ↩</Code>).
  </p>
  <p>
  A rewind is reversible. The current branch is kept and can be returned
  to, and undoing a rewind is just another rewind.
  </p>
  <p>
  Rewind is <strong>Claude Native only</strong>. For other providers and
  the Claude CLI the button stays visible but disabled, with the reason
  beside it. Cancel any in-flight turn first.
  </p>
  </>
  ),
  },
  {
  id: 'offline',
  group: 'Troubleshooting',
  title: 'OFFLINE / SYNCING / reconnect',
  body: (
  <>
  <p>The quiet-worker clock advances while a workflow is busy and online, including when no new events arrive. At the silence threshold, the warning offers CANCEL TURN for that workflow.</p>
<p>
  The header pill reports ONLINE, SYNCING or OFFLINE for the WebSocket and
  workflow replay state.
  </p>
  <ul>
  <li><strong>● ONLINE</strong> - WS connected, all persisted workflows have replayed. Normal.</li>
  <li>
  <strong>● SYNCING…</strong> - WS up, but at least one workflow is still
  waiting for its state snapshot. Brief, usually invisible. The
  full-screen SYNCING overlay only fires for first-load rehydration.
  </li>
  <li>
  <strong>● OFFLINE</strong> - WS down. The <Code>RECONNECT</Code> button
  forces a new connection attempt; otherwise Arco retries with backoff.
  </li>
  </ul>
  <p>
  The client remembers the last event it saw for each workflow in
  localStorage. On reconnect, the server replays anything newer from disk
  and then sends a fresh snapshot.
  </p>
  <p>
  Saved conversation events replay across drops; transient telemetry is
  not durable. Incognito has only a brief in-memory reconnect grace, never
  disk recovery.
  </p>
  </>
  ),
  },
  {
  id: 'duplicate-tab',
  group: 'Troubleshooting',
  title: 'Duplicate Tab overlay',
  body: (
  <>
  <p>
  Arco refuses to run two browser tabs against the same server so they do
  not fight over observer state.
  </p>
  <p>
  The second tab gets a full-screen <strong>Duplicate Tab</strong> overlay.
  Two tabs would both rehydrate the same persisted workflows on connect,
  fighting over observer state and confusing the server-side WS handler.
  </p>
  <p>
  The tabs handshake at boot. If the first tab is responsive, the second
  tab declines to mount. Close the original tab to take over.
  </p>
  </>
  ),
  },
  {
  id: 'concurrent-writer',
  group: 'Troubleshooting',
  title: 'Concurrent writer warnings',
  body: (
  <>
  <p>
  A foreign <Code>claude --resume</Code> on a session Arco has open trips a
  60-second turn lockout; recover with Handoff.
  </p>
  <p>
  If a system notice like this appears:
  </p>
  <Pre>{`[WARN] Concurrent writer detected on session <uuid>.
New turns blocked for 60s. Recover via Handoff.`}</Pre>
  <p>
  A <Code>claude --resume &lt;uuid&gt;</Code> (or similar) is appending to
  the same session JSONL Arco has open. Arco detects this from the entry
  point recorded on each new entry; any writer other than Arco's own trips
  the guard.
  </p>
  <p>To recover:</p>
  <ol>
  <li>Close the foreign terminal session (or wait for it to settle).</li>
  <li>Click <strong>Handoff</strong>. The new session is owned alone.</li>
  </ol>
  <Note>
  The 60-second cooldown is intentional. Interleaved writes from two
  drivers will corrupt the session JSONL, and recovery from corruption is
  much worse than a forced rotation.
  </Note>
  </>
  ),
  },
  {
  id: 'common-issues',
  group: 'Troubleshooting',
  title: 'Common issues',
  body: (
  <>
  <p>
  Short fixes for missing providers, tool-pill display, CTX indicators, MCP
  env secrets and the RSS safety cap.
  </p>
  <Sub>"Provider not in workflow creator"</Sub>
  <ul>
  <li>Check Settings &gt; Providers and models &gt; Enabled providers - is the provider toggled on?</li>
  <li>Check Settings - is the provider authed (LIVE chip)?</li>
  <li>For Ollama: is the daemon running on <Code>OLLAMA_URL_BASE</Code>?</li>
  </ul>
  <Sub>"Tool calls don't show as inline pills"</Sub>
  <ul>
  <li>Inline pills appear for the tool calls a provider reports to Arco. A provider that reports none shows its work only in the ACTIVITY tab.</li>
  </ul>
  <Sub>"CTX bar shows ○ instead of ●"</Sub>
  <ul>
  <li>Claude - calibration hasn't run yet for this session. It runs on idle moments crossing zone thresholds, or click the CTX cluster to recalibrate now.</li>
  <li>Codex - the session hasn't yet emitted a token snapshot with <Code>model_context_window</Code>. Until then, the denominator uses the selected account/model catalog and the tab's MAX or STANDARD policy.</li>
  </ul>
  <Sub>"My MCP server can't authenticate / is missing an API key"</Sub>
  <ul>
  <li>
  Spawned MCP children (npx/uvx) no longer inherit Arco's environment.
  The Claude OAuth token, GitHub PAT, and other host secrets are withheld
  as a security floor.
  </li>
  <li>
  A child sees only an allowlisted base env (PATH/HOME/SHELL, locale,
  temp dir, XDG_*) plus the keys declared in that server's{' '}
  <Code>env</Code> block in the MCP registry entry.
  </li>
  <li>
  If a server needs a secret, add it explicitly to its <Code>env</Code>:
  that is the intended secret channel.
  </li>
  </ul>
  <Sub>"Package install will not start or the page does not load"</Sub>
  <ul>
  <li>Run <Code>arco doctor</Code>: it reports the Node version (24 or newer), whether the native modules load, whether the port is free on loopback, which provider CLIs answer <Code>--version</Code>, and the service state.</li>
  <li>If the native modules are missing or incompatible, run <Code>arco setup --repair-native</Code> (build tools required).</li>
  <li>If the port is in use, another Arco or a different program holds it. Stop the other process or set <Code>ARCO_PORT</Code>.</li>
  <li>Run <Code>arco service logs</Code> to read the recent service logs.</li>
  </ul>
  <Sub>"process tree exceeded 32 GB RSS safety cap"</Sub>
  <ul>
  <li>Something the agent ran (a recursive find, a huge build, a runaway test) ballooned memory. The kill is intentional.</li>
  <li>If the project legitimately needs &gt;32 GB, opt out of the RSS guard from CONFIG for that workflow specifically (or shrink/raise the cap with <Code>ARCO_RSS_KILL_BYTES</Code>).</li>
  </ul>
  </>
  ),
  },

  // -------------------------------------------------------------- REFERENCE
];
