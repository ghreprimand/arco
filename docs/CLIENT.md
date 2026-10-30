# Arco - client

**Status:** Stable project identity, organization, creation and removal, and missing-path or relocation recovery remain in progress. See [Development status](DEVELOPMENT_STATUS.md).

The web UI. Vite + React 19 + Zustand. Two-column layout: chat + composer on the left (2/3), tabbed right pane (1/3). Talks to the server over a single persistent WebSocket; HTTP only for file uploads, transcripts, artifact bodies, plan bodies, and auth.

This doc covers the store, components, render pipeline, theme + shader system, and performance patterns. For the WebSocket protocol see [`PROTOCOL.md`](PROTOCOL.md). For the server side see [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Boot sequence

`client/src/main.tsx` is tiny:

1. **`bootstrapCachedTheme`** - synchronous. Reads the cached `themeId` from localStorage and applies CSS vars to `:root` before React mounts. This avoids the 100-500 ms flash of default `matrix` colors that was happening when theme apply ran post-mount.
2. **Terminal pop-out branch** - there is no router. `main.tsx` reads `?popoutTerminal=<sessionId>` from `window.location.search`; if present it renders a standalone `<TerminalPopout/>` (no app stores, no `/ws`) **instead of** `<App/>`. The bootstrap above still runs first, so the pop-out inherits the operator's theme. See [`TERMINAL.md`](TERMINAL.md).
3. **ARCHIVE explorer branch** - `main.tsx` also reads `?app=explorer`; when set it renders the standalone chromeless `<ExplorerApp/>` (the read-only project-artifact window) instead of `<App/>`, parallel to the terminal pop-out. Theme bootstrap still runs first so the window inherits the operator's theme.
4. **`createRoot(...).render(<App />)`** - mount the app (or the pop-out / explorer, per the branches above). The two standalone entries mount no workflow store; when the Phosphor family is active with effects on they share only a lazy `PhosphorBackdrop`.

`App.tsx` then:

1. **Tab singleton gate** - `useTabSingleton` uses BroadcastChannel to detect a duplicate Arco tab. If another tab is already alive, this one shows `DuplicateTabOverlay` and returns. (Why: two tabs with the same persisted jobs would both rehydrate the same workflows on connect, fighting over observer state and confusing the WS handler.)
2. **`useWebSocket`** - opens the persistent WS, returns the outbound action helpers plus `{ reconnect, reconnectState }`.
3. **Auth poll** - `GET /api/auth-status` on mount, then every 2 minutes **only while Claude is logged in**; a `loggedIn:false` pauses the loop until `HeaderAuthChip`'s re-login flow flips it back.
4. **Fetches keyed on `connected`** - `/api/settings` and `/api/capabilities` re-run on every WS reconnect (the page may load while the server is still starting; re-keying avoids a manual refresh after each restart). Pollers: `/api/usage`, `/api/codex-usage`, `/api/cursor-usage` (`USAGE_POLL_MS` = 3 min); `/api/claude-native/catalog`, `/api/codex/catalog` (+ `?account=` per Codex profile), `/api/cursor/catalog` (30 min); `/api/ollama-live` + `/api/llamacpp-live` (15 s, only while enabled + reachable). `/api/toolbox` is workflow-specific and fetched lazily when that workflow's `/SKILLS` menu opens.
5. **Gates, in order** - `ShutdownOverlay` replaces the tree on `shutdown`; `AuthOverlay` replaces it when no primary-capable provider (Claude / Codex) is both enabled and authed (Settings + Manual stay mountable above it).
6. **Main-view routing** - `showGithub` -> `GitHubPanel`; `activeClusterId` -> `ClusterTab`; `showCreator || !activeJob` -> `WorkflowCreator`; `activeJob.config.kind === 'chat'` -> `ChatModeView`; else `WorkflowView`. The routed view sits inside an `ErrorBoundary` keyed on the active id so one tab's render crash doesn't blank the shell.
7. **SYNCING overlay** - fires when the WS is up but persisted jobs haven't received their `workflow_state_snapshot` yet. Cleared per-job on snapshot arrival. Fresh workflows skip this entirely (set `snapshotReceived: true` at create time).

---

## State management (Zustand)

`client/src/stores/appStore.ts` - the central per-tab store (state shape + action creators). A file-size refactor split the pure helpers out (move-only, no behavior change): the `AppState` / `JobState` types live in **`appStore.types.ts`**, pure read selectors in **`selectors.ts`**, and the memory-cap constants + capping helpers in **`memoryTrim.ts`** (which must not import `appStore`).

**Voice transcript follow.** `chatFollowStore` holds one memory-only targeted
request. Computer selection/back and a successful voice send/nudge to the
selected worker re-pin `ChatPanel` in a layout effect, including when React
reuses the panel. The existing resize/streaming paths then follow normally.
Manual scroll-up detaches again; unrelated recipients and failed sends do not
move the pane. This is UI intent, never worker/background activity.

**Standalone feature stores.** Several global, cross-workflow or transient-wizard surfaces keep their state OUT of `appStore` (so they don't touch the load-bearing per-tab store and can mount independent of props) - each a small dedicated Zustand store: `draftStore` (per-workflow composer drafts - a **performance boundary**: a draft in `appStore` paid the whole subscriber fan-out on every keystroke, 37.2 ms vs 4.2 ms median; `appStore.setDraft` / `clearDraft` remain as delegating wrappers), `terminalStore` (operator PTY windows/sessions), `recallStore` (cross-session search), `cookbookStore` (local-model catalog modal), `compareStore` (Compare primitive), `docEditStore` (A7 AI-edit proposals), `knowledgeDistillStore` (distill-from-session wizard draft), `notificationStore` (notice history + mutes + unread marker), `sessionIndexStore` (resume-index rows + pin/rename/archive mutations), `hubLinkStore` (management-hub link status in the header), `orchestrationAssistStore` (per-cluster orchestration proposals - see below), `clusterSnapshotsStore` (operator-saved whole-cluster snapshots - config + members + conversation histories, over the `cluster_snapshot_*` WS messages), `liveChangesStore` (live working-tree change subscription via `live_changes_subscribe` / `_unsubscribe`, backing the FILES **LIVE** sub-tab (`LiveChangesPanel`)), and `mdTuneupStore` (agent-instruction-file tune-up proposals backing the composer ✎ TUNEUP / `MdTuneupDialog` surface - agent drafts `md_tuneup_proposed`, operator approves the diff). Each is described inline where its UI is covered.

### Two tiers

**Global singletons:**

- `connected: boolean`, `sessionId: string | null` - WS state
- `connectionState: 'connecting' | 'online' | 'disconnected' | 'server-down'`  - observable connection state (`runtime/runtimeState.ts`); a closed socket probes `/healthz` to split a WS-layer drop from a dead server. Not persisted.
- `authStatus: AuthStatusByProvider | null` - per-provider auth snapshot
- `capabilities: Capabilities | null` - CLI versions, supported efforts, models
- `quotaState: QuotaSnapshot | null` - per-provider throttle snapshot
- `cliChanges: CliChangeEntry[]` - recent CLI version changes (drives the CONFIG red dot)
- `usage: UsageInfo | null` - Claude 5-hour / weekly usage
- `codexUsage: CodexUsageInfo | null` - Codex billing snapshot
- `cursorUsage: CursorUsageInfo | null` - dashboard-polled Cursor MTD usage (ACP exposes no per-turn tokens)
- `ollamaLive: OllamaLiveStatus | null` / `llamacppLive: LlamacppLiveStatus | null` - live daemon snapshots; null while polling is disabled or the daemon is down
- `claudeNativeCatalog: ClaudeCatalogSnapshot | null` / `codexCatalog: CodexCatalogSnapshot | null` - server-fetched model catalogs (Anthropic / OpenAI), 1-hour lazy cache; pickers fall back to the static `CLAUDE_MODELS` / `CODEX_MODELS` lists when null · `cursorCatalog: CursorCatalogSnapshot | null` - Cursor's ~153-model roster (30-min poll)
- `codexCatalogByAccount: Record<profileId, CodexCatalogSnapshot>` - per-Codex-account catalogs (HOME/WORK entitlements differ; read via `useCodexCatalog(accountRef)`)
- `settings: ArcoSettings | null` - operator preferences (theme, default provider, font-pack override, tab order, etc.)
- `shutdown: boolean` + `shutdownReason: string | null` - server is shutting down/restarting
- `activeJobId: string | null` - currently focused workflow tab
- `activeClusterId: string | null` - currently focused cluster tab. Mutually exclusive with `activeJobId` - setting one clears the other so the App.tsx routing branch picks deterministically.
- `jobs: Record<string, JobState>` - per-workflow state (the workhorse)
- `clusters: Record<string, ClusterStatePayload>` - server-authoritative cluster mirror, persisted alongside `jobs`
- `clusterFocusedMember: Record<clusterId, workflowId>` - operator's currently-focused member inside each cluster tab (local UI state, not persisted)
- `clusterGridSplit: number` - fraction of `ClusterTab` body width given to the `MemberCard` grid (left); detail `MemberPane` gets the remainder. Default `0.35`; persisted.
- `attachments: Record<workflowId, DraftAttachment[]>` - staged composer files, lifted to the store so tab-switch remounts don't drop them (blob-URL revocation lives in the actions). Drafts live in `draftStore`. Neither is persisted.
- `clusterMemberLabels`, `clusterCardLayout` (persisted), `handoffLocksByCwd` (`handoff_lock_snapshot` mirror) - cluster/handoff UI mirrors
- `bakeoffsByWorkflow: Record<workflowId, BakeoffState[]>` - server-rehydrated bake-off projection
- `taskLedger: Record<cwd|cwd::boardKey, LedgerTask[]>` - LEDGER / BOARD mirror of `task_ledger_snapshot`
- `mcpRegistry` / `mcpProbeResults` / `mcpAllow` / `mcpMalwareWarning` - CONFIG `McpRegistrySection` state
- `artifactQueue: ArtifactItem[]` - pending `primary_artifact` items for `ArtifactModal`
- `showSettings`, `showGithub`, `showManual`, `showCreator`, `showRecall: boolean` - modal/view open flags. (The Cookbook, Compare, Media studio, and doc-edit surfaces keep their open flags in their own dedicated stores, not here - see the standalone-store list below.)
- `focusMode: boolean` - I3 focus mode active; collapses the header + unmounts the right panel. Persisted to `arco.focusMode`.
- `mediaStudio: { open; path?; mode?: 'image'|'audio'|'video'; edit?; context?: { cwd, workflowId } }` - Media studio modal open-state (set by `setMediaStudio` / the `media/launchers.ts` helpers).
- `helpMode: boolean` - contextual help mode active. Body class `help-mode` is mirrored from this in `useHelpMode`.
- `activeHelpCard: { section, title } | null` - the floating `HelpCard` a tool modal's `ModalHelpButton` raises (scoped manual snippets above the modal)
- `activeHelpPopover: { key, anchorRect } | null` - the popover surfaced when the operator clicked a `[data-help]` element; key looks up `HELP_CONTENT[key]` (in `help/helpContent.tsx`); `anchorRect` is captured at click time so the popover doesn't drift if the underlying element re-renders.
- `activeDocRef: { path } | null` - file currently shown in `DocViewer`. Repo-relative; loaded via `GET /api/docs?file=<path>`. Replace-in-place: clicking a different `DocRef` while one is open just updates this field rather than stacking modals.
- `notifications: Array<{ id, level, message, createdAt }>` - transient toasts driven by `NotificationToasts`; auto-dismiss 6s after `createdAt`. Fed by the WS `error` handler so cluster-action rejections (Native fence etc.) surface regardless of which tab is focused.
- `detailWorker: { jobId, workerId } | null` - worker the operator clicked to inspect (opens `WorkerDetailModal`).
- `flashTarget: { jobId, messageId, at } | null` - HISTORY -> ChatPanel scroll-and-flash signal; `at` bumps each selection so the same row can re-fire the effect.
- `wsSendRaw: ((msg) => void) | null` - raw WS sender registered by `useWebSocket` on mount, so self-contained chat-row components (`AskUserQuestionNotice`, `HistoryTab` operator actions) can dispatch without threading callbacks through the prop tree.

**Per-workflow `JobState`** - keyed by `workflowId`. The big one:

```ts
interface JobState {
  // Identity
  id: string;
  currentSessionId: string;          // rotates on Handoff
  config: WorkflowConfig;
  resumedVia?: 'native' | 'bootstrapped';
  claudeSessionId?: string;          // Native Claude session UUID (for `claude --resume`)
  sessionMetadata?: WorkflowSessionMetadata;

  // Chat
  messages: ChatMessage[];           // optimistic adds + streaming + system notices + peer rows
  sessionChat: ChatMessage[]; // Claude JSONL entries - not persisted, rebuilt on reconnect
  hasEarlierSessionHistory?: boolean;
  earlierSource?: 'ws' | 'transcript';
  earlierTranscriptCursor?: number;
  transcriptFetch?: { sessionId: string; provider: 'claude' | 'codex'; cwd: string };

  // Turn state
  busy?: boolean;                    // server-authoritative
  turnStartedAt?: number;
  lastTurnEndedAt?: number;          // drives prompt-cache warmth countdown
  lastPrimaryEventAt?: number;       // - last primary event; drives the stalled/recovered runtime state
  recoveredAt?: number;              // replay-recovered window marker (cleared by clearRecovered)
  lastTurnTokens?: TokenUsage;
  lastGenSpeed?: GenerationSpeed;    // Ollama / Strata - runtime-measured decode/prefill; shared Agent and Chat tok/s readout
  totalTokens: TokenUsage;
  totalCost: number;

  //  signals
  turnTokenUsage?: PrimaryTurnTokenUsageMessage[];   // Sliding token-usage window, capped at TURN_TOKEN_USAGE_CAP=200
  toolCallsSinceHandoff?: number; // audit counter, client-recounted
  toolCallsSinceCompact?: number;                    // Native worker-authoritative mirror; preferred over local recount
  sandboxChunkCount?: number;                        // Best-effort mirror of per-workflow SQLite chunk count (Native only)
  toolFiltered?: Record<toolUseId, { filterName; originalBytes; filteredBytes; rawArtifactPath? }>;
  modelContextWindow?: number;                       // provider-reported window (Codex populates; CTX-bar denominator uses this)

  // Workers
  workers: Record<string, WorkerState>;
  totalWorkers: number;              // monotonic counter

  // Reviews / Research / Handoffs
  reviews: ReviewEntry[];
  research: ResearchEntry[];         // Deep Research runs (RESEARCH tab)
  handoffs: HandoffEntry[];          // mode: original-worker | fresh-summarizer | fresh-agent

  // Replay machinery
  lastSeq?: number;
  snapshotReceived?: boolean;

  // Task children. Map keyed by taskId; populated from
  // task_started / task_status broadcast on the parent workflow. Survives
  // refresh-after-settle because lifecycle events are re-broadcast on
  // rehydrate regardless of clientLastSeq, and the recordTaskStarted/Status
  // actions are idempotent.
  taskChildren?: Record<string, TaskChildEntry>;
  parentWorkflowId?: string;         // set when this workflow was minted by a Task tool call; gates TabBar filter
  promoted?: boolean;                // client-only flag: a parented child surfaced into the top tab strip

  // HISTORY tab event entries. Capped at 1000 in memory; last 500 persisted.
  historyEvents?: HistoryEventEntry[];

  // Live Preview tab state
  preview?: { port: number; framework?: string; manual: boolean } | null;
  previewUnread?: boolean;
  previewHistory?: PreviewHistoryEntry[];   // most-recent first, capped at 5
  previewCapturing?: boolean;               // preview_capture in flight
  previewCaptures?: PreviewCaptureRecord[]; // completed screenshot/report captures

  // C3 LSP diagnostics on write, keyed by file
  diagnosticsByFile?: Record<string, DiagnosticItem[]>;

  // Genesis (the Creative-mode integration) - seed + readiness + assist + scaffold result + Creative-mode arm
  genesisSeed?: GenesisSeed; genesisReadiness?: GenesisReadiness; genesisNextPrompt?: string;
  genesisAssist?: { ... }; genesisScaffold?: { cwd; written; planId?; repoUrl?; ... };
  genesisCreativeArmed?: boolean; genesisCodebase?: GenesisCodebaseInfo;

  // Activity
  activity: ActivityEntry[];         // capped at MAX_ACTIVITY_ENTRIES = 500
  primaryBackgroundJobs?: PrimaryBackgroundJob[];
  contextUsage?: ContextUsageState; // byte-count context fill estimate (context-robustness)

  // Composer queue
  queue?: { steering: Array<{ content; clientMessageId? }>; followUp: Array<{ content; clientMessageId? }> };

  // Plan attached to this workflow, if any. Populated from `plan_attached`,
  // cleared by `plan_detached`. Body is fetched lazily via `/api/plans/body`.
  plan?: { id: string; title: string; updatedAt: number } | null;

  // PLAN composer button flow. `pendingPlanCapture` is set when the operator
  // clicks Draft -> I'll review or Draft & auto-save in the modal; the next
  // primary_complete grabs the assistant's reply and stashes it in
  // `planCandidate`. Banner above the composer either offers SAVE & ATTACH /
  // DISCARD (review mode) or self-fires the save (autosave mode).
  pendingPlanCapture?: 'review' | 'autosave' | null;
  planCandidate?: { body: string; mode: 'review' | 'autosave'; capturedAt: number } | null;

  // Cancel state
  lastTurnCancelledAt?: number;

  // Resolved model badge
  resolvedPrimaryModel?: string;

  // Ultracode fleet - live background-subagent telemetry for a sticky-ultracode
  // turn. Transient (fed by `ultracode_fleet_progress`, snapshot-replaced, not
  // persisted); drives the ACTIVITY FLEET section + composer pill.
  ultracodeFleet?: UltracodeFleetSnapshot | null;

  // tool posture - session-local mirror of the Native worker's
  // WorkflowState.toolPosture (full/coding/review/chat). Set by `tool_posture_set`,
  // not persisted; reverts to 'full' on reload. Drives the composer posture pill.
  toolPosture?: ToolPosture;

  // DD7 project-trust - set by `project_trust_prompt` when an untrusted repo's
  // AGENTS.md / skills / settings were suppressed; cleared by `project_trust_set`.
  // Drives the composer UNTRUSTED PROJECT banner.
  projectTrustPrompt?: { cwd: string; resources: string[] };

  // Fold / COMPACT - in-flight lock + last summary; drives the composer ⊟ COMPACTED banner.
  compacting?: boolean;
  compactingFoldedTurns?: number;
  compactedResume?: { foldedTurns?: number; at: number } | null;

  // DEBAG operator's standing "approve all like this" review-gate
  // approvals; pushed via `gate_standing`, rendered+revocable in ConfigTab.
  standingGateApprovals?: GateStandingApprovalView[];
}
```

Per-tab composer state used to live on `JobState`; attachments were lifted into a top-level `Record<workflowId, ...>` map on `AppState` (narrower selector), and drafts further out into `draftStore` (keystroke fan-out). Semantics are unchanged.

### Action shape

Actions are split into thematic groups inside `appStore.ts`:

- Connection: `setConnected`, `setConnectionState`, `bumpPrimaryEvent` / `clearRecovered`, `setShutdown`, `setAuthStatus`, `setCapabilities`, `setUsage` / `setCodexUsage`, `setOllamaLive` / `setLlamacppLive`, `setClaudeNativeCatalog` / `setCodexCatalog` / `setCursorCatalog` / `setCodexCatalogForAccount`, `setCursorUsage`, `setSettings`, `setQuotaState`, `setCliChanges`, `acknowledgeCliChange`
- Workflow lifecycle: `createJob`, `removeJob`, `setActiveJob`, `showJobCreator`, `applyWorkflowSnapshot`, `changeWorkflowSession`, `updateJobPrimary` (provider / model / effort / autoHandoff / claudeTransport / codexTransport / efficiency flags / outputStyle / goal / pinnedSkills / ultracode / webSearchMaxUses / claudeNativeThinkingDisplay), `setWorkflowName`, `setWorkflowGoal` (on `goal_set` -> syncs the north-star + a GOAL activity row), `setGoalRun`, `setCodebaseMemoryState`, `setSessionMetadata`, genesis (`setGenesisSeed` / `setWorkflowCwd` / `setGenesisScaffold` / `setGenesisAssist*` / `clearGenesisAssist` / `setGenesisCreative`)
- Cluster lifecycle: `setClusterState`, `clearCluster`, `setActiveCluster`, `setClusterFocusedMember`, `setClusterGridSplit`, `setClusterCardLayout`, `setHandoffLocks`
- Bake-offs / ledger / MCP: `setBakeoffs` / `upsertBakeoff`, `setTaskLedger`, `setMcpRegistry` / `setMcpProbeResult` / `setMcpAllow` / `setMcpMalwareWarning`
- Chat: `addMessage`, `removeMessage`, `updateMessage`, `prependMessages`, `appendToStreamingMessage`, `finalizeMessage`, `upsertSessionChat`, `setEarlierState`
- Turn state: `beginPrimaryTurn`, `endPrimaryTurn`, `recordTurnCancelled`, `addCost`, `addTokens`, `setLastTurnTokens`, `setLastGenSpeed`, `appendTurnTokenUsage`, `clearTurnUsageState`, `setContextUsage`, `setModelContextWindow`, `setPrimaryModel`, `setClaudeSessionId`, `beginCompacting` / `endCompacting` / `clearCompacting`, `setDiagnostics`
- EFFICIENCY signals: `bumpToolCallsSinceHandoff` / `resetToolCallsSinceHandoff`, `setToolCallsSinceCompact`, `bumpSandboxChunkCount` / `resetSandboxChunkCount` / `setSandboxChunkCount`, `recordToolFiltered`
- Workers: `spawnWorker`, `appendWorkerOutput`, `appendWorkerThinking`, `recordWorkerToolCall`, `setWorkerActivity`, `completeWorker`, `failWorker`, `setWorkerModel`, `setDetailWorker`
- Reviews / Research / Handoffs: `upsertReview`, `upsertResearch`, `upsertHandoff`
- Activity: `appendActivity`, `clearActivity`, `setPrimaryBackgroundJobs`, `setUltracodeFleet`
- Task children: `recordTaskStarted`, `recordTaskStatus`, `promoteTaskChild` (idempotent - safe under rehydrate replay)
- History: `appendHistoryEvent`, `flashChatMessage`
- Preview: `setPreview`, `setPreviewHistory`, `markPreviewSeen`, `setPreviewCapturing` / `addPreviewCapture`
- Plan: `setPlan` (clears with `null`), `setPendingPlanCapture`, `setPlanCandidate`
- Replay: `updateLastSeq`, `markSnapshotReceived`
- Composer: `setDraft`, `clearDraft`, `addAttachment`, `removeAttachment`, `clearAttachments`
- Toolbox / artifacts: `setToolbox`, `enqueueArtifact`, `dequeueArtifact`
- Theme / display: `setThemeId` (optimistic; reverts on `/api/settings` failure), `setFontPackOverride`, `setFrostedOverride` / `setFrostedOpacity`, `setBgBrightness` / `setTextBrightness` (+ `preview*` live-drag variants), `setCrispText`, `setPhosphorPreference`, `setTabOrder`
- Notifications + raw send: `pushNotification`, `dismissNotification`, `setWsSendRaw`
- Help / views: `setHelpMode`, `setActiveHelpPopover`, `setActiveHelpCard`, `setActiveDocRef`, `setShowSettings` / `setShowGithub` / `setShowManual` / `setShowRecall`, `setFocusMode`, `setMediaStudio`
- Memory: `trimMemory` (also fired every 30 s by a module-level timer), `getRetentionStats`
- DEBAG gate / posture / trust: `resolveGate` (flips a parked gate's status in-place on `gate_resolved`), `setStandingGateApprovals` (on `gate_standing`), `setToolPosture` (on `tool_posture_set`), `setProjectTrustPrompt` (on `project_trust_prompt` / cleared by `project_trust_set`)

### Persistence (localStorage)

The store uses Zustand's `persist` middleware over `debouncedJSONStorage` (`stores/persistence.ts`): it holds the partialized state *object* and stringifies exactly once at flush (1 Hz max, `PERSIST_DEBOUNCE_MS`), plus a synchronous flush on `visibilitychange->hidden` / `pagehide`. Why: the stock `createJSONStorage` stringified the whole multi-MB `jobs` slice on **every** `set`; a cluster-snapshot restore compounded that into a minutes-long freeze that let the server's zombie-socket heartbeat kill the client mid-replay (2026-06-12).

**Persisted via the Zustand `partialize`:**
- `jobs` - **incognito jobs filtered out entirely**; the rest slimmed per-tab: identity, config, last 200 messages, totals, `lastSeq`, last 40 reviews / research / handoffs, `taskChildren`, `parentWorkflowId`, `promoted`, last 500 `historyEvents`. Workers are stripped entirely (server resends on rehydrate; the 2026-04-16 5 MB-per-worker incident is the precedent).
- `activeJobId` (nulled when it points at an incognito job), `activeClusterId`
- `clusters` - restores the cluster tab's `[N]` badge before WS reconnect; overwritten by the authoritative `cluster_state` push on subscribe.
- `clusterGridSplit`, `clusterCardLayout`
- `showCreator` (forced true when the active tab is incognito, so a reload lands on the creator)

**Persisted directly to localStorage (outside the Zustand store):**
- `themeId` (cached for the synchronous pre-mount bootstrap) and `arco_font_pack_override`
- `arco.sidePanelTab.byWorkflow` - per-workflow active right tab
- `arco.preview.aspect` - preview pane aspect ratio (global)
- `arco.gitDialog.prefs.${cwd}` - per-repo GIT dialog choices
- `arco.historyFilter.byWorkflow` - HISTORY tab filter strip
- `arco.clusterRightPanelWidth` - outer cluster right-panel splitter
- `arco.focusMode` - I3 focus-mode flag (`'1'`/`'0'`); read into the store's `focusMode` at init, written by `setFocusMode`
- splitter widths (per-workflow + cluster) via `usePersistedSplitter`

**NOT persisted** (rebuilt on reconnect):
- `sessionChat` - server is the source of truth via `session_entry` stream
- `workers` (always empty on restore - server resends)
- `connected`, `sessionId` - WS state
- `connectionState`, `quotaState`, `capabilities`, `authStatus`, usage snapshots, `cliChanges`, model catalogs, `ollamaLive`, `llamacppLive`, `taskLedger`, `mcp*`, `bakeoffsByWorkflow` - fetched or re-pushed on connect
- `snapshotReceived`, `busy`, `turnStartedAt`, `lastTurnEndedAt`, `activity`, `primaryBackgroundJobs`, `turnTokenUsage` - reset on connect; the authoritative snapshot arrives within seconds
- `attachments`, `notifications`, `flashTarget`, `wsSendRaw`, `clusterFocusedMember`, `detailWorker` - session-only UI state

On rehydrate, `onRehydrateStorage` also strips persisted streaming flags, drops queued optimistic entries older than 30 s, and dedupes any `peer-sent-<msgId>` / `peer-recv-<msgId>` rows that earlier builds (pre-intake-dedup) accidentally duplicated.

**Hard caps** to prevent memory regressions:
- `MAX_CHAT_MESSAGES = 500` per job
- `MAX_WORKER_OUTPUT_BYTES_CLIENT = 256 KB` per worker
- `MAX_ACTIVITY_ENTRIES = 500` per job (raised from 80 - tool-heavy turns were truncating the live feed before settle)

These caps prevent a large worker response from exhausting browser memory. The server-side `MAX_WORKER_OUTPUT_BYTES = 5 MB` cap bounds output before it reaches the client.

**Store-as-cache model + the MemoryHud ( A1).** The store is a *bounded cache over the server's `events.jsonl`*, not the source of truth: every hot array is capped on its append path (`capMessages`/`capActivityEntry`/`capWorkers`/`trimJobMemory` in `memoryTrim.ts`), `removeJob` drops the whole `JobState` and revokes attachment blob URLs on tab close, and the persist `partialize` strips workers entirely (server re-pushes on reconnect). Because all of that was already in place, an A1 audit of every component interval/observer/listener and the `useWebSocket` reconnect path found **no leak** - so the residual "memory runs away after a while" can only be diagnosed live. `getRetentionStats` (store helper) returns the live footprint - per-tab `messages/sessionChat/activity/historyEvents/workers/toolFiltered/turnTokenUsage` counts, total attachment blob-URL count, and (Chrome only) JS heap. The dev-only `MemoryHud` (`components/dev/MemoryHud.tsx`, enable with `?memhud=1` or `localStorage['arco:memhud']='1'`) polls it every 2 s. Reading the result: **heap climbs while counts stay flat ⇒ non-store leak** (detached DOM, highlight cache, blob URLs, an iframe/webview); **a per-tab count climbs unbounded ⇒ a cap isn't firing on some append path.** Invariants guarded by `client/src/stores/retentionStats.test.ts` (`npm run smoke:mem-retention`).

---

## WebSocket hook

`client/src/hooks/useWebSocket.ts` - ~1500 lines (connection lifecycle + the outbound action helpers); the inbound dispatch lives in `client/src/ws/handleServerMessage.ts` (~2200 lines).

### Connection lifecycle

- **Open URL** - derived from `window.location` (`ws://` or `wss://` matching protocol). Single endpoint at `/ws`.
- **Backoff** - exponential, 500 ms -> 2 s cap on the next attempt. Resets to 500 on successful open.
- **Teardown** - on component unmount, set `teardownRef.current = true`, clear timers, detach handlers, close the socket. Detaching handlers prevents a trailing `onclose` from scheduling another reconnect after teardown (was a leak source).

### `onopen`

1. Reset backoff to initial.
2. Update reconnect state for the UI; `setConnectionState('online')`.

Rehydration is **not** sent from `onopen` - it waits for the server's `connected` message (fresh per-connection session), whose handler clears a stale `shutdown`, sends `rehydrate_workflows` listing every persisted job with its `config` + `lastSeq` (server replays missed events), and one `cluster_subscribe` per persisted cluster.

### `onmessage`

Parses JSON, advances `lastSeq` via `Math.max` (robust to out-of-order delivery during replay), then delegates to **`client/src/ws/handleServerMessage.ts`** - the per-message dispatch was extracted out of the inline `ws.onmessage` body (a sibling `ws/` module dir holds it alongside `streamState.ts`). That switch handles ~150 server message types, each routing to one or more store actions. See [`PROTOCOL.md`](PROTOCOL.md) for the full message list.

Module-level streaming state (`streamingMsgs: Map<workflowId, StreamRef>`, in `ws/streamState.ts`) tracks the in-flight streaming message ID per phase. Survives React re-renders within a tab. Pruned via Zustand subscribe when a workflow is removed from the store, and cleared on `onclose`, so long-lived sessions don't leak entries.

**Chat-tab delta batching.** For `kind:'chat'` workflows `handleServerMessage` coalesces `primary_text` deltas into one `appendToStreamingMessage` per animation frame (`queueChatDelta` / `flushChatDelta`, keyed `workflowId:phase`; flushed before finalize). Chat providers stream tiny deltas and Markdown re-layout was tracking token rate; agent tabs keep immediate per-delta semantics.

### `onclose` / `onerror`

`onclose` marks disconnected, clears `streamingMsgs`, and schedules a reconnect with current backoff; the reconnect path probes `/healthz` so `connectionState` can escalate `disconnected` -> `server-down` (RECONNECT won't help until the process is back). `onerror` only closes - `onclose` owns the retry. `reconnectState` drives UI hints ("reconnecting in 2s...").

---

## Component tree

Top-level structure rooted at `App.tsx`. The main view branches five ways (see Boot sequence): `GitHubPanel`, `ClusterTab`, `WorkflowCreator`, `ChatModeView` (`kind:'chat'`), or `WorkflowView`.

```
App
├── SystemHeader            (title, Providers popover, provider-throttling warning, auth chip, grouped action rows, UsageBar pills)
├── TabBar                  (job tabs + cluster tabs; "+" for new; two-row layout when a cluster is active)
├── GitHubPanel | ClusterTab | WorkflowCreator | ChatModeView | WorkflowView   (inside an ErrorBoundary)
│   └── WorkflowView (agent workflow tab)
│       ├── ChatPanel       (left 2/3 - virtualized chat log)
│       │   └── ChatRow (one of:)
│       │       ├── ChatMessage      (operator / assistant / system bubble)
│       │       ├── HandoffSeedPill
│       │       ├── SpawnSeedPill
│       │       ├── ToolCallPill
│       │       ├── ArtifactPill
│       │       ├── PriorSessionsSection (collapsed history)
│       │       ├── LongUserMessage (auto-collapsed wall of text)
│       │       ├── GateApprovalNotice (DEBAG inline approve/reject card for a parked sensitive Native tool call)
│       │       └── AuthReloginNotice
│       ├── NorthStarBar   (🎯 always-visible inline-editable north-star chip; click to edit, ⏎ save, GOAL_MAX_BYTES=2048)
│       ├── TerminalInput   (composer + REVIEW/HANDOFF/SPAWN/DOCS/GIT/COMPARE/RESEARCH/TUNEUP/REMOTE/COMPACT buttons + inline plan-mode checkbox + FOLD/posture/project-trust pills)
│       │   ├── PrimaryStatus   (busy: model · effort · elapsed)
│       │   ├── TokensFooter    (CTX %, OUT - provider-aware: Claude byte-count via job.contextUsage, Codex from lastTurnTokens via codexModelWindow; Ollama adds a `⚡ N tok/s` decode readout from job.lastGenSpeed)
│       │   ├── QueuedMessagesIndicator
│       │   ├── DragOverlay     (file drop hint)
│       │   ├── ToolboxMenu     (slash-command picker)
│       │   ├── PlanCandidateBanner   (renders between chat and composer when job.planCandidate is set)
│       │   ├── ReviewDialog
│       │   ├── HandoffDialog
│       │   ├── SpawnDialog
│       │   ├── DocsUpdateDialog
│       │   ├── GitDialog
│       │   ├── PlanComposerDialog
│       │   ├── PlanReviewPicker
│       │   ├── MdTuneupDialog        (✎ TUNEUP - agent-instruction-file tune-up; backed by mdTuneupStore)
│       │   ├── ResearchDialog        (RESEARCH - deep-research run)
│       │   └── TranscriptSendDialog  (cluster-member tabs only)
│       └── RightPanel      (right 1/3 - `RightPanel/index.tsx`; two-level grouped tabs: Workspace/Agent/Memory/Runtime)
│           ├── FileExplorer       (FILES tab)
│           ├── GenesisTab         (GENESIS tab - Creative-mode integration; scratch ideation workflows, any real-cwd workflow (to arm Creative mode), or once Creative is armed)
│           ├── ActivityTab        (ACTIVITY tab - inline in RightPanel)
│           ├── ReviewTab          (REVIEW tab - inline)
│           ├── ResearchTab        (RESEARCH tab - deep-research runs; expandable cited report)
│           ├── HandoffsTab        (HANDOFFS tab - inline)
│           ├── PlanTab            (PLAN tab - inline; renders the per-cwd plan + plan-scoped review surfaces)
│           ├── BakeoffTab         (BAKE-OFF tab - operator-armed worktree bake-offs)
│           ├── KnowledgeTab       (KNOWLEDGE tab - per-cwd operator-owned knowledge base; + KnowledgeWizard)
│           ├── TasksPanel (TASKS tab; gated on non-empty job.taskChildren)
│           ├── LedgerTab          (LEDGER tab - cwd-scoped durable project task ledger)
│           ├── HistoryTab (HISTORY tab; read-only timeline + LABEL / REVIEW-FROM-HERE / SPAWN-FROM-HERE)
│           ├── UsageTab           (USAGE tab - Workbench; per-provider/per-day token + cache-ratio trends, hand-rolled SVG)
│           ├── PreviewTab         (PREVIEW tab - per-workflow dev-server iframe with auto-detect + aspect toggle)
│           ├── ConfigTab          (CONFIG tab - `RightPanel/ConfigTab.tsx`: transport sections (Claude + sticky ULTRACODE / Codex + MAX/STANDARD context), auto-compaction, auto-handoff + auto-fold, Claude Native knobs (compact, auto-continue, thinking display, interleaved beta, tool filter, web budget, fact-force, config protection, review safe-mode, sandbox), OUTPUT STYLE, NORTH STAR + goal-run control, PROJECT TRUST, Ollama lifecycle/params/VRAM/compaction session, then CodebaseMemorySection + McpRegistrySection)
│           └── GitHubPanel        (GITHUB tab)
└── Modals & overlays
    ├── SettingsPanel
    │   ├── SkillEditorDialog (stacked modal at z=9300; opened from the SKILLS section)
    │   ├── HandoffPromptsEditor (HANDOFF PROMPTS section)
    │   └── LlamacppCatalogEditor (when llama.cpp is enabled)
    ├── UserManual          (full operator-facing manual; opened from the header MANUAL button)
    ├── RecallView          (Workbench; top-level cross-session search overlay; appStore.showRecall)
    ├── NotificationToasts  (top-right transient toasts; fed by appStore.notifications)
    ├── CommandPalette      (Cmd/Ctrl+P, App-local state) · ShortcutCheatSheet (Cmd/Ctrl+?)
    ├── CompareDialogHost + CompareOverlay (compareStore)
    ├── MediaModalHost      (appStore.mediaStudio.open)
    ├── MemoryHud           (dev-only, ?memhud=1)
    ├── FileViewerModal
    ├── WorkerDetailModal
    ├── ArtifactModal
    ├── ConversationMenu
    ├── TabContextMenu      (right-click on a Native Claude tab; "Add to cluster with...")
    ├── ProviderReleasesModal (in-app Ollama/Strata releases and Xolotl source history)
    ├── FloatingTerminalWindow (Workbench/; renders N operator-PTY windows, each a draggable/resizable overlay)
    ├── SyncingOverlay
    ├── AuthOverlay
    ├── ShutdownOverlay
    ├── DuplicateTabOverlay
    ├── ThemedBackgroundShader (the shader canvas)
    └── Help system (z=9300+)
        ├── HelpButton      (floating "?" toggle, bottom-right; collapsable to a small chevron)
        ├── HelpBanner      (top strip while help mode is active)
        ├── HelpPopover     (per-target help content, anchored to the clicked element)
        ├── HelpCard        (movable scoped-snippet card raised by a tool modal's ModalHelpButton)
        └── DocViewer       (file-content modal stacked above Manual; reached via DocRef chips)
```

The 2/3 - 1/3 splitter width and active right-tab key persist to localStorage independently of the Zustand store.

### Component responsibilities (highlights)

- **`ChatModeView`** - the separate `kind:'chat'` route. It renders a centered,
  wide conversation and its own composer (grows to 200 px then scrolls; send/stop;
  attachments via ＋ / paste / app-wide drop, hidden in Incognito to match the
  server's upload fence); there is no cwd, right panel, project primitive toolbar,
  north-star bar, or agent status scaffolding. The header carries a same-provider
  **model + effort picker** (applies next message, via `update_primary_config`)
  and the per-tab **web toggle** (`chatWebAccess`; default on for saved chats, off
  for Incognito; providers without a web tool show `○ NO WEB`). Rows get hover
  **COPY / EDIT / RETRY** - RETRY re-sends the last prompt as a new turn, not a
  rewind. Chat deltas are rAF-batched (see WebSocket hook). The status line
  explicitly shows SAVED versus INCOGNITO · NOT SAVED. The creator's Chat mode
  mounts `PastChatsList` (`GET /api/chats`) for one-click closed-conversation
  reopen and an Incognito checkbox. `appStore.partialize` filters incognito jobs
  entirely and does not persist their active-tab selection. The provider picker
  removes Cursor and llama.cpp while strict incognito is armed because neither
  can meet its no-local-log contract.

- **`SystemHeader`** (I1 - information architecture) - a single Row 1 with the wordmark on the left and, on the right, a **status cluster** followed by **three grouped action rows** separated by thin `GroupDivider` rules. Status cluster (urgent, always visible): `ProvidersPopover` · `WorkflowStatusChip` · `HeaderAuthChip`. Action groups: **Models** (`⌕ RECALL`, `⚙ COOKBOOK`) · **Tools** (`⌗ MEDIA`, `⌸ ARCHIVE` - calls `openArchive`, a same-browser popup falling back to `POST /api/explorer/open`, launching the standalone explorer window; `◆ GITHUB`, `>_ TERMINAL`) · **System** (`⚙ SETTINGS`, `ⓘ MANUAL`, connection LED + RECONNECT/RESTART, `⏻` power -> `SystemModal` whose Diagnostics tab is the group's third member). Every button shares the `actionBtn` style constant so the grouping reads off spacing, not per-button drift. Below Row 1 sits `UsageBar`, a uniform row of `LIVE` pills - one per authed provider plus an `OLLAMA [LIVE/READY/DOWN]` pill when ollama is enabled; hovering the Claude pill pops Session/Weekly usage bars + reset times, hovering Ollama pops the loaded-model list with VRAM-unload countdown. Stays at the top across all views. **Focus mode:** the `◳ FOCUS` toggle (always visible, between connection health and ⏻) flips `appStore.focusMode`; when armed the header collapses to wordmark + `WorkflowStatusChip` + connection health + `◳ EXIT FOCUS` + ⏻, hiding the Providers popover, auth chip, both action groups, Settings/Manual, and the UsageBar row. Also reachable from the command palette (`Enter/Exit focus mode`). Reversible + persisted (`arco.focusMode`).
  - **`ProvidersPopover`** - folds the former inline per-provider version-chip strip behind one `▼ PROVIDERS` trigger (click-outside to close, like `ConversationMenu`). The trigger carries a health dot (warning-color when any provider is outdated); the popover lists the chips. Chips are gated on `settings.enabledProviders` (disabled providers don't show) and un-installed CLIs, include an Ollama/llama.cpp row when reachable, and paint warning-color when the installed version is older than `capabilities.latestVersions.<p>`. Click on Claude/Codex runs the upstream installer via `POST /api/check-updates`; Ollama, Strata and Xolotl open `ProviderReleasesModal`; llama.cpp opens GitHub releases. Strata remains visible while stopped using the prepared engine's `BUILD.json`; update comparison uses engine package metadata, separately from the 0.2 app/Terminal release tag. Xolotl displays checkout HEAD as a single-line `XOLOTL` row. Its modal uses recent commits when upstream has no tagged releases, displays matching HEADs as UP TO DATE without a self-comparison request, and compares distinct revisions for source changes. External GitHub links are explicit; these three rows never open a browser or install an update themselves. Self-contained - owns the update-check + modal state that used to live in `SystemHeader`.
  - **`WorkflowStatusChip`** - a provider-throttling warning shown only when quota state reports a throttle. Click for affected providers and known reset times. Context usage remains beside the worker composer.
  - **`NotificationCenter`** - the header bell (`◔ BELL`) with an unread badge. Dropdown shows the workbench-notice history + a per-category MUTE grid (checkbox -> `set_notification_mutes` via `onSetNotificationMutes`, threaded App -> SystemHeader -> `useWebSocket`). Backed by the standalone `notificationStore` (notices history + server-authoritative `muted` set + `lastSeenTs` unread marker). Always visible - even in I3 focus mode - since notices are the "agent finished / something broke" signal. Incoming `workbench_notice` also raises a transient toast via the existing top-right strip (`NotificationToasts` / `appStore.pushNotification`), not a second stack. See [`NOTIFICATIONS.md`](NOTIFICATIONS.md).
- **`TabBar`** - horizontal job list with busy indicator (`activeWorkers > 0 || hasStreaming`). Click a tab -> `setActiveJob`. The "+" button shows `WorkflowCreator`.
- **`WorkflowView`** - owns the splitter and renders `ChatPanel` + `RightPanel`. Splitter width persists per-workflow. Forwards send/cancel/review/handoff/spawn callbacks to the children. **Focus mode:** when `appStore.focusMode` is true the left (chat) column goes `flex: 1 1 100%` and the splitter + `RightPanel` are unmounted, giving the chat the full width; toggling off restores the persisted split fraction. The chat column `Panel` carries `className="no-frost"` so `html[data-frosted="1"].arco-panel.no-frost { backdrop-filter: none }` (more specific than the generic frosted-blur rule) keeps the transcript crisp over the shader - matching the cluster transcript, which is never a `Panel`.
- **`NorthStarBar`** - inline-editable north-star chip above the composer (empty -> "set a north-star..."; soft-warn 1536 / cap 2048 bytes). Mirrors `job.config.goal`; edits go through `onUpdatePrimary({ goal })`.
- **`ChatPanel`** - virtualized chat log. The render-side `displayMessages` memo merges sources and dedupes (see "Chat rendering pipeline" below).
- **`ToolCallPill`** - compact tool-call row.  Tool-result filtering adds an inline `FilteredChip` ([filtered: 12.3 KB -> 1.4 KB, sample output]) when the `tool_filtered` WS event reports a non-zero byte delta for the matching `toolUseId`. Click on the chip copies the workspace-relative `rawArtifactPath` (`.arco/workflows/<wfId>/artifacts/raw-tools/<turnId>-<toolUseId>.txt.gz`) to the clipboard so the operator can `zcat` the pre-filter raw bytes - recovery preserves the cache and reversibility boundary. The connector lives in `ChatMessage.tsx` (`ToolCallPillWithFilter`) which subscribes to `appStore.jobs[jobId].toolFiltered[toolUseId]` with a narrow selector so unrelated filter events don't re-render the row.
- **`TerminalInput`** - the composer. Auto-grows up to 240 px. Auto-focus on idle / busy transition. The `b·w·s` diagnostic chip and the CANCEL button surface when `isBusy`.
- **`RightPanel`** (`components/RightPanel/index.tsx`) - **two-level grouped** tab strip + content area. The 16 tabs (files, genesis, activity, review, research, handoffs, plan, bakeoff, knowledge, tasks, ledger, history, usage, preview, config, github) are grouped by purpose into four families - **WORKSPACE** (files, genesis) · **AGENT** (activity, review, research, handoffs, plan, bakeoff, tasks) · **MEMORY** (knowledge, ledger, history, usage) · **RUNTIME** (preview, config, github) - declared in the `GROUPS` const. Level 1 is the group selector; level 2 is the active group's tabs. The **active group is derived** from the active tab (`groupOf`), so no separate group state is persisted; clicking a group lands on its first visible tab. On a **narrow split** (`< 360px`, measured by a `ResizeObserver` on the panel root) level 2 collapses to a single grouped `<select>` with one `<optgroup>` per family - every tab stays reachable without a 3-row wrap. Tab selection is **per-workflow**, persisted to `localStorage['arco.sidePanelTab.byWorkflow']` as a `Record<workflowId, RightTab>` map - switching workflows respects each workflow's last tab (and thus its group); fresh workflows default to `'files'`. The CONFIG **`cliChanges`** red dot shows on CONFIG's level-2 tab AND on the RUNTIME **group header** when CONFIG isn't the active group (in the narrow `<select>`, a `●` is appended to the CONFIG option), so the "CLI changes" signal never hides behind a collapsed group. Group help: dynamic `rightpanel.group.{workspace,agent,memory,runtime}`. Auto-switches to PREVIEW once per `freshlyBound` signal: `previewUnread` flips true on `preview_set` only when `freshlyBound: true && !manual && wasPort !== isPort`, and a `useEffect` watching `job.previewUnread` flips that workflow's tab and calls `markPreviewSeen` to clear the flag - so the auto-flip fires once per real bind, not on every hydration replay or stale port re-broadcast, and never bleeds across workflows.
- **`ConfigTab`** - model/effort and per-provider runtime controls. Transport rows are provider-specific: Claude `cli`/`native` and Codex `exec`/`appserver`. Codex also shows a per-tab MAX/STANDARD context-window row backed by the selected account's live model catalog; MAX is the default. For **Cursor**, the MODEL row renders `CursorModelSelect` (family×effort×flags -> exact catalog id) and the EFFORT row shows `(set via the model picker above)`. Additional sections: `NorthStarSection` (NORTH STAR), `ClaudeNativeThinkingDisplaySection` (THINKING VISIBILITY - omitted/summarized/updates; `updates` is Fable 5 / 5.1 progress notes, degrades to omitted elsewhere), `ClaudeNativeWebBudgetSection` (WEB LOOKUPS/TURN), and the sticky ULTRACODE ON/OFF toggle inside `ClaudeTransportSection`. `OutputStyleSection` (renamed from `ClaudeNativeOutputStyleSection` - OUTPUT STYLE now applies to Claude Native + Codex app-server + early-returning `null` on every other transport) sets `outputStyle` (`normal` / `lite` / `terse`). A REVIEW-SAFE-MODE toggle (`ClaudeNativeReviewSafeModeSection`, Native-only) flips `WorkflowConfig.reviewSafeMode` (default `off`) - when on, sensitive Native tool calls park behind the DEBAG HITL gate - and renders the operator's standing "approve all like this" approvals (`job.standingGateApprovals`) with a per-row REVOKE (`gate_revoke`). An **auto-fold** block under `AutoHandoffSection` (`data-help="rightpanel.config.auto-fold"`) sets `WorkflowConfig.autoFold` `{ enabled, foldAt, tailBudget }` through `update_primary_config` - Native-only deterministic in-place transcript trim (`foldAt` sits below the handoff `warnAt`), default OFF.
- **`PreviewTab`** - iframe rendering of the workflow's dev server, fed by the per-workflow proxy at `/api/preview/<workflowId>/`. PORT input + BIND/UNBIND/RELOAD/OPEN button row + 4:3/16:10/16:9 aspect-ratio segmented control (persists to localStorage `arco.preview.aspect` - global across workflows). A "RECENT" pill row below the controls surfaces this workflow's history of bound ports (most-recent-first, capped at 5; fed by `preview_history` WS message; persisted under `meta.previewHistory`). Click a pill to rebind: the client first hits `GET /api/preview/probe?port=N`; if alive, behaves like a manual BIND; if dead, opens a modal that lists currently-listening services on the box (via `GET /api/preview/listening`, Linux-only; macOS shows empty list with the same explanatory copy) so the operator can pick one to bind to. The listing excludes Arco's own server PID; workflow-spawned dev servers still appear. Iframe is given a fixed logical viewport - width 1920, height per chosen aspect (1440 / 1200 / 1080) - and CSS-scaled (`transform: scale(...)`, computed via `ResizeObserver` on the wrapper) to the largest box-of-that-ratio that fits the pane, then centered both axes. Width-constrained when the pane is wider than tall, height-constrained when taller, never clipped in either axis. The `useLayoutEffect` that drives the scaling depends on `[logicalH, src]` - `src` is in the deps so the effect re-fires when the wrapper div mounts on first BIND (object refs don't notify effects on attach; without that dep `boxStyle` stays null and the iframe never renders until something else remounts the component). `iframeReactKey` includes `preview.port` so a rebind to a different port forces a remount (the proxy URL doesn't encode the port). Sandbox `allow-same-origin allow-scripts allow-forms allow-popups allow-modals`; `allow-top-navigation` is intentionally omitted so a misbehaving page can't hijack the Arco shell.
- **`WorkflowCreator`** - new-tab / Resume picker. Lists Claude/Codex native sessions per cwd via `GET /api/sessions?path=<cwd>`. Claimed sessions show `★` and reuse the workflowId; unclaimed get a fresh wfid pinned to the native session UUID. The top-of-form MODE toggle switches between SINGLE (one primary agent), CLUSTER (N members), and **GENESIS** (idea -> scaffold, no folder yet - Creative-mode integration). CLUSTER mode shows the **`ClusterPresetsRow`** (saved member shapes); SINGLE mode shows the **`TemplatePickerRow`** (Workbench "recipes"). Both are PRESETS-style pill rows. GENESIS mode hides the working-directory cell + tree and shows a SPARK textarea instead; it launches a cwd-less workflow with `config.genesisSeed` set (title + spark), gated on those two fields rather than a cwd. The rest of the seed is filled in the **`GenesisTab`** (right panel, see below). **Layout (I5, banded):** the centered heading is the selected cwd's folder name (`headingText`, I4) over a `NEW WORKFLOW`/`NEW CLUSTER` subtitle; below the MODE toggle the form is three bordered band cards - **WHERE & SESSION** (dir input + name as a balanced top row; the BROWSE tree and CONVERSATION picker span both columns), **AGENT** (a symmetric 2×2 of provider | model dropdowns over effort | permissions), and **AGENT TUNING** (Claude: fast / tool-result-filter / output-style; Codex app-server: output-style only). ADVANCED OPTIONS is a standalone full-width collapsible below the bands. Band titles use `glow-text-bright` + a divider to outrank the 11px field labels; each band's inner grid is `1fr 1fr` at ≥1200px, single-column below.
  - **`TemplatePickerRow`** - the single-tab analogue of cluster presets, backed by `useTemplates` (CRUD over `GET/POST/DELETE /api/templates` -> `~/.arco/templates.json`). Pills apply a saved `WorkflowConfig` snapshot (provider/model/effort/permissions + native knobs + **optional** cwd); `+ SAVE AS TEMPLATE` POSTs the current creator config. **Apply pre-fills, never auto-sends:** cwd pre-fills only for project-pinned recipes; portable templates leave it unset; an optional `seedPrompt`/`plan` is stashed in `pendingTemplateApply` and threaded onto the new tab via a one-shot `WorkflowConfig.templateSpawnToken`. The `workflow_created` handler drains it - seeding the composer draft (`setDraft`) and POSTing the plan to `/api/plans` (`attach:true`) - so neither is auto-sent. The operator initiates either action. Model is applied as-is and validated against the live catalog at apply time (survives renames). The save row in the creator captures config + cwd only; seedPrompt/plan are supported on apply for templates authored elsewhere.
- **`SettingsPanel`** - global settings modal. Collapsible theme picker (default closed; header reads `▶ THEME - <active name>`) with hover-preview pills, per-provider login chips, enabled-providers toggles (both now include `cursor` - a `CURSOR (ACP)` `ProviderRow` whose login chip runs `startLogin('cursor')`), model catalog edit, CLI VERSIONS block (Claude/Codex CLIs + Ollama daemon). Also hosts the **SKILLS** section (of operator-features): list of project + global skills with `[+ NEW]` and per-row `[EDIT] [×]`. Project rows come first; global rows render under a `(GLOBAL)` separator at the bottom. Project skill operations require an active workflow's cwd (read from `useAppStore.getActiveJob.config.workingDirectory`); when no tab is active the new-skill scope defaults to global. Backed by `/api/skills*` (see `HTTP_API.md`). The editor lives in `SkillEditorDialog.tsx` - Name + Description + Body fields, scope toggle on create (fixed on edit), Save POSTs to `/api/skills`. Edits propagate to the next primary turn automatically - the server scans `<cwd>/.arco/skills/` and `~/.arco/skills/` per turn and prepends an XML manifest to the system prompt.
- **Cursor (ACP) UI** - Cursor is a first-class provider (`ProviderName` includes `'cursor'`). Because Cursor bakes reasoning effort into the model id, its picker is `CursorModelSelect.tsx` (family × effort × fast/think chips; never concatenates an id - parses the current id, moves coordinates, then looks up the exact catalog id via `resolveCursorModelId`, degrading via `pickCursorId`). Usage is dashboard-polled, not live (ACP has no per-turn tokens): `UsageTab`'s `CursorUsageCard` + `CursorIncludedGauge` ("Included in Pro" bar driven by Cursor's blended `totalPercentUsed`, **not** used/limit). The compact R-dot hover also renders Cursor's separate **Other Models** bar from `apiPercentUsed`; it does not derive that quota from event totals. `WorkerCard` badge is **R** / `#6cc6d6` / "Cursor (ACP · ~153 models)"; `PrimaryStatus` parses effort **out of the id** (never `config.primaryEffort`). `App.tsx` polls `/api/cursor/catalog` (30-min) -> `setCursorCatalog` and `/api/cursor-usage` (`USAGE_POLL_MS`) -> `setCursorUsage`. Version chip is display-only in `ProvidersPopover` (self-updating; click -> cursor.com/changelog; never flagged outdated).
- **`SystemHeader`** owns the bonus `SystemModal` for global ops. Tabs: **Actions** (restart/shutdown), **Diagnostics** (`DiagnosticsTab` - Ops-A4 status checks), **Models** (`ModelHealthPanel`  -; per-backend health rows. When llama.cpp fails to serve, a DD13 `DiagnosisBox` (`data-help="model-health.llamacpp-diagnosis"`) surfaces the likely cause plus one-click set-ctx-size / set-ngl / add-extra-arg fixes (`model-health.llamacpp-fix`) that wholesale-replace the catalog via `GET`/`POST /api/llamacpp/catalog` and reload the alias), **Services** (`ServicesTab` - Ops; **machine-wide** local web/dev service browser: compact rows, open/copy/kill/pin, ~5s auto-poll). Services lives here, not the per-workflow right panel, because it's project-agnostic (the same list regardless of focused workflow).
- **`UserManual`** - comprehensive operator-facing manual, opened from the header `MANUAL` button. Two-column layout (left TOC with grouped sections + live search; right scrolling content). Listens for `arco:manual-jump` window events so the contextual help popover's "READ MORE IN MANUAL ->" button can deep-link to a section.
- **`RecallView`** (Workbench, `components/Recall/`) - the **top-level Recall search overlay**: a portal modal (like `UserManual`, Escape / backdrop to dismiss) over `GET /api/recall/search`, gated on `appStore.showRecall`. Search box + project/provider/date filters + a transcript-full-text toggle (default OFF, disabled when `rg` is absent), and a ranked result list (`RecallResultRow`) with highlighted FTS5 snippets. Search state (hits + filters + `runSearch`) lives in the standalone `recallStore` (not `appStore`), debounced 180ms on filter change. **Entry points:** the command-palette command "Recall: search conversations" and the header **⌕ RECALL** button. **Not** a per-tab RightPanel sub-tab - it spans every conversation Arco has run. Result actions: Jump-to-transcript/Resume (switches to the tab if it's open) is live; Open-summary is a graceful "no summary yet" stub until F2; Reference-in-current-tab is a disabled stub deferred to D1. See `docs/RECALL.md`.
- **Help system** - contextual help mode (GroundTruth-pattern port). State lives in `appStore` (`helpMode`, `activeHelpPopover`, `activeDocRef`). `useHelpMode` (in `client/src/help/useHelpMode.ts`) installs the body-class toggle, the capture-phase click handler that intercepts `[data-help]` clicks while help mode is on, and the Escape exit. Help-system widgets carry the `help-system-ui` class so the body-level `pointer-events: none` rule (in `styles/contextual-help.css`) doesn't disable them. Per-element content keys live in the `HELP_CONTENT` registry (`client/src/help/content/`, re-exported from `helpContent.tsx`); ~388 surfaces across the app are annotated with `data-help="<key>"` (~435 usages - many added in the 2026-06 refactor: `composer.fold` / `composer.posture` / `composer.project-trust`, `cluster.board-add-task` / `cluster.board-columns` / `cluster.board-automation-toggle` / `cluster.task-edit`, `model-health.llamacpp-diagnosis` / `-fix`, `rightpanel.config.auto-fold`, ...). `npm run docs:check` keeps the registry, the `data-help` usages, and the manual `manualSection` links in sync - see "Help-system doc-sync checker" below.
- **`DocRef`** - clickable in-app file-path chip used by the manual + help popovers. On click, sets `activeDocRef` so `DocViewer` opens. Replace-in-place semantics: clicking another `DocRef` from inside `DocViewer` swaps content, no nested stack.
- **`DocViewer`** - modal stacked above the manual (z=9520) that reads from `GET /api/docs?file=<repo-relative path>` and renders markdown via the same ReactMarkdown + rehype-highlight pipeline as `FileViewerModal`. Source files (`.ts`/`.tsx`/`.js`/`.json`/etc.) are wrapped in a fenced code block so syntax highlighting reuses the existing pipeline.
- **`HandoffPromptsEditor`** - mounted inside `SettingsPanel`. Two cards (FRESH-SUMMARIZER / ORIGINAL-WORKER) showing the effective handoff seed prompt with project / global / default scope pills (`ScopePill`). Click a scope to override at that level; commit via `POST /api/handoff-prompts`. Active cwd is read from `useAppStore.getActiveJob.config.workingDirectory`.
- **`SkillEditorDialog`** - stacked above `SettingsPanel`. Name / Description / Body fields, scope toggle on create (fixed on edit). `POST /api/skills`; edits propagate to the next primary turn (server re-scans `<cwd>/.arco/skills/` + `~/.arco/skills/` per turn and prepends an XML manifest to the system prompt). An **AUDIT** button (`POST /api/skills/audit`) runs an operator-triggered security scan of the current body - diagnostic-only, surfaced inline, never blocks Save.
- **`RunAsPicker`** - shared provider / model / effort picker used by `GitDialog` and `DocsUpdateDialog`. Exports `spawnConfigFromRunAs(parentConfig, selection, nameSuffix)` which inherits the parent config but overrides primary fields, suffixes the workflow name, and clears `resumeSessionId/resumeWorkflowId` so the new tab is fresh. When the picker selection matches the parent's current primary the dialog dispatches in-tab via `onConfirm(prompt)`; when changed it calls `onSpawn(newConfig, prompt, false)`. `ReviewDialog` and `SpawnDialog` have their own embedded pickers and could adopt this shared component to dedupe ~80 LOC each.
- **`NotificationToasts`** - top-right toast stack subscribed to `appStore.notifications`. Auto-dismisses 6 s after `createdAt`; backed by `pushNotification` / `dismissNotification` actions. The WS `error` handler is the primary producer so cluster-action rejections (Native fence, sandbox 503, etc.) surface regardless of which tab is focused.
- **`PlanBodyRenderer`** (2026-05-11; top-level `components/PlanBodyRenderer.tsx`) - shared rich plan renderer extracted from the former inline `PlanBody`. Renders H1/H2/H3 styling, clickable `- [ ]` / `- [x]` checkboxes (optimistic toggle), per-H3 action pill rows, and exports `CHECKBOX_RE` for host components. Used by both the per-worker PLAN tab (`RightPanel/PlanTab.tsx`) and `ClusterPlanTab.tsx` so the two surfaces stay visually identical. Action-pill set varies per host (worker plan: DETACH / PROMOTE / MOVE / DONE; cluster plan: none - the cluster plan IS the cluster plan). On a cluster-member plan whose board is attached it also renders a `-> TASK` pill next to each unchecked item (`onPromoteTask`) that promotes the item text into a durable board task (`task_ledger_create`).
- **`PlanCandidateBanner`** - mounts between chat and composer when `job.planCandidate` is set. Captures from the latest finalized assistant message at `primary_complete` time; `turn_cancelled` clears `pendingPlanCapture` so a stale flag doesn't capture an unrelated later reply. Cluster-member tabs gain a third `ATTACH TO CLUSTER` button between `ATTACH TO WORKER` and `DISCARD` (resolved by `App.tsx` from the member's `clusterId`). A detection-based fallback in `ws/handleServerMessage.ts` (`looksLikePlan` from `ws/streamState.ts`: H1 + ≥3 checkbox lines) surfaces the banner in `review` mode even when the operator didn't click PLAN before sending.
- **`AskUserQuestionNotice`** - inline reply form rendered by `ChatMessage` when it detects the `[ASK:claude-native:<questionId>]` sentinel a Native worker emits via `system_notice`. Parses an `[ASK_OPTIONS:opt1 | opt2]` line into option chips; otherwise renders a text input. Submits `ask_user_question_reply { workflowId, questionId, reply }` via `wsSendRaw`; the worker resolves the awaiting tool-result Promise.
- **`GateApprovalNotice`** (Native-only v1; see [PRIMITIVES.md](PRIMITIVES.md)) - the inline edit-then-approve card `ChatMessage` renders when it sees a synthetic `gate::<gateId>` row (`message.toolUse.tool === 'Gate'`) that the `gate_required` broadcast anchored into chat. Shows the parked sensitive tool call (Bash command line, or pretty-JSON for other tools) with an editable textarea (edit-then-approve), APPROVE / REJECT (sends `gate_reply` via `wsSendRaw`), and an "approve all like this" checkbox. `gate_resolved` flips the row's status in-place (`resolveGate`); standing approvals arrive via `gate_standing` -> `setStandingGateApprovals` and render + revoke (per-row `gate_revoke`) inside `ClaudeNativeReviewSafeModeSection` in CONFIG. Arg helpers live in `client/src/utils/gateArgs.ts` (`buildGateFinalArgs` / `renderGateArgs`). Gated behind the per-tab `reviewSafeMode` flag (default off).
- **`HistoryTab`** - covered in detail under the right-panel section below.

- **`UsageTab`** (Workbench, `components/RightPanel/UsageTab.tsx`) - the **USAGE** right-panel tab. Fetches `GET /api/usage-stats?path=<cwd>` (read-only, deterministic aggregation of the existing `primary_turn_token_usage` events under this workflow's cwd - **no new capture, no LLM**) and renders **per-provider, per-day token-volume + cache-hit-ratio trends**, framed as **quota-pressure / token-volume insight** ("which tab/model is eating my rolling window") - there is deliberately **no USD / cost framing** anywhere (subscriptions). Charts are **hand-rolled inline SVG** - a `<polyline>` sparkline of daily prompt volume per provider (single-day series renders as a dot) plus a `<rect>` cache-hit-ratio bar - so there's **no chart-library dependency**. The cache-hit ratio is computed server-side with the provider-correct denominator (Claude's input/cache fields are disjoint; Codex's `cacheRead` is a subset of `input`), so the tab just displays it. A ↻ refresh button re-fetches; an empty/missing-cwd/zero-turn state degrades to an `EmptyState`. When Cursor is logged in, a `CursorUsageCard` (framed "· polled · not live") renders above the aggregation - embedding `CursorIncludedGauge`, MTD tokens/events, per-kind chips, a ↻ re-poll (`/api/cursor-usage?force=1`), and a dashboard link - even on Cursor-only projects that have no per-turn events.
- **`TasksPanel`** + **`TaskCard`** - covered under the right-panel section.
- **Cluster components** (`ClusterTab` / `ClusterRightPanel` / `ClusterPlanTab` / `ClusterActivityTab` / `ClusterMemberPicker` / `MemberCard` / `MemberPane` / `TabContextMenu`) - covered in the cluster-tab section below.
- **Terminal components** (Workbench/, `components/Terminal/`) - the operator PTY surface, state in a standalone `stores/terminalStore.ts` (kept out of `appStore` because the byte stream is off the seq'd protocol and the windows are non-persisted overlays):
  - **`FloatingWindow`** - reusable draggable / resizable overlay shell. `position: fixed`, no backdrop, z-order bumps on focus (module-level counter) so it never reflows the two-column layout and several can tile. Drag by the title bar; resize from the bottom-right grip.
  - **`XtermView`** - the `xterm.js` view bound to one session over the dedicated `/terminal` WS path (raw bytes, separate from `/ws`). Fit addon drives resize->PTY resize. Captures Enter-submitted command lines client-side for `terminal_command` logging. Unmount closes the socket = server detach (the shell lives on). **:** two `XtermView`s on the same `sessionId` both render live output - the server fans the stream to a `Set` of listeners.
  - **`FloatingTerminalWindow`** - orchestrator mounted once at `App.tsx`. **: renders N windows** - `terminalStore.windows.map(...)` -> one `TerminalWindowInstance` each. Each instance spawns a session on demand (`terminal_open`), renders the window + xterm, asks `terminal_list` on mount, and offers a **session switcher** (`<select>` over `sessionsByWorkflow`), a **`+ NEW`** button (always spawns a fresh session in a new window), and per-session **KILL**. **Entry points:** the header `>_ TERMINAL` launcher (`SystemHeader`, active-workflow root) and the Files-tab "open terminal here" (`FileExplorer` - a `>_` header icon at the Files root + right-click any directory for that dir's cwd) both route through `useTerminalStore.openTerminal` (reuse-or-open a window for the workflow); `+ NEW` calls `newSession` (forces a fresh spawn). **Session ≠ connection:** closing a window detaches (disposes only that window's listener); only KILL ends the shell. See [`TERMINAL.md`](TERMINAL.md).
  - **`terminalStore` shape :** `windows: TerminalWindow[]` (`{ windowId, workflowId, sessionId|null, pendingCwd?, pendingPrefill? }`) + `sessionsByWorkflow: Record<string, TerminalSession[]>`. The session list is driven by the WS dispatch (`terminal_opened` -> `addSession` + `bindSpawnedSession`; `terminal_killed` -> `removeSession`; `terminal_sessions` -> `setSessions`, sent on `terminal_list` and re-emitted on rehydrate). `setSessions`/`removeSession` reconcile open windows: a window whose session no longer exists (e.g. after a server restart) drops its `sessionId` to null and shows the switcher/empty state.

### Help-system doc-sync checker (`scripts/docs-check.ts`)

The three help pieces - `data-help="key"` attributes on elements, the `HELP_CONTENT` registry (`client/src/help/content/`, assembled in `helpContent.tsx`), and the manual sections (`client/src/help/manualSections/`, each a `{ id, title, group, body }`) - have no compile-time link. `npm run docs:check` (Workbench Expansion) is a deterministic static validator that keeps them in sync. It runs as text/regex scans (the house style of `scripts/size-check.ts`), exits non-zero on a real orphan, and is wired into the per-phase DONE checklist (see `CONTRIBUTING.md-sync`).

What it validates:

- **`data-help` key -> entry (hard error).** Every static `data-help` key used in a component must have a `HELP_CONTENT` entry. A clicked element with no help text is the dangerous direction, so this hard-fails.
- **`manualSection` -> section id (hard error).** Every `manualSection` referenced from an entry must resolve to a real manual section id. Dangling link hard-fails.
- **Entry -> usage (warning).** An entry no element references is a *warning*, not an error - that's the normal state when a phase pre-authors help before wiring the element. It also covers parent-prefix entries (e.g. `chat.seed-pill` is covered by `chat.seed-pill.handoff`).
- **Coverage % (informational).** Fraction of interactive elements (`<button>`/`<input>`/`<select>`/`<textarea>` + any `onClick=` tag, plus a ~200-char wrapper window for the common `<span data-help><button>` idiom) that carry help. Never fails the build.

**Dynamic-key / forwarded-prop handling** - the load-bearing reason the checker is trustworthy enough to gate every phase (false positives would erode that):

- A `data-help={`...${x}...`}` template (the `rightpanel.tab.${id}` / `github.tab.${t}` patterns) is treated as a *dynamic prefix*: not hard-checked against the registry, but any entry sharing that prefix counts as referenced.
- Forwarded-prop helpers are recognized so their keys aren't lost: `helpKey="..."` and `dataHelp="..."` props (the `Field` / `CheckpointActions` indirection), `help: '...'` object properties (FilesTab tab descriptors, guarded by a key-shape regex), the `'data-help': key` object-property spread, and `const helpKey = cond ? 'a' : 'b'` local-variable chains (ClusterRightPanel). New forwarder names need adding to the script - documented in its header comment.

`npm run docs:check -- --self-test` runs a fixture-based self-test (injects a missing-entry key, a dangling section, and an unreferenced entry into temp files, asserts the checker classifies each correctly) - proves the gate fails loudly without touching real files.

### In-modal scoped Help (`openManualSection` + `ModalHelpButton`,)

The "full tool" modals (Media studio, Cookbook, ...) carry their own in-place **Help** affordance so the operator gets a scoped guide without hunting the global TOC. Three pieces:

- **`client/src/help/openManualSection.ts`** - `openManualSection(sectionId: string): void`. The single bridge: opens the manual via `useAppStore.getState.setShowManual(true)`, then (next tick, so the modal's listener is mounted) dispatches `window` CustomEvent `arco:manual-jump { detail: { sectionId } }`, which `UserManual` listens for and scrolls to `#manual-<id>`. `HelpPopover`'s "READ MORE IN MANUAL ->" link also routes through this helper (DRY - no inline dispatch anymore).
- **`client/src/components/help/ModalHelpButton.tsx`** - props `{ section: string; title?: string; label?: string }`. A small "HELP" button styled like the modal-header buttons; click -> `setActiveHelpCard({ section, title })`. It used to call `openManualSection` directly, but that opened the whole manual *behind* the modal (greyed out, unreadable). This is **not** the global floating `HelpButton` (which toggles help-*mode* for the whole app). Each tool passes its own section id (`media-studio`, `cookbook-catalog`), which doubles as the snippet filter.
- **`client/src/components/help/HelpCard.tsx`** - the movable, filterable card rendered from `appStore.activeHelpCard`, floating **above** the modal with the tool's scoped snippets; its "open full manual" link is the escape hatch through `openManualSection`.

Consumers today: **`CookbookModal.tsx`** (`section="cookbook-catalog"`, next to CLOSE) and **`MediaModalHost.tsx`** (`section="media-studio"`, in the header). Later tools reuse the same mechanism per Appendix D.

---

## Chat rendering pipeline

`ChatPanel.tsx`'s `displayMessages` memoization is the linchpin. It runs only when `job.sessionChat` or `job.messages` change - the composer auto-grow on keystrokes does NOT invalidate this memo, so the virtualizer doesn't recalc and the chat doesn't jitter.

### Two render paths

**Early-return path** - when `job.sessionChat` is empty (non-Claude provider, or fresh workflow before JSONL is populated):

```ts
if (sessionChat.length === 0) {
  return job.messages
    .filter((m) => !(m.role === 'user' && m.queued))
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}
```

The sort handles out-of-order frame arrivals on the wire (long pauses between text chunks, reconnect replay).

**Merged path** - when `sessionChat` is populated (Claude with JSONL):

1. Build a content-prefix -> timestamp[] map from sessionChat user entries.
2. Compute `sessionAssistantConcat` (concat all sessionChat assistant text blocks).
3. For each `job.messages` entry, decide its fate:
   - **System notice** - keep as-is.
   - **Streaming bubble** - try to trim the prefix that sessionChat has already materialized. If the suffix is empty after trim, drop the bubble. If trim fails but normalized whitespace matches, drop. If the streaming content has genuinely diverged from sessionChat, keep but pin to bottom (`timestamp = lastSessionTs + 1`).
   - **Queued user message** - drop (surfaces in `QueuedMessagesIndicator`'s strip above the composer; the strip's source of truth is `job.queue`, kept in sync via the `queue_update` WS event).
   - **Operator user message** - keep if there's no sessionChat echo within 5s (proximity-based dedup).
4. Build `optimisticUserMetaByKey` to merge optimistic-add metadata (timestamp + attachments) onto the matching sessionChat echo. Only merge if within `DEDUP_WINDOW_MS = 5000`.
5. Concat `enrichedSession + extras`, sort by timestamp.

### Handoff/Spawn seed collapse

Scan `displayMessages` for `[HANDOFF U+2014` and spawn-suffix prefixes. If found, the most recent seed becomes the threshold; everything ≤ that index collapses into a single `PRIOR SESSIONS · click to expand` pill. Expanding inline re-renders the full history (intermediate seeds still render as pills inside).

### Peer message rows + role display (2026-05-11)

`ChatMessage` carries `targetWorkflowId?: string` on `peer-sent` rows - the full recipient workflowId, set in the `peer_message_sent` WS handler (now in `ws/handleServerMessage.ts`). `PeerMessageBlock` in `ChatMessage.tsx` looks up the relevant peer in the cluster store (recipient for sent rows via `targetWorkflowId`; sender for received rows via `senderWorkflowId`) and renders `displayName (role)` instead of an 8-char wfid prefix. The lookup is reactive on rename / re-role. ** peer->task bridge:** `PeerMessageBlock` accepts an `onMakeTask(content, fromWorkflowId)` prop so a delivered peer message in the transcript can be promoted to a board task; `ChatPanel` supplies the callback (`onMakeTaskFromPeer`) only when the member's cluster board is attached (`taskBoardMode !== 'none'`), anchoring the task at the first member's cwd.

Implementation note: the selector reads the full `clusters` map (`useAppStore((s) => s.clusters)`) and the derivation runs through `useMemo` keyed on `[clusters, lookupWfid]`. Selecting a fresh-object literal each render (`s => ({ name, role })`) re-runs the memo every commit and triggers an infinite update loop - keep the selector pointing at the referentially-stable map.

Row identity uses deterministic ids (`peer-sent-<msgId>` / `peer-recv-<msgId>`) so rehydrate-on-subscribe + tsx-watch restarts are idempotent. Three-layer dedupe: WS handler intake check, `appStore.addMessage` defense-in-depth, `onRehydrateStorage` strips historical duplicates on load. See `GOTCHAS.md-polish push gotchas`.

### "Run in terminal" chat chip (Workbench Expansion)

Fenced code blocks render through `CopyablePre` in `ChatMessage.tsx` (the `pre` override in `markdownComponents`). On each block it runs the **pure detector `client/src/components/Terminal/detectCommand.ts`** - which classifies the block's info-string / `language-xxx` className (`bash`/`sh`/`shell`/`console`/`zsh`, case-insensitive) and extracts the command text - and, when it qualifies **and** a `workflowId` (`jobId`) is in scope, renders a `▶ RUN IN TERMINAL` chip next to `COPY`. Clicking it calls `terminalStore.prefillInTerminal(workflowId, command)`, which raises/opens the floating terminal and stages the command; `FloatingTerminalWindow` drains it into `XtermView`, which sends a `prefill` frame over `/terminal`. **Pre-fill never auto-runs** - no newline is sent (see `docs/TERMINAL.md §` + `docs/GOTCHAS.md`). The detector lives next to the terminal components (not in `ChatMessage.tsx`) so the smoke (`npm run smoke:terminal-prefill`) can unit-test it directly.

### Why dedup is content-prefix-based

The optimistic add uses client `Date.now`; the sessionChat echo uses Claude's JSONL wall-clock. They can differ by milliseconds to seconds. Sorting purely by timestamp would visually swap them sometimes. The dedup uses the first 120 chars of content (whitespace normalized) as the join key, only merges within 5s, and pins the optimistic timestamp onto the echo so the message stays in its visual slot.

---

## Hands-free voice

Computer also has `ComputerAgentPicker`: provider/model/effort/history from
the shared live model catalog resolver, applied by `voice/computerControl.ts`
and `ComputerConversation`. Separate workflows hold each selection's context;
no history is copied across providers or privacy boundaries. Preferences alone
persist in `arco.computer.selection.v1`. `computerTurnActive` waits for the
server's complete-turn `settled:true` notice, including queued work, and a
snapshot rebases it on reconnect. A private clear discards browser messages;
leaving private mode removes the private job. `arco_computer` uses the same
controller as the panel, with strict catalog/effort/privacy validation.

The header's COMPUTER button opens `ComputerPanel`, a dedicated transcript,
tool-call and usage viewer backed by `stores/computerStore.ts` (transient open
state). It uses the existing saved `voiceOperator` job and `ChatPanel`, with
no project selection change or microphone access. The flag excludes Computer
from `TabBar`, command-palette tabs and PAST CHATS; selecting it through a history
link opens the panel. Creation keeps the workbench selection; hydration migrates
an older active Computer tab back to a project or cluster while retaining the
thread. An ordinary chat named Computer is unaffected.
`ComputerComposer` adds text requests through the existing `sendMessage`
path, using memory-only `draftStore` drafts. It works with the microphone off;
`toolBridge.allowComputerTextTools` scopes browser-tool permission to an
explicit typed request, revoking on full settlement, STOP, disconnect or
owner change. Merely opening the panel grants no tool access. The fixed header
and voice strip show STOP REQUEST using the shared `computerRequestActive`
selector (busy, streaming, queue and Computer's full-turn boundary).
`computerVoiceStatus` replaces stale working text with an idle/read-response
message, independently of speech playback or readback delivery.
The panel displays provider-reported current input/window/fullness separately
from accumulated usage, the last native compaction notice in retained history,
and fresh-context controls (OFF/25/50/75%, KEEP CONTEXT, CLEAR CONTEXT / CLEAR
AFTER TURN). Policy and reset state mirror `config.computerContext` from the
server's `computer_context_updated`; a fresh event clears the previous input
count; saved history retains rows, while a private clear discards them. `headerActionStyle`
is shared by the normal header actions and the VOICE button, including font,
padding and radius.
Contextual help on the header, agent picker, context controls and voice strip
links to the Computer manual and covers provider/history selection, 50%/75%
defaults, CLEAR CONTEXT, and Codex stall recovery. `ComputerConversation`
speaks scoped server errors after a failed turn instead of its partial reply.
The shared `voiceText` helper keeps screen labels/readings, prompt and reply
caps well-formed across emoji boundaries; the server repairs tool results too.

The header's VOICE control opens `VoiceControl`, mounted once in App below the
workflow tabs; its strip reserves layout space and never overlays worker
panes. `voice/runtime.ts` owns the microphone, the AudioWorklet, the wake /
audio / diag requests and the capture buffer; microphone/capture state is
transient and nothing auto-enables. Everything captured goes to the Computer chat (`voice/converse`
path) and comes back as tool calls: `voice/toolBridge.ts` answers
`voice_tool_call` for the owning window, `voice/executor.ts` runs the named
tools over the app store (select, panels, send/steer/follow-up via
`sendMessage`, nudge, cancel, read), `voice/dialogs.ts` raises the
`arco:voice-dialog` DOM event that `ClusterTab` / `TerminalInput` turn into
their dialog state, and `voice/screen.ts` is the generic layer (`readScreen`,
`actOnScreen`, `readText`) over the live DOM. `buildCheck.ts` +
`StaleBuildBanner` flag a tab left on an older bundle after a rebuild.
Audio is memory-only; Computer offers saved or strict memory-only history (Strata is saved-only). See
[VOICE.md](VOICE.md) Computer works today.

Capture acknowledgement uses the bundled quiet 230 ms Soft double pulse from
`/api/voice/ready-sound`, with unity gain and no normalization. It plays only
after verified wake, independently of speech output, without blocking capture.

`VoiceOutputPicker` in the expanded controls offers the five shared
`VOICE_OUTPUT_OPTIONS` plus the configured server default. `voice/store.ts`
saves only `outputVoice` under `arco.voice.output.v1`; it never persists
arming or capture state. `runtime.speak` freezes a voice for all sentences of
one reply; selection changes apply to the next reply without cancelling the
current reply/capture. LISTEN uses the normal runtime while enabled/idle
(including echo/barge-in guards), or an independent bounded
`POST /api/voice/preview` plus cancellable audio playback with the mic off.
An off-mic sample stops before enabling capture. Strip buttons and the picker
explicitly use `var(--font-display)` so browser form defaults cannot ignore
the active theme/font pack. `smoke:computer-panel` covers preview, persistence,
capture preservation and two display-font overrides.

## Composer state

`TerminalInput.tsx` decides between idle and queue mode based on:

```ts
const isBusy = (job.busy === true) || hasActiveWorkers || hasStreaming;
```

Where:

- `job.busy` - server-authoritative, mirrors `primary_turn_started`/`_ended`. Stays true across tool roundtrips.
- `hasActiveWorkers` - local heuristic: any spawned worker still in `running` or `spawning` status.
- `hasStreaming` - local heuristic: any chat message with `isStreaming: true`.

When `isBusy`:

- Claude/Codex Agent placeholders include `Ctrl/Cmd+Enter` for interrupt and send. Other providers retain the cancel hint.
- Glyph flips from `>` to `...`
- Diagnostic chip `b{0|1}·w{N}·s{0|1}` appears next to CANCEL - helps diagnose stuck composer
- Hint reads `↵ STEER · ⌥↵ FOLLOW-UP` instead of `ENTER TO SEND`
- **SEND** remains visible beside **INTERRUPT & SEND**. It follows Enter: starts normally when idle, steers when busy. Send choices wrap below the draft on narrow layouts.
- Composer routes to a structured queue:
  - `Enter` -> enqueue as **steer** (do this now / change direction)
  - `Alt+Enter` -> enqueue as **follow-up** (after the current task lands)
  - `Ctrl/Cmd+Enter` or **INTERRUPT & SEND** -> cancel the Claude/Codex primary, await teardown, then run the draft before older queued instructions. The button is hidden for other providers and Computer, and disabled while uploading/compacting or with an empty draft.
  - `Alt+↑` -> recall most recently queued message into the editor (replaces draft; takes the last follow-up if any, otherwise the last steer)
  - `Esc` -> cancel the in-flight turn; if the queue is non-empty the client confirms via `window.confirm("Drop N queued messages?")` first
  - `Shift+Esc` -> force-cancel without the prompt
- Steering drains at provider boundaries on Codex app-server, Claude Native and local tool loops; single-shot transports deliver it after completion. Interrupt uses a separate cancellation path. Its queue entry carries `interrupt:true`, and the queue strip/modal labels it **INTERRUPT & SEND**.

The send hook (`useWebSocket.sendMessage`) takes an optional `kind` argument. Explicit `interrupt` survives a stale client busy flag; the server starts normally if already idle. Other idle sends bypass the queue. The optimistic add's `queueKind` field drives the per-message [steer] / [follow-up] pill in the queue strip and modal.

`Esc` in an empty composer (idle) still cancels the most-recent queued message via `onCancelQueued` for muscle-memory parity, but with the busy-path Esc cancelling the whole turn this is rare.

Drafts (`draftStore`) and attachments (`appStore`) are keyed by `workflowId` so they survive tab switches.

**`/goal` command** - `/goal <objective>` sets, bare `/goal` queries, `/goal clear|none` clears the standing north-star (regex won't match `/goalkeeper`); pushes a local system row, never sends a turn.

### Inline plan-mode toggle (Claude Native only)

Above the textarea, `TerminalInput.tsx` renders a `⛔ PLAN MODE - GATE WRITE TOOLS FOR NEXT TURN` checkbox. Visibility is gated on `job.config.primaryProvider === 'claude'` AND the resolved transport (`job.config.claudeTransport ?? settings.claude.transport ?? 'cli'`) being `'native'`; on every other provider/transport the row renders nothing (no reserved space). Local-only state (`planModeArmed: boolean`) - not persisted to the store, not in localStorage, so a reload or tab swap clears it. The placeholder text shifts to `Type your task - plan mode armed for next turn` when armed; no banner.

Send-time-fire: when the operator hits send with the box checked, `handleSubmit` first calls `onArmPlanMode` (dispatches `enter_plan_mode_request` over the WS) and then the regular `onSend`. Server processes them in order: `pendingPlanModeEntry` is set, then the upcoming turn dispatch picks it up and arms the worker. Auto-clears on every send - single-turn arming. If the operator unchecks before sending, no WS message fires (toggle state is the source of truth).

Wire path through the rest of the app: `useWebSocket.armPlanMode` -> `App.tsx` -> `WorkflowView` -> `TerminalInput` (`onArmPlanMode` prop). Callback chain mirrors `onSpawn` / `onHandoff` for symmetry.

### Fold / posture / project-trust pills (Claude Native)

The composer status row gained three Native-only operator surfaces (all gated on `provider === 'claude'` && resolved transport `'native'`), plus a few extra primitive buttons:

- **`⊞ FOLD` pill** (`data-help="composer.fold"`) - manual deterministic in-place transcript trim ( Fold). Click dispatches `fold_workflow` via `onFold` -> `useWebSocket`. A companion **`⊟ COMPACTED`** banner (`data-help="composer.compact-continue"`) renders when `job.compactedResume` is set, reporting `folded N turns into a summary` and offering a one-click Continue prompt.
- **Posture cycle pill** (`data-help="composer.posture"`) - cycles `POSTURE_CYCLE = full -> coding -> review -> chat` via `onSetToolPosture` (sends `set_tool_posture`). It mirrors `job.toolPosture` (set by the server's `tool_posture_set` push), is **session-local** (not persisted; reverts to `full` on reload), and takes effect next turn - narrowing the exposed Native toolset (coding = no web research; review = read/inspect/run only; chat = read-only lookup) to cut tool-def tokens + attention.
- **DD7 project-trust banner** (`data-help="composer.project-trust"`) - renders when `job.projectTrustPrompt` is set (an untrusted repo's `AGENTS.md` / skills / settings were suppressed from the turn). Shows `UNTRUSTED PROJECT` + the suppressed resources with TRUST / DON'T-TRUST buttons calling `onSetProjectTrust(cwd, 'always' | 'never')` (sends `set_project_trust`); the server's `project_trust_set` push clears the prompt.
- **`⚡ ULTRACODE` pill** - always shown when `job.config.ultracode` is set (read-only here; the toggle lives in CONFIG -> TRANSPORT); while a turn is fanning out it shows live `done/total agents · N running` from `job.ultracodeFleet`.

The composer button row also carries **COMPARE** (`composer.compare` -> `CompareDialog`), **RESEARCH** (`composer.research` -> `ResearchDialog`), **✎ TUNEUP** (`composer.tuneup` -> `MdTuneupDialog`), **REMOTE** (per-workflow hub opt-in), **/SKILLS** (lazy provider-native catalog; Claude CLI inserts `/name`, Codex inserts `$name`, unsupported transports explain the boundary), and **+SKILL**. Each Arco-managed skill row has **APPLY ONCE** (stages `pickedSkills`, full body inlined into the next user turn) and **PIN TO TAB** (whole-set `update_primary_config { pinnedSkills }`; durable refs in meta, current bodies injected as standing system instructions every turn). Pinned chips stay visible above the composer with × unpin; `pinned_skills_set` synchronizes observers and adds a SKILLS activity row. Both modes include `operatorOnly` skills hidden from automatic discovery. **⊟ COMPACT** sits alongside the documented REVIEW / HANDOFF / SPAWN / DOCS / GIT; on Cursor it dispatches native `/compress` without normal prompt prefixes, and the token footer reads `CTX: Cursor-managed` because ACP supplies no retained-context count.

### Context refs (`@file:` / `@diff` / `@staged` / `@git:N` / `@url:`,)

Inline composer expansion. The operator types an `@`-ref in the draft and Arco expands it into the turn's context at send time - killing the "paste this file/diff in" friction.

**Parse -> chip -> server-expand -> log:**

- **Parse (client, pure).** `client/src/components/composer/contextRefs.ts` exports `parseContextRefs(text): ContextRef[]` - a pure, DOM-free parser (no React imports, so the headless smoke imports it directly). The grammar, one regex anchored on `@` at a word boundary (so an email `a@b.com` or npm scope `@scope/pkg` mid-token isn't matched): `@file:<path>` (path to next whitespace), `@diff`, `@staged` (bare keywords with a `\b` so `@diffstat` doesn't match), `@git:<digits>` (digits only - `@git:abc` is left as plain text), `@url:<url>`. Each `ContextRef` carries `kind` / `raw` / `arg` / `count` / `start` / `end`.
- **Chip (client).** `TerminalInput.tsx` memoizes `parseContextRefs(draft)` and renders a chip bar above the attachments bar - one chip per ref, with a `×` that strips the ref's exact span from the draft (`removeContextRef(start, end)`). The chips are purely a visual affordance; the server is the source of truth (it re-parses + expands). `@url:` chips render dimmed with a "not yet supported" tooltip. `data-help="composer.context-refs"`.
- **Server-expand.** `server/src/contextRefs.ts` `expandContextRefs(cwd, content)` runs once in `turnEngine.handleUserMessage`, **before the busy/queue split**, so queued AND immediate sends both carry the expansion. The grammar is duplicated there (the client file lives outside the server tsconfig `rootDir`, so they can't share a module - kept in lockstep by hand). `@file:` confines via `resolveWithinCwd` + a realpath re-check (symlink-escape guard) and is byte-capped at 64 KB with an explicit `... [truncated N bytes]` marker; `@diff`/`@staged` go through `git.ts` `gitDiff` (execFile argv only); `@git:N` validates N is a positive integer and caps it at 50 via `gitLog`. Every failure (missing file, traversal, non-repo, git error) becomes a readable notice - `expandContextRefs` never throws into the turn loop. `@url:` is **recognized-but-deferred**: it expands to a clear "not yet supported" notice rather than fetching (a safe SSRF-guarded fetch is a security-sensitive sub-phase of its own - see deferral). The expanded blocks append to the **model prompt** (after the plan prefix) under a `--- Context (@file:src/x.ts) ---` header; the chat **echo stays compact** (the raw `@file:...` text the operator typed). Queued messages stash their block on the `QueueItem.expandedContext` field and re-append on drain.
- **Log.** When any ref expands, the server emits a `system_notice` summarizing the per-ref outcome (expanded / truncated / refused / deferred), which `send` seq-stamps into `events.jsonl` - visible + reviewable per the four-question test, like attachments.

Smoke: `npm run smoke:context-refs` (`scripts/smoke/context-refs.ts`) - unit-tests the parser and exercises the real expander against this checkout (real `@file:package.json`, `@diff`, `@git:2`, plus path-traversal refusal and oversized-file truncation). No WS, no server boot.

---

## Theme + shader system

`client/src/themes/`. 42 named themes total (one `definitions/<id>.ts` file each), plus the `provider-auto` sentinel. The default is `matrix`.

### Theme structure

Each theme is a TypeScript file under `definitions/<id>.ts` that exports a `Theme` object:

```ts
{
  id: string;
  name: string;
  tokens: {
    'color-bg': string,
    'color-fg': string,
    'color-fg-muted': string,
    'color-accent-primary': string,
    'color-accent-secondary': string,
    'color-warning': string,
    'color-error': string,
    'color-border-hairline': string,
    // ...30+ role-based vars
  };
  density: { spacing-unit, border-width, radius-* };
  fonts: { display, body, code, googleFontsUrl? };
  animations: { scan?: bool, pulseHalo?: bool, flicker?: bool };
  shaderPreset: ShaderPreset;        // 'matrix-rain', 'cherenkov', 'sonar', etc., or 'none'
  borderRenderer: 'css' | 'rough';
  terminal?: {                       // optional exact xterm Core + ANSI palette
    background, foreground, cursor, cursorAccent,
    selectionBackground, selectionForeground,
    black, red, green, yellow, blue, magenta, cyan, white,
    brightBlack, brightRed, brightGreen, brightYellow,
    brightBlue, brightMagenta, brightCyan, brightWhite
  };
  background?: { image: string; scrim?: number };   // opt-in fixed background image (arco-default) - painted on document.body under a --color-bg scrim
}
```

**Never hard-code hex literals in components.** Always reference `var(--color-...)`.

### Apply

`client/src/themes/apply.ts` - idempotent. Signature: `applyTheme(theme, fontPackOverrideId?, frostedOverride?, frostedOpacity?, brightness?)`. Mutates CSS vars on `:root`, sets `data-theme` attribute on `<html>`, lazy-loads any required Google Fonts (one-shot per session, theme link tagged `theme-font-<id>` and pack link tagged `font-pack-<id>` so they coexist), fires `arco:theme-changed` custom event. The `fontPackOverrideId` argument substitutes `--font-display` / `--font-body` / `--font-code` with the curated pack's stacks before applying.

Two display tweaks post-process the color tokens before they hit `:root`:
- **`frostedOpacity`** - panel-surface alpha for frosted glass (via `withAlpha`); see the frosted-glass section below.
- **`brightness`** (`{ bg, text }`) - two independent signed shifts (`settings.bgBrightness` / `settings.textBrightness`, −30...+30, 0 = stock). The caller routes `color-bg*` tokens through `bg` and everything else (text, accents, borders, status, shadows) through `text`, but they use **different colour models on purpose**: `bg` shifts **HSL lightness** (`liftLightness`) - the intuitive "how light is this surface" dimmer for near-black panels; `text` shifts **HSV value** (`shiftValue`) - brightens a coloured ink toward its most *vivid* form while keeping hue **and** saturation, so it never washes out to white (white needs saturation 0, which this leaves alone). Both clamp to [0,100], preserve alpha, and short-circuit at 0 (byte-identical to stock). Clamped server-side to −30...30. `setBgBrightness` / `setTextBrightness` (+ `previewBg/TextBrightness`) share one `commitBrightness` helper with the frosted-opacity optimistic-apply + persist + live-drag shape.
- **Fixed background image** - when `theme.background` is set, `applyTheme` paints `linear-gradient(scrim, scrim), url(image)` (cover/fixed) onto `document.body` via `root.dataset.bgImage`, and resets it to the flat `--color-bg` on themes without one. Only `arco-default` uses it today (`/backgrounds/odytty-dark-waves.webp`, scrim 0.8).

**Crisp text** is deliberately *not* an `applyTheme` param - it's a root attribute, independent of theme tokens, so it survives theme swaps. `applyCrispText(on)` sets `data-crisp` on `<html>`; `global.css` keys a `text-shadow: none !important` kill-switch off it, neutralizing the phosphor text-glow that softens small text on glow-heavy themes (Matrix, Cicada, Oscilloscope...). The ARCO header wordmark (`.arco-wordmark` on the `SystemHeader` `<h1>`) is **exempted** so it always keeps its glow; structural box-shadow glow on borders/LEDs is untouched. Backed by `settings.crispText`; `setCrispText` in the store is optimistic + persists to `/api/settings`.

### Bootstrap

`client/src/themes/bootstrap.ts` - synchronous, runs before React mount. Reads `themeId` *and* `arco_font_pack_override` from localStorage, looks up the theme in `registry.ts`, applies tokens + override fonts directly to `:root`. This avoids the flash of default colors / fonts during initial paint.

### Registry

`client/src/themes/registry.ts` exports `THEME_REGISTRY: Record<ThemeId, Theme>` and `DEFAULT_THEME_ID = 'matrix'`. Adding a theme requires updating this file.

### Font pack overrides

Native buttons and selects default to `var(--font-display)` in `global.css`;
inputs and textareas inherit the surrounding font, as do options and optgroups.
These `:where(...)` rules set only the family, with zero specificity, so explicit
component/code typography still wins. Native controls otherwise fall back to
browser fonts even though the body follows the selected theme/font pack.

`client/src/themes/fontPacks.ts` - registry of font stacks (display + body + code triples). Operator picks one in Settings to substitute typography on every theme without changing colors / shader. `setFontPackOverride(id | null)` in the store is optimistic + persists to `/api/settings` (sanitized server-side against `VALID_FONT_PACK_IDS`). 29 packs: the original 14 curated from fonts a theme already pulls - JetBrains/Space Mono/IBM Plex Mono uniform sets, Share Tech, Courier Prime, Cinzel+Lora, Cormorant+Plex, EB Garamond+Lora, Fraunces+Lora, Inter+JetBrains, Inter Tight, Syncopate+Inter, Space Grotesk+JetBrains, Cinzel+JetBrains - plus two **Legibility packs** blocks (2026-06-16) chosen for small-size clarity, which deliberately introduce typefaces no theme uses (loaded on demand): Atkinson Hyperlegible+JetBrains, Lexend+JetBrains, IBM Plex Sans+Mono, Source Sans 3+Source Code, Public Sans+JetBrains, Inter+Source Code, a large-x-height grotesque set (Hanken Grotesk, Onest, Figtree, Geist, Readex Pro - each + JetBrains Mono), and monospace-everywhere packs (Geist Mono, Martian Mono, Victor Mono uniform; Geist + Geist Mono split). New packs must be registered in both `fontPacks.ts` and `VALID_FONT_PACK_IDS` (shared/protocol/themes.ts).

### Shaders

The following legacy shader rules concern Classic. Phosphor uses its own
single-pass, dithered ambient renderer plus static CSS glass/raster and text
emission, gated by family. It never stacks with Classic Three.js. See
Lifecycle and accessibility behavior is implemented by the theme components.

**Classic:** `client/src/themes/shaders/` - 29 fragment shaders (`.frag.glsl` files imported as strings; plus a shared `util.ts` of GLSL helpers). Themes reference one via `shaderPreset: 'cherenkov'` etc. `ThemedBackgroundShader.tsx` renders the active shader to a fullscreen canvas behind the UI. Canvas opacity is `opacityForPreset(preset)` - the 0.32 default with per-preset overrides (`PRESET_OPACITY`, e.g. `matrix-rain` at 0.6). The bloom-overlay companion canvas (a second WebGL pipeline that ran the same shader through a CSS blur + screen-blend) was removed because its full-screen compositor read-back was the dominant per-frame cost, while the visual change was haze rather than identity. Per-element glow on text/borders/LEDs is pure CSS `text-shadow` / `box-shadow` and continues to work as before.

**Classic shader rule (2026-04-27):** background shaders avoid soft-glow / radial-gradient / breathing-blob layers. 8-bit alpha compositing produces visible posterization rings on smooth low-amplitude gradients against near-black. Use structural elements only - particles, streaks, grids, dots, vein lines, scanlines, hard-edged cells. Vignettes / atmospheric noise washes / orb halos were stripped from every dark-mood shader in the 2026-04-27 pass.

Notable shader-related commits:
- `8a5af37` - switched to `highp` precision and bounded hash inputs to prevent long-uptime freezes (Mali GPU NaN cascade)
- `0691c8e` - toned down background effects across four themes (operator feedback)
- (this commit) - banding-prone radial gradients stripped across all dark-theme shaders; bloom canvas pixel ratio raised 0.4× -> 1.0×; matrix font swap; font-pack override system

CSS animations are gated by data attributes set in apply: `data-anim-scan` / `data-anim-pulseHalo` / `data-anim-flicker`. Each theme opts in.

### Theme switching

`store.setThemeId(id)` is optimistic: applies locally first, then PATCHes `/api/settings`. On failure, reverts.

`store.setFontPackOverride(id | null)` follows the same pattern; passing `null` clears the override.

### Available themes

The picker separates **Arco Classic** (the existing 43 selections including
provider-auto) from **Arco Phosphor** (68 namespaced Phosphor palettes).
Phosphor shares one paint-only CRT treatment, with category/search selection,
independent effects and glow-softness controls, and existing font/brightness/
crisp/frost preferences. No workbench layout or content is rearranged. See
The theme components and settings panel manage integration and deployment.

The 42 (alphabetical by id): abyssal · amber-crt · arch · arrakis · aurora · bloodmoon · blueprint · braun · cassette-futurism · cherenkov · cicada · concrete · copper · cute · dark-academia · dsky · everforest · forest · frutiger-aero · holographic · infrared · kintsugi · lavender · matrix · midnight-tokyo · nebula · night-city · noir · ocean · arco-default · arco-jungle · oscilloscope · red-planet · seismograph · sentinel · solar-paper · sonar · stealth · tarkovsky · ume · unfinished-works · voyager. (`registry.ts` is the live source; it also wires the dynamic `provider-auto` sentinel separately from these named themes.) Red Planet and Everforest provide optional exact xterm Core + ANSI palettes; other themes retain xterm's default ANSI colors while inheriting the app background, foreground, and cursor.

---

## Performance

### Virtualization

`ChatPanel.tsx` uses TanStack `useVirtualizer` to only render visible rows. Resize observer on the inner wrapper auto-scrolls when content grows. Scroll handler uses `pinnedToBottom` ref to avoid per-render effect fires.

### Memoization

- `displayMessages` - gated on `job.sessionChat` and `job.messages` only.
- `visibleRows` / `priorMessageCount` / `handoffCount` - separate memo so the seed-scan doesn't re-run on every message append.
- Module-level streaming state in `ws/streamState.ts` - survives React re-renders within a tab (no per-render Map allocation).
- Empty-attachments singleton (`EMPTY_ATTS = []`) - TerminalInput doesn't re-render when no files are staged.

### Re-render gating

- `TabBar` doesn't remount on per-job state changes; React diffs the `job` prop.
- RightPanel tabs are simple state switches; the active panel re-renders only when its own data changes.
- localStorage writes are debounced to 1 Hz max so worker_activity polls don't thrash.

---

## Right panel tabs

| Tab | Component | Data source |
|---|---|---|
| FILES | `FileExplorer` + a `LIVE` sub-tab (`LiveChangesPanel`, live working-tree subscription via `liveChangesStore`) + a `CHANGES` sub-tab (`ChangesPanel`, A3 whole-tree diff) + a `SOURCE` sub-tab (`WorkingChangesPanel`, I1 per-file grouped changes) + a `REMOTE` sub-tab (`CompareRemotePanel`, I2 local↔upstream ahead/behind + fetch); `BlastRadiusTab` sub-tab when codebase memory attached | `GET /api/files?path=` lazy on expand; `GET /api/workflows/diff` for CHANGES; `GET /api/git/diff` for SOURCE; `GET /api/git/compare` + `POST /api/git/fetch` for REMOTE; `job.config.codebaseMemory` for the BLAST RADIUS nav |
| ACTIVITY | embedded in `RightPanel` | `job.activity` + `job.primaryBackgroundJobs` + `job.turnTokenUsage` ( sticky session-total header + per-turn rows above the live event feed; capped at TURN_TOKEN_USAGE_CAP=200; CLI/Codex render tools as " - " since they don't expose tool_result bytes) + `job.ultracodeFleet` (Ultracode `FleetSection` renders atop the feed when `total > 0` - `⚡ FLEET done/total · N running` + per-agent rows with `lastTool` badges) |
| GENESIS | `GenesisTab` (Creative-mode integration) | `job.genesisSeed` / `genesisReadiness` / `genesisNextPrompt` / `genesisAssist` / `genesisScaffold`. Visible for a from-nothing genesis workflow still in its scratch ideation dir (`/.arco/genesis/`), for **any** real-cwd workflow (to arm Creative mode, `genesis_creative_arm`), and while Creative mode is armed (`genesisCreativeArmed`). Only the scratch case auto-opens it. Seed editor debounces `genesis_seed_update`; field-assist buttons send `genesis_assist_request` and apply proposals through the same seed update path. Working-name assist renders multiple candidate cards and persists shortlist/reject/use history on `genesisSeed.nameWorkbench`. CREATE & SCAFFOLD (operator-confirmed) sends `genesis_scaffold`. GitHub visibility is shown inline (private default, public optional). A fresh genesis workflow with no explicit tab pick defaults to this tab. |
| REVIEW | `ReviewTab` | `job.reviews` + `GET /api/workflows/artifact` for body |
| RESEARCH | `ResearchTab` | `job.research` + `GET /api/workflows/artifact` for the cited report body |
| HANDOFFS | `HandoffsTab` | `job.handoffs` + `GET /api/workflows/handoff` for body |
| PLAN | `PlanTab` (in `RightPanel/`) | `job.plan` + `GET /api/plans` (list with attachments) + `GET /api/plans/body` |
| BAKE-OFF | `BakeoffTab` (in `RightPanel/`) | `bakeoffsByWorkflow[job.id]` via `bakeoff_list` / `bakeoff_state`; candidate patches via `GET /api/git/bakeoffs/diff` |
| KNOWLEDGE | `KnowledgeTab` (+ `KnowledgeWizard`) | per-cwd operator-owned knowledge base; CRUD over `GET/POST/PATCH/DELETE /api/knowledge` |
| TASKS | `TasksPanel` | `job.taskChildren` (only visible when the workflow has Native Task fan-out) |
| LEDGER | `LedgerTab` | cwd-scoped durable project task ledger; mirrors the server's `task_ledger_snapshot` |
| HISTORY | `HistoryTab` | `job.historyEvents` (narrative events derived from the WS stream) |
| USAGE | `UsageTab` | `GET /api/usage-stats?path=<cwd>` (per-provider/per-day token + cache-ratio trends) |
| PREVIEW | `PreviewTab` | `job.preview` + `job.previewHistory` |
| CONFIG | `ConfigTab` (with `CodebaseMemorySection` + `McpRegistrySection` mounted at the end) | `job.config` (incl. `autoHandoff`, `codexTransport`, `codebaseMemory`), `cliChanges`, `settings.codex.appserverWarningSeen` |
| GITHUB | `GitHubPanel` | `GET /api/github/*` proxied via `gh` CLI |

**BAKE-OFF tab.** The form owns a 2-5-row array of shared `RunAsPicker`
selections and sends one `bakeoff_start`. Attempt workflows arrive as normal
jobs, but `workflow_created.backgroundCreated` prevents a batch from changing
the active tab for every leg. `BakeoffTab` can open a leg, fetch its unified
patch into the shared `DiffView`, explicitly promote it, or clean selected
worktrees. `appStore.bakeoffsByWorkflow` is a server-rehydrated projection;
durable truth remains the out-of-repo manifest.

**FILES tab - worktree picker (Workbench I / `WorktreeInfo`).** `useWorktreeSelection` + `WorktreePicker` (shared by `FilesTabBody` + `ClusterFilesTabBody`) resolve which git worktree a worker is editing - AUTO = the worker's active-task worktree from the store `taskLedger` (in_progress preferred; cluster keys by `baseCwd::boardKey`), plus enumerated linked worktrees via `GET /api/git/worktrees` (4s poll). The resolved `effectiveCwd` (`selectedWorktree || autoWorktreePath || baseCwd`) is passed to `LiveChangesPanel` / `ChangesPanel` / `WorkingChangesPanel` / `CompareRemotePanel` (was always `cwd`). The header picker shows when >1 worktree or an auto target exists; main is labelled "tab root" / "cluster root".

**FILES tab - CHANGES sub-tab + the diff renderer (Workbench Expansion A3).** `client/src/components/diff/DiffView.tsx` is a **source-agnostic** unified-diff renderer (`react-diff-view`, themed to CSS vars via `diff-view.css`, unified/split toggle, collapsible per-file): it takes a `patch` string (or pre-parsed `files`) and nothing else - it never imports the endpoint or any "source" concept, so A4 revert, A6/A7 file-edit diffs, D5 inline comments, and all of Part I (Git/GitHub workbench) reuse it unchanged. All data-fetching/source selection lives outside it: `ChangesPanel` (client) calls `GET /api/workflows/diff?wfid&path&from&to`, and `server/src/gitDiff.ts` (via `server/src/http/diffRoutes.ts`) runs the right `git diff` (two shadow `refs/arco/*` refs, or working-tree vs HEAD). The CHANGES sub-tab shows working-tree-vs-HEAD; `GitDialog` shows the same working-tree diff (collapsible) before the commit prompt. The endpoint always answers 200 with `{ patch, isRepo, from, to, missingRef? }` - non-git dirs / missing refs degrade gracefully, never 500.

**FILES tab - SOURCE sub-tab (Workbench Expansion I1).** `client/src/components/diff/WorkingChangesPanel.tsx` is a Source-Control-style file list beside the A3 `CHANGES` tab. It calls `GET /api/git/diff?wfid&path` (no `file`) to list the working tree's changed files grouped **staged / unstaged / untracked**, then on click calls `GET /api/git/diff?wfid&path&file&staged` for that one file's diff and renders it in the **same** source-agnostic `DiffView` (its interface is untouched - still just a `patch` string). Untracked files render as an all-added new-file diff; binary/oversized files show a hint (`binary:true`). Server logic is `server/src/gitWorking.ts` (`getWorkingChanges` parses `git status --porcelain=v2 -z`; `getFileDiff` runs `git diff [--cached] -- <path>` or `git diff --no-index` for untracked) via `server/src/http/gitDiffRoutes.ts`. See `docs/GIT_WORKBENCH.md` for the Part I workbench detail.

**FILES tab - REMOTE sub-tab (Workbench Expansion I2).** `client/src/components/diff/CompareRemotePanel.tsx` sits beside the SOURCE tab and compares the cwd's current branch against its upstream. It calls `GET /api/git/compare?wfid&path` for the **↑N to push / ↓M to pull** summary with an expandable commit list each direction (plus a per-direction diffstat), and `GET /api/git/compare/diff?wfid&direction` for the per-direction patch rendered in the **same** A3 `DiffView` (interface untouched). A **FETCH** button POSTs `/api/git/fetch` (remote-tracking refs only - never merges/moves HEAD) then re-reads the comparison. Non-fatal states (no upstream, detached HEAD, in sync, non-git) each render a plain explanation. Server logic is `server/src/gitWorking.ts` (`getUpstreamComparison`, `getComparisonDiff`, `fetchRemote`) via `server/src/http/gitCompareRoutes.ts`. Read-only except the fetch; the mutating push/pull lands in I3. See `docs/GIT_WORKBENCH.md`.

**FILES tab - Blast Radius sub-tab (Codebase-memory integration).** When `job.config.codebaseMemory?.attached === true`, a `FILES | BLAST RADIUS` sub-tab nav appears at the top of the FILES body (rendered by `FilesTabBody` in `RightPanel/FilesTab.tsx`). `BlastRadiusTab` (`client/src/components/RightPanel/BlastRadiusTab.tsx`) renders `detect_changes` output against the current `git diff` once the spawn-site MCP wiring lands as a follow-up. Today it renders a placeholder; the operator-facing surface (toggle, persistence, smoke) is the codebase-memory deliverable.

**CONFIG tab - `INDEXES & MEMORY` section (Codebase-memory integration).** `CodebaseMemorySection` (`client/src/components/RightPanel/CodebaseMemorySection.tsx`) is mounted at the bottom of `ConfigTab` for every provider (Claude / Codex / etc.) since the MCP is provider-agnostic. Operator toggles attach, types an index path (default = cwd), clicks "Re-index now." The Re-index button POSTs `/api/workflows/:wfId/codebase-memory/reindex` - on 503 (`binary_not_installed`) the existing top-right `NotificationToasts` surface gets a push pointing at `docs/OPERATIONS.md`. The attach toggle dispatches `attach_codebase_memory` / `detach_codebase_memory`; the server's `codebase_memory_state` push mirrors onto `job.config.codebaseMemory` via the `setCodebaseMemoryState` store action.

CONFIG carries a red dot when `cliChanges.length > 0`. The PLAN tab supports attach/detach (`plan_attach` / `plan_detach` WS), inline create/edit (REST `POST` / `PATCH`), mark-complete + reopen + hard-delete (REST `PATCH { completedAt }` / `DELETE`). List view splits active vs completed (collapsed by default) and surfaces "active in <workflowName>" badges per plan; detail view shows a "WORKFLOWS USING THIS PLAN" section with active spans inline + collapsed past spans.

`PlanBodyRenderer` renders the body as preformatted markdown but parses `- [ ]` / `- [x]` lines into clickable checkboxes. Click -> optimistic body update + `PATCH /api/plans { body }` to persist; the server's plan_attached re-broadcast confirms the change. The body fetch only clears the visible body when `plan.id` changes (operator switched plans); on a same-plan refetch (after the agent edited the file -> watcher reconcile -> `updatedAt` bumped) the prior body stays on screen until the new content lands, so the panel doesn't flicker through "loading..." on every agent edit. Tracked via a `lastPlanIdRef` ref.

**Plan-scoped review surfaces (PlanTab).** The Plan tab dispatches plan-scoped reviews via `ReviewDialog` (with `prefilledPlanRef + prefilledScopeLabel`). REVIEW and VERIFY are paired buttons at both plan and phase granularity - REVIEW defaults to `critique` mode (audit the plan itself), VERIFY defaults to `verify` mode with INCLUDE GIT DIFF pre-ticked (audit the claimed-done work against the changes). The dialog's MODE row stays editable for either, and `initialIncludeGitDiff` (a new prop on `ReviewDialog`) lets VERIFY buttons preset the toggle without changing the default for REVIEW buttons.

- `REVIEW PLAN` (top toolbar) -> `kind: 'plan-whole'`, `mode: 'critique'`.
- `VERIFY WORK` (top toolbar, next to REVIEW PLAN) -> `kind: 'plan-whole'`, `mode: 'verify'`, `initialIncludeGitDiff: true`.
- `▷ REVIEW PHASE PLAN` pill (under each `### Phase` heading) -> `kind: 'plan-phase'`, `heading: <H3 text>`, `mode: 'critique'`.
- `▷ VERIFY PHASE WORK` pill (next pill under the heading) -> same `plan-phase` ref but `mode: 'verify'`, `initialIncludeGitDiff: true`.
- `▷ SPAWN PHASE` pill (next pill) -> dispatches `spawn_from_here_request` with `initialDirection = planPhaseSpawnDirection(phaseBlock)`. Not a review; see `docs/PRIMITIVES.md-tab spawn surfaces`.
- `CUSTOM REVIEW` -> opens `PlanReviewPicker`; on confirm, dispatches `kind: 'plan-items'`, `itemIds: string[]` (`${phaseIdx}/${taskIdx}`), `mode: 'verify'`.

H3 heading rows render with the heading on its own line and the three pills stacked below it (REVIEW PHASE PLAN / VERIFY PHASE WORK / SPAWN PHASE) - three pills inline crowded the heading down to one character per line in narrow panels.

The `RightPanel` component threads an `onReview` prop into `PlanTab` so plan-scoped review requests share the same dispatcher as transcript reviews. The dialog renders a second `ReviewDialog` instance keyed to the `reviewPrefill` state, kept separate from the toolbox-button-triggered ReviewDialog. `reviewPrefill` carries `{ ref, label, initialIncludeGitDiff? }` so VERIFY buttons round-trip their git-diff hint into the dialog.

**HISTORY tab.** `HistoryTab` renders a vertical timeline of narrative events derived from the workflow's WS stream. The store builds `job.historyEvents` in `ws/handleServerMessage.ts` via `narrativeEventFromMessage` - a single helper that maps the small set of seq-stamped messages we surface (`user_message_echo`, `primary_complete`, `worker_tool_use[completed|failed]`, `task_started`, `task_status[done|error|cancelled]`, `handoff_artifact_ready`, `review_artifact_ready`, `operator_label`, `checkpoint_created` (-> `checkpoint` row), `leaf_move` (-> `fork` row, carrying `rewindTargetSeq`)) to a `HistoryEventEntry`. Dedup is by `seq` so a snapshot replay that re-emits a line we already received live doesn't double-render. `appendHistoryEvent` caps the buffer at 1000 entries; persistence keeps the last 500 across reloads (replay only resends events with `seq > clientLastSeq`, so a quiet workflow would otherwise come up with an empty timeline).

The tab itself runs four operator actions:

- **LABEL THIS** - inline composer + button. Dispatches `create_label_request` via `wsSendRaw`. Server validates (≤ 200 chars, `targetEventSeq` ≤ head) and broadcasts `operator_label`, which lands back in `historyEvents` like any other event.
- **REVIEW FROM HERE** - opens `ReviewDialog` with `prefilledSinceEventRef`. The locked-scope rendering shows a label like `FROM 07:39:02 - research checkpoint` (or the bare event tag when the anchor isn't a label). Dispatches `review_request` via `wsSendRaw`.
- **SPAWN FROM HERE** - opens the existing `SpawnDialog`; on confirm, dispatches `spawn_from_here_request` via `wsSendRaw` with `cutoffEventSeq` baked in.
- **REWIND CONVERSATION** (see [CHECKPOINTS.md](CHECKPOINTS.md)) - two-click inline confirm (`rewindConfirm` state, no modal; reversible - undo-the-undo is just another rewind). Dispatches `revert_to_point_request { targetSeq }` via `wsSendRaw`, moving the live head back to the selected point and keeping the current branch as a returnable fork (Claude Native only - rejected on CLI/Codex, and disabled while `job.busy`). The resulting `leaf_move` lands as a `fork`-category `HistoryEventEntry` (carrying `rewindTargetSeq`), surfaced under the new REWINDS filter preset.

The filter strip (`FILTERS`, persisted per workflow under `arco.historyFilter.byWorkflow`) presets are: ALL · TURNS · TOOLS · LABELS · HANDOFFS · REVIEWS · CHECKPOINTS (`checkpoint`) · REWINDS (`fork`).

Selection state is local to `HistoryTab`. When the selected event has a `chatMessageId` (today: `user_message_echo` via `clientMessageId` and `primary_complete` via the streamRef-captured passthrough id), `HistoryTab` calls `store.flashChatMessage(jobId, messageId)`. `ChatPanel` subscribes to the top-level `flashTarget` state, finds the matching row in `visibleRows`, calls `virtualizer.scrollToIndex(idx, { align: 'center' })`, and applies a 2 s outline to the row wrapper. Filter-strip selection persists per workflow under `arco.historyFilter.byWorkflow`.

**Label rows** carry `anchorSeq` (the event the operator pinned to) and `pinnedAt` (wall-clock when the label was created). The store's `appendHistoryEvent` sorts entries by `anchorSeq ?? seq` with a tie-break that places labels after their anchor, so a label slots in beside the row it points to instead of at the bottom by its own (high) seq. The label's `at` is resolved from the anchor row's timestamp at append time; the timeline row renders a `(pinned HH:MM:SS)` sub-line when `pinnedAt !== at` so both timestamps are visible.

**Review rows** carry `reviewArtifactName` when the artifact was written (failed reviews don't). Clicking a `REVIEW <verdict>` row opens `FileViewerModal` with `path = <cwd>/.arco/workflows/<wfid>/artifacts/<artifactName>` and `fallback={cwd, workflowId}` (the artifact-dir retry handles edge cases where the literal path 404s).

**Chat-row injection.** `ws/handleServerMessage.ts` injects two system rows into chat for each review (mirroring the existing Handoff pattern): `[REVIEW] Running review (...)...` on `review_started` and `[REVIEW <verdict>] <artifactName>` (or `[REVIEW] Failed - ...`) on `review_artifact_ready`. Without this, the dialog would close silently and the verdict only appeared in the REVIEW + HISTORY tabs - easy to miss.

---

## Dialogs

- **`PlanComposerDialog`** - opens from PLAN button in the composer. Two paths, both inject the same synthesize-from-context prompt: "Draft -> I'll review" arms `pendingPlanCapture: 'review'` (banner offers SAVE & ATTACH / DISCARD on the next primary_complete); "Draft & auto-save" arms `'autosave'` (banner self-fires the save and clears). Title is extracted from the captured body via `# Heading` -> first non-empty line -> `Plan from <date>` fallback.
- **`PlanCandidateBanner`** (between chat and composer) - renders only when `job.planCandidate` is set. Captures from the latest finalized assistant message in `job.messages` at `primary_complete` time. `turn_cancelled` clears `pendingPlanCapture` so a stale flag doesn't capture an unrelated later reply.
- **`ReviewDialog`** - opens from REVIEW button. Picks reviewer (provider/model/effort, including `llamacpp`), scope (`last-turn` / `last-n` / `current-session` / `full` / `git-diff`), include-git-diff. Sends `review_request`. **Plan-scoped variant:** when `prefilledPlanRef + prefilledScopeLabel` props are set (from `PlanTab`), the SCOPE row collapses to a locked label ("PLAN: ...") and a MODE row (VERIFY / CRITIQUE) appears. **Since-event variant:** when `prefilledSinceEventRef` is set (from `HistoryTab`), the SCOPE row collapses to a locked `FROM hh:mm:ss - <label>` chip and the plan-mode picker is hidden. The Claude model row reads the live polled `claudeNativeCatalog` when present (with display names + per-model effort gating), falling back to the static `CLAUDE_MODELS` aliases when no Native auth has fetched a catalog yet - same pattern as `WorkflowCreator`. A useEffect clamps the model state to a value in the current pill set (catches the dialog opening before catalog arrives, then reconciling once it lands). VERIFY WORK / VERIFY PHASE WORK pass `initialIncludeGitDiff: true` so the toggle pre-ticks; default-undefined leaves it off for plain reviews.
- **`PlanReviewPicker`** - tree-with-checkboxes modal opened by `CUSTOM REVIEW` in the Plan tab. Tri-state per-section checkboxes, SELECT ALL / ALL CHECKED / CLEAR shortcuts. Mirrors the server's task-detection rules (CHECKBOX_TASK_RE, NUMBERED_TASK_RE, H2 reset) so what the picker shows is exactly what the reviewer will receive. Returns `${phaseIdx}/${taskIdx}` IDs to the parent.
- **`HandoffDialog`** - opens from HANDOFF button. Picks mode (`original-worker` / `fresh-summarizer`), optional newPrimary swap. Sends `handoff_request`.
- **`SpawnDialog`** - opens from SPAWN button. Pre-fills parent config, lets operator override + add a `new direction:` prompt. Sends `spawn_from_here_request`. New tab auto-activates on completion.
- **`DocsUpdateDialog`** - opens from `✎ DOCS` composer button. Sends a structured prompt to update repo markdown docs (README / DEVLOG / AGENTS.md / `docs/**/*.md`). Hard-coded constraint: agent must not modify anything under `.arco/plans/`. Optional operator note. Embeds `RunAsPicker`; routes via `onConfirm` (in-tab) or `onSpawn` (new tab) based on the picker selection.
- **`GitDialog`** - opens from `⎇ GIT` composer button. Live git status (current branch, ahead/behind, dirty count) fetched on open via `GET /api/git/status`. Branch dropdown + inline `+ NEW BRANCH` form (server-side dirty-tree refusal on switch via `POST /api/git/checkout`). Action picker (commit / commit-push / commit-push-pr); PR auto-disabled with no GitHub remote; smart default `inferDefaultAction(status)`. Protected-branch warnings via `/^(main|master|release\/.*|prod|production)$/i`. Per-repo localStorage prefs at `arco.gitDialog.prefs.${cwd}`. Builds a structured prompt with branch context, action steps, pause-and-ask rules, expected deliverables. Embeds `RunAsPicker` for in-tab vs new-tab routing.
- **`RunAsPicker`** - shared provider/model/effort picker used by `GitDialog` and `DocsUpdateDialog`. Compares its selection against the parent's current primary; if matched, dialog dispatches in-tab via `onConfirm(prompt)`; if changed, dialog calls `onSpawn(spawnConfigFromRunAs(parentConfig, runAs, suffix), prompt, false)`. The `spawnConfigFromRunAs` helper inherits the parent config but overrides primary fields, suffixes the workflow name, and clears `resumeSessionId/resumeWorkflowId` so the new tab is fresh. Reset arrow snaps back to the current primary. ReviewDialog and SpawnDialog have their own embedded pickers and could adopt this shared component to dedupe ~80 LOC each.
- **`LlamacppCatalogEditor`** - embedded in `SettingsPanel` when llama.cpp is enabled. Wholesale-replace pattern (fetch full catalog, edit in-place, POST entire new catalog) - same as `models.md` editor. Exposes per-row alias / ggufPath / mmprojPath / ctxSize / ngl / capability flags. Per-row Load / Unload buttons hit the lifecycle manager (`POST /api/llamacpp-load`, `POST /api/llamacpp-unload`); "Load now" pre-warms the binary so the next workflow turn doesn't pay the 20-30s cold-start. Preserves `chatTemplate` and `extraArgs` across edits even though the form doesn't expose them.
- **`FileViewerModal`** - opens from clicking a file path in a tool-call pill or the file explorer. Portaled to `document.body` via `createPortal` so `position: fixed` escapes the chat virtualizer's transformed ancestor. Hosts the A6 editor (`editor/CodeEditor.tsx`, a CodeMirror 6 wrapper) under EDIT/LOCK + SAVE, and - when opened with an `editContext.workflowId` - the **A7 AI-edit affordance** (below).
- **`Cookbook/CookbookModal.tsx`** (Workbench Expansion G2) - the fit-scored local-model catalog. Triggered by the header **⚙ COOKBOOK** button (`SystemHeader.tsx`) via the **`open` flag in `stores/cookbookStore.ts`** (a dedicated store kept out of appStore, mirroring `recallStore`/`terminalStore`/`docEditStore` - the catalog is a global on-demand HTTP projection, not per-tab state, and the modal is mountable independent of props). On open it `fetchHardware` (the header rig strip + RESCAN, hitting `GET`/`POST /api/cookbook/hardware`) and runs an empty `search({})` (the trending-that-fits feed). Filter changes re-query via `GET /api/cookbook/catalog` (text debounced 350ms; selects fire immediately). Sub-components: **`CatalogFilters.tsx`** (free-text search / task / quant preference / hardware-sim preset `?sim=`), **`CatalogTable.tsx`** (the FIT·MODEL·PARAM·QUANT·VRAM·CTX·SPEED·SCORE·MODE columns, sorted by SCORE, FIT coloured green/amber/red; expand a row -> HF/Ollama link + backend badge + the **inert** Download/Run/Configure buttons), and **`fmt.ts`** (byte/ctx/tps formatters + the verdict palette). **G2 is read-only:** every call is a GET (or the explicit RESCAN POST); the action buttons are disabled placeholders wired in G4.
- **`editor/AiEditAffordance.tsx`** (Workbench Expansion) - AI-collaborative document editing, mounted as an overlay inside `FileViewerModal`'s edit body (kept OUT of `FileViewerModal` per the spec's file-size note). On a non-empty editor selection (or **SELECT ALL** for a whole-doc edit), **✦ ASK AI** opens an instruction box + the **reused `RunAsPicker`**; **PROPOSE EDIT** fires `doc_edit_request` (in-tab only - the proposal must round-trip to THIS buffer). The `doc_edit_proposed` event lands in the standalone **`docEditStore`** (`stores/docEditStore.ts`, kept out of appStore like recallStore/terminalStore; `useWebSocket` registers a module-level sender so the deep-nested modal needn't thread the callback through every call site). The proposal previews as an A3 **`DiffView`** (`selectionBefore` vs `replacement`, built into a unified diff via `diff`'s `createTwoFilesPatch`). **ACCEPT** calls `CodeEditor`'s imperative `spliceSelection(from, to, replacement)` to splice into `[from,to)` of the **buffer only** - the existing **SAVE** is the one disk write, through the `resolveWithinCwd`-guarded `/api/files/write`. **REJECT** discards. The selection is surfaced by a new `CodeEditor` `onSelectionChange` prop; the splice/select-all/doc-length ops via a `forwardRef` `CodeEditorHandle`. Fence: the agent has no Write tool and never touches disk - operator approves twice (Accept into buffer, Save to disk).
- **`media/MediaModalHost.tsx`** (Workbench Expansion+) - the Media studio modal: the shared shell hosting the image , audio , and video  editors, all of which now exist. Mounted in `App.tsx` on the `appStore.mediaStudio.open` flag (companion state `{ open, path?, mode? }` + `setMediaStudio`, mirroring `showCookbook`). Two entry points: **standalone** (header **⌗ MEDIA** button + the `Open Media studio[...]` command-palette entries -> opens empty in a mode) and **contextual** (FileExplorer right-click -> opens with an on-disk path routed to the matching mode). Both go through **`media/launchers.ts`** - `openMediaStudio(mode?)`, `openMediaFile(path)`, and `classifyMediaExt(filename)` (image/audio/video by extension). **Image mode** mounts **`media/ImageEditor`** (a React wrapper around the vendored Odysseus raster editor at `client/src/vendor/odysseus-editor/`, bridging LOAD + SAVE to guarded endpoints). **Audio mode** renders **`media/AudioEditor`** (waveform + region select; see below) with the ffmpeg-backed clip/convert ops in **`AudioOpsPanel`**. **Video mode** renders **`media/VideoEditor`** (HTML5 `<video>` preview + scrub + in/out markers) with **`VideoOpsPanel`** for clip/convert/extract-audio. On-disk media (audio/video) streams through the guarded **`/api/media/raw`** Range route so the browser can seek; imported files use a browser object URL (revoked on unmount/replace), and on-disk images still load via the same `GET /api/file-content` fetch `FileViewerModal` uses. Honest-scope notes live in each component's header comment + the manual section. Shared op-posting helpers live in `media/postMediaOp.ts`; advanced/stems controls in `MediaAdvancedOps.tsx` / `MediaStemsControls.tsx` / `MediaSaveControls.tsx`.
- **`media/AudioEditor/AudioEditor.tsx`** (Workbench Expansion) - the audio editor that replaces the bare `<audio>` for imported audio. Props `{ src; filename?; onRegionChange?(start, end) }` where `src` is the **same object URL** the host already owns (no second URL; the host still owns revocation). Built on **`wavesurfer.js`** (v7, **BSD-3-Clause**; client workspace only) - waveform + transport from core `WaveSurfer`, region select from its regions plugin (`wavesurfer.js/dist/plugins/regions.esm.js`). The `waveColor`/`progressColor`/`cursorColor` are resolved from the `--color-*` CSS vars at init (canvas can't read CSS vars live). Transport = play/pause + `mm:ss.mmm` time readout; click the waveform to seek. One region with draggable in/out handles + editable `IN`/`OUT` numeric fields that two-way-bind to it; every in/out change fires `onRegionChange` - the **clip seam H6 reads** (the host stashes the latest value in `audioRegionRef`). **React lifecycle:** the `WaveSurfer` instance is created in a `src`-keyed `useEffect` and `destroy`-ed in cleanup, with a `disposed` flag aborting late async handlers so StrictMode's double-mount can't leak an instance or double-init the container. Clip/convert (FFmpeg) is H6 - the editor records the selection but performs no edit yet.
- **`WorkerDetailModal`** - opens from clicking a `WorkerCard` chip in the right-pane Activity / Reviews / Handoffs tabs. Shows full output, tokens, status, errors. `WorkerCard` itself is a compact summary chip (model/effort/elapsed/verdict) that's rendered in those tabs.
- **`ArtifactModal`** - for inline artifacts (confirm / choice / image). Has a response composer that sends a `[artifact:<id>] <answer>` follow-up to the primary.
- **`ConversationMenu`** - `CTX ▾` menu in the chat header. New / resume / compact / export. The **RESUME SESSION...** view  merges discovery (`/api/sessions`) with the session-index projection (`/api/session-index`) by the `(provider, sessionId)` key, rendering rich rows (layered title + subtitle + provider/account tag + relative last-active) with operator **pin** (★, sorts to top), **rename** (✎, inline input -> `operator` title that survives refreshes), **archive** (⊘, hidden behind the ARCH toggle), and a live **filter** box. Index data + the rename/pin/archive mutations live in the standalone `stores/sessionIndexStore.ts` (kept out of `appStore`, mirroring `recallStore`); each mutation POSTs to `/api/session-index/*` and folds the server's returned entry back. Live `waiting/running/idle` + context/quota columns are a documented deferral (see `docs/RESUME_INDEX.md in H3`). See `docs/RESUME_INDEX.md`.
- **`AskUserQuestionNotice`** - inline reply form rendered by `ChatMessage` when it detects the `[ASK:claude-native:<questionId>]` sentinel a Native worker emits via `system_notice`. Renders a text input or option chips based on the `[ASK_OPTIONS:opt1 | opt2]` line; submits `ask_user_question_reply { workflowId, questionId, reply }` and the worker resolves the awaiting tool-result Promise.
- **`TaskCard`** - compact card rendered inline on the parent's `Task` tool_use chat row when `job.taskChildren[taskId]` exists. Shows status (`running` / `done` / `error` / `cancelled`), elapsed time, child workflow id, and a `PROMOTE` button to flip the child into the top tab strip. Native injects a synthetic message at the tool_use position because Native has no JSONL; CLI tabs use the existing tool_use entry from `sessionChat`.
- **`TasksPanel`** - the TASKS right-panel tab. Reads `job.taskChildren` keyed by `taskId` and renders one row per child workflow with status glyph + colour, child wfid, description, and elapsed time. Visible only when the map is non-empty (depth-1 cap; child workflows have no Task children of their own).
- **`AttachmentPill`** + **`TokenBadge`** - small inline chips. AttachmentPill (composer + chat) opens an uploaded file in `FileViewerModal`. TokenBadge shows per-worker `ctx / out` token counts. (Throttle state from `quota_status` renders in `WorkflowStatusChip`; the standalone `QuotaBadge` is gone.)
- **`TranscriptSendDialog`** (2026-05-11) - opens from the `-> TRANSCRIPT` composer button on any cluster member tab (gated on cluster membership + ≥1 peer). Lets the operator pick a recipient peer + scope (`Last turn` / `Last N turns` / `Full transcript`) and fires a single `operator_peer_send` WS message. Scope slicer walks back through `messages` by `role === 'user'` boundaries; `formatRow` strips `ctx-divider` rows, tool pills, and pure-metadata system pills (single-line `[TAG] short text` shape) but keeps substantive multi-line system content (inlined review bodies, AUTH detail with detail). 32 KB cap (matches server-side `OPERATOR_PEER_SEND_MAX_BYTES`); preview pane shows live byte count + warns at cap. Server bypasses budget + dedupe (operator intent is explicit) - see `PRIMITIVES.md transcript-send`.
- **`MailboxModal`** (2026-05-11, `client/src/components/ClusterRightPanel/MailboxModal.tsx`) - opens from the MAILBOX sub-tab row click. Lists pending peer messages addressed to the picked member, with a per-row CANCEL button that hits `DELETE /api/clusters/:id/mailbox/:wfid/:msgId` to discard before the recipient drains. Server fires `notifyClusterStateForWorkflow` post-delete so the depth chip drops without a refetch. Delivered messages live in `events.jsonl` and aren't reachable here - modal only mutates the transient mailbox file layer. **** each pending message carries a `TASK` button (`onMakeTask`, mounted only when the cluster's `taskBoardMode !== 'none'`) promoting it to a board task. (`ClusterRightPanel` is now a **directory** - `index.tsx` is the panel; sub-tabs / modals split into sibling files: `MailboxModal.tsx`, `ClusterReviewsList.tsx`, `MemberRow.tsx`, `AddWorkerSection.tsx`, `ClusterHandoffsTab.tsx`, `EfficiencyControl.tsx`, `types.ts`.)
- **`ClusterReviewRow`** (2026-05-11, the `ClusterReviewRow` component in `client/src/components/ClusterRightPanel/ClusterReviewsList.tsx`, used by the `ClusterReviewsList` list) - replaces the old expand-only Reviews row. Status pill + reviewer header; CANCEL button on in-flight rows (wires `onCancelReview(workflowId, reviewId)`); click anywhere on the row to fetch the artifact body via `/api/workflows/artifact` and inline it. Refetches on every open + on the completion transition (`completedAt` keys the effect) so a streaming snapshot is replaced by the final body when the reviewer settles.

---

## Overlays

These are full-screen gates that block UI when something critical is happening:

- **`SyncingOverlay`** - fires when WS is up but persisted jobs haven't received their snapshot.
- **`AuthOverlay`** - fires when no primary-capable provider is authed.
- **`ShutdownOverlay`** - fires on `shutdown` message until reconnect.
- **`DuplicateTabOverlay`** - fires when another Arco tab is already alive.
- **`DragOverlay`** - fires during file drag-over (composer attachment hint).

**Command palette (`CommandPalette.tsx`, Workbench Expansion A5).** A `Cmd/Ctrl+P` fuzzy palette mounted in `App.tsx` (the hotkey `preventDefault`s so it doesn't trigger the browser Print dialog; Esc closes, arrows/Enter navigate). Four live sources: (a) active-workflow transcript rows - activating one switches tab + calls the existing `flashChatMessage` which drives `ChatPanel`'s virtualizer `scrollToIndex`; (b) top-level files under cwd (`GET /api/files`); (c) open workflows/tabs; (d) commands (new tab / Settings / Manual / GitHub). Fuzzy matching is a hand-rolled subsequence scorer (no `fuse.js` dep). **Content search** is a separate server path: the palette can query `GET /api/search/content?wfid&q` -> `server/src/contentSearch.ts` `searchContent` (a reusable `rg --json` engine, decoupled from HTTP so F3/Recall reuses it; respects `SKIP_DIRS`, degrades to `{available:false}` when `rg` isn't on PATH); content hits open in `FileViewerModal`. (Deferred niceties: recursive file walk, line-anchored viewer scroll.)

**Compare primitive (`components/compare/`,).** A bounded fan-out-and-vote surface: the operator types ONE prompt and picks N legs (each a `{provider, model, effort}` via the shared `RunAsPicker`), runs them in parallel as read-only/no-tools jobs, and votes a winner. State lives in the standalone **`stores/compareStore.ts`** (kept out of `appStore`, like `cookbookStore`/`docEditStore`/`recallStore`), driving two globally-mounted App.tsx surfaces: **`CompareDialogHost`** (wraps `CompareDialog` - the prompt + per-leg `RunAsPicker` rows + a `blind` flag that hides leg identities until the vote) and **`CompareOverlay`** (the live run - **`CompareGrid`** of side-by-side answer panes cloned from `MemberPane`'s structure, plus **`CompareVote`** which reveals the winner and offers a synthesize step). Launched from the **COMPARE** button in `TerminalInput` (wiring in `components/terminalInput/compare.ts`); `COMPARE_MIN_LEGS`/`COMPARE_MAX_LEGS` from `@arco/shared` bound the leg count. See `docs/PRIMITIVES.md` / `docs/PROTOCOL_PRIMITIVES.md`.
---

## Hooks

`client/src/hooks/`:

- `useWebSocket` - the persistent WS connection (covered above).
- `useTabSingleton` - BroadcastChannel coordination to prevent duplicate tabs.
- `useTension` - a single scalar in `[0, 1]` derived from app state (disconnect / failed-worker / busy load), used to drive ambient UI intensity; `useTensionDriver` is the App-level writer.
- `useCodexCatalog(accountRef?)` - resolves the per-account Codex catalog from `codexCatalogByAccount`, falling back to `codexCatalog` (entitlements differ per HOME/WORK profile).
- `useProjectTrust` - DD7 client over `GET/POST /api/project-trust`; backs the Settings PROJECT TRUST section, the per-tab CONFIG row, and the cluster header chip (trust is keyed by cwd, so one decision covers every tab on that repo).
- `useTemplates` - CRUD over `GET/POST/DELETE /api/templates` (`~/.arco/templates.json`); backs `TemplatePickerRow` in the single-tab creator.
- `useClusterPresets` - CRUD over `GET/POST/DELETE /api/cluster-presets` (`~/.arco/cluster-presets.json`); backs `ClusterPresetsRow`.

The 2/3 - 1/3 split-width persistence and the composer file-drop handler are **inline in their owning components** (`WorkflowView.tsx` reads/writes the split fraction directly to localStorage; drag-over hint state lives in the composer + `DragOverlay`), not extracted into hooks.

---

## Utilities

`client/src/utils/`:

- `chatText.ts` - `cleanPrimaryText` strips internal JSON blocks (worker specs, state mutations, verdicts, arco-artifact frames) from rendered chat. The original text stays in `--resume` context.
- `linkify.tsx` - bare URLs in text become clickable. Used for operator + system messages (assistant content goes through markdown which handles its own linking).
- `modelCatalog.ts` - the one provider -> model-list resolver for every dialog picker (RUN AS, Review, Handoff, Spawn, cluster fresh-spawn, tab context menu): live catalog first, static fallback second. Replaced per-dialog `modelsFor` copies that drifted (Review/Handoff rendered an empty MODEL row for Cursor).
- `gateArgs.ts` - DEBAG gate arg helpers (`buildGateFinalArgs` / `renderGateArgs`).
- Also here: `format.ts` (effort/model helpers incl. `effortsForModel` / `clampEffortForModel`), `historyEvents.ts` (`narrativeEventFromMessage` helper for the HISTORY tab), `operatorLabel.ts`, `rafThrottle.ts`, `themeScramble.ts`; `codexEfforts.test.ts` pins the Codex effort allowlist.

---

## Adding a new component

1. Create the file under `client/src/components/`.
2. Use role-based CSS vars for all colors (`var(--color-accent-primary)`, etc.). Never hard-code hex.
3. Use `var(--font-display)` for terminal/UI labels (small caps, letter-spaced) and `var(--font-body)` for prose.
4. If the component needs job state, take the active job from the store via `useAppStore((s) => s.jobs[s.activeJobId!])` or pass as prop.
5. If the component fires WS messages, accept them as callback props from `WorkflowView` rather than calling `wsRef.current.send` directly. Keeps the dispatcher consolidated.

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for the full dev workflow.

---

## Cluster tab rendering

Cluster tabs are a third top-level view alongside `WorkflowView` and `WorkflowCreator`. App.tsx routes between them via mutually-exclusive store fields: setting `activeJobId` clears `activeClusterId` and vice-versa. The cluster mirror lives at `appStore.clusters: Record<clusterId, ClusterStatePayload>`, populated on `cluster_state` / `cluster_created` push and persisted alongside `jobs` so a reload survives.

**Composition:**

```
ClusterTab (App.tsx routes here when activeClusterId set)
├── horizontal flex of MemberPane[] (left, scrolls horizontally past 4)
│   └── MemberPane (per cluster.members[i])
│       ├── identity strip (display name + busy/idle pill + tab name)
│       ├── ChatPanel  (existing component, reused as-is)
│       └── TerminalInput  (member composer + per-member primitives)
├── ClusterRightPanel (right; width persisted, fraction clamped to [0.18, 0.5], default 0.28)
│   ├── WORKSPACE group - MEMBERS (rows + role/tier/focus/rename/add-worker) and FILES (cluster.cwd)
│   ├── AGENT group - ACTIVITY, REVIEWS, HANDOFFS, PLAN, BOARD, MAILBOX
│   ├── MEMORY group - HISTORY (anchored to the first member's workflow history)
│   └── RUNTIME group - PREVIEW (first-member anchor), CONFIG (member selector + ConfigTab), GITHUB (cluster.cwd)
└── sticky broadcast composer (bottom)
    └── on submit: cluster_broadcast WS message + local toast
```

**Why ClusterRightPanel replaces RightPanel.** Per-member RightPanel toggles (FILES / ACTIVITY / REVIEW / HANDOFFS / PLAN / TASKS / HISTORY / PREVIEW / CONFIG / GITHUB) are scoped to a single workflow; in a cluster they multiply confusingly across panes. The cluster's single right-pane focuses on cluster-level state - members, the shared mailbox, the shared plan, interleaved activity, cluster-wide reviews - plus a few cluster-scoped reuses of single-workflow tabs (GitHub / Files keyed to `cluster.cwd`; History / Preview anchored to the first member where the underlying wire is workflow-scoped). CONFIG is intentionally **member-scoped** inside the cluster panel: the operator picks a member, then the existing `ConfigTab` edits that workflow through the normal `update_primary_config`, codebase-memory, and MCP registry paths. There is no hidden "cluster config" write that mutates all members.

**Peer-message rendering.** The store extends `ChatMessage.role` with `'peer-sent' | 'peer-received'` synthetic variants. `ws/handleServerMessage.ts` injects a synthetic ChatMessage entry on every `peer_message_sent` / `peer_message_received` event; `peer_send_rejected` becomes a `[PEER] Send rejected -> <to> (<reason>)` system row. `ChatMessage.tsx` renders these via a `PeerMessageBlock` early-return branch - colored left-border + sender label, color via stable djb2 hash of `senderWorkflowId` over an 8-color palette. Same sender = same color across the cluster. The rendering branch sits before the system-notice / handoff-seed / spawn-seed branches; ordering is load-bearing.

**Broadcast composer ergonomics.** One textarea + BROADCAST button at the bottom of `ClusterTab`. Enter submits (Shift+Enter newlines); on submit, the composer dispatches `cluster_broadcast`, snapshots the busy/idle split locally, and renders one of two toasts: `"Sent to all M members"` (no busy members at submit) or `"Queued for K of M members"`. The toast is local to `ClusterTab` and intentionally doesn't dispatch a store action for `cluster_broadcast_dispatched` - co-located is simpler. The server-authoritative reply is read for the `failed[]` array if a future surface needs it.

**Broadcast recipient picker (2026-05-11).** A chip row sits above the textarea - one chip per cluster member, click toggles inclusion. Default state: all-selected (every chip on); when every chip is on the wire shape omits `recipientWorkflowIds` so the legacy "send to all" path is preserved. Each chip carries the member's role badge (`presetForText`-resolved preset label, or `CUSTOM` for free-form roles) plus a status dot (warning while busy, accent while idle). Placeholder + toast read `X of N members` to confirm scope before/after send. State lives in `ClusterTab`-local `recipientSelection: Set<string> | null` (null ≡ all).

**NUDGE button + modal (2026-05-11).** Separate from BROADCAST. NUDGE sits next to the BROADCAST button; click opens a per-cluster modal with a checkbox list of every member (default selection is **empty** - operator must pick recipients explicitly; this is intentional so reflex-clicking can't fan out to everyone). Each row shows the member's role chip, busy badge, and current mailbox depth (`3 MAIL`). The SEND NUDGE button is disabled until ≥1 member is picked; on submit, the modal fires the same `cluster_broadcast` wire shape as the composer with the canned prompt `"(nudge) Check your mailbox for any pending peer messages and continue with your assignment."` and the picked `recipientWorkflowIds`. Esc / clicking outside closes without sending. Modal state lives in `ClusterTab`-local `nudgeSelection: Set<string> | null` (null ≡ closed).

**AUTO-PICKUP toggle (2026-05-11).** Operator-armed per-cluster chip in `ClusterRightPanel`'s header, next to the MAIL ALERTS chip. Default OFF. Click flips `cluster_auto_turn_toggle` on the wire. When ON, the server-side detector (`server/src/clusterAutoTurn.ts`) fires a single synthetic primary turn on any currently-idle recipient that gets a `peer_message_sent`, with three guards (per-recipient cooldown, per-cluster rate cap, chain-depth cap). Distinct from the idle nudger: the nudger is toast-only and never sends prompts to workers; AUTO-PICKUP dispatches actual turns. See `PROTOCOL.md_auto_turn_toggle` and `GOTCHAS.md mode` for guard details.

**Tab strip.** `TabBar.tsx` renders cluster tabs after all workflow tabs with a `[N]` member-count badge. Right-click on any Native Claude tab opens `TabContextMenu` (a new component scoped to this single use) with "Add to cluster with..." + a multi-select checkbox list of other Native Claude tabs in the same cwd. Confirm dispatches `cluster_create`. × on a cluster tab confirms tear-down via `cluster_delete`.

### Tab bar layout (slice 6a)

**Two rows.** Top row mixes clusters + standalone workflow tabs (member workflows hidden - they live in the bottom row). Bottom row renders only when a cluster is the active tab; lists that cluster's members, indented 24 px under the cluster tab, with a dimmer style. Bottom row collapses to nothing when a standalone tab is active.

**Cluster naming.** `clusterDisplayName(cluster)` (exported from `TabBar.tsx`) returns the operator-set `cluster.name` when present, else derives `<basename(cwd)> · <short-id>` (e.g. `Kestrel · 82e46640`). The default is computed at render time, never persisted. Operator-set names live on `ClusterStatePayload.name` / persisted to `~/.arco/clusters/<id>/meta.json`. The rename UI lives in `ClusterRightPanel`'s Members tab header - pencil button toggles an inline editor; ↵ commits via `cluster_rename` WS, Esc cancels, empty string clears back to the derived default.

**Drag-reorder.** `@dnd-kit/core` + `@dnd-kit/sortable` + `@dnd-kit/utilities`. Top row only this slice (bottom-row member ordering is fixed at cluster-meta order; reorder there is polish). `DndContext` with a `PointerSensor` (4 px activation distance - under that threshold, click-to-activate still wins over drag start). `SortableContext` with `horizontalListSortingStrategy` wraps the top row. Each tab is a `useSortable` consumer; the whole tab is the drag handle. Close × and activate buttons stop pointer-down propagation so they still receive clicks. On `onDragEnd`, `arrayMove` produces the new order; `setTabOrder` (in `appStore`) optimistically writes the local store and POSTs `/api/settings`. On client load, `applyTabOrder(items, settings.tabOrder)` sorts known IDs first; unknown IDs (newly-created tabs not yet in `tabOrder`) append in their original creation order.

**Bottom-row mechanics + grid card click.** Click a member tab in the bottom row OR click any `MemberCard` in the grid -> both call `setClusterFocusedMember(clusterId, workflowId)` updating `appStore.clusterFocusedMember[clusterId]`. The cluster tab stays the active top-row tab; only the focused detail MemberPane changes. Three visual surfaces subscribe to the same key so they stay in sync: bottom-row tab (accent border-bottom + bg tint), the corresponding `MemberCard` in the grid (accent outline at the same border thickness as unfocused so swapping focus never shifts neighbouring cards), and the single detail `MemberPane` (accent header + outline). First-render default in `ClusterTab` picks `cluster.members[0]`; `setClusterState`'s reducer carries focus across membership changes (re-pinning to the first member when the previously-focused workflow is removed).

**Grid splitter.** The `ClusterTab` body splits horizontally between the `MemberCard` grid (left) and the focused detail `MemberPane` (right) via a 4 px col-resize divider. Drag fraction reads from `appStore.clusterGridSplit` (default 0.35; persisted via the existing zustand-persist `partialize`). The drag handler mirrors `WorkflowView.tsx`'s splitter cleanup contract - `mousemove` updates a local live-value, `mouseup` (+ capture-phase pointerup + pointercancel + blur + visibilitychange) commits to the store and clears `body.style.userSelect / cursor`. Min widths: 240 px grid, 360 px detail. Cards-per-row is `clamp(ceil(sqrt(N)), 1, 4)` so 2 -> 2, 3-4 -> 2×2, 5-6 -> 3×2, 7-9 -> 3×3, 10+ -> 4 cols max with vertical scroll. See [PROTOCOL_CLUSTER.md](PROTOCOL_CLUSTER.md) for the cluster message details.

**Member-remove ×.** Bottom-row × on a member tab confirms then dispatches `cluster_member_remove`. Server-side: detach + tear down workflow in one operation (single click = "I'm done with this member"). If detaching drops the cluster below 2 members, `clusterStore.removeMember` collapses the cluster - server fans out `cluster_deleted`, and the now-orphan member's workflow is also torn down. The other member(s) become standalone workflows on their next turn (peer tools disappear from their tool list the invariant).

**Per-member primitive bar.** `MemberPane.tsx` now renders `TerminalInput` with `onReview / onHandoff / onSpawn / onRecalibrate / onUpdatePrimary / onArmPlanMode` threaded App -> ClusterTab -> MemberPane. Each handler closes over the member's `workflowId` at the App level (mirrors how `WorkflowView` keys primitives on `activeJob.id`). Behavior is unchanged from the standalone primitive bar - the cluster-aware shape (HANDOFF preserves cluster membership, SPAWN-into-this-cluster as a default option, REVIEW understands peer rows) is described in the cluster primitive reference and now shipped.

**`MemberCard` two-line header.** Line 1 = busy/idle dot + friendly name + `IDLE` / `BUSY` tag. Line 2 = wfid 8-char prefix + optional role chip. Friendly name resolves to `wf.config.name?.trim || workflowId.slice(0, 8)` - operator-renamed members surface the rename here, the rest fall back to the wfid prefix. The role chip uses `presetForText` from [`shared/src/clusterRolePresets.ts`](../shared/src/clusterRolePresets.ts) to label known preset bodies (DIRECTOR / BUILDER / REVIEWER / RESEARCHER / TESTER); free-form text labels as `CUSTOM`; an empty role hides the chip entirely. Auto-scroll-to-bottom on `bodyText` change is unchanged from the cluster grid pass.

**MEMBERS sub-tab - role preset popover.** Replaces the inline role editor that used to mount under each `MemberRow`. The popover is anchored to the row's `SET` button; renders the six preset rows + `CLEAR` + `Custom...`. The Custom... branch falls back to the inline editor (same textarea + commit semantics as before). Click-outside + Esc close the popover; both listeners attach only while open (no global leak). On commit the row shows `ROLE <preset.label>` for a preset or truncated text for custom; the button flips to `EDIT`. `EDIT` reopens the popover with the matching preset highlighted via `presetForText` (returns undefined for free-form text -> Custom... is highlighted instead).

**MEMBERS sub-tab - rename pencil.** Pencil affordance next to each member's name opens an inline editor. Commit fires `rename_workflow` via the new `renameWorkflow` helper on `useWebSocket`; empty commit clears the name (member reverts to its wfid 8-char prefix on the next `cluster_state` push). The 64-char cap is enforced server-side - see [`PROTOCOL.md_workflow`](PROTOCOL.md).

**MEMBERS sub-tab - replacement and access posture.** Each `MemberRow` has a
REPLACE control that opens provider/model/effort/account selectors, STANDARD /
BLIND / ISOLATED posture pills, and independent prior-history / active-task
transfer checkboxes. The dialog states that every replacement gets a new
workflow/provider session. ISOLATED forces Claude Native and disables both
transfer checkboxes. `AddWorkerSection` exposes the same posture picker for
fresh members; roster rows badge non-standard modes.

**`PlanCandidateBanner` cluster surface.** When the active workflow is a cluster member, the banner mounts a third `ATTACH TO CLUSTER` button between `ATTACH TO WORKER` (the original behaviour, relabelled) and `DISCARD`. `App.tsx` resolves the member's `clusterId` once and only threads the prop on cluster-member tabs; the button is absent on standalone workflows. Click -> persists the plan record per-cwd, then routes the body to the cluster's shared PLAN via `cluster_plan_set` (skipping the per-worker attach). Operator-side semantics in [`PRIMITIVES.md-attached plan + role hints`](PRIMITIVES.md).

**`TerminalInput` - BACK TO CLUSTER button.** Status row, immediately left of `/SKILLS`. Only mounts when the active workflow is a cluster member. Click -> `setActiveCluster(clusterId)` (switches the top-level view back to the parent cluster tab).

**Shared cluster plan cap.** `ClusterPlanTab.tsx` enforces `PLAN_MAX_BYTES = 32768` (hard) / `PLAN_SOFT_WARN_BYTES = 28672` (soft). Mirrors the server limit in `clusterPlanStore.ts`.

**`PlanBodyRenderer.tsx` - shared rich plan renderer (2026-05-11).** Extracted from the former inline `PlanBody`. Renders the markdown plan body with H1/H2/H3 styling, clickable `- [ ]` / `- [x]` checkboxes (optimistic toggle), per-H3 action pill rows, and a `CHECKBOX_RE` export the host components reuse for line parsing. Used by both the per-worker PLAN tab (`RightPanel/PlanTab.tsx`) and `ClusterPlanTab.tsx` so the two surfaces stay visually identical. Action-pill set varies per host: worker plan exposes DETACH / PROMOTE / MOVE / DONE, cluster plan omits all four (cluster plan IS the cluster plan - no detach target, no promote destination).

**`ClusterPlanTab.tsx` - VIEW / EDIT modes (2026-05-11).** Two modes toggled by the header `EDIT` pill. VIEW renders the body through `PlanBodyRenderer`; H3 section blocks expose `▷ REVIEW PHASE PLAN` / `▷ VERIFY PHASE WORK` / `▷ SPAWN PHASE`. EDIT drops to the textarea with byte counter + dirty marker; SAVE writes via `cluster_plan_set` and flips back to VIEW. Auto-opens in EDIT when the body is empty; auto-flips back to EDIT if a remote update drops the body to empty. Header pill bar in VIEW: `EDIT` / `CLEAR PLAN` / `REVIEW PLAN` / `VERIFY WORK` / `CUSTOM REVIEW`. REVIEW/VERIFY pop a `ClusterMemberPicker` first (review needs a worker to run on); CUSTOM REVIEW reuses the existing `PlanReviewPicker` against the picked member's promoted plan.

**Outer cluster right-panel splitter (2026-05-11).** A 4 px col-resize divider sits between the cluster main area (member grid + detail pane) and `ClusterRightPanel`. Width persisted to `localStorage` under `arco.clusterRightPanelWidth`. Fraction clamped to `[0.18, 0.5]` with default `0.28`. Same cleanup contract as `WorkflowView`'s splitter (mousemove updates a live-value, mouseup + capture-phase pointerup + pointercancel + blur + visibilitychange commit + clear `body.style.userSelect/cursor`).

**`PlanCandidateBanner` - detection-based fallback (2026-05-11).** Previously the banner only appeared when the operator clicked PLAN (DRAFT / DRAFT & AUTO-SAVE) before sending. Fallback in the `ws/handleServerMessage.ts` `primary_complete` handler (`phase: 'passthrough'`): when `pendingPlanCapture` is absent AND the assistant's latest reply matches `looksLikePlan` (H1 title on first non-empty line + ≥3 markdown checkbox lines), the banner surfaces in `review` mode automatically. Catches the cases where the operator asked for a plan via free-form prompt without clicking PLAN, or where the pre-arm flag was dropped before `primary_complete` (page reload mid-turn). Operator can DISCARD if it's a false positive - the heuristic is conservative enough to avoid surprising normal replies.

**`ClusterActivityTab.tsx` - interleaved feed + sort flip (2026-05-11).** Pill row `[ALL · MEMBER1 · MEMBER2 · ...]` filters the feed; `ALL` interleaves cluster-scoped events (peer messages, role/plan/member edits, idle-nudger toasts, AUTO-PICKUP audit rows) with per-member `job.activity[]` tool calls (`READ`, `BASH`, `TodoWrite`, etc.). Per-member colour-tagged chip uses `hash(wfid) mod 6` over a fixed palette so the same member lands on the same colour every session. **Sort flipped to oldest-at-top / newest-at-bottom** (chat convention) - earlier the feed was newest-first; the live readout now reads downward and auto-scroll snaps to `scrollHeight` whenever the operator is within 80 px of the bottom. Compact-runs collapse: ≥3 identical `(memberId, tool)` rows within 30 s render as a single `TOOL × N` row that click-expands. Adjacent thinking deltas from the same member also coalesce after the global time sort (preserving raw separator chunks), so providers such as Cursor/Kimi that stream word-sized `agent_thought_chunk` updates render one growing reasoning row; a tool, cluster event, or another member remains a run boundary. The per-member `activity[]` buffer is the same sliding window the workflow ACTIVITY tab reads - resets per turn - so this feed mirrors the live tool stream, not a durable log (which lives in each member's `events.jsonl`).

**BLIND member task handback (2026-07-30).** ADD FRESH / REPLACE access-mode copy now states the operational consequence of mailbox-only cluster access: BLIND members have no plan/board/task tools, so a task can remain assigned to them for operator tracking but its status transition must be performed by a STANDARD member/operator after the BLIND member mails its completion report. The manual also tells operators not to instruct a BLIND lane to mutate the board directly.

**Reconnect handling.** `handleServerMessage`'s `connected` case re-subscribes to every persisted cluster (one `cluster_subscribe` per id). The server's reply is a fresh `cluster_state`; the existing entry is overwritten in-place. If the cluster was torn down while disconnected the server sends an `error` (which we ignore - the persisted entry stays stale until the operator closes the tab manually).

### BOARD tab - `ClusterTaskBoardTab.tsx`

Cluster BOARD sub-tab (`client/src/components/ClusterTaskBoardTab.tsx`). Renders the cwd-scoped task ledger as a Kanban-style board shared across all cluster members. **Task-ledger integration** (see [TASK_LEDGER.md](TASK_LEDGER.md)).

**Board mode + default-attach.** A cluster's board mode is `cluster.taskBoardMode` (`none` | `project` | `cluster`); new clusters **default-attach a project board** (`clusterStore.ts` seeds `taskBoardMode: 'project'`). `cluster_state` carries `taskBoardMode` / `taskBoardKey` / `taskBoardAttached`; the operator flips it via `cluster_task_board_attach_set` / `cluster_task_board_mode_set`. The plan->task / peer->task bridges (above) mount only when the board is attached (`!== 'none'`).

**Kanban columns + drag.** Eight status columns in order: `triage / todo / ready / in_progress / blocked / review / done / archived`. Column definitions live in `BOARD_COLUMNS` (exported helper). Cards show task title, assignee (if any), open-run count, and dependency indicators. The board is a horizontal kanban with `@dnd-kit` drag-to-restatus (`data-help="cluster.board-columns"`): a `PointerSensor` with a 4px activation distance (so a plain click still opens the drawer instead of starting a drag) plus a `TouchSensor` (delay 180ms / tolerance 8) for touch-drag. A drop fires `task_ledger_update { status }`; drops onto `done` / `archived` confirm first. A create-on-board composer (`data-help="cluster.board-add-task"`) authors a new `todo` task via `task_ledger_create`.

**Task detail drawer.** Clicking a card opens a right-side drawer backed by `GET /api/clusters/:id/peer/task-show?workflowId=<wfid>&id=<taskId>`. The drawer has three main sections:
- **Overview** - now **editable** (`data-help="cluster.task-edit"`): title / notes / priority commit together as one `task_ledger_update` (`onEditTask`); dependency add/remove and DELETE (`task_ledger_delete`, `onDeleteTask`) are discrete actions. Also shows the comments thread.
- **Runs** - run history with heartbeat age, stale indicator, and per-run RECLAIM / TERMINATE controls (`task_run_recover` WS message). Open runs are listed first.
- **Dependency graph** - `taskGraphSummary` helper computes parent/child counts and blocked-parent / open-child summary. Displayed as a plain-text graph summary.

**Collapsed AUTOMATION header.** The dispatcher, SWARM, and orchestration-assist controls now live behind a single collapsed **AUTOMATION** disclosure (`automationOpen`, default false; `data-help="cluster.board-automation-toggle"`; the header badge appends `· N` proposed-count when non-zero). Expanded, it exposes:
- `DISPATCH ONCE` - fires `cluster_dispatch_once`; one deterministic explicit-assignee sweep.
- Armed-daemon toggle (DISPATCHER) - `cluster_dispatch_toggle`; persisted in cluster meta; status shown as `Armed` / `Disarmed` tooltip.
- Per-cap settings (max open runs cluster-wide, per-member cap) - fires `cluster_dispatch_settings_update`.
- Run concurrency pill showing `RUNS N/cap` - visual throttle indicator.
- CREATE SWARM / DRAFT ASSIST - the orchestration-assist panel below.

**Orchestration assist panel** (`orchestrationAssistStore`). An operator-armed ASSIST panel inside the AUTOMATION disclosure. Gated: only appears when the cluster is armed (via the panel's own arm toggle). Five assist modes (radio/select): `TASK GRAPH / ASSIGNMENTS / RECOVERY / SYNTHESIS / SWARM`. On dispatch:
1. Client fires `cluster_orchestration_assist_request` with the chosen mode + a freeform prompt + requester workflowId.
2. Server generates (or stubs) a proposal and stores it via `orchestrationProposals.ts`; broadcasts `cluster_orchestration_proposal` back.
3. Client upserts the proposal into `orchestrationAssistStore.byCluster[clusterId]` and auto-selects it.
4. Selected proposal previews in the panel. Operator can **accept selected items** (fires `cluster_orchestration_proposal_apply`, which runs through the normal task-kernel APIs producing ordinary `task_ledger_event`s) or **reject** (fires `cluster_orchestration_proposal_reject`; mutates nothing in the task store).

`orchestrationAssistStore` (`client/src/stores/orchestrationAssistStore.ts`) is a standalone Zustand store (not in `appStore`). Shape:
```ts
{
  byCluster: Record<string, OrchestrationProposal[]>;   // proposals per cluster, newest-first
  selectedProposalId: Record<string, string | null>;     // per-cluster selection
  dispatch(args): string;                                // fires the request, returns requestId
  upsertProposal(proposal): void;
  replaceClusterProposals(clusterId, proposals): void;
  markRejected(clusterId, proposalId): void;
  markApplied(clusterId, proposalId, itemIds): void;
  selectProposal(clusterId, proposalId | null): void;
}
```
State is not persisted (proposals are fetched from the server on subscribe). The store is kept out of `appStore` because proposals are cluster-scoped, not per-workflow, and the panel can be independently mounted.

---

## ARCHIVE explorer (`?app=explorer`)

A standalone chromeless read-only window, mounted by `main.tsx` on `?app=explorer`, sharing the same root/theme bootstrap but no app store or `/ws`. `explorer/ExplorerApp.tsx` is the shell - `LensId = 'artifacts' | 'recents' | 'tree'` (ARTIFACTS is the landing home), left-nav lens switcher, poll-on-focus + manual ↻, an A−/A+ window-zoom control (`document.documentElement.style.zoom`, persisted `arco_explorer_zoom3`, default 0.85), a transparent root so the theme's body background shows through, and a reused `FileExplorer` for the TREE lens. `ArtifactsLens.tsx` (HOME recent-across-projects strip + per-project drill-down over `/api/explorer/artifacts` + `/docs`), `RecentsLens.tsx` (AGENT WRITES ledger + RECENTLY MODIFIED scan, filter chips ALL/DOCS/IMAGES, `/api/explorer/recents` + `/changed`), `types.ts` (client mirrors of the server read-models), and `launch.ts` (`openArchive` - same-browser `window.open` popup, falling back to `POST /api/explorer/open`, last-resort plain tab). `/api/explorer/*` (5 routes) lives in `server/src/http/explorerRoutes.ts`. Read-only, zero model authority.

---

## Cross-references

- WS protocol: [`PROTOCOL.md`](PROTOCOL.md)
- The state shape: `client/src/stores/appStore.ts`
- The connection + outbound helpers: `client/src/hooks/useWebSocket.ts`; inbound dispatch: `client/src/ws/handleServerMessage.ts`
- Theme system: `client/src/themes/`
- "Don't regress X" client-side invariants: [`GOTCHAS.md`](GOTCHAS.md)


Codex app-server clarification requests render through `OperatorQuestionNotice`.
`PendingQuestionsButton` beside the Agent/Chat composer opens all pending cards
without finding a virtualized transcript row. Options retain descriptions;
freeform inputs and masked secret inputs require explicit SEND ANSWERS. Pending
cards remain hot within the normal message cap. `ws/operatorQuestions.ts`
upserts by request ID and reconciles against `workflow_state_snapshot.operatorQuestions`;
connection/snapshot gates disable forms during reconnect, and stale cards close.
Secret values stay in component state until sent and are cleared on resolution.
The store/transcript receives only the server's redacted answered state.

Computer also projects completion watches through `voice/watches.ts` into the
Computer panel. VoiceControl refreshes authenticated state on transient
`computer_activity_changed` events, initial selection/context boundary and reconnect; one terminal announcement claim per watch prevents multiple
windows speaking it. Runtime announcements queue behind capture/playback and
remain interruptible. The `computer-watch` notification category gates speech
and ordinary notices. Private watch projections are scoped to their Computer
owner and cleared at a context boundary. `voice.sensitivity` controls the saved
minimum onset threshold (default .0035); changing it posts to the current
AudioWorklet immediately, while the adaptive room floor remains authoritative.

Computer's MAILBOX CONDITIONS section uses the memory-only `useComputerMailRules`
projection (`voice/mailRules.ts`), refreshed alongside completion watches on
WebSocket invalidations without a refresh interval. Full state stays in the panel; compact replies fit the voice relay
budget. Cancel is an authenticated HTTP action. New terminal states claim speech
once server-side and queue `runtime.announce` behind capture/playback; the
`computer-watch` mute applies. Context-epoch changes discard private projections.

`ComputerScriptsPanel` shows general CONDITIONAL SCRIPTS: exact JSON declaration,
pinned members, current hold/reason, total/per-worker counts and optional
limits, cooldown, observation usage, expiry and pause/resume/cancel. Null budgets
show "no limit"; null expiry shows "No expiry". Existing numeric scripts keep
their settings; voice can update/remove limits without resetting counts or
resending handled mail. `voice/conditions.ts` keeps the projection in memory and
compacts model replies inside the relay budget. VoiceControl coalesces its read
with activity, watches and legacy rules on the existing push invalidation,
initial selection and reconnect. Owner/context-epoch checks discard private
late replies. Notification announcements share the one-claim queued voice path.
`arco_compact` direct voice calls wait for an actual busy acknowledgement;
scripted compact instead runs server-side with the guarded ordinary handler.

`ComputerAutomationSection` separates active/paused counts and visible armed
items from terminal records in a closed History disclosure. Scripts and the
watch/legacy panels (`ComputerMonitoringPanels`) use the same presentation;
only status `watching` is armed, even if a terminal record retains a paused
flag. The activity master switch marks armed scripts/legacy rules paused;
completion watches remain active. Private records are filtered before counting.
Active script reasons and actions remain visible; definitions, receipts and
explanations are expandable. Terminal history never includes action buttons.
Empty legacy state renders no section. There is no backend status mutation,
history deletion, polling or automatic re-arming in this presentation change.
Agent/activity/automation/context settings share one scrollable region capped
at 55% of the Computer panel; expanded details cannot consume the transcript.

`ComputerActivityPanel` shows the per-owner automation switch, optional agent
feed, bounded recent ledger, inbox states and clear-queued action. Technical
batch/cost explanations sit inside the activity disclosure; disconnected,
paused and rate-limited states remain visible. The
`voice/activity.ts` memory store receives transient invalidations, coalesces
refresh requests and guards late replies by owner/context epoch. Private
projections clear with the context. The server persists public state; the browser
never puts the private ledger/inbox in localStorage. Computer readback waits for
`computer_context_updated settled` so background acknowledgements and partial
queue ends cannot swallow an operator answer. Switching agents disables the old
feed before opening the new context; it does not copy events or preferences.

## Workspace Outputs

`RightPanel/OutputsPanel.tsx` is shared by individual and cluster Files views.
It uses the workflow/cluster-scoped `/api/outputs` API rather than the global
Archive listing. Rows preserve producing workflow context for existing file and
media viewers. The durable projection and copy/move metadata are maintained by
`server/src/outputs.ts` and `outputStore.ts`; editor writes emit `output_saved`
and media result events include exact exported paths. Public behavior, limits and
recovery are described in [Workspace Outputs](OUTPUTS.md).
