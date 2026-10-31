# Changelog

User-visible changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and semantic versioning. New entries go under Unreleased; releases appear newest first.

## Unreleased

### Changed

- Add built-in cluster templates (Pair, Small team, Full team, Parallel build, Research) with a review step that explains each member's recommended tier and effort in words and lets you choose provider and model from connected providers; effort starts at most at HIGH.

- Simplify the New workflow page: each mode shows only the controls it uses, cluster mode leads with the shared folder and members, keeps member defaults and coordination settings collapsed, lists only connected member providers, and describes members, permissions and saved presets in plain words.

- Replace the fixed one-local-member cluster rule with a per-runtime setting in Connections for Ollama and llama.cpp, "Cluster members that may use this runtime at once" (1 to 16, default 1, so existing behavior is unchanged). The server enforces it when clusters are created, members are added and members are replaced; the creator shows local capacity in use. `ARCO_CLUSTER_ALLOW_MULTIPLE_LOCAL=1` still lifts the limit.

- Start new work at HIGH effort at most: a fresh home, saved defaults, templates, saved cluster presets, new cluster members, Add worker and Replace member are capped at HIGH, an explicit XHIGH or MAX resets to HIGH with a note when the model or provider changes, and SAVE AS DEFAULTS stores at most HIGH. A new home also starts single workers and new members with the Conservative tool-result filter and Lite output style; saved choices, including Off and Normal, are kept.

- Bound Home: open work shows two rows of cards with Show all, and every project group, including pinned and bookmarked folders, shows six entries before expanding into a bounded scrolling list.

- Separate cluster coordination style from Warn only, Hard limit and No limit message guards; align role and mailbox guidance; default new clusters to Balanced, a cluster-local board and Keep current Both while preserving saved settings.

### Fixed

- Show "Z.ai support has been removed" wherever a removed Z.ai provider is still named (creator, workflow create, provider start, sign-in and update-check requests) instead of a generic unsupported or unknown provider error; Z.ai settings stay discarded.

- Start the New workflow page on the first enabled, connected provider when no default is saved, keep a saved default that is not connected selected and marked "not connected" with an Open Connections link, and disable launch with a plain reason until a connected provider is chosen; the provider picker lists only enabled, connected providers. Repeated roles are numbered the same way ("Builder #2") in the template review and the member list.

- Give the cluster creator's Message guard, Warn after, Task board and Keep current controls, the cluster and worker Auto-compaction selects, Computer activity and fresh-context selects, the Codex usage account and source selects, speech sensitivity and the workspace name field the theme's form-control style; wrap the message guard help and use plain wording for cluster notes.

- Store cluster-local task boards under folder names that are valid on Windows, keeping boards already created on Linux or macOS in place.

- Keep filled Config control labels and keyboard focus readable across themes and brightness settings while preserving selected values and appearance choices.

- Keep reauthentication bound to its originating workflow and credential source, detect Native callback completion with present credentials, and retain drafts with explicit review before continuing.

- Keep the Claude allowance popover open and focused during a manual check, including when the pointer leaves it.

- Attribute Claude allowance snapshots to their actual credential source, invalidate changed bindings, fence late responses and keep CLI refresh ownership and execution authentication separate.

- Distinguish Claude Native credential state, CLI login and allowance availability, with transport-specific recovery and preserved saved choices.

- Refuse checkpoint restores that overlap active managed work, and block conflicting turns and workers through the safety snapshot and restore while preserving isolated worktree recovery.

- Save worker and cluster auto-compaction thresholds once per completed adjustment and avoid duplicate policy notices.

### Added

- Rename a single-worker workspace from its Workspace panel or a chat header disclosure, with saved-name feedback and preserved work.

- Allow worker and cluster auto-compaction thresholds as low as 30%.

- Clarify message submission, queue replay, and approval behavior across browser reconnects and server restarts, with operator review guidance for uncertain work.

- Show pending peer-mail counts on cluster member cards and the NUDGE control; label operator-only notifications MAIL ALERTS.

- Ollama worker and cluster auto-compaction policies now reuse durable summaries of verified completed turns while preserving queued input and original events.

- Show a qualified GPU-use hint for Phosphor effects in recognized non-Chromium browsers.

- Configure per-worker and cluster auto-compaction thresholds for Claude Native and Codex app-server.

- Show a provider throttling warning in the header only while a provider is throttled.

- Hide the duplicate header wordmark on Home while keeping it in other views.

- Remove Gemini and dedicated Google provider paths while preserving historical work; keep retired saved choices visibly unavailable until a supported provider is explicitly selected.

- Remove Antigravity integration and desktop launch paths while preserving historical work and explicitly rejecting retired provider requests.

- Show a centered, theme-aware Arco wordmark on Home.

- Give Home more room for project locations, distinguish folder paths, and bring the latest saved session forward.

- Resize or maximize larger browsing, search and editing dialogs while keeping controls and folder choices in view.

- Call optional individual folder shortcuts Bookmarked folders, with consistent bookmark actions distinct from project locations and saved chats.

- Show project locations with useful folder choices and truthful counts, simplify Settings/setup, and keep duplicate location names until an explicit rename is confirmed.

- Keep generated files in Workspace Outputs after previews close, with producer attribution, existing viewers/editors, and reviewed copy/move destinations.

- Manage multiple named project roots, browse root groups on Home, search and choose one-off session folders, and add several folders during non-destructive setup.
- Read Codex subscription quota through the app-server with account selection, freshness and an optional legacy browser source.

- Home now leads with open work, a clear Start a chat action, project cards with saved-session resume, folded Add project controls, and compact connection/version status.

### Fixed

- Keep streamed worker replies after the peer messages they follow, including cluster panes, session overlays and replay.

- Preserve concurrent first checkpoints for projects without a Git repository.

- Keep Bakeoff usable before its comparison list arrives, including navigation and reload.

- Restore switching from the shipped Phosphor default to Arco Classic themes in Settings.

- Correct provider, transport, instruction-file, and Docker guidance in the in-app manual and reference docs.

- Restore retained-provider routing and HTTP API guidance after provider removal.

- Preserve historical worker provider labels in the detail viewer instead of displaying Ollama for retired providers.

- Keep Recall draft actions reachable when browser zoom and interface size constrain the dialog.

- Open provider Settings above setup and return to the same Connections selection with keyboard focus intact.

- Keep the Settings close button accessible at larger interface sizes while settings content scrolls.

- Default Computer to a connected agent, offer Connections when none is available, and explain its workbench-only scope.

- Finish welcome setup with a folder and provider summary, then choose Go to Home or Start a chat in the normal creator.

- Browse and choose a project folder during welcome setup with a typed path, root shortcuts, UP and new-folder controls. Keep large folder lists inside the dialog without configuring scanning.

- Show first-run setup for an unused Arco home even when provider CLIs are signed in. Offer explicit scan-folder choices, keep discoveries out of saved project records, and collapse long scanned lists on Home.

### Added

- Adjust interface text size from 90% to 150% in Appearance settings.

- Optional Arco release notices with persistent dismissal, manual checks, an opt-out, and service, foreground and Docker update instructions.

### Changed

- Clarify that interface text size changes take effect immediately and persist across startup.

- Connections labels local runtime addresses as configured and reports whether they are reachable.

- New homes default to Codex app-server, Claude native, and +30 text brightness.

- Hide provider status dots and usage details when their providers are disabled in Settings.
- Use Electric Blue and Victor Mono as the default appearance, while preserving saved theme choices.

- README and Getting started now present the background service as the normal way to run Arco.

### Removed

- Z.ai provider, transports, usage indicators, API-key controls and setup entries. Existing unrelated settings and saved files are preserved.

## v0.1.0 - 2026-10-27

### Added

- A local software workbench with project-aware conversations, saved and Incognito chats, terminals, files, Git, Preview, Review, Compare, Research, Handoff, Spawn, clusters, and plans.
- Native installation for Linux, macOS, and Windows, plus a Docker runtime with persistent state and explicitly mounted project folders.
- Skippable first-run setup, guided provider connections, Project Home with pins and archive, and missing-folder recovery.
- Provider integrations for Claude, Codex, Z.ai, Gemini, Cursor, Antigravity, Ollama, LM Studio, and llama.cpp; optional Strata and DeepSeek through separately installed external services.
- Optional native voice setup with locally run recognition and speech components, guided microphone testing, and download notices.
- Numbered releases with a changelog and a local release command that prepares commits and tags without pushing.
- An in-app manual, public reference documentation, contributor guidance, third-party notices, and GPL-3.0-only licensing.

### Changed

- Settings are organized by task while preserving the workbench controls.
- Native state and voice homes are configurable, with platform-specific launch and terminal handling.
- The running version is available from liveness probes and the application version API; container builds can include their source revision.

### Fixed

- File and media access respects project grants and explicit media folders while protecting provider credentials and runtime state.
- Saved work survives browser disconnects and project relocation without losing project identity.
- Voice test uploads return bounded-input errors without aborting the response socket.

The [long-form release notes](docs/releases/v0.1.0.md) describe installation,
provider boundaries, download sources, and remaining target-host acceptance limits.
