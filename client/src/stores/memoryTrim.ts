// Memory-cap constants and pure capping helpers. Extracted verbatim from
// appStore.ts (Phase 5 file-size refactor) — move-only, no behavior change.
// These take/return plain data and must NOT import from `./appStore`.
import type { ChatMessage, WorkerState } from '@archon/shared';
import type { ActivityEntry, JobState } from './appStore.types';

// Hard caps to keep the browser tab's memory bounded. The 2026-04-16 incident
// (~63GB system RAM ballooning, hard lock) was made worse — possibly caused
// by — the Archon UI tab itself accumulating worker state without bounds and
// having Zustand-persist re-serialize the whole jobs slice on every store
// update. These limits keep the in-memory state lean; the persistance layer
// further strips workers entirely (server-side is the source of truth).
// Several of these caps + helpers are referenced directly by action bodies
// that remain in appStore.ts (worker output/thinking/tool-call trimming,
// activity + tool-filtered caps, the turn-usage sliding window). They were
// module-private in the original single file; exporting them here is the
// move-only equivalent so appStore.ts can import them.
export const MAX_WORKER_OUTPUT_BYTES_CLIENT = 256 * 1024;   // 256 KB per worker
export const MAX_WORKER_THINKING_BYTES_CLIENT = 64 * 1024;  // 64 KB per worker
const MAX_CHAT_MESSAGE_BYTES_CLIENT = 256 * 1024;    // 256 KB per chat/session row
const MAX_TOOL_INPUT_STRING_BYTES_CLIENT = 16 * 1024; // per string field in tool inputs
export const MAX_WORKER_TOOL_CALLS = 200;                    // last N tool calls
const MAX_RETAINED_WORKERS = 80;                      // all live workers + newest settled workers
const MAX_CHAT_MESSAGES = 500;                        // newest 500 messages
const SESSION_CHAT_WINDOW = 500;                       // newest Claude JSONL-derived rows kept hot
export const LOADED_HISTORY_PIN = 200;                // explicit load-earlier page kept visible after prepend
export const MAX_ACTIVITY_ENTRIES = 500;                     // right-pane live feed cap; sized so tool-heavy turns survive without unbounded growth
export const MAX_TOOL_FILTERED_ENTRIES = 500;                // tool filter annotations keyed by toolUseId
export const TURN_TOKEN_USAGE_CAP = 200;                     // EFFICIENCY_PLAN.md Phase A — sliding window for the Activity tab "Token usage" section. Older turns live in events.jsonl.
export const PERSIST_DEBOUNCE_MS = 1000;              // 1 Hz max write rate

export interface MessageWindowOptions {
  limit?: number;
  preserveStartCount?: number;
}

export interface SessionWindowOptions {
  limit?: number;
  preserveOldestCount?: number;
}

function messageSortKey(m: ChatMessage, index: number): number {
  const ts = typeof m.timestamp === 'number' && Number.isFinite(m.timestamp) ? m.timestamp : 0;
  // Preserve stable insertion order for rows sharing a timestamp.
  return ts * 100000 + index;
}

function mustKeepHot(m: ChatMessage): boolean {
  return m.isStreaming === true || m.queued === true || m.operatorQuestion?.status === 'pending';
}

function shouldPreferKeeping(m: ChatMessage): boolean {
  return m.role === 'system' || !!m.toolUse;
}

export function capMessages(messages: ChatMessage[], options: MessageWindowOptions = {}): ChatMessage[] {
  const limit = options.limit ?? MAX_CHAT_MESSAGES;
  const cappedMessages = messages.map(capChatMessage);
  if (cappedMessages.length <= limit) return cappedMessages;
  const keep = new Set<number>();
  const preserveStartCount = Math.max(0, Math.min(options.preserveStartCount ?? 0, cappedMessages.length));
  for (let i = 0; i < preserveStartCount; i++) keep.add(i);
  const newestFirst = cappedMessages
    .map((m, i) => ({ i, key: messageSortKey(m, i) }))
    .sort((a, b) => b.key - a.key);

  // Streaming, queued and pending-question rows stay hot (questions are
  // bounded to 16 per worker), still subject to the overall hard cap. System/tool
  // rows are preferred, but they still participate in the hard cap; otherwise
  // long-running clusters can bypass MAX_CHAT_MESSAGES forever with turn
  // markers, peer notices, and tool cards.
  for (const { i } of newestFirst) {
    if (mustKeepHot(cappedMessages[i]!)) keep.add(i);
  }
  if (keep.size > limit) {
    const hot = newestFirst.filter(({ i }) => keep.has(i)).slice(0, limit);
    return cappedMessages.filter((_, i) => hot.some((h) => h.i === i));
  }
  for (const { i } of newestFirst) {
    if (keep.size >= limit) break;
    if (shouldPreferKeeping(cappedMessages[i]!)) keep.add(i);
  }
  const remaining = Math.max(0, limit - keep.size);
  if (remaining > 0) {
    newestFirst
      .filter(({ i }) => !keep.has(i))
      .slice(0, remaining)
      .forEach(({ i }) => keep.add(i));
  }
  return cappedMessages.filter((_, i) => keep.has(i));
}

export function capWorkerText(text: string, cap: number, label: string): string {
  if (text.length <= cap) return text;
  const notice = `\n[client-side ${label} truncated; full stream remains in provider logs/events if available]`;
  return text.slice(Math.max(0, text.length - cap + notice.length)) + notice;
}

function capMiddleText(text: string, cap: number, label: string): string {
  if (text.length <= cap) return text;
  const notice = `\n[client-side ${label} truncated; full content remains in provider transcripts/events if available]\n`;
  const keep = Math.max(0, cap - notice.length);
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return text.slice(0, head) + notice + text.slice(Math.max(0, text.length - tail));
}

function capToolInputValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return capMiddleText(value, MAX_TOOL_INPUT_STRING_BYTES_CLIENT, 'tool input field');
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 3) return '[client-side nested tool input omitted]';
  if (Array.isArray(value)) {
    let changed = value.length > 100;
    const capped = value.slice(0, 100).map((v) => {
      const next = capToolInputValue(v, depth + 1);
      if (next !== v) changed = true;
      return next;
    });
    if (value.length > capped.length) {
      capped.push(`[client-side ${value.length - capped.length} array item(s) omitted]`);
    }
    return changed ? capped : value;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  let changed = entries.length > 80;
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries.slice(0, 80)) {
    const next = capToolInputValue(v, depth + 1);
    if (next !== v) changed = true;
    out[k] = next;
  }
  if (entries.length > 80) {
    out.__archon_truncated_keys = `${entries.length - 80} key(s) omitted client-side`;
  }
  return changed ? out : value;
}

function capChatMessage(message: ChatMessage): ChatMessage {
  let next = message;
  if (typeof message.content === 'string' && message.content.length > MAX_CHAT_MESSAGE_BYTES_CLIENT) {
    next = {
      ...next,
      content: capMiddleText(message.content, MAX_CHAT_MESSAGE_BYTES_CLIENT, 'chat message'),
    };
  }
  if (message.toolUse) {
    const cappedInput = capToolInputValue(message.toolUse.input);
    if (cappedInput !== message.toolUse.input) {
      next = {
        ...next,
        toolUse: {
          ...message.toolUse,
          input: cappedInput,
        },
      };
    }
  }
  return next;
}

export function capToolInputText(input: string): string {
  return capMiddleText(input, MAX_TOOL_INPUT_STRING_BYTES_CLIENT, 'tool input field');
}

function capToolFiltered(
  toolFiltered: JobState['toolFiltered'],
): JobState['toolFiltered'] {
  if (!toolFiltered) return toolFiltered;
  const keys = Object.keys(toolFiltered);
  if (keys.length <= MAX_TOOL_FILTERED_ENTRIES) return toolFiltered;
  const next = { ...toolFiltered };
  for (const k of keys.slice(0, keys.length - MAX_TOOL_FILTERED_ENTRIES)) delete next[k];
  return next;
}

function capWorkerState(worker: WorkerState): WorkerState {
  return {
    ...worker,
    output: capWorkerText(worker.output ?? '', MAX_WORKER_OUTPUT_BYTES_CLIENT, 'worker output'),
    thinking: capWorkerText(worker.thinking ?? '', MAX_WORKER_THINKING_BYTES_CLIENT, 'worker thinking'),
    toolCalls: Array.isArray(worker.toolCalls)
      ? worker.toolCalls.slice(-MAX_WORKER_TOOL_CALLS).map((call) => ({
          ...call,
          input: capToolInputText(call.input),
        }))
      : [],
  };
}

export function capWorkers(workers: Record<string, WorkerState>): Record<string, WorkerState> {
  const entries = Object.entries(workers).map(([id, worker]) => [id, capWorkerState(worker)] as const);
  if (entries.length <= MAX_RETAINED_WORKERS) return Object.fromEntries(entries);
  const active = entries.filter(([, w]) => w.status === 'running' || w.status === 'spawning');
  const settled = entries
    .filter(([, w]) => w.status !== 'running' && w.status !== 'spawning')
    .sort((a, b) => (b[1].lastActivityAt ?? b[1].spawnedAt ?? 0) - (a[1].lastActivityAt ?? a[1].spawnedAt ?? 0));
  return Object.fromEntries([...active, ...settled.slice(0, Math.max(0, MAX_RETAINED_WORKERS - active.length))]);
}

export function capActivityEntry(entry: ActivityEntry): ActivityEntry {
  return {
    ...entry,
    ...(entry.input ? { input: capMiddleText(entry.input, MAX_TOOL_INPUT_STRING_BYTES_CLIENT, 'activity input') } : {}),
    ...(entry.output ? { output: capMiddleText(entry.output, MAX_CHAT_MESSAGE_BYTES_CLIENT, 'activity output') } : {}),
    ...(entry.text ? { text: capMiddleText(entry.text, MAX_WORKER_THINKING_BYTES_CLIENT, 'activity thinking') } : {}),
  };
}

export function trimJobMemory(job: JobState): JobState {
  return {
    ...job,
    messages: capMessages(job.messages ?? []),
    sessionChat: capSessionChat(job.sessionChat ?? []),
    activity: Array.isArray(job.activity) ? job.activity.slice(-MAX_ACTIVITY_ENTRIES).map(capActivityEntry) : [],
    historyEvents: Array.isArray(job.historyEvents) ? job.historyEvents.slice(-1000) : [],
    turnTokenUsage: Array.isArray(job.turnTokenUsage) ? job.turnTokenUsage.slice(-TURN_TOKEN_USAGE_CAP) : undefined,
    workers: capWorkers(job.workers ?? {}),
    toolFiltered: capToolFiltered(job.toolFiltered),
  };
}

export function capSessionChat(messages: ChatMessage[], options: SessionWindowOptions = {}): ChatMessage[] {
  const limit = options.limit ?? SESSION_CHAT_WINDOW;
  const cappedMessages = messages.map(capChatMessage);
  if (cappedMessages.length <= limit) return cappedMessages;
  const keep = new Set<number>();
  const preserveOldestCount = Math.max(0, Math.min(options.preserveOldestCount ?? 0, cappedMessages.length));
  const byAge = cappedMessages
    .map((m, i) => ({ i, key: messageSortKey(m, i) }))
    .sort((a, b) => a.key - b.key);
  byAge.slice(0, preserveOldestCount).forEach(({ i }) => keep.add(i));
  const remaining = Math.max(0, limit - keep.size);
  if (remaining > 0) {
    byAge
      .filter(({ i }) => !keep.has(i))
      .sort((a, b) => b.key - a.key)
      .slice(0, remaining)
      .forEach(({ i }) => keep.add(i));
  }
  return cappedMessages.filter((_, i) => keep.has(i));
}
