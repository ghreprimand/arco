// docs/ARCHITECTURE.md - Workbench Notifications.
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
  | 'attention'       // failed or waiting attention notice
  | 'port-change'     // package startup moved to an available port
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
  'port-change',
  'computer-watch',
  'turn-finished',
  'attention',
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

// ---------------------------------------------------------------------------
// Attention alerts (desktop and phone). Separate from workbench notices: they
// are opt-in per event for desktop and phone, and never create an in-app toast.
// Quiet in-app notices follow the existing BELL category settings.

export const ATTENTION_KINDS = ['finished', 'failed', 'waiting'] as const;
export type AttentionKind = typeof ATTENTION_KINDS[number];

export type AttentionSwitches = Record<AttentionKind, boolean>;

export interface NtfyChannelConfig {
  // Server address, for example https://ntfy.sh or a self-hosted address.
  server: string;
  // Topic name; anyone who knows it can read the messages, so it is generated randomly.
  topic: string;
  // Optional access token for a protected topic. Never sent back to the browser.
  token?: string;
}

export interface NotificationChannels {
  desktop: AttentionSwitches;
  phone: AttentionSwitches;
  ntfy: NtfyChannelConfig;
  // Include message text (the question, error or reply start) in phone messages.
  phoneText: boolean;
  // In a cluster, which members raise "finished": only the director (default) or everyone.
  clusterFinished: 'director' | 'all';
}

// What the browser receives: the token is replaced by a flag.
export interface NotificationChannelsView extends Omit<NotificationChannels, 'ntfy'> {
  ntfy: { server: string; topic: string; tokenSet: boolean };
  // True when ARCO_NTFY_URL supplies the phone address because none is saved.
  ntfyFromEnvironment: boolean;
  // True when ARCO_NTFY_URL is set and no address is saved, but the Arco home is
  // inside the temporary folder, so the inherited address is not used
  // (server/src/management/hubGuard.ts). Absent from older servers.
  ntfyEnvironmentHeldBack?: boolean;
}

export const DEFAULT_NOTIFICATION_CHANNELS: NotificationChannels = {
  desktop: { finished: false, failed: false, waiting: false },
  phone: { finished: false, failed: false, waiting: false },
  ntfy: { server: 'https://ntfy.sh', topic: '' },
  phoneText: false,
  clusterFinished: 'director',
};

const NTFY_TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidNtfyTopic(topic: string): boolean {
  return NTFY_TOPIC_RE.test(topic);
}

export function normalizeNtfyServer(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch { return null; }
}

function switches(value: unknown): AttentionSwitches {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return { finished: v.finished === true, failed: v.failed === true, waiting: v.waiting === true };
}

// Tolerant: anything missing or malformed falls back to the off-by-default value.
export function sanitizeNotificationChannels(value: unknown, previousToken?: string): NotificationChannels {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const n = (v.ntfy && typeof v.ntfy === 'object' ? v.ntfy : {}) as Record<string, unknown>;
  const server = normalizeNtfyServer(n.server) ?? DEFAULT_NOTIFICATION_CHANNELS.ntfy.server;
  const topic = typeof n.topic === 'string' && isValidNtfyTopic(n.topic.trim()) ? n.topic.trim() : '';
  // token: a string sets it, '' or null clears it, absent keeps the previous one.
  let token: string | undefined = previousToken;
  if (typeof n.token === 'string') token = n.token.trim().slice(0, 256) || undefined;
  else if (n.token === null) token = undefined;
  return {
    desktop: switches(v.desktop),
    phone: switches(v.phone),
    ntfy: { server, topic, ...(token ? { token } : {}) },
    phoneText: v.phoneText === true,
    clusterFinished: v.clusterFinished === 'all' ? 'all' : 'director',
  };
}

// Server -> clients: something needs attention. Carries no message text.
export interface AttentionEventMessage {
  type: 'attention_event';
  id: string;
  kind: AttentionKind;
  workflowId: string;
  // The tab name, or the member and cluster name, captured at the event.
  workflowName: string;
  // Short turns and filtered cluster members can still produce in-app notices.
  desktopEligible?: boolean;
}
