# Changelog

User-visible changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and semantic versioning. New entries go under Unreleased; releases appear newest first.

## Unreleased

- Browse and choose a project folder during welcome setup with a typed path, root shortcuts, UP and new-folder controls. Keep large folder lists inside the dialog without configuring scanning.

- Show first-run setup for an unused Arco home even when provider CLIs are signed in. Offer explicit scan-folder choices, keep discoveries out of saved project records, and collapse long scanned lists on Home.

### Added

- Optional Arco release notices with persistent dismissal, manual checks, an opt-out, and service, foreground and Docker update instructions.

### Changed

- New homes default to Codex app-server, Claude native, and +30 text brightness.

- Hide provider status dots and usage details when their providers are disabled in Settings.
- Use Electric Blue and Victor Mono as the default appearance, while preserving saved theme choices.

- README and Getting started now present the background service as the normal way to run Arco.

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
