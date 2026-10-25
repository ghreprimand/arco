// ARCO_OPS_PLAN.md Part J (J1) — the in-app workbench notification hub.
//
// One place to mint + broadcast WorkbenchNotice events so every source
// (turn-finished, quota-recovered, …) is a single `emit()` call and the
// J2 external transports can hang off the same chokepoint later. Mute is
// applied HERE (server-side) so a muted category is suppressed for in-app
// toasts AND future external transports alike, and the suppression survives a
// restart (persisted to ~/.arco/notification-mutes.json).
//
// Inform-only: nothing in this module reads client input as a command — the
// only client message it services is `set_notification_mutes` (a preference).

import { homedir } from 'os';
import { join } from 'path';
import { readFile } from 'fs/promises';
import type {
  ServerMessage,
  WorkbenchNotice,
  WorkbenchNoticeCategory,
  NotificationMutesMessage,
  ProviderName,
} from '@arco/shared';
import { WORKBENCH_NOTICE_CATEGORIES } from '@arco/shared';
import { atomicWriteFile } from './atomicFile.js';
import { arcoHome } from './arcoHome.js';

// A primary turn shorter than this isn't worth a "turn finished" notice — the
// operator was almost certainly watching. Only long-running turns (where they
// likely tabbed away) surface one.
const LONG_TURN_MS = 60_000;

// Overridable so the smoke can point persistence at a temp dir instead of the
// real ~/.arco. Defaults to the per-user arco home.
let mutesPath = join(arcoHome(), 'notification-mutes.json');
export function _setMutesPathForTest(p: string): void { mutesPath = p; }

let broadcast: ((msg: ServerMessage) => void) | null = null;
// J2 external transports (ntfy / email / …). A transport is a fire-and-forget
// sink called with every notice that SURVIVES the mute check — so muting an
// in-app category suppresses the push for free, the load-bearing promise of the
// single chokepoint. Transport errors never touch the in-app path.
type NoticeTransport = (n: WorkbenchNotice) => void | Promise<void>;
const transports: NoticeTransport[] = [];
export function registerNoticeTransport(t: NoticeTransport): void {
  transports.push(t);
}
/** Test-only: drop all registered transports so a smoke starts clean. */
export function _resetTransportsForTest(): void { transports.length = 0; }
const mutedCategories = new Set<WorkbenchNoticeCategory>();
const turnStarts = new Map<string, number>();
let idCounter = 0;

function isCategory(c: string): c is WorkbenchNoticeCategory {
  return (WORKBENCH_NOTICE_CATEGORIES as readonly string[]).includes(c);
}

/** Inject the global all-clients sender + load persisted mutes. Call once at boot. */
export async function initNotifications(broadcastFn: (msg: ServerMessage) => void): Promise<void> {
  broadcast = broadcastFn;
  try {
    const raw = await readFile(mutesPath, 'utf-8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      mutedCategories.clear();
      for (const c of arr) if (typeof c === 'string' && isCategory(c)) mutedCategories.add(c);
    }
  } catch { /* no file yet → nothing muted */ }
}

async function persistMutes(): Promise<void> {
  try {
    // Advisory: the in-memory set is authoritative for this session. Atomic
    // anyway so a torn write can't silently un-mute every category on the
    // next boot (readMutes swallows a parse error as "nothing muted").
    await atomicWriteFile(mutesPath, JSON.stringify([...mutedCategories]), { durability: 'advisory' });
  } catch { /* best-effort — mute still applies in-memory this session */ }
}

export function getMutes(): WorkbenchNoticeCategory[] {
  return [...mutedCategories];
}

export function mutesMessage(): NotificationMutesMessage {
  return { type: 'notification_mutes', muted: [...mutedCategories] };
}

/** Service a `set_notification_mutes` client message: replace + persist + re-broadcast. */
export function setMutes(muted: WorkbenchNoticeCategory[]): void {
  mutedCategories.clear();
  for (const c of muted) if (isCategory(c)) mutedCategories.add(c);
  void persistMutes();
  broadcast?.(mutesMessage());
}

/**
 * Mint + broadcast a notice. Returns the built notice, or null if the category
 * is muted (suppressed before it reaches any client). The id + ts are filled in
 * here so callers pass only the semantic fields.
 */
export function emit(
  n: Omit<WorkbenchNotice, 'id' | 'ts'> & { ts?: number },
): WorkbenchNotice | null {
  if (mutedCategories.has(n.category)) return null;
  const notice: WorkbenchNotice = {
    ...n,
    id: `wn_${Date.now().toString(36)}_${(idCounter++).toString(36)}`,
    ts: n.ts ?? Date.now(),
  };
  broadcast?.({ type: 'workbench_notice', notice });
  // Fan out to external transports AFTER the in-app broadcast and only for
  // non-muted notices (muted ones returned above). Fire-and-forget: a slow or
  // failing transport must never delay or break the in-app surface.
  for (const t of transports) {
    try {
      const r = t(notice);
      if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => {});
    } catch { /* transport threw synchronously — ignore */ }
  }
  return notice;
}

// ── Source helpers ─────────────────────────────────────────────────────────
// Thin wrappers so callsites stay a one-liner and the category/severity/copy
// conventions live in one place.

/** Long-turn detection. Pair onTurnStarted / onTurnEnded around a primary turn. */
export function onTurnStarted(workflowId: string): void {
  turnStarts.set(workflowId, Date.now());
}

export function onTurnEnded(workflowId: string, opts?: { provider?: ProviderName; workflowName?: string }): void {
  const start = turnStarts.get(workflowId);
  turnStarts.delete(workflowId);
  if (start === undefined) return;
  const elapsed = Date.now() - start;
  if (elapsed < LONG_TURN_MS) return;
  const secs = Math.round(elapsed / 1000);
  const mins = Math.floor(secs / 60);
  const dur = mins >= 1 ? `${mins}m ${secs % 60}s` : `${secs}s`;
  emit({
    category: 'turn-finished',
    severity: 'success',
    title: `Turn finished — ${opts?.workflowName ?? workflowId.slice(0, 8)}`,
    body: `Ran ${dur}.`,
    workflowId,
    provider: opts?.provider,
  });
}

/** A throttled provider became available again. */
export function notifyQuotaRecovered(provider: ProviderName): void {
  emit({
    category: 'quota-recovered',
    severity: 'success',
    title: `${provider} quota recovered`,
    body: 'The provider is available again.',
    provider,
  });
}
