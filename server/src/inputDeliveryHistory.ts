interface InputEvent {
  type?: string;
  content?: unknown;
  seq?: number;
  clientMessageId?: string;
  clientMessageIds?: readonly string[];
  inputClientMessageIds?: readonly string[];
  ollamaInputSeqs?: readonly number[];
  deliveryTracked?: boolean;
  ollamaReplayInput?: boolean;
  kind?: string;
  deliveryId?: string;
}

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const numbers = (value: unknown): number[] => Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number' && Number.isSafeInteger(item)) : [];

function references(event: InputEvent): { ids: readonly string[]; seqs: readonly number[] } {
  if (event.type === 'primary_turn_started') return { ids: strings(event.inputClientMessageIds), seqs: numbers(event.ollamaInputSeqs) };
  if (event.type === 'turn_messages_delivered') return { ids: strings(event.clientMessageIds), seqs: [] };
  return { ids: [], seqs: [] };
}

// Preserve the prefix input and delivery records referenced by an exact tail.
export function referencedInputRecords<T extends InputEvent>(events: readonly T[], source: readonly T[]): T[] {
  const ids = new Set<string>(), seqs = new Set<number>(), deliveries = new Set<string>();
  for (const event of events) { if (event.type === 'turn_messages_delivered' && event.deliveryId) deliveries.add(event.deliveryId); const refs = references(event); refs.ids.forEach(id => ids.add(id)); refs.seqs.forEach(seq => seqs.add(seq)); }
  return source.filter(event => event.type === 'user_message_echo'
    ? (event.clientMessageId !== undefined && ids.has(event.clientMessageId)) || (event.seq !== undefined && seqs.has(event.seq))
    : event.type === 'queued_messages_drained' && event.deliveryId !== undefined && deliveries.has(event.deliveryId));
}

// Correlate acknowledgements with the exact drain attempt. An acknowledgement
// may arrive after completion or after a retry; it does not move the input to
// whichever execution happens to be active when the reply reaches Arco.
export function confirmedInputDeliveries<T extends InputEvent>(source: readonly T[]): Map<T, { inputs: T[]; confirmedSeq?: number }> {
  const byId = new Map(source.filter(event => event.type === 'user_message_echo' && typeof event.clientMessageId === 'string').map(event => [event.clientMessageId!, event]));
  const anchors = new Map(source.filter(event => event.type === 'queued_messages_drained' && typeof event.deliveryId === 'string').map(event => [event.deliveryId!, event]));
  const confirmed = new Map<string, { ids: Set<string>; seq?: number }>();
  for (const event of source) if (event.type === 'turn_messages_delivered' && typeof event.deliveryId === 'string') {
    const status = confirmed.get(event.deliveryId) ?? { ids: new Set<string>() };
    strings(event.clientMessageIds).forEach(id => status.ids.add(id));
    if (typeof event.seq === 'number') status.seq = Math.max(status.seq ?? 0, event.seq);
    confirmed.set(event.deliveryId, status);
  }
  const result = new Map<T, { inputs: T[]; confirmedSeq?: number }>();
  for (const event of source) {
    let ids: string[] = [], confirmedSeq: number | undefined;
    if (event.type === 'queued_messages_drained' && typeof event.deliveryId === 'string' && confirmed.has(event.deliveryId)) {
      const status = confirmed.get(event.deliveryId)!; ids = strings(event.clientMessageIds).filter(id => status.ids.has(id)); confirmedSeq = status.seq;
    } else if (event.type === 'turn_messages_delivered' && (typeof event.deliveryId !== 'string' || !anchors.has(event.deliveryId))) {
      ids = strings(event.clientMessageIds); confirmedSeq = event.seq;
    }
    const inputs = ids.flatMap(id => {
      const input = byId.get(id);
      return input && typeof input.content === 'string' && !(typeof input.seq === 'number' && typeof event.seq === 'number' && input.seq > event.seq) ? [input] : [];
    });
    if (inputs.length) result.set(event, { inputs, confirmedSeq });
  }
  return result;
}

// Echoes retain their original position in the audit/UI log. Model and review
// readers place tracked input at actual dispatch, combining a queued batch in
// the same order as the provider prompt. Legacy follow-ups use turn boundaries.
export function projectDeliveredInputs<T extends InputEvent>(events: readonly T[], source: readonly T[] = events, maxSeq?: number): T[] {
  const scoped = events.filter(event => typeof maxSeq !== 'number' || typeof event.seq !== 'number' || event.seq <= maxSeq);
  const byId = new Map<string, T>(), bySeq = new Map<number, T>();
  const referencedIds = new Set<string>(), referencedSeqs = new Set<number>();
  for (const event of source) {
    if (event.type === 'user_message_echo') { if (event.clientMessageId) byId.set(event.clientMessageId, event); if (event.seq !== undefined) bySeq.set(event.seq, event); }
    const refs = references(event); refs.ids.forEach(id => referencedIds.add(id)); refs.seqs.forEach(seq => referencedSeqs.add(seq));
  }
  const deliveries = confirmedInputDeliveries(source);
  const hasStarts = scoped.some(event => event.type === 'primary_turn_started');
  const cancelled = new Set<string>(), delivered = new Set<string>();
  let pending: T[] = [], afterComplete = false;
  const out: T[] = [];
  const key = (event: T) => event.clientMessageId ?? (event.seq !== undefined ? 'seq:' + event.seq : undefined);
  const emit = (inputs: T[], boundary: T, steer: boolean): void => {
    const unique: T[] = [], seen = new Set<T>();
    for (const input of inputs) {
      if (seen.has(input) || typeof input.content !== 'string') continue;
      seen.add(input);
      if (input.clientMessageId && cancelled.has(input.clientMessageId)) continue;
      if (typeof input.seq === 'number' && typeof boundary.seq === 'number' && input.seq > boundary.seq) continue;
      const id = key(input); if (steer && id && delivered.has(id)) continue;
      unique.push(input); if (id) delivered.add(id);
    }
    if (!unique.length) return;
    const ids = new Set(unique.map(key)); pending = pending.filter(input => !ids.has(key(input)));
    out.push({ ...unique[0], content: unique.map(input => input.content).join('\n\n'), kind: steer ? 'steer' : undefined,
      deliveryTracked: false, ...(boundary.seq !== undefined ? { seq: boundary.seq } : {}) } as T);
  };
  for (const event of scoped) {
    if (event.type === 'queued_message_cancelled' && event.clientMessageId) {
      cancelled.add(event.clientMessageId); pending = pending.filter(input => input.clientMessageId !== event.clientMessageId);
    }
    if (event.type === 'user_message_echo') {
      const tracked = event.deliveryTracked || event.ollamaReplayInput
        || (event.clientMessageId !== undefined && referencedIds.has(event.clientMessageId))
        || (event.seq !== undefined && referencedSeqs.has(event.seq));
      if (tracked) continue;
      if (event.kind === 'follow-up' || event.kind === 'interrupt') { pending.push(event); continue; }
    }
    if (event.type === 'primary_turn_started') {
      const refs = references(event);
      const inputs = refs.ids.length ? refs.ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []) : refs.seqs.flatMap(seq => bySeq.has(seq) ? [bySeq.get(seq)!] : []);
      if (inputs.length) emit(inputs, event, false);
      else if (afterComplete && pending.length) emit([...pending], event, false);
      afterComplete = false;
    } else if (deliveries.has(event)) {
      emit(deliveries.get(event)!.inputs, event, true);
    } else if (!hasStarts && afterComplete && pending.length && ['primary_text', 'primary_thinking', 'primary_tool_use'].includes(event.type ?? '')) {
      emit([...pending], event, false); afterComplete = false;
    }
    out.push(event);
    if (event.type === 'primary_complete' || event.type === 'primary_turn_ended') afterComplete = true;
  }
  return out;
}
