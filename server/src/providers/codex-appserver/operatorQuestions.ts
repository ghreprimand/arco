import { randomUUID } from 'node:crypto';
import type { OperatorQuestionState, OperatorQuestion } from '@arco/shared';
import type { JsonRpcId, JsonRpcServerRequest } from './jsonRpc.js';

type Answers = Record<string, string[]>;
type SendInput = (content: string, question: OperatorQuestionState) => Promise<void>;
interface Pending {
  workflowId: string;
  state: OperatorQuestionState;
  rpcId?: JsonRpcId;
  respond?: (result: unknown) => boolean | void;
  publish: (state: OperatorQuestionState) => void;
  owner: CodexOperatorQuestions;
  sending: boolean;
}
// Process-local handles only. Disk/replay stores the public state, never callbacks.
const pending = new Map<string, Pending>();
let publisher: ((workflowId: string, state: OperatorQuestionState) => void) | undefined;
export function setOperatorQuestionPublisher(publish: NonNullable<typeof publisher>): void { publisher = publish; }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function text(v: unknown, max = 32768): v is string { return typeof v === 'string' && v.length > 0 && v.length <= max; }

function parseQuestions(value: unknown): OperatorQuestion[] {
  if (!Array.isArray(value) || !value.length || value.length > 3) throw new Error('Expected 1–3 questions.');
  const ids = new Set<string>();
  return value.map((q) => {
    if (!record(q) || !text(q.id, 256) || ids.has(q.id) || typeof q.header !== 'string' || q.header.length > 1024 || !text(q.question)) throw new Error('Invalid question fields.');
    ids.add(q.id);
    if (q.options != null && (!Array.isArray(q.options) || q.options.length > 20)) throw new Error('Invalid question options.');
    const options = (q.options as unknown[] | null | undefined)?.map((o) => {
      if (!record(o) || !text(o.label, 4096) || typeof o.description !== 'string' || o.description.length > 8192) throw new Error('Invalid question option.');
      return { label: o.label, description: o.description };
    });
    return { id: q.id, header: q.header, question: q.question, options, allowOther: q.isOther === true, secret: q.isSecret === true };
  });
}

export function pendingOperatorQuestions(workflowId: string): OperatorQuestionState[] {
  return [...pending.values()].filter((p) => p.workflowId === workflowId).map((p) => p.state);
}

export async function replyToOperatorQuestion(workflowId: string, requestId: string, value: unknown, sendInput?: SendInput): Promise<{ ok: boolean; error?: string }> {
  const entry = pending.get(requestId);
  if (!entry || entry.workflowId !== workflowId) return { ok: false, error: 'This question is no longer pending.' };
  if (entry.sending) return { ok: false, error: 'An answer is already being delivered.' };
  if (!record(value) || Object.keys(value).length !== entry.state.questions.length) return { ok: false, error: 'Answer every question.' };
  const answers: Answers = Object.create(null);
  for (const q of entry.state.questions) {
    const a = Object.hasOwn(value, q.id) ? value[q.id] : undefined;
    if (!Array.isArray(a) || a.length !== 1 || !text(a[0], 16384) || !a[0].trim()) return { ok: false, error: 'Each question needs an answer.' };
    if (q.options?.length && !q.allowOther && !q.options.some((o) => o.label === a[0])) return { ok: false, error: 'Choose one of the offered options.' };
    answers[q.id] = [a[0]];
  }
  entry.sending = true;
  try {
    if (entry.respond) {
      const delivered = entry.respond({ answers: Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, { answers: a }])) });
      if (delivered === false) throw new Error('Codex connection closed.');
    } else {
      if (!sendInput) throw new Error('The question reply channel is unavailable.');
      // Async agent-message questions have no pending RPC. Send an ordinary
      // operator turn/interjection through Arco's existing turn pipeline.
      await sendInput('Answers to your questions:\n' + entry.state.questions.map((q) => `${q.question}\nAnswer: ${answers[q.id][0]}`).join('\n\n'), entry.state);
    }
    if (pending.get(requestId) === entry) {
      const publicAnswers = Object.fromEntries(entry.state.questions.map((q) => [q.id, q.secret ? ['[redacted]'] : answers[q.id]]));
      entry.owner.finish(entry, { ...entry.state, status: 'answered', answers: publicAnswers });
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'The answer could not be delivered. Retry or cancel the turn.' };
  } finally { entry.sending = false; }
}

export class CodexOperatorQuestions {
  private ids = new Set<string>();
  private asyncItems = new Set<string>();
  constructor(private workflowId: string, private provider: 'codex', private publish: Pending['publish'] = (state) => publisher?.(workflowId, state)) {}

  acceptRpc(req: JsonRpcServerRequest, respond: (result: unknown) => boolean | void): void {
    const p = req.params;
    if (!record(p) || !text(p.threadId) || !text(p.turnId) || !text(p.itemId)) throw new Error('Invalid question request.');
    if (p.isBlocking !== undefined && typeof p.isBlocking !== 'boolean') throw new Error('Invalid blocking flag.');
    if ([...this.ids].some((id) => pending.get(id)?.rpcId === req.id)) throw new Error('Duplicate question request.');
    const questions = parseQuestions(p.questions);
    this.add({ threadId: p.threadId, turnId: p.turnId, itemId: p.itemId, mode: p.isBlocking === false ? 'async' : 'blocking', questions }, respond, req.id);
  }

  acceptAsync(threadId: string, turnId: string, item: { id: string; questions?: unknown }): void {
    if (this.asyncItems.has(item.id) || !Array.isArray(item.questions) || !item.questions.length) return;
    // The current CLI's async agentMessage schema carries titles + option
    // strings, unlike requestUserInput's richer per-question schema.
    const questions = parseQuestions(item.questions.map((q, i) => {
      if (!record(q) || !text(q.title) || (q.options != null && (!Array.isArray(q.options) || q.options.some((o) => !text(o, 4096))))) throw new Error('Invalid async question.');
      return { id: `question-${i + 1}`, header: `Question ${i + 1}`, question: q.title, isOther: true,
        options: Array.isArray(q.options) ? q.options.map((label) => ({ label, description: '' })) : undefined };
    }));
    if ([...this.ids].some((id) => pending.get(id)?.state.itemId === item.id)) return;
    this.add({ threadId, turnId, itemId: item.id, mode: 'async', questions });
    this.asyncItems.add(item.id);
    if (this.asyncItems.size > 128) this.asyncItems.delete(this.asyncItems.values().next().value!);
  }

  private add(data: Pick<OperatorQuestionState, 'threadId' | 'turnId' | 'itemId' | 'mode' | 'questions'>, respond?: Pending['respond'], rpcId?: JsonRpcId): void {
    if (this.ids.size >= 16) throw new Error('Too many pending questions.');
    const state: OperatorQuestionState = { ...data, requestId: randomUUID(), provider: this.provider, status: 'pending', createdAt: Date.now() };
    const entry: Pending = { workflowId: this.workflowId, state, respond, rpcId, publish: this.publish, owner: this, sending: false };
    this.ids.add(state.requestId); pending.set(state.requestId, entry); this.publish(state);
  }

  finish(entry: Pending, state: OperatorQuestionState): void {
    pending.delete(entry.state.requestId); this.ids.delete(entry.state.requestId); entry.publish(state);
  }

  resolvedRpc(rpcId: JsonRpcId): void {
    for (const id of [...this.ids]) {
      const p = pending.get(id);
      if (p?.rpcId === rpcId) this.finish(p, { ...p.state, status: 'cancelled', reason: 'Codex closed this question.' });
    }
  }

  cancel(reason: string, rpcOnly = false): void {
    for (const id of [...this.ids]) {
      const p = pending.get(id);
      if (!p || (rpcOnly && p.rpcId === undefined)) continue;
      this.finish(p, { ...p.state, status: 'cancelled', reason });
      p.respond?.({ answers: {} });
    }
  }
}
