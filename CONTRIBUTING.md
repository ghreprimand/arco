# Contributing to Arco

Contributor setup, verification, code style, and repository workflow. Extension recipes are in [Extending Arco](docs/EXTENDING.md).

For the architecture map, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). For terminology, see [`docs/GLOSSARY.md`](docs/GLOSSARY.md). For "don't regress X," see [`docs/GOTCHAS.md`](docs/GOTCHAS.md). For debugging and hot-reload notes, see [`docs/DIAGNOSTICS.md`](docs/DIAGNOSTICS.md).

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

## Extending Arco

Six implementation recipes are maintained in [`docs/EXTENDING.md`](docs/EXTENDING.md):

- [Add a provider](docs/EXTENDING.md#adding-a-new-provider).
- [Add a primitive](docs/EXTENDING.md#adding-a-new-primitive).
- [Author a skill](docs/EXTENDING.md#authoring-an-arco-skill).
- [Add a theme](docs/EXTENDING.md#adding-a-new-theme).
- [Add a shader](docs/EXTENDING.md#adding-a-shader).
- [Add a right-panel tab](docs/EXTENDING.md#adding-a-right-panel-tab).

The recipes are unchanged and remain grouped by extension point.

## Working with the WS protocol

### Client -> Server

Send via `wsRef.current?.send(JSON.stringify({ type: 'foo', ... }))`. The dispatcher in `useWebSocket.ts` doesn't help with sends; senders are scattered across components (each composer button, the workflow creator, the recalibrate button, etc.).

### Server -> Client

Add a case to the switch in `client/src/ws/handleServerMessage.ts` (`useWebSocket.ts` owns the socket and hands frames to it). The Math.max-based `lastSeq` update is automatic. Only the per-message-type state mutation needs handling.

### Persistence

If your message has a `workflowId`, it's automatically stamped with `seq` and persisted in `events.jsonl` by `persistAndStampSeq()`. If you specifically want it transient (broadcast but not persisted, for example `quota_status` or `context_usage`), use `broadcastTransient()` instead of `send()`.

See [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the persisted-vs-transient breakdown.

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

## Releases

A user-visible change adds a concise bullet under `## Unreleased` in
[CHANGELOG.md](CHANGELOG.md) in the same commit. Use Added, Changed, Fixed, or
Removed, describe the effect on a user, and leave implementation evidence in the
development log. Keep the root, shared, server, and client package versions in
sync; the unit suite checks them.

The Director cuts a release after the operator confirms the version. Before 1.0,
a minor version identifies a feature or behavior change; a patch identifies a fix
or documentation update. Start with a clean `main` equal to `origin/main` after
fetching and completing the local gate:

```sh
git fetch origin
npm run build
npm run typecheck
npm run test:unit
npm run docs:check
npm run audit:public
node scripts/release.mjs patch --dry-run
node scripts/release.mjs patch
```

The inaugural release is the one exception to the bump and empty-Unreleased rules:
when there are no local version tags, `node scripts/release.mjs 0.1.0` uses the
already seeded `v0.1.0` notes and retains the package version. It requires an
empty Unreleased section and no other release sections. Any pending changes must
be reviewed before that tag is cut.

Use `minor`, `major`, or an explicit newer `X.Y.Z` instead of `patch` when
appropriate. Unreleased must contain a change bullet. The dry run prints the
exact planned edits and tag message without changing files. The real invocation
rolls the changelog, updates all four manifests and their lockfile entries, and
opens the release devlog stub in the configured Git editor (`GIT_EDITOR` or
`core.editor`). Complete the entry with the checks actually run and remove its
`RELEASE_ENTRY_REQUIRED` marker. An unchanged stub or failed editor prevents the
commit; the edits remain available for review and recovery.

The script commits `Release vX.Y.Z` with the project identity and creates the
annotated `vX.Y.Z` tag from the changelog section. It never pushes. The Director
reviews the release diff and tag, then explicitly pushes both:

```sh
git show --stat HEAD
git show HEAD
git tag -n99 vX.Y.Z
git push origin main vX.Y.Z
```

Replace `vX.Y.Z` with the reviewed tag. The tag workflow checks its package
version, runs the Ubuntu verification gate, and publishes the changelog section
as a GitHub Release using the built-in token. Automatic source archives are the
only assets. Failed publishing is recovered through the workflow; the release
script does not overwrite an existing local tag. The release notes can be
inspected independently with `node scripts/release/notes.mjs vX.Y.Z`.
