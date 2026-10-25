// Pure selectors over AppState. Extracted verbatim from appStore.ts (Phase 5
// file-size refactor) — move-only, no behavior change.
import type { AppState, AppMemoryStats } from './appStore.types';

export function getAppMemoryStats(state: AppState): AppMemoryStats {
  let messages = 0;
  let sessionChat = 0;
  let activity = 0;
  let historyEvents = 0;
  let workerToolCalls = 0;
  let messageBytes = 0;
  let sessionChatBytes = 0;
  let activityBytes = 0;
  let workerOutputBytes = 0;
  let workerThinkingBytes = 0;
  let workerToolInputBytes = 0;
  for (const job of Object.values(state.jobs)) {
    messages += Array.isArray(job.messages) ? job.messages.length : 0;
    sessionChat += Array.isArray(job.sessionChat) ? job.sessionChat.length : 0;
    activity += Array.isArray(job.activity) ? job.activity.length : 0;
    historyEvents += Array.isArray(job.historyEvents) ? job.historyEvents.length : 0;
    for (const m of job.messages ?? []) messageBytes += m.content?.length ?? 0;
    for (const m of job.sessionChat ?? []) {
      sessionChatBytes += m.content?.length ?? 0;
      if (m.toolUse?.input !== undefined) {
        try { sessionChatBytes += JSON.stringify(m.toolUse.input).length; } catch { /* ignore */ }
      }
    }
    for (const a of job.activity ?? []) {
      activityBytes += (a.input?.length ?? 0) + (a.output?.length ?? 0) + (a.text?.length ?? 0);
    }
    for (const worker of Object.values(job.workers ?? {})) {
      workerOutputBytes += worker.output?.length ?? 0;
      workerThinkingBytes += worker.thinking?.length ?? 0;
      workerToolCalls += Array.isArray(worker.toolCalls) ? worker.toolCalls.length : 0;
      for (const call of worker.toolCalls ?? []) workerToolInputBytes += call.input?.length ?? 0;
    }
  }
  const clusters = Object.values(state.clusters);
  const clusterMemberCount = clusters.reduce((sum, c) => sum + c.members.length, 0);
  const mailboxDepth = clusters.reduce(
    (sum, c) => sum + Object.values(c.mailboxDepth ?? {}).reduce((s, n) => s + (Number.isFinite(n) ? n : 0), 0),
    0,
  );
  const persistedShape = {
    jobs: Object.fromEntries(Object.entries(state.jobs).map(([id, j]) => [id, {
      id: j.id,
      currentSessionId: j.currentSessionId,
      config: j.config,
      messages: j.messages.slice(-200),
      reviews: j.reviews.slice(-40),
      handoffs: j.handoffs.slice(-40),
      lastSeq: j.lastSeq,
      historyEvents: j.historyEvents?.slice(-500),
    }])),
    clusters: state.clusters,
    activeJobId: state.activeJobId,
    activeClusterId: state.activeClusterId,
  };
  const perf = typeof performance !== 'undefined'
    ? performance as Performance & { memory?: { usedJSHeapSize?: number } }
    : undefined;
  return {
    workflowCount: Object.keys(state.jobs).length,
    clusterCount: clusters.length,
    clusterMemberCount,
    hotRows: { messages, sessionChat, activity, historyEvents, workerToolCalls, mailboxDepth },
    hotTextBytes: {
      messages: messageBytes,
      sessionChat: sessionChatBytes,
      activity: activityBytes,
      workerOutput: workerOutputBytes,
      workerThinking: workerThinkingBytes,
      workerToolInputs: workerToolInputBytes,
    },
    approxPersistedBytes: new Blob([JSON.stringify(persistedShape)]).size,
    ...(typeof perf?.memory?.usedJSHeapSize === 'number' ? { browserHeapBytes: perf.memory.usedJSHeapSize } : {}),
  };
}
