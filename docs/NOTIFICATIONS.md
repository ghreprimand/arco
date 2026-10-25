# Workbench Notifications

Workbench notifications surface selected events in the Arco UI and can forward
muted-category-filtered notices through an optional external transport. They
inform users and never accept commands. The only inbound notification control
changes category mute preferences. Remote actions use the authenticated
[Remote Management](REMOTE_MANAGEMENT.md) console.

## The event contract (`shared/src/protocol/notifications.ts`)

A `WorkbenchNotice` is `{ id, category, severity, title, body?, ts, workflowId?, provider? }`.

**Categories** (`WorkbenchNoticeCategory`, mute is per-category):

| category | when | severity (typical) |
|---|---|---|
| `turn-finished` | a long primary turn completed (>= 60s) | success |
| `quota-recovered` | a throttled provider became available again | success |
| `auth-expired` | a provider's auth needs re-login | warning |
| `terminal-exited` | a terminal session exited non-zero | warning |
| `preview-failed` | a preview health check failed | error |
| `pr-status` | a PR / CI check status changed | info |
| `backup` | a backup completed or failed | success / error |

**Severity** (`WorkbenchNoticeSeverity`): `info` · `success` · `warning` · `error`
, drives the toast/notice accent and maps to the existing app toast strip's
`info` / `error` levels on the client.

## Wire messages

- **`workbench_notice`** (server -> all clients), a fresh notice. Broadcast to
  every connected client (NOT workflow-scoped: several categories are
  machine-global). The server applies mute suppression *before* broadcasting, so
  any notice that reaches a client is one the operator wants.
- **`notification_mutes`** (server -> all clients), the current muted-category
  set. Sent on connect and after every change, keeping every client's
  notice-center in sync.
- **`set_notification_mutes`** (client -> server), replace the muted set. The
  *only* inbound message the notification path services. Persisted server-side
  (so the suppression also covers external transports and survives a restart) and
  re-broadcast as `notification_mutes`.

## Server, the hub (`server/src/notifications.ts`)

One chokepoint so every source is a one-liner and external transports can use the same
`emit()`:

- `initNotifications(broadcastFn)`, inject the global all-clients sender +
  load persisted mutes from `~/.arco/notification-mutes.json`. Called once at
  boot (`index.ts`), wired to `for (const ws of sessions.keys()) send(ws, msg)`.
- `emit(notice)`, mint `id` + `ts`, **suppress if the category is muted**
  (returns `null`, nothing broadcast), else broadcast `workbench_notice`.
- `setMutes(cats)`, replace + persist + re-broadcast the snapshot. Serviced
  from the `set_notification_mutes` handler.
- Source helpers: `onTurnStarted` / `onTurnEnded` (long-turn detection, only
  past the 60s threshold), `notifyQuotaRecovered(provider)`.

### Wired sources (this pass)

- **`turn-finished`**, `broadcast.ts` already special-cases
  `primary_turn_started` / `primary_turn_ended`; `onTurnStarted` /
  `onTurnEnded` ride that same spot. Only turns >= 60s surface a notice.
- **`quota-recovered`**, `index.ts`'s quota change-listener: `markAvailable`
  only fires the listener on a real throttled->available flip, so a non-throttled
  state there is a recovery -> `notifyQuotaRecovered`.
- **`terminal-exited`**, `index.ts`'s `setTerminalExitHook`: a non-zero shell
  exit emits a `terminal-exited` notice (a clean `exit 0` stays quiet).

### Contract-ready sources (follow-up)

`auth-expired`, `preview-failed`, `pr-status`, and `backup` are first-class
categories with copy + severity conventions in the hub; wiring each is an
additive `emit({ category, ... })` at the corresponding source (auth-status flip,
preview health check, GitHub PR/check poll, backup CLI completion). No contract
or UI change needed, they already render + mute like the wired three. ntfy reuses
the identical `emit()`.

## Client

- **`stores/notificationStore.ts`**, standalone Zustand store (out of
  `appStore`, like `recallStore`): `notices` history (cap 50, newest first),
  the server-authoritative `muted` set, and a `lastSeenTs` marker for the unread
  badge. Mute is enforced server-side, so the store never filters incoming
  notices.
- **`ws/handleServerMessage.ts`**, `workbench_notice` -> `pushNotice` (history)
  **and** a transient toast via the existing app strip
  (`appStore.pushNotification`, error/warning -> `error`, else `info`).
  `notification_mutes` -> `setMutedFromServer`.
- **`components/NotificationCenter.tsx`**, the header bell (`◔ BELL`) with an
  unread badge; the dropdown shows the notice history + a per-category MUTE grid
  (checkbox -> `set_notification_mutes` via `onSetMutes`, threaded App ->
  SystemHeader -> useWebSocket). Always visible, even in I3 focus mode, since
  notices are exactly the "agent finished / something broke" signal focus mode
  is for.
- Transient toasts reuse the existing top-right strip
  (`components/NotificationToasts.tsx`), not a second stack.

## Smoke (`scripts/smoke/notifications.ts`)

Pure, no WS/server boot. Injects a capture-broadcast into the hub and asserts:
every category emits a `workbench_notice`; a muted category is suppressed before
broadcast (`emit` returns `null`, zero wire messages); `setMutes` persists to
disk + re-broadcasts `notification_mutes` and a fresh `init` reloads it (survives
a restart); the long-turn helper only fires past threshold; `notifyQuotaRecovered`
emits. `npm run smoke:notifications` (26 asserts).

## External transport (ntfy)

ntfy reuses the in-app event contract over external channels. The optional ntfy transport carries
title/body/priority + a tap-link to the management console; nothing inbound is read.

### The transport seam (`server/src/notifications.ts`)

- `registerNoticeTransport(fn)`, register a fire-and-forget sink.
- `emit()` fans out to every transport **after** the in-app broadcast and **only
  for surviving (non-muted) notices**, so muting a category suppresses the push
  for free. A slow/throwing transport never delays or breaks the in-app path
  (sync throws caught; async rejections swallowed). `_resetTransportsForTest()`
  clears the list for smokes.

### ntfy transport (`server/src/ntfyTransport.ts`)

- **Inert** unless `ARCO_NTFY_URL` is set (mirrors `hubLink` gating, an
  ordinary `npm run dev` is unchanged). `initNtfyTransport({instanceLabel})` is
  called from `index.ts` after `initNotifications`, labeled with the friendly
  instance name (`loadFriendlyName()`).
- Env: `ARCO_NTFY_URL` (full topic URL, required to activate) ·
  `ARCO_NTFY_TOKEN` (optional bearer) · console tap-link from
  `ARCO_CONSOLE_URL`, else **derived** from `ARCO_HUB_URL`
  (`deriveConsoleUrl`: `ws->http` / `wss->https`, path dropped).
- `buildNtfyRequest(notice, cfg)` (pure, exported for the smoke) -> `{url, headers,
  body}`. Headers: `Title` (ascii-safe, em/en-dashes + smart quotes
  transliterated, remaining non-ascii stripped, whitespace collapsed, <=200 chars,
  since ntfy headers are latin-1/single-line), `Priority` (error/warning->`high`,
  success->`default`, info->`low`; `urgent` deliberately unused so it can't bypass
  DnD), `Tags` (severity emoji), `Click` (console), `Authorization` (bearer).
  Body: `[instance]` line first, then the notice body, then an 8-char workflow
  hint when scoped.
- **Smoke** `scripts/smoke/ntfy.ts` (7 steps, pure, temp mutes + injected fake
  fetch): `deriveConsoleUrl` mapping; `buildNtfyRequest` header/body shape +
  priority-by-severity; the chokepoint fans out to a transport for surviving
  notices and **suppresses muted ones**; `initNtfyTransport` inert-without-env /
  active-with-env drives exactly one POST. `npm run smoke:ntfy`.

### Per-workflow gate (Remote Management opt-in)

The ntfy transport takes an injected `isRemoteEnabled(workflowId)` predicate
(wired from `index.ts` against the live `workflows` map). A notice carrying a
`workflowId` pushes to the phone **only when that workflow is opted in to remote**
(`WorkflowConfig.remoteEnabled`, which is disabled by default).
Instance-level notices (no `workflowId`: `quota-recovered`, server events) are
unaffected and always push. The gate lives in the transport closure, *after* the
in-app category-mute chokepoint, so a muted category is still suppressed first. Smoke:
`npm run smoke:remote-optin`.

### Configure a private ntfy server

The ntfy server must be reachable only through a private network. Configure
`ARCO_NTFY_URL` with the server URL and topic. Keep the topic and any access
token out of tracked files and logs. Set `ARCO_NTFY_TOKEN` when the server
requires bearer authentication. `ARCO_CONSOLE_URL` can provide an explicit
console link; otherwise the link is derived from `ARCO_HUB_URL`.

The optional upstream wakeup service can carry an opaque notification ID, while
notice content remains on the configured private server. Category mutes and the
per-workflow remote-access setting are applied before the transport sends a
notice.

### ntfy client setup

Configure the ntfy client to use the private server URL and subscribe to the
configured topic. The tap link opens the management console when a console URL
is available. Do not put the topic URL or access token in public documentation,
source control, or screenshots.
