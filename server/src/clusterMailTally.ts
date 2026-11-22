// Member mail tally for the Director's turn: how many peer_send messages each
// member delivered to each other member since the Director's previous turn.
// Feedback only; it never limits, warns or blocks. Process-local like the
// message guard counters, so a server restart starts the count again. See
// docs/PROTOCOL_CLUSTER.md "Director roles and work size".

export interface MailTallyPair { from: string; to: string; count: number }

const tallies = new Map<string, Map<string, MailTallyPair>>();

/** Count one delivered peer_send in a cluster. */
export function recordDelivery(clusterId: string, from: string, to: string): void {
  let pairs = tallies.get(clusterId);
  if (!pairs) { pairs = new Map(); tallies.set(clusterId, pairs); }
  const key = `${from}\n${to}`;
  const pair = pairs.get(key);
  if (pair) pair.count++;
  else pairs.set(key, { from, to, count: 1 });
}

/** Return the cluster's pairs, largest first, and start a new count. Called
 * when the Director's turn starts. The Director's own sends are left out:
 * it already knows them. */
export function takeTally(clusterId: string, directorId: string): MailTallyPair[] {
  const pairs = [...(tallies.get(clusterId)?.values() ?? [])];
  tallies.delete(clusterId);
  return pairs.filter((p) => p.from !== directorId).sort((a, b) => b.count - a.count);
}
