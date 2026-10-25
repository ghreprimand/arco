import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Pre, Note } from '../../components/UserManual/components';

export const troubleshooting: Section[] = [
  {
    id: 'diagnostics',
    group: 'Troubleshooting',
    title: 'Diagnostics tab',
    body: (
      <>
        <p>
          The <strong>System</strong> modal (the ⏻ menu in the header) has four
          tabs: <strong>Actions</strong> (RESTART / QUIT),{' '}
          <strong>Diagnostics</strong>, <strong>Models</strong> (Model Health,
          below), and <strong>Services</strong> (Local Services, below).{' '}
          Diagnostics is grouped, read-only status checks that answer "what's
          actually working on this machine?". The report runs on open and on{' '}
          <strong>↻ REFRESH</strong>; there is no background polling.
        </p>
        <p>Six groups:</p>
        <ul>
          <li>
            <strong>Core</strong> — data/config dir read+write, an{' '}
            <Code>events.jsonl</Code> append+read round-trip (against a throwaway
            temp file, never a real workflow log), settings-cascade parse, and
            the workflow-recovery registry.
          </li>
          <li>
            <strong>Providers</strong> — Claude CLI / Native, Codex, Gemini,
            Ollama, llama.cpp version/auth/reachability, plus
            Antigravity (not cheaply probable, so reported <Code>skipped</Code>).
          </li>
          <li>
            <strong>Local Tools</strong> — <Code>gh</Code> auth, ffmpeg, ffprobe,
            LSP servers on PATH, and node-pty (terminal) importability.
          </li>
          <li>
            <strong>Workbench</strong> — preview proxy, recall index, knowledge
            index, Cookbook hardware probe.
          </li>
          <li>
            <strong>Storage</strong> — <Code>~/.arco</Code> size (per-project{' '}
            <Code>.arco</Code> is workflow-scoped, so reported{' '}
            <Code>skipped</Code> from the global report).
          </li>
          <li>
            <strong>Security &amp; Exposure</strong> — server bind address,
            remote-access exposure, integrated-terminal / git-ops / preview-proxy
            reach, writable cwd roots, provider-credential and local-model-endpoint
            exposure. These flow into the shareable support bundle, so they bite
            on misconfiguration.
          </li>
        </ul>
        <Note>
          Status colours: <strong>OK</strong> works; <strong>WARN</strong>{' '}
          degraded or an optional dependency is absent (e.g. ffmpeg or the TS
          language server not installed); <strong>ERROR</strong> something that
          should work doesn't; <strong>SKIPPED</strong> not probed on this
          platform/config. A probe that throws is reported as an error with its
          message — it never crashes the report.
        </Note>
        <p>
          <strong>Copy support bundle.</strong> The button beside REFRESH copies
          a paste-ready, <strong>redacted</strong> text snapshot — the
          diagnostics report plus Arco version, git rev, platform, and runtime
          (node version + best-effort service mode) — suitable for an issue or
          another agent. Redaction follows a safe-field <strong>allowlist</strong>{' '}
          (never a denylist): the bundle is assembled from hand-picked fields
          only, every free-text detail/hint has its home path collapsed to{' '}
          <Code>~</Code> and any other absolute path reduced to a{' '}
          <Code>&lt;path&gt;/basename</Code> placeholder, and a final secret-scrub
          replaces any token-shaped string (GitHub/OpenAI/Anthropic keys, Bearer
          headers, JWTs, long hex/base64 runs) with <Code>&lt;redacted&gt;</Code>.
          It contains <strong>no</strong> tokens, env secrets, auth material, or
          private directory layouts. If the browser blocks clipboard access (an
          insecure context), the text drops into a selectable box to copy by hand.
        </p>
        <p>
          <strong>Code-skew check.</strong> Prod runs the compiled build (
          <Code>node server/dist/index.js</Code>), which does not watch source — so
          a commit you can see in <Code>git log</Code> is not live until you rebuild
          and restart. The Core check <Code>core.code-skew</Code> snapshots the git
          HEAD the running build booted from and compares it to the on-disk HEAD,
          reporting <strong>WARN</strong> ("running build is N commits behind on-disk
          HEAD") when the running dist is stale. The fix is <Code>npm run build</Code>{' '}
          + <Code>systemctl --user restart arco.service</Code>. Under the{' '}
          <Code>tsx watch</Code> dev runtime source is already live, so the check
          reports <Code>skipped</Code>.
        </p>
        <Note>Code-skew compares Git revisions captured at startup, not compiled
          file contents. Committing an already-deployed change or changing only
          documentation can produce a warning without an undeployed runtime fix.
          Check build/deploy records before restarting active workers.</Note>
        <p>
          <strong>Model Health tab.</strong> A third System-modal tab (
          <strong>MODELS</strong>) answers the model-operator question "what can I
          run now / what's running / what failed last time / is my config stale?".
          It is a richer, structured sibling of Diagnostics — three subsystems,
          each with a roll-up status and concrete fields:
        </p>
        <ul>
          <li>
            <strong>Ollama</strong> — resolved base URL, reachability, installed
            models (count + names + capability hints), and the daemon version when
            cheap. A daemon that isn't running is <strong>WARN</strong>, not error.
          </li>
          <li>
            <strong>llama.cpp</strong> — the <Code>llama-server</Code> binary path,
            registered loadouts (<Code>~/.arco/llamacpp.json</Code>), the
            lifecycle-manager state, the loaded alias/port/pid, the{' '}
            <strong>last launch args</strong>, and a tail of{' '}
            <Code>~/.arco/llamacpp.log</Code> (the last stderr). A failed last
            launch is the one <strong>ERROR</strong> case — and when it fails, Model
            Health runs a deterministic diagnosis over the stderr tail and names a
            likely <strong>cause</strong> (port-in-use, gguf-missing, ctx-too-large,
            OOM, binary-missing, or unsupported-arch) with plain-text suggestions and{' '}
            <strong>one-click fixes</strong> that write straight into the catalog
            editor's ctx / ngl / extraArgs fields (e.g. halve the context, offload
            fewer GPU layers, serve on another port). It is an ordered regex pass,
            not a model verdict: readable and reviewable.
          </li>
          <li>
            <strong>Cookbook</strong> — the detected hardware profile (backend /
            VRAM / RAM / cores / GPUs), downloaded GGUFs under{' '}
            <Code>~/.arco/models</Code>, and{' '}
            <strong>fit-score mismatch warnings</strong> — registered loadouts that
            won't fit this hardware on GPU at a useful context (scored with the
            same engine the Cookbook catalog uses). A mismatch is an actionable{' '}
            <strong>WARN</strong>, never an error.
          </li>
        </ul>
        <Note>
          The Model Health panel is read-only and operator-triggered — it fetches
          on open + Refresh and <strong>never spawns a model</strong>, mutates a
          catalog, or changes the llama.cpp manager lifecycle. The last-launch-args
          field is additive metadata the manager retains on its existing spawn
          path; the stderr tail is a read of the existing log file.
        </Note>
        <p>
          <strong>Services tab.</strong> A fourth System-modal tab
          (<strong>SERVICES</strong>) is a machine-wide browser of the local
          listening web/dev services Arco discovers (it lives here, not in the
          per-workflow right panel, because it's project-agnostic). Compact rows
          show each service; click to expand to cmdline / cwd / pid / host. It
          fetches on open + REFRESH with a ~5s auto-poll while open. The one
          mutation is a two-step <strong>KILL</strong> (server-guarded SIGTERM).
          You can <strong>pin</strong> a service (by stable cwd+port identity, so a
          pinned-but-dead one shows as an offline row) and{' '}
          <strong>Open in Live Preview</strong> to bind a service's port to the
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
        <p>If a tab gets stuck in the busy state with no apparent activity:</p>
        <ol>
          <li>
            Click <strong>cancel</strong> in the chat header. The server's{' '}
            <Code>handleCancel</Code> unconditionally broadcasts{' '}
            <Code>turn_cancelled</Code> +<Code>primary_turn_ended</Code> even if the
            worker has gone "ghost" (silently exited mid-turn). This is the
            standard escape hatch.
          </li>
          <li>
            If cancel doesn't unstick it, click <strong>Handoff</strong>. That writes
            a fresh-summarizer doc against the rendered transcript and rotates to a
            new session.
          </li>
          <li>
            Last resort: <strong>RESTART</strong> from the ⏻ menu. Workflows
            persist; on reboot the client rehydrates from{' '}
            <Code>events.jsonl</Code>.
          </li>
        </ol>
        <p>
          <strong>Stuck-worker breaker.</strong> If a worker repeats the{' '}
          <em>identical failing</em> tool call with no progress, the breaker fires.
          It is deterministic (a counter, not a model judgement): the same{' '}
          <Code>toolName | inputHash | outputHash</Code> signature 3× in a row
          surfaces a one-time nudge notice (escalation <Code>detected</Code>); at 5×
          it recommends a reversible <strong>pause</strong> (escalation{' '}
          <Code>persist</Code>). It emits a <Code>worker_stuck</Code> event plus a
          chat <Code>system_notice</Code> reading <Code>Stuck-worker breaker: …</Code>.
          It <strong>never kills or re-prompts the worker itself</strong> — you act
          on the signal. A single successful tool call (or your next turn) clears the
          latch (escalation <Code>recovered</Code>). The breaker is cross-provider
          (Claude Native + Codex); the in-turn tool-loop guardrail is the tighter
          same-turn sibling.
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
          <Code>reviewSafeMode</Code> is a per-tab CONFIG flag, default{' '}
          <strong>OFF</strong>, <strong>Claude Native only</strong> in v1. When on, a
          sensitive tool call parks behind a <Code>gate_required</Code> approval card
          (the GateApprovalNotice). To recover a parked gate: <strong>approve</strong>,
          <strong> edit-then-approve</strong>, or <strong>reject</strong> from the
          card — or use "approve all like this" to record a standing approval (it
          re-evaluates against the non-lossy signature, and the set lives in the
          CONFIG list where you can revoke it).
        </p>
        <Note>
          Across a server restart the parked in-process tool-loop is gone, so the
          card re-surfaces (<Code>gate_required</Code> re-emitted on first rehydrate)
          but an approve <strong>re-issues the action as your next-turn input</strong>{' '}
          — an honest re-run, not a seamless continuation. If the gate looks stuck
          after a restart, that is expected: act on the re-surfaced card.
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
          When a turn went wrong, the <strong>HISTORY</strong> tab's{' '}
          <strong>REWIND CONVERSATION</strong> action (on transcript rows; the{' '}
          <strong>REWINDS</strong> filter preset lists prior forks) moves the live
          head back to an earlier point. It is a two-click confirm (
          <Code>CONFIRM REWIND ↩</Code>) that emits a{' '}
          <Code>revert_to_point_request</Code>. It is reversible — the current branch
          is kept and can be returned to, and undoing a rewind is just another
          rewind. <strong>Claude Native only</strong> in v1; rewind is rejected on
          CLI/Codex. Cancel any in-flight turn first.
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
        <p>The header pill is a three-state indicator:</p>
        <ul>
          <li><strong>● ONLINE</strong> — WS connected, all persisted workflows have replayed. Normal.</li>
          <li>
            <strong>● SYNCING…</strong> — WS up, but at least one workflow is still
            waiting for its <Code>workflow_state_snapshot</Code>. Brief, usually
            invisible. The full-screen SYNCING overlay only fires for first-load
            rehydration.
          </li>
          <li>
            <strong>● OFFLINE</strong> — WS down. The <Code>RECONNECT</Code> button
            forces a new connection attempt; otherwise Arco retries with backoff.
          </li>
        </ul>
        <p>
          The client persists <Code>lastSeq</Code> per workflow to localStorage.
          On reconnect, it sends <Code>rehydrate_workflows</Code> with each seq;
          the server replays anything <Code>&gt; lastSeq</Code> from disk and then
          sends a fresh snapshot. Saved conversation events replay across drops; transient telemetry is not durable. Incognito has only a brief in-memory reconnect grace, never disk recovery.
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
          Arco refuses to run two browser tabs against the same server. The second
          tab gets a full-screen <strong>Duplicate Tab</strong> overlay. The reason:
          two tabs would both rehydrate the same persisted workflows on connect,
          fighting over observer state and confusing the server-side WS handler.
        </p>
        <p>
          Implementation: <Code>BroadcastChannel</Code> handshake at boot. If the
          first tab is responsive, the second tab declines to mount. Close the
          original tab to take over.
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
          If you see a system notice like:
        </p>
        <Pre>{`[WARN] Concurrent writer detected on session <uuid>.
New turns blocked for 60s. Recover via Handoff.`}</Pre>
        <p>
          A <Code>claude --resume &lt;uuid&gt;</Code> (or similar) is appending to
          the same session JSONL Arco has open. Arco detects this via the{' '}
          <Code>entrypoint</Code> field on each new entry — anything other than{' '}
          <Code>sdk-cli</Code> trips the guard.
        </p>
        <p>To recover:</p>
        <ol>
          <li>Close the foreign terminal session (or wait for it to settle).</li>
          <li>Click <strong>Handoff</strong>. The new session is yours alone.</li>
        </ol>
        <Note>
          The 60-second cooldown is intentional — interleaved writes from two
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
        <p><strong>"Provider not in workflow creator"</strong></p>
        <ul>
          <li>Check Settings — is the provider toggled on?</li>
          <li>Check Settings — is the provider authed (LIVE chip)?</li>
          <li>For Antigravity: is the desktop binary at <Code>/opt/antigravity/antigravity</Code> (or <Code>ANTIGRAVITY_BINARY</Code>)?</li>
          <li>For Ollama: is the daemon running on <Code>OLLAMA_URL_BASE</Code>?</li>
        </ul>
        <p><strong>"Tool calls don't show as inline pills"</strong></p>
        <ul>
          <li>Inline pills are Claude-only. Other providers show tool calls in the ACTIVITY tab.</li>
        </ul>
        <p><strong>"CTX bar shows ○ instead of ●"</strong></p>
        <ul>
          <li>Claude — calibration hasn't run yet for this session. It runs on idle moments crossing zone thresholds, or click the CTX cluster to recalibrate now.</li>
          <li>Codex — the session hasn't yet emitted a token snapshot with <Code>model_context_window</Code>. Until then, the denominator uses the selected account/model catalog and the tab's MAX or STANDARD policy.</li>
        </ul>
        <p><strong>"Antigravity is unavailable"</strong></p>
        <ul>
          <li>Confirm the desktop app is launched, or that the binary exists at <Code>ANTIGRAVITY_BINARY</Code>.</li>
          <li>The default Arco profile is isolated. Use <Code>ANTIGRAVITY_USE_DEFAULT_PROFILE=1</Code> for the normal signed-in subscription-backed profile.</li>
          <li>Restart from the launcher after external env changes; in-app restart inherits the current server env.</li>
        </ul>
        <p><strong>"My MCP server can't authenticate / is missing an API key"</strong></p>
        <ul>
          <li>
            Spawned MCP children (npx/uvx) no longer inherit Arco's environment —
            the Claude OAuth token, GitHub PAT, and other host secrets are withheld
            (H20 security floor). A child sees only an allowlisted base env
            (PATH/HOME/SHELL, locale, temp dir, XDG_*) plus the keys you declare in
            that server's <Code>env</Code> block in the MCP registry entry. If a
            server needs a secret, add it explicitly to its <Code>env</Code> — that
            is the intended secret channel.
          </li>
        </ul>
        <p><strong>"process tree exceeded 32 GB RSS safety cap"</strong></p>
        <ul>
          <li>Something the agent ran (a recursive find, a huge build, a runaway test) ballooned memory. The kill is intentional.</li>
          <li>If your project legitimately needs &gt;32 GB, opt out of the RSS guard from CONFIG for that workflow specifically (or shrink/raise the cap with <Code>ARCO_RSS_KILL_BYTES</Code>).</li>
        </ul>
      </>
    ),
  },
  {
    id: 'antigravity-troubleshooting',
    group: 'Troubleshooting',
    title: 'Antigravity troubleshooting',
    body: (
      <>
        <p>
          CONFIG shows the active Antigravity RPC state: desktop reachability,
          profile mode, configured model, cascade state, CTX ownership, and
          capability flags. If the provider is down, start there.
        </p>
        <ul>
          <li><strong>App not launched / binary path:</strong> launch Antigravity or set <Code>ANTIGRAVITY_BINARY</Code>.</li>
          <li><strong>Wrong profile or not signed in:</strong> isolated profile is the default; use <Code>ANTIGRAVITY_USE_DEFAULT_PROFILE=1</Code> for your normal signed-in profile, or sign in to the custom <Code>ANTIGRAVITY_USER_DATA_DIR</Code>.</li>
          <li><strong>Wrong model:</strong> use <Code>ANTIGRAVITY_RPC_MODEL=gemini-3-flash-agent</Code> for Gemini 3.5 Flash High.</li>
          <li><strong>Env changes:</strong> in-app restart does not pick up external shell exports; restart the server from the launcher or owning shell.</li>
          <li><strong>Debug port:</strong> <Code>ANTIGRAVITY_CDP_PORT</Code> is liveness only, not prompt transport.</li>
          <li><strong>Unbridged tool timeout:</strong> <Code>waiting_unbridged_tool</Code> then <Code>timed_out</Code> means model access worked but a tool step was opaque to Arco.</li>
          <li><strong>Path-only attachments:</strong> uploads are local paths, not native Antigravity image/file message parts.</li>
          <li><strong>Artifacts partial:</strong> text artifacts appear as <Code>[artifact:&lt;name&gt;]</Code>; images surface as copied paths/file-viewer targets. Generated-image RPC shape is unproven.</li>
          <li><strong>Clusters disabled:</strong> Antigravity cannot be added as a cluster member yet.</li>
        </ul>
      </>
    ),
  },

  // -------------------------------------------------------------- REFERENCE
];
