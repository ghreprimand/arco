// docs/ARCHITECTURE.md (J2) - ntfy external notification transport.
//
// Mirrors the management/hubLink gating model: INERT unless ARCO_NTFY_URL is
// set, so an ordinary `npm run dev` is unchanged. When configured, it registers
// a fire-and-forget sink at the J1 notice chokepoint (server/src/notifications.ts
// `registerNoticeTransport`) that POSTs each surviving notice to an ntfy topic.
//
// Trust boundary (docs/REMOTE_MANAGEMENT.md §1, docs/NOTIFICATIONS.md): this is
// a PROMPT, not a command channel — ntfy carries title/body/priority + a Click
// link to the tailnet console; nothing inbound is ever read. Self-hosted on the
// hub-host hub box (with `upstream-base-url` for push wakeups) keeps notice
// CONTENT on the tailnet — only an opaque wakeup id transits ntfy.sh's relay.
//
// Mute is enforced upstream (a muted category never reaches a transport), so
// there is no mute logic here.

import { registerNoticeTransport } from './notifications.js';
import type { WorkbenchNotice, WorkbenchNoticeSeverity } from '@arco/shared';

export interface NtfyConfig {
  // Full ntfy topic URL to POST to, e.g. http://hub-host.tailnet:3501/arco-<topic>.
  topicUrl: string;
  // Optional bearer token (ntfy access token) for a protected topic.
  token?: string;
  // The K2 console URL used as the notification's tap target. Derived from
  // ARCO_HUB_URL when not given explicitly.
  consoleUrl?: string;
  // Workstation label (e.g. "workstation") prefixed onto the body so a glance tells
  // you WHICH machine. Falls back to the OS hostname at init.
  instanceLabel?: string;
}

// ntfy maps Priority to push behavior. We stay conservative: errors/warnings
// ride 'high' (sound + heads-up), routine success/info ride 'default'/'low'.
// 'urgent' (max) is deliberately unused — it can bypass Do-Not-Disturb.
function priorityFor(sev: WorkbenchNoticeSeverity): string {
  switch (sev) {
    case 'error': return 'high';
    case 'warning': return 'high';
    case 'success': return 'default';
    default: return 'low';
  }
}

function tagFor(sev: WorkbenchNoticeSeverity): string {
  switch (sev) {
    case 'error': return 'rotating_light';
    case 'warning': return 'warning';
    case 'success': return 'white_check_mark';
    default: return 'information_source';
  }
}

// ntfy header values must be single-line and latin-1-safe (they're HTTP header
// values). Strip control chars / non-ASCII and cap length so a unicode title
// can't break the request. The body (POST payload, not a header) keeps unicode.
function headerSafe(s: string, max = 200): string {
  return s
    .replace(/[‒-―]/g, '-')      // figure/en/em dashes → hyphen
    .replace(/[‘’]/g, "'")        // smart single quotes
    .replace(/[“”]/g, '"')        // smart double quotes
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^\x20-\x7E]/g, '')           // strip any remaining non-ascii
    .replace(/\s+/g, ' ')                   // collapse runs left by stripped glyphs
    .trim()
    .slice(0, max);
}

// ws://host:port/agent → http://host:port/  (the console is the hub's HTTP root
// on the same port). wss → https. Path/query dropped.
export function deriveConsoleUrl(hubUrl: string | undefined): string | undefined {
  if (!hubUrl) return undefined;
  try {
    const u = new URL(hubUrl);
    const scheme = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol;
    return `${scheme}//${u.host}/`;
  } catch {
    return undefined;
  }
}

// Pure: build the HTTP request for a notice. Exported so the smoke can assert
// the shape without a network round-trip.
export function buildNtfyRequest(
  notice: WorkbenchNotice,
  cfg: NtfyConfig,
): { url: string; headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = {
    Title: headerSafe(notice.title),
    Priority: priorityFor(notice.severity),
    Tags: tagFor(notice.severity),
  };
  // R6 — deep-link the tap: workflow-scoped notices land on that workflow's
  // row; auth-expired lands on the AUTH banner. Fragment-only (the console JS
  // resolves it after first render), so an old console just opens Home.
  if (cfg.consoleUrl) {
    const frag = notice.category === 'auth-expired'
      ? '#auth'
      : notice.workflowId
        ? `#w=${encodeURIComponent(notice.workflowId)}`
        : '';
    headers.Click = `${cfg.consoleUrl}${frag}`;
  }
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  // Body: high-signal + compact. [workstation] line first so the machine is
  // unambiguous, then the notice body, then a workflow hint when scoped.
  const lines: string[] = [];
  if (cfg.instanceLabel) lines.push(`[${cfg.instanceLabel}]`);
  if (notice.body) lines.push(notice.body);
  if (notice.workflowId) lines.push(`workflow ${notice.workflowId.slice(0, 8)}`);
  return { url: cfg.topicUrl, headers, body: lines.join('\n') || notice.title };
}

let configured: NtfyConfig | null = null;
let fetchImpl: typeof fetch = fetch;

/** Read the live config (null when inert). Exposed for diagnostics/tests. */
export function getNtfyConfig(): NtfyConfig | null {
  return configured;
}

/**
 * Initialize the ntfy transport. INERT (no-op, returns false) unless
 * ARCO_NTFY_URL is set. Idempotent-ish: registers exactly one sink the first
 * time it activates. `opts` lets the smoke inject a fake fetch + env + label.
 */
export function initNtfyTransport(opts?: {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  instanceLabel?: string;
  // REMOTE_MANAGEMENT.md §1.4 — per-workflow opt-in gate. When provided, a notice
  // carrying a `workflowId` is pushed ONLY if the predicate returns true (the
  // workflow has `remoteEnabled` on). Notices with no workflowId (instance-level:
  // quota-recovered, server events) always push. Injected from index.ts so this
  // module stays decoupled from server state; the smoke passes a fake.
  isRemoteEnabled?: (workflowId: string) => boolean;
}): boolean {
  const env = opts?.env ?? process.env;
  const topicUrl = (env.ARCO_NTFY_URL || '').trim();
  if (!topicUrl) return false; // inert — ordinary dev run

  if (opts?.fetchImpl) fetchImpl = opts.fetchImpl;
  const isRemoteEnabled = opts?.isRemoteEnabled;
  configured = {
    topicUrl,
    token: (env.ARCO_NTFY_TOKEN || '').trim() || undefined,
    consoleUrl: (env.ARCO_CONSOLE_URL || '').trim() || deriveConsoleUrl(env.ARCO_HUB_URL),
    instanceLabel: opts?.instanceLabel,
  };

  registerNoticeTransport(async (notice) => {
    const cfg = configured;
    if (!cfg) return;
    // Per-workflow opt-in: a workflow-scoped notice pushes to the phone only when
    // that workflow is opted in to remote. Instance-level notices (no workflowId)
    // are unaffected.
    if (notice.workflowId && isRemoteEnabled && !isRemoteEnabled(notice.workflowId)) return;
    const { url, headers, body } = buildNtfyRequest(notice, cfg);
    try {
      await fetchImpl(url, { method: 'POST', headers, body });
    } catch (err) {
      // Best-effort: a push failure must not surface to the operator beyond a
      // log line (the in-app notice already fired).
      console.warn(`[ntfy] push failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  console.log(`[ntfy] transport active → ${topicUrl}${configured.consoleUrl ? ` (click → ${configured.consoleUrl})` : ''}`);
  return true;
}
