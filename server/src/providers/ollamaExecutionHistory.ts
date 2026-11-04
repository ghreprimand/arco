import { createHash } from 'node:crypto';
import type { ServerMessage } from '@arco/shared';

// Echo sequence identifies accepted input; execution identity identifies an actual
// spawn. Neither a queue drain nor chronological echo order proves execution.
export type OllamaHistoryEvent = ServerMessage & {
  seq?: number;
  ollamaExecutionId?: string;
  ollamaReplayInput?: boolean;
  ollamaInputSeqs?: number[];
};
interface Execution {
  id: string;
  start: number;
  inputs: number[];
  events: OllamaHistoryEvent[];
  complete?: number;
  ended?: number;
}
export interface OllamaHistoryCut {
  throughSeq: number;
  digest: string;
  events: OllamaHistoryEvent[];
}
export interface OllamaHistoryProjection {
  valid: boolean;
  reason?: string;
  epoch: number;
  events: OllamaHistoryEvent[];
  cuts: OllamaHistoryCut[];
}
const outputTypes = new Set(['primary_text', 'primary_thinking', 'primary_tool_use']);
const historyTypes = new Set([...outputTypes, 'user_message_echo', 'primary_turn_started', 'primary_complete', 'primary_turn_ended', 'queued_message_cancelled']);

export function projectOllamaHistory(
  source: OllamaHistoryEvent[], workflowId: string, activeInputSeqs: number[],
): OllamaHistoryProjection {
  const epoch = source.filter(e => e.type === 'handoff_complete').at(-1)?.seq ?? 0;
  // Unrelated events can have domain-specific positions (checkpoint guard seq),
  // so only replay inputs, execution events and cancellation define this prefix.
  const relevant = source.filter(e => historyTypes.has(e.type));
  const events = relevant.filter(e => typeof e.seq === 'number' && e.seq > epoch);
  const active = new Set(activeInputSeqs);
  // Retain readable legacy history when identity cannot be established. Current
  // identified input is still supplied through the normal prompt exactly once.
  const dispatched = new Set(events.flatMap(e => e.type === 'primary_turn_started' && e.ollamaExecutionId ? e.ollamaInputSeqs ?? [] : []));
  const fallback = (reason: string): OllamaHistoryProjection => ({ valid: false, reason, epoch,
    events: events.filter(e => e.type !== 'user_message_echo' || !active.has(e.seq!)
      && (!e.ollamaReplayInput || dispatched.has(e.seq!))), cuts: [] });
  let previous = 0;
  for (const e of relevant) {
    if (!Number.isSafeInteger(e.seq) || e.seq! <= previous || ('workflowId' in e && e.workflowId !== workflowId)) return fallback('invalid source event identity');
    previous = e.seq!;
  }
  const echoes = new Map(events.filter(e => e.type === 'user_message_echo').map(e => [e.seq!, e]));
  if (!activeInputSeqs.length || active.size !== activeInputSeqs.length || activeInputSeqs.some(seq => !echoes.has(seq))) return fallback('current input is not identifiable');
  const executions = new Map<string, Execution>();
  const consumed = new Map<number, Execution>();
  const cancelled = new Map<number, number>();
  const clientIds = new Map<string, number[]>();
  for (const e of echoes.values()) if (e.type === 'user_message_echo' && e.clientMessageId) {
    clientIds.set(e.clientMessageId, [...(clientIds.get(e.clientMessageId) ?? []), e.seq!]);
  }
  for (const e of events) {
    if (e.type === 'queued_message_cancelled') {
      const matches = clientIds.get(e.clientMessageId) ?? [];
      if (matches.length !== 1) return fallback('cancelled input is not identifiable');
      cancelled.set(matches[0], e.seq!);
    }
    if (e.type === 'primary_turn_started') {
      const id = e.ollamaExecutionId, inputs = e.ollamaInputSeqs;
      if (!id || !inputs?.length || executions.has(id) || new Set(inputs).size !== inputs.length
        || inputs.some(seq => !echoes.has(seq) || seq >= e.seq! || consumed.has(seq) || cancelled.has(seq))) return fallback('execution input mapping is missing or conflicting');
      const turn: Execution = { id, start: e.seq!, inputs: [...inputs], events: [] };
      executions.set(id, turn);
      for (const seq of inputs) consumed.set(seq, turn);
    } else if (outputTypes.has(e.type) || e.type === 'primary_complete' || e.type === 'primary_turn_ended') {
      const turn = e.ollamaExecutionId ? executions.get(e.ollamaExecutionId) : undefined;
      if (!turn || turn.ended || turn.complete && e.type !== 'primary_turn_ended') return fallback('output or outcome has no matching active execution');
      if (e.type === 'primary_complete') turn.complete = e.seq!;
      else if (e.type === 'primary_turn_ended') turn.ended = e.seq!;
      else turn.events.push(e);
    }
  }
  // An untagged legacy echo may have executed. Guessing would omit history.
  if ([...echoes.values()].some(e => !e.ollamaReplayInput)) return fallback('legacy input has no execution mapping');
  const replay = (through: number): OllamaHistoryEvent[] => {
    const out: OllamaHistoryEvent[] = [];
    for (const turn of executions.values()) {
      if (turn.start > through || turn.inputs.some(seq => active.has(seq))) continue;
      const first = echoes.get(turn.inputs[0])!;
      out.push({ ...first, content: turn.inputs.map(seq => (echoes.get(seq) as Extract<ServerMessage, {type:'user_message_echo'}>).content).join('\n\n') } as OllamaHistoryEvent);
      out.push(...turn.events.filter(e => e.seq! <= through));
      if (turn.complete && turn.complete <= through) out.push({ type: 'primary_complete', workflowId, phase: 'passthrough', costUsd: 0, durationMs: 0 } as OllamaHistoryEvent);
    }
    return out;
  };
  const completeBySeq = new Map([...executions.values()].filter(t => t.complete).map(t => [t.complete!, t]));
  const cuts: OllamaHistoryCut[] = [];
  const hash = createHash('sha256').update('[');
  let requiredThrough = 0;
  let first = true;
  for (const event of events) {
    hash.update((first ? '' : ',') + JSON.stringify(event)); first = false;
    if (event.type === 'user_message_echo') {
      const turn = consumed.get(event.seq!);
      const required = active.has(event.seq!) || turn?.inputs.some(seq => cancelled.has(seq))
        ? Infinity : turn?.complete ?? cancelled.get(event.seq!) ?? Infinity;
      requiredThrough = Math.max(requiredThrough, required);
    }
    if (!completeBySeq.has(event.seq!) || requiredThrough > event.seq!) continue;
    const cut = event.seq!;
    // Materialize only selected prefixes. Long logs must not allocate one
    // transcript copy for every completed execution on every turn.
    cuts.push({ throughSeq: cut, digest: hash.copy().update(']').digest('hex'), get events() { return replay(cut); } });
  }
  return { valid: true, epoch, events: replay(Infinity), cuts };
}

export function stampOllamaExecution(message: ServerMessage, id: string, inputSeqs: number[]): ServerMessage {
  if (message.type === 'primary_turn_started') return { ...message, ollamaExecutionId: id, ollamaInputSeqs: [...inputSeqs] };
  if (outputTypes.has(message.type) || message.type === 'primary_complete' || message.type === 'primary_turn_ended') return { ...message, ollamaExecutionId: id } as ServerMessage;
  return message;
}
