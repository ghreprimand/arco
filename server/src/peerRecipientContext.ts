import type { LedgerTask, ServerMessage } from '@arco/shared';
import * as clusterStore from './clusterStore.js';
import * as mailbox from './clusterMailbox.js';
import * as ledger from './project/taskLedger.js';
import { workflows, workflowCwds } from './server/state.js';
import { readEventsPageBefore } from './workflowStore.js';

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
    const page = await readEventsPageBefore(cwd, sender, Infinity, Number.MAX_SAFE_INTEGER).catch(() => ({ events: [] as ServerMessage[] }));
    for (const event of page.events) {
      if (event.type === 'peer_message_received' && event.from === recipient && typeof event.ts === 'number') facts.push({ content: event.content, timestamp: event.ts });
    }
  }
  return buildRecipientContext(workflows.get(recipient)?.busy, tasks, recipient, facts, Date.now());
}
