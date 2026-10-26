# Arco

Arco is the public release of a private workbench for building and operating software with provider-backed agents. It preserves the workbench, behavior, and voice operator while preparing the project for public use on Linux, macOS, and Windows.

Arco is for people who want project-aware agent workflows, saved chat, local tools, clusters, and voice controls in one interface. A model or provider does not come bundled with Arco. Connect a provider account or local model endpoint, then choose the project and workflow from the workbench.

## Quick start

### Native

Clone the public repository into a directory named `arco`, then run:

```bash
git clone https://github.com/ghreprimand/arco.git
cd arco
npm ci --include=dev
npm run dev
```

Open <http://localhost:5173>. The Vite client proxies API and WebSocket traffic to the local server. `npm run dev` keeps the server and client running together; the Vite client listens on all network interfaces, so devices on a reachable network can load the development client. API calls remain subject to the browser session check. Use a trusted network during development. A new installation without projects or connected providers opens **Welcome to Arco**: add a folder, connect a provider, then launch the prefilled creator. Every step can be skipped. Settings > Projects > **Run setup again** reopens the flow; **CONNECT A PROVIDER** opens Connections later. Follow [Getting started](docs/GETTING_STARTED.md) to open a project and start a chat.

Ensure `NODE_ENV` is not set to `production` during installation, because the native build needs development dependencies. Node.js 24 or newer is required. A C/C++ toolchain and Python 3 may be needed when a native dependency has no prebuilt binary for the platform.

### Docker

Create a local `.env` from `.env.example`. Run `mkdir -p projects` for the
sample `ARCO_PROJECTS_DIR` on macOS, Linux, or WSL; in PowerShell, use
`New-Item -ItemType Directory -Force projects`. Alternatively, change
`ARCO_PROJECTS_DIR` to an existing project folder on the host. Then run:

```bash
mkdir -p projects
docker compose up -d --build
```

In PowerShell, create the folder with `New-Item -ItemType Directory -Force projects`, then run `docker compose up -d --build`.

Open <http://localhost:3001>. The Arco home persists in a named volume and the selected project folder is mounted read-write. Mounted projects appear in Home under container paths such as `/projects/demo`. Provider login runs inside the container so credentials stay in its persistent home. See [DOCKER.md](docs/DOCKER.md) for provider commands, extra mounts, and container limits. Voice microphone capture requires a native run.

## Provider overview

The workbench supports Claude, Codex, Z.ai, Gemini, Cursor, Antigravity, Ollama, LM Studio, llama.cpp, Strata, and DeepSeek through Xolotl. Availability depends on provider setup, account access, installed command-line tools, or a reachable local endpoint. See [PROVIDERS.md](docs/PROVIDERS.md).

## Feature tour

- [Getting started](docs/GETTING_STARTED.md): first chat, first cluster, voice setup, state, and backup
- [Chat](docs/CHAT.md), [Terminal](docs/TERMINAL.md), and [Git workbench](docs/GIT_WORKBENCH.md)
- **Interrupt and send:** stop an active Claude or Codex Agent turn and run the correction next; other queued messages remain. Use the composer button or `Ctrl/Cmd+Enter`. See [Providers](docs/PROVIDERS.md#interrupt-and-send).
- [Clusters and tasks](docs/TASK_LEDGER.md), [Knowledge](docs/KNOWLEDGE.md), and [Recall](docs/RECALL.md)
- [Voice and Computer](docs/VOICE.md), [Media studio](docs/MEDIA_STUDIO.md), and [Live Preview](docs/PREVIEW_VERIFY.md)
- [Operations](docs/OPERATIONS.md), [Persistence](docs/PERSISTENCE.md), [Backup](docs/BACKUP.md), and [Remote Management](docs/REMOTE_MANAGEMENT.md)

See the [documentation index](docs/INDEX.md) for the full reference set and [development status](docs/DEVELOPMENT_STATUS.md) for current capability and platform limits.

## Platform support

| Platform | Current status |
| --- | --- |
| Linux native | Development platform; host acceptance remains open |
| macOS native | Target-host acceptance remains open |
| Windows native | Target-host acceptance remains open |
| Docker | Baseline is available; fresh-install acceptance remains open |
| Voice | Setup downloads components on request; target-host acceptance is tracked separately |

## Privacy and state

Arco stores global settings and Arco-managed provider connection data in the Arco home, which defaults to `~/.arco` on Linux and macOS and `%USERPROFILE%\.arco` on Windows. Provider command-line tools may keep their own login data in their provider-managed locations. Project workflows and project settings are stored in each project's `.arco` folder. `ARCO_HOME` relocates the global home.

When a user submits a model request, Arco sends the prompt and selected context to the chosen provider. Provider requests follow that provider's data and billing terms. Other network access occurs for user-selected features such as provider sign-in, catalog lookup, and voice setup downloads. Arco does not upload project folders for telemetry. The production server binds to loopback by default. The `npm run dev` Vite client is an exception and listens on all interfaces; review the [Operations exposure posture](docs/OPERATIONS.md#exposure-posture) before exposing a development instance to a network.

Arco is the public release of a private workbench. The license decision and final release review remain open; redistribution terms will be published after that review.

---

## Status


Development and platform acceptance are in progress. See [Development status](docs/DEVELOPMENT_STATUS.md) for current capabilities and remaining release work.

## Help and appearance

Appearance is controlled in **Settings > Theme > Arco Classic / Arco Phosphor**.
Classic retains existing selections; Phosphor shares one CRT presentation across
68 palettes, with adjustable glow and effects. Fonts, text/background brightness
and crisp text remain independent. See the [Phosphor preview](docs/PHOSPHOR_DEMO.md).

The in-app **MANUAL** and contextual help explain controls and recovery. Current documentation coverage and remaining work are listed in [development status](docs/DEVELOPMENT_STATUS.md).

## Architecture in 60 seconds

- **Agent tabs are project workflows; Chat tabs are projectless.** Each Agent workflow owns one long-lived **primary agent** (Claude / Codex / Z.ai / Gemini / Cursor / Ollama / llama.cpp / LM Studio / Strata / DeepSeek / Antigravity). Claude has two transports per tab (`cli` per-turn spawn vs `native` long-lived in-process `@anthropic-ai/sdk` worker); Codex has two (`exec` per-turn spawn vs `app-server` long-lived per-tab process); Z.ai has two (`native`, the default - an in-process worker calling `api.z.ai` Chat Completions directly - vs `app-server`, the Codex app-server path through Arco's local Responses-to-Z.ai proxy). Toggleable transports live in the CONFIG tab where applicable.
- **Operator primitives** layer on top: **Review** (cross-family second opinion, including plan-scoped review), **Compare** (race one prompt across N providers, vote a winner), **Research** (bounded web-research turn -> cited report), **Handoff** (rotate session within the same tab), **Spawn** (fork to a new tab). Plus two structured one-off composer prompts (**DOCS** and **GIT**) that dispatch in-tab or spawn a new tab under a different model via the RUN AS picker.
- **Clusters** group N tabs sharing one cwd around a peer-tool substrate (`peer_list` / `peer_send` / `peer_read`) and a shared plan, with per-member role hints. Operator-driven by default; operator-armed cluster assists may draft or dispatch through visible, logged, reversible task APIs.
- **No hidden orchestrator authority.** No silent autonomous routing. No LLM-curated memory. Models can assist only through previewed proposals, explicit operator approval, or normal bounded tools with recorded actor identity.
- **Durable conversation replay.** Saved workflow/chat events carry monotonic sequence numbers and replay from `events.jsonl` on reconnect. Transient telemetry and explicitly memory-only Incognito are not durable history.
- **Native session interop.** Arco's Claude (CLI transport) and Codex (`exec` transport) sessions are real CLI sessions - start here, resume in a terminal with `claude --resume <uuid>`, and vice versa. Codex `app-server` likewise stores rollouts under `~/.codex/sessions/`. Claude Native is the exception: the Messages API is stateless, so a Native session lives in Arco's `events.jsonl` and cannot be resumed from a terminal.

Full system map: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## What Arco does

- **Tabbed multi-provider workspace** - every project is a tab. Each tab has one long-lived primary agent (Claude / Codex / Z.ai / Gemini / Cursor / Ollama / llama.cpp / LM Studio / Strata / DeepSeek / Antigravity) the operator chats with directly.
- **Project Home** - cards represent folders from arbitrary paths. Stable project identity preserves saved workflows across relocation; cards can be pinned, archived, opened, or continued. See [Getting started](docs/GETTING_STARTED.md).
- **Native session interop** - every Arco Claude-CLI / Codex-exec session is a native CLI session. Start in Arco, resume in a terminal with `claude --resume <uuid>`. Start in a terminal, resume in Arco. Arco owns tab-state; the provider owns conversation-state.
- **Inline tool-call pills** - when the primary invokes Bash / Read / Grep / WebFetch / etc., each call renders as a compact row between assistant bubbles. Click to expand the full JSON input; click a file path to open it in the viewer modal.
- **Interrupt & send** - while a Claude or Codex Agent is working, click **INTERRUPT & SEND** or press **Ctrl/Cmd+Enter** to stop that turn and send the draft next in the same conversation. Works on both transports for each provider. Existing queued messages run afterward; completed edits remain in place. The adjacent **SEND** button and Enter keep ordinary steering; Alt+Enter queues a follow-up.
- **Per-tab transport toggles** - Claude has two transports (`cli` per-turn spawn vs `native` long-lived in-process worker via `@anthropic-ai/sdk`); Codex has two (`exec` per-turn spawn vs `app-server` long-lived per-tab process); Z.ai has two (`native` vs `app-server`). CONFIG-tab toggle on each Claude / Codex / Z.ai tab; cascade default in TRANSPORT DEFAULTS (`settings.json`). Cursor's `print` one-shot is routed automatically for read-only primitives, not toggled. Reviewers and handoff seeds always run on the default transport regardless. Native unlocks server-side compaction + auto-handoff, plan-mode arming, and Task subagent fan-out; Codex appserver unlocks structured `turn/interrupt` cancel + non-destructive `turn/steer` mid-turn input.
- **Per-project configuration** - pick provider, model, effort, and tool allowlist per tab, live-editable from the CONFIG tab. Same-provider model/effort swaps take effect on the next turn; no session rotation needed.
- **Context usage monitoring** - the footer shows `CTX: NNK / NNK NN%` color-coded against the model's window. Claude CLI tabs use the CLI session's latest context snapshot with JSONL byte-size calibration as fallback; Claude Native uses `messages.countTokens()` on the retained next-turn prompt; Codex and Z.ai app-server tabs use the latest per-call token snapshot from the rollout file (Z.ai native uses the final `prompt_tokens`). Codex tabs default to the account's **MAX** context window (resolved from `$CODEX_HOME/models_cache.json`; CONFIG can switch a tab to STANDARD), and the denominator prefers the provider-reported window, then that catalog estimate. Native compact clears stale Codex/Z.ai context fill until the next real snapshot arrives.
- **Auto-handoff at threshold** - when context fill reaches the configured limit (default 90%), the agent automatically writes a handoff document and the tab rotates to a fresh session; a warning fires at a lower threshold (default 75%). Configurable per-tab for providers with a trusted context-fill signal: Claude (CLI + Native), Codex (both transports), Z.ai, and Ollama.
- **Context management and Fold (Claude Native)** - beyond auto-handoff, Native tabs expose a deterministic **FOLD FOLD** composer button that trims older history into a digest while keeping a verbatim recent tail in the *same* session - no model round (cheaper than Compact) and no fresh worker (cheaper than Handoff); the raw transcript stays in `events.jsonl`. An **AUTO-FOLD** toggle in CONFIG (off by default, fires when the budget crosses a FOLD AT kept below the warn threshold) automates it, and a per-turn token-budget meter plus tool-result eviction keep large tool outputs from blowing the window.
- **North-star objective** - pin a durable free-text goal per tab (CONFIG -> NORTH STAR, the `/goal <text>` composer command, or the always-visible GOAL chip above the composer). It folds into the system prompt on every turn on every transport and is inherited by Review / Handoff / Spawn, but stays pure context: operator-write, model-read-only, byte-capped, with an anti-autonomy trailer - no tool can mutate it.
- **Goal run** - `/goal run <n>` (or CONFIG) arms a per-tab loop that dispatches one deterministic continuation turn toward the north star after each settled turn, up to `n` iterations (default 10, max 500). Stops on budget spent, a turn error, provider throttle, context >=92%, or a cleared north star; the **RUN n/N** chip above the composer is one-click stop. It continues because budget remains - never because a model judged the work unfinished. Not persisted across a server restart. See [`docs/GOTCHAS.md#goal-run-north-star-auto-continue`](docs/GOTCHAS.md#goal-run-north-star-auto-continue).
- **Ultracode mode (Claude)** - a sticky per-tab toggle (the **ULTRACODE** composer pill) that pins the tab to the Claude CLI transport at `xhigh` effort with the multi-agent **Workflow** orchestration tool armed, so a single turn can fan out and coordinate a fleet of subagents; a live **FLEET** panel shows the running/done subagent count and a per-tab web-lookup budget bounds research spend. Operator-armed and sticky until toggled off.
- **Cross-provider review on tap** - select Review and a different model (Codex reviewing Claude, Antigravity reviewing either, a local model for a cheap sanity check), get structured feedback as a read-only artifact in the REVIEW tab. A `SEND TO AGENT` button pre-fills the composer with the review body. Local reviewers receive an addendum to verify diff claims with their read-only tools to verify diff claims against the live tree.
- **Compare the field** - the `COMPARE` button races one prompt across N providers/models at once; results land in a side-by-side overlay and the operator votes a winner. No hidden auto-synthesis - the operator chooses whether to run an optional bounded synthesis leg.
- **Bounded web research** - the `RESEARCH` button runs a single bounded web-research turn (fan-out searches + source fetch) and produces a cited markdown report in the RESEARCH tab. Bounded, operator-initiated, one report per dispatch.
- **Plan-scoped review** - when a plan is attached, the PLAN tab pairs REVIEW (audit plan structure) with VERIFY (audit claimed-done work, with `git diff HEAD` pre-included) at whole-plan and per-phase granularity, plus `CUSTOM REVIEW` (tree-with-checkboxes picker). VERIFY shows only `[x]`-completed items; CRITIQUE shows everything for plan-level evaluation. The parser tolerates checkbox-stripped plans (recognizes `- **N.M**` numbered bullets as tasks).
- **Spawn-phase from plan** - alongside per-task SPAWN, each `### Phase` heading gets a SPAWN PHASE button that opens SpawnDialog prefilled with the full phase block.
- **One-click handoff** - when the conversation gets long, click Handoff. The agent writes a structured handoff document; a fresh agent starts in the same tab with that handoff as its seed. Seed messages collapse to a one-line `HANDOFF SEED / click to expand` pill. Both sessions remain valid native-CLI sessions.
- **Spawn from here** - fork the conversation to a new tab. The agent self-reflects with full session context and writes a handoff doc; a new tab opens with that doc as its seed and an optional `new direction:`. The original tab continues in parallel.
- **DOCS one-off prompt** - `DOCS` opens a dialog that sends a structured prompt to update repo markdown docs based on recent git activity. Hard-coded constraint: **does not modify anything under `.arco/plans/`** (load-bearing checkbox / H3 structure the Plan tab parses).
- **GIT one-off prompt** - `GIT` opens a dialog with live git status (branch, ahead/behind, dirty files), branch dropdown + `+ NEW BRANCH` form (server-side dirty-tree refusal on switch), action picker (commit / commit + push / commit + push + PR via `gh pr create`), protected-branch warnings, per-repo localStorage prefs, and a commit-subject hint. Branch switch happens server-side via `POST /api/git/checkout` before the prompt dispatches.
- **RUN AS picker** (in GIT / DOCS dialogs) - override the current tab's provider/model/effort for the one-off prompt. If unchanged, dispatches in-tab; if changed, a new tab opens with the picked config and runs the work there.
- **Embedded terminal** - a real PTY session bound to the workflow's cwd, available as a floating/popout terminal. Output streams over the WS channel; the terminal can pipe selected output back into the composer. See [`docs/TERMINAL.md`](docs/TERMINAL.md).
- **Recall** - full-text search across saved conversations and transcripts (SQLite-backed index at `~/.arco/recall/`), with per-result summaries for finding prior work. See [`docs/RECALL.md`](docs/RECALL.md).
- **Knowledge / codebase memory** - distill a repository into a structured memory document, store it, and inject relevant slices into the agent's context (RAG injection) on the turns that need it. KNOWLEDGE tab manages articles, links, and session-distilled notes; a BLAST RADIUS view surfaces what a change touches. See [`docs/KNOWLEDGE.md`](docs/KNOWLEDGE.md).
- **Genesis** - a project scaffolder and creative tool: the operator describes a project idea, then Genesis stages a plan and bootstraps the project skeleton in a fresh cwd. GENESIS tab. See [`docs/CLIENT.md`](docs/CLIENT.md) for the workflow creator and Genesis integration.
- **DeepSeek via Xolotl** - a separately managed service with configurable profiles, guarded loading and unloading, text/image/tool support, reasoning, in-app help, and source-version tracking. Resource needs depend on the configured profile. Arco does not download model weights. See [`docs/DEEPSEEK.md`](docs/DEEPSEEK.md).
- **Strata large MoE models** - separate OpenAI-compatible service with configured profiles, discovered context and capabilities, optional image input, web tools, reasoning, and engine tok/s. One model loads per turn; FREE VRAM releases local models. Memory budgets and recovery: [`docs/STRATA.md`](docs/STRATA.md).
- **Cookbook** - a fit-scored catalog of local models matched to available hardware, with one-click install + recommendations (probes VRAM/RAM, scores each model's fit, points at the right quant). See [`docs/COOKBOOK.md`](docs/COOKBOOK.md).
- **LSP-backed tools** - a language-server client pool feeds the agent real go-to-definition / references / diagnostics for supported languages. See [`docs/LSP.md`](docs/LSP.md).
- **MCP registry** - an operator-managed registry of MCP servers, enable/disable per workflow (and a per-server tool disable-list) from the CONFIG tab's MCP section. Registry-add runs an OSV malware pre-check (block-with-override, fail-open), and MCP children run under an env allowlist so child processes do not inherit provider credentials. See [`docs/MCP_REGISTRY.md`](docs/MCP_REGISTRY.md).
- **Diagnostics & support bundles** - health checks (auth, binaries, ports), per-model health probes, and a one-click support-bundle export, surfaced in the SYSTEM modal's DIAGNOSTICS / MODELS / SERVICES tabs. See [`docs/DIAGNOSTICS.md`](docs/DIAGNOSTICS.md).
- **Project task ledger + worktrees** - durable, cwd-scoped task records (TRIAGE / TODO / READY / IN PROGRESS / BLOCKED / REVIEW / DONE / ARCHIVED) in the LEDGER tab, with optional git-worktree-backed task tabs so each task gets an isolated checkout. See [`docs/TASK_LEDGER.md`](docs/TASK_LEDGER.md) + [`docs/CHECKPOINTS.md`](docs/CHECKPOINTS.md).
- **Local-services discovery** - a machine-wide browser of local web services (listening ports + heuristics) with an "open in Preview" action to open a local development server in Arco's preview pane. SYSTEM -> SERVICES. See [`docs/LOCAL_SERVICES.md`](docs/LOCAL_SERVICES.md).
- **Remote management** - opt a workflow into remote management (`REMOTE` toggle in the composer) and link the instance to a hub for lifecycle commands. See [`docs/REMOTE_MANAGEMENT.md`](docs/REMOTE_MANAGEMENT.md).
- **Notifications** - an in-app notification center + toasts, plus optional external push via [ntfy](https://ntfy.sh) so long turns can send notifications to a configured device. See [`docs/NOTIFICATIONS.md`](docs/NOTIFICATIONS.md).
- **Checkpoints** - git-snapshot-backed working-tree checkpoints and one-click revert, for reverting the working tree to a known-good point without manual stashing. See [`docs/CHECKPOINTS.md`](docs/CHECKPOINTS.md).
- **Live Preview tab** - the PREVIEW tab loads the workflow's dev server (Vite, Next, Astro, etc.) in a sandboxed iframe with operator-selectable aspect ratio. `npm run dev` is auto-detected (Bash-command sniff + port probe + `/proc` PID-attributed listening-port discovery on Linux); a same-origin proxy keyed by workflowId keeps HMR working through Arco's single forwarded port. Manual `BIND <port>` / `UNBIND` override auto-detect. See [`docs/PREVIEW_VERIFY.md`](docs/PREVIEW_VERIFY.md).
- **Worktree bake-offs** - race one implementation prompt through 2-5 provider/model tabs from the same commit, compare their transcripts and diffs, then explicitly promote one no-fast-forward merge. Attempts live in isolated managed worktrees; Arco never auto-selects a winner. See [`docs/GIT_WORKBENCH.md`](docs/GIT_WORKBENCH.md#i5-worktree-bake-off).
- **HISTORY tab** - read-only timeline of seq-stamped narrative events with four operator actions: `LABEL THIS` (pin a free-text label, persisted to `events.jsonl`), `REVIEW FROM HERE` (since-event Review), `SPAWN FROM HERE` (cutoff-aware Spawn so the new tab boots with the transcript truncated at the chosen seq), and `REWIND CONVERSATION` (Native-first restore-point - move the live head back to a chosen seq; the current branch is kept and can be returned to, with fork markers rendered inline and a REWINDS filter). Native-only; rejected on CLI / Codex.
- **Tasks (Claude Native)** - when the Native worker calls the `Task` tool, the spawned sub-agent is a first-class Arco workflow scoped to its parent: inline `TaskCard`, a TASKS sub-tab (gated on non-empty children), parallel `Task` calls dispatch concurrently. Depth-1 cap by design.
- **Built-in GitHub browser** - the GITHUB tab browses repos, file trees, source, PRs, issues, Actions runs, and can clone - authenticated via `gh auth`.
- **ARCHIVE explorer** - a standalone, chromeless read-only window (`ARCHIVE` in the header) for browsing project artifacts across all projects: an ARTIFACTS home (per-project cards + recent-across-all strip), RECENTS (an attributed agent-writes ledger + an exhaustive changed-within scan), and a TREE view. Read-only, zero model authority. See [`docs/INDEX.md`](docs/INDEX.md).
- **Media studio** - a modal viewer/editor for images, audio and video, backed by real server-side **FFmpeg** ops and GPU **Demucs** stem separation. Image: zoom/pan + a layer-based raster editor. Audio: waveform + clip / convert / normalize / speed / gain / spectrogram, plus **SEPARATE** (Demucs stem split). Video: scrub + clip / convert / extract-audio / framegrab / gif / geometry / speed / mute. Every op is a typed spec -> argv (no shell, whitelisted enums + validated numbers), confined to the workflow folder + scratch unless **Unconfined media access** is enabled. FFmpeg/Demucs are optional. See [`docs/MEDIA_STUDIO.md`](docs/MEDIA_STUDIO.md).
- **Command palette, focus mode, notification bell, SYSTEM modal** - a `CommandPalette` for quick navigation, a focus-mode toggle in the header that collapses chrome to wordmark + urgent status, a notification bell, and a SYSTEM modal with ACTIONS / DIAGNOSTICS / MODELS / SERVICES tabs (health, model probes, local-services, power actions).
- **API resilience** - `overloaded_error` and `{"type":"error"}` envelopes from the Claude CLI are caught, surfaced as a system notice, and retried with 15s/30s/60s backoff up to 3 attempts (same session id -> idempotent).
- **Concurrent-writer guard** - if a native `claude --resume <uuid>` terminal starts appending to a session Arco has open, Arco detects the non-`sdk-cli` writes, fires a chat warning, and refuses new turns for 60s rather than corrupt conversation state. Recover via Handoff.
- **Long-session friendly** - chat hydrates tail-first (last 200 entries) with a `LOAD EARLIER MESSAGES` pill; scroll position preserved across paging. Links open in a new tab so a clicked URL never navigates Arco away.
- **Safety rails on worker processes** - 50 MB output cap per turn (`ARCO_MAX_WORKER_OUTPUT_BYTES`), 32 GB tree-RSS auto-kill (`ARCO_RSS_KILL_BYTES`), process-tree cleanup on cancel. Runaway command output remains bounded.
- **Review safe-mode gate (Claude Native)** - an operator-armed, per-tab gate (CONFIG -> REVIEW SAFE-MODE, default off) that pauses the turn on a sensitive tool call (`Bash`, `KillShell`, writes outside the project, `git push` / `reset --hard` / `clean -fd`) and surfaces an editable proposal card for review, edit-then-approve, or rejection before it runs. Durable across server restart; supports a standing "approve all like this" with live re-evaluation against a non-lossy signature.
- **Project-trust gate** - a freshly opened or cloned repo's own `CLAUDE.md`, project skills (`.arco/skills/`), and `.arco/settings.json` are *suppressed* from the agent's turn until the project is trusted (the cloned-repo prompt-injection vector). The composer shows an UNTRUSTED PROJECT warning with `TRUST` / `NEVER` controls; the decision is recorded in `~/.arco/trust.json` and is reversible.
- **In-app help system** - `MANUAL` in the header opens a full operator reference; the floating `?` toggle enables contextual help mode (dashed outline + click-for-popover on annotated elements). Inline file references open in a stacked DocViewer reading from the local repo.
- **Two theme families with font-pack override** - 43 Arco Classic selections (42 color/font/shader-driven palettes such as Matrix, Sentinel, Cherenkov, Aurora, Red Planet, Everforest, DSKY, Noir, plus the `provider-auto` sentinel) backed by 29 GLSL shaders, and 68 Arco Phosphor CRT palettes; 29 font packs substitute display/body/code typography on top of any theme. Each Classic theme carries an inspiration backstory in the User Manual.
- **Remote-friendly** - designed around a single forwarded port. Run Arco on a local host and connect through a forwarded port.

## What Arco explicitly does not do

- **No silent autonomous routing.** Arco never picks models, providers, effort levels, or task completion without an operator-armed surface and an inspectable event trail.
- **No hidden orchestrator authority.** No meta-agent owns a workflow. Model-assisted decomposition, assignment, recovery, or synthesis is eligible only as a visible proposal or through bounded task tools the operator enabled.
- **No hidden auto-synthesis.** Review, Compare and Research outputs remain separate artifacts. Any synthesis is an operator-chosen bounded action or a visible proposal for inspection before applying.
- **No LLM-curated project memory that edits itself.** Knowledge/codebase memory is operator-triggered and operator-reviewed; session traces do not rewrite project instruction files.
- **No opaque "smart" anything.** Automatic or model-assisted behavior must be operator-armed, bounded by readable mechanics, logged, and reversible; the existing cluster automations are off by default, deterministically capped, logged, and reversible.

## Optional Linux desktop launcher

```bash
cp scripts/arco.desktop scripts/arco-quit.desktop ~/.local/share/applications/
update-desktop-database ~/.local/share/applications
```

Installs **Arco** (starts dev server + opens browser) and **Quit Arco** (tears down the whole process group) as desktop entries. Underlying script `scripts/arco` supports `start | stop | restart | status | logs`; logs land at `~/.cache/arco/arco.log`. To run Arco as a long-lived background service (systemd / launchd), see [`docs/SERVICE_MODE.md`](docs/SERVICE_MODE.md).

Detail: [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## The operator actions

Everything Arco does reduces to explicit operator surfaces. The core ones:

| Action | What it does |
|---|---|
| **New project** | Opens a tab. The workflow creator opens a tab for the selected cwd, provider, model, effort, and tool allowlist. |
| **Resume** | Lists existing native CLI sessions for the current cwd (`~/.claude/projects/...`, `~/.codex/sessions/...`). The selected session continues inside Arco. |
| **Review** | Spawns an ephemeral reviewer (any provider/model) over the last turn or a plan slice. Output is a read-only artifact in the right pane. |
| **Compare** | Races one prompt across N providers/models; the operator votes for a winner in the overlay. |
| **Research** | Runs one bounded web-research turn; produces a cited markdown report in the RESEARCH tab. |
| **Handoff** | Rotates the current tab's session. Current agent writes a handoff document; new session starts in the same tab with that document as its seed. |
| **Spawn from here** | Forks the current context to a new tab with a configurable model/effort. Original tab continues in parallel. |
| **Live model/effort swap** | Edit MODEL and EFFORT in the CONFIG tab. Takes effect on the next turn. Provider swaps require a Handoff (session rotation). |

Deep dives: [`docs/PRIMITIVES.md`](docs/PRIMITIVES.md).

### Right-panel tabs

The right pane groups its tabs into four sections:

- **WORKSPACE** - FILES (with LIVE / CHANGES / SOURCE / REMOTE views + BLAST RADIUS + SANDBOX), GENESIS
- **AGENT** - ACTIVITY, REVIEW, RESEARCH, HANDOFFS, PLAN, BAKE-OFF, TASKS
- **MEMORY** - KNOWLEDGE, LEDGER, HISTORY, USAGE
- **RUNTIME** - PREVIEW, CONFIG, GITHUB

Cluster tabs swap the per-workflow right pane for the cluster panel, grouped the same WORKSPACE / AGENT / MEMORY / RUNTIME way as a normal tab: MEMBERS / ACTIVITY / REVIEWS / HANDOFFS / PLAN / BOARD / MAILBOX, plus FILES / HISTORY / PREVIEW / CONFIG / GITHUB mirrors. Diagnostics / model-health / local-services live in the header SYSTEM modal, not the right pane.

### Cluster tabs (power-user)

A cluster tab hosts N member workflows pinned to one cwd, with a sticky broadcast composer and a shared peer-tool substrate. Use it for problems that benefit from multiple agents working alongside each other. The operator remains the only actor that advances a member's turn (unless the operator arms auto-turn) - clusters are about *peer-comms plumbing*, not auto-orchestration.

**Creating a cluster.** Right-click a cluster-capable tab -> `Add to cluster with...` or `Create cluster with N fresh workers...`. From inside a cluster: `+ ADD WORKER` in the Members sub-tab.

**Fresh replacements + independent auditors.** `REPLACE` swaps one member
slot to a brand-new workflow/provider session while cloning its name, role,
tier, focus, and tab configuration. Provider/model/effort/account may be
changed; prior transcript context and active task assignments are independent
choices. Fresh and replacement workers can be STANDARD, BLIND
(project-visible but no cluster coordination context; mailbox only), or
ISOLATED (Claude Native in a private scratch cwd with no project access;
mailbox only). Isolated workers can return bounded scratch artifacts through
`peer_send artifact_paths`.

**Peer messaging.** Members register three tools - `peer_list` (roster + mailbox depth), `peer_send` (deliver to a peer's mailbox), `peer_read` (drain own mailbox). Pre-turn injection delivers pending peer messages as a system block before the operator's prompt. Caps: 15 sends per operator turn; 50 pending per recipient; 16 KB per message (operator transcript-sends bypass to 32 KB).

**Shared plan + per-member roles.** Author a cluster-wide plan in the PLAN sub-tab (32 KB cap, 28 KB soft warn); attach a free-form role hint per member (<=120 chars). Both ride as system blocks on every turn - Native via forced blocks, CLI / Codex via `--append-system-prompt`. Director vs. worker stays **emergent through operator conversation** - no permission asymmetry.

**Provider support.** Cluster members are fenced to **claude** (CLI + Native), **codex** (`exec` + `app-server`), **zai** (`native` + `app-server`), **cursor** (ACP), **ollama**, and **llamacpp**. Peer tools wire differently per provider: Native Claude registers them in-process; CLI Claude via a per-spawn `--mcp-config` arco-cluster MCP child; both Codex transports (and Z.ai app-server) via `-c mcp_servers.arco-cluster.*` TOML overrides; Z.ai native and the local providers (ollama / llamacpp) get the peer tools folded into their in-process tool loop; Cursor via an in-process loopback StreamableHTTP MCP server (ACP honors MCP over http/sse only, not stdio - fresh-only membership). Gemini / LM Studio / Strata / DeepSeek / Antigravity stay outside the cluster fence. **Local members are capped at one per cluster** by default (override with `ARCO_CLUSTER_ALLOW_MULTIPLE_LOCAL=1`).

**Sub-tabs in the right panel.** MEMBERS (roster + Detach + role hints) / ACTIVITY (unified feed) / REVIEWS (aggregated reviewer queue) / HANDOFFS / PLAN (shared markdown) / **BOARD** (kanban task board) / MAILBOX (live pending depth) - plus FILES / HISTORY / PREVIEW / CONFIG / GITHUB mirrors so routine work doesn't leave the cluster tab.

**Operator-armed idle nudger.** Default OFF; the NUDGES chip arms it. When ON, the server alerts the *operator* (toast + ACTIVITY row) if a member is idle >=10s with pending mail - capped at 3 nudges per operator turn, suppressed during busy state. It NEVER sends prompts to workers.

**Operator-armed auto-turn.** Default OFF (per-cluster toggle). When ON, the server dispatches a synthetic primary turn on a recipient that has pending mail - fenced by a cooldown (default 20s/recipient), a rate cap (default 10 fires/60s/cluster), and a chain-depth cap (default 3), all env-overridable. Every fire and every guard refusal lands in `events.jsonl` as `cluster_auto_turn_fired`. Toggling OFF stops further fires; the in-flight turn finishes normally.

**Director / workers task dispatch.** Clusters carry a durable task kernel - tasks with dependencies, comments, run/attempt history, and an expanded status set (triage / todo / ready / in_progress / blocked / review / done / archived). New clusters default-attach a project task board. Workers drive their own work through lifecycle peer-tools (`cluster_task_show` / `create` / `link` / `comment` / `heartbeat` / `block` / `complete`) but can only move work to `review` - `done` and `archived` stay operator-only. The operational **BOARD** tab is a horizontal **kanban** (TODO -> ... -> DONE) with drag-to-restatus (touch-drag supported; moves to `done` / `archived` ask for confirmation), an on-board create-task composer (always `todo`), an editable card drawer (title / notes / priority / deps / delete), and one-click bridges promoting a plan task or a delivered peer message into a board task. Its automation - an **operator-armed dispatcher** (one-shot or armed daemon, default OFF, deterministic eligibility + caps, every fire/skip logged), run **recovery** (reclaim / terminate / reassign, stale-claim detection, consecutive-failure breaker), a **swarm helper** (root blackboard -> N workers -> verifier -> synthesizer), worktree-aware dispatch (`autoWorktree`, default OFF), and **orchestration assist** (operator-armed model drafts of task graph / assignments / recovery / synthesis / swarm that land as preview proposals and only mutate state when the operator accepts selected items through the normal task APIs) - collapses under an AUTOMATION header, closed by default.

See [`docs/PROTOCOL_CLUSTER.md`](docs/PROTOCOL_CLUSTER.md) for the full design, [`docs/TASK_LEDGER.md`](docs/TASK_LEDGER.md) for the task-dispatch layer, and [`docs/GOTCHAS.md under Cluster mode`](docs/GOTCHAS.md) for the load-bearing invariants.

### Plans (per-cwd briefs)

A long-form markdown brief pinned to a workflow and injected into every primary turn so the agent stays oriented. Plans live at `<cwd>/.arco/plans/<id>.md`; one cwd can host many, and the same plan can attach to multiple workflows.

- **PLAN button** in the composer opens a modal: *Draft for review* or *Draft & auto-save*. Both inject a prompt synthesized from the conversation (Goal / Current state / Open questions / Next steps with `- [ ]` items).
- **PLAN tab** - list of plans with attachment counts; active inline, completed behind a toggle. Select a plan to attach it.
- **Living document loop** - an fs watcher catches agent-driven `.md` edits (like `- [ ]` -> `- [x]`) and refreshes the panel live.
- **Clickable checkboxes** - `- [ ] item` lines render as clickable boxes; click flips `[x]` and PATCHes the file (works both directions).
- **Mark complete / delete** - mark complete archives + auto-detaches; delete is permanent (with confirm).

## Hands-free voice

The complete reference is [Computer and hands-free voice control](docs/VOICE.md),
with a quick start, topic index, current behavior, source map and verification.

**Settings > VOICE SETUP** reports installed components, runs installation with a live log, tests microphone level and local phrase recognition, and displays model notices.

Opt-in, off on every load. Run `npm run voice:setup` once (local CPU speech),
then enable VOICE in the header or press Ctrl/Cmd+Shift+Space. Say "Computer",
wait for the soft double pulse, speak naturally with pauses, and say "over" on its own to
submit. Say "Cancel capture" to discard the unsent directive, even after
other words have been dictated; silence never sends. Everything after "Computer"
goes as free text to **Computer**, a projectless chat with Arco's operator
surface as tools. Computer classifies the input as a task or a conversation. A task ("open settings", "tell the builder to...",
"close that", "bring up the nudge dialog") runs without a model round, as with mouse and
keyboard input. A generic read-screen / click / type / read-text layer covers actions
without a dedicated tool; a question ("how does Strata work?",
"what is happening in this project?") is answered by voice after Computer looks
it up in the manual, project context, or the visible screen, with the conversation
retained across turns. The "dictate" command sends captured words to a worker.
**COMPUTER in the top bar** opens its conversation, tool calls and usage
in a dedicated panel, separate from project tabs while the selected project remains active.
Requests, corrections, and answers can also be typed in its message field; the microphone can remain off. Enter sends; Shift+Enter adds a line. While a request is active,
STOP REQUEST appears in the panel header and voice strip. Stale working text
clears when Computer finishes; standing scripts have separate pause/cancel controls.
Codex, Claude, Ollama, and Strata are available with model and effort selection; Luna LOW remains the default. Each selection has separate context. The panel shows context
fullness and compaction history. Full clears default to 50% of the actual
subscription-model window or 75% locally, after the turn and queue finish.
KEEP CONTEXT pauses automatic clears; CLEAR CONTEXT starts fully fresh.
Saved transcripts remain available. No history on Codex/Claude/Ollama keeps
the transcript in memory only, discarded on clear or when the panel closes;
Strata stays saved-only. Model/privacy changes and full clears also work by voice.
Completion watches can track a selected worker or all currently busy members of a cluster. They wait for current turns and queues, then report errors, cancellations, and restarts without polling models. Watches can be reviewed or cancelled in COMPUTER.
Computer's live activity ledger receives worker and mailbox events directly.
Optional agent updates queue factual reports for the selected Computer agent
while it is busy, then deliver bounded read-only batches; they default off.
Conditions and browser updates are event-driven, with no recurring scan.
Computer can translate conditional directives into composable scripts over
worker state: busy/queues/mail, human-input holds, context fullness and compaction.
Scripts combine independent actions and waits; no Director nudge is mandatory. For example,
a script can nudge selected workers for new mail and notify when their exchange settles,
or compact a worker at a configured threshold and continue afterwards. The exact script can be reviewed, updated by voice, or controlled in COMPUTER. New scripts have no default expiry or action/worker-turn cap. Limits can be added or removed without resetting counts or resending work. Cooldown defaults
to 30 seconds and can be changed by voice, including zero.
Structured input requests hold immediately; ordinary changed replies use bounded
Luna LOW checks (normal Codex usage, at most 24 batches/hour). Unknown holds,
and worker questions are never answered automatically. Native worker actions run
server-side; scripted screen controls need the owning hands-free browser.
See the in-app Voice manual or [voice contract](docs/VOICE.md).

Subscription quota usage can be requested directly. Settings can also be changed through dropdowns, sliders, hover, right-click menus, scrolling, and other Arco controls. Voice Controls includes adjustable
speech sensitivity for quieter speech; this leaves system microphone gain alone.
Codex Computer recovers from stalls by replacing its own connection and speaking
the error; it never automatically repeats actions, and queued requests are cancelled.
Speech recognition is local; reply voices use Microsoft online speech with
local Kokoro fallback. The voice controls provide 24 English female voices grouped by accent for audition. Cloud inference and online speech still receive
the text included in each request, including in no-history mode. Details,
lifecycle and privacy: [docs/VOICE.md](docs/VOICE.md).

## Providers

| Provider | Transport | Effort levels | Native resume | Notes |
|---|---|---|---|---|
| Claude | `cli` (default) | low / medium / high / xhigh / max | UUID-based (`--session-id` / `--resume`) | Picker: `opus` / `sonnet` family aliases plus pinned ids (Opus 5.5, Fable 5.1, Sonnet 5, Opus 5, Opus 4.8, ...). Per-turn `claude` CLI spawn. Full two-way interop with terminal `claude`. Chat renders from `~/.claude/projects/<cwd-hash>/<sessionId>.jsonl`. Auto-handoff supported. |
| Claude | `native` | low / medium / high / xhigh / max | Replay from `events.jsonl` (Arco-internal; no terminal resume) | Long-lived in-process `@anthropic-ai/sdk` worker, no CLI spawn. OAuth subscription auth + pinned Claude Code wire fingerprint. Append-only request prefix with preserved thinking (required by Fable 5.1 / Mythos 5.1 / Opus 5.5). Ships its own Bash / Read / Edit / Grep / Glob / Task tools, Claude-Code-compatible hooks runner, server-side `compact` + auto-handoff + deterministic Fold, operator-armed plan-mode, parallel `Task` subagent fan-out (depth-1 cap), output-style picker (normal / lite / terse), and posture-based toolsets (operator cycles a full / coding / review / chat posture that scopes exposed tools). |
| Codex | `exec` (default) | model/catalog-driven; Astra / Sol: low through ultra, Luna: through max | UUID-based (`codex exec resume`) | Default model GPT-6 Astra (Sol and Luna also in the cold-catalog fallback; the live `model/list` catalog is authoritative). MAX context by default. Per-turn `codex exec` spawn. Full two-way interop with terminal `codex`. Supported effort values pass through; older models are not widened to Astra-only levels. Reviewer runs `-s read-only`. Transcript hydration on Resume for unclaimed rollouts. |
| Codex | `app-server` | model/catalog-driven (same as `exec`) | UUID-based (rollouts in `~/.codex/sessions/`) | Long-lived `codex app-server` per tab. Structured `turn/interrupt` cancel + non-destructive `turn/steer` mid-turn input + `localImage` attachments + crash-recovery circuit breaker + output-style picker + native compact with context-signal reset. Reviewers / handoff seeds always run on `exec`. |
| Z.ai | `native` (default) + `app-server` | low / medium / high / xhigh (sent only on GLM-5.2) | `native` rebuilds history from `events.jsonl`; `app-server` UUID-based (Codex app-server thread) | GLM Coding Plan models (default `glm-5.2`, 1M ctx) with Z.ai API-key auth + Coding Plan usage indicators. `native` is an in-process worker calling `api.z.ai` Chat Completions directly with its own tool loop + compaction + output-style picker; `app-server` routes through Arco's local Responses-to-Z.ai proxy and shares the Codex app-server steer/cancel/compact/MCP/cluster path. |
| Gemini | `cli` | (no effort flag) | UUID-stored / index-resolved (`--list-sessions` -> `-r <index>`) | Per-turn `gemini` spawn; two-way interop with terminal `gemini`. Arco stores the stable UUID and re-resolves the index on each spawn. Chat hydration of unclaimed sessions deferred - agent has full context, chat starts empty. (An in-process `gemini-native` transport is an unfinished stub, not shipped.) |
| Cursor | `acp` (default) + `print` | baked into the model id (`-low` / `-high` / `-xhigh` / `-max`) | `session/load` (loadSession capability) | Long-lived `cursor-agent acp` ACP worker; ~153 models incl. Grok. Steer / cancel / session resume / live model-swap via `session/set_model`. No per-turn token signal (the Usage tab is dashboard-polled). Cluster member via an in-process loopback HTTP MCP server. Read-only reviewer / primitives run a stateless `cursor-agent -p --mode ask` one-shot. |
| Ollama | (single) | per model - graded thinking: `low` = thinking off (`think:false` + `/no_think`) plus the model's own levels from `/api/show` `thinking.values` (e.g. supported levels from `/api/show`); boolean-only models keep low / high | None | No native session concept; each turn is a fresh context. Tool use + large context + image attachments + web tools (SearXNG search, fetch with Camoufox stealth fallback). Mid-turn steer supported. Override base URL with `OLLAMA_URL_BASE` (default `http://localhost:11434`). |
| llama.cpp | (single) | low / high (`low` = `/no_think`) | None | Operator-managed GGUF catalog at `~/.arco/llamacpp.json`. Singleton `llama-server` process owned by Arco (`llamacppManager`); switching aliases SIGTERMs the old server and warms the new one. OpenAI-compatible chat-completions + SSE streaming. Same tool-loop runtime as Ollama, with in-place auto-recovery (reasoning runaway / stream stall / tool-cap / context fill). Override binary with `ARCO_LLAMACPP_BIN`. |
| DeepSeek / Xolotl | HTTP + guarded user services | none / low / medium / high | Transcript replay | Configured profiles with model-specific context, image, and tool capabilities, guarded loading and unloading, and source-version tracking; see [`docs/DEEPSEEK.md`](docs/DEEPSEEK.md). |
| Strata | (single HTTP worker + optional registered user services) | none / low / medium / high (`none` disables reasoning; high maps to Qwen xhigh) | Transcript replay | Standalone OpenAI-compatible service at `http://127.0.0.1:8081/v1`. The service reports installed model IDs, context and capabilities; one profile is resident at a time. Streaming reasoning, tools, image input, Chat web-only toggle, native tok/s, FREE VRAM and release notices. [Runbook](docs/STRATA.md). |
| LM Studio | (single) | low / high (`low` = `/no_think`) | None | LM Studio reached via its **OpenAI-compatible** HTTP API (`/v1/chat/completions`, `/v1/models`) - not the native SDK. Joins ollama / llama.cpp on the serial local queue, same tool-loop runtime + recovery. Whatever model is loaded in the LM Studio app is the active model. Override base URL with `LMSTUDIO_URL_BASE` (default `http://localhost:1234`). |
| Antigravity | `rpc` | (set in desktop app) | Cascade (opaque id) | Google's Antigravity desktop app driven via its local **language-server RPC** (the CDP debug port `:9222` is liveness-only). Real multi-step agent - web search, shell, file ops surfaced as merged Activity rows. Uses the desktop's signed-in profile (`ANTIGRAVITY_USE_DEFAULT_PROFILE=1`) or an isolated user-data-dir at `~/.arco/antigravity-data/`. Context is Antigravity-managed/opaque; handoff auto-degrades to fresh-summarizer; excluded from clusters. Primary or reviewer. |

All configured providers can act as reviewers or primary agents. Local reviewers (Ollama, llama.cpp, LM Studio, Strata) get a prompt addendum reminding them to use their read-only tools to verify diff claims against the live tree. Cross-family reviewer pairings are the most useful.

Auth is per-service: browser OAuth for Claude (CLI login, plus a separate OAuth flow for Native); terminal-launched TUI for Gemini/Codex; an API key for Z.ai; `gh auth token` for GitHub; Ollama / LM Studio / Strata probe their HTTP endpoints (prepared local Strata profiles can also start on demand); llama.cpp probes for the binary + reads `~/.arco/llamacpp.json`; Cursor uses its own `cursor-agent login`; Antigravity uses the desktop app's own auth. The auth overlay blocks app use only when no primary-capable provider is authed.

Per-provider deep dive: [`docs/PROVIDERS.md`](docs/PROVIDERS.md).

## Persistence layout

Per-cwd state lives under the working directory:

```
<cwd>/.arco/
  workflows/<wfid>/
    meta.json            # tab identity, primary worker config, session history, threshold settings
    events.jsonl         # append-only event log, seq-stamped
    artifacts/           # reviewer / compare / research outputs, worker-written files
    handoffs/            # one markdown file per session rotation
  plans/                 # markdown briefs, attachable per workflow
    index.json
    <planId>.md
  project/
    tasks.json           # durable per-cwd task ledger
```

Operator-global (under `~/.arco/`):

- `chats/<wfid>/` - saved Chat tabs' persistence cwd (`.arco/workflows/<wfid>/` nested inside; Incognito writes nothing)
- `settings.json` - per-provider enable/disable + operator preferences (theme, font pack, op name, transport defaults)
- `projects.json` - stable project identities, display names, pins, archive state, and previous paths for Project Home
- `models.md` - model catalog for Claude/Gemini/Codex/Ollama (populates dropdowns)
- `llamacpp.json` - llama.cpp GGUF catalog (alias -> ggufPath, ctxSize, ngl, capability flags)
- `auth.json` - provider auth state
- `provider-accounts/` - per-account Codex homes for multi-account use
- `clusters/<clusterId>/` - cluster store + per-recipient mailbox (`mailbox/<wfid>/<msgId>.json`)
- `cluster-presets.json` - saved cluster templates
- `knowledge/` - codebase-memory store + index
- `recall/recall.db` - recall full-text index
- `mcp/registry.json` - operator-managed MCP server registry
- `trust.json` - project-trust decisions (which repos' own `CLAUDE.md` / skills / `.claude` settings are vouched-for)
- `checkpoints/<cwd-hash>/` - git-snapshot checkpoint store
- `worktrees/<cwd-hash>/<taskId>` - git-worktree-backed task checkouts
- `bakeoffs/<cwd-hash>/` - durable implementation-race manifests + managed attempt worktrees
- `genesis/` - scaffolder staging
- `templates.json` - new-project templates
- `skills/` - `.arco/skills/` global skill files
- `notification-mutes.json` - muted notification rules
- `known-cwds.json` - crash-recovery registry
- `worker-pids.json` / `terminal-pids.json` - live PIDs for orphan reaping on restart
- `cli-snapshots/` - provider CLI version snapshots for change detection
- `session-index.json` - resume-index cache
- `antigravity-data/` - isolated Antigravity user-data-dir
- `llamacpp.log` - stdout/stderr from the singleton `llama-server`

`.arco/workflows/` is `.gitignore`-d by default.

Full layout: [`docs/PERSISTENCE.md`](docs/PERSISTENCE.md).
## Repo layout

```
Arco/
  shared/src/
    protocol/                    # ~41 domain WS-message modules (chat, clusters, compare,
                                 #   cookbook, diagnostics, genesis, gitOps, handoffs,
                                 #   knowledge, mcp, media, models, notifications, plans,
                                 #   providers, recall, remoteManagement, research, reviews,
                                 #   services, settings, tasks, templates, terminal, themes,
                                 #   usage, workers, workflows, checkpoints, ...)
    protocol.ts                  # shim that re-exports the protocol/ directory
  server/src/
    index.ts                     # HTTP + WS server, workflow state machine
    providers/                   # claude / claude-native/ / codex / codex-appserver/ / zai-native/ /
                                 #   cursor/ / gemini (+ gemini-native/ stub) / ollama / llamacpp
                                 #   (+ Manager) / lmstudio / antigravity, plus goalBlock,
                                 #   outputStyle, codexCodeMode, ragInjection, fallbackChain,
                                 #   errorClassifier
    primitives/                  # seedWorker, exportContext, runReviewer, runCompare,
                                 #   runResearch, runDocEdit, reviewContent (+ plan review)
    workers/                     # process lifecycle, RSS/output caps, activity probe, PID registry
    http/                        # REST route modules (git, diff, files, github, cookbook, ...)
    ws/                          # WS message handlers (turnEngine = primary-turn dispatch, clusterHandlers,
                                 #   compareHandlers, genesisHandlers, knowledgeHandlers, ...)
    server/                      # broadcast, state, prompts, readiness, logger, constants
    cluster*.ts                  # store / mailbox / peerOps / rehydrate / idleNudger / autoTurn /
                                 #   efficiency / planBridge / stringFold / director / presets
    chatMode.ts goalRun.ts       # Chat-tab contract (providers, web toggle) / goal-run loop logic
    cookbook/                    # fit / hardware / recommend / install / catalog
    genesis/                     # scaffold / stages / creative / prompts
    knowledge/                   # distill + store (codebase memory)
    recall/                      # search / summarize index
    terminal/                    # PTY manager + channel + PID registry
    media/                       # ffmpeg / demucs / scratch
    services/                    # local-service discovery
    lsp/                         # language-server client pool
    mcp/                         # registry + cluster MCP server + config writer + wiring
    diagnostics/                 # checks / modelHealth / supportBundle
    management/                  # hub link + identity (remote management)
    project/                     # taskLedger + taskWorktree
    workflows/                   # session discovery / index / transcripts / purge
    preview/                     # CDP-based preview capture
    net/ defaults/ templates/    # ipv4 forcing / bundled models.md / new-project templates
    gitSnapshots.ts              # checkpoint snapshots
    git.ts / gitOps.ts / gitWorking.ts / gitSafe.ts / gitDiff.ts  # git surfaces
    notifications.ts / ntfyTransport.ts  # notification center + ntfy push
    sessionJsonl.ts contextEstimator.ts contextCalibrator.ts catalog.ts
    workflowStore.ts workflowMeta.ts planStore.ts settings.ts auth.ts (+ usage / quota / skills / ...)
  client/src/
    components/                  # WorkflowView, ChatPanel, TerminalInput, SystemHeader,
                                 #   SystemModal, CommandPalette, NotificationCenter, modals,
                                 #   and subdirs: RightPanel, ClusterRightPanel, composer,
                                 #   compare, primitives, Cookbook, Recall, Terminal,
                                 #   terminalInput, GitHubPanel, editor, diff, media, help,
                                 #   UserManual, WorkflowCreator, dev
    help/                        # manualSections + contextual-help content
    themes/                      # definitions/ (42 Classic) + phosphor/ (68 generated) +
                                 #   shaders/ (29 .frag.glsl) + fontPacks (29)
    stores/                      # Zustand state
    hooks/                       # useWebSocket, useTabSingleton, etc.
    styles/ utils/               # theme + contextual-help CSS, shared helpers
  docs/                          # See "Documentation" below
  DEVLOG.md                      # Running development log
  AGENTS.md                      # Repository rules
  CONTRIBUTING.md                # Dev workflow + how to add a provider/primitive
  README.md                      # This file
```
## Configuration

Environment variables (all optional; user-relevant subset):

- `ARCO_PORT` - server port (default `3001`)
- `ARCO_HOST` - server bind address (default `127.0.0.1`; set to `0.0.0.0` only for intentional network exposure behind an auth-enforcing proxy - see [`docs/OPERATIONS.md`](docs/OPERATIONS.md))
- `ARCO_SERVE_CLIENT` - when `1`, the server also serves the prebuilt `client/dist` (service/prod mode)
- `ARCO_HOME` - relocates global settings and provider data; per-project state remains under `<cwd>/.arco`
- `ARCO_RSS_KILL_BYTES` - override the 32 GB tree-RSS auto-kill threshold (>= 1 GB)
- `ARCO_MAX_WORKER_OUTPUT_BYTES` - override the per-turn worker output cap (default 50 MB, >= 1 MB)
- `ARCO_HUB_URL` - remote-management hub endpoint; `ARCO_INSTANCE_NAME` names this instance
- **Local providers:** `OLLAMA_URL_BASE` (default `http://localhost:11434`), `LMSTUDIO_URL_BASE` (default `http://localhost:1234`), `ARCO_LLAMACPP_BIN` (optional override for the `llama-server` binary resolved from `PATH`), `ARCO_LLAMACPP_HOST` / `ARCO_LLAMACPP_PORT` / `ARCO_LLAMACPP_KEEPALIVE_MS`, and per-provider tool-loop tuning (`ARCO_{OLLAMA,LLAMACPP,LMSTUDIO}_MAX_TOOL_TURNS`, `ARCO_LLAMACPP_THINKING_FLUSH_MS`, etc.). `ARCO_LOCAL_PROVIDER_SERIAL_QUEUE=0` disables the shared serial queue.
- **Cluster automations:** `ARCO_CLUSTER_ALLOW_MULTIPLE_LOCAL=1` lifts the one-local-member cap; `ARCO_CLUSTER_AUTO_TURN_COOLDOWN_MS` / `_RATE_CAP_PER_MINUTE` / `_MAX_CHAIN_DEPTH` / `_SWEEP_INTERVAL_MS` and `ARCO_CLUSTER_IDLE_FLOOR_SECONDS` tune the operator-armed auto-turn / idle-nudger.
- **Web tools (Ollama / llama.cpp / LM Studio / Z.ai native):** `ARCO_SEARXNG_URL` (SearXNG endpoint, default `http://127.0.0.1:8888`), `ARCO_CAMOUFOX_PYTHON` (Camoufox Python for stealth fetch + the Codex usage probe). `ARCO_CHROME_BINARY` / `CHROME_PATH` pick the browser for headless preview capture.
- **Antigravity:** `ANTIGRAVITY_BINARY` (app path), `ANTIGRAVITY_USE_DEFAULT_PROFILE`, `ANTIGRAVITY_USER_DATA_DIR`, `ANTIGRAVITY_WORKSPACE`.
- **Notifications:** `ARCO_NTFY_URL` (+ optional `ARCO_NTFY_TOKEN`) for external ntfy push.
- **Z.ai:** `ZAI_API_KEY` (overrides the Settings key; the stored Settings key accepts `!cmd` / `${ENV}` interpolation).
- `TERMINAL` - preferred terminal emulator for Gemini/Codex auth flows.

Full env-var list and operations notes: [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Documentation

The full documentation index is available at [`docs/INDEX.md`](docs/INDEX.md). Codebase documentation is organized in this order:

1. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) - system map; the anchor doc, links every other doc
2. [`docs/GLOSSARY.md`](docs/GLOSSARY.md) - vocabulary
3. [`docs/PROTOCOL.md`](docs/PROTOCOL.md) - every WebSocket message - plus [`docs/PROTOCOL_PRIMITIVES.md`](docs/PROTOCOL_PRIMITIVES.md) (operator-primitive messages) and [`docs/PROTOCOL_CLUSTER.md`](docs/PROTOCOL_CLUSTER.md) (cluster-mode messages)
4. [`docs/HTTP_API.md`](docs/HTTP_API.md) - every HTTP endpoint with request/response shapes
5. [`docs/PROVIDERS.md`](docs/PROVIDERS.md) - Claude / Codex / Z.ai / Gemini / Cursor / Ollama / llama.cpp / LM Studio / Strata / DeepSeek / Antigravity deep dives; [`docs/CHAT.md`](docs/CHAT.md) - Chat / Incognito contract
6. [`docs/PRIMITIVES.md`](docs/PRIMITIVES.md) - Review / Compare / Research / Handoff / Spawn + DOCS / GIT
7. [`docs/PERSISTENCE.md`](docs/PERSISTENCE.md) - events.jsonl, meta.json, atomic writes
8. [`docs/CLIENT.md`](docs/CLIENT.md) - Zustand store, components, theming, performance
9. [`docs/OPERATIONS.md`](docs/OPERATIONS.md) - running locally, ports, launcher, recovery
10. [`docs/GOTCHAS.md`](docs/GOTCHAS.md) - non-obvious invariants
11. [`CONTRIBUTING.md`](CONTRIBUTING.md) - dev setup, hot-reload caveats, adding providers/primitives

### Feature deep-dives

- [`docs/STRATA.md`](docs/STRATA.md) - large MoE setup: models, profile switching, RAM/VRAM/KV/PLE, CPU vision, web tools, file provenance and recovery.

One reference doc covers each operator subsystem:

- [`docs/TERMINAL.md`](docs/TERMINAL.md) - embedded PTY terminal
- [`docs/RECALL.md`](docs/RECALL.md) - search across past transcripts
- [`docs/KNOWLEDGE.md`](docs/KNOWLEDGE.md) - codebase memory + RAG injection
- [`docs/MEDIA_STUDIO.md`](docs/MEDIA_STUDIO.md) - image / audio / video editor (FFmpeg + Demucs)
- [`docs/COOKBOOK.md`](docs/COOKBOOK.md) - fit-scored local-model catalog + install
- [`docs/CLIENT.md`](docs/CLIENT.md) - Genesis workflow creator and scaffold integration
- [`docs/LSP.md`](docs/LSP.md) - language-server-backed tools
- [`docs/MCP_REGISTRY.md`](docs/MCP_REGISTRY.md) - operator-managed MCP server registry
- [`docs/DIAGNOSTICS.md`](docs/DIAGNOSTICS.md) - health checks, model health, support bundles
- [`docs/TASK_LEDGER.md`](docs/TASK_LEDGER.md) - durable per-cwd task records + worktree task tabs
- [`docs/LOCAL_SERVICES.md`](docs/LOCAL_SERVICES.md) - local web-service discovery
- [`docs/REMOTE_MANAGEMENT.md`](docs/REMOTE_MANAGEMENT.md) - hub link + lifecycle commands
- [`docs/NOTIFICATIONS.md`](docs/NOTIFICATIONS.md) - notification center + ntfy push
- [`docs/CHECKPOINTS.md`](docs/CHECKPOINTS.md) - git-snapshot working-tree checkpoints
- [`docs/BACKUP.md`](docs/BACKUP.md) - backing up Arco state
- [`docs/SERVICE_MODE.md`](docs/SERVICE_MODE.md) - running Arco as a systemd/launchd service
- [`docs/GIT_WORKBENCH.md`](docs/GIT_WORKBENCH.md) - the GIT one-off prompt + git surfaces
- [`docs/PREVIEW_VERIFY.md`](docs/PREVIEW_VERIFY.md) - the Live Preview tab + verification
- [`docs/RESUME_INDEX.md`](docs/RESUME_INDEX.md) - session resume index
- [`docs/PROTOCOL_CLUSTER.md`](docs/PROTOCOL_CLUSTER.md) - full cluster design + decision log
- [`docs/GOTCHAS.md#goal-run-north-star-auto-continue`](docs/GOTCHAS.md#goal-run-north-star-auto-continue) / [`docs/GOTCHAS.md`](docs/GOTCHAS.md) - goal run + north star
- [`docs/GOTCHAS.md`](docs/GOTCHAS.md) - review safe-mode gate
- [`docs/PROVIDERS.md`](docs/PROVIDERS.md) - Native append-only prefix + preserved thinking
- [`docs/PROVIDERS.md`](docs/PROVIDERS.md) - Cursor ACP provider (all phases shipped)

For agents working in this repo: [`AGENTS.md`](AGENTS.md). For chronological history: [`DEVLOG.md`](DEVLOG.md).

## License

A license has not been selected. Redistribution terms will be published after the operator completes the license review.
