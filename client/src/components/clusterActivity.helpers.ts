// Pure helpers for the cluster ACTIVITY feed. Kept React-free so streaming
// edge cases can be regression-tested without mounting the full cluster UI.

export interface ClusterActivityItemLike {
  id: string;
  ts: number;
  kind: string;
  summary: string;
  memberId?: string;
}

// A coalesced row replaces as many as MAX_ACTIVITY_ENTRIES source chunks.
// Bound the derived display copy so a pathological reasoning stream cannot
// multiply the store's already-bounded memory footprint in the cluster view.
export const MAX_CLUSTER_THINKING_CHARS = 64 * 1024;

function appendThinkingSummary(current: string, chunk: string): string {
  if (current.length >= MAX_CLUSTER_THINKING_CHARS) {
    return current.endsWith('…')
      ? current
      : `${current.slice(0, MAX_CLUSTER_THINKING_CHARS - 1)}…`;
  }
  const combined = current + chunk;
  return combined.length <= MAX_CLUSTER_THINKING_CHARS
    ? combined
    : `${combined.slice(0, MAX_CLUSTER_THINKING_CHARS - 1)}…`;
}

// Cursor ACP emits agent_thought_chunk at provider-defined boundaries. Some
// models use sentence-sized chunks; others (notably Kimi K3) emit individual
// words or punctuation. The per-workflow Activity tab already joins adjacent
// thinking deltas. Apply the same rule after the cluster feed is globally
// time-sorted so another member/event/tool remains a real run boundary.
//
// Keep the first id so React updates one stable row while the run streams, and
// advance ts to the newest chunk so the displayed time reflects live progress.
export function coalesceThinkingRuns<T extends ClusterActivityItemLike>(
  items: readonly T[],
): T[] {
  const out: T[] = [];
  for (const item of items) {
    const prev = out[out.length - 1];
    if (
      prev?.kind === 'thinking'
      && item.kind === 'thinking'
      && !!prev.memberId
      && prev.memberId === item.memberId
    ) {
      out[out.length - 1] = {
        ...prev,
        summary: appendThinkingSummary(prev.summary, item.summary),
        ts: item.ts,
      };
      continue;
    }
    out.push(item);
  }

  // Preserve whitespace chunks while joining (they are often the separator
  // between word-sized deltas), then trim only the completed display run.
  return out.flatMap((item) => {
    if (item.kind !== 'thinking') return [item];
    const summary = item.summary.trim();
    return summary ? [{ ...item, summary }] : [];
  });
}
