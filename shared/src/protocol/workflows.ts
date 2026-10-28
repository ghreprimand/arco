// ── Workflow / worker config + session metadata types ──

import type { EffortLevel, ModelName, ProviderName } from './providers.js';
import type { AdvancedOptions } from './settings.js';
import type { ResolvedMcpServer } from './mcp.js';
import type { GenesisSeed } from './genesis.js';

export interface WorkflowSessionMetadata {
  sessionKind?: 'antigravity-cascade';
  cascadeId?: string;
  opaqueContext?: boolean;
  arcoAutoCompact?: boolean;
  contextLabel?: string;
}

// §4.1 — posture-based toolsets. A per-tab pill that filters the Native tool
// union to a named, deterministic bundle (cuts tool-def tokens + attention
// dilution). SESSION-LOCAL + NON-PERSISTENT (lives in WorkflowState, never
// meta.json) so a reload returns to 'full'. The bundle mapping is the single
// source of truth in server/src/providers/claude-native/toolPosture.ts
// (clusterEfficiency.ts pattern). Native-only. Four-question test: operator-set
// pill, deterministic readable bundles, logged via the set event, reversible
// (flip back to full).
export const TOOL_POSTURES = ['full', 'coding', 'chat', 'review'] as const;
export type ToolPosture = (typeof TOOL_POSTURES)[number];
export function isToolPosture(v: unknown): v is ToolPosture {
  return typeof v === 'string' && (TOOL_POSTURES as readonly string[]).includes(v);
}
export const TOOL_POSTURE_DEFAULT: ToolPosture = 'full';

// Stable identity for an Arco-managed skill. Bodies deliberately stay on
// disk: a pinned tab re-resolves SKILL.md every turn so edits take effect
// immediately without bloating meta.json or the wire protocol.
export interface ArcoSkillRef {
  scope: 'project' | 'global';
  slug: string;
}

// Tab-level config. In Lite, these fields describe the *primary worker's*
// (the one long-lived chat agent per tab) provider/model/effort. Persisted
// shape is flat; nested `primary: PrimaryWorkerConfig` (plan §7) can land
// later as another mechanical rename if the surface gets big.
export interface WorkflowConfig {
  name: string;
  // docs/PROTOCOL_CLUSTER.md - tab kind discriminator. Absent or
  // 'workflow' = the existing single-primary tab shape (every persisted
  // pre-Phase-2 tab back-compats to this). 'cluster' = a parent tab that
  // hosts N member workflows; created via cluster_create, never via
  // create_workflow. Cluster tabs do not carry a primary worker — the
  // primaryProvider/primaryModel/primaryEffort fields are unused for
  // kind='cluster'. The client routes cluster tabs to ClusterTab; non-
  // cluster tabs to WorkflowView.
  kind?: 'workflow' | 'cluster' | 'chat';
  // Chat-only privacy mode. Incognito conversations live solely in server +
  // browser memory: no Arco events.jsonl/meta.json/Recall entry and no
  // localStorage job snapshot. A reload, tab close, or server restart loses
  // the conversation. Provider-side API retention remains provider-owned.
  incognito?: boolean;
  // Chat-only web access (web_search / web_fetch). Chat tabs otherwise expose
  // no tools at all, which is why an operator asking for a lookup got "I have
  // no web access here" instead of an answer. Absent ⇒ armed for a saved Chat,
  // disarmed for an Incognito Chat (a query leaves the machine, so incognito
  // opts in explicitly). Only claude / codex chats can honor it — see
  // CHAT_WEB_PROVIDERS. Ignored on kind!=='chat' tabs, which get the full
  // agent toolset anyway.
  chatWebAccess?: boolean;
  // docs/VOICE.md - this Chat is the hands-free "Computer" operator. It
  // exposes bounded arco_* tools that run in the owning browser. Codex
  // carries one arco-voice MCP child; Native/local APIs share its relay. Second documented exception to toolless Chat.
  voiceOperator?: boolean;
  computerContext?: import('./voiceOperator.js').ComputerContextState;
  primaryProvider?: ProviderName;
  primaryModel: ModelName;
  primaryEffort: EffortLevel;
  // docs/ARCHITECTURE.md - transient client-only token. The RESEARCH
  // dialog's "new tab" path mints this and threads it onto the spawned tab's
  // config so the client can recognize the resulting `workflow_created` and
  // fire the deferred `research_request` against the new workflow id. The
  // server treats it as an opaque passthrough (echoed back in workflow_created,
  // never persisted meaningfully). Absent on every ordinary tab.
  researchSpawnToken?: string;
  // docs/ARCHITECTURE.md - transient client-only token, same shape +
  // lifecycle as researchSpawnToken. The template picker mints this and threads
  // it onto the new tab's config so the client can recognize the resulting
  // `workflow_created` and apply the deferred seedPrompt (composer pre-fill) +
  // plan (POST /api/plans attach). Server treats it as opaque passthrough
  // (echoed in workflow_created, never persisted meaningfully). Never
  // auto-sends — pre-fill only (§D4 design decision 2). Absent on ordinary tabs.
  templateSpawnToken?: string;
  // Transient/durable provenance for a worktree bake-off attempt. These
  // fields identify the attempt in the UI; authority remains with the
  // source workflow's Bake-off tab and manifest.
  bakeoffId?: string;
  bakeoffAttemptId?: string;
  bakeoffSourceWorkflowId?: string;
  // A managed bake-off worktree is byte-identical to this operator-opened
  // source repo at creation. DD7 resolves the trust decision from this source
  // path while still discovering/reading resources from the worktree path.
  managedWorktreeSourceCwd?: string;
  // Provider-account profile id, scoped to primaryProvider. v1 routes Codex
  // by setting CODEX_HOME per worker; unset preserves legacy default auth.
  providerAccountRef?: string;
  skipPermissions: boolean;
  workingDirectory: string;
  resumeSessionId?: string;
  // Arco workflow id to resume. Kept for back-compat with any old
  // persisted state; Phase 3 replaced the picker with native-session ids.
  resumeWorkflowId?: string;
  // Narrow which provider pools this tab may use. Undefined or empty means
  // "all available providers".
  allowedProviders?: ProviderName[];
  // Pass --fast on Claude primary spawn for faster (higher-throughput)
  // output. Opus 4.6 fast-mode toggle parity with native CLI. Default false.
  fastMode?: boolean;
  advanced?: AdvancedOptions;
  // Phase 3 context robustness — per-tab auto-handoff config. Defaults
  // (enabled=true, warnAt=75, autoAt=90) are applied server-side when absent.
  // WP5 — `mode` picks how an auto-handoff is performed: 'original-worker'
  // resumes the same session (only valid for resumable providers — claude /
  // codex); 'fresh-summarizer' spawns a strong agent to write the handoff.
  // Absent ⇒ resolved at fire time from the global default then the
  // provider-resumable fallback. `summarizer` pins WHICH model writes a
  // fresh-summarizer handoff (per-tab override; falls back to the global
  // settings.handoffSummarizer, then the tab's primary). model/effort optional
  // — the resolver fills them from the primary when absent.
  autoHandoff?: {
    enabled: boolean;
    warnAt: number;
    autoAt: number;
    mode?: 'original-worker' | 'fresh-summarizer';
    summarizer?: { provider: ProviderName; model?: ModelName; effort?: EffortLevel };
  };
  // §2.1 — per-tab auto-fold (Claude Native only). When enabled, an in-place
  // deterministic Fold fires once the §2.3 budget meter's effective-window pct
  // crosses `foldAt` (which sits BELOW autoHandoff.warnAt, so the cheap Fold is
  // tried before a handoff is recommended). `tailBudget` is the verbatim-tail
  // token budget (default ~20% of the model window). OFF by default — like
  // auto-handoff it's an operator-armed surface. Persisted to meta.json.
  autoFold?: {
    enabled: boolean;
    foldAt: number;
    tailBudget?: number;
  };
  // Phase 6e — per-tab Codex transport override. Falls through to the
  // settings cascade (`settings.codex.transport`) when absent; final default
  // is `'exec'`. Only honored on Codex tabs. Persisted to meta.json so it
  // survives reload + server restart. See docs/PROVIDERS.md
  codexTransport?: 'exec' | 'appserver';
  // Codex context-window policy. Absent / 'max' asks Codex for the selected
  // model's live catalog max; 'standard' leaves Codex at its conservative
  // catalog default. Persisted per tab. Codex still reports the authoritative
  // effective window after each turn.
  codexContextPolicy?: 'max' | 'standard';
  // Phase 7a — per-tab Claude transport override. Falls through to
  // `settings.claude.transport` cascade; final default `'cli'`. Only
  // honored on Claude tabs. See docs/PROVIDERS.md
  claudeTransport?: 'cli' | 'native';
  // docs/PROVIDERS.md - sticky per-tab ultracode mode (default off / undefined).
  // While on, every Claude turn is forced onto the CLI transport with the
  // Workflow tool + xhigh (the harness WorkflowTool lives only in the `claude`
  // binary). The force happens at turn time in turnEngine WITHOUT overwriting
  // `claudeTransport`, so the operator's stored base transport (e.g. 'native')
  // is preserved and restores itself the moment ultracode is turned off — no
  // separate "remembered base" field needed. Persisted to meta.json.
  ultracode?: boolean;
  // Per-tab override for the Claude Native web_search / web_fetch per-turn
  // budget (the Anthropic server tools' `max_uses`). Absent ⇒ the server
  // default (DEFAULT_WEB_TOOL_MAX_USES, 15). Native-only — CLI Claude uses the
  // `claude` binary's own web tooling and ignores this. Persisted to meta.json.
  webSearchMaxUses?: number;
  // Phase 7c-followup — Claude Native worker support for Anthropic's
  // server-managed `compact_20260112` context management. Unless explicitly
  // false, the worker appends `compact-2026-01-12` to the request's anthropic-beta
  // header on each turn so Anthropic transparently summarizes earlier
  // history once the model's compaction trigger fires. Only honored on
  // Claude Native tabs whose active model exposes the capability in the
  // catalog; ignored otherwise. Coexists with `autoHandoff.enabled` —
  // both can be on (two safety nets) or either off. See
  // docs/PROVIDERS.md
  claudeNativeCompact?: boolean;
  // Debug override for Claude Native adaptive-thinking models. Default false:
  // adaptive models get interleaved thinking automatically and do not need
  // the `interleaved-thinking-2025-05-14` beta. True forces that beta anyway
  // for A/B testing if a future model regresses on multi-tool reasoning.
  claudeNativeForceInterleavedThinkingBeta?: boolean;
  // Adaptive-thinking display for Claude Native models. Absent / 'omitted'
  // keeps the Claude-Code-parity default (no thinking streamed back — a long
  // Fable/Opus think is invisible in the Activity tab). 'summarized' streams
  // summarized thinking deltas, which land as primary_thinking Activity rows
  // and keep the stuck-detector clock fresh. Budget-thinking models already
  // stream summarized thinking and ignore this. Persisted to meta.json.
  claudeNativeThinkingDisplay?: 'omitted' | 'summarized' | 'updates';
  // docs/PROVIDERS.md - tool-call-count threshold that emits a
  // ctx_action {trigger: "auto-threshold"} event when the workflow has
  // dispatched N tool calls without an operator-initiated context reset.
  // Off by default; "conservative" fires at 75 then every 50; "aggressive"
  // at 50 then every 25. Today the event is informational (the chat
  // divider per Phase D §8c surfaces it); no automated compaction lands
  // until "compact" has a clear meaning in Arco's surfaces. The chip in
  // the composer (6b.1) reads `toolCallsSinceHandoff`; this is its
  // server-side counterpart for transcript-side persistence.
  efficiencyAutoCompact?: 'off' | 'conservative' | 'aggressive';
  // NATIVE_COMPACTION_PLAN Phase 3 — opt-in auto-continue after a Native
  // compaction. Default false (MANUAL resume): the operator clicks "Continue"
  // in the composer to resume from the compacted seed. When true, the server
  // auto-sends a short continuance prompt after the compaction settles
  // (manual COMPACT button OR Phase 2 between-turn auto path). Kept opt-in
  // because between-turn compaction means the turn already ended — auto-
  // continuing is autonomous continuation, which the autonomy fence
  // (CLAUDE.md) keeps off by default. Native-only.
  nativeCompactAutoContinue?: boolean;
  // docs/PROVIDERS.md - Native-side tool-result filter mode.
  // `off`: no filter; tool stdout/stderr lands verbatim (subject only to
  // the existing 50 MB hard cap).
  // `conservative` (default for new tabs once Phase C ships): the
  // ship-day pack list — bash-cargo-test, bash-jest-vitest, bash-pytest,
  // bash-git-status, bash-find, bash-grep, bash-ls.
  // `aggressive`: reserved for measured-and-promoted packs. Today
  // resolves to the same list as conservative; promoting a pack into
  // aggressive requires a follow-up phase with operator data per the
  // docs/PROVIDERS.md doc-discipline rule.
  // Per-tab CONFIG-tab toggle; only honored on Claude Native tabs.
  efficiencyToolFilter?: 'off' | 'conservative' | 'aggressive';
  // docs/PROVIDERS.md - fact-force first-edit gate toggle.
  // `'on'`: the first `Edit`/`Write`/`MultiEdit` of a turn targeting any
  // not-yet-edited path is intercepted with a synthetic tool_result asking
  // the model to state importers + API surface + the operator instruction
  // it satisfies. `'off'` skips the gate entirely. Per-tab CONFIG toggle;
  // only honored on Claude Native (CLI parity is deferred — master
  // refactor §3.3 F4). Defaults to `'off'`; the operator explicitly opts in.
  efficiencyFactForce?: 'on' | 'off';
  // Per-tab config-protection write-gate. `'on'` (default for ALL tabs —
  // safety gate) intercepts `Edit`/`Write`/`MultiEdit` targeting lint /
  // format / type-check config files (eslint.config.*, tsconfig*.json,
  // .prettierrc*, ruff.toml, .editorconfig) with a synthetic tool_result
  // nudging the model to fix the code instead of weakening the gate.
  // `'off'` relaxes the gate for this one workflow — the operator opts out
  // when a legitimate config edit (e.g. a new path mapping) is needed.
  // Per-tab CONFIG toggle; only honored on Claude Native (the gate lives in
  // the Native worker's dispatchTool — CLI / Codex / Gemini have no gate).
  // Absent field ⇒ `'on'` (gate stays on; opting out is explicit).
  efficiencyConfigProtection?: 'on' | 'off';
  // docs/PROVIDERS.md - opt-in sandbox tool surface. When
  // `'on'`, the Native worker registers three additional tools in the
  // Anthropic tools[] array: `ctx_execute` / `ctx_search` / `ctx_fetch`.
  // The worker also appends a system-prompt nudge so the model knows the
  // tools exist and what they're useful for. Per-tab opt-in; default
  // `'off'`. Native-only — CLI / Codex / Gemini ignore the field.
  // Per-tab SQLite database (with an FTS5 virtual table over chunk
  // content) lives at <cwd>/.arco/workflows/<wfId>/sandbox.db and is
  // unlinked on tab close (remove_workflow) or operator Clear-DB.
  efficiencySandbox?: 'off' | 'on';
  // docs/PROVIDERS.md - operator-armed durable HITL review gate. When `'on'`, the
  // Native worker's dispatchTool pauses on a *sensitive* tool call (static
  // allowlist in `gateReview.ts`: Bash, KillShell, write outside cwd, git
  // push/reset --hard/clean) and surfaces an editable proposal the operator
  // approves / edits / rejects. Default `'off'` ⇒ the gate is inert and adds
  // nothing to the hot path. Native-only — CLI / Codex / Gemini ignore the field.
  reviewSafeMode?: 'off' | 'on';
  // docs/PROVIDERS.md - operator-armed terseness picker. Three levels:
  // `normal` (default; no addendum, status quo), `lite` (drop fillers /
  // pleasantries / hedging; keep grammar), `terse` (fragments OK; drop
  // articles; short synonyms — was `caveman`, renamed 2026-05-10).
  // Cuts output tokens. The Native system-block builder appends
  // `outputStyleAddendum(level)` after the forced-first block. Code
  // blocks / error strings / file paths preserved verbatim by the addendum
  // text. Native-only — CLI / Codex / Gemini ignore (operators install
  // upstream caveman themselves; see helpContent for the link). Persists
  // to meta.json; takes effect on the next turn (system block is rebuilt
  // per turn). Review / Handoff seed / DOCS / GIT primitives hard-code
  // `'normal'` regardless of source tab — see plan §6. Legacy `'caveman'`
  // values in pre-2026-05-10 meta.json files are auto-aliased to `'terse'`
  // on rehydrate.
  outputStyle?: 'normal' | 'lite' | 'terse';
  // docs/GOTCHAS.md - operator-set persistent north-star. Short free-text
  // objective ("what is this whole session ultimately in service of") injected as
  // a high-priority stable system block on every turn until cleared. Durable
  // across restarts and resumes (meta.json). ZERO model authority: pure steering
  // context, never a controller — no loop, no completion judge, no spawn. Absent
  // / empty ⇒ no block, byte-identical to pre-feature behavior. Cap
  // GOAL_MAX_BYTES = 2048 (goalBlock.ts). Honored by every transport that folds
  goal?: string;
  // docs/GOTCHAS.md - operator-armed north-star auto-continue. While armed,
  // a deterministic continuation turn is dispatched after each settled turn
  // until the iteration budget runs out or a stop condition trips. Requires a
  // `goal` (there is nothing to continue toward without one). Default absent
  // ⇒ OFF; byte-identical to pre-feature behavior.
  //
  // Deliberately NOT Codex's `create_goal`: the operator arms it (no model
  // tool can), every tick is a real visible turn, the budget is mandatory and
  // finite, and disarming is one click. It carries no model authority — the
  // loop continues because budget remains, never because a model judged the
  // work unfinished. See docs/GOTCHAS.md § Codex app-server for the
  // 2026-07-28 incident that motivated the distinction.
  goalRun?: {
    enabled: boolean;
    // Iterations armed / left. `remaining` counts down per dispatched tick and
    // is what makes the loop terminate; `total` is kept for the chip's "3/10".
    total: number;
    remaining: number;
    // Output+input tokens accumulated across the run, for the cost chip. An
    // optional ceiling stops the run when crossed (unset ⇒ iterations only).
    tokensUsed: number;
    tokenBudget?: number;
  };
  // Operator-pinned Arco skills. Unlike one-shot `pickedSkills`, these are
  // re-resolved and injected as standing system instructions on every primary
  // turn until removed. Durable across restart / Handoff / Native compaction.
  // References only; SKILL.md remains the source of truth.
  pinnedSkills?: ArcoSkillRef[];
  // REMOTE_MANAGEMENT.md §1.4 — per-workflow opt-in to the management hub. The
  // documented `REMOTE CONTINUATION` gate: default OFF. When false (the
  // default), this workflow is NOT reported to the hub (invisible in the VPS
  // console), remote actions (reply/stop/continue/handoff) are rejected
  // (`remote-disabled`), and it generates NO phone notifications. Flip true to
  // monitor / respond / get notified from the tailnet console. Persists to
  // meta.json. Only meaningful when the instance is hub-linked (ARCO_HUB_URL
  // set); inert otherwise.
  remoteEnabled?: boolean;
  // R1 (docs/REMOTE_MANAGEMENT.md) - SECOND arming for remote DEBAG
  // gate resolution, default OFF. `remoteEnabled` alone lets the phone converse
  // with the workflow; approving/rejecting a parked sensitive tool call from
  // the phone additionally requires this flag. Remote conversation never
  // implies remote approval authority. Persists to meta.json; inert unless
  // hub-linked AND reviewSafeMode is arming gates in the first place.
  remoteGatesEnabled?: boolean;
  // docs/PROVIDERS.md - operator-attached `DeusData/codebase-memory-
  // mcp` for this tab. The binary is operator-installed once per machine
  // (see docs/OPERATIONS.md) and Arco invokes it with `--skip-config` so
  // it doesn't auto-edit other agent configs. Phase F ships UX wiring only;
  // the actual `--mcp-config` write-in at CLI spawn time is deferred to the
  // follow-up that piggybacks on Cluster Phase 3's `mcpConfigWriter`.
  // `attached` is the operator's intent bit; `indexPath` defaults to the
  // workflow's workingDirectory when absent. `lastIndexedAt` + `fileCount`
  // are populated by the one-shot re-index endpoint until the spawn-site
  // wiring lands. Persists to meta.json.
  codebaseMemory?: {
    attached: boolean;
    indexPath?: string;
    lastIndexedAt?: number;
    fileCount?: number;
  };
  // docs/GENESIS.md - the staged-ideation seed for a
  // from-nothing genesis workflow. THE durable home for the seed while the
  // workflow has no working directory: it rides the client-persisted config and
  // is re-sent on `rehydrate_workflows`, so a server restart mid-ideation
  // restores it. Once `genesis_scaffold` binds a cwd, the seed is also mirrored
  // into meta.json. Absent on every ordinary (non-genesis) workflow. The turn
  // engine reads it to inject the genesis system block until the seed is
  // scaffolded (the workflow gains a real cwd).
  genesisSeed?: GenesisSeed;
  // docs/PROVIDERS.md - per-tab Ollama generation-param preset blob,
  // keyed by Ollama option name (num_ctx, keep_alive, num_gpu, temperature,
  // and the pre-wired extensions in providers/ollamaParams.ts). Edited via the
  // CONFIG-tab "advanced params" affordance (Ollama tabs only), persisted to
  // meta.json, threaded to the worker per turn, and merged into the /api/chat
  // body through the typed allowlist boundary. Absent ⇒ Modelfile/daemon
  // defaults (status quo). num_ctx is trusted-only — clamped against the
  // model's probed Modelfile window, never sent on a guess (Hardening §3).
  ollamaParams?: Record<string, unknown>;
}

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  name: string;
  startedAt: number;
  // Which provider CLI owns this native session. Drives the Resume picker —
  // selecting an entry auto-sets the new tab's primary provider so `--resume`
  // / `codex exec resume` targets the right binary.
  provider: ProviderName;
  providerAccountRef?: string;
  providerAccountLabel?: string;
  providerAccountShortLabel?: string;
  // True when an Arco workflow meta.json already claims this session. The
  // Resume picker can show "Arco: <name>" instead of the raw first-turn
  // preview and — on server-side — reuse the existing workflow id rather
  // than minting a new one on resume.
  arcoWorkflowId?: string;
  arcoName?: string;
  // True for workflows resumed by Arco workflow id instead of a native
  // provider session picker id. Used for providers whose continuity is
  // Arco-managed rather than native-session-managed, such as Claude Native
  // event replay, Antigravity workflow-id rows, and Ollama transcript replay.
  arcoInternal?: boolean;
  // Claude's dynamic conversation title (`ai-title` entry in the session
  // JSONL). Claude writes this AT MOST ONCE per session — many sessions
  // never get one — so treat it as "Claude's best guess at naming the
  // conversation", not a live summary. Undefined for Codex + fresh sessions.
  aiTitle?: string;
  // Preview of the most recent user turn (≤80 chars, one line). Picker
  // uses this as the dynamic subtitle so "what am I working on right now"
  // is visible even when aiTitle is absent / stale / identical to the
  // first-user-message fallback.
  lastUserPreview?: string;
}

// Entry returned by GET /api/workflows?path=<cwd>. Built from
// <cwd>/.arco/workflows/<wfid>/meta.json. Phase 3 Lite shifted the Resume
// picker to /api/sessions (native CLI sessions unified); this summary is
// still emitted for tooling / debugging.
export interface WorkflowMetaSummary {
  workflowId: string;
  name: string;
  cwd: string;
  createdAt: number;
  lastActiveAt: number;
  primaryProvider: ProviderName;
  primaryModel: ModelName;
  primaryEffort: EffortLevel;
  // Last Claude CLI session bound to this workflow.
  lastClaudeSessionId?: string;
}

// GET /api/chats — machine-global saved Chat conversations. The config is
// reconstructed from meta.json server-side so reopening preserves transport,
// provider account, model, effort, and other turn-relevant choices.
export interface SavedChatSummary {
  workflowId: string;
  name: string;
  createdAt: number;
  lastActiveAt: number;
  primaryProvider: ProviderName;
  primaryModel: ModelName;
  primaryEffort: EffortLevel;
  lastUserPreview?: string;
  config: WorkflowConfig;
}

// Phase 5 — single mid-turn steer entry handed off from the server's queue
// to the worker. `clientMessageId` matches the optimistic chat row created
// at enqueue time so the client can flip its QUEUED pill on
// `queued_messages_drained`. `attachments` are folded into the injected
// user-message text as `[attached file: <path>]` references — mid-turn image
// re-encoding into provider-specific shapes is intentionally out of scope.
export interface SteerItem {
  content: string;
  clientMessageId?: string;
  attachments?: string[];
}

export interface WorkerConfig {
  model: ModelName;
  effort: EffortLevel;
  provider?: ProviderName;
  // Hard execution contract: chat workers receive no project tools and run
  // from an isolated storage cwd. This is not merely presentation metadata.
  interactionMode?: 'agent' | 'chat';
  // Chat-only: arm the provider's web tools for this turn. Never set for
  // agent-mode turns (they already carry the full toolset).
  chatWebAccess?: boolean;
  // Chat-only: expose the bounded Computer tools (Codex MCP / Native/local relay).
  voiceOperator?: boolean;
  // Incognito Chat only. Provider adapters use this to disable their own CLI
  // session files where supported (Claude --no-session-persistence, Codex
  // --ephemeral). Never set for project workflows or saved Chat.
  incognito?: boolean;
  providerAccountRef?: string;
  // Codex-only: alternate CODEX_HOME for multi-subscription profiles.
  codexHome?: string;
  skipPermissions?: boolean;
  cwd?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  tools?: string[];
  additionalDirectories?: string[];
  fallbackModel?: ModelName;
  sessionId?: string;       // use --session-id <id> (enables persistence)
  resumeSessionId?: string; // use --resume <id>
  // Server-local filesystem paths for files the operator attached to this
  // turn. Claude embeds image files (png/jpg/jpeg/gif/webp) as base64 content
  // blocks; Codex passes them via `--image`; Ollama embeds base64 image bytes.
  // Any other file has its path appended to the text prompt.
  attachments?: string[];
  // Codex-only: explicit sandbox level. When set, wins over `skipPermissions`
  // (which only chooses between workspace-write / danger-full-access).
  // Reviewers set this to `'read-only'` so the `-s read-only` flag is honored
  // — Codex has no tools allow-list, so the sandbox flag is how read-only is
  // enforced. Other providers ignore this field.
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  // Phase 5 — mid-turn steer hook for providers that own their own agent loop
  // (Ollama, llama.cpp). Called between tool-result append and the next API
  // round-trip; returns any pending steer entries (FIFO) and side-effects on
  // the server (queue-update broadcast + queued_messages_drained). Worker
  // appends each entry as a `role:'user'` message before the next call.
  // Wired only by the primary-turn path; reviewers/handoffs leave it unset
  // so a steer queued during a handoff-seed turn waits for the operator's
  // first real reply rather than landing inside the ack.
  // In-process callback only; not serialized.
  drainSteer?: () => SteerItem[];
  // Phase 6b — re-enqueue hook for the Codex app-server worker. Called when
  // a `turn/steer` round-trip fails and the drained items have to land
  // back in a queue: `'steer'` for `activeTurnNotSteerable` (the next
  // operator turn picks them up as steer); `'follow-up'` for a mismatched
  // expectedTurnId / generic transport blip. Symmetrical with `drainSteer`
  // — both are in-process callbacks owned by the primary-turn dispatch
  // site and carry the same not-serialized contract.
  requeueSteer?: (items: SteerItem[], bucket: 'steer' | 'follow-up') => void;
  // Phase 6 — workflow id for providers with a per-workflow lifetime.
  // The Codex app-server worker is cached per workflowId so subsequent
  // turns reuse the same long-lived `codex app-server` subprocess (the
  // tab's Codex thread stays warm across turns). Other providers (and the
  // Codex `exec` transport) ignore this field. Reviewers/handoff seeds
  // pass it through too — reviewers always run with `codexTransport:
  // 'exec'` so the per-workflow cache never picks them up.
  workflowId?: string;
  // Phase 6 — Codex transport selector. `'exec'` (default, undefined) keeps
  // the existing per-turn `codex exec --json` worker. `'appserver'` opts
  // into the long-lived `codex app-server` worker (mid-turn steer + structured
  // interrupt). Resolved from the project/global cascade in
  // `handleUserMessage` and threaded through to the dispatcher; reviewers
  // hard-code `'exec'`. See docs/PROVIDERS.md.
  codexTransport?: 'exec' | 'appserver';
  // Resolved per-tab Codex context policy. Absent means Arco's MAX default.
  codexContextPolicy?: 'max' | 'standard';
  // Phase 7a — Claude transport selector. `'cli'` (default, undefined) keeps
  // the per-turn `claude -p` CLI spawn. `'native'` opts into the long-lived
  // in-process Anthropic-API worker (mid-turn steer; OAuth subscription auth;
  // CLAUDE.md auto-discovery). Reviewers / handoff seeds always run on
  // `'cli'`. See docs/PROVIDERS.md
  claudeTransport?: 'cli' | 'native';
  // docs/PROVIDERS.md - operator-armed sticky mode. When true on a CLI Claude
  // turn: prepend the `ultracode` keyword, ensure the Workflow tool is exposed,
  // force `xhigh`, and switch turn-completion to wait-for-process-exit +
  // coalesce-to-last-result (a background workflow emits MULTIPLE `result`
  // events; the last before exit is the real synthesis). Only honored on
  // provider='claude' + claudeTransport='cli'; other transports ignore it.
  ultracode?: boolean;
  // Phase 7b — Task-spawned child workers carry this so their tool registry
  // drops the `Task` tool (depth-1 cap; non-goals doc forbids autonomous
  // orchestration trees). The parent never sets it. In-process callback path
  // only — never JSON-serialized over the wire.
  claudeNativeTaskDisabled?: boolean;
  // Phase 7c-followup — unless explicitly false, the Claude Native worker
  // appends the `compact-2026-01-12` beta to its anthropic-beta header per
  // request and includes `context_management.edits =
  // [{type: 'compact_20260112'}]` on every messages.create. Resolved by the
  // dispatcher from WorkflowConfig.claudeNativeCompact and gated against the
  // model's catalog capability. Other transports ignore the field.
  claudeNativeCompact?: boolean;
  // Mirror of WorkflowConfig.claudeNativeForceInterleavedThinkingBeta.
  // Native-only debug override; other transports ignore the field.
  claudeNativeForceInterleavedThinkingBeta?: boolean;
  // Mirror of WorkflowConfig.claudeNativeThinkingDisplay threaded into the
  // worker so buildThinkingParams picks the adaptive-thinking display per
  // request. Absent ⇒ 'omitted'. Primitives (reviewers / handoff seeds) leave
  // it unset, like outputStyle's forced 'normal'. Other transports ignore.
  claudeNativeThinkingDisplay?: 'omitted' | 'summarized' | 'updates';
  // docs/PROVIDERS.md - per-turn operator notice (peer-mailbox
  // depth, plan-mode arm nudge). The Native worker appends it to the
  // operator's user message and leaves it there for the life of the
  // conversation; folding it into `system` and dropping it next turn was a
  // prefix edit. Other transports keep receiving it inside appendSystemPrompt.
  // Operator-turn only; unset on auto-continue / drain iterations.
  turnNotice?: string;
  // docs/PROVIDERS.md - mirror of WorkflowConfig.efficiency-
  // AutoCompact threaded into the worker so the dispatch loop can count
  // tool calls and emit ctx_action {trigger: "auto-threshold"} events at
  // the configured threshold without round-tripping back to the workflow
  // store. See WorkflowConfig for semantics.
  efficiencyAutoCompact?: 'off' | 'conservative' | 'aggressive';
  // docs/PROVIDERS.md - mirror of WorkflowConfig.efficiencyToolFilter
  // threaded into the worker so dispatchTool can resolve a filter pack per
  // tool call. Other transports ignore the field. See WorkflowConfig for
  // semantics.
  efficiencyToolFilter?: 'off' | 'conservative' | 'aggressive';
  // docs/PROVIDERS.md - mirror of WorkflowConfig.efficiencyFactForce
  // threaded into the worker so dispatchTool can evaluate the first-edit
  // fact-force gate per turn. Other transports ignore. See WorkflowConfig.
  efficiencyFactForce?: 'on' | 'off';
  // Mirror of WorkflowConfig.efficiencyConfigProtection threaded into the
  // worker so dispatchTool can decide whether to run the config-protection
  // gate. Absent ⇒ gate ON. Other transports ignore. See WorkflowConfig.
  efficiencyConfigProtection?: 'on' | 'off';
  // docs/PROVIDERS.md - mirror of WorkflowConfig.efficiencySandbox
  // threaded into the worker so buildToolDefs() can register the three
  // `ctx_*` tools and buildSystemBlocks() can append the sandbox nudge.
  // Other transports ignore. See WorkflowConfig.
  efficiencySandbox?: 'off' | 'on';
  // docs/PROVIDERS.md - mirror of WorkflowConfig.reviewSafeMode threaded into the
  // worker so dispatchTool can decide whether to run the review gate. Absent ⇒
  // gate OFF. Other transports ignore. See WorkflowConfig.
  reviewSafeMode?: 'off' | 'on';
  // docs/PROVIDERS.md - mirror of WorkflowConfig.outputStyle threaded into
  // the worker so the system-block builder can append the matching addendum
  // text (`outputStyleAddendum`). Reviewers / Handoff seeds / DOCS / GIT
  // primitives hard-code `'normal'` regardless of source-tab value (plan §6).
  // Spawn-from-here inherits parent's value. Only honored on Claude Native;
  // other transports ignore. Renamed `caveman` → `terse` 2026-05-10.
  outputStyle?: 'normal' | 'lite' | 'terse';
  // docs/GOTCHAS.md - mirror of WorkflowConfig.goal threaded into the
  // worker so the system-block builder can push the operator's north-star block
  // (`goalBlock`) immediately after FORCED_FIRST_BLOCK, before the cluster plan.
  // Zero model authority — steering context only. Absent / empty ⇒ no block.
  // Honored by every transport that folds `clusterPlan`. Review / Handoff / DOCS
  // / GIT primitive seeds INHERIT the source tab's value (they set it, unlike
  // outputStyle's forced 'normal'); Spawn-from-here inherits the parent's.
  goal?: string;
  // §4.1 — posture-based toolset. Session-local pill (WorkflowState, not
  // persisted) threaded into the worker so buildToolDefs() filters the tool
  // union to the posture's bundle. Unset / 'full' ⇒ no filtering. Native-only;
  // takes effect next turn (tools[] is rebuilt per messages.create).
  toolPosture?: ToolPosture;
  // Operator-initiated plan-mode entry. When true, the Claude Native worker
  // flips `planMode = true` before the turn's first messages.create so the
  // Write/Edit gate is active, and the dispatcher prepends a system-prompt
  // nudge instructing the model to call EnterPlanMode. Single-turn —
  // resolved by the dispatcher from WorkflowState.pendingPlanModeEntry and
  // cleared after consumption. Other providers / transports ignore it.
  claudeNativePlanModeArmed?: boolean;
  // docs/PROTOCOL_CLUSTER.md - when set, the Claude Native worker
  // registers the three `peer_*` tools into its tool list and routes
  // matching tool_use blocks to peerTools.executePeerTool. Resolved by
  // handleUserMessage from clusterStore.getClusterIdForWorkflow at turn
  // start. Hard requirement (plan §6.1d): leaking peer tools into a
  // non-cluster workflow breaks the no-orchestrator invariant — the gate
  // is `clusterId !== undefined`. Other transports ignore the field for
  // now (Phase 3+ wires them via MCP).
  clusterId?: string;
  // Cluster-member information boundary. Blind members retain their normal
  // project cwd but only receive mailbox tools/context. Isolated members run
  // Claude Native in a private cwd and also keep persistence rooted at the
  // real project via `persistenceCwd`.
  clusterAccessMode?: import('./clusters.js').ClusterMemberAccessMode;
  persistenceCwd?: string;
  // True only when this cluster is explicitly attached to the cwd-scoped
  // project task ledger. Peer/plan cluster tools still follow clusterId;
  // cluster_task_* tools additionally require this flag so same-cwd clusters
  // do not automatically share a board.
  clusterTaskBoardAttached?: boolean;
  // Shared cluster plan body, resolved by handleUserMessage at turn start
  // from the cluster's active <cwd>/.arco/plans/<id>.md.
  // Threaded into the worker so buildSystemBlocks() can inject it as a
  // forced system block after FORCED_FIRST_BLOCK. Empty / undefined ⇒ no
  // block. Hard cap 32768 chars (enforced server-side at write time).
  // Non-Native transports ignore the field.
  clusterPlan?: string;
  // docs/PROTOCOL_CLUSTER.md - this member's role hint (<=120 chars),
  // resolved by handleUserMessage at turn start from clusterStore. When
  // set, the Native worker injects `Your role in this cluster: <role>` as
  // a system block immediately after the cluster-plan block. Empty /
  // undefined ⇒ no block. Non-Native transports ignore the field.
  clusterRole?: string;
  // 2026-06-15 — per-cluster efficiency doctrine, resolved by
  // handleUserMessage at turn start from clusterEfficiency.buildDoctrine()
  // (canned text for the cluster's efficiencyLevel + the optional operator
  // addendum). When set, injected as a forced system block immediately after
  // the role block (Native), folded into finalAppend (CLI / Codex), and added
  // to buildLocalClusterSystemPrompt (Ollama / llama.cpp). Empty / undefined ⇒
  // no block (the 'thorough' default produces no doctrine). The peer-send
  // budget + mailbox-notice variant ride the same level resolution but are
  // applied at their own sites, not via this field.
  clusterEfficiencyDoctrine?: string;
  // 2026-06-29 — per-cluster progress-tracking doctrine, resolved by
  // handleUserMessage at turn start from clusterProgress.buildProgressDoctrine()
  // (which surface[s] to keep current, gated on whether a plan/board actually
  // exists for the cluster). When set, injected as a forced system block right
  // after the efficiency-doctrine block (Native), folded into finalAppend
  // (CLI / Codex), and added to buildLocalClusterSystemPrompt (Ollama /
  // llama.cpp). Empty / undefined ⇒ no block.
  clusterProgressDoctrine?: string;
  // docs/PROTOCOL_CLUSTER.md + docs/PROVIDERS.md - absolute
  // path to the per-workflow `mcp-config.json` written by
  // `mcpConfigWriter.writeFor`. Only set on CLI Claude turns when the
  // workflow is a cluster member AND/OR has codebase-memory attached; the
  // CLI provider appends `--mcp-config <path>` to its `claude` argv so the
  // claude CLI spawns the per-spawn MCP stdio children declared in that
  // file. Native ignores this field — it dispatches peer_* in-process via
  // peerTools, and a Native equivalent for codebase-memory is deferred
  // (MASTER_REFACTOR §3.3 row F10).
  clusterMcpConfigPath?: string;
  // docs/PROVIDERS.md - operator-attached codebase-memory-mcp
  // intent + resolved index path. Set on every turn when
  // `wf.config.codebaseMemory.attached === true`. The Codex providers
  // (`exec` per-turn, `app-server` per-process) layer the registration on
  // via `-c mcp_servers.codebase-memory.*` TOML overrides built from these
  // fields. The Claude CLI provider gets the same registration via the
  // merged `mcp-config.json` referenced by `clusterMcpConfigPath` above.
  // Native ignores both — see F10.
  codebaseMemoryAttached?: boolean;
  codebaseMemoryIndexPath?: string;
  // docs/ARCHITECTURE.md - namespaced tool names (`mcp__<key>__<tool>`) for
  // dangerous-and-UNticked tools of the workflow's operator-enabled registry
  // servers. The CLI Claude provider appends each as `--disallowedTools`,
  // which composes with `--dangerously-skip-permissions` (verified) and
  // removes the tool from the model's set. Codex has no per-tool deny flag, so
  // it ignores this field (documented gap). Native ignores it in this pass
  // (E1-Native is pass 2).
  mcpDisallowedTools?: string[];
  // docs/ARCHITECTURE.md - operator-enabled-and-allowed registry MCP servers
  // for this workflow turn. The Codex providers (exec / app-server) build
  // `-c mcp_servers.<key>.*` TOML overrides from these (Codex has no
  // --mcp-config). CLI Claude gets the SAME servers via the merged
  // mcp-config.json written by mcpConfigWriter.writeFor (the writer takes them
  // through McpConfigOptions.registryServers), so it ignores this field.
  // Native ignores it in this pass (E1-Native is pass 2).
  mcpRegistryServers?: ResolvedMcpServer[];
  // docs/ARCHITECTURE.md (Deep Research) - overrides the Claude
  // Native web_search / web_fetch `max_uses` budget for a single spawn so a
  // research run's operator-set `maxRounds` is a MECHANICAL hard ceiling, not
  // just prompt-advisory. Only honored on Claude Native; other transports
  // ignore it (Codex's `web_search: 'live'` exposes no per-turn max_uses knob,
  // so its hard stop is the single bounded turn + the prompt-stated cap — this
  // provider asymmetry is documented in runResearch.ts and docs/PRIMITIVES.md).
  // Unset ⇒ historical default of 10.
  webSearchMaxUses?: number;
  // docs/PROVIDERS.md - per-tab Ollama generation-param preset blob.
  // Mirror of WorkflowConfig.ollamaParams, resolved at turn start. The Ollama
  // provider merges it through the typed allowlist boundary
  // (providers/ollamaParams.ts) into the /api/chat `options` envelope
  // (keep_alive lifts to the body root). Only honored on Ollama tabs; every
  // other provider ignores it. num_ctx is trusted-only (clamped against the
  // model's probed Modelfile window). The blob is byte-stable across a
  // workflow's turns unless the operator edits it — Ollama's prefix cache
  // keys on request byte-stability, so a mid-workflow change is an explicit
  // cache-invalidation event (logged, same as an effort switch).
  ollamaParams?: Record<string, unknown>;
  // docs/PROVIDERS.md / Excellence LE-4 - Ollama structured-output
  // request. When set, the Ollama provider sends it as the top-level `format`
  // field on /api/chat (sibling of messages/options/tools), constraining
  // decoding at the sampler level to either free-form JSON ("json") or a raw
  // JSON-Schema object. Set ONLY by primitives that ask an Ollama model to
  // PRODUCE structured/parseable output (e.g. the Review verdict — see
  // reviewSchema.ts); never by normal chat turns, so the prefix cache and
  // every non-structured turn are unaffected. Every other provider ignores it
  // (no equivalent sampler-constrained field). Mutually exclusive with tools
  // on the wire (Ollama can't tool-call AND grammar-constrain the same turn),
  // so the provider only honors it on a tool-free turn — see ollama.ts.
  ollamaFormat?: 'json' | Record<string, unknown>;
}

// -- docs/ARCHITECTURE.md - project-local session index --
//
// `<cwd>/.arco/session-index.json` is a per-project PROJECTION of that
// project's resumable sessions — one entry per (provider, sessionId) the
// project has run. It exists so the resume surface (§H3) can render rich rows
// (title / subtitle / last-active / outcome) WITHOUT re-scanning every
// meta.json + provider JSONL on each open. Like Recall's recall.db it is a
// rebuildable projection, never a source of truth: deleting it costs nothing
// (it's rebuilt from meta.json on the next turn / discovery). Distinct from the
// machine-global recall.db (which is cross-cwd + SQLite-backed); this is a
// single small JSON file scoped to one cwd, cheap to read in the UI.
//
// ACCEPTANCE INVARIANT (§H1): building / updating the index NEVER mutates a
// provider's own session files (~/.claude, ~/.codex, …). It only reads them
// and only writes <cwd>/.arco/session-index.json.
export interface SessionIndexEntry {
  // Which provider CLI/transport owns the resumable session.
  provider: ProviderName;
  // The native provider session id, or — for Arco-internal continuity
  // (Claude Native replay / Antigravity / Ollama, which have no native
  // resume token) — the Arco workflow id. The (provider, sessionId) pair
  // is the index key.
  sessionId: string;
  // The Arco workflow that owns this session, when one claims it. Absent for
  // a native session discovered on disk with no Arco meta.json.
  workflowId?: string;
  // Absolute cwd the session ran under (constant within one project file, but
  // carried per-entry so entries stay self-describing if ever aggregated).
  cwd: string;
  startedAt: number;
  lastActiveAt: number;
  // Never blank. H1 resolves it deterministically (first operator message →
  // `<provider> · <project> · <date>`). H2 layers AI/model titles on top and
  // populates `subtitle`.
  title: string;
  // H2 — which layer produced the current `title`. Drives the refresh
  // precedence: a derived (deterministic/dynamic) upsert may only overwrite a
  // title whose source ranks at or below it, so a `model`-generated or
  // `operator`-renamed title survives an opportunistic refresh. Absent on
  // legacy (H1) entries → treated as `deterministic` (lowest rank).
  //   deterministic — first meaningful operator ask / Arco workflow name / label
  //   dynamic       — fell back to a non-trivial later message
  //   model         — H2 background 5–8 word generated title (gated/opt-in)
  //   operator      — H3 manual rename (always wins)
  titleSource?: 'deterministic' | 'dynamic' | 'model' | 'operator';
  // H2 — when a `model` title was generated/cached (epoch ms). Undefined for
  // non-model titles.
  titleGeneratedAt?: number;
  // H2 — one-line "where this left off". Two sources, summary wins: a generated
  // Recall summary's first line (`subtitleSource = 'summary'`, sticky), else the
  // last non-trivial operator message (`'dynamic'`, refreshed each upsert).
  subtitle?: string;
  subtitleSource?: 'summary' | 'dynamic';
  // H2/H3 — short status of how the last turn ended; the open question the
  // agent is waiting on, if any. Undefined in H1.
  lastOutcome?: string;
  currentQuestion?: string;
  // H3 — operator tags (preserved across opportunistic upserts — a derived
  // refresh never clobbers them).
  tags?: string[];
  // H3 — operator pin: pinned entries sort to the top of the resume picker.
  // Preserved across derived upserts (a refresh never clears it).
  pinned?: boolean;
  // H3 — operator archive/hide: archived entries are filtered out of the
  // picker unless "show archived" is on. Preserved across derived upserts.
  archived?: boolean;
  // H3 — live-workflow telemetry surfaced in the picker (context use, quota
  // label). Undefined for inactive/disk-only entries.
  contextPercent?: number;
  quotaLabel?: string;
  // Cheap material-change marker (H1: the workflow's last event seq as a
  // string). H2's title generator compares it to decide whether a cached title
  // is stale and worth regenerating.
  sourceHash?: string;
  // Highest event seq seen for the owning workflow (mirrors meta.lastEventSeq).
  lastSeq?: number;
}

export interface SessionIndex {
  // Bump when the on-disk shape changes in a way readers must know about.
  version: number;
  updatedAt: number;
  entries: SessionIndexEntry[];
}

// H2 — append-only audit line for a session-title change, written to
// <cwd>/.arco/title-events.jsonl. Satisfies the §H2 "record title-generation
// events" requirement (CLAUDE.md four-question fence #3 — visible on disk for
// review) without minting a new per-workflow events.jsonl ServerMessage type.
// Currently emitted only when a `model` title is applied (the generation event);
// the deterministic/dynamic refresh path is silent (it carries no new
// information beyond what meta.json already records).
export interface SessionTitleEvent {
  ts: number;
  workflowId: string;
  provider: ProviderName;
  sessionId: string;
  // The title before/after this change ('' when there was no prior title).
  from: string;
  to: string;
  // The layer that produced `to`. H2 logs 'model'; H3 logs 'operator' renames.
  source: NonNullable<SessionIndexEntry['titleSource']>;
  // The entry's material-change marker at generation time (the cache key).
  sourceHash?: string;
}

// H3 — HTTP shapes for the resume-picker surface.
//   GET  /api/session-index?path=<cwd>            → SessionIndexResponse
//   POST /api/session-index/{rename,pin,archive}  → SessionIndexEntryResponse
// A mutation is selected by the (provider, sessionId) entry key.
export interface SessionIndexResponse {
  entries: SessionIndexEntry[];
}
export interface SessionIndexEntryResponse {
  // The updated entry, or null when no entry matched the selector.
  entry: SessionIndexEntry | null;
}

// Server-authoritative open-tab set (server/src/workspace.ts). Every browser
// connected to one server reconciles its tab strip to this; active tab stays
// per-browser. Incognito tabs are never included.
export interface WorkspaceWorkflowEntry {
  workflowId: string;
  config: WorkflowConfig;
  parentWorkflowId?: string;
}

export interface WorkspaceSnapshotPayload {
  workflows: WorkspaceWorkflowEntry[];
  clusters: Array<{ clusterId: string; memberIds: string[] }>;
}
