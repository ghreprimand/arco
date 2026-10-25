# Remote Management

Remote Management provides a separate control plane for checking Arco instances
and responding to pending workflow requests. It does not expose the desktop
workbench or project files to the remote console.

## 1. Security boundary

Remote management is intended for a private network and must not be exposed to
the public internet. The local Arco instance remains authoritative: the hub
routes signed actions, and the instance validates each action against its current
pending request before applying it. Stale or already-answered requests are
rejected locally.

Notifications are one-way and never accept commands. Authenticated actions go
through the management console. Remote management is disabled by default and
must be enabled per workflow. The console has no file browser, arbitrary
terminal, Git push, deployment approval, or provider-credential management.
Remote actions are recorded in `events.jsonl` with the actor, instance,
workflow, and resolved request. The `arco-agent` accepts only signed lifecycle
commands from a fixed allowlist and has no file, workflow, or shell access.

A hub URL alone cannot read files, run a shell, manage credentials, or apply a workflow action rejected by the local instance.

## 2. Architecture

Each Arco service connects outbound to the management hub over a private
WebSocket at `/instance`. The optional `arco-agent` connects at `/agent` and
handles lifecycle commands when the Arco service is stopped. The hub merges the
two connections by instance ID, tracks heartbeat state, routes signed lifecycle
commands to the agent, and routes workflow actions back to the service. The
full Arco frontend is not exposed remotely.

Workflow controls (reply, wait, stop, approve, and deny) require the Arco
service to be running. Service-lifecycle controls (start, stop, restart, and
logs) use the agent or the configured SSH fallback because a stopped service
cannot receive its own restart request.

The hub exposes `GET /api/instances`, `POST /api/instances/:id/lifecycle`, and `/healthz` for the console. Workflow
actions are correlated, timeout-guarded, and revalidated by the owning Arco
instance. `ARCO_HUB_URL` enables the outbound service and agent connections;
without it, remote management remains inactive. `scripts/management/registry.ts`
tracks online, stale, and offline states without deleting an instance record.

## 3. Instance model & capability flags

Multi-instance is a **first-class constraint**: Arco can run on Linux, macOS, Windows, a remote server, or a temporary development instance. The protocol uses capability flags so each platform can report which service controls it supports.

```ts
// shared/src/protocol/remoteManagement.ts  (typed contract)
type Platform     = 'linux' | 'macos' | 'windows' | 'unknown';
type ServiceMode  = 'systemd' | 'launchd' | 'dev' | 'manual' | 'unknown';

interface ManagedArcoInstance {
  instanceId: string;          // stable per install, persisted UUID at ~/.arco/instance-id,
                               //   survives rename/hostname change so history never orphans
  name: string;                // user-assigned display name
  platform: Platform;
  hostname: string;
  tailscale?: { magicDns?: string; ip?: string };  // when available
  version: string;             // Arco version
  gitRevision: string;         // short sha
  serviceMode: ServiceMode;
  capabilities: {
    workflows: boolean;        // can report/route workflow state
    requests: boolean;         // surfaces pending requests
    approvals: boolean;        // accepts approve/deny
    serviceRestart: boolean;   // agent present + can restart local service
    diagnostics: boolean;      // exposes  diagnostics summary
    resourceStats: boolean;    // cheap CPU/mem/disk summary available
  };
  lastHeartbeatAt: number;     // ms epoch; hub derives online/stale/offline
}
```

Each instance heartbeat additionally reports the **live rollup** the console renders (cheap to compute, no
transcript): health state, active-workflow count, waiting-request count, provider-availability summary, and
(when cheap) CPU load / memory pressure / disk free.

**Lifecycle states the console renders** (derived from agent + SSH reachability):

| State | Meaning | Available action |
|---|---|---|
| agent online, service stopped | host up, Arco down | **Start Arco** (via agent) |
| agent unhealthy, SSH reachable | agent down, host reachable | **Repair/Restart Agent**, **Start Arco over SSH** |
| agent offline, SSH reachable | asleep/down agent, host up | **Start over SSH** only |
| instance + SSH offline | machine asleep/off | no remote start without a separate wake path |

The UI distinguishes a stopped Arco process with a reachable agent or SSH target from an unreachable sleeping host.

---

## 4. Heartbeat & registration

- On boot, each Arco service (and its `arco-agent`) opens an **outbound** tailnet WebSocket to the hub
  and sends `instance_register { instance: ManagedArcoInstance }`.
- Thereafter `instance_heartbeat { instanceId, at, rollup }` on a fixed interval (suggest 15s; tunable).
- The hub marks **online** (`now - lastHeartbeatAt < 2×interval`), **stale** (within a grace window), then
  **offline**. Offline never deletes the instance, it shows last-seen so the operator knows *which* machine
  is asleep.
- Registration is **outbound from Arco to the hub** (no inbound port on the Arco instance for the workflow
  layer; only the agent's signed-lifecycle listener, §6, accepts inbound, and only signed commands).

---

## 5. Remote action model (workflow layer)

The console offers exactly these workflow-scoped actions (see section 8):

```ts
type RemoteManagementAction =
  | { type: 'reply';   workflowId: string; requestId: string; body: string }
  | { type: 'wait';    workflowId: string; requestId: string }
  | { type: 'stop';    workflowId: string; requestId: string }
  | { type: 'approve'; workflowId: string; requestId: string; approvalKind: string }
  | { type: 'deny';    workflowId: string; requestId: string; reason?: string };
```

**The console allowlist is:** `reply`, `stop`, `approve` (continue), `deny` (decline), and
`wait` (leave pending). Before an action is available, the console shows the current question, last-turn
summary, provider and model, and context zone. Only these actions can be sent.

Flow: console -> hub signs + routes to the owning instance -> **local Arco re-validates** `requestId`
against its *current* pending request (rejects if already answered/stale) -> applies -> appends to
`events.jsonl` -> the result fans back to the hub and the console. The hub is a **router**, never an
authority on validity.

---

## 6. `arco-agent`, the host supervisor

A tiny always-on supervisor, one per Arco instance, runs at login/boot. **Narrow by construction**. **Autostart:** Linux uses a systemd `--user` unit, enabled at install. The
agent does not autostart on macOS in the current setup. The SSH path in section
7 provides remote recovery while Arco is closed.

- Registers with the hub (same outbound tailnet WS as the instance, or its own).
- Reports whether the full Arco service is running (and `serviceMode`).
- Can **start / stop / restart / tail logs for the local Arco service** using
  `scripts/arco-service.ts` and platform-specific templates. Commands are fixed
  allowlisted templates; they are never free-form.
- **No file access, workflow access, or arbitrary shell.** Its entire inbound vocabulary is the fixed
  `LifecycleCommand` enum:

```ts
type LifecycleCommand =
  | 'arco.status' | 'arco.start' | 'arco.stop' | 'arco.restart' | 'arco.logs.tail'
  | 'arco-agent.status' | 'arco-agent.restart';
```

- **Accepts only signed lifecycle commands** from the hub over the private
  network. The Ed25519 signature adds command authenticity and replay protection
  to network authentication. The hub signs each `{ cmd, instanceId, nonce,
  issuedAt }` payload. The agent verifies the signature, freshness, nonce, and
  instance ID before executing. The hub private key stays outside the repository;
  agents store the public key at `~/.arco/agent/hub.pub`.

Platform templates (versioned with Arco, platform-specific):

- **Linux** -> `systemctl --user {status,start,stop,restart} arco`, `journalctl --user -u arco -n 200
  --no-pager`. (These commands reuse the existing `arco service` controls.)
- **macOS** -> `launchctl print|kickstart -k|bootout gui/$UID/com.arco.app`, `tail -n 200
  ~/Library/Logs/Arco/arco.log`. (launchd unit is a later add; manual wrapper documented meanwhile.)

The agent and its signed-command verifier can be tested without a live hub. Generate the hub signing key with `npm run arco:management -- keygen`, provision
the public key to each agent, and configure `ARCO_HUB_URL` for both the service
and agent. Keep the private key outside the repository and use a private network
for the hub connection. The `arco-management` and `arco-agent` CLIs provide install, start, stop, status, restart, logs, uninstall, and self-test commands.
See [`OPERATIONS.md`](OPERATIONS.md) for service installation details.

---

## 7. SSH lifecycle path

A recovery path for when Arco **and** the agent are down but the host is reachable. **Tailscale-SSH only**
(or equivalent tailnet SSH), never public SSH. Constrained:

- Per-instance SSH target configured **explicitly** (no discovery).
- Hub uses a **dedicated key / Tailscale-SSH identity**.
- Commands are **allowlisted** (`arco.{status,start,stop,restart,logs.tail}`,
  `arco-agent.{status,restart}`), never free-form shell from the browser.
- Every command is **shown before execution** and **fully logged** (command, exit code, stdout/stderr
  summary, actor).
- **No file browsing, no interactive terminal** through the console in v1.
- Templates are platform-specific and versioned with Arco (the platform templates in section 6).

The SSH fallback uses `scripts/management/sshLifecycle.ts` to render an
allowlisted command as an argv array. It never builds a shell command string.
When the agent is offline, `sendLifecycleCommand` uses an explicitly configured
SSH target. SSH targets are stored in `~/.arco/hub/ssh-targets.json` and are not
committed. The target includes the host, platform, optional user, and service
unit overrides. `npm run smoke:ssh-lifecycle` checks the renderer with a fake
command runner. SSH commands are not signed by the agent; access depends on the
configured private-network SSH identity and the fixed command allowlist.

---

## 8. Mobile management console

The console is mobile-first and provides quick controls from a phone without exposing the desktop workbench. One-handed layout, large tap targets, no hover-only interactions, no dense tab rows, fast over
mobile networks, **current question/action always above secondary detail**, expandable sections for
transcript snippets / logs / diagnostics.

> The console reuses Arco theme tokens and components while keeping a mobile-first layout.

Each project, workflow, and request card identifies the instance that receives an instruction.

Primary screens:

- **Home:** all Arco instances (online/offline, last heartbeat, version, service status) + all active
  requests.
- **Project:** workflows grouped by cwd; dirty/clean git state, last activity.
- **Workflow:** provider/model/effort, running/waiting/idle, context zone, quota window, last turn summary,
  current question.
- **Request:** focused approve / deny / reply surface (the one action above all detail).
- **Activity:** recent high-signal events with aggressive filtering (not full transcript).
- **Settings:** notification preferences and trusted devices.

> The console is served as static HTML, CSS, and JavaScript from `scripts/management/console.ts`. It uses theme tokens from `client/src/styles/global.css` and is served at `GET /` (+ `/console.css`, `/console.js`) ahead of the `/api/*` control routes.
> - **Home / instance + service-lifecycle layer:** per-instance cards (online/stale/offline badge,
>   host/tailscale, platform/service-mode, version+sha, last-seen + rollup) with **Status / Start / Restart /
>   Stop / Logs** buttons wired to `POST /api/instances/:id/lifecycle`; auto-refresh every 5s; command output
>   inline. Mobile-first: >=44px tap targets, no hover-only, sticky header.
> - **Workflow layer:** when the live
>   Arco *service* is connected, each card grows a **Workflows** section listing each workflow (title,
>   running/idle, provider/model) with **Reply / Continue** (idle) and **Stop** (running) wired to
>   `POST /api/instances/:id/workflow-action`. The away-from-desk approval loop now works end-to-end.
> - **Workflow context:** each workflow row shows the last assistant message (operator
>   directive: length is fine), in a scrollable block (<=60vh so a long one doesn't bury the other workflows),
>   plus last-activity time and last-turn duration. Source: the server tails the workflow's `events.jsonl`
>   (bounded **1MB**; walks back collecting `primary_text`, skipping thinking, to the last
>   `primary_turn_started`; message capped at `MAX_MESSAGE_CHARS=200k` only to bound a runaway). A workflow
>   with no chat turns shows "no conversation turns yet". *Limitation:* a pathologically ledger-snapshot-heavy
>   tail can still push a real message past the 1MB window.
> - **Handoff:** a **Handoff** button per idle workflow rotates the worker **in place
>   (same provider/model, `mode:'original-worker'`)** to free context, confirm-gated; rejected mid-turn
>   (`busy`). Routes as a `handoff` workflow action -> `initHubLink` -> `handleHandoffRequest`.
> - **Transcript:** a **Transcript** link per workflow opens the **full conversation in a
>   new tab**, a standalone read-only Arco-styled page (`GET /api/instances/:id/workflows/:wfid/transcript`).
>   The hub asks the owning service (`transcript_request`/`transcript_response`, correlated by requestId); the
>   service reconstructs turns from `events.jsonl` (`user_message_echo` = operator, `primary_text` = assistant,
>   skip thinking; bounded 8MB / 800 turns).
> - **PWA install:** the hub serves a web-app manifest (`/manifest.webmanifest`,
>   standalone display + dark splash) + an on-brand SVG icon (`/icon.svg`), so Android Chrome's "Add to Home
>   screen" becomes a real standalone install (no URL bar, Arco icon).
> - Project and workflow detail screens, request identifiers, and notification deep links are not available in the current console.

**Desktop transparency indicator.** Under the security boundary in section 1, users can see when an
instance is hub-linked (remotely controllable) and sever it locally. The Arco header shows a **`⬡ HUB ·
<host>`** chip (`client/src/components/HubLinkChip.tsx`, fed by `hub_link_status`) when linked, clicking it
is a confirm-gated **local kill switch** (`hub_link_set_enabled:false` -> `setHubLinkEnabled` stops the link),
and **`HUB OFF`** when configured-but-severed (click reconnects). Renders nothing when no hub is configured.
Status lives in an isolated `hubLinkStore` (not the central appStore). This is the only management element inside the Arco desktop UI. Other remote controls remain in the separate console.
> - **Preview locally (no VPS):** `npm run arco:management -- keygen` then
>   `npm run arco:management -- serve --host 127.0.0.1 --port 3500`, open `http://127.0.0.1:3500` (best in a
>   phone-sized viewport / device toolbar). With no agent connected it shows the empty state; run an agent
>   (`ARCO_HUB_URL=ws://127.0.0.1:3500/agent npm run arco:agent -- run`, after dropping `hub.pub` in place)
>   to see a live card.

---

## 9. Notification linkage

The management console can be linked from one-way notices. The ntfy transport
uses the same notification event contract as the in-app notice center, sends no
commands, and is inactive unless `ARCO_NTFY_URL` is configured. Workflow notices
are sent only when remote access is enabled for that workflow; instance-level
notices are unaffected by that per-workflow gate. Category mutes suppress both
in-app broadcasts and external notices. See [`NOTIFICATIONS.md`](NOTIFICATIONS.md)
for transport configuration and privacy behavior.

---

## 10. Deployment requirements

Use a private network for the management hub and agent connections. Generate the
hub key on the hub, provision only the public key to agents, and keep the
private key outside the repository. Set `ARCO_HUB_URL` in the service and agent
environments. Enable remote access only for workflows that require it. The local
service remains authoritative and can disable its hub link at any time.

---

## 11. Git worktrees per task

Git worktrees can be used independently of the remote agent and hub. They depend on the task ledger, Git, and the checkpoint store (`server/src/gitSnapshots.ts`).

**Goal:** an *optional* isolated git worktree per ledger task so parallel work on one repo doesn't collide.
Creating (or, from the LEDGER tab, electing to isolate) a task can spin a `git worktree add` under a managed
location; checkpoints and diffs operate **within** that worktree. The checkpoint store is a single shared
blob store that **dedupes across worktrees** (the same `refs/arco/...` / content-addressed tar store, keyed
so identical trees from sibling worktrees share storage).

See **`docs/TASK_LEDGER.md`** and **`docs/CHECKPOINTS.md`** for the current mechanism and the
load-bearing invariants (never mutate the user's index/HEAD; `execFile` argv-only; worktrees live under a
managed path, never inside the user's tree; removal is `git worktree remove` + prune, never `rm -rf` of a
path the operator might own).

---

## 12. Typed contract

Remote management uses one protocol module: **`shared/src/protocol/remoteManagement.ts`**, `Platform`,
`ServiceMode`, `ManagedArcoInstance`, `LifecycleCommand`, `RemoteManagementAction`, the
register/heartbeat/action/result message shapes, and the signed-envelope shape. The protocol is exported from `shared/src/protocol/index.ts`. Worktree types live in the task-ledger protocol.

---

## Security properties

- Remote management and per-workflow actions are disabled unless configured.
- The console routes a fixed set of actions; the local instance validates them.
- The agent accepts signed commands from a fixed allowlist and cannot read
  project files or run arbitrary shell commands.
- Notifications carry information only and have no command channel.
- Every remote action is recorded locally and can be disabled from the instance.
