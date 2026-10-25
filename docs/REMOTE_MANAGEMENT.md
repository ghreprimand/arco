# Remote Management (Arco Ops Part K + J2)

> **Status: SHIPPED + DEPLOYED.** The core K1–K4 + J2 management tier began shipping
> 2026-06-03; the cluster-aware Remote Control v2 expansion (A1/A2 + R1–R6) shipped and
> deployed 2026-07-18. The workstation remains authoritative and the `hub-host:3500` hub
> remains a tailnet-only router. Current v2 detail: `docs/REMOTE_CLUSTER_CONTROL_PLAN.md`.

The strongest away-from-desk workflow: **check on workflows and approve/answer requests from a phone** —
without exposing the full Arco UI or file workbench. This Part is a **control plane** for continuance,
status, and *narrow* approvals — **not a second Arco**.

---

## 1. The trust boundary (load-bearing — read first)

Everything here is governed by the four-question fence (`CLAUDE.md` / plan §0.2). The remote tier passes it
**only** because of these rules; relaxing any one re-opens the fence:

1. **Tailnet-only, never public.** No LAN bind, no public internet, no Tailscale **Funnel** on the default
   path. The hub and every agent listen only on the Tailscale interface (MagicDNS / 100.64/10 CGNAT range).
2. **The local Arco instance stays authoritative.** The hub *routes* signed actions; the owning instance
   **re-validates every action against the current pending request** before applying it. A stale or
   already-answered request is rejected locally. The hub never executes workflow work itself.
3. **Notifications inform; they never command.** The notification system (J1/J2) is one-way. All
   authenticated action goes through the tailnet console, never through a reply-to-email or a tappable
   notification payload. This keeps the trust boundary one-directional and simple.
4. **The management surface is intentionally narrower than the desktop app.** Default-OFF globally; explicit
   per-workflow opt-in (`REMOTE CONTINUATION`). No file browser, no arbitrary terminal, no git push / deploy
   approval, no provider-credential management, no broad transcript export — none of these in v1.
5. **Every remote action lands in `events.jsonl`** with the actor, the instance, the workflow, and the
   resolved request — reversible/auditable like every other operator action.
6. **The agent's command surface is a fixed allowlist.** `archon-agent` (K1) accepts only the named lifecycle
   commands in §6, only when **signed** by the hub key, and has **no** file/workflow/shell access.

> Net: a leaked hub URL on the tailnet still cannot read a file, run a shell, manage credentials, or apply a
> workflow action the local instance considers invalid. The blast radius of every layer is bounded by design,
> not by trust.

---

## 2. Architecture — the hub model

Two viable shapes; **the hub model is chosen** (followup §8):

- **direct** — each workstation exposes its own tailnet-only management endpoint. Rejected: N URLs on the
  phone, no single offline view, every workstation exposes a surface.
- **hub (chosen)** — one `archon-management` service (suggested host: `hub-host`) runs the console UI/API on the
  tailnet. Each Arco workstation connects **outbound** to the hub over a tailnet WebSocket and registers as
  an instance. One stable URL on the phone, one link target for notifications, one place that shows
  stale/last-heartbeat when a workstation sleeps, and the full Arco frontend is never exposed remotely.

```
  phone / laptop / tablet              ┌──────────────────────────────┐
  ─────────────────────────  HTTPS ───▶│  archon-management (hub)     │
  (tailnet only, MagicDNS)             │  on hub-host · tailnet-only     │
                                       │  · aggregates instances      │
                                       │  · routes signed actions     │
                                       │  · last-heartbeat/offline    │
                                       └──────────────────────────────┘
                                          ▲ outbound WS (tailnet)  ▲
                          ┌───────────────┘                        └───────────────┐
            ┌─────────────────────────┐                      ┌─────────────────────────┐
            │ linux-desktop            │                      │ macbook                  │
            │  Archon service (B1)     │                      │  Archon service (manual) │
            │  + archon-agent (K1)     │                      │  + archon-agent (K1)     │
            │  systemd --user          │                      │  launchd (later) / manual│
            └─────────────────────────┘                      └─────────────────────────┘
```

Two **layers** that must not be conflated:

- **Workflow controls** — reply / wait / stop / approve / deny against a *live* Arco instance's pending
  request. Travels Archon-service ⇄ hub over the registered WebSocket. Needs the Arco process **alive**.
- **Service-lifecycle controls** — start / stop / restart / tail-logs the Arco process itself. If Arco is
  dead, its own HTTP/WS API cannot receive a restart — so this layer goes through the always-on
  **`archon-agent`** (K1) or, as a fallback, **Tailscale SSH** (K4). Never through the Arco API.

> **AS-BUILT — workflow layer 2026-06-03** (`feat(management): workflow-reporting layer`). The live Arco
> *service* connects to the hub at `/instance` with **role `service`** (the agent uses `/agent`, role
> `agent`; one machine = two connections merged into one card by `instanceId`). The service pushes an
> `instance_workflows` snapshot and applies routed `reply`/`stop`/`continue` actions, **re-validating against
> live state first** (`server/src/management/initHubLink.ts`: `handleCancel` for stop, `handleUserMessage` for
> reply/continue via a synthetic ws+session; **inert unless `ARCHON_HUB_URL` is set**). The connector
> (`server/src/management/hubLink.ts`) is turn-engine-free + injectable; smoke `workflow-reporting` (6/6)
> wires it to a real hub. The hub routes via `routeWorkflowAction` (service socket, `actionId`-correlated,
> timeout-guarded). Note: `ARCHON_HUB_URL` is shared by the agent and the service — the path (`/agent` vs
> `/instance`) is cosmetic, `role` disambiguates, so `export ARCHON_HUB_URL=ws://hub:3500` lights up both.

> **AS-BUILT — K2 hub built locally 2026-06-03** (`feat(management): K2`). The hub spine is built and
> smoke-verified on localhost; the `hub-host` deploy is operator-reviewed (build-local-then-deploy-together).
> - **`scripts/management/registry.ts`** — `InstanceRegistry`: register / heartbeat / remove + online/stale/
>   offline derivation by heartbeat age (online `<2×interval`, stale `≤4×`, offline beyond — **never deletes**,
>   keeps last-seen).
> - **`scripts/management/hub.ts`** — `createHub`: WS server at **`/agent`** for instance connections, **signs**
>   lifecycle commands with the hub private key and routes them to the owning socket (correlated by nonce,
>   timeout-guarded), `routeAction` forwards workflow actions, and a thin tailnet **HTTP control API**
>   (`GET /api/instances`, `POST /api/instances/:id/lifecycle`, `/healthz`) the K3 console consumes. Bind
>   host defaults to loopback for tests; **`serve` refuses `0.0.0.0`/`::`** (trust boundary §1).
> - **`scripts/management/unit.ts`** + **`scripts/archon-management.ts`** — systemd `--user` unit (binds the
>   tailnet IP, `ARCHON_HUB_KEY` env) + CLI: `keygen / serve / install / start|stop|status|restart / logs /
>   uninstall`. `keygen` refuses to overwrite an existing key.
> - **Verify:** `npm run smoke:management-hub` (8 steps — a **real K1 agent wired to a real hub in-process**:
>   register→online, hub-signed command → agent verify+exec → result by nonce, HTTP round-trip, routeAction,
>   closed-socket→offline, state derivation, unit render).
> - **Default port `:3500`** on the `hub-host` tailnet IP `<hub-tailnet-ip>` (`:443` is taken). **Open for deploy:**
>   `archon-management keygen` on `hub-host`, `install --host <hub-tailnet-ip> --port 3500 --enable`, distribute
>   `hub.pub` to agents. The deploy must be additive — see the §6 recon blockquote.

---

## 3. Instance model & capability flags

Multi-instance is a **first-class constraint** — assume Arco runs on several machines at once (Linux
desktop, MacBook, a future VPS worker, a temporary dev instance). The protocol must not depend on
systemd-specific behavior; model **capability flags** instead so macOS (launchd later / manual now) and Linux
(systemd) share one contract.

```ts
// shared/src/protocol/remoteManagement.ts  (typed contract — see §12)
type Platform     = 'linux' | 'macos' | 'windows' | 'unknown';
type ServiceMode  = 'systemd' | 'launchd' | 'dev' | 'manual' | 'unknown';

interface ManagedArchonInstance {
  instanceId: string;          // stable per install — persisted UUID at ~/.archon/instance-id (§13.4),
                               //   survives rename/hostname change so history never orphans
  name: string;                // operator-assigned friendly name: 'linux-desktop', 'macbook' (§13.4)
  platform: Platform;
  hostname: string;
  tailscale?: { magicDns?: string; ip?: string };  // when available
  version: string;             // Archon version
  gitRevision: string;         // short sha
  serviceMode: ServiceMode;
  capabilities: {
    workflows: boolean;        // can report/route workflow state
    requests: boolean;         // surfaces pending requests
    approvals: boolean;        // accepts approve/deny
    serviceRestart: boolean;   // agent present + can restart local service
    diagnostics: boolean;      // exposes A-series diagnostics summary
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

The UI must make this explicit: *a dead Arco process is recoverable if the host-level agent/SSH is alive; a
sleeping laptop is not recoverable from the console unless a wake path is configured.*

---

## 4. Heartbeat & registration

- On boot, each Arco service (and its `archon-agent`) opens an **outbound** tailnet WebSocket to the hub
  and sends `instance_register { instance: ManagedArchonInstance }`.
- Thereafter `instance_heartbeat { instanceId, at, rollup }` on a fixed interval (suggest 15s; tunable).
- The hub marks **online** (`now − lastHeartbeatAt < 2×interval`), **stale** (within a grace window), then
  **offline**. Offline never deletes the instance — it shows last-seen so the operator knows *which* machine
  is asleep.
- Registration is **outbound from Arco to the hub** (no inbound port on the workstation for the workflow
  layer; only the agent's signed-lifecycle listener, §6, accepts inbound — and only signed commands).

---

## 5. Remote action model (workflow layer)

The console offers exactly these workflow-scoped actions (followup §8):

```ts
type RemoteManagementAction =
  | { type: 'reply';   workflowId: string; requestId: string; body: string }
  | { type: 'wait';    workflowId: string; requestId: string }
  | { type: 'stop';    workflowId: string; requestId: string }
  | { type: 'approve'; workflowId: string; requestId: string; approvalKind: string }
  | { type: 'deny';    workflowId: string; requestId: string; reason?: string };
```

**v1 console allowlist (resolved §13.5):** `reply`, `stop`, and `approve` ("continue") — plus `deny`
("decline") as continue's inverse and `wait` (do-nothing/leave-pending). The console must surface enough
context (current question, last-turn summary, provider/model, context zone) to make an informed decision
*before* any of these is offered — the operator's stated bar: "surface enough information for me to make an
informed decision." No action beyond this enum exists in v1; widening it is a later, separately-fenced step.

Flow: console → hub signs + routes to the owning instance → **local Arco re-validates** `requestId`
against its *current* pending request (rejects if already answered/stale) → applies → appends to
`events.jsonl` → the result fans back to the hub and the console. The hub is a **router**, never an
authority on validity.

---

## 6. `archon-agent` — the per-host supervisor (K1)

A tiny always-on supervisor, one per workstation, runs at login/boot. **Narrow by construction**. **Autostart
(resolved §13.3):** Linux gets a systemd `--user` unit (mirrors `archon.service`, enabled at install);
**macOS does NOT autostart** in v1 — the agent starts only when Arco is launched from the app launcher (a
launchd unit is a later add). So on macOS the SSH path (§7) is the primary remote-recovery route until the app
is opened.

- Registers with the hub (same outbound tailnet WS as the instance, or its own).
- Reports whether the full Arco service is running (and `serviceMode`).
- Can **start / stop / restart / tail-logs the local Arco service** — reusing the **B1** control surface
  (`scripts/archon-service.ts`: `systemctl --user {start,stop,status}` on Linux; the documented manual /
  launchd path on macOS). The agent shells **the same allowlisted templates**, never free-form.
- **No file access, no workflow access, no arbitrary shell.** Its entire inbound vocabulary is the fixed
  `LifecycleCommand` enum:

```ts
type LifecycleCommand =
  | 'archon.status' | 'archon.start' | 'archon.stop' | 'archon.restart' | 'archon.logs.tail'
  | 'archon-agent.status' | 'archon-agent.restart';
```

- **Accepts only signed lifecycle commands** from the hub over the tailnet. Signature model (**resolved
  2026-06-03, §13.2**): an **Ed25519** keypair; the **hub holds the private key**, each agent is provisioned
  the hub's **public key** at install. The tailnet already authenticates *transport* (only tailnet peers can
  reach the agent at all); the signature adds *command authenticity + replay protection* on top, so even a
  compromised tailnet peer cannot forge a lifecycle command — the "most secure without being complicated"
  point between "trust any tailnet caller" (weaker) and a full cert PKI (more complex). Every command is
  `{ cmd, instanceId, nonce, issuedAt }` signed detached; the agent verifies signature + freshness (reject
  `issuedAt` skew beyond a small window) + single-use nonce (replay guard) + `instanceId` match before
  executing. Keys live outside the repo (`~/.archon/agent/hub.pub` on the host; the hub's private key on
  `hub-host`, never committed).

Platform templates (versioned with Arco, platform-specific):

- **Linux** → `systemctl --user {status,start,stop,restart} archon`, `journalctl --user -u archon -n 200
  --no-pager`. (These already exist behind `archon service` — K1 reuses them, it does not re-implement.)
- **macOS** → `launchctl print|kickstart -k|bootout gui/$UID/com.archon.app`, `tail -n 200
  ~/Library/Logs/Archon/archon.log`. (launchd unit is a later add; manual wrapper documented meanwhile.)

**Buildable without the VPS:** the agent binary, the signed-command verifier, the allowlist, and the local
lifecycle exec are all host-side and headlessly smoke-testable (generate a throwaway keypair, sign a command,
assert verify+exec; assert an unsigned/replayed/forged command is rejected; assert a non-allowlisted command
is rejected). What needs the operator: the **real key provisioning** and **pairing the agent to the hub on
`hub-host`** — done in the collaborative session.

> **AS-BUILT — K1 host-side shipped 2026-06-03** (`feat(agent): K1 host-side`). The whole supervisor minus
> the live hub WS endpoint (which is K2) is built and smoke-verified:
> - **`scripts/agent/signing.ts`** — Ed25519 sign/verify, canonical fixed-order payload serialization,
>   freshness window, nonce. **`allowlist.ts`** — `LifecycleCommand → argv` (argv-only, no shell).
>   **`handle.ts`** — verify→render→exec via an injectable runner + `NonceStore` (single-use + TTL prune).
>   **`identity.ts`** — persisted instance UUID + friendly name + descriptor. **`agent.ts`** — outbound
>   register/heartbeat/dispatch loop (injectable socket/runner/clock) + production `systemctl` runner.
>   **`unit.ts`** — systemd `--user` unit render (Restart=always). **`scripts/archon-agent.ts`** — CLI:
>   `keygen / install / start|stop|status|restart / logs / uninstall / selftest / run`.
> - **Typed contract:** `shared/src/protocol/remoteManagement.ts` (exported from the barrel; NOT yet folded
>   into the client/server WS unions — that is K2).
> - **Verify:** `npm run archon:agent -- selftest` (offline crypto+allowlist check) and
>   `npm run smoke:archon-agent` (11 steps: valid exec, every reject path never reaching the runner, nonce
>   single-use+prune, and a register+command round-trip against an in-process fake hub).
> - **Open for the collaborative session:** run `archon-agent keygen` on the hub, copy `hub.pub` to each
>   agent, `archon-agent install --enable --hub ws://<hub-host-tailnet>:<port>`, then `run`.

> **Deployment environment — `hub-host` recon (recorded 2026-06-03).** Tailnet IP **`<hub-tailnet-ip>`**.
> **Ports already in use (do NOT collide):** nginx `:80`/`:443` (public), postgres `:5432`, redis `:6379`,
> PM2 Go svc `:3400`/`:3200`, `node /opt/rift` `:3300`, `node /opt/<app>` `:3100`, gunicorn `:5000`,
> docker-proxy `:9000`/`:9443`, and **tailscaled already owns `:443` on the tailnet interface**. So the K2
> hub must bind a *free* tailnet port (e.g. **`:3500`**) — `:443` is taken. The box runs many unrelated
> services; the hub install must be additive and must never restart/modify anything it didn't create.
>
> **Runtime: PM2, NOT systemd `--user`.** Recon (2026-06-03) shows every service on `hub-host` runs under
> **PM2** as root (`deaddrop`, `mws`, `<monitor-app>`, `pm2-logrotate`), and root has `Linger=no` — so a
> systemd `--user` unit would not survive logout/reboot. The hub therefore deploys under PM2 (matching the
> box; restart + boot-resurrect for free), **not** via `archon-management install`. node `v20`, git present;
> no Arco checkout yet. Turnkey additive deploy:
> ```bash
> # on hub-host (root), additive — touches nothing already running:
> git clone <archon remote> ~/Archon && cd ~/Archon
> npm install                                   # tsx is a devDep → npx tsx resolves locally
> npm run archon:management -- keygen           # → ~/.archon/hub/{hub.key(600),hub.pub}
> pm2 start "npx tsx scripts/archon-management.ts serve --host <hub-tailnet-ip> --port 3500" \
>     --name archon-management
> pm2 save                                       # persist across reboot (PM2 resurrect already configured)
> # then copy ~/.archon/hub/hub.pub to each agent host's ~/.archon/agent/hub.pub
> ```
> The console is then at `http://hub-host-tailnet:3500/` from any tailnet device (phone). **Done together** —
> outward-facing on a shared production box.
>
> **DEPLOYED 2026-06-03.** GitHub SSH isn't set up on `hub-host` (`git@github.com:…` host-key fails) and we
> didn't want git creds on the shared box, so the hub was **rsync'd over the tailnet** (workstation → hub-host),
> NOT cloned. Lean footprint at **`~/archon-hub/`**: `scripts/` + `shared/src/` + a minimal `package.json`
> (`ws` + `tsx` only — the hub imports shared via RELATIVE paths, no `@archon/shared`, so no workspace
> install, no native builds). `keygen` → `~/.archon/hub/`; runs under **PM2** as `archon-management`
> (`pm2 start ./node_modules/.bin/tsx -- scripts/archon-management.ts serve --host <hub-tailnet-ip> --port 3500`,
> `pm2 save`). Bound to the tailnet IP **`<hub-tailnet-ip>:3500`** (MagicDNS `hub-host.tailnet.ts.net`).
> the workstation's agent + dev server point at it via `ARCHON_HUB_URL=ws://<hub-tailnet-ip>:3500`; the workstation's
> `~/.archon/agent/hub.pub` is the VPS hub's public key. **Re-deploy after repo changes:** re-rsync `scripts/`
> + `shared/src/` to `~/archon-hub/` and `pm2 restart archon-management`.

> **Encrypted cluster vault (2026-07-23).** The same tailnet-only hub now
> exposes `/api/cluster-vault` as an opaque manual object store for portable
> cluster snapshots. Workstations build/verify `.archoncluster` bundles and
> AES-256-GCM encrypt them before upload; the vault key remains local at
> `~/.archon/cluster-vault.key`. Hub files live under
> `~/.archon/hub/cluster-vault/` as ciphertext + bounded list metadata. This is
> storage only: the hub cannot decrypt, restore, or act on a cluster.

---

## 7. SSH lifecycle path (K4)

A recovery path for when Arco **and** the agent are down but the host is reachable. **Tailscale-SSH only**
(or equivalent tailnet SSH), never public SSH. Constrained:

- Per-instance SSH target configured **explicitly** (no discovery).
- Hub uses a **dedicated key / Tailscale-SSH identity**.
- Commands are **allowlisted** (`archon.{status,start,stop,restart,logs.tail}`,
  `archon-agent.{status,restart}`) — never free-form shell from the browser.
- Every command is **shown before execution** and **fully logged** (command, exit code, stdout/stderr
  summary, actor).
- **No file browsing, no interactive terminal** through the console in v1.
- Templates are platform-specific and versioned with Arco (the same Linux/macOS maps as §6).

Needs the operator: the Tailscale-SSH identity + per-instance targets. Specced now, built with you.

> **As built (2026-06-03).** `scripts/management/sshLifecycle.ts` (pure) wraps the **same** allowlist template
> (`scripts/agent/allowlist.ts`) into an `ssh` argv — remote argv passed after `--`, never a shell string, so
> there's no interpolation surface. The hub (`createHub`) gained `sshTargets` + an injectable `sshExec`
> (defaults to spawning `ssh`): `sendLifecycleCommand` now, when the agent socket is **down**, looks up an SSH
> target (by instanceId then friendly name) and runs the command over Tailscale SSH instead — the dispatch
> carries `via:'agent'|'ssh'` and an `ssh-failed` error on a non-zero exit. **NOT Ed25519-signed** (no agent to
> verify): the tailnet + ACLs are the auth, and the rendered command is always an allowlist template (the
> renderer returns `null` for anything off-platform/off-allowlist). Targets load from
> `~/.archon/hub/ssh-targets.json` on the hub (`{ "<id-or-name>": { host, platform, user?, …unit overrides } }`,
> never committed). `npm run smoke:ssh-lifecycle` (7, pure, fake exec).
>
> **Deployed + verified (hub-host → workstation).** workstation advertises Tailscale SSH; `operator@workstation` is reachable from
> the hub and `systemctl --user` responds over that session. ssh-targets.json maps
> `workstation → {host:"workstation", platform:"linux", user:"operator"}`. **Promoted 2026-06-03:** workstation now runs the
> compiled server under a systemd `--user` unit (`archon.service`) + the agent (`archon-agent.service`), with
> `enable-linger <user>` so both come up at boot without a login session. The B1 install bakes `ARCHON_HUB_URL` +
> `ARCHON_NTFY_URL` into the service unit (`renderSystemdUnit` env passthrough) and `ARCHON_HUB_URL` into the
> agent unit, so the durable service hub-links + pushes ntfy exactly like the dev launcher's inline env did.
> `systemctl --user restart archon.service` over SSH now hits a real unit — restart-from-phone works even when
> the agent is also down. The Mac path uses `launchctl` templates; see `docs/REMOTE_MANAGEMENT_MAC_SETUP.md §5`.

---

## 8. Mobile management console (K3)

**Mobile-first** — a companion console for quick decisions from a phone, **not** a compressed desktop
Workbench. One-handed layout, large tap targets, no hover-only interactions, no dense tab rows, fast over
mobile networks, **current question/action always above secondary detail**, expandable sections for
transcript snippets / logs / diagnostics.

> **Visual bar (operator directive, 2026-06-03):** the console must be **styled in the same visual language
> as Arco itself** — the dark Arco theme, same typography/spacing/component feel — and **look really
> nice**, not a bare-bones admin page. Treat polish as a first-class K3 acceptance criterion. Reuse Arco's
> theme tokens / CSS variables / component idioms (`docs/CLIENT.md`) rather than inventing a separate look;
> mobile-first ergonomics carry the Arco aesthetic, they don't replace it.

**Every project, workflow, and request card carries an instance label** — the operator must never be unsure
which machine receives an instruction.

Primary screens:

- **Home** — all workstations (online/offline, last heartbeat, version, service status) + all active
  requests.
- **Project** — workflows grouped by cwd; dirty/clean git state, last activity.
- **Workflow** — provider/model/effort, running/waiting/idle, context zone, quota window, last turn summary,
  current question.
- **Request** — focused approve / deny / reply surface (the one action above all detail).
- **Activity** — recent high-signal events with aggressive filtering (not full transcript).
- **Settings** — notification preferences and trusted devices.

> **AS-BUILT — K3 v1 (Home screen) shipped 2026-06-03** (`feat(management): K3`). **Server-rendered** by the
> hub (operator decision): static HTML + CSS + vanilla JS, so the phone renders it and the VPS cost is ~nil —
> no React bundle, no build step. **`scripts/management/console.ts`** (`consoleHtml` / `consoleCss` /
> `consoleJs`) lifts Arco's **actual** theme tokens from `client/src/styles/global.css`
> (phosphor-green `#4af066` on near-black `#0c0e10`, Share Tech Mono / JetBrains Mono, sharp corners,
> hairline-green borders, scanline vignette + glow on online cards) — it reads as Arco, not an imitation.
> Served at `GET /` (+ `/console.css`, `/console.js`) ahead of the `/api/*` control routes.
> - **Home / instance + service-lifecycle layer:** per-instance cards (online/stale/offline badge,
>   host/tailscale, platform/service-mode, version+sha, last-seen + rollup) with **Status / Start / Restart /
>   Stop / Logs** buttons wired to `POST /api/instances/:id/lifecycle`; auto-refresh every 5s; command output
>   inline. Mobile-first: ≥44px tap targets, no hover-only, sticky header.
> - **Workflow layer (shipped 2026-06-03 — `feat(management): workflow-reporting layer`):** when the live
>   Arco *service* is connected, each card grows a **Workflows** section listing each workflow (title,
>   running/idle, provider/model) with **Reply / Continue** (idle) and **Stop** (running) wired to
>   `POST /api/instances/:id/workflow-action`. The away-from-desk approval loop now works end-to-end.
> - **Decision context (§13.5):** each workflow row shows the **FULL last assistant message** (operator
>   directive: length is fine), in a scrollable block (≤60vh so a long one doesn't bury the other workflows),
>   plus last-activity time and last-turn duration. Source: the server tails the workflow's `events.jsonl`
>   (bounded **1MB**; walks back collecting `primary_text`, skipping thinking, to the last
>   `primary_turn_started`; message capped at `MAX_MESSAGE_CHARS=200k` only to bound a runaway). A workflow
>   with no chat turns shows "no conversation turns yet". *Limitation:* a pathologically ledger-snapshot-heavy
>   tail can still push a real message past the 1MB window.
> - **Handoff (shipped 2026-06-03):** a **Handoff** button per idle workflow rotates the worker **in place
>   (same provider/model — `mode:'original-worker'`)** to free context — confirm-gated; rejected mid-turn
>   (`busy`). Routes as a `handoff` workflow action → `initHubLink` → `handleHandoffRequest`.
> - **Transcript (shipped 2026-06-03):** a **Transcript** link per workflow opens the **full conversation in a
>   new tab** — a standalone read-only Archon-styled page (`GET /api/instances/:id/workflows/:wfid/transcript`).
>   The hub asks the owning service (`transcript_request`/`transcript_response`, correlated by requestId); the
>   service reconstructs turns from `events.jsonl` (`user_message_echo` = operator, `primary_text` = assistant,
>   skip thinking; bounded 8MB / 800 turns).
> - **PWA install (shipped 2026-06-03):** the hub serves a web-app manifest (`/manifest.webmanifest`,
>   standalone display + dark splash) + an on-brand SVG icon (`/icon.svg`), so Android Chrome's "Add to Home
>   screen" becomes a real standalone install (no URL bar, Arco icon).
> - **Still future:** dedicated full-screen Project/Workflow drill-downs, explicit per-request ids, and the J2
>   push that deep-links into a specific request.

**Desktop transparency indicator (shipped 2026-06-03).** Per §1, the operator should be able to SEE when an
instance is hub-linked (remotely controllable) and sever it locally. The Arco header shows a **`⬡ HUB ·
<host>`** chip (`client/src/components/HubLinkChip.tsx`, fed by `hub_link_status`) when linked — clicking it
is a confirm-gated **local kill switch** (`hub_link_set_enabled:false` → `setHubLinkEnabled` stops the link),
and **`HUB OFF`** when configured-but-severed (click reconnects). Renders nothing when no hub is configured.
Status lives in an isolated `hubLinkStore` (not the central appStore). This is the only management element
inside the Arco desktop UI — everything else stays in the separate console (§1 rule 4).
> - **Preview locally (no VPS):** `npm run archon:management -- keygen` then
>   `npm run archon:management -- serve --host 127.0.0.1 --port 3500`, open `http://127.0.0.1:3500` (best in a
>   phone-sized viewport / device toolbar). With no agent connected it shows the empty state; run an agent
>   (`ARCHON_HUB_URL=ws://127.0.0.1:3500/agent npm run archon:agent -- run`, after dropping `hub.pub` in place)
>   to see a live card.

---

## 9. Notification linkage (J2 — pairs with K2)

J1 (in-app notices) shipped 2026-06-02 with a single event contract
(`shared/src/protocol/notifications.ts`, `WorkbenchNotice` + 7 categories). **J2** reuses that exact contract
over external transports — **email / ntfy / Pushover / desktop push** (Signal/Matrix bridge later). Email is
a **prompt, not a command channel**: compact + high-signal (Arco mark + workflow title, project/workstation,
a status row, one "what happened" + one "what Arco needs", a **link to the tailnet console**, plain-text
fallback). **No commands accepted by any transport** — the console handles authenticated action. J2's only
new server surface is per-transport `emit()` wiring at J1's existing chokepoint + transport config; **depends
on K2** for the console link to resolve. Needs the operator: transport credentials (ntfy topic / Pushover
token / SMTP). Built with you. Full contract: `docs/NOTIFICATIONS.md`.

> **As built (2026-06-03) — ntfy transport shipped + deployed.** The first J2 transport is **ntfy**, self-hosted
> on the `hub-host` hub box. Server: a `registerNoticeTransport` seam on the J1 chokepoint (`emit()` fans out to
> transports AFTER the in-app broadcast and ONLY for non-muted notices — muting suppresses the push for free) +
> `server/src/ntfyTransport.ts` (inert unless `ARCHON_NTFY_URL` set; builds an ascii-safe ntfy POST with a
> `Click` tap-link to the K2 console derived from `ARCHON_HUB_URL`). Deployed: ntfy 2.x release binary under PM2
> (`archon-ntfy`, reboot-durable), `listen-http` bound to **the tailnet IP `:3501` only** (never `0.0.0.0`), with
> `upstream-base-url: https://ntfy.sh` so the official Android app gets instant push while message **content
> stays on the tailnet** (only an opaque wakeup id transits ntfy.sh). The **topic name is the secret** (tailnet-
> only, no auth v1) — it lives in `<hub-host>:/root/ntfy/topic.txt` + the workstation `ARCHON_NTFY_URL`, never
> committed. Prompt-only (no inbound). `npm run smoke:ntfy` (7, pure). Mac shares the same topic — see
> `docs/REMOTE_MANAGEMENT_MAC_SETUP.md §6`. **Still future:** SMTP email transport.

---

## 10. What's VPS-dependent vs. buildable now

| Phase | Buildable headlessly tonight | Needs the operator (VPS / keys / taste) |
|---|---|---|
| **K1** agent | ✅ **host-side shipped** — verifier, allowlist, lifecycle exec, register/heartbeat loop, smoke | real key provisioning, hub pairing on `hub-host` |
| **K2** hub | ✅ **DEPLOYED on `hub-host:3500`** (PM2 `archon-management`, rsync'd to `~/archon-hub`, tailnet-bound) | — |
| **K3** console | ✅ **Home + workflow actions shipped** — server-rendered, Archon-styled; lifecycle + reply/stop/continue | mobile-UI review on a real phone; dedicated Project/Workflow/Request drill-down screens |
| **K4** SSH path | ✅ **shipped + deployed** — pure renderer + hub fallback (`via:'ssh'`); hub-host→`operator@workstation` verified | finishes once workstation is a systemd service (B1); Mac targets + ACLs |
| **J2** transports | transport adapters + config plumbing | self-hosted ntfy topic on `hub-host` (first), then SMTP |
| **K5** worktrees | ✅ **shipped** — no VPS, no keys, no trust boundary | nothing (see §11) |

**Decision (2026-06-03):** the design (this doc, §13 resolved) + **K5** + **K1 host-side** + **K2 hub** +
**K3 console v1** are built (local; smoke-verified). Remaining: the **K2/K3 deploy on `hub-host:3500`** (+ agent
key provisioning), **K4** (SSH path), **J2** (ntfy), and the **workflow-reporting layer** that unlocks the K3
Project/Workflow/Request screens (reply/stop/continue). Approach is **build locally, verify, deploy together**.
Next concrete step: the **deploy on `hub-host`** (operator-reviewed footprint, additive-only), then the
workflow-reporting layer + K4 + J2.

---

## 11. K5 — Git worktrees per task (local, independent)

Absorbed from old Part E4. **Depends only on D1 (task ledger, ✅) + git + the A2 checkpoint store
(`server/src/gitSnapshots.ts`, ✅)** — the listed K1 dependency is *ordering within Part K*, not functional;
K5 needs nothing from the agent/hub and ships standalone.

**Goal:** an *optional* isolated git worktree per ledger task so parallel work on one repo doesn't collide.
Creating (or, from the LEDGER tab, electing to isolate) a task can spin a `git worktree add` under a managed
location; checkpoints and diffs operate **within** that worktree. The checkpoint store is a single shared
blob store that **dedupes across worktrees** (the same `refs/archon/...` / content-addressed tar store, keyed
so identical trees from sibling worktrees share storage).

See **`docs/TASK_LEDGER.md` § Worktrees** and **`docs/CHECKPOINTS.md`** for the as-built mechanism and the
load-bearing invariants (never mutate the user's index/HEAD; `execFile` argv-only; worktrees live under a
managed path, never inside the user's tree; removal is `git worktree remove` + prune, never `rm -rf` of a
path the operator might own).

---

## 12. Typed contract

The whole tier shares one protocol module: **`shared/src/protocol/remoteManagement.ts`** — `Platform`,
`ServiceMode`, `ManagedArchonInstance`, `LifecycleCommand`, `RemoteManagementAction`, the
register/heartbeat/action/result message shapes, and the signed-envelope shape. Added to
`shared/src/protocol/index.ts`. (K5's worktree types live with the task-ledger protocol, not here — they are
local-workbench, not remote.)

---

## 13. Operator decisions — RESOLVED 2026-06-03

All six gating decisions are settled. K1/K2 build against these; the two the operator delegated (§13.2
signing, §13.6 transports) carry the recommendation that was locked in — revisit before the collaborative
session if either reads wrong.

1. **Hub host** — ✅ **`hub-host`, tailnet-only, no Funnel.** The phone is on the tailnet, so the console never
   needs a public path. Hub and agents bind only to the Tailscale interface.
2. **Signing scheme** *(operator-delegated → chosen)* — ✅ **Ed25519, hub-private / agent-public.** Tailnet
   authenticates transport; the Ed25519 detached signature adds command authenticity + replay protection, so
   a compromised tailnet peer still can't forge a lifecycle command. Chosen over "trust any tailnet caller"
   (weaker) and full cert PKI (more complex) as the most-secure-without-being-complicated point. Hub private
   key lives on `hub-host` (never committed); each agent is provisioned `~/.archon/agent/hub.pub` at install.
3. **Agent autostart** — ✅ **Linux: systemd `--user` unit, enabled at install** (mirrors `archon.service`).
   **macOS: no autostart in v1** — agent starts only when Arco is launched from the app launcher; launchd
   unit deferred. macOS leans on the SSH path (§7) for remote recovery until the app is opened.
4. **Instance identity** — ✅ **Persisted UUID at `~/.archon/instance-id`** (stable across rename/hostname
   change) + **operator-assigned friendly names** (`linux-desktop`, `macbook`) as the display/addressing
   label. Instance = machine; friendly names are predefined by the operator, the UUID keeps history anchored.
5. **`REMOTE CONTINUATION`** — ✅ **OFF globally + per-workflow opt-in.** v1 action allowlist narrowed to
   **reply / stop / continue (`approve`)**, with **decline (`deny`)** as continue's inverse and `wait` as
   leave-pending. Hard requirement: the console must surface enough context (current question, last-turn
   summary, provider/model/effort, context zone) to make an informed decision before offering any action.
   **Shipped 2026-06-03 (the per-workflow gate):** `WorkflowConfig.remoteEnabled` (persisted to meta.json,
   default OFF). The one switch gates all three surfaces on the owning instance — *visibility*
   (`initHubLink.snapshotWorkflows` skips opted-out workflows, so the hub never sees them), *actions*
   (`initHubLink.applyAction` rejects with `remote-disabled`), and *notifications* (the ntfy transport skips
   any notice whose `workflowId` isn't opted in). Toggled from the composer toolbar (`◉ REMOTE`); a flip
   re-pushes the hub snapshot and re-broadcasts `hub_link_status` (header monitored-count) at once. Smoke:
   `npm run smoke:remote-optin`.
6. **J2 first transport** *(operator-delegated → chosen)* — ✅ **ntfy first, self-hosted on `hub-host`.** With a
   VPS already standing up on the tailnet, a self-hosted ntfy topic is the cheapest and most private first
   transport (no third-party account, stays on the tailnet). **SMTP email second.** Pushover/Signal/Matrix
   remain later options. ntfy and email both stay prompt-only — no command channel (§1 rule 3, §9).

---

## 14. Four-question fence check

1. **Operator-initiated / opted-in?** Yes — default OFF, explicit per-workflow `REMOTE CONTINUATION`, every
   action operator-driven from the console.
2. **Bounded by deterministic rules the operator can read?** Yes — fixed action enum, fixed lifecycle-command
   allowlist, fixed SSH templates, capability flags; no LLM in the loop anywhere.
3. **Visible in `events.jsonl`?** Yes — every remote action + lifecycle command logged with actor/instance.
4. **Reversible / peelable?** Yes — global off switch, per-workflow toggle, per-transport disable; the local
   instance can reject any routed action; uninstalling the agent removes the lifecycle surface entirely.

No hard fence is touched: no hidden orchestrator authority, no cross-session instruction mutation, no second-LLM
summarization, no silent context manipulation, no auto-config-mutation. The remote work is operator-armed,
tailnet-only, and the local instance stays authoritative.
