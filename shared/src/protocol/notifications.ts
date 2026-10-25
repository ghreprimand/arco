// ARCO_OPS_PLAN.md Part J — Workbench Notifications.
//
// A single in-app event contract so the J1 toast/notice-center surface and the
// (future) J2 external transports (email / ntfy / Pushover / desktop push)
// share one shape. The notification system is **inform-only** — it never
// accepts commands (the trust boundary: notices tell you something happened;
// the Part K tailnet console is where authenticated action lives).
//
// Scope: WORKBENCH events only (turn finished, quota recovered, auth expired,
// terminal exit, preview check, PR/check status, backup) — NOT a general
// reminder system.

import type { ProviderName } from './providers.js';

// The seven workbench event categories from the plan. Mute is per-category.
export type WorkbenchNoticeCategory =
  | 'computer-watch'  // explicitly armed Computer completion watch
  | 'turn-finished'    // a long primary turn completed
  | 'quota-recovered'  // a throttled provider became available again
  | 'auth-expired'     // a provider's auth needs re-login
  | 'cluster-nudge'    // R6 — a remote-shared cluster member idle with pending peer mail
  | 'terminal-exited'  // a terminal command exited (esp. non-zero)
  | 'preview-failed'   // a preview health check failed
  | 'pr-status'        // a PR / CI check status changed
  | 'backup';          // a backup completed or failed

export const WORKBENCH_NOTICE_CATEGORIES: readonly WorkbenchNoticeCategory[] = [
  'computer-watch',
  'turn-finished',
  'quota-recovered',
  'auth-expired',
  'cluster-nudge',
  'terminal-exited',
  'preview-failed',
  'pr-status',
  'backup',
] as const;

export type WorkbenchNoticeSeverity = 'info' | 'success' | 'warning' | 'error';

export interface WorkbenchNotice {
  id: string;
  category: WorkbenchNoticeCategory;
  severity: WorkbenchNoticeSeverity;
  title: string;
  // Optional second line — kept short; transports render title-first.
  body?: string;
  ts: number;
  // Optional scope hints (omitted for machine-global events like a backup).
  workflowId?: string;
  provider?: ProviderName;
}

// Server → clients: a fresh workbench notice. Broadcast to every connected
// client (not workflow-scoped — several categories are machine-global). The
// server suppresses muted categories before broadcasting, so a notice that
// arrives is always one the operator wants to see.
export interface WorkbenchNoticeMessage {
  type: 'workbench_notice';
  notice: WorkbenchNotice;
}

// Server → clients: the current set of muted categories. Sent on connect and
// whenever the mute set changes, so every client's notice-center stays in sync.
export interface NotificationMutesMessage {
  type: 'notification_mutes';
  muted: WorkbenchNoticeCategory[];
}

// Client → server: replace the muted-category set. Persisted server-side so the
// suppression also covers J2 external transports and survives a restart.
export interface SetNotificationMutesMessage {
  type: 'set_notification_mutes';
  muted: WorkbenchNoticeCategory[];
}
