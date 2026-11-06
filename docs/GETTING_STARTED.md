# Getting started

This guide takes a new Arco install from provider setup to a project chat, then
covers a first cluster, optional voice, and backups.

## Welcome flow

A new Arco home opens **Welcome to Arco** when there is no completed setup, no
confirmed provider, no saved work, and no added projects. That is true even when
provider CLIs are already signed in on the machine.

1. Optionally enter a name for chat messages. Leave it blank to use OPERATOR.
   **Get started** saves it; skipping leaves any saved name unchanged. Change it
   later under Settings > Appearance > **Operator name**. **Run setup again**
   prefills it.
2. Select **Add project location** for a folder that contains projects (for
   example Work or Personal). Enter a location name and absolute folder path, or
   browse with folder shortcuts and UP. **Add a single project folder** is the
   secondary option for a one-off folder outside the usual locations.
3. Add one or more choices to the visible summary, then choose **Continue**.
   Adding the first choice does not advance the step or start work.
4. Connect a provider through Connections. An existing CLI login is prefilled.
5. On **Setup complete**, review the name, choices, and provider. Choose
   **Go to Home**, or **Start a chat** to open the normal creator.

Only an explicitly chosen single project folder can prefill a session. A
location never chooses its first child. Either final choice marks setup
complete. Earlier steps can be skipped. Settings > Projects >
**Run setup again** shows existing choices and preserves chats, settings,
locations, and bookmarked folders unless explicitly edited.

## Home: projects and recent work

Home greets the operator by the optional Welcome name and shows connected
providers, running work, waiting questions, and the installed version. The three
start tiles open chat, session, and cluster creators. **More ways to start**
offers Genesis. A new user sees a **Getting started** card until a provider,
project folder, and first conversation (any chat, session or cluster) are available; **HIDE** removes the card.

**Continue** lists open work, with questions waiting for an answer first and the
current step for running work. Each Continue card shows a status word: Working, Needs you, New reply (a turn finished while you were elsewhere) or Idle. Tabs show a status dot; hover over a tab for its status. Idle has no dot. **Resume** returns to a tab. Two rows show at
first; **Show all** opens the rest in a bounded scrolling area.

The project grid shows pinned folders first, then recent activity, in two rows; **Show all** opens the rest in a bounded scrolling area, and a search shows every match. Filter it by
location or search names and paths (press `/` to focus search). A project card
shows its folder, activity, and open tabs. **New session** opens the creator
with that folder. The **...** menu offers **New cluster**, **Saved sessions**,
**Pin** or **Unpin**, and **Manage** for rename, archive, bookmark removal, or
missing-folder relocation. None of these actions moves or deletes files.

Use **Add project location** for a named parent folder and **Open another
folder** for a one-off session or an optional bookmark. The location filter
also sets the folder browser's starting location.

## Manage locations and one-off folders

Larger browsing and work dialogs offer **Maximize** and **Restore**. Drag
**Resize**, or focus it and use arrow keys to adjust the dialog (Shift makes
larger steps; Home resets its size). These adjustments are temporary and do not
change the saved interface text size.

### Settings > Projects

Settings > Projects starts with the compact **Project locations** list.

- **Add location** opens its form. **Edit** changes a name or path.
- Adding an existing path or an alias explains which location already uses it,
  keeps the submitted name, and offers an explicit rename.
- Saving a rename shows confirmation and updates Home.
- Editing a location onto another location's path is refused without dropping
  either location.
- These same checks apply during setup.

**Bookmarked folders (N)** contains **Bookmark folder** and **Remove bookmark**.
Bookmarks are optional: folders inside project locations already appear
automatically. Bookmarks keep individual folders listed independently of
locations. They do not control saved chats or files.

If a location is itself a Git repository, it appears as a project alongside
its non-hidden child folders. The default Docker single-repository mount is
listed as one project, without offering its internal folders as projects.

**Advanced folder options** contains the independent **Default browsing
location**. Changing that starting location never adds a project location or
bookmarks its children. Removing a location stops its listing and grouping.
Bookmarked folders, files, sessions, and trust choices remain unchanged. The
legacy single-location setting migrates automatically. An explicitly empty list
stays empty.

### Creator folder controls

In the creator, **Project location** filters **All folders**,
**Pinned and recent**, or one named location. Search by name or path. Filtering
never replaces a typed working folder. **Browse this location** starts
navigation there. **Browse another folder** can reach other directories. The
browser offers an editable path, UP, shortcuts, and new-folder creation at the
displayed parent. **Use for this session** selects a folder without bookmarking
it. **Bookmark folder** explicitly keeps it listed independently of locations.
The workflow name defaults to the selected project's display name and remains
editable.
In Docker, folders must be mounted before they can be selected.

## Before starting

**Prerequisites**

- Node.js 24 or 26
- One provider account or local model endpoint
- On Windows, Git for Windows. Agent shell commands (the Bash tool) and Claude
  Native hooks run in its Git Bash, as in Claude Code. Arco finds it through
  `CLAUDE_CODE_GIT_BASH_PATH`, the Git install that `git` on `PATH` belongs to,
  or the standard install folders. It never uses the WSL `bash.exe` in the
  Windows system folder. Without Git Bash they run in PowerShell, as in Claude
  Code: the model gets a PowerShell tool instead of Bash, and Connections >
  Claude shows a notice with how to get Git Bash. Hooks written for bash need
  Git Bash; a hook can also name its shell with `"shell"` or skip the shell
  with `"args"`.

Provider requests are sent to the provider selected for a turn. API-key providers
may bill according to their own terms. Arco does not submit a chat request until
a user sends a message or starts a model-backed feature.

## Install and start

### Native package

Install the package, then run its interactive setup:

```bash
npm install -g arco-workbench
arco setup
```

`arco setup` asks before installing the per-user service, starts it, and opens
the local URL. Use `arco start` for a foreground run. Use
`arco service install|uninstall|start|stop|restart|status|logs|refresh` to manage the
service directly.

If npm reports `EACCES` for a global install on Linux or macOS, use nvm or a
user-owned npm prefix (for example under Homebrew's Node, or a prefix you own
under your home directory). On Windows, run `arco.cmd` when the PowerShell
execution policy blocks the shim. If install fails with `EEXIST` because an
`arco` link already exists in the global bin folder (for example from an earlier
source checkout's `npm link`), remove that link or run `npm uninstall -g` for
the old package, then install again. If `arco doctor` reports missing or
incompatible native modules, install the platform build tools and run:

```bash
arco setup --repair-native
```

The service keeps `ARCO_HOME`, `ARCO_PORT`, `ARCO_HOST`, and other supported
environment settings from its first install. It refuses existing unowned or
modified service definitions. See [Service mode](SERVICE_MODE.md) for the
systemd user service, LaunchAgent, and Task Scheduler details.

The package uses port 3001 when free and saves a different available port when
needed. If that port later becomes occupied, Arco selects another and shows a
notice. `arco open` and shortcuts follow the saved address; `arco doctor` shows
its status.

`arco open` and the shortcut open Arco in an app window of Chrome, Edge, Brave,
Vivaldi or Chromium, including Flatpak installs on Linux. Choose which one in
**Settings > Advanced > App window browser**, or once with
`arco open --browser <name-or-path>`. Firefox and Safari work as normal tabs;
Arco shows a one-time notice there because it runs lighter in a Chromium-family
browser. See [Service mode](SERVICE_MODE.md) for the search order.

Update a package install with `arco update`, or use **UPDATE AND RESTART** from
a release notice while the packaged service is running. Updating stops running
turns. See [Updating Arco](OPERATIONS.md#updating-arco).

### Docker

Docker keeps the Arco home in a named volume and mounts project folders from the
host. First fetch and list tags, then check out the newest stable release tag;
replace `vX.Y.Z` with the selected tag:

```bash
git fetch --tags origin
git tag --list "v*" --sort=-v:refname
git checkout --detach vX.Y.Z
```

1. Create a local `.env` from `.env.example`.
2. Create the sample folder with `mkdir -p projects` on macOS, Linux, or WSL, or
   `New-Item -ItemType Directory -Force projects` in PowerShell. Alternatively,
   set `ARCO_PROJECTS_DIR` to an existing folder. On Windows, use forward
   slashes, such as `C:/Projects`.
3. Start Compose:

```bash
docker compose up -d --build
```

Open <http://localhost:3001>. The published port is bound to host loopback. The
selected project folder is mounted read-write into the container, so edits affect
those host files. Folders under the mounted root appear in Home using container
paths such as `/projects/demo`, not their host paths.

Sign in to a provider from the same container so credentials are stored in its
persistent home volume:

```bash
docker compose exec arco codex login --device-auth
docker compose exec arco claude auth login --claudeai
```

Follow the link and code instructions shown by the command. The browser can
capture audio, but the image lacks the speech runtime. Sign in to providers
again inside the container, and remember that only mounted folders are visible.
Docker Desktop licensing applies on macOS and Windows. The Compose path is
tested on Linux in CI and documentation acceptance. See [DOCKER.md](DOCKER.md)
for extra bind mounts, service operation, and container limitations.

## Connect a provider

The provider step opens **Welcome - Connections**.

1. Choose a provider.
2. Follow its sign-in or API-key steps.
3. Check the connection.
4. Select **Continue to chat**.

**Skip for now** marks setup complete without connecting a provider and opens the
Setup complete screen. In the workspace, **CONNECT A PROVIDER** opens Connections
later.

Settings retains the controls under **Providers and models > Sign-in, accounts
and local endpoints**. CLI-based providers may show a command to run in a
terminal. Search the task-based Settings categories for controls; see
[`SETTINGS.md`](SETTINGS.md) for the full control map. For Ollama in Docker, use
`http://host.docker.internal:11434`. A `localhost` endpoint refers to the
container. The connection check does not send a model prompt.

Provider rows and model choices depend on the installed CLI, account access, or
reachable local model endpoint. A connected indicator means Arco can reach the
provider. It does not guarantee that a requested model is available or that a
provider account has quota.

## Add a project and start a chat

Use **HOME** to find or add work.

- Add a named parent with **Add project location**.
- Open a one-off folder with **Open another folder** (create a new folder from
  inside the folder browser when needed).
- In Docker, only mounted folders are visible and they appear under `/projects`.
- Select **New session** on a project card to open the workflow creator with its
  folder prefilled.
- Use **Saved sessions** to resume prior work.
- Use **Manage...** to pin, rename, archive, relocate, or remove a project
  registration. These actions do not move or delete project files.
- A missing folder offers **Relocate...**.
- When opening the creator directly, the folder control is **PROJECT FOLDER** or
  **SHARED PROJECT FOLDER**. **Browse another folder** opens the folder picker,
  and **Project location** filters the list.

For registration, scanned and recent folders, the default browsing location, or
project trust, open **Settings > Projects**. Home is the place to find and resume
work or start a session from a project card. The full control map is in
[`SETTINGS.md`](SETTINGS.md).

### Launch a project chat

1. Select **New session** on a project card, or choose **Start > New session** on
   HOME and choose a folder in the creator.
2. Without a saved default, the creator starts on the first enabled, connected
   provider. A saved default that is not connected stays selected and is marked
   not connected. Launch stays disabled until a connected provider is chosen or
   sign-in completes from **Connections**.
3. Choose an available model.
4. Select **SAFE** or **AUTO** permissions according to the project's trust
   level. Use **SAFE** for an unfamiliar repository.
5. Select **LAUNCH WORKFLOW**, wait for the provider to connect, then send a
   small request in the composer.

### Chat without project tools

For a plain saved conversation without file or project tools, choose **CHAT** in
the creator and select **START CHAT**. Saved Chat is the default. Incognito Chat
is memory-only in Arco and cannot be resumed after closing the tab.

## Create a first cluster

A cluster is a group of workflow members that share one project folder. It needs
at least two members, each with a model selected.

1. Open the workflow creator from **HOME** and select **CLUSTER**.
2. Set the shared folder in **PROJECT FOLDER**. All members use this same folder.
3. Optionally start from a template (Pair, Small team, Research, Medium team,
   Full team, Parallel build, Large team) or **Build my own**. Template review
   lists each member's role and a Recommended model line. Repeated roles offer
   an editable Work size choice (Research starts unset; the two-builder templates
   recommend Heavy and Standard). Choose provider and model from connected
   providers, then **USE THESE MEMBERS**.
4. Or configure at least two member rows by hand. Each member's provider is a
   button group of enabled, connected cluster providers. A saved disconnected
   choice stays visible as **(not connected)**. Provider defaults seed members
   added later; they do not replace existing rows. By default a cluster accepts
   one member per local runtime (Ollama, llama.cpp). Raise "Cluster members that
   may use this runtime at once" in Connections to allow more.
5. Optionally describe the project purpose and leave **Have the director draft a plan for review** checked. Choose a director in the member list. After creation, review the draft before attaching it; leave the purpose empty to skip the drafting turn. For a public project, tick **This project is public (or will be)** beside it. See [Plan or board?](PLAN_OR_BOARD.md).
6. Select **CREATE CLUSTER**. The cluster tab opens with its members. Member
   cards default to the **ROWS** layout (AUTO, COLS, and GRID remain available).

A cluster may have at most one director (roles beginning with Director or
Coordinator count). Existing clusters that already have two directors remain
intact, show a warning on MEMBERS, and still allow REPLACE that preserves both
roles. Work size is a hint for the director and does not change model or effort.
Arco does not otherwise auto-route work from role or work size. AUTO-PICKUP on
the cluster header stays Off until armed. Rule-based is the recommended
automatic mode; Smart Observe-only and Smart Automatic need an evaluator on
Claude Native, Cursor, Codex, Ollama, LM Studio, llama.cpp, Strata, or DeepSeek through Xolotl. See the in-app manual for modes and limits.
See [TASK_LEDGER.md](TASK_LEDGER.md) for cluster boards, messages, and saved
tasks.

## Choose a utility agent

Short side jobs such as **BRIEF**, **CATCH ME UP**, and **TIDY** use one
operator-chosen utility agent instead of a workflow's agent. Open
**Settings > Agents and clusters**, or finish Welcome when it offers the
choice. Pick Claude with Native sign-in, Cursor, Codex, Ollama, LM Studio, llama.cpp, Strata, or DeepSeek through Xolotl, choose a model,
then save. For LM Studio, llama.cpp, Strata, and DeepSeek, load the selected model first; these requests never load or switch models. Nothing is selected until that save. **TEST** checks the choice;
**CLEAR** removes it. The utility agent has no tools and only reads facts Arco
already holds. See [Settings: Utility agent](SETTINGS.md#utility-agent).

## Optional voice setup

Voice input uses the browser microphone and local speech components. It requires
a native run on `localhost` or HTTPS. Package users need `uv`, then run:

```bash
arco voice setup
```

From a source checkout, run:

```bash
npm run voice:setup
```

The setup downloads speech components to the configured voice home and writes a
`NOTICES.md` file there with component licenses and upstream sources. Review that
notice and [VOICE.md](VOICE.md) before enabling hands-free mode.

1. Open Arco's **COMPUTER** controls.
2. Enable hands-free.
3. Allow browser microphone access.
4. Say "Computer" followed by a short request.
5. Say "over" to submit. Silence does not send a directive.

## Where state lives

- Global settings, provider connections, clusters, and logs: `~/.arco` on Linux
  and macOS, `%USERPROFILE%\.arco` on Windows.
- Per-project workflows, chats, plans, and project settings: `<project>/.arco`.
  Opening a project creates that folder. It ships its own `.gitignore` so its
  contents stay out of Git by default; adding `.arco/` to the project's root
  `.gitignore` is a sensible extra safeguard.
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

## Continue a terminal session

For a project with local Claude Code or Codex history, open its Home card menu and choose **Continue a session from the terminal**, or use the session creator. Home reads that project history when the menu opens. Select **OPEN** to continue in Arco. Close the terminal session first to avoid concurrent writes. Claude sessions require a connected Claude CLI; the tab uses the CLI transport. Codex uses the terminal account, even when other profiles are configured. Discovery reads the provider history in place. Docker shows these sessions only when the history directories are mounted.
