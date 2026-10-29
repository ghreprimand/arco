# Changelog

User-visible changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and semantic versioning. New entries go under Unreleased; releases appear newest first.

## Unreleased

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

- Correct provider, transport, instruction-file, and Docker guidance in the in-app manual and reference docs.

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
