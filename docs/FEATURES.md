# Feature reference

A complete tour of Arco capabilities, with links to subsystem contracts and
controls. For installation and first session, see
[Getting started](GETTING_STARTED.md).

## Workspace start and clusters

| Feature | What it does | Details |
| --- | --- | --- |
| Tabbed multi-provider workspace | Every project is a tab with one long-lived primary agent the operator chats with directly | Providers: Claude, Codex, Cursor, Ollama, llama.cpp, LM Studio, Strata, DeepSeek |
| Home | Start page for project locations, bookmarks, and open work | Greeting and status, start tiles, bounded Continue cards, and a filterable project grid; stable project identity across relocation; cards can be pinned, archived, opened, or continued. See [Getting started](GETTING_STARTED.md) |
| Waiting questions | Marks structured Codex and Claude Native questions until settled | The toast opens the asking worker; cluster cards and tabs show a question indicator. |
| Workspace Outputs | Collects artifacts, generated-file events, and scoped exports | FILES tab **OUTPUTS** sub-tab for the active workflow or cluster. By default it shows what was made for you (generated media, top-level artifact documents, reports and exports); code edits and files in artifact subfolders sit under **All files**. See [Outputs](OUTPUTS.md) |
| Clusters | Multi-member coordinated work | Seven size-ordered templates (Pair through Large team) plus Build my own; at most one director on new work; work size only for repeated roles; member cards default to **ROWS**; AUTO-PICKUP modes Off, Rule-based (recommended automatic), Smart Observe-only, and Smart Automatic. Smart modes need an evaluator on Claude Native, Cursor, or Ollama. See [Getting started](GETTING_STARTED.md) and [Task ledger](TASK_LEDGER.md) |
| One status per tab | Shows at a glance which tabs need you | Workflow and cluster tabs show a dot when not idle (hover for the status); Home Continue cards show a word: Working, Needs you (a question waits, or an idle cluster member has mail), New reply (a turn finished while you were elsewhere; cleared when you open the tab; not saved across reloads) or Idle |
| Waiting mail on member cards | Shows undelivered messages per member | The member card's mail mark shows the count, delivered at the member's next turn; muted while the member is busy; highlighted when it is idle with mail, and clicking it nudges that member. No sounds or pop-ups |
| Needs you and board accept | Shows what only the operator can clear on a cluster board | **NEED YOU** above the member cards counts review tasks with a director sign-off, tasks blocked on an operator decision, and members waiting on an answer. On the Board, **ACCEPT** replaces DONE on review cards; **ACCEPT ALL MET** accepts met sign-offs; done tasks hide behind **SHOW DONE**; review tasks older than seven days fold into an older row. Optional Settings > Agents and clusters **Board auto-done** marks met tasks done automatically. See [Task ledger](TASK_LEDGER.md) and [Settings](SETTINGS.md) |
| Utility agent | One operator-chosen provider and model for short side jobs | Settings > Agents and clusters (also offered on the last Welcome screen). Accepts only Claude with Native sign-in, Cursor, Codex, or Ollama. Never chosen silently; **TEST** checks it; **USE UTILITY AGENT** can fill it into Smart AUTO-PICKUP, Research, document edit, and handoff summarizer pickers without changing saved choices. See [Settings](SETTINGS.md#utility-agent) |
| BRIEF | Short synopsis from visible activity facts | On each member card and in the composer toolbar; in a cluster tab the composer's BRIEF offers THIS WORKER or WHOLE CLUSTER. Uses the utility agent; lists the facts; sends nothing to any worker. |
| CATCH ME UP | Summary since the last visit | On a workflow or cluster; the utility agent writes the synopsis for the covered time range. Unloaded or Incognito cluster members are skipped with a note. |
| TIDY | Rewrite the composer draft into a clearer instruction | Workflow and Chat composers. **ACCEPT** only replaces the draft; TIDY never sends. **KEEP ORIGINAL** and Escape leave it unchanged. |

## Capacity, updates, and appearance

| Feature | What it does | Details |
| --- | --- | --- |
| Auto-compaction | Arms between-turn compaction for supported transports | Workflow CONFIG and cluster defaults; Claude Native, Codex app-server, Ollama. See [Settings](SETTINGS.md) |
| Local runtime capacity | Limits concurrent local cluster members | Connections `localClusterCapacity` for Ollama or llama.cpp (default 1 each). See [Settings](SETTINGS.md) |
| Version box and update notices | Always-visible version and optional GitHub release checks | Top bar, right of the power button: running version, accent state when an update is available, opens the update dialog; toast (**OPEN RELEASE** / **DISMISS**); Settings > Advanced Arco row with **CHECK NOW**. Packaged services offer **UPDATE AND RESTART**. See [Updating Arco](OPERATIONS.md#updating-arco) |
| Application shortcuts and `arco open` | Per-user desktop shortcut and dedicated app window | `arco setup` can install the shortcut; `arco open` / `arco open --tab`; `arco shortcuts add|remove`. See [Service mode](SERVICE_MODE.md) |
| Default appearance | New-home theme and typography defaults | Phosphor Electric Blue and Victor Mono font pack at 100% interface scale; a saved theme or font pack is left alone. See [Settings](SETTINGS.md) |

## Sessions, transports, and chat controls

| Feature | What it does | Details |
| --- | --- | --- |
| Native session interop | Arco Claude-CLI / Codex-exec sessions are native CLI sessions | Start in Arco, resume in a terminal with `claude --resume <uuid>`; start in a terminal, resume in Arco. Arco owns tab state; the provider owns conversation state |
| Inline tool-call pills | Compact rows for primary tool calls between assistant bubbles | Bash / Read / Grep / WebFetch and similar; click to expand full JSON input; click a file path to open it in the viewer modal |
| Interrupt and send | Stop the current turn and send the draft next in the same conversation | **INTERRUPT & SEND** or **Ctrl/Cmd+Enter** while a Claude or Codex Agent is working; both transports per provider; queued messages run afterward; completed edits remain. Adjacent **SEND** and Enter keep ordinary steering; Alt+Enter queues a follow-up |
| Mid-turn delivery and working step | Display-only turn progress | A message sent while the agent is mid-turn shows **Queued** or **Delivered** until answered. The working indicator and cluster member cards name the current step with elapsed time and mark steps over 60 seconds as long-running |
| Per-tab transport toggles | Choose transport per Claude or Codex tab | Claude `cli` and `native` (new homes default `native`); Codex `exec` and `app-server` (new homes default `app-server`); project and per-tab settings can select either. Reviewers and handoff seeds use CLI or exec regardless of tab transport. Cursor `print` one-shot is routed automatically for read-only primitives, not toggled. Native unlocks server-side compaction, auto-handoff, plan-mode arming, and Task subagent fan-out; Codex app-server unlocks structured `turn/interrupt` cancel and non-destructive `turn/steer` mid-turn input |
| Per-project configuration | Provider, model, effort, and tool allowlist per tab | Live-editable from the CONFIG tab; same-provider model/effort swaps take effect on the next turn with no session rotation |

## Context, handoff, and goals

| Feature | What it does | Details |
| --- | --- | --- |
| Context usage monitoring | Worker header shows `CTX: NNK / NNK NN%` color-coded against the model window | Claude CLI: CLI session latest context snapshot with JSONL byte-size calibration fallback; Claude Native: `messages.countTokens()` on the retained next-turn prompt; Codex app-server: latest per-call token snapshot from the rollout file. Codex tabs default to the account **MAX** context window (from `$CODEX_HOME/models_cache.json`; CONFIG can switch a tab to STANDARD); denominator prefers the provider-reported window, then that catalog estimate. Native compact clears stale Codex context fill until the next real snapshot |
| Auto-handoff at threshold | When enabled, build a Quick handoff and rotate to a fresh session at the configured fill limit | Off by default; default limit 90%; warning at a lower threshold (default 75%). Configurable per-tab for providers with a trusted context-fill signal: Claude (CLI + Native), Codex (both transports), and Ollama |
| Context management and Fold (Claude Native) | Deterministic history trim in the same session | **FOLD FOLD** composer button trims older history into a digest while keeping a verbatim recent tail; no model round (cheaper than Compact) and no fresh worker (cheaper than Handoff); raw transcript stays in `events.jsonl`. **AUTO-FOLD** in CONFIG (off by default) fires when the budget crosses a FOLD AT kept below the warn threshold. Per-turn token-budget meter and tool-result eviction keep large tool outputs from blowing the window |
| North-star objective | Pin a durable free-text goal per tab | CONFIG -> NORTH STAR, `/goal <text>` composer command, or the always-visible GOAL chip above the composer. Folds into the system prompt on every turn on every transport; inherited by Review / Handoff / Spawn; operator-write, model-read-only, byte-capped, with an anti-autonomy trailer; no tool can mutate it |
| Goal run | Arms a per-tab continuation loop toward the north star | `/goal run <n>` or CONFIG; one deterministic continuation turn after each settled turn, up to `n` iterations (default 10, max 500). Stops on budget spent, turn error, provider throttle, context >=92%, or cleared north star; **RUN n/N** chip is one-click stop. Continues because budget remains, never because a model judged work unfinished. Not persisted across a server restart. See [Gotchas: goal run](GOTCHAS.md#goal-run-north-star-auto-continue) |
| Ultracode mode (Claude) | Sticky per-tab Claude CLI orchestration mode | **ULTRACODE** composer pill pins the tab to Claude CLI at `xhigh` effort with multi-agent **Workflow** orchestration armed so one turn can fan out and coordinate subagents; live **FLEET** panel shows running/done subagent count; per-tab web-lookup budget bounds research spend. Operator-armed and sticky until toggled off |
| One-click handoff | Fresh agent in the same tab seeded from a structured handoff | Quick assembles recent conversation, the action digest and Git state without a writer model; written modes remain available. Seed messages collapse to a one-line `HANDOFF SEED / click to expand` pill; both sessions remain valid native-CLI sessions |
| Spawn from here | Fork the conversation to a new tab | The agent self-reflects with session context and Arco saves its reply as a handoff; the new tab opens with that document and an optional `new direction:`; the original tab continues in parallel |

## Operator actions: review, compare, research, and plan

| Feature | What it does | Details |
| --- | --- | --- |
| Cross-provider review on tap | Review with a different model | Feedback as a read-only artifact in the REVIEW tab; **SEND TO AGENT** prefills the composer with the review body; local reviewers get an addendum to verify diff claims against the live tree with read-only tools |
| SECOND OPINION | Several models each draft the reply you could send to a worker | Composer **SECOND OPINION** (or the bar above the composer for selected messages); independent read-only drafts with no shared session, optional recent turns and read-only file access (both off); blind labels, vote, optional operator-chosen **SYNTHESIZE**; **USE THIS REPLY** puts the draft in the composer for editing (UNDO restores your text) and sends nothing; a per-model tally of picks is kept in the browser |
| Bounded web research | Single bounded web-research turn | Fan-out searches plus source fetch; cited markdown report in the RESEARCH tab; operator-initiated; one report per dispatch |
| Plan-scoped review | REVIEW and VERIFY against an attached plan | PLAN tab: REVIEW audits plan structure; VERIFY audits claimed-done work with `git diff HEAD` pre-included; whole-plan and per-section granularity; **CUSTOM REVIEW** tree-with-checkboxes picker. VERIFY shows only `[x]`-completed items; CRITIQUE shows everything for plan-level evaluation. Parser tolerates checkbox-stripped plans (recognizes `- **N.M**` numbered bullets as tasks) |
| Spawn-phase from plan | Prefill Spawn with a full phase block | Alongside per-task SPAWN, each `### Phase` heading gets a **SPAWN PHASE** button that opens SpawnDialog |
| DOCS one-off prompt | Structured prompt to update repo markdown from recent git activity | Hard-coded constraint: does not modify anything under `.arco/plans/` (load-bearing checkbox / H3 structure the Plan tab parses) |
| GIT one-off prompt | Git status dialog and action picker | Live status (branch, ahead/behind, dirty files); branch dropdown plus `+ NEW BRANCH` form (server-side dirty-tree refusal on switch); actions commit / commit + push / commit + push + PR via `gh pr create`; protected-branch warnings; per-repo localStorage prefs; commit-subject hint. Branch switch via `POST /api/git/checkout` before the prompt dispatches. **SHOW OTHER WORK** lists the repository's other worktrees and local branches read-only (tab working there, ahead/behind the default branch, uncommitted files, open pull request); **VIEW CHANGES** opens FILES > CHANGES on that worktree |
| RUN AS picker | Override provider/model/effort for GIT / DOCS one-offs | Unchanged: dispatches in-tab; changed: new tab opens with the picked config and runs there |

## Memory, knowledge, and scaffolding

| Feature | What it does | Details |
| --- | --- | --- |
| Embedded terminal | PTY session bound to the workflow cwd | Floating/popout terminal; output over the WS channel; can pipe selected output into the composer. See [Terminal](TERMINAL.md) |
| Recall | Full-text search across saved conversations and transcripts | SQLite-backed index at `~/.arco/recall/`; per-result summaries. See [Recall](RECALL.md) |
| Knowledge / codebase memory | Distill a repository into structured memory and inject relevant slices | RAG injection on turns that need it; KNOWLEDGE tab manages articles, links, and session-distilled notes; BLAST RADIUS view surfaces what a change touches. See [Knowledge](KNOWLEDGE.md) |
| Genesis | Project scaffolder and creative tool | Operator describes a project idea; Genesis stages a plan and bootstraps the skeleton in a fresh cwd; GENESIS tab. See [Genesis](GENESIS.md) for the engine, scaffolding, and Creative mode; [Client](CLIENT.md) for workflow creator integration |

## Local models and optional integrations

| Feature | What it does | Details |
| --- | --- | --- |
| DeepSeek via Xolotl | Separately managed service | Configurable profiles; guarded loading and unloading; text/image/tool support; reasoning; in-app help; source-version tracking. Resource needs depend on the configured profile. Arco does not download model weights. See [DeepSeek](DEEPSEEK.md) |
| Strata large MoE models | Separate OpenAI-compatible service | Configured profiles; discovered context and capabilities; optional image input; web tools; reasoning; engine tok/s. One model loads per turn; **FREE VRAM** releases local models. Memory budgets and recovery: [Strata](STRATA.md) |

## Tools, MCP, diagnostics, and ledger

| Feature | What it does | Details |
| --- | --- | --- |
| LSP-backed tools | Language-server client pool for the agent | Go-to-definition, references, and diagnostics for supported languages. See [LSP](LSP.md) |
| MCP registry | Operator-managed MCP servers | Enable/disable per workflow and per-server tool disable-list from CONFIG MCP section; registry-add runs an OSV malware pre-check (block-with-override, fail-open); MCP children run under an env allowlist so they do not inherit provider credentials. See [MCP registry](MCP_REGISTRY.md) |
| Diagnostics and support bundles | Health checks and export | Auth, binaries, ports; per-model health probes; one-click support-bundle export in SYSTEM modal **DIAGNOSTICS** / **MODELS** / **SERVICES** tabs. See [Diagnostics](DIAGNOSTICS.md) |
| Project task ledger and worktrees | Durable cwd-scoped task records | Statuses TRIAGE / TODO / READY / IN PROGRESS / BLOCKED / REVIEW / DONE / ARCHIVED in the LEDGER tab; optional git-worktree-backed task tabs for isolated checkouts. See [Task ledger](TASK_LEDGER.md) and [Checkpoints](CHECKPOINTS.md) |
| Local-services discovery | Machine-wide browser of local web services | Listening ports and heuristics; open in Preview action. SYSTEM -> SERVICES. See [Local services](LOCAL_SERVICES.md) |
| Remote management | Link a workflow or cluster to a hub for lifecycle commands | **REMOTE**, remote review gates, and **CLOUD** snapshot controls appear only while the management hub is connected. Local snapshots stay available when disconnected. See [Remote management](REMOTE_MANAGEMENT.md) |
| Notifications | In-app center and toasts; opt-in desktop and phone alerts | Settings > Notifications: desktop and phone switches start off; REQUEST PERMISSION and TEST DESKTOP check browser alerts; quiet BELL notices for other tabs follow SHOW IN BELL; ntfy server, topic, optional token and TEST; the window title shows a waiting count such as `(2) ARCO`. Desktop alerts appear only when Arco is not the focused window. See [Notifications](NOTIFICATIONS.md) |
| Checkpoints | Git-snapshot working-tree checkpoints and one-click revert | Revert to a known-good point without manual stashing. See [Checkpoints](CHECKPOINTS.md) |

## Preview, Git workbench, history, and GitHub

| Feature | What it does | Details |
| --- | --- | --- |
| Live Preview tab | Loads the workflow dev server in a sandboxed iframe | Operator-selectable aspect ratio. `npm run dev` auto-detected (Bash-command sniff + port probe + `/proc` PID-attributed listening-port discovery on Linux); same-origin proxy keyed by workflowId keeps HMR working through Arco's single forwarded port. Manual **BIND** `<port>` / **UNBIND** override auto-detect. See [Preview](PREVIEW_VERIFY.md) |
| Worktree bake-offs | Race one implementation prompt through 2-5 provider/model tabs from the same commit | Compare transcripts and diffs; explicitly promote one no-fast-forward merge. Attempts live in isolated managed worktrees; Arco never auto-selects a winner. See [Git workbench bake-off](GIT_WORKBENCH.md#i5-worktree-bake-off) |
| HISTORY tab | Read-only timeline of seq-stamped narrative events | Actions: **LABEL THIS** (pin free-text label to `events.jsonl`); **REVIEW FROM HERE** (since-event Review); **SPAWN FROM HERE** (cutoff-aware Spawn so the new tab boots truncated at the chosen seq); **REWIND CONVERSATION** (Native-first restore-point: move live head back to a chosen seq; current branch kept and returnable; fork markers inline; REWINDS filter). Native-only; rejected on CLI / Codex |
| Tasks (Claude Native) | First-class workflows for Native `Task` tool sub-agents | Scoped to parent; inline `TaskCard`; TASKS sub-tab gated on non-empty children; parallel `Task` calls dispatch concurrently; depth-1 cap by design |
| Built-in GitHub browser | Browse repos, trees, source, PRs, issues, Actions runs, and clone | Authenticated via `gh auth`; GITHUB tab |
| ARTIFACTS explorer | Chromeless read-only window for project artifacts across projects | Header **ARTIFACTS**: ARTIFACTS home (per-project cards + recent-across-all strip); RECENTS (attributed agent-writes ledger + exhaustive changed-within scan); TREE view. Read-only, zero model authority. See [Documentation index](INDEX.md) |

## Media, chrome, and themes

| Feature | What it does | Details |
| --- | --- | --- |
| Media studio | Modal viewer/editor for images, audio, and video | Server-side **FFmpeg** ops and GPU **Demucs** stem separation. Image: zoom/pan + layer-based raster editor. Audio: waveform + clip / convert / normalize / speed / gain / spectrogram, plus **SEPARATE** (Demucs stem split). Video: scrub + clip / convert / extract-audio / framegrab / gif / geometry / speed / mute. Every op is a typed spec to argv (no shell, whitelisted enums + validated numbers), confined to the workflow folder + scratch unless **Unconfined media access** is enabled. FFmpeg/Demucs are optional. See [Media studio](MEDIA_STUDIO.md) |
| Command palette, focus mode, notification bell, SYSTEM modal | Quick navigation and system surfaces | `CommandPalette`; header focus-mode toggle collapses chrome to wordmark + urgent status; notification bell; SYSTEM modal with **ACTIONS** / **DIAGNOSTICS** / **MODELS** / **SERVICES** (health, model probes, local-services, power actions) |
| Two theme families with font-pack override | Classic and Phosphor themes plus font packs | 43 Arco Classic selections (42 color/font/shader-driven palettes such as Matrix, Sentinel, Cherenkov, Aurora, Red Planet, Everforest, DSKY, Noir, plus the `provider-auto` sentinel) backed by 29 GLSL shaders; 68 Arco Phosphor CRT palettes; 29 font packs substitute display/body/code typography on top of any theme. Each Classic theme carries an inspiration backstory in the User Manual |
| Remote-friendly | Single forwarded port design | Run Arco on a local host and connect through a forwarded port |
| In-app help system | Manual and contextual help | Header **MANUAL** opens the full operator reference; floating `?` toggle enables contextual help mode (dashed outline + click-for-popover on annotated elements). Inline file references open in a stacked DocViewer reading from the local repo |

## Safety and resilience

| Feature | What it does | Details |
| --- | --- | --- |
| API resilience | Catch and retry Claude CLI overload envelopes | `overloaded_error` and `{"type":"error"}` surfaced as a system notice; retried with 15s/30s/60s backoff up to 3 attempts (same session id, idempotent) |
| Concurrent-writer guard | Detect external native CLI writes to an open session | Non-`sdk-cli` writes fire a chat warning; Arco refuses new turns for 60s rather than corrupt conversation state. Recover via Handoff |
| Long-session friendly | Tail-first chat hydration | Last 200 entries first; **LOAD EARLIER MESSAGES** pill; scroll position preserved across paging. Links open in a new tab so a clicked URL never navigates Arco away |
| Safety rails on worker processes | Bound runaway worker output and memory | 50 MB output cap per turn (`ARCO_MAX_WORKER_OUTPUT_BYTES`); 32 GB tree-RSS auto-kill (`ARCO_RSS_KILL_BYTES`); process-tree cleanup on cancel |
| Review safe-mode gate (Claude Native) | Pause sensitive tool calls for operator review | Operator-armed per-tab gate (CONFIG -> REVIEW SAFE-MODE, default off) on `Bash`, `KillShell`, writes outside the project, `git push` / `reset --hard` / `clean -fd`; editable proposal card for review, edit-then-approve, or rejection. Durable across server restart; standing "approve all like this" with live re-evaluation against a non-lossy signature |
| Project-trust gate | Suppress untrusted project instruction files until trusted | Freshly opened or cloned repo `CLAUDE.md`, project skills (`.arco/skills/`), and `.arco/settings.json` suppressed until trusted. Composer shows UNTRUSTED PROJECT with **TRUST** / **NEVER**; decision in `~/.arco/trust.json`, reversible |

## What Arco explicitly does not do

| Rule | Meaning |
| --- | --- |
| No silent autonomous routing | Arco never picks models, providers, effort levels, or task completion without an operator-armed surface and an inspectable event trail |
| No hidden orchestrator authority | No meta-agent owns a workflow. Model-assisted decomposition, assignment, recovery, or synthesis is eligible only as a visible proposal or through bounded task tools the operator enabled |
| No hidden auto-synthesis | Review, Compare, and Research outputs remain separate artifacts. Any synthesis is an operator-chosen bounded action or a visible proposal for inspection before applying |
| No LLM-curated project memory that edits itself | Knowledge/codebase memory is operator-triggered and operator-reviewed; session traces do not rewrite project instruction files |
| No opaque "smart" anything | Automatic or model-assisted behavior must be operator-armed, bounded by readable mechanics, logged, and reversible; existing cluster automations are off by default, deterministically capped, logged, and reversible |

## Related links

- [Getting started](GETTING_STARTED.md)
- [Documentation index](INDEX.md)
- [Settings map](SETTINGS.md)
- [Documentation style](STYLE.md)
