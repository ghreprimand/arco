import type { ServerMessage } from '@arco/shared';
import type { HistoryEventEntry } from '../stores/appStore';

export function trim80(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? oneLine.slice(0, 80) + '...' : oneLine;
}

function summarizeToolInput(tool: string, inputJson: string): string {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(inputJson);
  } catch {
    return '';
  }
  if (!rec || typeof rec !== 'object') return '';
  if (typeof rec.file_path === 'string') return rec.file_path;
  if (tool === 'Bash') {
    const desc = typeof rec.description === 'string' ? rec.description : '';
    const cmd = typeof rec.command === 'string' ? rec.command : '';
    return desc || trim80(cmd);
  }
  if (tool === 'Grep' || tool === 'Glob') {
    const pat = typeof rec.pattern === 'string' ? rec.pattern : '';
    const where = typeof rec.path === 'string' ? ` in ${rec.path}` : '';
    return pat ? `${pat}${where}` : '';
  }
  if (tool === 'WebFetch' || tool === 'WebSearch') {
    if (typeof rec.url === 'string') return rec.url;
    if (typeof rec.query === 'string') return rec.query;
  }
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === 'string' && v.length > 0) return `${k}=${trim80(v)}`;
  }
  return '';
}

// Recover the checkpoint guard seq from its ref. Git refs are
// `refs/arco/<wfid>/<seq>`; the non-git tar fallback ref is
// `<wfid>.<seq>.tar`. The guard seq is the value the server's revert handler
// needs to rebuild the ref (the message's own `seq` field is clobbered by the
// broadcast seq-stamp, so the ref is the only reliable carrier).
function guardSeqFromRef(ref: string): number | null {
  if (!ref) return null;
  let token: string | undefined;
  if (ref.startsWith('refs/arco/')) {
    token = ref.split('/').pop();
  } else if (ref.endsWith('.tar')) {
    // <wfid>.<seq>.tar — seq is the segment before the .tar extension.
    token = ref.slice(0, -'.tar'.length).split('.').pop();
  }
  if (token == null) return null;
  const n = Number(token);
  return Number.isFinite(n) ? n : null;
}

function formatElapsedShort(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${(s - m * 60).toFixed(0)}s`;
}

// Phase 8 — narrative-event extractor for the HISTORY tab. Maps the small set
// of seq-stamped messages we render on the timeline to a HistoryEventEntry;
// returns null for everything else so live replay and paged fetches can share
// the same interpretation.
export function narrativeEventFromMessage(msg: ServerMessage): HistoryEventEntry | null {
  const seq = (msg as { seq?: number }).seq;
  if (typeof seq !== 'number') return null;
  const eventTs = (msg as { ts?: number }).ts;
  const fallbackAt = typeof eventTs === 'number' ? eventTs : Date.now();
  switch (msg.type) {
    case 'user_message_echo':
      return {
        seq,
        category: 'user',
        label: 'USER',
        summary: trim80(msg.content),
        at: msg.timestamp ?? fallbackAt,
        ...(msg.clientMessageId ? { chatMessageId: msg.clientMessageId } : {}),
      };
    case 'primary_complete':
      return {
        seq,
        category: 'primary',
        label: 'PRIMARY',
        summary: '(turn complete)',
        at: fallbackAt,
      };
    case 'worker_tool_use': {
      if (msg.status && msg.status !== 'completed' && msg.status !== 'failed') return null;
      return {
        seq,
        category: 'tool',
        label: `TOOL · ${msg.tool}`,
        summary: summarizeToolInput(msg.tool, msg.input),
        at: fallbackAt,
        tool: msg.tool,
      };
    }
    case 'task_started':
      return {
        seq,
        category: 'task',
        label: 'TASK ⚡',
        summary: trim80(msg.description),
        at: msg.startedAt,
        taskPhase: 'running',
      };
    case 'task_status': {
      if (msg.phase === 'running') return null;
      const glyph = msg.phase === 'done' ? '✓' : msg.phase === 'error' ? '✕' : '⊘';
      const elapsed = formatElapsedShort(msg.elapsedMs);
      return {
        seq,
        category: 'task',
        label: `TASK ${glyph}`,
        summary: elapsed,
        at: fallbackAt,
        taskPhase: msg.phase,
      };
    }
    case 'handoff_artifact_ready': {
      const base = msg.artifactName.split('/').pop() ?? msg.artifactName;
      return {
        seq,
        category: 'handoff',
        label: 'HANDOFF →',
        summary: msg.error ? `ERROR: ${msg.error}` : base,
        at: msg.completedAt,
        ...(msg.error ? {} : { handoffArtifactName: msg.artifactName }),
      };
    }
    case 'review_artifact_ready': {
      const verdict = msg.verdict ?? (msg.error ? 'BLOCKING' : undefined);
      return {
        seq,
        category: 'review',
        label: verdict ? `REVIEW ${verdict}` : 'REVIEW',
        summary: msg.error ? trim80(msg.error) : msg.artifactName,
        at: msg.completedAt,
        ...(verdict ? { reviewVerdict: verdict } : {}),
        ...(msg.error ? {} : { reviewArtifactName: msg.artifactName }),
      };
    }
    case 'operator_label':
      return {
        seq,
        category: 'label',
        label: 'LABEL 📌',
        summary: trim80(msg.text),
        anchorSeq: msg.targetEventSeq,
        pinnedAt: msg.createdAt,
      };
    // Workbench Expansion A4 — checkpoint markers on the timeline. The row
    // carries the guard seq + ref so HISTORY can offer "Revert to here" and
    // "View diff vs now" (which open a ref-vs-WORKTREE diff).
    //
    // NOTE: the message's own `seq` field is CLOBBERED on the wire by the
    // broadcast's seq-stamp (`{...message, seq: <eventSeq>}` in
    // persistAndStampSeq), so we CANNOT read the guard seq off `msg.seq`. The
    // guard seq is recovered from the ref's trailing path segment
    // (`refs/arco/<wfid>/<guardSeq>`), which is never overwritten — that is
    // the value the server's revert handler needs to rebuild the ref.
    case 'checkpoint_created': {
      const guardSeq = guardSeqFromRef(msg.ref);
      return {
        seq,
        category: 'checkpoint',
        label: 'CHECKPOINT ●',
        summary: `${msg.label} · ${msg.fileCount} file${msg.fileCount === 1 ? '' : 's'}`,
        at: msg.ts ?? fallbackAt,
        ...(guardSeq != null ? { checkpointSeq: guardSeq } : {}),
        checkpointRef: msg.ref,
      };
    }
    // PHASE_9_FORKS_PLAN.md — REWIND CONVERSATION marker. The head was moved to
    // an earlier point; the next turn forks a child of `targetSeq`. Rendered as
    // its own `fork` row so the timeline shows where branches diverged.
    case 'leaf_move':
      return {
        seq,
        category: 'fork',
        label: 'REWIND ↩',
        summary: msg.reconstructed
          ? `rewound to seq ${msg.targetSeq} (reconstructed — older events had rotated off)`
          : `rewound to seq ${msg.targetSeq}`,
        at: msg.createdAt ?? fallbackAt,
        branchSource: msg.source,
        rewindTargetSeq: msg.targetSeq,
      };
    case 'checkpoint_reverted':
      return {
        seq,
        category: 'checkpoint',
        label: 'REVERTED ↩',
        // safetySnapshotRef carries the guard seq of the pre-revert snapshot
        // in its trailing segment; the restored checkpoint's guard seq isn't
        // recoverable here (msg.seq is clobbered) so we report the count only.
        summary: `restored a checkpoint · ${msg.fileCount} file${msg.fileCount === 1 ? '' : 's'}`
          + (msg.limitation ? ` · ${trim80(msg.limitation)}` : ''),
        at: msg.ts ?? fallbackAt,
        reverted: true,
      };
    default:
      return null;
  }
}
