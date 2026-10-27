# Arco

**A local workbench for building and operating software with provider-backed agents, shared project tools, and a voice operator.**

[Getting started](docs/GETTING_STARTED.md) |
[Docker](docs/DOCKER.md) |
[Documentation index](docs/INDEX.md) |
[Settings guide](docs/SETTINGS.md) |
[Contributing](CONTRIBUTING.md) |
[Issues](https://github.com/ghreprimand/arco/issues)

Arco brings project-aware agent conversations, saved chat, terminals, files, Git,
preview, and multi-agent clusters into one browser interface. Work stays attached
to its project, with conversations and artifacts available to resume later.
The operator chooses providers, models, tools, and which automation to enable;
Computer offers the same workbench through typed requests and optional voice.
Arco runs locally and connects to provider accounts or local model services.
A model, provider subscription, and credentials are not bundled.

## Install

Choose a native run for local desktop tools and microphone access, or Docker for
an isolated server with a persistent home and explicitly mounted projects.
[Getting started](docs/GETTING_STARTED.md) covers installation, connecting a
provider, opening a project, the first chat, clusters, voice, and backup.

### Native: Linux, macOS, and Windows

Install **Node.js 24 or newer**, npm, and Git. Native dependencies may also need
Python 3 and a C/C++ build toolchain when a prebuilt binary is unavailable.
Keep `NODE_ENV` unset during installation so development tools needed for the
build are installed. The commands below work in a terminal or PowerShell:

```sh
git clone https://github.com/ghreprimand/arco.git
cd arco
npm ci --include=dev
npm run build
npm start
```

Open <http://localhost:3001>. This serves the built client and API from one
loopback port. Keep the terminal running while using Arco; stop it with Ctrl+C.
Provider command-line tools, accounts, and local model endpoints are configured
separately through Connections. A new installation without projects or connected providers
opens **Welcome to Arco**: add a folder, connect a provider, then launch the
prefilled creator. Every step can be skipped, and **Skip setup** opens Home.
Settings > Projects > **Run setup again** reopens the flow;
**CONNECT A PROVIDER** opens Connections later.

See [Getting started](docs/GETTING_STARTED.md) for the complete first-session
walkthrough and [Operations](docs/OPERATIONS.md) for platform prerequisites,
ports, troubleshooting, and the optional Linux desktop launcher.
[Service mode](docs/SERVICE_MODE.md) describes background operation.

### Docker

Install Docker with Compose support, clone the repository as above, and enter
its directory. Copy `.env.example` to `.env`; the example mounts a `projects`
folder from the checkout. Create that folder, then build and start:

```sh
mkdir projects
docker compose up -d --build
```

In PowerShell, `mkdir projects` also creates the folder. If it already exists,
skip that command. Alternatively, set `ARCO_PROJECTS_DIR` in `.env` to an
existing project folder before starting Compose.

Open <http://localhost:3001>. Settings and provider login data persist in a named
volume; project files are mounted read-write. Home displays container paths,
such as `/projects/demo`. Provider login runs inside the container so its
credentials remain in the persistent container home.

The [Docker guide](docs/DOCKER.md) covers provider sign-in commands, additional
mounts, backups, updates, and container limits. Native voice is required for
microphone capture. Stopping the container preserves its named volume; follow
the guide before changing or removing stored data.

## Run and configure

Open **Settings** for Appearance, Projects, Providers and models, Agents and
clusters, Voice, Files and media, and Advanced. Search finds controls across
categories, and each section explains its scope. Per-workflow provider, model,
effort, and tool controls live in **CONFIG**. The
[Settings guide](docs/SETTINGS.md) maps every control to its location.

Global state defaults to `~/.arco` on Linux and macOS and
`%USERPROFILE%\.arco` on Windows. Set `ARCO_HOME` before starting to use a
different global home. Project workflows and project settings stay in each
project's `.arco` folder. Provider command-line tools may keep their own login
data outside the Arco home. See [Persistence](docs/PERSISTENCE.md) for the
storage layout and [Backup](docs/BACKUP.md) before moving an installation.

Model requests send prompts and selected context to the chosen provider under
its data and billing terms. User-selected features also access the network for
sign-in, catalog lookup, downloads, and online speech. Arco does not upload
project folders for telemetry. The production server binds to loopback by
default; review [network exposure](docs/OPERATIONS.md#exposure-posture) before
making it reachable elsewhere.

## Highlights

- **Project Home:** open arbitrary folders, pin or archive projects, recover moved folders, and resume saved work. [Getting started](docs/GETTING_STARTED.md)
- **Provider choice:** Claude, Codex, Z.ai, Gemini, Cursor, Antigravity, Ollama, LM Studio, and llama.cpp. [Providers](docs/PROVIDERS.md)
- **Optional external services:** Strata and DeepSeek through Xolotl require separately installed services that Arco does not distribute. [Provider guide](docs/PROVIDERS.md)
- **Conversation control:** interrupt an active Claude or Codex turn and send a correction next, preserving queued follow-ups. [Interrupt and send](docs/PROVIDERS.md#interrupt-and-send)
- **Operator actions:** Review, Compare, Research, Handoff, and Spawn keep results visible and actions explicit. [Operator actions](docs/OPERATOR_ACTIONS.md)
- **Clusters and plans:** shared task boards, peer messages, plans, and optional operator-armed dispatch coordinate parallel work. [Task ledger](docs/TASK_LEDGER.md)
- **Working tools:** an embedded terminal and Git workbench keep commands, diffs, checkpoints, and reviews beside the conversation. [Git workbench](docs/GIT_WORKBENCH.md)
- **Project knowledge:** store reviewed notes and retrieve useful context; search saved conversations through Recall. [Knowledge](docs/KNOWLEDGE.md)
- **Computer and voice:** use typed requests or hands-free capture, local recognition, speech replies, and guided component setup. [Voice](docs/VOICE.md)
- **Preview and media:** inspect a development server in Preview and edit images, audio, or video with optional media tools. [Preview verification](docs/PREVIEW_VERIFY.md)
- **Appearance and help:** Classic and Phosphor themes, font packs, an in-app manual, and contextual help. [Settings](docs/SETTINGS.md)

The [complete feature reference](docs/FEATURES.md) retains the detailed tour,
including context management, goal runs, safety gates, local services, and
explicit limits on automation. [Operator actions](docs/OPERATOR_ACTIONS.md)
explains the right-panel and cluster tabs and how plans attach to workflows.

## Platform support and status

Arco is in development. Linux, macOS, and Windows are native targets, and a
Docker baseline is available. Setup and automated checks do not substitute for
acceptance on real hardware or a fresh installation.

| Platform | Acceptance status |
| --- | --- |
| Linux native | Development platform; host acceptance remains open. |
| macOS native | Target-host acceptance remains open. |
| Windows native | Target-host acceptance remains open. |
| Docker | Baseline available; fresh-install acceptance remains open. |
| Voice | Components download on request; target-host acceptance tracked separately. |

[Development status](docs/DEVELOPMENT_STATUS.md) tracks capability limits and
remaining onboarding, portability, documentation, and release work. Provider
availability depends on account access, installed tools, and reachable local
services; support for an Agent tab does not imply support for every Chat or
cluster mode. The [provider reference](docs/PROVIDERS.md) records those boundaries.

## Build and test

From a checkout with dependencies installed:

```sh
npm run build
npm run typecheck
npm run test:unit
npm run audit:public
npm run docs:check
```

Run the browser or smoke suite covering the changed area as well. The
[contribution guide](CONTRIBUTING.md) describes development setup, test suites,
public-safety checks, and how to add providers or primitives. Routine tests use
synthetic projects and temporary homes; acceptance involving provider accounts
or hardware is a separate step.

For hot-reload development, use `npm run dev` and open <http://localhost:5173>.
Unlike the built server, the Vite development client listens on all interfaces;
use a trusted network and read the [exposure posture](docs/OPERATIONS.md#exposure-posture).
API requests remain subject to the browser session check.

## Documentation

Start with the installation walkthrough, then follow the reference for the
surface in use. The in-app **MANUAL** and contextual help cover workbench
controls without leaving the interface.

- [Getting started](docs/GETTING_STARTED.md) and [Docker](docs/DOCKER.md)
- [Feature reference](docs/FEATURES.md) and [operator actions](docs/OPERATOR_ACTIONS.md)
- [Settings guide](docs/SETTINGS.md) and [provider reference](docs/PROVIDERS.md)
- [Chat](docs/CHAT.md), [terminal](docs/TERMINAL.md), and [Git workbench](docs/GIT_WORKBENCH.md)
- [Voice and Computer](docs/VOICE.md) and [media studio](docs/MEDIA_STUDIO.md)
- [Task ledger and clusters](docs/TASK_LEDGER.md), [Knowledge](docs/KNOWLEDGE.md), and [Recall](docs/RECALL.md)
- [Operations and configuration](docs/OPERATIONS.md), [persistence](docs/PERSISTENCE.md), and [backup](docs/BACKUP.md)
- [Architecture](docs/ARCHITECTURE.md), [repository layout](docs/REPO_LAYOUT.md), and [development history](DEVLOG.md)

[Complete index](docs/INDEX.md)

## Contributing, security, and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution scope, development
workflow, validation requirements, and public-repository safety rules. Report
bugs, propose changes, or ask for help through the
[bug-report](https://github.com/ghreprimand/arco/issues/new?template=bug_report.yml),
[change-proposal](https://github.com/ghreprimand/arco/issues/new?template=change_proposal.yml),
or [question](https://github.com/ghreprimand/arco/issues/new?template=question.yml) form.
Report vulnerabilities privately through the process in
[SECURITY.md](SECURITY.md#reporting-a-vulnerability).

Arco is licensed under **GPL-3.0-only**. The source may be used, studied, shared,
and modified under that license; distributed modifications must use the same
license. See [LICENSE](LICENSE). Bundled assets and downloaded speech components
have their own notices and applicable terms; see
[voice component notices](docs/VOICE.md) and the
[bundled background terms](client/public/backgrounds/LICENSE).
