# Contributing to Arco

Dev workflow, code-style notes, and how to extend Arco with a new provider, primitive, theme, or right-pane tab.

For the architecture map, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). For terminology, see [`docs/GLOSSARY.md`](docs/GLOSSARY.md). For "don't regress X," see [`docs/GOTCHAS.md`](docs/GOTCHAS.md).

Contributions are accepted under the repository's GPL-3.0-only license.

Vulnerabilities are reported privately through the process in
[SECURITY.md](SECURITY.md#reporting-a-vulnerability); public issues and pull
requests must not disclose unresolved security vulnerabilities.

---

## Setup

```bash
git clone https://github.com/ghreprimand/arco.git
cd arco
npm install
npm run dev
```

Open <http://localhost:5173>.

**Native deps under npm 12.** npm 12 blocks package install scripts by default. The root `package.json` carries an `allowScripts` block covering three packages: `better-sqlite3` (recall index), `node-pty` (integrated terminal), and `esbuild` (two versions resolve in this tree). A fresh clone needs nothing beyond `npm install`. Three things to know:

- **On npm 12, prefer `npm ci`.** `npm install` under npm 12 renormalizes `package-lock.json`, dropping 26 `"peer": true` flags from esbuild's platform-optional deps. The rewrite is cosmetic and moves no dependency versions. Do not commit it: npm 10 puts the flags straight back, leaving the other machine's tree dirty. The lockfile ping-pongs between formats, as measured in both directions. `npm ci` installs from the lock without writing it, honors `allowScripts` identically, and builds both native modules, so it is the clean call on any npm 12 machine. If you already ran `npm install` there, `git checkout package-lock.json`. The lock stays npm 10-authored until this project's Node floor moves (npm 12 wants Node `^22.22.2 || ^24.15.0 || >=26`).
- **The pins are version-keyed** (`better-sqlite3@12.9.0`). Bump one of those deps without updating its pin and npm silently stops running its scripts. `npm install` reports `N packages had install scripts blocked because they are not covered by allowScripts`. Read that warning rather than scrolling past it. `npm install-scripts ls` lists the current state.
- **Approving after the fact does not build anything.** `npm install-scripts approve <pkg>` writes the `allowScripts` entry and prints `added <pkg>`, but npm won't re-run scripts for an already-unpacked package. Follow it with `npm rebuild better-sqlite3 node-pty`.

A missed `better-sqlite3` build is the quiet one: `npm run build` passes, the server boots, and only transcript recall is dead. A healthy boot logs `Recall index backfilled N workflows`; a broken one logs a `RECALL DISABLED` block naming the rebuild command. The System modal's Recall-index check reports `warn` in that state too.

Requirements:

- Node.js **22+** (developed on 24.x LTS; 22.x is in maintenance until 2027-04-30). Crossing a Node major changes the native ABI, so `better-sqlite3` and `node-pty` need `npm rebuild` afterwards. `RECALL DISABLED` or `ERR_DLOPEN_FAILED` at boot signals that rebuild is needed.
- One or more configured providers: Claude (`claude auth login`), Codex (`codex login`), Gemini (`gemini auth login`), Cursor (`cursor-agent login`), a Z.ai key (`ZAI_API_KEY`), or a local backend (Ollama, LM Studio, or `llama-server` + `~/.arco/llamacpp.json`)
- Linux, macOS or Windows (see the cross-platform notes in [`docs/GOTCHAS.md`](docs/GOTCHAS.md))

`npm run dev` starts both the server (port 3001, `tsx watch`) and the client (port 5173, Vite) under `concurrently --kill-others`. If one dies, both die.

---

## Repo structure

```
Arco/
├── shared/src/protocol/             # shared WS message types split by domain
│   │                                #   between client and server. `shared/src/protocol.ts`
│   │                                #   is a thin barrel re-exporting `./protocol/index.js`.
├── server/src/
│   ├── index.ts                     # boot, WS dispatcher switch, workflow lifecycle
│   ├── ws/                          # per-domain WS handlers: turnEngine (primary-turn dispatch,
│   │                                #   post-settle armed actions), updatePrimaryConfig,
│   │                                #   cluster/handoff/compact/gate/posture/bakeoff handlers
│   ├── http/                        # router.ts + per-domain *Routes.ts
│   ├── chatMode.ts                  # Chat-tab contract (provider sets, web toggle, saved-chat list)
│   ├── goalRun.ts                   # goal-run arming + deterministic stop decision
│   ├── taskDispatcher.ts            # operator-armed cluster task dispatcher
│   ├── primitives/                  # seedWorker, runReviewer, exportContext, reviewContent,
│   │                                #   runCompare, runResearch, runDocEdit, runMdTuneup
│   ├── providers/                   # claude, claude-native/, codex, codex-appserver/,
│   │                                #   gemini, gemini-native/ (auth+catalog stub only),
│   │                                #   zai-native/, ollama, ollamaTools, llamacpp,
│   │                                #   llamacppManager, llamacppRecovery, lmstudio,
│   │                                #   antigravity, cursor/ (acp worker + print.ts one-shot);
│   │                                #   shared: codexCodeMode, goalBlock, outputStyle
│   ├── mcp/                         # MCP registry + clusterMcpServer/clusterMcpTools +
│   │                                #   clusterMcpLoopback (Cursor) + osvCheck + safeEnv
│   ├── projectTrust.ts              # untrusted-repository skills/settings gate
│   ├── skillAudit.ts                # user-triggered skill security audit
│   ├── skillUsage.ts                # skill-usage telemetry sidecar
│   ├── primitiveDrift.ts            # Review/Handoff/Spawn model vs live catalog
│   ├── configValue.ts              # !cmd / ${ENV} config interpolation
│   ├── prompts.ts                   # parameterized /prompt template expansion
│   ├── memoryMonitor.ts             # RSS/heap trend logging (gated)
│   ├── clusterEfficiency.ts         # per-cluster efficiency-level bundle
│   ├── ultracodeFleetWatcher.ts     # ultracode background-subagent fleet telemetry
│   ├── recentFilesLedger.ts         # agent-writes ledger (ARCHIVE RECENTS)
│   ├── workers/                     # WorkerManager, RSS guard, /proc activity probe
│   ├── workflowStore.ts             # events.jsonl persistence
│   ├── workflowMeta.ts              # meta.json
│   ├── planStore.ts                 # plan briefs
│   ├── crashRecovery.ts             # boot-time recovery
│   ├── sessionJsonl.ts              # Claude JSONL watcher
│   ├── contextEstimator.ts          # byte-count fill
│   ├── contextCalibrator.ts         # ground-truth calibration
│   ├── auth.ts                      # per-provider login triggers
│   ├── catalog.ts                   # provider model catalog and live model discovery
│   ├── claudeMdDiscovery.ts         # CLAUDE.md walker (cwd -> root + ~/.claude)
│   ├── codexUsage.ts                # Codex 5h/weekly usage probe
│   ├── codexRolloutTokens.ts        # per-call token usage snapshot
│   ├── handoffPrompts.ts            # user-editable Handoff prompts
│   ├── skills.ts                    # .arco/skills/ scanner + manifest builder
│   ├── git.ts                       # GitDialog backing (status + checkout)
│   ├── settings.ts                  # operator settings (cascade: defaults → global → project)
│   ├── usage.ts                     # Claude 5h/weekly usage probe
│   ├── github.ts                    # gh proxy
│   ├── toolbox.ts                   # tool catalog
│   ├── capabilities.ts              # CLI version detection
│   ├── quota.ts                     # per-provider throttle state
│   ├── previewProxy.ts              # per-workflow dev-server iframe proxy
│   ├── previewAutoDetect.ts         # Bash-sniff + /proc-fd auto-detection
│   └── (workers/pidRegistry.ts)     # worker pid tracking + orphan reaping
├── client/src/
│   ├── main.tsx                     # entry; bootstraps theme before mount
│   ├── App.tsx                      # top-level layout + routing
│   ├── components/                  # all UI components
│   ├── stores/appStore.ts           # Zustand store (~2000 lines; types in appStore.types.ts)
│   ├── ws/handleServerMessage.ts    # server-to-client message switch
│   ├── hooks/
│   │   ├── useWebSocket.ts          # WS connection + reconnect + rehydrate
│   │   └── useTabSingleton.ts       # duplicate-tab gate
│   ├── themes/                      # role-based CSS vars + shaders
│   └── utils/                       # format (efforts, ctx windows), modelCatalog, chatText, linkify, and related utilities
├── scripts/arco                   # launcher (start/stop/restart/status/logs)
├── docs/                            # this doc set
├── DEVLOG.md                        # chronological development log
├── AGENTS.md                        # contributor and agent guidance
├── README.md                        # user-facing introduction
├── AGENTS.md                        # repository contribution rules
└── CONTRIBUTING.md                  # this file
```

---

## Hot-reload caveats

### `tsx watch` kills active workers

Editing any file under `server/` or `shared/` triggers `tsx watch` to restart the server. **This kills any in-flight worker subprocesses** because they were spawned as children of the now-dead server.

If an agent is mid-turn and you save a server file, the agent dies and the chat shows a partial reply. Workarounds:
- Wait until idle to save server changes.
- Or pause the watch by editing only client files until the agent finishes.
- The launcher's `restart` command is the controlled way to bounce the server when you do want to recycle.

Client files (under `client/src/`) hot-reload via Vite without affecting workers.

### The live service does not see source edits

If Arco runs as the `arco.service` systemd user unit (service mode), it serves the compiled `server/dist` + `client/dist` and watches nothing. Edits reach it only via `npm run build` + `systemctl --user restart arco.service`. The restart kills in-flight workers in every tab and deploys whatever else is in the working tree. See `docs/SERVICE_MODE.md`.

### Vite HMR keeps WS connection

Vite's HMR doesn't reset the WebSocket; the same connection persists across client-side hot reloads. If you change `useWebSocket.ts` itself, the new code runs against the same socket. Sometimes a manual page reload is cleaner than HMR for WS-handler changes.

---

## Headless smoke harness

`scripts/smoke/` contains WebSocket scenarios for protocol and workflow behavior.
The harness in `scripts/smoke/lib.ts` provides `connect()`, `send()`,
`waitFor(predicate, timeoutMs)`, and `close()` helpers. Scenarios create a
workflow, exercise a protocol surface, assert broadcasts, and clean up.

List the available commands with:

```bash
npm run | grep smoke:
```

Run a smoke only against an isolated server with a temporary `ARCO_HOME` and a
synthetic project. Do not point it at an installed or shared Arco service. Smoke
startup and cleanup can interact with persisted workflows and worker state.

```bash
ARCO_HOME=<temporary-arco-home> ARCO_PORT=3099 npm run dev:server
ARCO_HOME=<temporary-arco-home> ARCO_PORT=3099 ARCO_SMOKE_WS_URL=ws://localhost:3099/ws npm run smoke:<name>
```

Use a separate temporary home and port for each concurrent server. Some
scenarios require environment variables. `requireServerEnv()` in `lib.ts` makes
a scenario stop immediately with a clear message when a prerequisite is absent.
`ARCO_TEST=1` enables test-only debug hooks; do not set it in a shared service
environment.

Assertions should use real exported constants rather than copied values. A
smoke should derive fixture size from the relevant limit so later limit changes
do not silently invalidate the assertion. A feature that adds protocol messages,
broadcasts, or persisted store fields should include a descriptive scenario
under `scripts/smoke/` and a matching `smoke:<feature>` script in `package.json`.
Keep fixtures synthetic and isolate provider calls.

---

## Type checks + builds

Hosted CI runs the build, typecheck, unit suite, privacy audit, and configured smoke checks. Type checks and tests are required before landing changes.

Hosted minutes are metered, and macOS and Windows runners bill at a multiple of Linux. A push to `main` or a pull request therefore runs only the Ubuntu jobs (verify with the help-registry check, browser smokes, Docker smoke), and skips changes that touch only `docs/**`, `devlog/**` or root-level `*.md` files. The macOS and Windows verify and browser jobs run on a weekly schedule and on demand through the **CI** workflow's `workflow_dispatch` form, whose `os` input selects `ubuntu`, `macos`, `windows` or `all`. Every job has a timeout, and a newer push to the same ref cancels the older run. Run the Windows and macOS jobs before a release or after a change to paths, shells, file watching or process handling; the local gate (`npm run build`, `npm run typecheck`, `npm run test:unit`, `npm run audit:public -- --tree`) stays the first line of defense.

```bash
# Type check across all three workspaces (no emit):
npm run typecheck

# Full build (production; cleans dist/ first):
npm run build
```

Anything failing `tsc` fails the workspace's `build`. The `ClientMessage` / `ServerMessage` discriminated unions (in `shared/src/protocol/clientMessages.ts` / `serverMessages.ts`, re-exported via the `shared/src/protocol.ts` barrel) are exhaustively switched on the client and the server. Adding a new variant without updating both sides will cause a compile error.

### Unit tests

Pure-logic modules ship a co-located `*.test.ts` run under the Node built-in runner: `node --conditions development --import tsx --test <file>`. Each is wired as a `test:<name>` script (root `package.json` + `server/package.json`), e.g. `npm run test:cursor-models`. Convention: add a co-located test for each new deterministic parser, budgeter, or matcher. Run the relevant `test:*` script and `npm run typecheck`; run the aggregate unit suite with `npm run test:unit`.

---

## Doc-sync (`npm run docs:check`)

The in-app help system has three pieces that must stay in lockstep: `data-help="key"` attributes on client elements, the `HELP_CONTENT` registry (`client/src/help/content/`), and the manual sections (`client/src/help/manualSections/`). Nothing at compile time enforces that a `data-help` key has a matching entry, or that an entry's `manualSection` link resolves to a real section id. `scripts/docs-check.ts` does:

```bash
npm run docs:check              # report + fail on a real orphan / dangling link
npm run docs:check -- --self-test   # fixture self-test (proves it fails loudly)
```

What it enforces (hard-fails the build):

- **Every `data-help` key has a `HELP_CONTENT` entry.** A clicked element with no help text is dangerous: it is a hard error.
- **Every `manualSection` link resolves to a real section id.** Dangling "Read more in manual" link -> hard error.

What it reports without failing:

- **Unreferenced entries** (an entry no element points at) -> **warning**, not error. This is the normal mid-coverage-pass state: a phase may pre-author help for an element it hasn't wired yet. Wire it or remove the entry when convenient.
- **Coverage percentage**: the share of interactive elements carrying `data-help`. This measure is informational only.

Dynamic keys (`data-help={`rightpanel.tab.${id}`}`) and forwarded-prop helpers (`helpKey="..."`, `const helpKey = ... ? 'a' : 'b'`, `{ 'data-help': key }`) are recognized so they don't produce false errors. See the header comment in `scripts/docs-check.ts` for the exact heuristics, and `docs/CLIENT.md` under `Help system`.

**Feature documentation obligation:** every feature phase ships its own `data-help` attributes + `HELP_CONTENT` entries + manual section(s) as part of its DONE checklist, and **`npm run docs:check` must stay green** (no new hard errors). Run it alongside `npm run typecheck` and the unit suite before landing a documentation change.

---

## Code style

### General

- TypeScript strict mode. No `any` unless you're at a wire boundary you can't type.
- Prefer single-quote strings, except inside JSX (double).
- Two-space indents.
- Trailing commas where allowed.
- Functions over classes for new code, except where Zustand actions or React class lifecycles call for them.

### Comments

This repo uses comments to capture *why*, not *what*. Long comment blocks before tricky code blocks are normal. They explain the load-bearing detail, the constraint that motivates the choice, or the constraint that the reader would otherwise miss.

If you remove a comment, you're saying its content is no longer load-bearing. Make sure that's true. If a comment describes an invariant, the invariant should also be in [`docs/GOTCHAS.md`](docs/GOTCHAS.md) so the next agent finds it without reading the file.

### CSS

**Never hard-code hex literals in components.** All colors come from theme tokens via `var(--color-...)`. Themes live under `client/src/themes/definitions/<id>.ts`.

Fonts come from theme tokens too: `var(--font-display)` for terminal/UI labels (small caps, letter-spaced), `var(--font-body)` for prose, `var(--font-code)` for code. Operators can override the active theme's font stack with a curated pack via Settings -> Font Pack Override; the substitution is global across all themes.

### Logging

Server-side logs go to stdout; the dev launcher captures them at `$XDG_CACHE_HOME/arco/arco.log`, service mode sends them to journald plus the rotating `~/.arco/logs/`. Incognito workflows suppress workflow-scoped log lines; do not add a logging path that bypasses the console tee.

Use `console.log('[arco] [<wfid-prefix>] <message>')` for workflow-scoped logs and `console.log('[arco] <message>')` for global ones. Do not bring in a logging library; the existing pattern is enough for the scale Arco operates at.

### Naming

Use `primary*` identifiers for workflow roles. Do not reintroduce `orchestrator*` names; the persisted store keys and protocol rely on the current names.

### Cross-platform

See [`docs/GOTCHAS.md`](docs/GOTCHAS.md) "Cross-platform" section. Briefly:

- No `setsid` binary: use `spawn(..., { detached: true })`.
- Bash 3.2 in scripts (macOS default). No bash-4 features.
- `/proc/` reads need a platform check.
- `pkill -f` matches differently on Linux vs macOS.

---

## Adding a new provider

Ten providers ship today: Claude (with `cli` + `native` transports), Codex (with `exec` + `appserver` transports), Gemini CLI (a native worker is not available), Z.ai GLM (`zai-native/` in-process worker on direct Chat Completions by default; optional `appserver` transport routes through the Codex app-server via a loopback Responses proxy; configure `ZAI_API_KEY`; default model `glm-5.2`, 1M context; other GLMs 128K-200K), Ollama, llama.cpp, LM Studio (OpenAI-compat `/v1`), Strata (standalone `/v1`, shared HTTP worker), Antigravity, Cursor (`cursor-agent` via the Agent Client Protocol; long-lived `acp` worker by default + a stateless `print` one-shot `cursor-agent -p --mode ask` for read-only primitives; reasoning effort is part of the model id, with a catalog of about 150 models). To add a new one (let's call it `foo`):

> **Several providers use a subdirectory layout** rather than a single file (claude-native/, codex-appserver/, zai-native/, cursor/, and the gemini-native/ stub):
> - `server/src/providers/claude-native/`: in-process Anthropic SDK worker. Read `docs/PROVIDERS.md` under `Claude Native` and `docs/GOTCHAS.md` under `Claude Native transport` before touching it; the forced-first-system-block, replay-on-restart pair-flush, and depth-1 Task cap are load-bearing.
> - `server/src/providers/codex-appserver/`: long-lived per-tab `codex app-server` process. Read `docs/PROVIDERS.md` under `Codex app-server transport` and `docs/GOTCHAS.md` under `Codex app-server transport invariants`.
> - `server/src/providers/cursor/`: long-lived `cursor-agent acp` ACP worker + stateless `print.ts` one-shot. Read `docs/PROVIDERS.md` under `Cursor`; ACP is bidirectional JSON-RPC (the agent sends fs/permission requests mid-turn that must be answered), and cluster membership rides an in-process loopback HTTP MCP (`mcp/clusterMcpLoopback.ts`), not stdio.
>
> New single-transport providers should use a single file like `ollama.ts`; new dual-transport providers should use the subdirectory pattern.

### 1. Type system

In `shared/src/protocol/providers.ts` (the `ProviderName` union lives in the split protocol directory, re-exported via the `shared/src/protocol.ts` barrel):

```ts
export type ProviderName = 'claude' | 'gemini' | 'ollama' | 'codex' | 'zai' | 'antigravity' | 'llamacpp' | 'lmstudio' | 'cursor' | 'foo';
```

Add to `PRIMARY_PROVIDERS` if foo can be a primary.

### 2. Provider implementation

Create `server/src/providers/foo.ts`. It must implement the `ProviderProcess` interface from `types.ts`:

```ts
export class FooProcess implements ProviderProcess {
  id: string;
  status: 'spawning' | 'running' | 'completed' | 'failed';
  output: string;
  pid?: number;
  
  constructor(id: string, config: WorkerConfig) { ... }
  
  async spawn(prompt: string): Promise<void> { ... }
  async kill(): Promise<void> { ... }
  
  on<E extends keyof ProviderEvents>(event: E, handler: ProviderEvents[E]): void { ... }
}
```

The unified event stream you must emit:
- `init`: `{ model, sessionId? }` on first response
- `text`: `{ text }` deltas
- `thinking`: `{ text }` reasoning blocks (skip if not supported)
- `tool_use`: `{ tool, input, toolUseId? }` (skip if not supported)
- `result`: `{ costUsd, durationMs, tokens? }` on settle
- `error`: `{ error, detail? }` on failure
- `system_notice`: `{ text }` for transient out-of-band issues

Reference implementations: `claude.ts` is the most full-featured subprocess provider; `lmstudio.ts` is the smallest HTTP provider (it reuses the Ollama tool runtime rather than owning one).

### 3. Factory

In `server/src/providers/index.ts`:

```ts
import { FooProcess } from './foo';

export function createProviderProcess(id: string, config: WorkerConfig): ProviderProcess {
  switch (config.provider) {
    case 'claude': return new ClaudeWorkerProcess(id, config);
    // ...
    case 'foo': return new FooProcess(id, config);
  }
}
```

### 4. Capability detection

In `server/src/capabilities.ts`, add a probe:

```ts
async function probeFoo(): Promise<FooCapabilities> {
  // Run `foo --version`, parse, return supported efforts/models
}
```

Wire it into `probeCapabilities()` and add the result to the `Capabilities` shape under `shared/src/protocol/` (re-exported via the barrel).

### 5. Auth

In `server/src/auth.ts`, add a status check and a login trigger:

```ts
case 'foo':
  return { provider: 'foo', loggedIn: <bool>, email: <string|null>, ... };
```

And handle the `POST /api/auth-login?provider=foo` case.

### 6. Client

In the WorkflowCreator's provider dropdown and the CONFIG tab's provider/model selectors, add the new option. Most of this picks up automatically from `Capabilities` once the server reports it.

### 7. Chat, Incognito, clusters

Decide explicitly: nothing opts a provider in by default.

- **Chat**: add it to `CHAT_PROVIDERS` in `server/src/chatMode.ts` only if the transport can honor `WorkerConfig.interactionMode:'chat'` (no project tools, isolated cwd). Web support means adding it to `CHAT_WEB_PROVIDERS` *and* making the transport state armed/disarmed explicitly (mirror the client's `WEB_CAPABLE` set in `ChatModeView.tsx`).
- **Incognito**: add it to `INCOGNITO_CHAT_PROVIDERS` only if nothing the provider runs writes to disk (no session files, no daemon log). When in doubt, leave it out; Cursor and llama.cpp are excluded for exactly this.
- **Clusters**: `isClusterMemberProvider` + a peer-tool wiring path (in-process, stdio MCP, or loopback HTTP MCP). See [`docs/PROTOCOL_CLUSTER.md`](docs/PROTOCOL_CLUSTER.md).

### 8. Docs

Update [`docs/PROVIDERS.md`](docs/PROVIDERS.md) with a section matching the existing per-provider format (Spawn / Argv / Stdin / Event parsing / Session resume / Auth / Capability detection / Quirks).

### 9. Test

- Run `npm run typecheck` (all three workspaces) and `npm run test:chat-mode` if you touched the Chat sets.
- Smoke-test in the browser: open a tab, pick the new provider, send a prompt, observe streaming.
- Try cancel mid-turn.
- Try Review with the new provider as reviewer.
- Try Handoff (only if the provider supports `original-worker` mode).

---

## Adding a new primitive

The three operator primitives (Review / Handoff / Spawn) live under `server/src/primitives/`. Adding a fourth (call it `Bar`) requires:

> **Cluster substrate is not a primitive**, but if your primitive interacts with clusters (peer messaging, plan, mailbox) you must go through the cluster substrate layer rather than directly reading the cluster files:
> - `server/src/clusterStore.ts`: cluster record persistence (create/read/delete)
> - `server/src/clusterMailbox.ts`: file-per-message mailbox (`enqueue`, `peek`, `drain`, `discard`)
> - `server/src/clusterPeerOps.ts`: peer tool implementations (`peerList`, `peerSend`, `peerRead`, `peerPlanTick`, `peerPlanWrite`)
> - `server/src/clusterRehydrate.ts`: rehydrate-on-subscribe (re-emits undelivered `peer_message_sent` to reconnecting subscribers)
> - `server/src/clusterIdleNudger.ts`: idle detection + operator-armed toast (never sends prompts)
>
> Read [`docs/PROTOCOL_CLUSTER.md`](docs/PROTOCOL_CLUSTER.md) and `docs/GOTCHAS.md` under `Cluster mode` before touching these files.

### 1. Protocol

Add the message types to the relevant file under `shared/src/protocol/` (e.g. a new `bar.ts`, exported from `protocol/index.ts`):

```ts
export interface BarRequestMessage {
  type: 'bar_request';
  workflowId: string;
  // ...params
}

export interface BarStartedMessage {
  type: 'bar_started';
  workflowId: string;
  barId: string;
  startedAt: number;
}

export interface BarArtifactReadyMessage {
  type: 'bar_artifact_ready';
  workflowId: string;
  barId: string;
  artifactName?: string;
  error?: string;
  completedAt: number;
}
```

Add them to the `ClientMessage` / `ServerMessage` unions. TS will error on the exhaustive switches until you handle them.

### 2. Server-side primitive

Create `server/src/primitives/runBar.ts` (or extend `exportContext.ts` if it's a Handoff/Spawn variant). Take a `broadcast` callback so events can be stamped to any workflow:

```ts
export async function runBar(
  ctx: { workflowId: string, cwd: string, manager: WorkerManager, broadcast: (msg) => void },
  config: BarConfig,
): Promise<BarResult> {
  // Spawn worker, collect output, write artifact, broadcast events.
}
```

### 3. Dispatcher

Put `handleBarRequest` in a per-domain module under `server/src/ws/` (e.g. `barHandlers.ts`, following `compareHandlers.ts`), and route the message type to it from the WS switch in `server/src/index.ts`:

```ts
case 'bar_request':
  await handleBarRequest(ws, msg);
  break;
```

`handleBarRequest` validates the workflow, broadcasts `bar_started`, calls `runBar`, broadcasts `bar_artifact_ready`. Pattern: copy `handleReviewRequest` and adapt.

### 4. Client

- Add a button to `TerminalInput.tsx` (next to REVIEW / HANDOFF / SPAWN) that opens a `BarDialog`.
- Create `BarDialog.tsx` modeled on `ReviewDialog.tsx`.
- Handle `bar_started` and `bar_artifact_ready` in `client/src/ws/handleServerMessage.ts`. Add `upsertBar` to the store.
- Add a `BarsPanel` under `RightPanel/` if you want a dedicated tab (see "Adding a right-panel tab").

### 5. Docs

Update [`docs/PRIMITIVES.md`](docs/PRIMITIVES.md) with a new section, and [`docs/PROTOCOL.md`](docs/PROTOCOL.md) with the new message shapes.

---

## Authoring an Arco skill

Operators create skills from the SettingsPanel SKILLS section. The on-disk shape is also hand-editable, which is useful when checking project skills into git.

Layout:

```
<cwd>/.arco/skills/<slug>/SKILL.md      # project (versioned with the repo)
~/.arco/skills/<slug>/SKILL.md          # global (user home)
```

`<slug>` is the directory name and the stable identifier: it survives renames of the user-facing `name` field. Slug pattern: `^[a-z0-9][a-z0-9-]{0,63}$`.

`SKILL.md` shape:

```markdown
---
name: <operator-facing name>
description: <one-line summary the agent reads to decide when to apply this skill>
operator-only: <true to withhold from the model manifest; available through the +SKILL composer pick>
---

<body: the playbook the agent follows>
```

Frontmatter is required (YAML, single-line values, optional surrounding quotes). Skills missing a `name:` are silently skipped during the scan. `operator-only` is optional (parsed case-insensitively; any value but `true` leaves it model-visible).

Per primary turn, the server scans both roots, builds an XML `<arco-skills>` manifest of name + description + absolute path, and prepends it to the system prompt. Only the manifest goes into the prompt; the agent reads the full body via its `Read` tool when it picks a skill (Pi's progressive-disclosure model). This bounds prompt cost while leaving the skill body unbounded.

Skills with `operator-only: true` are excluded from the `<arco-skills>` manifest the model sees; the user includes the body on demand via the `+SKILL` composer picker. Two related new surfaces: the SKILLS editor's AUDIT button (`POST /api/skills/audit`, diagnostic only) and the project-trust gate (skills from an untrusted repository are suppressed until a user approves the repository, `server/src/projectTrust.ts`).

Server module: `server/src/skills.ts`. HTTP surface: `/api/skills` (see `docs/HTTP_API.md`). UI: `SettingsPanel.tsx` SKILLS section + `SkillEditorDialog.tsx` (see `docs/CLIENT.md`).

---

## Adding a new theme

`client/src/themes/` separates Classic definitions from generated Phosphor palettes. The steps below add a **Classic** theme; Phosphor imports use the catalog/adapter procedure below.

### 1. Definition

Create `client/src/themes/definitions/myTheme.ts`:

```ts
import type { Theme } from '../types';

export const myTheme: Theme = {
  id: 'my-theme',
  name: 'My Theme',
  tokens: {
    'color-bg': '#0a0a0a',
    'color-fg': '#ffffff',
    'color-fg-muted': '#888888',
    'color-accent-primary': '#00ff00',
    // ...all 30+ role-based vars
  },
  density: { /* spacing-unit, border-width, radius-* */ },
  fonts: {
    display: "'IBM Plex Mono', monospace",
    body: "'Inter', sans-serif",
    code: "'IBM Plex Mono', monospace",
    googleFontsUrl: 'https://fonts.googleapis.com/css2?family=...&display=swap',
  },
  animations: { scan: true, pulseHalo: false, flicker: false, cursorBlink: true },
  shaderPreset: 'matrix-rain', // must match a supported Classic shader preset
  borderRenderer: 'css', // 'css' | 'rough'
};
```

Match the existing tokens by reading another theme: `matrix.ts` is the canonical reference.

### 2. Registry

In `client/src/themes/registry.ts`:

```ts
import { myTheme } from './definitions/myTheme';

export const CLASSIC_THEME_REGISTRY: Record<ThemeId, Theme> = {
  ...,
  'my-theme': myTheme,
};
```

Also add `'my-theme'` to `CLASSIC_THEME_IDS` (which feeds `VALID_THEME_IDS`) in `shared/src/protocol/themes.ts` (re-exported via the barrel).

### 3. Test

Open the SettingsPanel -> Theme picker. Switch to your theme. Verify:
- Chat is readable (operator/assistant/system contrast)
- Composer focus ring is visible
- Right-panel tab labels are legible
- The shader (if any) doesn't tank framerate

If you add a new shader, see "Adding a shader" below.

### 4. Docs

Update the theme list in [`docs/CLIENT.md`](docs/CLIENT.md) "Available themes" section.

### Phosphor catalog updates

Do not add dozens of hand-written Classic definitions or reuse Classic IDs.
Update the traceable local `themes/phosphor/arco-palette.ts` snapshot and its
revision/hash notes, adapt roles in `paletteAdapter.ts`, and regenerate the ordered
`shared/src/protocol/phosphorPaletteIds.ts` allowlist. Both client registry and
server validation must accept the same namespaced IDs. Run `npm run test:phosphor`
and review representative palettes, Classic restoration, fonts/brightness/crisp,
reduced motion and effects-off. Keep the family-specific ambient renderer mutually
exclusive with Classic Three.js. See `docs/CLIENT.md` for the supported theme catalog and rendering rules.

### Documentation for operator-visible changes

Treat these as separate checks; a green link checker does not prove accuracy:

1. Update the relevant `client/src/help/content/` entries **and** manual sections.
2. Wire new controls with `data-help` (a wrapper is appropriate for disabled
   controls). Keep help clicks non-consequential and link to a real manual section.
3. Check names, defaults, provider/transport limits, failure recovery and privacy
   against code; do not copy a historical plan's intended behavior into current help.
4. Update README/current subsystem docs and add a dated DEVLOG entry. Preserve
   historical evidence; annotate stale deployment labels instead of guessing dates.
5. Run `npm run docs:check`, its `-- --self-test`, `npm run test:help-docs`, and
   client type/build checks. Open the actual manual, search new topics/table rows,
   and click contextual help. Record surfaces not exercised.

Use `docs/INDEX.md` to locate maintained documentation.

---

## Adding a shader

Shaders live under `client/src/themes/shaders/<name>.frag.glsl` and are imported as raw strings in `client/src/themes/shaders/index.ts`.

### Constraints

- Use `precision highp float;` (Mali GPU NaN cascades on `mediump`)
- Bound any `hash` inputs to a sane range: long-uptime drift can produce NaN that propagates through the whole pixel grid (see commit `8a5af37`)
- Keep instruction count low: these run per-pixel at 60fps
- **No smooth radial gradients (vignettes / atmospheric noise washes / breathing blobs / orbs) on dark themes.** They posterize visibly under 8-bit alpha compositing against near-black. Use structural elements only: particles, streaks, grids, dots, vein lines, scanlines, hard-edged cells. See `docs/GOTCHAS.md` under `Themes / shaders` for the current palette and shader constraints.

### Pattern

```glsl
#version 300 es
precision highp float;

uniform float uTime;
uniform vec2 uResolution;
uniform vec3 uAccentPrimary;
uniform vec3 uAccentSecondary;

out vec4 fragColor;

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution.xy;
  // ...your shader logic
  fragColor = vec4(color, 1.0);
}
```

`ThemedBackgroundShader.tsx` provides the standard uniforms (`uTime`, `uResolution`, `uAccentPrimary`, `uAccentSecondary`).

---

## Adding a right-panel tab

`client/src/components/RightPanel/index.tsx`. RightPanel was split into a directory: each tab body lives as its own module under `client/src/components/RightPanel/<Name>Tab.tsx` (e.g. `ConfigTab.tsx`, `ActivityTab.tsx`, `ReviewTab.tsx`).

### 1. Component

Create `client/src/components/RightPanel/MyTabPanel.tsx` alongside the existing tab bodies. It receives the active job as a prop and renders its content.

### 2. Wire into RightPanel

`TABS` is an `{ id, label }` array, not a string union. Add your entry:

```tsx
const TABS: { id: RightTab; label: string }[] = [
  { id: 'files', label: 'FILES' },
  /* ...existing... */
  { id: 'mytab', label: 'MYTAB' },
];
```

Add `'mytab'` to the `RightTab` union in `RightPanel/types.ts`. Tabs are also bucketed into the WORKSPACE / AGENT / MEMORY / RUNTIME `GROUPS` array: add the new id to the relevant group's `tabs` list or it won't render. Then add the render-on-active block:

```tsx
{tab === 'mytab' && <MyTabPanel job={job} />}
```

### 3. Persist tab selection

The right panel persists the active tab to localStorage at `STORAGE_KEY`. Adding a new tab name means existing localStorage values are still valid; nothing else needs changing.

---

## Working with the WS protocol

### Client -> Server

Send via `wsRef.current?.send(JSON.stringify({ type: 'foo', ... }))`. The dispatcher in `useWebSocket.ts` doesn't help with sends; senders are scattered across components (each composer button, the workflow creator, the recalibrate button, etc.).

### Server -> Client

Add a case to the switch in `client/src/ws/handleServerMessage.ts` (`useWebSocket.ts` owns the socket and hands frames to it). The Math.max-based `lastSeq` update is automatic. Only the per-message-type state mutation needs handling.

### Persistence

If your message has a `workflowId`, it's automatically stamped with `seq` and persisted in `events.jsonl` by `persistAndStampSeq()`. If you specifically want it transient (broadcast but not persisted, for example `quota_status` or `context_usage`), use `broadcastTransient()` instead of `send()`.

See [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the persisted-vs-transient breakdown.

---

## Debugging

### See what's on the wire

Browser devtools -> Network -> WS frames. The single `/ws` connection carries all the chatter; filter by message type with the search box.

### See what's persisted

```bash
tail -f <cwd>/.arco/workflows/<wfid>/events.jsonl | jq .
```

You'll see every server-to-client message as it's broadcast.

### Composer stuck

The diagnostic chip (`b·w·s`) next to CANCEL tells you which flag is keeping the composer in queue mode. See [`docs/OPERATIONS.md`](docs/OPERATIONS.md) "Recovering stuck states."

### Worker output truncated

50 MB cap per worker per turn (`ARCO_MAX_WORKER_OUTPUT_BYTES`). Check the worker's `output` in the WorkerDetailModal: there's a truncation notice at the end if it hit the cap.

### Antigravity tool rows missing or mis-labelled

Antigravity is RPC-only now (the CDP port is liveness only), so DOM-scrape tooling such as `scripts/antigravity-chat-dump.mjs` is historical. Set `ANTIGRAVITY_RPC_TRACE_STEPS=1` (compact per-step JSONL) or `ANTIGRAVITY_RPC_TRACE_RAW=1` (redacted raw step objects) and read `<cwd>/.arco/workflows/<wfid>/debug/antigravity-rpc-steps*.jsonl`; see `docs/PROVIDERS.md` under `Antigravity`.

---

## Commit / PR conventions

The repo's commit-message format:

```
Subject prefix: concise description in active voice

Optional body explaining the WHY. Wrap at 80 chars. Bullet points
for multi-part changes. Do not add co-author or tool-attribution trailers.
```

Example subjects:

```
Restart: SIGKILL the dev tree and tighten kill-vs-respawn timing
Shaders: highp + bounded hash inputs to prevent long-uptime freeze
Theme system overhaul: new themes, shaders, header chips
```

Pull requests are welcome. Include a concise change summary, verification results, and any remaining limitations.

---

## DEVLOG

Significant changes get a chronological entry in [`DEVLOG.md`](DEVLOG.md) at the top. Read the top entry when resuming work; it is the running context log. Do not move entries around; append to the top.

For contributors and agents, read [`AGENTS.md`](AGENTS.md) before starting. It contains the repository rules and development-log requirements.

---

## Cross-references

- [README](README.md): user-facing introduction
- [Architecture](docs/ARCHITECTURE.md): system map
- [Protocol](docs/PROTOCOL.md): WS message reference
- [Providers](docs/PROVIDERS.md): per-provider deep dive
- [Primitives](docs/PRIMITIVES.md): Review/Handoff/Spawn
- [Persistence](docs/PERSISTENCE.md): disk layout
- [Client](docs/CLIENT.md): store, components, themes
- [Operations](docs/OPERATIONS.md): running, stopping, recovery
- [Gotchas](docs/GOTCHAS.md): invariants and "don't regress"
- [Glossary](docs/GLOSSARY.md): terminology
