// Labeled Smart AUTO-PICKUP corpus cases (synthetic) mapped onto the same
// SnapshotInput the app builds from a real mailbox, task board and thread
// context. Shared by the unit tests and scripts/smart-pickup-eval.ts so an
// evaluation run sends the evaluator exactly what the app would.
//
// Two case shapes are read:
//   v1: pendingMessages [{senderRole, body}], taskFacts.taskStatus
//   v2: pendingMessages [{senderId, senderRole, body}], openTasks
//       [{id, title, status}], recipientLastMessageToSender {senderId: body}
import { DEFAULT_SMART_PICKUP_LIMITS } from '@arco/shared';
import { isOpenTaskStatus, type SnapshotInput } from './smartPickupEvaluator.js';

export interface CorpusCase {
  id: string;
  split: string;
  category?: string;
  recipient: { role: string; status: string };
  pendingMessages: { senderId?: string; senderRole: string; body: string; age?: string }[];
  openTasks?: { id: string; title: string; status: string }[];
  recipientLastMessageToSender?: Record<string, string>;
  taskFacts?: Record<string, unknown>;
  expected: { action: 'wake' | 'defer' | 'ask'; reason: string };
}

export const CORPUS_MAX_INPUT_BYTES = DEFAULT_SMART_PICKUP_LIMITS.maxInputBytes;

// v1 described the recipient's task as a free status; the task board's
// statuses are used where they exist (active becomes in_progress).
function v1Tasks(c: CorpusCase): SnapshotInput['tasks'] {
  const status = c.taskFacts?.taskStatus;
  if (typeof status !== 'string') return [];
  return [{ id: 'task-1', title: 'Current assignment', status: status === 'active' ? 'in_progress' : status }];
}

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 31, 0, 0, seconds)).toISOString();

export function corpusSnapshotInput(c: CorpusCase): SnapshotInput {
  const condition = c.taskFacts?.snapshotCondition;
  const recipientRole = c.recipient.role;
  // Pending mail is queued after any earlier message from the recipient.
  const messages = c.pendingMessages.map((m, i) => ({
    id: `${c.id}-m${i}`,
    senderId: m.senderId ?? `sender:${m.senderRole}`,
    senderRole: m.senderRole,
    body: m.body,
    createdAt: at(30 + i),
  }));
  const tasks = (c.openTasks ?? v1Tasks(c)).filter((t) => isOpenTaskStatus(t.status)).slice(0, 5);
  const sentTo = Object.entries(c.recipientLastMessageToSender ?? {}).map(([to, body]) => ({ to, body, createdAt: at(10) }));
  if (condition === 'empty') return { recipientRole, recipientStatus: 'idle', messages: [], tasks };
  if (condition === 'oversized' || condition === 'truncated') {
    return { recipientRole, recipientStatus: 'idle', messages: [{ id: `${c.id}-big`, senderId: 'sender:Tester', senderRole: 'Tester', body: 'x'.repeat(CORPUS_MAX_INPUT_BYTES + 1) }], tasks };
  }
  if (condition === 'corrupt' || condition === 'missing_ids') return { recipientRole, recipientStatus: 'idle', messages, tasks, unreadable: true };
  return { recipientRole, recipientStatus: c.recipient.status === 'busy' ? 'busy' : 'idle', messages, tasks, ...(sentTo.length ? { sentTo } : {}) };
}
