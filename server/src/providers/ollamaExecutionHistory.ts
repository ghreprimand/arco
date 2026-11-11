import { confirmedInputDeliveries, projectDeliveredInputs } from '../inputDeliveryHistory.js';
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
  delivered: number[];
  confirmations: number[];
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
const historyTypes = new Set([...outputTypes, 'user_message_echo', 'primary_turn_started', 'primary_complete', 'primary_turn_ended', 'queued_message_cancelled', 'turn_messages_delivered', 'queued_messages_drained']);

export function projectOllamaHistory(
  source: OllamaHistoryEvent[], workflowId: string, activeInputSeqs: number[], includeFileContext = false,
): OllamaHistoryProjection {
  const epoch = source.filter(e => e.type === 'handoff_complete').at(-1)?.seq ?? 0;
  // Unrelated events can have domain-specific positions (checkpoint guard seq),
  // so only replay inputs, execution events and cancellation define this prefix.
  const relevant = source.filter(e => (historyTypes.has(e.type) || includeFileContext && e.type === 'file_context') && (e.type !== 'queued_messages_drained' || !!e.deliveryId));
  const events = relevant.filter(e => typeof e.seq === 'number' && e.seq > epoch);
  const active = new Set(activeInputSeqs);
  const deliveries = confirmedInputDeliveries(events);
  // Retain readable legacy history when identity cannot be established. Current
  // identified input is still supplied through the normal prompt exactly once.
  const dispatched = new Set(events.flatMap(e => e.type === 'primary_turn_started' && e.ollamaExecutionId ? e.ollamaInputSeqs ?? [] : []));
  for (const delivery of deliveries.values()) for (const input of delivery.inputs) if (typeof input.seq === 'number') dispatched.add(input.seq);
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
  let activeExecution: Execution | undefined;
  const inputOwners = new Map<number, Execution>();
  const fileOwners = new Map<number, Execution>();
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
      const turn: Execution = { id, start: e.seq!, inputs: [...inputs], delivered: [], confirmations: [] };
      activeExecution = turn; inputOwners.set(e.seq!, turn);
      executions.set(id, turn);
      for (const seq of inputs) consumed.set(seq, turn);
    } else if (outputTypes.has(e.type) || e.type === 'primary_complete' || e.type === 'primary_turn_ended') {
      const turn = e.ollamaExecutionId ? executions.get(e.ollamaExecutionId) : undefined;
      if (!turn || turn.ended || turn.complete && e.type !== 'primary_turn_ended') return fallback('output or outcome has no matching active execution');
      if (e.type === 'primary_complete') turn.complete = e.seq!;
      else if (e.type === 'primary_turn_ended') turn.ended = e.seq!;
      if (e.type === 'primary_turn_ended' && activeExecution === turn) activeExecution = undefined;
    }
    if (e.type === 'file_context' && activeExecution && !activeExecution.complete) fileOwners.set(e.seq!, activeExecution);
    const delivery = deliveries.get(e);
    if (delivery) {
      const inputs = delivery.inputs.flatMap(input => typeof input.seq === 'number' && !consumed.has(input.seq) ? [input.seq] : []);
      if (!inputs.length) continue;
      if (!activeExecution || activeExecution.complete || activeExecution.ended || inputs.some(seq => !echoes.has(seq) || seq >= e.seq! || cancelled.has(seq))) return fallback('steering has no matching active execution');
      activeExecution.delivered.push(...inputs); inputOwners.set(e.seq!, activeExecution);
      if (delivery.confirmedSeq !== undefined) activeExecution.confirmations.push(delivery.confirmedSeq);
      for (const seq of inputs) consumed.set(seq, activeExecution);
    }
  }
  if ([...executions.values()].some(turn => turn.complete && turn.confirmations.some(seq => seq > turn.complete!))) return fallback('steering confirmation is outside its completed prefix');
  // An untagged legacy echo may have executed. Guessing would omit history.
  if ([...echoes.values()].some(e => !e.ollamaReplayInput)) return fallback('legacy input has no execution mapping');
  const projected = projectDeliveredInputs(events);
  const replay = (through: number): OllamaHistoryEvent[] => {
    const allowed = new Set([...executions.values()].filter(turn => turn.start <= through && ![...turn.inputs, ...turn.delivered].some(seq => active.has(seq))));
    const out: OllamaHistoryEvent[] = [];
    for (const event of projected) {
      if (typeof event.seq === 'number' && event.seq > through) continue;
      if (event.type === 'user_message_echo') {
        const owner = inputOwners.get(event.seq!);
        if (owner && allowed.has(owner)) out.push({ ...event, deliveryTracked: false, ollamaReplayInput: false });
      } else if (event.type === 'file_context') {
        const owner = fileOwners.get(event.seq!);
        if (owner && allowed.has(owner)) out.push(event);
      } else if (outputTypes.has(event.type) || event.type === 'primary_complete') {
        const owner = event.ollamaExecutionId ? executions.get(event.ollamaExecutionId) : undefined;
        if (owner && allowed.has(owner)) out.push(event);
      }
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
      const required = active.has(event.seq!) || turn && [...turn.inputs, ...turn.delivered].some(seq => cancelled.has(seq))
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
