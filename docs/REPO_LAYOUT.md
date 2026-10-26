# Repository layout

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
  docs/                          # Reference guides listed in INDEX.md
  DEVLOG.md                      # Monthly development-log index
  AGENTS.md                      # Repository rules
  CONTRIBUTING.md                # Dev workflow + how to add a provider/primitive
  README.md                      # Landing page
```

See [Architecture](ARCHITECTURE.md) for subsystem relationships and [Documentation index](INDEX.md) for reference guides.
