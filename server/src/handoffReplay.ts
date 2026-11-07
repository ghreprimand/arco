interface HandoffReplayEvent {
  type?: string;
  handoffId?: string;
  error?: unknown;
  cancelled?: boolean;
  seq?: number;
}

// The latest ready outcome wins: a fallback may recover an earlier failure,
// while cancellation during pre-warm may revoke an already prepared artifact.
export function revokedHandoffIds(events: readonly HandoffReplayEvent[], maxSeq?: number): Set<string> {
  const latest = new Map<string, boolean>();
  for (const event of events) {
    if (typeof maxSeq === 'number' && typeof event.seq === 'number' && event.seq > maxSeq) break;
    if (event.type === 'handoff_artifact_ready' && event.handoffId) {
      latest.set(event.handoffId, Boolean(event.error || event.cancelled));
    }
  }
  return new Set([...latest].filter(([, revoked]) => revoked).map(([id]) => id));
}
