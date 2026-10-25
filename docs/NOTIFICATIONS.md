# Workbench Notifications

> ARCHON_OPS_PLAN.md **Part J**. In-app event notices for workbench events,
> behind a single event contract so the (future) **J2** external transports
> (email / ntfy / Pushover / desktop push) reuse the same shape.
>
> **Trust boundary — inform-only.** The notification system *informs*; it never
> accepts commands. The only client→server message it services is a mute
> *preference*. Authenticated action lives in the Part K tailnet console, not
> here.

## The event contract (`shared/src/protocol/notifications.ts`)

A `WorkbenchNotice` is `{ id, category, severity, title, body?, ts, workflowId?, provider? }`.

**Categories** (`WorkbenchNoticeCategory`, mute is per-category):

| category | when | severity (typical) |
|---|---|---|
| `turn-finished` | a long primary turn completed (≥ 60s) | success |
| `quota-recovered` | a throttled provider became available again | success |
| `auth-expired` | a provider's auth needs re-login | warning |
| `terminal-exited` | a terminal session exited non-zero | warning |
| `preview-failed` | a preview health check failed | error |
| `pr-status` | a PR / CI check status changed | info |
| `backup` | a backup completed or failed | success / error |

**Severity** (`WorkbenchNoticeSeverity`): `info` · `success` · `warning` · `error`
— drives the toast/notice accent and maps to the existing app toast strip's
`info` / `error` levels on the client.

## Wire messages

- **`workbench_notice`** (server → all clients) — a fresh notice. Broadcast to
  every connected client (NOT workflow-scoped: several categories are
  machine-global). The server applies mute suppression *before* broadcasting, so
  any notice that reaches a client is one the operator wants.
- **`notification_mutes`** (server → all clients) — the current muted-category
  set. Sent on connect and after every change, keeping every client's
  notice-center in sync.
- **`set_notification_mutes`** (client → server) — replace the muted set. The
  *only* inbound message the notification path services. Persisted server-side
  (so the suppression also covers J2 transports and survives a restart) and
  re-broadcast as `notification_mutes`.

## Server — the hub (`server/src/notifications.ts`)

One chokepoint so every source is a one-liner and J2 can hang off the same
`emit()`:

- `initNotifications(broadcastFn)` — inject the global all-clients sender +
  load persisted mutes from `~/.archon/notification-mutes.json`. Called once at
  boot (`index.ts`), wired to `for (const ws of sessions.keys()) send(ws, msg)`.
- `emit(notice)` — mint `id` + `ts`, **suppress if the category is muted**
  (returns `null`, nothing broadcast), else broadcast `workbench_notice`.
- `setMutes(cats)` — replace + persist + re-broadcast the snapshot. Serviced
  from the `set_notification_mutes` handler.
- Source helpers: `onTurnStarted` / `onTurnEnded` (long-turn detection — only
  past the 60s threshold), `notifyQuotaRecovered(provider)`.

### Wired sources (this pass)

- **`turn-finished`** — `broadcast.ts` already special-cases
  `primary_turn_started` / `primary_turn_ended`; `onTurnStarted` /
  `onTurnEnded` ride that same spot. Only turns ≥ 60s surface a notice.
- **`quota-recovered`** — `index.ts`'s quota change-listener: `markAvailable`
  only fires the listener on a real throttled→available flip, so a non-throttled
  state there is a recovery → `notifyQuotaRecovered`.
- **`terminal-exited`** — `index.ts`'s `setTerminalExitHook`: a non-zero shell
  exit emits a `terminal-exited` notice (a clean `exit 0` stays quiet).

### Contract-ready sources (follow-up)

`auth-expired`, `preview-failed`, `pr-status`, and `backup` are first-class
categories with copy + severity conventions in the hub; wiring each is an
additive `emit({ category, … })` at the corresponding source (auth-status flip,
preview health check, GitHub PR/check poll, backup CLI completion). No contract
or UI change needed — they already render + mute like the wired three. J2 reuses
the identical `emit()`.

## Client

- **`stores/notificationStore.ts`** — standalone Zustand store (out of
  `appStore`, like `recallStore`): `notices` history (cap 50, newest first),
  the server-authoritative `muted` set, and a `lastSeenTs` marker for the unread
  badge. Mute is enforced server-side, so the store never filters incoming
  notices.
- **`ws/handleServerMessage.ts`** — `workbench_notice` → `pushNotice` (history)
  **and** a transient toast via the existing app strip
  (`appStore.pushNotification`, error/warning → `error`, else `info`).
  `notification_mutes` → `setMutedFromServer`.
- **`components/NotificationCenter.tsx`** — the header bell (`◔ BELL`) with an
  unread badge; the dropdown shows the notice history + a per-category MUTE grid
  (checkbox → `set_notification_mutes` via `onSetMutes`, threaded App →
  SystemHeader → useWebSocket). Always visible — even in I3 focus mode — since
  notices are exactly the "agent finished / something broke" signal focus mode
  is for.
- Transient toasts reuse the existing top-right strip
  (`components/NotificationToasts.tsx`), not a second stack.

## Smoke (`scripts/smoke/notifications.ts`)

Pure — no WS/server boot. Injects a capture-broadcast into the hub and asserts:
every category emits a `workbench_notice`; a muted category is suppressed before
broadcast (`emit` returns `null`, zero wire messages); `setMutes` persists to
disk + re-broadcasts `notification_mutes` and a fresh `init` reloads it (survives
a restart); the long-turn helper only fires past threshold; `notifyQuotaRecovered`
emits. `npm run smoke:notifications` (26 asserts).

## J2 — external transports (ntfy)

J2 reuses the J1 contract over external channels. The first transport is **ntfy**
(self-hosted on the `hub-host` hub box). Prompt-only, same as J1: ntfy carries
title/body/priority + a tap-link to the K2 console; nothing inbound is read.

### The transport seam (`server/src/notifications.ts`)

- `registerNoticeTransport(fn)` — register a fire-and-forget sink.
- `emit()` fans out to every transport **after** the in-app broadcast and **only
  for surviving (non-muted) notices** — so muting a category suppresses the push
  for free. A slow/throwing transport never delays or breaks the in-app path
  (sync throws caught; async rejections swallowed). `_resetTransportsForTest()`
  clears the list for smokes.

### ntfy transport (`server/src/ntfyTransport.ts`)

- **Inert** unless `ARCHON_NTFY_URL` is set (mirrors `hubLink` gating — an
  ordinary `npm run dev` is unchanged). `initNtfyTransport({instanceLabel})` is
  called from `index.ts` after `initNotifications`, labeled with the friendly
  instance name (`loadFriendlyName()`).
- Env: `ARCHON_NTFY_URL` (full topic URL, required to activate) ·
  `ARCHON_NTFY_TOKEN` (optional bearer) · console tap-link from
  `ARCHON_CONSOLE_URL`, else **derived** from `ARCHON_HUB_URL`
  (`deriveConsoleUrl`: `ws→http` / `wss→https`, path dropped).
- `buildNtfyRequest(notice, cfg)` (pure, exported for the smoke) → `{url, headers,
  body}`. Headers: `Title` (ascii-safe — em/en-dashes + smart quotes
  transliterated, remaining non-ascii stripped, whitespace collapsed, ≤200 chars,
  since ntfy headers are latin-1/single-line), `Priority` (error/warning→`high`,
  success→`default`, info→`low`; `urgent` deliberately unused so it can't bypass
  DnD), `Tags` (severity emoji), `Click` (console), `Authorization` (bearer).
  Body: `[workstation]` line first, then the notice body, then an 8-char workflow
  hint when scoped.
- **Smoke** `scripts/smoke/ntfy.ts` (7 steps, pure — temp mutes + injected fake
  fetch): `deriveConsoleUrl` mapping; `buildNtfyRequest` header/body shape +
  priority-by-severity; the chokepoint fans out to a transport for surviving
  notices and **suppresses muted ones**; `initNtfyTransport` inert-without-env /
  active-with-env drives exactly one POST. `npm run smoke:ntfy`.

### Per-workflow gate (REMOTE opt-in)

The ntfy transport takes an injected `isRemoteEnabled(workflowId)` predicate
(wired from `index.ts` against the live `workflows` map). A notice carrying a
`workflowId` pushes to the phone **only when that workflow is opted in to remote**
(`WorkflowConfig.remoteEnabled`, default OFF — REMOTE_MANAGEMENT.md §1.4).
Instance-level notices (no `workflowId`: `quota-recovered`, server events) are
unaffected and always push. The gate lives in the transport closure, *after* the
J1 category-mute chokepoint, so a muted category is still suppressed first. Smoke:
`npm run smoke:remote-optin`.

### Deployed ntfy (hub-host)

Self-contained binary under PM2 (matches `archon-management`; reboot-durable via
the existing `pm2-root.service`), **never apt/systemd-wide** so nothing else on
the shared box is touched:

- `/root/ntfy/ntfy` (release binary) · `serve --config /root/ntfy/server.yml` ·
  `pm2 start … --name archon-ntfy && pm2 save`.
- `server.yml`: `listen-http: <hub-tailnet-ip>:3501` (**tailnet IP only, never
  `0.0.0.0`/public** — the trust boundary) · `base-url: http://<hub-tailnet-ip>:3501`
  · `upstream-base-url: https://ntfy.sh`. The upstream forwards only an **opaque
  wakeup id** to ntfy.sh so the official Android app gets instant push while
  message **content stays on the tailnet** (the phone polls `:3501` directly).
- **Topic name is the secret** (no auth in v1; the server is tailnet-only). The
  live topic lives in `/root/ntfy/topic.txt` on the box and in the workstation's
  `ARCHON_NTFY_URL` — deliberately **NOT** committed here. Add a per-topic ntfy
  access token (`ARCHON_NTFY_TOKEN`) to harden further.

### Phone (official ntfy Android app)

Add a custom server pointing at `http://<hub-tailnet-ip>:3501` (the tailnet name
works too — phone must be on the tailnet), subscribe to the topic. Instant push
works because of `upstream-base-url`; tapping a notice opens the K2 console.
