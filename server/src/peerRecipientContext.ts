import type { LedgerTask } from '@arco/shared';
import * as clusterStore from './clusterStore.js';
import * as mailbox from './clusterMailbox.js';
import * as ledger from './project/taskLedger.js';
import { workflows, workflowCwds } from './server/state.js';
import { readLogLines } from './eventLog.js';
import { join } from 'node:path';

export interface RecipientContext {
  state: 'busy' | 'idle' | 'unknown';
  task: { id: string; title: string } | null;
  lastMessage: { firstLine: string; ageSeconds: number } | null;
}

type MessageFact = { content: string; timestamp: number };
export function buildRecipientContext(busy: boolean | undefined, tasks: LedgerTask[], recipient: string, messages: MessageFact[], now: number): RecipientContext {
  const task = tasks.filter((t) => t.assignee === recipient && t.status === 'in_progress')
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))[0];
  const last = messages.filter((m) => Number.isFinite(m.timestamp)).sort((a, b) => b.timestamp - a.timestamp)[0];
  return {
    state: busy === undefined ? 'unknown' : busy ? 'busy' : 'idle',
    task: task ? { id: task.id, title: task.title } : null,
    lastMessage: last ? { firstLine: last.content.split(/\r?\n/, 1)[0], ageSeconds: Math.max(0, Math.floor((now - last.timestamp) / 1000)) } : null,
  };
}

export async function recipientContext(clusterId: string, sender: string, recipient: string): Promise<RecipientContext> {
  const cluster = await clusterStore.readCluster(clusterId);
  const canReadBoard = cluster && clusterStore.getMemberAccessMode(clusterId, sender) === 'standard' && clusterStore.normalizeTaskBoardMode(cluster) !== 'none';
  const tasks = canReadBoard ? await ledger.load(cluster.cwd, clusterStore.taskBoardKeyForState(cluster)).catch(() => []) : [];
  const pending = await mailbox.peek(sender).catch(() => []);
  const facts: MessageFact[] = pending.filter((m) => m.fromWorkflowId === recipient).map((m) => ({ content: m.content, timestamp: Date.parse(m.createdAt) }));
  const cwd = workflowCwds.get(sender) ?? cluster?.cwd;
  if (cwd) {
    let last: MessageFact | undefined;
    if (/^[a-zA-Z0-9-]{1,64}$/.test(sender)) {
      try {
        for await (const line of readLogLines(join(cwd, '.arco', 'workflows', sender))) {
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.type === 'peer_message_received' && event.from === recipient && typeof event.content === 'string'
            && typeof event.ts === 'number' && Number.isFinite(event.ts) && (!last || event.ts >= last.timestamp)) {
            last = { content: event.content.split(/\r?\n/, 1)[0].slice(0, 2000), timestamp: event.ts };
          }
        }
      } catch { /* advisory context; a failed lookup must not hide pending mail */ }
    }
    if (last) facts.push(last);
  }
  return buildRecipientContext(workflows.get(recipient)?.busy, tasks, recipient, facts, Date.now());
}
