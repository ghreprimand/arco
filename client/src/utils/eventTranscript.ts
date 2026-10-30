import type { ChatMessage } from '@arco/shared';
import type { JobState } from '../stores/appStore.types';

// Session JSONL and workflow events describe the same text with different
// boundaries. Event segments own causal placement; remove only their matched
// text from the JSONL overlay, retaining tools and unmatched historical text.
const CHAR_CAP = 512 * 1024;
function normalized(text: string): { text: string; offsets: number[] } {
  let result = '';
  const offsets: number[] = [];
  for (let i = 0; i < text.length && result.length < CHAR_CAP; i++) {
    if (/\s/.test(text[i])) continue;
    const c = text[i];
    result += c;
    offsets.push(i);
  }
  offsets.push(text.length);
  return { text: result, offsets };
}

type Cuts = Map<string, Array<[number, number]>>;
type Match = { session: ChatMessage[]; rows: ChatMessage[]; next?: number; cuts: Cuts; tools: Map<string, number> };
// Immutable store rows let completed turns reuse their source alignment while
// the active segment streams. Weak keys release trimmed history automatically.
const matches = new WeakMap<ChatMessage, Match>();
function mergeCuts(target: Cuts, cuts: Cuts): void {
  for (const [id, ranges] of cuts) target.set(id, [...(target.get(id) ?? []), ...ranges]);
}

export function reconcileEventTranscript(job: Pick<JobState, 'messages' | 'sessionChat' | 'activity'>): { sessionChat: ChatMessage[]; canonicalIds: Set<string> } {
  const session = Array.isArray(job.sessionChat) ? job.sessionChat : [];
  const canonicalIds = new Set<string>();
  const groups = new Map<string, ChatMessage[]>();
  for (const m of job.messages) {
    if (m.role !== 'assistant' || m.toolUse || !m.parentTurnId || m.eventSeq === undefined) continue;
    canonicalIds.add(m.id);
    const group = groups.get(m.parentTurnId) ?? [];
    group.push(m); groups.set(m.parentTurnId, group);
  }
  if (!groups.size || !session.length) return { sessionChat: session, canonicalIds };
  const removed = new Map<string, Array<[number, number]>>();
  const toolAnchors = new Map<string, number>();
  for (const a of job.activity ?? []) {
    if (a.toolUseId && a.eventSeq !== undefined && !toolAnchors.has(a.toolUseId)) toolAnchors.set(a.toolUseId, a.eventSeq);
  }
  const ordered = [...groups.values()].map(g => g.sort((a,b) => a.eventSeq! - b.eventSeq!)).sort((a,b) => a[0].eventSeq! - b[0].eventSeq!);
  for (let gi = 0; gi < ordered.length; gi++) {
    const group = ordered[gi];
    // Phases are separate streams. JSONL assistant text is passthrough output.
    const rows = group.filter(m => !m.phase || m.phase === 'passthrough');
    if (!rows.length) continue;
    const next = ordered[gi+1]?.[0].turnStartedAt;
    const cached = matches.get(group[0]);
    if (cached?.session === session && cached.next === next && cached.rows.length === rows.length && rows.every((row,i) => row === cached.rows[i])) {
      mergeCuts(removed,cached.cuts);
      for (const [id,seq] of cached.tools) if (!toolAnchors.has(id)) toolAnchors.set(id,seq);
      continue;
    }
    const groupCuts: Cuts = new Map();
    const groupTools = new Map<string, number>();
    const raw = rows.map(m => m.content).join('');
    if (!raw.length || raw.length > CHAR_CAP) continue;
    const body = normalized(raw).text;
    const start = rows[0]?.turnStartedAt;
    if (start === undefined) continue;
    let flat = '';
    const ranges: Array<{ row: ChatMessage; start: number; end: number }> = [];
    for (const m of session) {
      if (m.role !== 'assistant' || m.toolUse || (start !== undefined && m.timestamp < start) || (next !== undefined && next !== start && m.timestamp >= next)) continue;
      if (flat.length + m.content.length > CHAR_CAP) break;
      ranges.push({ row: m, start: flat.length, end: flat.length + m.content.length });
      flat += m.content;
    }
    const source = normalized(flat);
    if (!source.text.length) continue;
    // Prefer the full match. While the JSONL watcher catches up, a prefix
    // match covers only the bytes it has actually materialized.
    let found = source.text.indexOf(body);
    if (found < 0) found = source.text.indexOf(body.slice(0, Math.min(32, body.length)));
    if (found < 0) {
      // A short session prefix may be the only JSONL row available so far.
      if (body.startsWith(source.text)) found = 0;
      else continue;
    }
    let length = 0;
    while (length < body.length && found + length < source.text.length && body[length] === source.text[found + length]) length++;
    if (!length) continue;
    const from = found === 0 ? 0 : source.offsets[found];
    const to = found + length === source.text.length ? flat.length : source.offsets[found + length - 1] + 1;
    for (const r of ranges) {
      const lo = Math.max(from, r.start), hi = Math.min(to, r.end);
      if (lo >= hi) continue;
      const cuts = groupCuts.get(r.row.id) ?? [];
      cuts.push([lo-r.start, hi-r.start]); groupCuts.set(r.row.id, cuts);
    }
    // Legacy session-only tools have no event anchor. Retain their position
    // between matched text blocks; current tool events provide the exact seq.
    const rangesByRow = new Map(ranges.map(r => [r.row,r]));
    let rawOffset = 0;
    for (const m of session) {
      const range = rangesByRow.get(m);
      if (range) rawOffset = range.end;
      if (!m.toolUse || m.timestamp < start || (next !== undefined && next !== start && m.timestamp >= next) || toolAnchors.has(m.toolUse.toolUseId) || rawOffset < from || rawOffset > to) continue;
      let offset = 0;
      for (const row of rows) {
        offset += row.content.length;
        if (offset >= rawOffset - from) { groupTools.set(m.toolUse.toolUseId, row.eventEndSeq ?? row.eventSeq!); break; }
      }
    }
    mergeCuts(removed,groupCuts);
    for (const [id,seq] of groupTools) if (!toolAnchors.has(id)) toolAnchors.set(id,seq);
    matches.set(group[0],{ session,rows,next,cuts:groupCuts,tools:groupTools });
  }
  const sessionChat = session.flatMap(m => {
    if (m.toolUse) {
      const seq = toolAnchors.get(m.toolUse.toolUseId);
      return [seq === undefined ? m : { ...m, eventSeq: seq }];
    }
    const cuts = removed.get(m.id);
    if (!cuts) return [m];
    let at = 0;
    const pieces: ChatMessage[] = [];
    for (const [lo, hi] of cuts.sort((a,b) => a[0]-b[0])) {
      if (lo > at) pieces.push({ ...m, id: `${m.id}::unmatched-${at}`, content: m.content.slice(at,lo) });
      at = Math.max(at, hi);
    }
    if (at < m.content.length) pieces.push({ ...m, id: `${m.id}::unmatched-${at}`, content: m.content.slice(at) });
    return pieces;
  });
  return { sessionChat, canonicalIds };
}

export function orderConversation(messages: ChatMessage[]): ChatMessage[] {
  const sequenced = messages.filter(m => Number.isFinite(m.eventSeq)).sort((a,b) => a.eventSeq! - b.eventSeq! || Number(!!a.toolUse) - Number(!!b.toolUse));
  let time = -Infinity;
  const positions = new Map<ChatMessage, { time: number; index: number }>();
  sequenced.forEach((m,index) => {
    const anchor = m.role.startsWith('peer-') ? m.turnStartedAt ?? m.timestamp : m.timestamp;
    time = Math.max(time, anchor ?? 0);
    positions.set(m,{ time,index });
  });
  return [...messages].sort((a,b) => {
    const pa = positions.get(a), pb = positions.get(b);
    if (pa && pb) return pa.index - pb.index;
    return (pa?.time ?? a.timestamp ?? 0) - (pb?.time ?? b.timestamp ?? 0);
  });
}
