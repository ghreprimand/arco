import { DocRef } from '../../components/help/DocRef';
import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Note, Table } from '../../components/UserManual/components';

export const providers: Section[] = [
  {
    id: 'providers-overview',
    group: 'Providers',
    title: 'Choosing a provider',
    body: (
      <>
        <p>
          Eight providers ship for Agent workflows, with different transports,
          session resume, authentication and capabilities. Chat has a smaller
          provider set; Incognito narrows it further (see Chat in Workflows & sessions).
        </p>
        <Table
          headers={['Provider', 'Transport', 'Resume', 'Tool use', 'Reasoning', 'Effort levels']}
          rows={[
            ['Claude', <>cli subprocess or native <Code>@anthropic-ai/sdk</Code></>, 'UUID', 'rich', 'yes', '5'],
            ['Codex', <>exec subprocess or long-lived <Code>app-server</Code></>, 'thread_id', 'yes', 'yes', 'model-dependent; Astra up to ultra'],
            ['Cursor', <>ACP (<Code>cursor-agent acp</Code>, JSON-RPC over stdio)</>, 'session/load', 'yes (fs + permission callbacks)', 'model-dependent', 'baked into model id'],
            ['Ollama', 'HTTP', 'none (transcript replay)', 'yes (server-side allowlist)', 'model-dependent', 'none'],
            ['llama.cpp', 'HTTP (singleton llama-server)', 'none (transcript replay)', 'yes (OpenAI-format + XML fallback)', 'model-dependent', 'none'],
            ['DeepSeek / Xolotl', 'HTTP (guarded user service)', 'none (transcript replay)', 'yes (Chat web-only)', 'yes', 'none, low, medium, high'],
            ['Strata', 'HTTP (standalone OpenAI-compatible /v1)', 'none (transcript replay)', 'yes (local allowlist; Chat web-only)', 'yes', 'none, low, medium, high'],
            ['LM Studio', 'HTTP (OpenAI-compatible /v1, configurable endpoint)', 'none (transcript replay)', 'yes (reuses local allowlist)', 'model-dependent', 'none'],
          ]}
        />
        <Note kind="tip">
          The most common operator pattern: <strong>Claude as primary</strong>, with
          Codex for cross-family review. Pick the family that
          tends to disagree most usefully with your primary.
        </Note>
      </>
    ),
  },
  {
    id: 'provider-claude',
    group: 'Providers',
    title: 'Claude',
    body: (
      <>
        <p>
          Claude ships with two transports. New homes default to{' '}
          <Code>native</Code>, a long-lived in-process worker using{' '}
          <Code>@anthropic-ai/sdk</Code> with Claude-Code-compatible OAuth
          headers, Arco-owned tools, mid-turn steer, hooks, plan-mode, Task
          fan-out, and context-management controls. <Code>cli</Code> is the
          per-turn <Code>claude</Code> subprocess with full Claude Code feature
          surface and two-way terminal interop. Saved transport choices are kept.
        </p>
        <p>
          <strong>Models.</strong> The picker carries the family aliases (<Code>haiku</Code>,{' '}
          <Code>sonnet</Code>, <Code>opus</Code> = OPUS LATEST) plus pinned versions:
          Fable 5.1 / 5, Sonnet 5, Opus 5.5 / 5 / 4.8 / 4.7 / 4.6 and OPUS 1M. Opus 5.5
          (1M context, five effort levels) and Fable 5.1 use preserved thinking on
          Native: the request prefix is frozen per worker and config changes are
          appended as system notes rather than rebuilding it. Effort is always sent
          explicitly.
        </p>
        <p>
          <strong>Auth:</strong> CLI transport uses <Code>claude auth login</Code>,
          run in Arco's terminal (it prints a URL and a paste-code prompt, so it
          works from any device); API-key fallback if <Code>ANTHROPIC_API_KEY</Code>{' '}
          is set. Native uses Arco's in-app Claude Native OAuth flow and stores
          tokens under <Code>~/.arco/auth.json</Code>. Its approval redirects to{' '}
          <Code>localhost:53692</Code>, which only resolves when your browser is on the
          Arco machine — from another device, copy the "can't connect" page's URL
          into the paste box.
        </p>
        <p><strong>Quirks worth knowing:</strong></p>
        <ul>
          <li>
            <strong>Transport toggle.</strong> Per-tab in CONFIG, with cascade
            defaults in Settings. Reviewers and handoff seeds always run on{' '}
            <Code>cli</Code>; Native workers are disposed after handoff so the
            next turn rebuilds from the post-handoff transcript.
          </li>
          <li>
            <strong>Ultracode (sticky, CLI-only).</strong> A CONFIG toggle (or
            the <Code>⚡ ULTRACODE</Code> box at tab creation) that puts the tab in
            the same deep multi-agent mode as <Code>ultracode</Code> in the Claude
            CLI: each turn Claude authors a <Code>Workflow</Code> that fans out a
            background subagent fleet. The harness WorkflowTool exists only in the{' '}
            <Code>claude</Code> binary — Native's raw SDK can't host it — so
            ultracode forces the <Code>cli</Code> transport and pins{' '}
            <Code>xhigh</Code>, restoring your base transport when turned off. A
            background workflow emits an early "launched" result then the real
            synthesis; Arco holds intermediates and settles the turn on the
            final synthesis at process exit. Because the fleet runs in the
            background — invisible to the normal Activity stream — the{' '}
            <Code>ACTIVITY</Code> tab grows a live <Code>⚡ FLEET</Code> panel
            (agent count + per-subagent task/last-tool) while a fan-out runs.
            Operator-armed, reversible, logged — but it runs a fleet unattended
            with full access and spends heavily. See{' '}
            <Code>docs/PROVIDERS.md</Code>.
          </li>
          <li>
            <strong>Native hooks.</strong> Native walks project and user{' '}
            <Code>.claude/settings.json</Code> hook files and runs Claude-Code-style
            hooks (<Code>PreToolUse</Code>, <Code>PostToolUse</Code>,{' '}
            <Code>UserPromptSubmit</Code>, <Code>Stop</Code>, <Code>SubagentStop</Code>,
            <Code>Notification</Code>, <Code>PreCompact</Code>).
          </li>
          <li>
            <strong>API overload retry loop</strong> — <Code>overloaded_error</Code>{' '}
            envelopes are caught, surfaced as a system notice, and retried with
            15s/30s/60s backoff up to 3 attempts. Same session id, idempotent. When
            the server sends a timing hint the parsed header takes precedence over
            this fixed ladder (see below).
          </li>
          <li>
            <strong>Rate-limit header parsing (H10, Native).</strong> Native sets the
            Anthropic SDK's <Code>maxRetries</Code> to 0 — Arco's ladder is the only
            retry path, with no hidden internal double-retry — and reads the server's
            own <Code>retry-after</Code> / <Code>anthropic-ratelimit-*-reset</Code>{' '}
            timing hints to size the wait, capped at 5 minutes
            (<Code>MAX_RATE_LIMIT_WAIT_MS</Code>). The 15s/30s/60s ladder is the
            fallback only when no header is present.
          </li>
          <li>
            <strong>Tool postures (Native-only).</strong> A per-tab posture pill
            scopes which Arco tools the model sees: <Code>full</Code> (no filtering,
            the default), <Code>coding</Code> (full local toolset minus web research),{' '}
            <Code>review</Code> (Read / Grep / Glob / Bash / TodoWrite /
            AskUserQuestion — no mutation, no Task fan-out, no web), and{' '}
            <Code>chat</Code> (Read / Grep / Glob / TodoWrite / AskUserQuestion only).
            The keep-sets in <Code>toolPosture.ts</Code> are deterministic; dynamic
            opt-in tools (<Code>mcp__*</Code> / <Code>peer_*</Code> /{' '}
            <Code>ctx_*</Code>) are never stripped by a posture.
          </li>
          <li>
            <strong>Throttle detection</strong> — stderr regex catches "usage limit
            reached" messages and surfaces them in the QuotaBadge with a reset time.
          </li>
          <li>
            <strong>Output cap</strong> — 50 MB per turn by default. Beyond that you'll see a
            truncation notice and the worker is forced to settle.
          </li>
          <li>
            <strong>Image attachments</strong> — sent as native stream-json content
            blocks. Other files are referenced by path in the prompt text.
          </li>
          <li>
            <strong>Native web research.</strong> Claude Native advertises Anthropic
            server tools (<Code>web_search</Code> / <Code>web_fetch</Code> plus the
            required server-side code-execution descriptor), not Arco's local
            SearXNG/Camoufox WebSearch/WebFetch implementation. Anthropic runs those
            calls inside the Messages API. Retention is model-dependent: Fable/Mythos
            5.1 and Opus 5.5 keep thinking and the frozen request prefix. Other models can prune
            completed evidence, but never mutate the latest assistant message or
            remove a server-tool call referenced by its protected result.
          </li>
          <li>
            <strong>Native CTX accounting.</strong> The footer's <Code>CTX</Code> is
            retained next-turn context, measured with <Code>messages.countTokens()</Code>
            after those retention rules. The Activity tab can show much larger{' '}
            <Code>prompt</Code> / <Code>cache-read</Code> / <Code>cache-write</Code>
            numbers on server-web-tool turns because those are provider processing
            telemetry, not conversation footprint.
          </li>
          <li>
            <strong>Concurrent-writer guard</strong> — see <em>Native sessions &amp;
            resume</em>.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'provider-codex',
    group: 'Providers',
    title: 'Codex',
    body: (
      <>
        <p>
          OpenAI's Codex CLI. Frontier-tier reasoning, native thread_id resume,
          and two transports: <Code>exec</Code> (per-turn subprocess) and{' '}
          <Code>app-server</Code> (long-lived per-tab JSON-RPC child, the default
          for new Arco homes).
        </p>
        <p><strong>Auth:</strong> via <Code>codex login</Code>. API-key fallback if <Code>OPENAI_API_KEY</Code> is set.</p>
        <p><strong>Models &amp; effort.</strong> Arco's default is <Code>gpt-6-astra</Code>.
          GPT-6 also ships <Code>gpt-6-sol</Code> (the everyday coding workhorse) and
          <Code>gpt-6-luna</Code> (fast and affordable). The picker uses the selected
          model's live catalog: Astra and Sol offer low / medium / high / xhigh / max /
          ultra, Luna stops at max, and older models can expose fewer levels. Codex tabs default to the selected account/model's live MAX
          context value (currently about 828K effective for Astra); CONFIG can return
          a tab to STANDARD (about 258K). A provider-reported window takes precedence.</p>
        <Note kind="warn">Codex describes ultra as maximum reasoning with automatic
          task delegation. Provider-internal delegated-agent activity is not fully
          represented in Arco's transcript. Choosing it does not create an Arco
          cluster or grant a new Arco orchestration surface.</Note>
        <p><strong>Sandbox modes:</strong></p>
        <ul>
          <li><Code>read-only</Code> — reviewers always force this. Reads only.</li>
          <li><Code>workspace-write</Code> — full read + write within cwd. The default for primaries.</li>
          <li><Code>danger-full-access</Code> — no sandboxing. Use only when you understand the implications.</li>
        </ul>
        <p><strong>Quirks worth knowing:</strong></p>
        <ul>
          <li>
            <strong>Resume mode is narrower.</strong> <Code>codex exec resume</Code>{' '}
            doesn't accept <Code>--color</Code>, <Code>-s</Code>, <Code>-C</Code>, or{' '}
            <Code>--add-dir</Code>. Arco drops them on resume; sandbox maps to{' '}
            <Code>--full-auto</Code> or <Code>--dangerously-bypass-approvals-and-sandbox</Code>.
          </li>
          <li>
            <strong>App-server transport.</strong> CONFIG can switch a tab from{' '}
            <Code>exec</Code> to <Code>app-server</Code>. App-server supports
            structured <Code>turn/interrupt</Code> cancel, non-destructive{' '}
            <Code>turn/steer</Code> mid-turn input, local image attachments, and a
            crash-recovery circuit breaker. It also captures blocking and async
            questions: answer inline or open the composer’s <strong>? QUESTIONS</strong>
            button. Options retain descriptions and you can type an answer when
            offered. Async questions let the agent continue; answers sent after
            a turn ends start a normal operator turn. Cancelled/expired questions
            close automatically. <Code>exec</Code> has no interactive reply bridge.
            Reviewers and handoff seeds always run
            on <Code>exec</Code> regardless of the tab default.
          </li>
          <li>
            <strong>thread_id capture.</strong> First-turn thread_id arrives in the{' '}
            <Code>thread.started</Code> init event. Arco mints a placeholder UUID
            for <Code>meta.cliSessions[]</Code> immediately, then reconciles in place
            once the real id arrives.
          </li>
          <li>
            <strong>Token semantics.</strong> Codex's <Code>cached_input_tokens</Code>{' '}
            is a SUBSET of <Code>input_tokens</Code>, not additive. Arco's CTX bar
            handles this correctly — but if you cross-reference token counts in the
            CLI itself, don't add the two.
          </li>
          <li>
            <strong>Reasoning tokens roll forward.</strong> High-effort GPT-5.x turns
            put significant tokens in hidden reasoning. They accumulate into the next
            turn's prompt — Codex session ctx grows faster than visible chat would
            suggest.
          </li>
          <li>
            <strong>Auto-handoff uses rollout snapshots.</strong> Arco reads the
            latest per-call token snapshot before checking thresholds, so a native
            compact or short follow-up does not fire from the previous turn's stale
            context percentage.
          </li>
        </ul>
      </>
    ),
  },
  {
    id: 'provider-cursor',
    group: 'Providers',
    title: 'Cursor (ACP · ~153 models incl. Grok)',
    body: (
      <>
        <p>
          Cursor's metered subscription fronts ~153 models — Grok 4.5, GPT-5.x,
          Claude, GLM, Kimi — under one login. Arco drives it through{' '}
          <Code>cursor-agent acp</Code> (ACP = Agent Client Protocol, real JSON-RPC 2.0
          over stdio), cloned from the Codex <Code>app-server</Code> mechanics: a
          long-lived in-process worker plus a per-turn wrapper. Badge letter{' '}
          <Code>R</Code> (C and X are taken).
        </p>
        <p><strong>Auth:</strong> <Code>cursor-agent login</Code> stores a cursor.com
          session JWT at <Code>~/.config/cursor/auth.json</Code> (auto-refreshed).
          Arco's auth probe reads it fresh, but an already-running ACP child can
          retain old credentials. A recognized sign-in failure now shows a re-login
          card and retires that child. Log in, then resend; the next turn creates a
          fresh worker and resumes the session where Cursor supports it.</p>
        <p><strong>Models &amp; effort.</strong> The full roster comes from a live{' '}
          <Code>cursor-agent models</Code> catalog (<Code>GET /api/cursor/catalog</Code>,
          1h server cache, 30-min client poll). <Code>auto</Code> is the default. Cursor
          bakes reasoning effort <em>into the model id</em> (<Code>-low</Code> /{' '}
          <Code>-high</Code> / <Code>-xhigh</Code> / <Code>-max</Code>), so the picker is a
          two-part <strong>family × effort</strong> control (with optional{' '}
          <strong>FAST</strong> / <strong>THINK</strong> toggles). It only offers
          combinations the catalog actually advertises and resolves to the exact id —
          it never synthesizes one, so you can't accidentally send <Code>xhigh</Code>
          when you picked <Code>high</Code>. <Code>auto</Code> hides the effort control
          (Cursor's router picks model <em>and</em> effort). The status chip reads the
          effort back out of the resolved id, so it always shows the true tier.</p>
        <p><strong>ACP is bidirectional.</strong> Unlike the Codex app-server, the agent
          calls back mid-turn (<Code>fs/read_text_file</Code>,{' '}
          <Code>fs/write_text_file</Code>, <Code>session/request_permission</Code>,{' '}
          <Code>terminal/*</Code>); the worker answers these or the turn hangs.
          Permissions are auto-approved in the current transport.</p>
        <p><strong>Steer, cancel, resume, live model-swap.</strong> Type mid-turn and the
          message is queued and dispatched as a follow-up the moment the turn finishes
          (output-preserving — Cursor's native barge-in is not used). Cancel sends{' '}
          <Code>session/cancel</Code> and hard-kills after 5s if it doesn't settle.
          Reopening a tab resumes the prior ACP session via <Code>session/load</Code>
          (falls back to a fresh session with a notice if the id is gone). Changing the
          model in CONFIG swaps it <em>in-session</em> via <Code>session/set_model</Code>{' '}
          with no respawn — you'll see a "model swapped" notice on the next turn.</p>
        <p><strong>North-star.</strong> A per-tab NORTH STAR objective (CONFIG or{' '}
          <Code>/goal</Code>) folds into every Cursor turn's prompt above the request, the
          same steering context the other providers get — pure context, no model authority.
          The cluster plan/role fold now takes effect too, since Cursor can join clusters.</p>
        <p><strong>Cluster member.</strong> A Cursor tab can be a full cluster member in any
          role, at any model (Auto or any frontier id) — it exchanges notes with peers via{' '}
          <Code>peer_list</Code> / <Code>peer_send</Code> / <Code>peer_read</Code> and the shared
          task board, same as a Claude or Codex member. One caveat: add a Cursor member when you{' '}
          <em>create</em> the cluster, or via the members panel's <em>fresh-spawn</em> button — an
          existing standalone Cursor tab can't be pulled into a cluster (its underlying session is
          fixed at start; a fresh member gets the peer tools wired in from the first turn).</p>
        <p><strong>Primitives are read-only.</strong> When you run Review (or a
          fresh-summarizer Handoff, DOCS, research, compare) on a Cursor tab, the reviewer
          runs as a throwaway <Code>cursor-agent -p --mode ask</Code> process — a separate,
          read-only Q&A session, <em>not</em> your live tab. It can read the codebase to
          ground its answer but cannot write or run shell, and it never touches the transcript
          of the tab you launched it from.</p>
        <p><strong>Usage.</strong> The ACP stream carries no token counts, so the header{' '}
          <Code>R</Code> dot is live-status only; billed MTD $/token detail lives on the
          Cursor dashboard (Arco's authed poll at <Code>/api/cursor-usage</Code>
          attributes spend per-workflow via the ACP <Code>sessionId</Code>).</p>
        <p><strong>Context management.</strong> Cursor automatically summarizes older
          history as its context fills, but ACP exposes no trustworthy retained-token
          count, so the composer says <Code>CTX: Cursor-managed</Code> instead of inventing
          a percentage. Use <Code>⊟ COMPACT</Code> (or type <Code>/compress</Code>) to run
          Cursor's native compression command against the live ACP session. Arco sends
          it without the normal cluster/north-star prefix so the slash command remains
          recognizable. <Code>HANDOFF</Code> remains the clean-session escape hatch.</p>
        <Note kind="tip">
          Grok 4.5 in an Arco tab is just Cursor with the model set to a{' '}
          <Code>grok-4.5-*</Code> id — the same picker holds every frontier family.
        </Note>
        <Note kind="warn">
          Shipped: spawnable primary + full model picker + badge R + steer, cancel, session
          resume, live model-swap (<Code>session/set_model</Code>, no respawn), the north-star
          system-prompt fold, read-only reviewer/handoff/DOCS primitives (the{' '}
          <Code>cursor-agent -p --mode ask</Code> print path), and <strong>cluster membership</strong>{' '}
          (peer tools ride an in-process loopback MCP, since Cursor honors MCP over http/sse only —
          which also lights up the cluster-plan fold), and the Usage-tab card — a polled
          month-to-date spend card plus the <em>Included in Pro</em> allocation gauge (fed by{' '}
          <Code>/api/cursor-usage</Code>). Hovering the header's <Code>R</Code> status dot shows
          a compact version with two bars: the included-plan gauge (Cursor's blended{' '}
          <Code>totalPercentUsed</Code>) and the separate <em>Other Models</em> quota
          (<Code>apiPercentUsed</Code>) — both are Cursor's own numbers, never reconstructed
          from local token totals. All Cursor transports now ship — see{' '}
          <Code>docs/PROVIDERS.md</Code>.
        </Note>
      </>
    ),
  },
  {
    id: 'provider-ollama',
    group: 'Providers',
    title: 'Ollama (local models)',
    body: (
      <>
        <p>
          Local-first. No subscription, no rate limits, no remote calls — but bound
          by your own GPU/RAM and the capabilities of the models you've pulled.
        </p>
        <p><strong>Auth:</strong> none. Arco probes the daemon on{' '}
          <Code>OLLAMA_URL_BASE</Code> (default <Code>http://localhost:11434</Code>).
          The header LIVE/READY chip indicates whether a model is currently loaded.</p>
        <p><strong>Built-in tool runtime.</strong> Ollama's HTTP API is stateless —
          when the model emits tool_calls, the <em>caller</em> executes them and
          feeds results back. Arco implements a server-side tool loop with these
          tools:</p>
        <Table
          headers={['Tool', 'Notes']}
          rows={[
            [<Code key="r">Read</Code>, '32 KB byte cap, refuses directories. Chunk via offset/limit for larger files.'],
            [<Code key="g">Glob</Code>, 'Node 22 fs.promises.glob. Cwd-rooted.'],
            [<Code key="gr">Grep</Code>, 'POSIX walk; skips node_modules / .git / dist / .arco. 64 KB output cap.'],
            [<Code key="w">Write</Code>, 'mkdir -p parents. Refuses to clobber a directory.'],
            [<Code key="b">Bash</Code>, '/bin/sh -c in cwd. 60s default timeout, 600s ceiling. Combined stdout+stderr capped at 64 KB.'],
            [<Code key="ws">WebSearch</Code>, <>Hits operator's local SearXNG (<Code>ARCO_SEARXNG_URL</Code>, default <Code>http://127.0.0.1:8888</Code>). Bang syntax (<Code>!g foo</Code>) routes engines.</>],
            [<Code key="wf">WebFetch</Code>, <>Native <Code>fetch()</Code> fast path, Camoufox stealth fallback for Cloudflare-gated pages. SSRF guard blocks loopback/RFC1918.</>],
          ]}
        />
        <p><strong>AUTO vs SAFE:</strong> AUTO mode (the primary's default) executes
          tools server-side. SAFE mode returns a denial string the model sees as the
          tool result — the loop converges without an operator-approval surface, and
          you can cancel mid-turn at any time.</p>
        <p><strong>Limitations to keep in mind:</strong></p>
        <ul>
          <li>
            <strong>Smaller context windows.</strong> Most local models have 32K–128K
            windows; the CTX bar reports them honestly.
          </li>
          <li>
            <strong>No native session resume.</strong> The transcript is replayed each
            turn; Ollama's prefix cache makes this cheap as long as the prefix is
            byte-stable. Sampler / num_ctx overrides are intentionally NOT plumbed —
            they'd invalidate the cache. Configure these in your Modelfile instead.
          </li>
          <li>
            <strong>Current local baseline.</strong> Qwen3.6-27B is the expected
            high-context local coding model: tool use, image attachments, 262K
            context, and Camoufox-backed WebFetch/WebSearch when configured.
          </li>
          <li>
            <strong>Mid-turn steer.</strong> Ollama uses Arco's own tool loop, so
            steer can land between tool-result append and the next model call.
          </li>
          <li>
            <strong>Cluster guardrails.</strong> In cluster mode, local workers
            get private recovery nudges if they stop after preparatory text or
            try to finish an assigned task without <Code>peer_send</Code>. The
            retry is bounded so a confused local model cannot loop forever.
          </li>
          <li>
            <strong>Reasoning support depends on model.</strong> Models with{' '}
            <Code>RENDERER qwen3.5</Code> / <Code>PARSER qwen3.5</Code> (qwen3-coder,
            qwen3-vl-thinking, deepseek3, gpt-oss) emit native{' '}
            <Code>message.thinking</Code>. Older models embed{' '}
            <Code>&lt;think&gt;</Code> tags in content; Arco's ThinkSplitter
            handles both.
          </li>
          <li>
            <strong>Reviewer slot</strong> uses a read-only allowlist (Read / Grep /
            Glob / WebSearch / WebFetch) and forces AUTO mode (so tools execute).
          </li>
        </ul>
        <Note kind="tip">
          Best use of Ollama in Arco: cheap second-opinion reviews from a different
          family (gpt-oss reviewing Claude), or fully-local primary work on a project
          where you don't want to spend subscription quota.
        </Note>
      </>
    ),
  },
  {
    id: 'provider-llamacpp',
    group: 'Providers',
    title: 'llama.cpp (local models, GGUF catalog)',
    body: (
      <>
        <p>
          Local-first like Ollama, but Arco owns the daemon. The catalog at{' '}
          <Code>~/.arco/llamacpp.json</Code> declares each loadout up front
          (alias / GGUF path / context size / GPU layers / capability flags), and a
          singleton <Code>llama-server</Code> process is spawned with the right flags
          on first use. Switching aliases mid-workflow SIGTERMs the old server and
          warms the new one.
        </p>
        <p>
          <strong>Why this exists alongside Ollama:</strong> vision-capable
          architectures often land in llama.cpp weeks before Ollama wires up the
          multimodal projector path. Qwen3.6 was the motivating case. The text-only
          ergonomic edge of Ollama is unchanged; llama.cpp is the escape hatch when
          you need a feature Ollama hasn't shipped.
        </p>
        <p><strong>Auth:</strong> none. Arco probes for the binary
          (<Code>/usr/local/bin/llama-server</Code> by default; override with{' '}
          <Code>ARCO_LLAMACPP_BIN</Code>) and confirms{' '}
          <Code>~/.arco/llamacpp.json</Code> parses cleanly. Capabilities are
          operator-declared (no <Code>--show</Code>-equivalent on llama-server).
        </p>
        <p><strong>Catalog editing.</strong> Settings panel ships a{' '}
          <Code>LlamacppCatalogEditor</Code> with per-row alias / ggufPath /
          mmprojPath / ctxSize / ngl / capability checkboxes. Per-row{' '}
          <Code>Load now</Code> pre-warms the binary so the next workflow turn
          doesn't pay the 20-30 s cold-start. <Code>Unload</Code> frees VRAM
          immediately without waiting for the idle eviction timer
          (<Code>ARCO_LLAMACPP_KEEPALIVE_MS</Code>, default 10 minutes).
        </p>
        <p>
          <strong>Mid-turn steer.</strong> Like Ollama, llama.cpp runs through
          Arco's server-side tool loop, so steer can land between tool-result
          append and the next chat-completions request.
        </p>
        <p><strong>Tool runtime.</strong> Reuses the Ollama allowlist (Read / Grep /
          Glob / Write / Bash / WebSearch / WebFetch). OpenAI fragment-assembly for
          tool calls; Qwen-style XML <Code>&lt;tool_call&gt;</Code> markup in{' '}
          <Code>reasoning_content</Code> is also recognized as a fallback so the loop
          doesn't hang when the model emits tools that way.
        </p>
        <p><strong>Auto-recovery.</strong> Local thinking models fail in specific
          ways the lifecycle alone can't handle. The provider runs four detection
          paths in-place (without spawning Handoff):</p>
        <ul>
          <li><strong>Reasoning runaway</strong> — model emits{' '}
            <Code>reasoning_content</Code> for too long without committing. Aborts
            stream, injects a coaching message that forces commitment.
          </li>
          <li><strong>Stream stall</strong> — no SSE event for{' '}
            <Code>ARCO_LLAMACPP_STALL_TIMEOUT_MS</Code> (default 90 s). Builds a
            deterministic summary (no LLM call) and continues.
          </li>
          <li><strong>Tool-cap exhaustion</strong> — 50-turn cap fires on a
            legitimately long task. Same deterministic recap, reset counter, keep
            going.
          </li>
          <li><strong>Context fill</strong> — at clean turn boundaries, when the
            input/ctxSize ratio crosses{' '}
            <Code>ARCO_LLAMACPP_COMPACT_THRESHOLD</Code> (default 0.85), asks the
            model to write a compaction summary and replaces the in-memory message
            stack with that summary. Conversation continues; tool history is dropped.
          </li>
        </ul>
        <p>
          All four paths share a budget (default 2 per operator turn). Each emits a{' '}
          <Code>system_notice</Code> so you see what happened without digging through
          logs.
        </p>
        <p>
          <strong>Serve-failure diagnosis.</strong> When a{' '}
          <Code>llama-server</Code> start fails, Arco runs a deterministic regex pass
          over the stderr tail (no model call) to name the cause — port-in-use, missing
          GGUF, context too large, out-of-memory, missing binary, or unsupported
          architecture — and offers one-click fixes that write straight into the
          catalog editor (e.g. halve <Code>ctxSize</Code>, reduce <Code>ngl</Code>, add
          an <Code>extraArgs</Code> flag). It surfaces in the model-health panel; it's a
          readable rule set, not a model verdict.
        </p>
        <Note kind="tip">
          Pair with the RUN AS picker in the GIT and DOCS buttons: tab's primary can
          be a local Qwen doing the actual coding while the one-off git/docs sweep
          dispatches to a frontier model in a freshly spawned tab.
        </Note>
      </>
    ),
  },
  {
    id: 'provider-strata',
    group: 'Providers',
    title: 'Strata — Qwen3.8 Flash Next and model switching',
    body: <>
      <p>Choose <strong>STRATA</strong> in the provider picker. It is a standalone
        inference service, separate from Ollama and LM Studio. Set its address in
        <strong> Settings → STRATA ENDPOINT</strong>; the default is{' '}
        <Code>http://127.0.0.1:8081/v1</Code>. Live discovery reports the served
        model's actual configured context and image support.</p>
      <p>The prepared local catalog offers <strong>Original · 262K</strong> and
        <strong> SC117 Abliterated · 262K</strong>, both IQ3_XXS with CPU vision
        and 262144 tokens. Click Agent's composer model chip, CONFIG → MODEL,
        or Chat's model dropdown. Your choice loads on the <strong>next
        message</strong> and retains the conversation. Only one profile is
        resident; other Strata turns wait for the current turn and tools to finish.</p>
      <p>Arco may start/switch explicitly registered loopback user services;
        their existing preflight and memory limits remain enforced. Remote or
        unregistered endpoints keep normal HTTP operation. Failed/cancelled
        switches attempt to restore the old profile. This is not an automatic
        model downloader or a promise of simultaneous residency.</p>
      <p>Streaming includes answers, reasoning and tool-call round trips.
        <Code>none</Code> disables thinking; <Code>low</Code>, <Code>medium</Code>
        and <Code>high</Code> set reasoning effort. High maps to Qwen xhigh;
        low is not thinking-off here. After a completed turn the composer shows
        decode <strong>tok/s</strong> and fresh-prefill <strong>PP</strong> when
        engine timing is available.</p>
      <p>Agent has local tools including WebSearch/WebFetch. Saved Chat's WEB
        switch exposes only that pair, with no project tools. Attach an image
        for vision. Strata is excluded from Incognito because its standalone
        service keeps logs/image caches, and it is not a cluster member.</p>
      <p><strong>FREE VRAM</strong> unloads local models after you finish/cancel
        active local work; the next message reloads them. PROVIDERS shows the
        installed Strata engine even while stopped and checks upstream engine
        component versions every four hours. Click opens release notes inside
        Arco, with manual installation; the 0.2 app version is separate. The SC117 selection is a
        compatibility/memory fit, not a measured universal quality winner.</p>
      <p>See the manual sections <strong>Strata MoE — RAM, VRAM and context</strong>
        and <strong>Strata — switching, FREE VRAM and recovery</strong>, or open
        the full runbook: <DocRef>docs/STRATA.md</DocRef>.</p>
    </>,
  },
  {
    id: 'provider-lmstudio',
    group: 'Providers',
    title: 'LM Studio (local models, OpenAI-compatible endpoint)',
    body: (
      <>
        <p>
          Local models served by the LM Studio app, reached over its{' '}
          <strong>OpenAI-compatible REST API</strong> rather than a native SDK.
          The standing verdict: LM Studio joins Arco as an HTTP endpoint
          (<Code>/v1/chat/completions</Code>, <Code>/v1/models</Code>), <em>not</em>{' '}
          via <Code>lmstudio.js</Code> — the app/engine are closed-source, so the
          REST surface reuses Arco's existing HTTP-provider plumbing and its own
          tool loop. Talk to a local install or a remote one over the network; LM
          Studio's app handles JIT model loading on its side.
        </p>
        <p><strong>Auth:</strong> none. Arco probes the configured base URL.
          The cascade is settings (<Code>lmstudio.baseUrl</Code>) → env
          (<Code>LMSTUDIO_URL_BASE</Code>) → <Code>http://localhost:1234/v1</Code>.
          A bare <Code>host:port</Code> gets <Code>/v1</Code> appended
          automatically, so pasting <Code>http://workstation:1234</Code> works.
          Load a model in LM Studio and refresh; if none is loaded the spawn fails
          loudly rather than starting blind.
        </p>
        <p><strong>Tool runtime.</strong> Reuses the shared local allowlist
          (Read / Grep / Glob / Write / Bash / WebSearch / WebFetch) with the same
          AUTO/SAFE dispatch contract as Ollama and llama.cpp — AUTO executes
          server-side, SAFE returns a denial string the model reads as the result.
          Tool-loop cap defaults to 25 turns
          (<Code>ARCO_LMSTUDIO_MAX_TOOL_TURNS</Code>).
        </p>
        <p><strong>Quirks worth knowing:</strong></p>
        <ul>
          <li>
            <strong>No locally-spawned server.</strong> Unlike llama.cpp, Arco
            does not own the process — there is no slot-erase, no warmup wait, no
            per-spawn model load. The trade-off is no catalog file and no
            operator-declared capability flags: the OpenAI <Code>/v1/models</Code>{' '}
            surface omits tool/vision/ctx metadata, so capabilities are inferred
            conservatively (tools assumed on; vision/thinking off until proven).
          </li>
          <li>
            <strong>Vision</strong> follows the OpenAI multimodal shape — attached
            images are forwarded as <Code>image_url</Code> data-URI parts and the
            model decides. Non-image files are referenced by path.
          </li>
          <li>
            <strong>No native session resume.</strong> Transcript is replayed each
            turn, same as Ollama / llama.cpp. ThinkSplitter handles native
            thinking and <Code>&lt;think&gt;</Code> tag fallback.
          </li>
          <li>
            <strong>Serial local queue.</strong> LM Studio shares the
            one-worker-at-a-time local queue with Ollama and llama.cpp (its app
            typically serves one loaded model at a time). Override with{' '}
            <Code>ARCO_LOCAL_PROVIDER_SERIAL_QUEUE=0</Code>.
          </li>
        </ul>
        <Note kind="tip">
          Use LM Studio when you already manage models in its app (or want to point
          Arco at a remote LM Studio host) and prefer its model management over
          Arco-owned llama.cpp loadouts.
        </Note>
      </>
    ),
  },

  // -------------------------------------------------------------- PLANS & ARTIFACTS
];
