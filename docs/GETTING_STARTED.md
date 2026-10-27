# Getting started

This guide takes a new Arco installation through provider setup to a project
chat, then covers a first cluster, optional voice setup, and backups. A new
installation with no projects or connected providers opens **Welcome to Arco**.
Select **Get started**, add an existing project folder or choose a discovery
scan folder, connect a provider through Connections, then review and launch the
prefilled chat creator. Every step has a skip action; **Skip setup** goes to Home.
Completion is remembered in the Arco home across browsers and provider outages.
Settings > Projects > **Run setup again** reopens the same flow.

## Before starting

Arco requires Node.js 24 or newer and `NODE_ENV` must not be set to `production` while installing, because the native build needs development dependencies. It also requires npm, Git, and a C/C++ toolchain with Python 3
when native dependencies need to build. Have one provider account or local model
endpoint ready. Provider requests are sent to the provider selected for a turn;
API-key providers may bill according to their own terms. Arco does not submit a
chat request until a user sends a message or starts a model-backed feature.

## Install and start

### Native run

On the repository hosting page, copy the Clone URL, clone the repository into
a directory named `arco`, and open a terminal in that directory. Install and
build the production files:

```bash
npm ci --include=dev
npm run build
```

**Background service on Linux:** run `npm run arco:service -- install --enable`,
then `npm run arco:service -- start`, and open <http://localhost:3001>. It runs
independently of the browser tab, starts on login, and restarts after a crash.
Manage it with `npm run arco:service -- status`, `npm run arco:service -- logs`,
and `npm run arco:service -- stop`.

**Background service on macOS:** use the hand-maintained [launchd procedure](SERVICE_MODE.md#hand-maintained-launchd-service-macos-specific).
The `arco service` CLI does not install launchd. Windows has no service mode.

**Foreground on any platform:** run `npm start` and open
<http://localhost:3001>. It serves the built client on loopback and stops with
Ctrl+C, interrupting in-flight agent work. This is suitable for a first look
and the documented Windows run path.

**Development only:** run `npm run dev` and open <http://localhost:5173>. Vite
proxies API and WebSocket traffic to the local server and listens on all network
interfaces, so use a trusted network. Changes under `server/` or `shared/`
restart the server and end in-flight agent turns; see
[Hot-reload caveats](DIAGNOSTICS.md#hot-reload-caveats).

To run the Linux service beside another server using port 3001, install it with
`ARCO_PORT=3002 npm run arco:service -- install --enable`; the chosen port is
stored in the generated unit. To update a Linux service, run `git pull`,
`npm ci --include=dev`, and install with the same install-time environment as
before, then stop and start the service with `npm run arco:service -- stop` and
`npm run arco:service -- start`. The install action rewrites the unit from the
current environment, so every install-time variable (`ARCO_PORT`, `ARCO_HOST`,
`ARCO_HUB_URL`, `ARCO_NTFY_URL`) must be set again. For a service on port 3002,
use `ARCO_PORT=3002 npm run arco:service -- install`; apply the same pattern to
any other install-time variables used. Stopping interrupts in-flight work. See
[Service mode](SERVICE_MODE.md) for the macOS procedure and further operating
details.

### Docker

Docker keeps the Arco home in a named volume and mounts project folders from the
host. Create a local `.env` from `.env.example`. Run `mkdir -p projects` on
macOS, Linux, or WSL, or `New-Item -ItemType Directory -Force projects` in
PowerShell, to create the sample folder. Alternatively, set `ARCO_PROJECTS_DIR`
to an existing folder. On Windows, use forward slashes, such as `C:/Projects`.
Then run:

```bash
docker compose up -d --build
```

Open <http://localhost:3001>. The published port is bound to host loopback. The
selected project folder is mounted read-write into the container, so edits affect
those host files. Folders under the mounted root appear in Home using container
paths such as `/projects/demo`, not their host paths. Sign in to a provider from
the same container so credentials are stored in its persistent home volume:

```bash
docker compose exec arco codex login --device-auth
docker compose exec arco claude auth login --claudeai
```

Follow the link and code instructions shown by the command. Docker does not
provide voice microphone capture; use a native run for voice setup. See
[DOCKER.md](DOCKER.md) for extra bind mounts, service operation, and container
limitations.

## Connect a provider

The provider step opens **Welcome - Connections**. Choose a provider, follow
its sign-in or API-key steps, check the connection, then select **Continue to
chat**. **Skip for now** advances to the creator without connecting a provider.
In the workspace, **CONNECT A PROVIDER** opens Connections later.
Settings retains the controls under **Providers and models > Sign-in, accounts
and local endpoints**. CLI-based providers may show a command to run in a
terminal. Search the task-based Settings categories for controls; see
[`SETTINGS.md`](SETTINGS.md) for the full control map. For Ollama in Docker, use
`http://host.docker.internal:11434`; a
`localhost` endpoint refers to the container. The connection check does not send
a model prompt.

Provider rows and model choices depend on the installed CLI, account access, or
reachable local model endpoint. A connected indicator means Arco can reach the
provider; it does not guarantee that a requested model is available or that a
provider account has quota.

## Add a project and start a chat

Use **HOME** to find or add a project. Add an existing folder with **Add a
project folder**, or create one with **Create a new project folder**. In Docker,
only mounted folders are visible and they appear under `/projects`. Select
**New session** on a project card to open the workflow creator with its folder
prefilled. Use **Saved sessions** to resume prior work, and **Manage...** to pin,
rename, archive, relocate, or remove a project registration. These actions do
not move or delete project files. A missing folder offers **Relocate...**. When
opening the creator directly, the folder control is **PROJECT FOLDER**;
**BROWSE FOLDERS +** opens the folder picker.

For registration, scanned and recent folders, the default working folder, or
project trust, open **Settings > Projects**. Home is the place to find and resume
work or start a session from a project card. The full control map is in
[`SETTINGS.md`](SETTINGS.md).

For a project chat, select **New session** on its card or choose **Start > New
session** on HOME and choose a folder in the creator. The creator starts with
Claude selected, which may show as not authenticated. Choose an enabled,
connected provider and an available model. Select **SAFE** or **AUTO**
permissions according to the project's trust level. Use **SAFE** for an
unfamiliar repository. Select **LAUNCH WORKFLOW**, wait for the provider to
connect, then send a small request in the composer.

For a plain saved conversation without file or project tools, choose **CHAT** in
the creator and select **START CHAT**. Saved Chat is the default; Incognito Chat
is memory-only in Arco and cannot be resumed after closing the tab.

## Create a first cluster

A cluster is a group of workflow members that share one project folder. It needs
at least two members, each with a model selected.

1. Open the workflow creator from **HOME** and select **CLUSTER**.
2. Set the shared folder in **PROJECT FOLDER**. All members use this same
   folder.
3. Configure at least two member rows. Each member's provider is a button group.
   Provider defaults seed members added later; they do not replace the two
   initial rows. Edit each initial row to choose its provider and model. A
   cluster supports at most one local-model member, so a two-member fixture
   cluster needs one local member and one non-local provider.
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
npx tsx scripts/arco-backup.ts restore "$HOME/arco-backup.arcobk" --into "$HOME/arco-restored"
```

The archive covers global Arco state. Back up project folders separately when
they contain project-local `.arco` state or work that needs to be retained.
Restore writes to a new target directory and does not merge over the live Arco
home. After checking the restored files, stop Arco, preserve the current home,
then copy the restored files into the intended home. For Docker, first copy
`/data/home/.arco` out of the container and run the backup script from a host
checkout with `ARCO_HOME` set to that copied directory. See [DOCKER.md](DOCKER.md)
for the container procedure and [BACKUP.md](BACKUP.md) for archive contents and
restore safeguards.

## Next steps

- Read [PROVIDERS.md](PROVIDERS.md) for provider-specific setup and recovery.
- Read [OPERATIONS.md](OPERATIONS.md) to stop, restart, inspect, or recover Arco.
- Review [OPERATIONS.md](OPERATIONS.md#exposure-posture) for network exposure and
  [PERSISTENCE.md](PERSISTENCE.md) for provider credential storage.
