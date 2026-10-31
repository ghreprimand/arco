# Getting started

This guide takes a new Arco installation through provider setup to a project
chat, then covers a first cluster, optional voice setup, and backups. A new
Arco home with no completed setup, confirmed provider, saved work or added projects opens **Welcome to Arco**, even when provider CLIs are already signed in on the machine.
Select **Get started**, then **Add project location** to choose a folder containing
projects, such as Work or Personal. Enter a location name and absolute folder path,
or browse with folder shortcuts and UP. **Add a single project folder** is a
secondary option for a one-off folder outside the usual locations. Add several
choices to the visible summary, then choose **Continue**. Adding the first choice
does not advance the step or start work.

Connect a provider through Connections; an existing CLI login is prefilled. The
final **Setup complete** screen summarizes the choices and provider. Choose
**Go to Home**, or **Start a chat** to open the normal creator. Only an explicitly
chosen single project folder can prefill a session; a location never chooses its
first child. Either choice remembers setup completion. Earlier steps can be
skipped. Settings > Projects > **Run setup again** shows existing choices and
preserves chats, settings, locations and bookmarked folders unless explicitly edited.

## Home: project locations and recent work

Home shows open work first, as cards that share the row, most recent first.
At most two rows show; **Show all N** opens the rest in a bounded scrolling
area and **Show fewer** collapses it. **Resume** returns to a tab without
stopping its running turn. **Start a chat**, **New session**, and **More ways to start** retain
the normal chat, session, cluster and Genesis creators.

Each **Project location** shows its name, path and available-folder count. The first
few folders are visible immediately with their paths; long lists offer **Show all N folders** and
**Show fewer**, with a bounded scrolling area. Pinned, bookmarked, available and
archived groups follow the same six-entry limit. Search works across locations.
Choose a folder to open the creator with that explicit path. **Browse Work**, for
example, opens the folder browser at Work. Opening a folder never bookmarks it, trusts it, or launches work automatically.

**Pinned** keeps shortcuts to folders. Cards preview the latest saved session with one-click
**Resume**; **Saved sessions** opens the full list, and sessions already open offer **Open**. Pinning, archive, and missing-folder
recovery remain on the cards. **Other projects** holds bookmarked or previously used
folders outside configured locations. Missing locations remain visible so a drive
can be reconnected or its path edited.

Use **Add project location** for another parent folder, or **Open another folder**
for a one-off session. The latter opens the shared folder browser; **Use this
folder** opens the creator without bookmarking it. Its **Bookmark a folder**
disclosure offers **Bookmark folder** and **Create and bookmark**. A compact status
area links to Connections and the installed Arco version/update controls.

## Manage locations and one-off folders

Larger browsing and work dialogs offer **Maximize** and **Restore**. Drag **Resize**, or focus it and use arrow keys to adjust the dialog (Shift makes larger steps; Home resets its size). These adjustments are temporary and do not change the saved interface text size.

Settings > Projects starts with the compact **Project locations** list. **Add
location** opens its form; **Edit** changes a name or path. Adding an existing path
or an alias explains which location already uses it, keeps the submitted name,
and offers an explicit rename. Saving a rename shows confirmation and updates
Home. Editing a location onto another location's path is refused without dropping
either location. These same checks apply during setup.

**Bookmarked folders (N)** contains **Bookmark folder** and **Remove bookmark**.
Bookmarks are optional: folders inside project locations already appear automatically.
Bookmarks keep individual folders listed independently of locations; they do not
control saved chats or files. **Advanced folder options** contains the independent **Default browsing
location**. Changing that starting location never adds a project location or bookmarks
its children. Removing a location stops its listing and grouping; bookmarked folders,
files, sessions and trust choices remain unchanged. The legacy single-location
setting migrates automatically; an explicitly empty list stays empty.

In the creator, **Project location** filters **All folders**, **Pinned and recent**,
or one named location. Search by name or path. Filtering never replaces a typed
working folder. **Browse this location** starts navigation there; **Browse another
folder** can reach other directories. The browser offers an editable path, UP,
shortcuts and new-folder creation at the displayed parent. **Use for this session**
selects a folder without bookmarking it. **Bookmark folder** explicitly keeps it listed independently of locations.
In Docker, folders must be mounted before they can be selected.

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
session** on HOME and choose a folder in the creator. Without a saved default,
the creator starts on the first enabled, connected provider. A saved default
that is not connected stays selected and is marked not connected; launch stays
disabled until you choose a connected provider or sign in from **Connections**.
Choose an available model. Select **SAFE** or **AUTO**
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
   initial rows. Edit each initial row to choose its provider and model. By
   default a cluster accepts one member per local runtime (Ollama, llama.cpp);
   raise "Cluster members that may use this runtime at once" in Connections to
   allow more.
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
