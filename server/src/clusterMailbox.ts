import { publishActivity } from './voice/activityBus.js';
// CLUSTER_MODE_PLAN.md Phase 1 — file-per-message mailbox.
//
// Layout: ~/.archon/clusters/<clusterId>/mailbox/<recipientWorkflowId>/<msgId>.json
// One file per message. The mailbox is the single source of truth — peer
// tools / pre-turn injection are stateless wrappers over this directory.
//
// drain() destructively removes message files after returning their
// contents. The peer_message_received events emitted by the seedWorker
// drain helper are the durable record (events.jsonl); the mailbox files
// only need to live long enough to bridge "sender wrote" → "recipient
// pulled". GOTCHAS § Cluster mode invariant: mailbox is per-recipient,
// not per-cluster — don't index it the wrong way.

import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { clusterMailboxRoot, getClusterIdForWorkflow, getMemberAccessMode, isolatedWorkspaceFor, readCluster } from './clusterStore.js';
import { atomicWriteFile, withFileLock } from './atomicFile.js';

export interface PeerArtifact {
  name: string;
  contentBase64: string;
  byteLength: number;
}

export interface PeerMessage {
  msgId: string;
  fromWorkflowId: string;
  fromDisplayName: string;
  toWorkflowId: string;
  content: string;
  createdAt: string; // ISO
  delivered: boolean;
  deliveredAt?: string;
  artifacts?: PeerArtifact[];
}

// 2026-05-11 — bumped 8KB → 16KB after operator feedback: 8KB was too tight
// for directors authoring multi-paragraph task assignments + context. The
// operator-driven path (TRANSCRIPT etc.) still caps at 32KB; this is the
// model-driven default. If 16KB starts feeling tight, chunking via multiple
// peer_sends is the right answer rather than another bump — the recipient's
// context fills up faster than the sender's.
// Exported so the smokes assert against the REAL cap. They previously hard-coded
// 8 KB and silently went stale when this was bumped on 2026-05-11.
export const MAX_CONTENT_BYTES = 16 * 1024;
const MAX_PENDING_PER_RECIPIENT = 50;
export const MAX_ARTIFACT_BYTES = 256 * 1024;

export class MailboxError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function recipientDir(clusterId: string, wfId: string): string {
  return join(clusterMailboxRoot(clusterId), wfId);
}

// Conversation purge — remove this workflow's mailbox directory (undelivered
// peer messages addressed to it). Best-effort; no-op when the workflow isn't a
// cluster member or has no mailbox. Sender-side files live under each
// recipient's dir, so a purged sender leaves nothing here to chase.
export async function purgeMailboxForWorkflow(wfId: string): Promise<void> {
  const clusterId = getClusterIdForWorkflow(wfId);
  if (!clusterId) return;
  await fs.rm(recipientDir(clusterId, wfId), { recursive: true, force: true }).catch(() => {});
}

function messagePath(clusterId: string, wfId: string, msgId: string): string {
  return join(recipientDir(clusterId, wfId), `${msgId}.json`);
}

export function mintMsgId(): string {
  // Millisecond + uuid suffix — ms prefix gives a natural sort that
  // matches createdAt order without needing a stat() call to recover it.
  return `${Date.now()}-${randomUUID().slice(0, 8)}`;
}

export async function enqueue(toWfId: string, msg: PeerMessage, opts?: { maxContentBytes?: number }): Promise<void> {
  const clusterId = getClusterIdForWorkflow(toWfId);
  if (!clusterId) {
    throw new MailboxError('recipient_not_in_cluster', `workflow ${toWfId} is not a cluster member`);
  }
  // Operator-driven transcript-send raises the cap above the 16 KB default. The cap
  // still exists — the recipient gets the message injected pre-turn so an
  // unbounded body would balloon the next turn's context. 32 KB matches the
  // cluster-plan body cap and is the largest value the operator UI exposes.
  const cap = opts?.maxContentBytes ?? MAX_CONTENT_BYTES;
  if (Buffer.byteLength(msg.content, 'utf8') > cap) {
    throw new MailboxError('content_too_large', `peer message exceeds ${cap} bytes`);
  }
  const artifactBytes = (msg.artifacts ?? []).reduce((sum, artifact) => sum + artifact.byteLength, 0);
  if ((msg.artifacts?.length ?? 0) > 8 || artifactBytes > MAX_ARTIFACT_BYTES) {
    throw new MailboxError('content_too_large', `peer artifacts exceed ${MAX_ARTIFACT_BYTES} bytes or 8 files`);
  }
  await withFileLock(clusterMailboxRoot(clusterId), async () => {
    // Replacement may have won the mailbox lock after the initial lookup.
    // Revalidate here so an in-flight send cannot recreate the old directory.
    if (getClusterIdForWorkflow(toWfId) !== clusterId) {
      throw new MailboxError('recipient_not_in_cluster', `workflow ${toWfId} is not a cluster member`);
    }
    const dir = recipientDir(clusterId, toWfId);
    await fs.mkdir(dir, { recursive: true });
    // Mailbox cap (plan §4): drop oldest if over the limit. Filename prefix
    // is the millisecond timestamp from mintMsgId() so a lexicographic sort
    // recovers chronological order.
    const entries = (await fs.readdir(dir)).filter((n) => n.endsWith('.json')).sort();
    while (entries.length >= MAX_PENDING_PER_RECIPIENT) {
      const dropped = entries.shift();
      if (!dropped) break;
      await fs.unlink(join(dir, dropped)).catch(() => undefined);
    }
    // ATOMIC, and load-bearing: `drain` runs concurrently with `peer_send` (two
    // members, same process, independent async tool calls). A plain writeFile
    // lets drain read a half-written file; `readMessageFile` collapses the parse
    // error to null, and drain treats null as "stale" and UNLINKS it — silently
    // destroying an undelivered peer message with no `peer_message_received`
    // ever written. Same silent-cross-member-loss class as DD3, different
    // substrate. Every reader filters `.endsWith('.json')`, so the `.tmp` is
    // invisible during the write window.
    await atomicWriteFile(messagePath(clusterId, toWfId, msg.msgId), JSON.stringify(msg, null, 2));
    publishActivity({ kind: 'mail_arrived', clusterId, workflowId: toWfId });
  });
}

export async function materializeArtifacts(
  wfId: string,
  msg: PeerMessage,
): Promise<Array<{ name: string; path: string; byteLength: number }>> {
  if (!msg.artifacts?.length) return [];
  const clusterId = getClusterIdForWorkflow(wfId);
  if (!clusterId) return [];
  const state = await readCluster(clusterId);
  if (!state) return [];
  const root = getMemberAccessMode(clusterId, wfId) === 'isolated'
    ? join(isolatedWorkspaceFor(clusterId, wfId), '.peer-artifacts', msg.msgId)
    : join(state.cwd, '.archon', 'peer-artifacts', msg.msgId);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const out: Array<{ name: string; path: string; byteLength: number }> = [];
  for (let i = 0; i < msg.artifacts.length; i++) {
    const artifact = msg.artifacts[i];
    const safeName = basename(artifact.name).replace(/[^a-zA-Z0-9._-]/g, '_') || `artifact-${i + 1}`;
    const path = join(root, safeName);
    const data = Buffer.from(artifact.contentBase64, 'base64');
    await fs.writeFile(path, data, { mode: 0o600 });
    out.push({ name: safeName, path, byteLength: data.byteLength });
  }
  return out;
}

async function readDirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function readMessageFile(path: string): Promise<PeerMessage | null> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw) as PeerMessage;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    return null;
  }
}

// Caller holds clusterMailboxRoot's lock through the eventual busy claim.
// A corrupt/unreadable mailbox must never satisfy a conditional empty check.
export async function pendingIdsStrict(clusterId: string, wfId: string): Promise<string[]> {
  if (getClusterIdForWorkflow(wfId) !== clusterId) throw Error('Cluster membership changed.');
  const dir = recipientDir(clusterId, wfId);
  const ids: string[] = [];
  for (const name of (await readDirSafe(dir)).filter((n) => n.endsWith('.json'))) {
    const msg = JSON.parse(await fs.readFile(join(dir, name), 'utf8')) as PeerMessage;
    if (typeof msg.msgId !== 'string' || msg.toWorkflowId !== wfId || typeof msg.delivered !== 'boolean') throw Error('Invalid mailbox record.');
    if (!msg.delivered) ids.push(msg.msgId);
  }
  return ids.sort();
}

export async function peek(wfId: string): Promise<PeerMessage[]> {
  const clusterId = getClusterIdForWorkflow(wfId);
  if (!clusterId) return [];
  const dir = recipientDir(clusterId, wfId);
  const names = (await readDirSafe(dir)).filter((n) => n.endsWith('.json')).sort();
  const out: PeerMessage[] = [];
  for (const name of names) {
    const msg = await readMessageFile(join(dir, name));
    if (msg && !msg.delivered) out.push(msg);
  }
  return out;
}

// Read all undelivered messages addressed to wfId, mark them delivered, and
// remove the message files (the peer_message_received events in events.jsonl
// are the durable record — keeping mailbox files post-drain serves no purpose
// in Phase 1). Caller must emit the events BEFORE the operator's
// user_message_echo to satisfy the acceptance ordering.
export async function drain(wfId: string): Promise<PeerMessage[]> {
  const clusterId = getClusterIdForWorkflow(wfId);
  if (!clusterId) return [];
  return withFileLock(clusterMailboxRoot(clusterId), async () => {
    if (getClusterIdForWorkflow(wfId) !== clusterId) return [];
    const dir = recipientDir(clusterId, wfId);
    const names = (await readDirSafe(dir)).filter((n) => n.endsWith('.json')).sort();
    const out: PeerMessage[] = [];
    for (const name of names) {
      const path = join(dir, name);
      const msg = await readMessageFile(path);
      if (!msg || msg.delivered) {
        // Stale or already-delivered file — clean up and skip.
        await fs.unlink(path).catch(() => undefined);
        continue;
      }
      msg.delivered = true;
      msg.deliveredAt = new Date().toISOString();
      out.push(msg);
      await fs.unlink(path).catch(() => undefined);
    }
    if (out.length) publishActivity({ kind: 'mail_read', clusterId, workflowId: wfId });
    return out;
  });
}

// Discard a single pending message without delivering it. Operator-only
// cancel path: the mailbox modal exposes a CANCEL button per pending message
// so the recipient never sees it. No event is emitted — the message was
// never delivered, so events.jsonl has nothing to record; cluster_state
// refresh after the unlink is sufficient to drop the depth indicator.
// Returns true if the file existed and was removed, false otherwise.
export async function discard(toWfId: string, msgId: string): Promise<boolean> {
  const clusterId = getClusterIdForWorkflow(toWfId);
  if (!clusterId) return false;
  return withFileLock(clusterMailboxRoot(clusterId), async () => {
    if (getClusterIdForWorkflow(toWfId) !== clusterId) return false;
    const path = messagePath(clusterId, toWfId, msgId);
    try {
      await fs.unlink(path);
      publishActivity({ kind: 'mail_discarded', clusterId, workflowId: toWfId });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  });
}

// Mark a single message delivered without removing the file. Provided per
// plan §6.1a's enumerated API; not used by the Phase 1 drain path (drain
// removes the file outright). Future phases may keep an audit trail and
// flip individual messages by id.
export async function markDelivered(toWfId: string, msgId: string): Promise<boolean> {
  const clusterId = getClusterIdForWorkflow(toWfId);
  if (!clusterId) return false;
  return withFileLock(clusterMailboxRoot(clusterId), async () => {
    if (getClusterIdForWorkflow(toWfId) !== clusterId) return false;
    const path = messagePath(clusterId, toWfId, msgId);
    const msg = await readMessageFile(path);
    if (!msg) return false;
    msg.delivered = true;
    msg.deliveredAt = new Date().toISOString();
    // Atomic for the same reason as the send path — this rewrite races drain.
    await atomicWriteFile(path, JSON.stringify(msg, null, 2));
    publishActivity({ kind: 'mail_read', clusterId, workflowId: toWfId });
    return true;
  });
}

export async function depthFor(wfId: string): Promise<number> {
  return (await peek(wfId)).length;
}
