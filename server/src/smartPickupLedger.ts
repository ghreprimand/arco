// Durable Smart AUTO-PICKUP budgets for one cluster: evaluator-call and
// automatic-wake reservations, plus a short decision log. Stored beside the
// cluster meta as auto-pickup-ledger.json so limits survive a restart.
//
// A reservation is taken before an evaluator request or a wake and always
// counts toward the limits, whatever happens next. Settling only ends its
// in-flight state. Reservations still open when the server stops become
// "uncertain" on recovery: they keep counting and are never refunded.
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SmartPickupCounters, SmartPickupDecisionRecord, SmartPickupLimits } from '@arco/shared';
import { atomicWriteFile } from './atomicFile.js';
import { clusterDir } from './clusterStore.js';

export type SmartPickupReservationKind = 'evaluator' | 'wake';

interface LedgerEntry {
  id: string;
  kind: SmartPickupReservationKind;
  memberId: string;
  sessionId: string;
  at: number;
  status: 'reserved' | 'settled' | 'uncertain';
  outcome?: string;
}

interface LedgerFile {
  version: 1;
  entries: LedgerEntry[];
  decisions: SmartPickupDecisionRecord[];
  // STOP holds: the pending mail ids a member had when the operator pressed
  // STOP. Automatic pickup leaves that mail alone until new mail arrives or
  // the mailbox empties.
  holds?: Record<string, { ids: string[]; at: number }>;
}

const HOUR_MS = 60 * 60 * 1000;
// Entries older than this cannot affect any limit (hour windows and sessions
// of at most 8 hours), so they are dropped on the next write.
const RETAIN_MS = 9 * HOUR_MS;
const DECISIONS_KEPT = 50;

export class SmartPickupLedgerUnreadable extends Error {}

export function ledgerPath(clusterId: string): string {
  return join(clusterDir(clusterId), 'auto-pickup-ledger.json');
}

const chains = new Map<string, Promise<unknown>>();

// One read-modify-write at a time per cluster.
function serialize<T>(clusterId: string, fn: () => Promise<T>): Promise<T> {
  const prior = chains.get(clusterId) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  chains.set(clusterId, next.catch(() => undefined));
  return next;
}

async function read(clusterId: string): Promise<LedgerFile> {
  let text: string;
  try {
    text = await fs.readFile(ledgerPath(clusterId), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entries: [], decisions: [] };
    throw new SmartPickupLedgerUnreadable(String(err));
  }
  try {
    const parsed = JSON.parse(text) as Partial<LedgerFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries) || !Array.isArray(parsed.decisions)) throw new Error('shape');
    return { version: 1, entries: parsed.entries, decisions: parsed.decisions, ...(parsed.holds && typeof parsed.holds === 'object' ? { holds: parsed.holds } : {}) };
  } catch (err) {
    throw new SmartPickupLedgerUnreadable(String(err));
  }
}

async function write(clusterId: string, ledger: LedgerFile, now: number): Promise<void> {
  ledger.entries = ledger.entries.filter((e) => e.status === 'reserved' || now - e.at < RETAIN_MS);
  ledger.decisions = ledger.decisions.slice(-DECISIONS_KEPT);
  await fs.mkdir(clusterDir(clusterId), { recursive: true });
  await atomicWriteFile(ledgerPath(clusterId), JSON.stringify(ledger, null, 2));
}

function count(entries: LedgerEntry[], kind: SmartPickupReservationKind, pred: (e: LedgerEntry) => boolean): number {
  return entries.filter((e) => e.kind === kind && pred(e)).length;
}

function tally(ledger: LedgerFile, sessionId: string | undefined, now: number): SmartPickupCounters {
  const hour = (e: LedgerEntry) => now - e.at < HOUR_MS;
  const session = (e: LedgerEntry) => sessionId !== undefined && e.sessionId === sessionId;
  return {
    inFlight: count(ledger.entries, 'evaluator', (e) => e.status === 'reserved'),
    callsLastHour: count(ledger.entries, 'evaluator', hour),
    callsThisSession: count(ledger.entries, 'evaluator', session),
    wakesLastHour: count(ledger.entries, 'wake', hour),
    wakesThisSession: count(ledger.entries, 'wake', session),
  };
}

export type ReserveResult = { ok: true; id: string } | { ok: false; reason: string };

// Pure limit check, exported for tests and the dispatcher.
export function limitReason(
  entries: readonly LedgerEntry[] | LedgerEntry[],
  kind: SmartPickupReservationKind,
  memberId: string,
  sessionId: string,
  limits: SmartPickupLimits,
  now: number,
): string | null {
  const list = entries as LedgerEntry[];
  const hour = (e: LedgerEntry) => now - e.at < HOUR_MS;
  if (kind === 'evaluator') {
    if (count(list, 'evaluator', (e) => e.status === 'reserved') >= limits.maxInFlight) return 'limit_in_flight';
    if (count(list, 'evaluator', hour) >= limits.callsPerClusterHour) return 'limit_calls_cluster_hour';
    if (count(list, 'evaluator', (e) => hour(e) && e.memberId === memberId) >= limits.callsPerMemberHour) return 'limit_calls_member_hour';
    return null;
  }
  if (count(list, 'wake', (e) => hour(e) && e.memberId === memberId) >= limits.wakesPerMemberHour) return 'limit_wakes_member_hour';
  if (count(list, 'wake', (e) => e.sessionId === sessionId) >= limits.wakesPerSession) return 'limit_wakes_session';
  return null;
}

export function reserveSmartPickup(clusterId: string, opts: {
  kind: SmartPickupReservationKind;
  memberId: string;
  sessionId: string;
  limits: SmartPickupLimits;
  now?: number;
}): Promise<ReserveResult> {
  return serialize(clusterId, async () => {
    const now = opts.now ?? Date.now();
    const ledger = await read(clusterId);
    const reason = limitReason(ledger.entries, opts.kind, opts.memberId, opts.sessionId, opts.limits, now);
    if (reason) return { ok: false, reason } as const;
    const id = randomUUID();
    ledger.entries.push({ id, kind: opts.kind, memberId: opts.memberId, sessionId: opts.sessionId, at: now, status: 'reserved' });
    await write(clusterId, ledger, now);
    return { ok: true, id } as const;
  });
}

export function settleSmartPickup(clusterId: string, id: string, outcome: string, now = Date.now()): Promise<void> {
  return serialize(clusterId, async () => {
    const ledger = await read(clusterId);
    const entry = ledger.entries.find((e) => e.id === id);
    if (!entry || entry.status !== 'reserved') return;
    entry.status = 'settled';
    entry.outcome = outcome.slice(0, 64);
    await write(clusterId, ledger, now);
  });
}

export function recordSmartPickupDecision(clusterId: string, record: SmartPickupDecisionRecord): Promise<void> {
  return serialize(clusterId, async () => {
    const ledger = await read(clusterId);
    ledger.decisions.push({ ...record, reason: record.reason.slice(0, 64), outcome: record.outcome.slice(0, 64) });
    await write(clusterId, ledger, record.at);
  });
}

// After a restart nothing is in flight; open reservations become uncertain
// and keep counting. Throws SmartPickupLedgerUnreadable when the file exists
// but cannot be read, so the caller can disarm instead of resetting budgets.
export function recoverSmartPickupLedger(clusterId: string, now = Date.now()): Promise<number> {
  return serialize(clusterId, async () => {
    const ledger = await read(clusterId);
    let changed = 0;
    for (const e of ledger.entries) {
      if (e.status === 'reserved') { e.status = 'uncertain'; e.outcome = 'restart'; changed++; }
    }
    if (changed > 0) await write(clusterId, ledger, now);
    return changed;
  });
}

export async function smartPickupSnapshot(clusterId: string, sessionId: string | undefined, now = Date.now()): Promise<{
  counters: SmartPickupCounters;
  lastDecision?: SmartPickupDecisionRecord;
  decisions: SmartPickupDecisionRecord[];
}> {
  const ledger = await read(clusterId);
  const lastDecision = ledger.decisions.at(-1);
  return { counters: tally(ledger, sessionId, now), ...(lastDecision ? { lastDecision } : {}), decisions: ledger.decisions.slice() };
}

export function setSmartPickupHold(clusterId: string, memberId: string, ids: string[], now = Date.now()): Promise<void> {
  return serialize(clusterId, async () => {
    const ledger = await read(clusterId);
    ledger.holds = { ...(ledger.holds ?? {}), [memberId]: { ids: [...ids].sort(), at: now } };
    await write(clusterId, ledger, now);
  });
}

// True while the member's pending mail is exactly mail it already had at
// STOP. New mail, or an empty mailbox, ends the hold (and clears it).
export function smartPickupHoldActive(clusterId: string, memberId: string, pendingIds: readonly string[], now = Date.now()): Promise<boolean> {
  return serialize(clusterId, async () => {
    const ledger = await read(clusterId);
    const hold = ledger.holds?.[memberId];
    if (!hold) return false;
    const held = new Set(hold.ids);
    if (pendingIds.length > 0 && pendingIds.every((id) => held.has(id))) return true;
    delete ledger.holds![memberId];
    await write(clusterId, ledger, now);
    return false;
  });
}
