import { DocRef } from '../../components/help/DocRef';
import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Note, Table, Sub} from '../../components/UserManual/components';

export const providers: Section[] = [
  {
  id: 'providers-overview',
  group: 'Providers',
  title: 'Choosing a provider',
  body: (
  <>
  <p>
  A provider is the model service behind a workflow tab. Use this table to
  pick one by transport, session resume, tool use and reasoning controls.
  </p>
  <p>
  Eight providers ship for Agent workflows. Chat has a smaller provider set,
  and Incognito narrows it further (see Chat in Workflows &amp; sessions).
  </p>
  <Table
  headers={['Provider', 'Transport', 'Resume', 'Tool use', 'Reasoning', 'Effort levels']}
  rows={[
  ['Claude', <>cli subprocess or native <Code>@anthropic-ai/sdk</Code></>, 'UUID', 'rich', 'yes', '5'],
  ['Codex', <>exec subprocess or long-lived <Code>app-server</Code></>, 'thread_id', 'yes', 'yes', 'model-dependent; Astra up to ultra'],
  ['Cursor', <>ACP (<Code>cursor-agent acp</Code>, JSON-RPC over stdio)</>, 'session/load', 'yes (fs + permission callbacks)', 'model-dependent', 'baked into model id'],
  ['Ollama', 'HTTP', 'none (transcript replay)', 'yes (server-side allowlist)', 'model-dependent', 'low plus model-advertised levels'],
  ['llama.cpp', 'HTTP (singleton llama-server)', 'none (transcript replay)', 'yes (OpenAI-format + XML fallback)', 'model-dependent', 'low / high thinking toggle'],
  ['DeepSeek / Xolotl', 'HTTP (guarded user service)', 'none (transcript replay)', 'yes (Chat web-only)', 'yes', 'none, low, medium, high'],
  ['Strata', 'HTTP (standalone OpenAI-compatible /v1)', 'none (transcript replay)', 'yes (local allowlist; Chat web-only)', 'yes', 'none, low, medium, high'],
  ['LM Studio', 'HTTP (OpenAI-compatible /v1, configurable endpoint)', 'none (transcript replay)', 'yes (reuses local allowlist)', 'model-dependent', 'low / high thinking toggle'],
  ]}
  />
  <Note>
  Z.ai, Gemini (dedicated Google paths) and Antigravity support have been
  removed. Existing history that named them remains readable; new work
  must use a supported provider. Details are in{' '}
  <DocRef path="docs/PROVIDERS.md">docs/PROVIDERS.md</DocRef> under
  retired provider history.
  </Note>
  <Note kind="tip">
  The most common operator pattern: <strong>Claude as primary</strong>, with
  Codex for cross-family review. Pick the family that tends to disagree most
  usefully with the primary.
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
  <p>A Native Task child shows and saves the model requested by the Task call. Queued follow-ups keep their own replies in restored context and reviews. Steering before the first visible reply retains the original request as well as the new instruction.</p>
  <p>Spawn from HISTORY keeps the selected earlier conversation even when it falls outside the recent replay tail. Cancelled handoffs preserve prior context. Older derived summary caches are rebuilt automatically.</p>
  <p>Native Read keeps the partial-read warning when output is capped. A complete later read clears it. Grep reports invalid patterns and search failures as errors. If Bash cannot save full output, its newest tail remains available and the result explains the storage failure. Registry MCP schemas retain their referenced definitions.</p>
  <p>CLI snapshots retain every text block and the final answer without repeating streamed text. Local HTTP generation bounds waiting for response headers. Completed local streams finish at their done marker, even if the connection stays open. Model discovery and WebSearch deadlines remain active while reading JSON.</p>
  <p>
  CLI version and help checks stop after five seconds when a process stalls.
  Codex interrupt and compaction deadlines include the initial server reply.
  </p>
  <p>
  Native file edits that replace every occurrence use non-overlapping matches
  from left to right, including matches recovered through whitespace normalization.
  Lines outside those matches stay unchanged.
  </p>
  <p>
  Claude runs through one of two transports, Native or CLI. This section
  covers choosing a transport, the model list, sign-in, and the behaviors
  that differ between the two.
  </p>
  <Sub>Transports</Sub>
  <Table
  headers={['Transport', 'What it is', 'Notes']}
  rows={[
  [<Code key="n">native</Code>, <>Long-lived in-process worker using <Code>@anthropic-ai/sdk</Code> with Claude-Code-compatible OAuth headers.</>, 'Default for new homes. Arco-owned tools, mid-turn steer, hooks, plan-mode, Task fan-out and context-management controls.'],
  [<Code key="c">cli</Code>, <>Per-turn <Code>claude</Code> subprocess.</>, 'Full Claude Code feature surface and two-way terminal interop.'],
  ]}
  />
  <ul>
  <li>Saved transport choices are kept.</li>
  <li>
  The toggle is per-tab in CONFIG, with cascade defaults in Settings.
  </li>
  <li>
  Reviewers and handoff seeds always run on <Code>cli</Code>.
  </li>
  <li>
  Native workers are disposed after handoff, so the next turn rebuilds from
  the post-handoff transcript.
  </li>
  </ul>
  <Sub>Models</Sub>
  <p>
  The picker carries the family aliases (<Code>haiku</Code>,{' '}
  <Code>sonnet</Code>, <Code>opus</Code> = OPUS LATEST) plus pinned versions:
  Fable 5.1 / 5, Sonnet 5, Opus 5.5 / 5 / 4.8 / 4.7 / 4.6 and OPUS 1M.
  </p>
  <p>
  Opus 5.5 (1M context, five effort levels) and Fable 5.1 use preserved
  thinking on Native. The request prefix is frozen per worker, and config
  changes are appended as system notes rather than rebuilding it. Effort is
  always sent explicitly.
  </p>
  <p>Claude Native token-count telemetry stops after five seconds or when STOP is clicked. The context display then uses response usage, so a stalled count cannot delay turn completion.</p>
  <p>Native reconnects failed or closed MCP sessions at the next turn. Changed server commands, arguments or environment settings replace the old connection then; healthy unchanged sessions stay open.</p>
  <p>Claude CLI reconnects and handoffs retain only the current session watcher. A delayed load of an older session cannot mix its rows into the conversation.</p>
  <p>Automatic Claude CLI context calibration waits for an idle session. Starting a new turn cancels pending calibration admission, so the probe cannot run alongside that turn.</p>
  <p>STOP also cancels a message still preparing prompt or file context, before it starts a provider turn or enters a queue.</p>
  <p>Selected one-shot skills also accompany mid-turn steering. Busy messages keep the same skill context whether consumed during the turn or delivered afterward.</p>
  <Sub>Sign-in</Sub>
  <ul>
  <li>
  <strong>CLI transport</strong> uses <Code>claude auth login</Code>, run in
  Arco&apos;s terminal. It prints a URL and a paste-code prompt, so it works
  from any device. An API key is the fallback if{' '}
  <Code>ANTHROPIC_API_KEY</Code> is set.
  </li>
  <li>
  <strong>Native</strong> uses Arco&apos;s in-app Claude Native OAuth flow and
  stores tokens under <Code>~/.arco/auth.json</Code>.
  </li>
  <li>
  Native approval redirects to <Code>localhost:53692</Code>, which only
  resolves when the browser is on the Arco machine. From another device, copy
  the &quot;can&apos;t connect&quot; page&apos;s URL into the paste box.
  </li>
  <li>
  The Native sign-in row is under Settings &gt; Providers and models &gt;
  Sign-in, accounts and local endpoints.
  </li>
  </ul>
  <Table
  headers={['Control', 'Action']}
  rows={[
  ['LOGIN', 'Starts the Native sign-in flow.'],
  ['OPEN SIGN-IN', 'Link to the provider sign-in page while a sign-in is in progress.'],
  ['SUBMIT', 'Sends a pasted code.'],
  ['CANCEL SIGN-IN', 'Abandons the flow.'],
  ['LOGOUT', 'Removes the stored tokens.'],
  ]}
  />
  <p>Native status reads one of these messages:</p>
  <ul>
  <li>
  <em>Credentials present; execution unverified</em> - tokens are stored.
  Arco has checked only the local credentials, not made a request with them.
  </li>
  <li><em>No Native credentials stored</em> - none exist.</li>
  <li>
  <em>Credentials present; refresh needed on next use; execution
  unverified</em> - the access token has expired and will be renewed by the
  next turn.
  </li>
  <li>
  <em>Authentication problem reported; review Native sign-in</em> - a request
  reported a sign-in problem; sign in again.
  </li>
  <li>
  <em>Status unknown</em> or <em>Status stale; refresh to check credentials</em>
  - the check failed or is older than six minutes.
  </li>
  </ul>
  <Sub>Ultracode (sticky, CLI-only)</Sub>
  <p>
  Ultracode puts the tab in the same deep multi-agent mode as{' '}
  <Code>ultracode</Code> in the Claude CLI. Each turn, Claude authors a{' '}
  <Code>Workflow</Code> that fans out a background subagent fleet.
  </p>
  <ul>
  <li>
  Turn it on with the CONFIG toggle, or the <Code>⚡ ULTRACODE</Code> box at
  tab creation.
  </li>
  <li>
  The harness WorkflowTool exists only in the <Code>claude</Code> binary;
  Native&apos;s raw SDK can&apos;t host it. Ultracode therefore forces the{' '}
  <Code>cli</Code> transport and pins <Code>xhigh</Code>, restoring the base
  transport when turned off.
  </li>
  <li>
  A background workflow emits an early &quot;launched&quot; result, then the
  real synthesis. Arco holds intermediates and settles the turn on the final
  synthesis at process exit.
  </li>
  <li>
  The fleet runs in the background, invisible to the normal Activity stream.
  While a fan-out runs, the <Code>ACTIVITY</Code> tab grows a live{' '}
  <Code>⚡ FLEET</Code> panel (agent count plus per-subagent task and last
  tool).
  </li>
  </ul>
  <Note kind="warn">
  Ultracode is operator-armed, reversible and logged, but it runs a fleet
  unattended with full access and spends heavily. See{' '}
  <Code>docs/PROVIDERS.md</Code>.
  </Note>
  <Sub>Tools and hooks (Native)</Sub>
  <p>
  <strong>Native hooks.</strong> Native walks project and user{' '}
  <Code>.claude/settings.json</Code> hook files and runs command hooks as
  Claude Code's hooks reference describes: <Code>UserPromptSubmit</Code>,{' '}
  <Code>PreToolUse</Code>, <Code>PostToolUse</Code>,{' '}
  <Code>PostToolUseFailure</Code>, <Code>Stop</Code>,{' '}
  <Code>SubagentStop</Code> (a Task child, matched against its agent type),{' '}
  <Code>PreCompact</Code> and <Code>Notification</Code>.
  </p>
  <p>
  <Code>PreCompact</Code> runs before COMPACT and FOLD, matched against{' '}
  <Code>manual</Code> or <Code>auto</Code>; exit code 2 skips that
  compaction. <Code>Notification</Code> runs when an approval card has
  waited 6 seconds (<Code>permission_prompt</Code>) and 60 seconds after a
  turn ends with nothing sent since (<Code>idle_prompt</Code>); it cannot
  block anything.
  </p>
  <p>
  A hook's <Code>if</Code> field takes one permission rule, such as{' '}
  <Code>Bash(git *)</Code> or <Code>Edit(*.ts)</Code>, and the hook runs only
  for tool calls that match it. On events other than tool events, a hook
  with <Code>if</Code> never runs. Hook input includes{' '}
  <Code>transcript_path</Code>, the tab's event log.
  </p>
  <p>
  Exit code 2 blocks where Claude Code blocks: it rejects a prompt, refuses a
  tool call, or keeps the model working after <Code>Stop</Code>. After a tool
  has run, the hook's reason is added next to the result. Any other non-zero
  exit is a non-blocking error shown in the tab, and the action goes ahead.
  </p>
  <p>
  JSON on stdout works as documented: <Code>permissionDecision</Code>{' '}
  <Code>deny</Code> refuses, <Code>ask</Code> parks the call on an approval
  card, <Code>updatedInput</Code> replaces the input, and{' '}
  <Code>additionalContext</Code> reaches the model.{' '}
  <Code>continue: false</Code> ends the turn and <Code>systemMessage</Code> is
  shown to you.
  </p>
  <p>
  <Code>onFailure: "block"</Code> makes a hook that fails, times out or cannot
  start block the action. <Code>async</Code> runs a hook in the background,
  and its context reaches the model with the next request.{' '}
  <Code>asyncRewake</Code> also runs in the background; exit code 2 wakes the
  model with the hook's message, starting a turn when the tab is idle.
  </p>
  <p>
  Closing or handing off the tab ends background hooks and background Bash
  commands that are still running, together with the processes they started.
  </p>
  <p>
  Hooks and the Bash tool run in <Code>/bin/sh</Code> on Linux and macOS and
  in Git Bash on Windows, as in Claude Code. Without Git Bash they run in
  PowerShell: the model gets a <Code>PowerShell</Code> tool instead of{' '}
  <Code>Bash</Code>, hooks that match <Code>PowerShell</Code> fire for it,
  and the tab shows one notice. Every safety check applies to it as to Bash.
  </p>
  <p>
  To use Git Bash, install Git for Windows, or set{' '}
  <Code>CLAUDE_CODE_GIT_BASH_PATH</Code> to its <Code>bash.exe</Code>.
  </p>
  <p>
  A hook can name its shell with <Code>"shell": "bash"</Code> or{' '}
  <Code>"shell": "powershell"</Code>. With <Code>"args"</Code> it starts{' '}
  <Code>command</Code> as a program with those arguments and no shell, on
  every system; <Code>{'${CLAUDE_PROJECT_DIR}'}</Code> is filled in. A hook
  that cannot start is skipped with a notice and does not block, unless it
  sets <Code>onFailure: "block"</Code>, or it is a shell-form{' '}
  <Code>PreToolUse</Code> hook on Windows without Git Bash.
  </p>
  <p>
  <strong>Tool postures (Native-only).</strong> A per-tab posture pill scopes
  which Arco tools the model sees:
  </p>
  <Table
  headers={['Posture', 'Tools the model sees']}
  rows={[
  [<Code key="f">full</Code>, 'No filtering. The default.'],
  [<Code key="c">coding</Code>, 'Full local toolset minus web research.'],
  [<Code key="r">review</Code>, 'Read / Grep / Glob / Bash / TodoWrite / AskUserQuestion. No mutation, no Task fan-out, no web.'],
  [<Code key="ch">chat</Code>, 'Read / Grep / Glob / TodoWrite / AskUserQuestion only.'],
  ]}
  />
  <p>
  The keep-sets are deterministic. Dynamic opt-in tools (<Code>mcp__*</Code> /{' '}
  <Code>peer_*</Code> / <Code>ctx_*</Code>) are never stripped by a posture.
  </p>
  <Sub>Limits and retries</Sub>
  <ul>
  <li>
  <strong>API overload retry loop.</strong> <Code>overloaded_error</Code>{' '}
  envelopes are caught, surfaced as a system notice, and retried with
  15s/30s/60s backoff up to 3 attempts. The session id is the same and the
  retry is idempotent.
  </li>
  <li>
  <strong>Rate-limit header parsing (H10, Native).</strong> When the server
  sends a timing hint (<Code>retry-after</Code> /{' '}
  <Code>anthropic-ratelimit-*-reset</Code>), the parsed header sizes the wait
  instead of the fixed ladder. The wait is capped at 5 minutes
  (<Code>MAX_RATE_LIMIT_WAIT_MS</Code>).
  </li>
  <li>
  The 15s/30s/60s ladder is the fallback only when no header is present.
  Native sets the Anthropic SDK&apos;s <Code>maxRetries</Code> to 0, so
  Arco&apos;s ladder is the only retry path, with no hidden internal
  double-retry.
  </li>
  <li>
  <strong>Throttle detection.</strong> A stderr regex catches &quot;usage limit
  reached&quot; messages and surfaces them in the QuotaBadge with a reset time.
  </li>
  <li>
  <strong>Output cap.</strong> 50 MB per turn by default. Beyond that a
  truncation notice appears and the worker is forced to settle.
  </li>
  <li>
  <strong>Image attachments</strong> are sent as native stream-json content
  blocks. Other files are referenced by path in the prompt text.
  </li>
  <li>
  <strong>Concurrent-writer guard</strong> - see <em>Native sessions &amp;
  resume</em>.
  </li>
  </ul>
  <Sub>Web research and context (Native)</Sub>
  <p>
  <strong>Native web research.</strong> Claude Native advertises Anthropic
  server tools (<Code>web_search</Code> / <Code>web_fetch</Code> plus the
  required server-side code-execution descriptor). It does not use Arco&apos;s
  local SearXNG/Camoufox WebSearch/WebFetch implementation; Anthropic runs
  those calls inside the Messages API.
  </p>
  <p>
  Retention is model-dependent. Fable/Mythos 5.1 and Opus 5.5 keep thinking
  and the frozen request prefix. Other models can prune completed evidence,
  but never mutate the latest assistant message or remove a server-tool call
  referenced by its protected result.
  </p>
  <p>
  <strong>Native CTX accounting.</strong> The worker header&apos;s{' '}
  <Code>CTX</Code> is retained next-turn context, measured with{' '}
  <Code>messages.countTokens()</Code> after those retention rules.
  </p>
  <p>
  The Activity tab can show much larger <Code>prompt</Code> /{' '}
  <Code>cache-read</Code> / <Code>cache-write</Code> numbers on
  server-web-tool turns. Those are provider processing telemetry, not
  conversation footprint.
  </p>
  </>
  ),
  },
  {
  id: 'provider-codex',
  group: 'Providers',
  title: 'Codex',
  body: (
  <>
  <p>Delayed steering acknowledgements stay with the turn that received the instruction. A rejected old steer cannot reappear after STOP. Cancelled work cannot pin an old session onto a newer provider.</p>
  <p>Late turn acknowledgements cannot restart a completed turn. Generated images are saved and announced before completion. App-server receives enabled registry servers and restarts its child before the next turn when a launch definition changes.</p>
  <p>Context and code-mode metadata follow the selected account home, then <Code>CODEX_HOME</Code>, then the CLI default. Concurrent catalog refresh failures use the same saved snapshot or normal picker fallback for every caller.</p>
  <p>
  Codex is OpenAI&apos;s Codex CLI, with frontier-tier reasoning and native
  thread_id resume. Use it as a primary or as a cross-family reviewer.
  </p>
  <Sub>Transports and sign-in</Sub>
  <Table
  headers={['Transport', 'How it runs', 'Notes']}
  rows={[
  [<Code key="e">exec</Code>, 'Per-turn subprocess.', 'No interactive reply bridge. Reviewers and handoff seeds always run on exec regardless of the tab default.'],
  [<Code key="a">app-server</Code>, 'Long-lived per-tab JSON-RPC child.', 'The default for new Arco homes. See App-server features below.'],
  ]}
  />
  <p>
  <strong>Auth:</strong> via <Code>codex login</Code>. API-key fallback if{' '}
  <Code>OPENAI_API_KEY</Code> is set.
  </p>
  <Sub>Models and effort</Sub>
  <p>
  Arco&apos;s default is <Code>gpt-6-astra</Code>. The picker uses the
  selected model&apos;s live catalog, so the effort levels offered follow the
  model:
  </p>
  <Table
  headers={['Model', 'Role', 'Effort levels']}
  rows={[
  [<Code key="a">gpt-6-astra</Code>, 'Arco default', 'low / medium / high / xhigh / max / ultra'],
  [<Code key="s">gpt-6-sol</Code>, 'Everyday coding workhorse', 'low / medium / high / xhigh / max / ultra'],
  [<Code key="l">gpt-6-luna</Code>, 'Fast and affordable', 'Stops at max'],
  ['Older models', '-', 'Can expose fewer levels'],
  ]}
  />
  <p>
  Codex tabs default to the selected account/model&apos;s live MAX context
  value (currently about 828K effective for Astra). CONFIG can return a tab
  to STANDARD (about 258K). A provider-reported window takes precedence.
  </p>
  <Note kind="warn">Codex describes ultra as maximum reasoning with automatic
  task delegation. Provider-internal delegated-agent activity is not fully
  represented in Arco&apos;s transcript. Choosing it does not create an Arco
  cluster or grant a new Arco orchestration surface.</Note>
  <Sub>Sandbox modes</Sub>
  <ul>
  <li><Code>read-only</Code> - reviewers always force this. Reads only.</li>
  <li><Code>workspace-write</Code> - full read + write within cwd. The default for primaries.</li>
  <li><Code>danger-full-access</Code> - no sandboxing. Use only when the implications are understood.</li>
  </ul>
  <Sub>App-server features</Sub>
  <p>
  CONFIG can switch a tab from <Code>exec</Code> to <Code>app-server</Code>.
  App-server adds:
  </p>
  <ul>
  <li>Structured <Code>turn/interrupt</Code> cancel.</li>
  <li>Non-destructive <Code>turn/steer</Code> mid-turn input.</li>
  <li>Local image attachments.</li>
  <li>A crash-recovery circuit breaker.</li>
  <li>Capture of blocking and async agent questions (below).</li>
  </ul>
  <p>
  <strong>Agent questions.</strong> Answer inline or open the composer&apos;s{' '}
  <strong>? QUESTIONS</strong> button. Options retain descriptions, and a
  typed answer is available when offered.
  </p>
  <ul>
  <li>
  Async questions let the agent continue. Answers sent after a turn ends
  start a normal operator turn.
  </li>
  <li>Cancelled or expired questions close automatically.</li>
  <li>
  A named toast opens the asking worker. A question mark on its tab and a
  highlighted cluster card remain until the question settles.
  </li>
  <li>Claude Native AskUserQuestion uses the same visibility.</li>
  </ul>
  <Sub>Quirks worth knowing</Sub>
  <ul>
  <li>
  <strong>Resume mode is narrower.</strong> <Code>codex exec resume</Code>{' '}
  doesn&apos;t accept <Code>--color</Code>, <Code>-s</Code>, <Code>-C</Code>, or{' '}
  <Code>--add-dir</Code>. Arco drops them on resume; sandbox maps to{' '}
  <Code>--full-auto</Code> or <Code>--dangerously-bypass-approvals-and-sandbox</Code>.
  </li>
  <li>
  <strong>thread_id capture.</strong> The first-turn thread_id arrives in the
  init event. Arco records a placeholder UUID immediately, then reconciles it
  in place once the real id arrives.
  </li>
  <li>
  <strong>Token semantics.</strong> Codex&apos;s <Code>cached_input_tokens</Code>{' '}
  is a SUBSET of <Code>input_tokens</Code>, not additive. Arco&apos;s CTX bar
  handles this correctly, but when cross-referencing token counts in the CLI
  itself, do not add the two.
  </li>
  <li>
  <strong>Reasoning tokens roll forward.</strong> High-effort GPT-5.x turns
  put significant tokens in hidden reasoning. They accumulate into the next
  turn&apos;s prompt, so Codex session ctx grows faster than visible chat
  would suggest.
  </li>
  <li>
  <strong>Compactions count toward auto-handoff.</strong> On the app-server
  transport Arco counts each compaction Codex reports, its own and the ones
  COMPACT or auto-compaction start, once per compaction.
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
  <p>ACP and print preserve multibyte text across streamed chunks. Cancelling compression finishes when the compression stops, without leaving a timer that can kill a later turn.</p>
  <p>
  Cursor&apos;s metered subscription fronts ~153 models (Grok 4.5, GPT-5.x,
  Claude, GLM, Kimi) under one login. Use it to reach many frontier families
  from one provider.
  </p>
  <p>
  Arco drives it through <Code>cursor-agent acp</Code> (ACP = Agent Client
  Protocol, real JSON-RPC 2.0 over stdio). The design is cloned from the
  Codex <Code>app-server</Code> mechanics: a long-lived in-process worker plus
  a per-turn wrapper. Its letter on dots and badges is <Code>X</Code>.
  </p>
  <Sub>Sign-in</Sub>
  <p>
  <Code>cursor-agent login</Code> stores a cursor.com session JWT at{' '}
  <Code>~/.config/cursor/auth.json</Code> (auto-refreshed). Arco&apos;s auth
  probe reads it fresh, but an already-running ACP child can retain old
  credentials.
  </p>
  <p>
  A recognized sign-in failure shows a re-login card and retires that child.
  Log in, then resend. The next turn creates a fresh worker and resumes the
  session where Cursor supports it.
  </p>
  <Sub>Models and effort</Sub>
  <p>
  The full roster comes from a live <Code>cursor-agent models</Code> catalog
  (1h server cache, 30-min client poll). <Code>auto</Code> is the default.
  </p>
  <p>
  Cursor bakes reasoning effort <em>into the model id</em> (<Code>-low</Code> /{' '}
  <Code>-high</Code> / <Code>-xhigh</Code> / <Code>-max</Code>). The picker is
  therefore a two-part <strong>family and effort</strong> control, with
  optional <strong>FAST</strong> / <strong>THINK</strong> toggles.
  </p>
  <ul>
  <li>
  It only offers combinations the catalog actually advertises and resolves to
  the exact id. It never synthesizes one, so <Code>xhigh</Code> cannot be sent
  accidentally when <Code>high</Code> was picked.
  </li>
  <li>
  <Code>auto</Code> hides the effort control; Cursor&apos;s router picks model{' '}
  <em>and</em> effort.
  </li>
  <li>
  The status chip reads the effort back out of the resolved id, so it always
  shows the true tier.
  </li>
  </ul>
  <Sub>Turn controls</Sub>
  <ul>
  <li>
  <strong>ACP is bidirectional.</strong> Unlike the Codex app-server, the agent
  calls back mid-turn (<Code>fs/read_text_file</Code>,{' '}
  <Code>fs/write_text_file</Code>, <Code>session/request_permission</Code>,{' '}
  <Code>terminal/*</Code>). The worker answers these or the turn hangs.
  Permissions are auto-approved in the current transport.
  </li>
  <li>
  <strong>Steer.</strong> Type mid-turn and the message is queued and
  dispatched as a follow-up the moment the turn finishes. This preserves
  output; Cursor&apos;s native barge-in is not used.
  </li>
  <li>
  <strong>Cancel</strong> asks the session to stop and hard-kills after 5s if
  it doesn&apos;t settle.
  </li>
  <li>
  <strong>Resume.</strong> Reopening a tab resumes the prior ACP session via{' '}
  <Code>session/load</Code>. If the id is gone, it falls back to a fresh
  session with a notice.
  </li>
  <li>
  <strong>Live model-swap.</strong> Changing the model in CONFIG swaps it{' '}
  <em>in-session</em> with no respawn. A &quot;model swapped&quot; notice
  appears on the next turn.
  </li>
  <li>
  <strong>Model check.</strong> Every new or resumed session selects the chosen
  model and confirms it. Cursor runs each model with the settings saved for it
  in the Cursor CLI (for example Grok 4.7 High Fast). When the chosen variant
  differs, a notice names both models and the model chip shows the one in use.
  To use another variant, choose it once in the Cursor CLI (<Code>/model</Code>),
  then HANDOFF. Choosing a Cursor model in Arco also makes it the CLI&apos;s
  default.
  </li>
  <li>
  <strong>Sign-in.</strong> Connections &gt; Cursor signs in from Arco and shows
  the link to open. When Cursor rejects the saved sign-in, the status reads
  Sign-in rejected and the chat shows a sign-in notice; sign in again and
  resend. Sign-in failures never stop a tab from retrying; three other start
  failures in a row do, until HANDOFF.
  </li>
  </ul>
  <Sub>North star and clusters</Sub>
  <p>
  <strong>North-star.</strong> A per-tab NORTH STAR objective (CONFIG or{' '}
  <Code>/goal</Code>) folds into every Cursor turn&apos;s prompt above the
  request. It is the same steering context the other providers get: pure
  context, no model authority.
  </p>
  <p>
  <strong>Cluster member.</strong> A Cursor tab can be a full cluster member in
  any role, at any model (Auto or any frontier id). It exchanges notes with
  peers via <Code>peer_list</Code> / <Code>peer_send</Code> /{' '}
  <Code>peer_read</Code> and the shared task board, same as a Claude or Codex
  member. The cluster plan/role fold also takes effect.
  </p>
  <p>
  One caveat: add a Cursor member when creating the cluster, or via the
  members panel&apos;s <em>fresh-spawn</em> button. An existing standalone
  Cursor tab can&apos;t be pulled into a cluster, because its underlying
  session is fixed at start; a fresh member gets the peer tools wired in from
  the first turn.
  </p>
  <Sub>Review and other primitives</Sub>
  <p>
  <strong>Primitives are read-only.</strong> When Review (or a
  fresh-summarizer Handoff, DOCS, research, compare) runs on a Cursor tab, the
  reviewer runs as a throwaway <Code>cursor-agent -p --mode ask</Code>{' '}
  process. This is a separate, read-only Q&amp;A session, <em>not</em> the
  live tab.
  </p>
  <p>
  It can read the codebase to ground its answer but cannot write or run
  shell, and it never touches the transcript of the tab that launched it.
  </p>
  <Sub>Usage and context</Sub>
  <p>
  <strong>Usage.</strong> The ACP stream carries no token counts, so the
  header <Code>X</Code> dot is live-status only. Billed MTD $/token detail
  lives on the Cursor dashboard; Arco&apos;s authed usage poll attributes
  spend per workflow via the ACP <Code>sessionId</Code>.
  </p>
  <p>
  The Usage tab shows a polled month-to-date spend card plus the{' '}
  <em>Included in Pro</em> allocation gauge. Hovering the header&apos;s{' '}
  <Code>X</Code> status dot shows a compact version with two bars:
  </p>
  <ul>
  <li>The included-plan gauge (Cursor&apos;s blended percentage used).</li>
  <li>The separate <em>Other Models</em> quota.</li>
  <li>Both are Cursor&apos;s own numbers, never reconstructed from local token totals.</li>
  </ul>
  <p>
  <strong>Context management.</strong> Cursor automatically summarizes older
  history as its context fills. ACP exposes no trustworthy retained-token
  count, so the worker header says <Code>CTX: Cursor-managed</Code> instead of
  inventing a percentage.
  </p>
  <p>
  Use <Code>⊟ COMPACT</Code> (or type <Code>/compress</Code>) to run
  Cursor&apos;s native compression command against the live ACP session. Arco
  sends it without the normal cluster/north-star prefix so the slash command
  remains recognizable. <Code>HANDOFF</Code> remains the clean-session escape
  hatch.
  </p>
  <Note kind="tip">
  Grok 4.5 in an Arco tab is just Cursor with the model set to a{' '}
  <Code>grok-4.5-*</Code> id - the same picker holds every frontier family.
  </Note>
  <Sub>What ships</Sub>
  <p>All Cursor transports now ship. The current feature set:</p>
  <ul>
  <li>Spawnable primary, the full model picker and badge X.</li>
  <li>Steer, cancel, session resume and live model-swap (no respawn).</li>
  <li>The north-star system-prompt fold.</li>
  <li>
  Read-only reviewer/handoff/DOCS primitives (the{' '}
  <Code>cursor-agent -p --mode ask</Code> print path).
  </li>
  <li>
  <strong>Cluster membership.</strong> Peer tools ride an in-process loopback
  MCP, since Cursor honors MCP over http/sse only; this also lights up the
  cluster-plan fold.
  </li>
  <li>The Usage-tab card and header hover described above.</li>
  </ul>
  <p>See <Code>docs/PROVIDERS.md</Code> for transport detail.</p>
  </>
  ),
  },
  {
  id: 'provider-ollama',
  group: 'Providers',
  title: 'Ollama (local models)',
  body: (
  <>
  <p>After a completed handoff, local replay keeps the new brief and subsequent exchanges. Cancelled handoffs keep earlier context. Literal USER and AGENT labels in quoted text or code remain part of their original message.</p>
  <p>Fenced tool mode keeps plan checkbox changes callable. Ordinary code and JSON examples remain answers; explicit malformed tool blocks still report argument errors. Native and local Write create nested parent directories on Windows. HTTP throttling can advance a configured fallback chain for a bounded job; context overflow stays on context recovery.</p>
  <p>
  Ollama runs models locally: no subscription, no rate limits, no remote
  calls. It is bound by local GPU/RAM and the capabilities of the models
  pulled.
  </p>
  <Sub>Connection</Sub>
  <p>
  <strong>Auth:</strong> none. Arco probes the daemon on{' '}
  <Code>OLLAMA_URL_BASE</Code> (default <Code>http://localhost:11434</Code>).
  The header LIVE/READY chip indicates whether a model is currently loaded.
  </p>
  <Sub>Built-in tool runtime</Sub>
  <p>
  Ollama&apos;s HTTP API is stateless: when the model emits tool_calls, the{' '}
  <em>caller</em> executes them and feeds results back. Arco implements a
  server-side tool loop with these tools:
  </p>
  <Table
  headers={['Tool', 'Notes']}
  rows={[
  [<Code key="r">Read</Code>, '32 KB byte cap, refuses directories. Chunk via offset/limit for larger files.'],
  [<Code key="g">Glob</Code>, 'Node 22 fs.promises.glob. Cwd-rooted.'],
  [<Code key="gr">Grep</Code>, 'POSIX walk; skips node_modules / .git / dist / .arco. 64 KB output cap.'],
  [<Code key="w">Write</Code>, 'mkdir -p parents. Refuses to clobber a directory.'],
  [<Code key="b">Bash</Code>, '/bin/sh -c in cwd (Git Bash on Windows; on Windows without Git Bash the PowerShell tool instead). 60s default timeout, 600s ceiling. Combined stdout+stderr capped at 64 KB.'],
  [<Code key="ws">WebSearch</Code>, <>Hits operator&apos;s local SearXNG (<Code>ARCO_SEARXNG_URL</Code>, default <Code>http://127.0.0.1:8888</Code>). Bang syntax (<Code>!g foo</Code>) routes engines.</>],
  [<Code key="wf">WebFetch</Code>, <>Native <Code>fetch()</Code> fast path, Camoufox stealth fallback for Cloudflare-gated pages. SSRF guard blocks loopback/RFC1918.</>],
  ]}
  />
  <Table
  headers={['Mode', 'Behavior']}
  rows={[
  ['AUTO', "The primary's default. Executes tools server-side."],
  ['SAFE', 'Returns a denial string the model sees as the tool result. The loop converges without an operator-approval surface.'],
  ]}
  />
  <p>Mid-turn cancel remains available at any time in either mode.</p>
  <Sub>Limitations to keep in mind</Sub>
  <ul>
  <li>
  <strong>Smaller context windows.</strong> Most local models have 32K-128K
  windows; the CTX bar reports them honestly.
  </li>
  <li>
  <strong>No native session resume.</strong> The transcript is replayed each
  turn; Ollama&apos;s prefix cache makes this cheap as long as the prefix is
  byte-stable. Sampler / num_ctx overrides are intentionally NOT plumbed:
  they&apos;d invalidate the cache. Configure these in the Modelfile instead.
  </li>
  <li>
  <strong>Current local baseline.</strong> Qwen3.6-27B is the expected
  high-context local coding model: tool use, image attachments, 262K
  context, and Camoufox-backed WebFetch/WebSearch when configured.
  </li>
  <li>
  <strong>Mid-turn steer.</strong> Ollama uses Arco&apos;s own tool loop, so
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
  <Code>&lt;think&gt;</Code> tags in content; Arco&apos;s ThinkSplitter
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
  where subscription quota should stay unused.
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
  llama.cpp runs local GGUF models with Arco owning the server process. Use it
  when a model feature, such as a new vision architecture, has not reached
  Ollama yet.
  </p>
  <p>Catalog aliases must stay unique, including renames. A save, delete or diagnosis fix refuses a changed catalog rather than replacing later work. Reload it and review the change again; a refused fix does not reload the model.</p>
  <p>
  The catalog at <Code>~/.arco/llamacpp.json</Code> declares each loadout up
  front (alias / GGUF path / context size / GPU layers / capability flags). A
  singleton <Code>llama-server</Code> process is spawned with the right flags
  on first use.
  </p>
  <p>
  Switching aliases mid-workflow SIGTERMs the old server and warms the new
  one.
  </p>
  <Sub>Why this exists alongside Ollama</Sub>
  <p>
  Vision-capable architectures often land in llama.cpp weeks before Ollama
  wires up the multimodal projector path; Qwen3.6 was the motivating case.
  The text-only ergonomic edge of Ollama is unchanged. llama.cpp is the escape
  hatch when a feature Ollama hasn&apos;t shipped is required.
  </p>
  <Sub>Setup and catalog editing</Sub>
  <p>
  <strong>Auth:</strong> none. Arco probes for the binary
  (<Code>llama-server</Code> on the PATH, or <Code>llama-server.exe</Code>{' '}
  on Windows; point at a specific file with <Code>ARCO_LLAMACPP_BIN</Code>)
  and confirms <Code>~/.arco/llamacpp.json</Code> parses cleanly.
  </p>
  <p>
  Capabilities are operator-declared (no <Code>--show</Code>-equivalent on
  llama-server).
  </p>
  <p>
  The Settings panel ships a llama.cpp catalog editor with per-row alias /
  ggufPath / mmprojPath / ctxSize / ngl / capability checkboxes. Per-row
  controls:
  </p>
  <ul>
  <li>
  <Code>Load now</Code> pre-warms the binary so the next workflow turn
  doesn&apos;t pay the 20-30 s cold-start.
  </li>
  <li>
  <Code>Unload</Code> frees VRAM immediately without waiting for the idle
  eviction timer (<Code>ARCO_LLAMACPP_KEEPALIVE_MS</Code>, default 10
  minutes).
  </li>
  </ul>
  <Sub>Tool loop and steer</Sub>
  <p>
  <strong>Mid-turn steer.</strong> Like Ollama, llama.cpp runs through
  Arco&apos;s server-side tool loop, so steer can land between tool-result
  append and the next chat-completions request.
  </p>
  <p>
  <strong>Tool runtime.</strong> Reuses the Ollama allowlist (Read / Grep /
  Glob / Write / Bash / WebSearch / WebFetch) with OpenAI fragment-assembly
  for tool calls. Qwen-style XML <Code>&lt;tool_call&gt;</Code> markup in{' '}
  <Code>reasoning_content</Code> is also recognized as a fallback, so the
  loop doesn&apos;t hang when the model emits tools that way.
  </p>
  <Sub>Auto-recovery</Sub>
  <p>
  Local thinking models fail in specific ways the lifecycle alone can&apos;t
  handle. The provider runs three recovery paths in place (without spawning
  Handoff) and one warning:
  </p>
  <ul>
  <li><strong>Reasoning runaway</strong> - model emits{' '}
  <Code>reasoning_content</Code> for too long without committing. Aborts
  stream, injects a coaching message that forces commitment.
  </li>
  <li><strong>Stream stall</strong> - no SSE event for{' '}
  <Code>ARCO_LLAMACPP_STALL_TIMEOUT_MS</Code> (default 90 s). Builds a
  deterministic summary (no LLM call) and continues.
  </li>
  <li><strong>Tool-cap exhaustion</strong> - 50-turn cap fires on a
  legitimately long task. Same deterministic recap, reset counter, keep
  going.
  </li>
  <li><strong>Context fill</strong> - at clean turn boundaries, when the
  input/ctxSize ratio crosses{' '}
  <Code>ARCO_LLAMACPP_COMPACT_THRESHOLD</Code> (default 0.85), a notice
  warns that the next turn may overflow and suggests Handoff. Nothing is
  compacted.
  </li>
  </ul>
  <p>
  The three recovery paths share a budget (default 2 per operator turn). Each emits a{' '}
  <Code>system_notice</Code> so the cause is visible without digging through
  logs.
  </p>
  <Sub>Serve-failure diagnosis</Sub>
  <p>
  When a <Code>llama-server</Code> start fails, Arco runs a deterministic
  regex pass over the stderr tail (no model call) to name the cause. It
  surfaces in the model-health panel; it&apos;s a readable rule set, not a
  model verdict.
  </p>
  <p>Recognized causes:</p>
  <ul>
  <li>Port in use.</li>
  <li>Missing GGUF.</li>
  <li>Context too large.</li>
  <li>Out of memory.</li>
  <li>Missing binary.</li>
  <li>Unsupported architecture.</li>
  </ul>
  <p>
  One-click fixes write straight into the catalog editor, for example halving{' '}
  <Code>ctxSize</Code>, reducing <Code>ngl</Code>, or adding an{' '}
  <Code>extraArgs</Code> flag.
  </p>
  <Note kind="tip">
  Pair with the RUN AS picker in the GIT and DOCS buttons: the tab&apos;s primary can
  be a local Qwen doing the actual coding while the one-off git/docs sweep
  dispatches to a frontier model in a freshly spawned tab.
  </Note>
  </>
  ),
  },
  {
  id: 'provider-strata',
  group: 'Providers',
  title: 'Strata - Qwen3.8 Flash Next and model switching',
  body: <>
  <p>
  Choose <strong>STRATA</strong> in the provider picker for a standalone
  local inference service, separate from Ollama and LM Studio.
  </p>
  <p>Saving unrelated settings preserves the configured Strata endpoint. An explicit endpoint reset still restores the environment or default address.</p>
  <Sub>Endpoint and profiles</Sub>
  <p>
  Set its address in <strong>Settings &gt; STRATA ENDPOINT</strong>; the default
  is <Code>http://127.0.0.1:8081/v1</Code>. Live discovery reports the served
  model&apos;s actual configured context and image support.
  </p>
  <p>
  The local profile registry lists each prepared profile by its label, with
  its context window, even while it is not loaded.
  </p>
  <Sub>Switching models</Sub>
  <ol>
  <li>Click Agent&apos;s composer model chip, CONFIG &gt; MODEL, or Chat&apos;s model dropdown.</li>
  <li>Send the <strong>next message</strong>. The choice loads then and retains the conversation.</li>
  </ol>
  <ul>
  <li>
  Only one profile is resident; other Strata turns wait for the current turn
  and tools to finish.
  </li>
  <li>
  Arco may start/switch explicitly registered loopback user services; their
  existing preflight and memory limits remain enforced.
  </li>
  <li>Remote or unregistered endpoints keep normal HTTP operation.</li>
  <li>Failed/cancelled switches attempt to restore the old profile.</li>
  <li>
  This is not an automatic model downloader or a promise of simultaneous
  residency.
  </li>
  </ul>
  <Sub>Reasoning and speed</Sub>
  <p>
  Streaming includes answers, reasoning and tool-call round trips. Effort
  levels:
  </p>
  <ul>
  <li><Code>none</Code> disables thinking.</li>
  <li>
  <Code>low</Code>, <Code>medium</Code> and <Code>high</Code> set reasoning
  effort. High maps to Qwen xhigh; low is not thinking-off here.
  </li>
  </ul>
  <p>
  After a completed turn the composer shows decode <strong>tok/s</strong> and
  fresh-prefill <strong>PP</strong> when engine timing is available.
  </p>
  <Sub>Tools and limits</Sub>
  <ul>
  <li>Agent has local tools including WebSearch/WebFetch.</li>
  <li>Saved Chat&apos;s WEB switch exposes only that pair, with no project tools.</li>
  <li>Attach an image for vision.</li>
  <li>
  Strata is excluded from Incognito because its standalone service keeps
  logs/image caches.
  </li>
  <li>It is not a cluster member.</li>
  </ul>
  <Sub>FREE VRAM and updates</Sub>
  <p>
  <strong>FREE VRAM</strong> unloads local models after active local work is
  finished/cancelled; the next message reloads them.
  </p>
  <p>
  PROVIDERS shows the installed Strata engine even while stopped and checks
  upstream engine component versions every four hours. Click opens release
  notes inside Arco, with manual installation; the 0.2 app version is
  separate.
  </p>
  <p>
  See the manual sections <strong>Strata MoE - RAM, VRAM and context</strong>
  and <strong>Strata - switching, FREE VRAM and recovery</strong>, or open
  the full runbook: <DocRef>docs/STRATA.md</DocRef>.
  </p>
  </>,
  },
  {
  id: 'provider-lmstudio',
  group: 'Providers',
  title: 'LM Studio (local models, OpenAI-compatible endpoint)',
  body: (
  <>
  <p>Standard LM Studio, Strata and DeepSeek cluster members receive their shared plan, role and coordination instructions. Blind members keep restricted context without the shared plan.</p>
  <p>
  LM Studio serves local models from its own app, reached over its{' '}
  <strong>OpenAI-compatible REST API</strong> rather than a native SDK. Use it
  when models are already managed in LM Studio, locally or on another host.
  </p>
  <p>
  LM Studio joins Arco as an HTTP endpoint (<Code>/v1/chat/completions</Code>,{' '}
  <Code>/v1/models</Code>), <em>not</em> via <Code>lmstudio.js</Code>. The
  app/engine are closed-source, so the REST surface reuses Arco&apos;s existing
  HTTP-provider plumbing and its own tool loop.
  </p>
  <p>
  Talk to a local install or a remote one over the network; LM Studio&apos;s
  app handles JIT model loading on its side.
  </p>
  <Sub>Connection</Sub>
  <p>
  <strong>Auth:</strong> none. Arco probes the configured base URL, taking the
  first of:
  </p>
  <ol>
  <li>Settings (<Code>lmstudio.baseUrl</Code>).</li>
  <li>Environment (<Code>LMSTUDIO_URL_BASE</Code>).</li>
  <li>The default <Code>http://localhost:1234/v1</Code>.</li>
  </ol>
  <p>
  A bare <Code>host:port</Code> gets <Code>/v1</Code> appended automatically,
  so pasting <Code>http://workstation:1234</Code> works. Load a model in LM
  Studio and refresh; if none is loaded the spawn fails loudly rather than
  starting blind.
  </p>
  <Sub>Tool runtime</Sub>
  <p>
  Reuses the shared local allowlist (Read / Grep / Glob / Write / Bash /
  WebSearch / WebFetch) with the same AUTO/SAFE dispatch contract as Ollama
  and llama.cpp. AUTO executes server-side; SAFE returns a denial string the
  model reads as the result.
  </p>
  <p>
  The tool-loop cap defaults to 25 turns
  (<Code>ARCO_LMSTUDIO_MAX_TOOL_TURNS</Code>).
  </p>
  <Sub>Quirks worth knowing</Sub>
  <ul>
  <li>
  <strong>No locally-spawned server.</strong> Unlike llama.cpp, Arco does not
  own the process: no slot-erase, no warmup wait, no per-spawn model load.
  </li>
  <li>
  The trade-off is no catalog file and no operator-declared capability flags.
  The OpenAI <Code>/v1/models</Code> surface omits tool/vision/ctx metadata,
  so capabilities are inferred conservatively (tools assumed on;
  vision/thinking off until proven).
  </li>
  <li>
  <strong>Vision</strong> follows the OpenAI multimodal shape: attached
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
  Use LM Studio when models are already managed in its app (or Arco should
  point at a remote LM Studio host) and its model management is preferred
  over Arco-owned llama.cpp loadouts.
  </Note>
  </>
  ),
  },

  // -------------------------------------------------------------- PLANS & ARTIFACTS
];
