import { createHash } from 'node:crypto';
import { buildTranscriptSlice, type TranscriptSliceOptions } from './transcriptWorker.js';
import { replayEvents } from './workflowStore.js';
import { renderTranscript, summarizePriorTurns } from './primitives/exportContext.js';
import { RECENT_HISTORY_MAX_BYTES } from './historyLimits.js';

export const REPLACEMENT_FULL_BYTES = 512 * 1024;
export const REPLACEMENT_RECENT_BYTES = RECENT_HISTORY_MAX_BYTES;
export type ReplacementHistoryMode = 'recent' | 'full';

export async function buildReplacementHistory(cwd: string, workflowId: string, mode: ReplacementHistoryMode, options: TranscriptSliceOptions) {
  if (mode !== 'recent' && mode !== 'full') throw new Error('Choose NO HISTORY, RECENT HISTORY or FULL HISTORY.');
  const slice = await buildTranscriptSlice(cwd, workflowId, { ...options, turns: mode === 'full' ? Number.MAX_SAFE_INTEGER : options.turns }, {
    maxBytes: mode === 'full' ? REPLACEMENT_FULL_BYTES : REPLACEMENT_RECENT_BYTES,
    fitWholeTurns: true, allTurns: mode === 'full',
  });
  let seed = slice.seed, selectedTurns = slice.selectedTurns, historyFallback = false;
  if (mode === 'full') {
    // Preserve the existing full-history transcript and action digest while
    // they fit. Only the oversized fallback uses the shared recent-turn form.
    const events = (await replayEvents(cwd, workflowId, 0)).filter(event => !('seq' in event) || typeof event.seq !== 'number' || event.seq <= slice.cutoffSeq);
    const transcript = renderTranscript(events).trim(), actions = summarizePriorTurns(events).trim();
    const full = [
      '[REPLACEMENT CONTEXT — copied by explicit operator request; this is a new provider session]',
      transcript,
      actions ? `\n[Prior-turn action digest]\n${actions}` : '',
      '\nAcknowledge this imported context briefly, then wait for the operator.',
    ].filter(Boolean).join('\n\n');
    if (Buffer.byteLength(full, 'utf8') <= REPLACEMENT_FULL_BYTES) { seed = full; selectedTurns = slice.availableTurns; }
    else historyFallback = true;
  }
  const bytes = Buffer.byteLength(seed, 'utf8');
  const digest = createHash('sha256').update(JSON.stringify({ source: slice.digest, seed, mode, turns: options.turns })).digest('hex');
  return { ...slice, seed, bytes, selectedTurns, digest, historyMode: mode,
    requestedTurns: mode === 'full' ? slice.availableTurns : options.turns,
    truncated: selectedTurns < slice.availableTurns, historyFallback };
}

export function replacementHistoryNotice(preview: Awaited<ReturnType<typeof buildReplacementHistory>>): string | undefined {
  if (!preview.truncated && !preview.historyFallback) return;
  if (!preview.selectedTurns) return 'No whole recent turn fit the replacement history limit. No earlier history was copied; it remains in the previous member conversation.';
  if (preview.truncated) return `Only the most recent ${preview.selectedTurns} of ${preview.availableTurns} turns were copied from the previous member. Earlier turns were not copied; they remain in its conversation.`;
  return `The full history exceeded 512 KiB. All ${preview.selectedTurns} turns were copied as text and tool/file receipts; the full action digest was not copied.`;
}
