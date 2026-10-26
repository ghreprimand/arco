# Getting started

This guide takes a new Arco installation to a project chat, then covers a first
cluster, optional voice setup, and backups. The current first-run steps use the
workflow creator; there is no separate welcome wizard yet.

## Before starting

Arco requires Node.js 24 or newer and `NODE_ENV` must not be set to `production` while installing, because the native build needs development dependencies. It also requires npm, Git, and a C/C++ toolchain with Python 3
when native dependencies need to build. Have one provider account or local model
endpoint ready. Provider requests are sent to the provider selected for a turn;
API-key providers may bill according to their own terms. Arco does not submit a
chat request until a user sends a message or starts a model-backed feature.

## Install and start

### Native run

On the repository hosting page, copy the Clone URL, clone the repository into
a directory named `arco`, and open a terminal in that directory. Then run:

```bash
npm ci --include=dev
npm run dev
```

Open <http://localhost:5173>. The Vite client proxies API and WebSocket traffic
to the local server. `npm run dev` keeps the server and client running together.
Use `npm start` only after building the production bundle; the native development
path starts with `npm run dev`.

On Windows, `npm run dev` is available, but native acceptance is still pending
verification on real Windows hardware. The Bash launcher and systemd service
commands documented in Operations are for Linux. The macOS service procedure is
separate from the development command.

### Docker

Docker keeps the Arco home in a named volume and mounts project folders from the
host. Create a local `.env` from `.env.example`, then set `ARCO_PROJECTS_DIR` to
an existing folder. On Windows, use forward slashes, such as `C:/Projects`.
Then run:

```bash
docker compose up -d --build
```

Open <http://localhost:3001>. The published port is bound to host loopback. The
selected project folder is mounted read-write into the container, so edits affect
those host files. Sign in to a provider from the same container so credentials
are stored in its persistent home volume:

```bash
docker compose exec arco codex login --device-auth
docker compose exec arco claude auth login --claudeai
```

Follow the link and code instructions shown by the command. Docker does not
provide voice microphone capture; use a native run for voice setup. See
[DOCKER.md](DOCKER.md) for extra bind mounts, service operation, and container
limitations.

## Connect a provider

If no provider is authenticated, Arco opens the authentication overlay. Choose
one of its listed providers and follow the login or API-key instructions. The
same controls are available under **Settings > Providers and models > Sign-in,
accounts and local endpoints**. CLI-based
providers may show a command to run in a terminal; finish the browser or device
login flow, then return to Arco. For local providers such as Ollama, set the
endpoint in Settings and make sure its service is running.

Provider rows and model choices depend on the installed CLI, account access, or
reachable local model endpoint. A connected indicator means Arco can reach the
provider; it does not guarantee that a requested model is available or that a
provider account has quota.

## Add a project and start a chat

The **HOME** view is the project landing page. Select **HOME** in the tab bar to
return to it. Add an existing folder with **Add a project folder**, or create a
folder with **Create a new project folder**. The project card offers **New
session** and **New cluster** actions prefilled with that folder. Use **Saved
sessions** to find and resume prior work, and **Manage...** to pin, rename,
archive, relocate, or remove a registration. These list actions do not move or
delete project files. Missing folders offer **Relocate...**.

For a project chat, select **New session** on its card, or use **Start > New
session** on HOME and choose a folder in the creator. Choose an authenticated
provider and available model, then select **SAFE** or **AUTO** permissions for
the project's trust level. Use **SAFE** for an unfamiliar repository. Select
**LAUNCH WORKFLOW**, wait for the provider to connect, then send a small request
in the composer.

To register or set a default folder without leaving a workflow, open **Settings
> Projects**. That category manages registered, scanned, and recent folders,
the default working folder for new workflows, and project trust. The HOME
project list is for finding and resuming work; the Settings category controls
project registration and defaults.

For a plain saved conversation without file or project tools, choose **CHAT** in
the creator and select **START CHAT**. Saved Chat is the default; Incognito Chat
is memory-only in Arco and cannot be resumed after closing the tab.

## Create a first cluster

A cluster is a group of workflow members that share one project folder. It needs
at least two members, each with a model selected.

1. Open the workflow creator and select **CLUSTER**.
2. Set the shared project folder in **WORKING DIRECTORY**. All members use this
same folder.
3. Choose provider defaults, then configure at least two member rows. Each row
can use its own provider, model, role, and supported controls.
4. Select **CREATE CLUSTER**. The cluster tab opens with its members.

Cluster roles are descriptive metadata. Arco does not automatically route work
to a member based on its role. See [TASK_LEDGER.md](TASK_LEDGER.md) for cluster
boards, messages, and saved tasks.

## Optional voice setup

Voice input uses the browser microphone and local speech components. It requires
a native run on `localhost` or HTTPS; Docker cannot provide microphone capture
portably. From the repository root, run:

```bash
npm run voice:setup
```

The setup downloads speech components to the configured voice home and writes a
`NOTICES.md` file there with component licenses and upstream sources. Review that
notice and [VOICE.md](VOICE.md) before enabling hands-free mode. Open Arco's
**COMPUTER** controls, enable hands-free, allow browser microphone access, and
say "Computer" followed by a short request. Say "over" to submit. Silence does
not send a directive.

## Where state lives

- Global settings, provider connections, clusters, and logs: `~/.arco` on Linux
  and macOS, `%USERPROFILE%\.arco` on Windows.
- Per-project workflows, chats, plans, and project settings: `<project>/.arco`.
- `ARCO_HOME` relocates the global Arco home. Project state remains in each
  project's `.arco` directory.

Do not add runtime state folders to source control. See
[PERSISTENCE.md](PERSISTENCE.md) for the full list and
[BACKUP.md](BACKUP.md) for archive contents and restore behavior.

## Back up Arco state

From the repository root, create and verify an archive before storing it in a
separate location:

```bash
npx tsx scripts/arco-backup.ts snapshot --out "$HOME/arco-backup.arcobk"
npx tsx scripts/arco-backup.ts verify "$HOME/arco-backup.arcobk"
```

The archive covers global Arco state. Back up project folders separately when
they contain project-local `.arco` state or work that needs to be retained.
Restore writes to a new target directory by default and does not merge over the
live Arco home. Follow [BACKUP.md](BACKUP.md) before restoring an archive.

## Next steps

- Read [PROVIDERS.md](PROVIDERS.md) for provider-specific setup and recovery.
- Read [OPERATIONS.md](OPERATIONS.md) to stop, restart, inspect, or recover Arco.
- Review [OPERATIONS.md](OPERATIONS.md#exposure-posture) for network exposure and
  [PERSISTENCE.md](PERSISTENCE.md) for provider credential storage.
