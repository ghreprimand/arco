import type { WorkerConfig } from '@arco/shared';
import { projectOllamaHistory } from './ollamaExecutionHistory.js';
import { readOllamaBoundary, saveOllamaBoundary, ollamaProjectDigest, type OllamaBoundary } from './ollamaBoundaryStore.js';
import { assembleCompacted, compactionSeedMessage, type CompactMessage, type CompactionConfig } from './ollamaRecovery.js';
import { renderTranscript } from '../primitives/exportContext.js';

type Message = CompactMessage;
const cycles = new Map<string, { digest: string; fired: boolean }>();
export async function compactDurableOllama(args: {
  messages: Message[]; context: NonNullable<WorkerConfig['ollamaReplay']>; cwd: string; workflowId: string;
  config: CompactionConfig; window: number | undefined;
  parse: (transcript: string) => Message[];
  estimate: (messages: Message[]) => number;
  summarize: (messages: Message[]) => Promise<{ text: string; source: string }>;
  emit: (notice: string) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { messages, context, config, cwd, workflowId, parse, emit } = args;
  if (!context.policy.enabled || !context.stillOwner() || args.signal?.aborted) return;
  const history = projectOllamaHistory(context.events, workflowId, context.activeInputSeqs);
  if (!history.valid) { emit(`Ollama auto-compaction deferred: ${history.reason}; original history remains available.`); return; }
  const cuts = history.cuts;
  const parsed = new Map<number, Message[]>();
  const cutMessages = (cut: (typeof cuts)[number]): Message[] => {
    let value = parsed.get(cut.throughSeq);
    if (!value) { value = parse(renderTranscript(cut.events, { preserveThinking: true }).trim()); parsed.set(cut.throughSeq, value); }
    return value;
  };
  const start = messages.findIndex(m => m.role !== 'system');
  const matches = (prefix: Message[]) => start >= 0 && prefix.length > 0 && JSON.stringify(messages.slice(start, start + prefix.length)) === JSON.stringify(prefix);
  const stored = readOllamaBoundary(cwd, workflowId);
  let prior: OllamaBoundary | null = null;
  let priorCount = 0;
  if (stored) {
    const matching = cuts.find(c => stored.sessionEpoch === history.epoch && c.throughSeq === stored.throughSeq && c.digest === stored.digest);
    if (matching && matches(cutMessages(matching))) {
      messages.splice(start, cutMessages(matching).length, compactionSeedMessage(stored.summary, stored.foldedCount));
      prior = stored; priorCount = cutMessages(matching).length;
    } else emit('Ollama saved summary did not match its execution history; original history is retained.');
  }
  const used = args.estimate(messages), window = args.window;
  if (!Number.isFinite(window) || !window || window <= 0 || !Number.isFinite(used) || used <= 0) return;
  const threshold = context.policy.thresholdPercent / 100;
  const cycleKey = JSON.stringify([cwd, workflowId, history.epoch]);
  const digest = prior?.digest ?? '';
  let cycle = cycles.get(cycleKey);
  if (!cycle || cycle.digest !== digest) {
    cycle = { digest, fired: !!prior };
    if (cycles.size >= 1024) cycles.delete(cycles.keys().next().value!);
    cycles.set(cycleKey, cycle);
  }
  if (used / window < threshold - 0.05) cycle.fired = false;
  if (used / window < threshold || cycle.fired) return;
  const historyCount = parse(renderTranscript(history.events, { preserveThinking: true }).trim()).length;
  const available = cuts.filter(c => !prior || c.throughSeq > prior.throughSeq);
  const limit = Math.max(0, historyCount - config.keepLastMessages);
  let low = 0, high = available.length - 1;
  let candidate: (typeof cuts)[number] | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2), cut = available[middle];
    if (cutMessages(cut).length <= limit) { candidate = cut; low = middle + 1; }
    else high = middle - 1;
  }
  if (!candidate) { emit('Ollama auto-compaction deferred: no additional closed execution prefix fits outside the retained tail.'); return; }
  const older = prior ? [compactionSeedMessage(prior.summary, prior.foldedCount), ...cutMessages(candidate).slice(priorCount)] : cutMessages(candidate);
  if (!matches(older)) { emit('Ollama auto-compaction deferred: replay messages did not match the execution prefix.'); return; }
  // One attempt per high-water cycle, including failed or ineffective summaries.
  cycle.fired = true;
  const summary = await args.summarize(older);
  if (args.signal?.aborted || !context.stillOwner()) return;
  const next: OllamaBoundary = { version: 2, projectDigest: ollamaProjectDigest(cwd), workflowId,
    sessionEpoch: history.epoch, throughSeq: candidate.throughSeq, digest: candidate.digest,
    summary: summary.text, foldedCount: cutMessages(candidate).length };
  try {
    const saved = await saveOllamaBoundary(cwd, next, () => !args.signal?.aborted && context.stillOwner(), () => { emit(`ollama_compacted: summarized ${next.foldedCount} history messages via ${summary.source} at ${Math.round(used / window * 100)}% context (threshold ${context.policy.thresholdPercent}%). Original events remain recoverable.`); });
    if (!saved) { emit('Ollama auto-compaction deferred: cancellation or a newer summary prevented the save.'); return; }
  } catch { emit('Ollama auto-compaction failed to save its summary boundary; original events remain intact.'); return; }
  if (args.signal?.aborted || !context.stillOwner()) return;
  const after = assembleCompacted({ system: messages.slice(0, start), older, tail: messages.slice(start + older.length) }, summary.text, config);
  after[start] = compactionSeedMessage(summary.text, next.foldedCount);
  messages.splice(0, messages.length, ...after);
  cycle.digest = next.digest;
  cycle.fired = args.estimate(messages) / window >= threshold - 0.05;
}
