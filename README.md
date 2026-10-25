# Arco

Arco is the public release of a private workbench for building and operating software with provider-backed agents. It preserves the workbench, behavior, and voice operator while preparing the project for public use on Linux, macOS, and Windows.

Arco is for people who want project-aware agent workflows, saved chat, local tools, clusters, and voice controls in one interface. A model or provider does not come bundled with Arco. Connect a provider account or local model endpoint, then choose the project and workflow from the workbench.

## Quick start

### Native

Copy the repository's HTTPS Clone URL from its hosting page. In a terminal, replace `<repository-url>` with that URL, clone the repository into a directory named `arco`, and run:

```bash
git clone <repository-url> arco
cd arco
npm ci --include=dev
npm run dev
```

Open <http://localhost:5173>. The Vite client proxies API and WebSocket traffic to the local server. `npm run dev` keeps the server and client running together. If no provider is authenticated, use the authentication overlay or the **AUTHENTICATION** section in Settings to sign in or configure a local endpoint. Follow [Getting started](docs/GETTING_STARTED.md) to open a project and start a chat.

Ensure `NODE_ENV` is not set to `production` during installation, because the native build needs development dependencies. Node.js 24 or newer is required. A C/C++ toolchain and Python 3 may be needed when a native dependency has no prebuilt binary for the platform.

### Docker

Create a local `.env` from `.env.example` and set `ARCO_PROJECTS_DIR` to a project folder on the host. Then run:

```bash
docker compose up -d --build
```

Open <http://localhost:3001>. The Arco home persists in a named volume and the selected project folder is mounted read-write. Provider login runs inside the container so credentials stay in its persistent home. See [DOCKER.md](docs/DOCKER.md) for provider commands, extra mounts, and container limits. Voice microphone capture requires a native run.

## Providers

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

When a user submits a model request, Arco sends the prompt and selected context to the chosen provider. Provider requests follow that provider's data and billing terms. Other network access occurs for user-selected features such as provider sign-in, catalog lookup, and voice setup downloads. Arco does not upload project folders for telemetry. The server binds to loopback by default; review the [Operations exposure posture](docs/OPERATIONS.md#exposure-posture) before exposing it to a network.

Arco is the public release of a private workbench. The license decision and final release review remain open; redistribution terms will be published after that review.
