// Smart AUTO-PICKUP thread context: the last few peer messages each member
// sent to each other member, so the evaluator can tell whether waiting mail
// answers something the recipient asked for. Memory only and bounded: a
// clipped body per message, a few messages per sender/recipient pair. Nothing
// is written to disk; after a restart the context returns as members send
// again. Recorded by clusterMailbox.enqueue for every accepted peer message.

export const THREAD_BODY_MAX = 600;
const PER_PAIR = 3;
const MAX_PAIRS = 2000;

export interface SentMessage { body: string; createdAt: string }

const sent = new Map<string, SentMessage[]>();
const pairKey = (from: string, to: string) => `${from}>${to}`;

export function noteSentPeerMessage(from: string, to: string, body: string, createdAt: string): void {
  const k = pairKey(from, to);
  const list = sent.get(k) ?? [];
  list.push({ body: body.length > THREAD_BODY_MAX ? body.slice(0, THREAD_BODY_MAX) : body, createdAt });
  while (list.length > PER_PAIR) list.shift();
  // Re-insert so Map order is least recently used first.
  sent.delete(k);
  sent.set(k, list);
  while (sent.size > MAX_PAIRS) sent.delete(sent.keys().next().value as string);
}

// Most recent first.
export function recentSentTo(from: string, to: string): SentMessage[] {
  return [...(sent.get(pairKey(from, to)) ?? [])].reverse();
}

export function resetSmartPickupThreadsForTest(): void {
  sent.clear();
}
