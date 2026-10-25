# Arco

Arco is an agent workbench for building and operating software with provider-backed agents, with a voice operator, for Linux, macOS, and Windows.

## Who it is for

Arco is for people who want a persistent workbench for agent chats, project files, provider connections, and multi-agent workflows. A new user should be able to clone the repository, start the app, connect a provider, and begin a chat using this guide as features land.

## Quick start

### Docker

**Pending:** Docker image, compose setup, persistent Arco home, project mounts, and provider sign-in support are being prepared.

### Native

**Pending:** the public native install and first-chat walkthrough are being prepared. Linux is the current development platform. macOS and Windows support remains pending real-host verification.

## Providers

The imported workbench supports Claude, Codex, Z.ai, Gemini, Ollama, LM Studio, Strata, DeepSeek (Xolotl), llama.cpp, Antigravity, and Cursor. Availability and setup details vary by provider; see [Providers](docs/PROVIDERS.md).

## Feature tour

- Workbench architecture and state: [Architecture](docs/ARCHITECTURE.md), [Persistence](docs/PERSISTENCE.md), [Operations](docs/OPERATIONS.md)
- Provider connections and voice: [Providers](docs/PROVIDERS.md), [Voice](docs/VOICE.md)
- Chat and project tools: [Chat](docs/CHAT.md), [Terminal](docs/TERMINAL.md), [Git workbench](docs/GIT_WORKBENCH.md)
- Projects and media: [Task ledger](docs/TASK_LEDGER.md), [Media studio](docs/MEDIA_STUDIO.md), [Backup](docs/BACKUP.md)

The documentation index and first-run guide will be added as the onboarding flow is completed.

## Platform support

| Platform | Status |
| --- | --- |
| Linux | Development platform; acceptance is in progress |
| macOS | Pending verification on real hardware |
| Windows | Pending verification on real hardware |

## Privacy

Provider requests are made when the operator uses a connected provider. Local workbench state is stored in the compatible `.arco` state area, and project files remain in the selected project folders. The public-safety audit checks the repository for credentials, private machine details, local paths, personal data, and other material that must not ship. See [Persistence](docs/PERSISTENCE.md) for state details; the security guide is planned.

## License

License: to be chosen by the maintainer before public release.

Arco is the public release of a private workbench. Its implementation is being prepared for public use while preserving the workbench behavior.
