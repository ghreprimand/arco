# Docker development preview

Arco runs the compiled server, browser UI and provider CLIs in one Linux
container. Docker Desktop supplies the Linux runtime on Windows and macOS.

## Setup and local files

Copy `.env.example` to `.env`. The sample uses `./projects`; create it with
`mkdir -p projects` on macOS, Linux, or WSL, or `New-Item -ItemType Directory -Force projects` in PowerShell. Alternatively, set `ARCO_PROJECTS_DIR` to an
existing project root. On Windows use forward slashes, for example `C:/Projects`.

    docker compose up -d --build

For a build identified by its source revision, run `docker compose build --build-arg ARCO_BUILD_COMMIT=$(git rev-parse HEAD)` before `docker compose up -d`. The image preserves this build argument as `ARCO_BUILD_COMMIT`; `/healthz` and `/api/app/version` include it as `commit`. Builds without the argument and native runs omit `commit`.

Open http://localhost:3001. ARCO_PORT changes the host port. The port is published
on host loopback. This protects network reachability, not separate users on the
host; Arco does not provide multi-user isolation. Remote authentication remains
a separate release requirement. Do not add a tunnel or reverse proxy in front of
this port.

The selected folder is mounted read-write at /projects. Edits change the host
files. A new data volume sets /projects as the default working directory, so
the folder picker starts there. Mounts expose folders on the Docker host, not
on a remote browser's computer.

A folder on the host must be mounted before the container can see it. Mount
extra folders with a compose.override.yaml next to compose.yaml:

    services:
      arco:
        volumes:
          - type: bind
            source: D:/projects/client-site
            target: /work/client-site

Then pick /work/client-site as the working directory of a new workflow.
Creating a new folder from the picker is limited to the container home
(/data/home); create new project folders on the host inside the mounted folder.

Windows folders work through Docker bind mounts, but large repositories, watchers,
permissions and worktrees need host acceptance. WSL Linux folders generally
perform better. Keep Windows-native and Linux-native dependency outputs separate.
Linux tools in the container do not run Windows desktop builds automatically.

## Voice

Voice input requires the native run (see the getting-started guide). A
container cannot reach the computer's microphone portably, and the speech
models installed by `npm run voice:setup` are not part of the image.

## Persistence and permissions

The `arco-data` volume is mounted at `/data`. `HOME` is `/data/home`, containing
`.arco`, `.codex` and `.claude`. Uploads use `/data/uploads`. Container
replacement preserves this volume. `docker compose down` preserves it; adding
`--volumes` deletes it. Project files remain in the host bind mount.

Compose reuses an existing `arco-data` volume when the project name is the same.
Two checkouts with the same directory-derived project name can therefore share
state. Use a distinct project name, for example `docker compose -p arco-clean up
-d --build`, to isolate a fresh run. `docker compose down -v` deletes the named
volume and its Arco home; use it only when that data should be discarded.

### Back up the container home

The application image does not include the repository's backup script or the
`tsx` development dependency. Copy the home out of the stopped container, then
run the backup commands from a host checkout with `ARCO_HOME` set to the copied
directory. Choose a new local destination for `arco-home` each time.

```bash
container="$(docker compose ps --all -q arco)"
docker compose stop arco
docker cp "$container:/data/home/.arco" ./arco-home
ARCO_HOME=./arco-home npx tsx scripts/arco-backup.ts snapshot --out ./arco-home.arcobk
ARCO_HOME=./arco-home npx tsx scripts/arco-backup.ts verify ./arco-home.arcobk
ARCO_HOME=./arco-home npx tsx scripts/arco-backup.ts restore ./arco-home.arcobk --into ./arco-home-restored
```

Restore extracts into a new directory and does not merge over the live home.
With the Arco container stopped, replace `/data/home/.arco` in the named volume
with the extracted directory's contents. Keep the copied original home until
Arco starts and the restored settings and saved work have been checked. Do not
use `docker compose down -v` during this procedure; it deletes the named volume.

The image runs as the node user. On Linux, the selected project directory must
allow that user's UID to read and write. Do not use privileged mode or mount the
Docker socket to solve permissions.

## Providers

Provider sign-in runs inside the container, from a terminal on the host in the
folder containing compose.yaml (Windows Terminal, PowerShell or any shell). The
image pins Codex and Claude Code versions. These commands use the same
persistent home as the running service, so the running Arco sees the login
without a restart:

    docker compose exec arco codex login --device-auth
    docker compose exec arco claude auth login --claudeai

Check login or sign out explicitly:

    docker compose exec arco codex login status
    docker compose exec arco claude auth status
    docker compose exec arco codex logout
    docker compose exec arco claude auth logout

For Codex, open the link the command prints and enter the one-time code. For
Claude, open the link, sign in, and paste the code the page shows back into the
terminal. Claude Native (the in-process API transport) signs in from the
browser: its callback returns to http://localhost:53692, which compose.yaml
publishes on host loopback; if that port is busy, paste the callback URL into
Arco instead.

Codex device login may need enabling in the account's security settings or by
the workspace administrator. Subscription login and API-key billing are separate
authentication methods; this setup uses ChatGPT subscription login. See the
[official OpenAI authentication guide](https://learn.chatgpt.com/docs/auth).
Claude commands follow its [CLI reference](https://code.claude.com/docs/en/cli-reference).

Account eligibility and provider login restrictions apply. These are entry
points for onboarding, not evidence of validated live login on every platform.
Host credentials are never imported automatically.

| Provider | Stock Docker image | Setup still required |
| --- | --- | --- |
| Codex | CLI bundled; exec and app-server adapters retained | ChatGPT login; live refresh/resume acceptance |
| Claude Code | CLI bundled | Claude subscription login and live session acceptance |
| Claude Native | API adapter retained | Browser sign-in through the published callback port; container acceptance pending |
| Ollama / LM Studio | HTTP adapters retained | Reachable model endpoint in provider settings |
| Strata | HTTP adapters retained | Provider configuration and container acceptance |
| Cursor | CLI unbundled; disabled on new volumes | Custom image with `cursor-agent`; explicit enable and acceptance |
| llama.cpp | Executable unbundled; disabled on new volumes | Custom runtime/model setup and acceptance |

These are deployment states, not claims that every adapter has passed live
provider acceptance. Initial disabled-provider settings are written only for a
new volume; updates preserve operator choices. GitHub CLI, media tools, browsers
and language-specific build dependencies are not included in the stock image.

Host model services require a reachable endpoint. Docker Desktop supplies
host.docker.internal; Compose adds the host-gateway alias on Linux. Configure
endpoints explicitly and allow the service to listen on a Docker-reachable
interface. A container's localhost refers to the container itself.
For example, configure Ollama as http://host.docker.internal:11434 and LM Studio
as http://host.docker.internal:1234/v1 when those services run on the Docker host.
Arco does not change those services' bind addresses automatically. Until an
endpoint is saved, Connections may report `http://localhost:11434` as the
Ollama service address. In a container, that address points inside the
container; set the endpoint to `http://host.docker.internal:11434` before
checking the host service.

Project dependencies execute in Linux. Install them in a derived image or an
isolated container workspace as appropriate. Keep host Windows node_modules,
Python virtual environments and compiled binaries separate from Linux outputs.
Only folders mounted into this container are accessible to its workers.

## Operation

    docker compose logs -f arco
    docker compose stop
    docker compose up -d

The restart policy brings the service back when Docker starts unless deliberately
stopped. Docker must stay running. Sleep and Docker restarts interrupt turns;
persistent state is retained without a promise to resume execution automatically.

### Check before updating

Before replacing a running instance, finish or cancel active turns. From an
Arco checkout with its npm dependencies installed, query the local instance you
plan to update:

    ARCO_PREFLIGHT_URL=http://127.0.0.1:3001 npm run deploy:preflight

The default is http://127.0.0.1:3001; use the actual published loopback port if
`ARCO_PORT` differs. Do not include credentials in the URL.

Exit status **0** means no primary turn is active. **2** reports active turns,
with workflow IDs and names. **1** means Arco could not confirm the status;
treat that as busy. The preflight obtains a session cookie and reads the live
turn state over the WebSocket; it never sends prompts or cancels work.

This is a point-in-time check, not a lock. Prevent new work from starting after
the check and run it again immediately before updating. It never authorizes or
performs the update for you.

For updates, back up data and projects, run `docker compose build --pull`, then
`docker compose up -d`. Updates interrupt active turns.

Run npm run smoke:docker for isolated verification with synthetic projects and
fresh state. It checks the real CLI binaries, persistence across container
replacement and a backup of the volume home, then mounts test-only Codex and
Claude protocol fixtures to exercise sign-in through docker exec, the compiled cluster MCP child,
task ownership, peer messaging, active-turn reconnect, review artifacts,
operator acceptance and cancellation. The fixtures use no credentials or
inference and are never installed in the image.

The smoke also starts an Ollama-compatible protocol fixture on the Docker host,
bound to the bridge gateway that host.docker.internal resolves to on Linux
Docker Engine (ARCO_SMOKE_HOST_BIND overrides the address). It confirms the
container's default endpoint is unreachable, configures the host endpoint
through settings, verifies that setting survives container replacement, adds a
tab on the host-served model to the Codex cluster, and checks that the member
reads the coordinator's note and reports back through the peer routes. This
proves the container-to-host path and the mixed-provider plumbing, not a real
Ollama or LM Studio installation.

Windows, macOS, real authentication/refresh, live host-model and model-behavior
acceptance remain separate release gates. Test reports stay outside Git.
