import type { ChatMessage } from '@arco/shared';

// Format a chat row into a transcript line. ctx-dividers + tool pills are
// pure render noise and get dropped. System rows are filtered: pure metadata
// pills like `[TURN · 1m 49.4s]` or `[REVIEW] Running review…` are stripped
// (single-line `[TAG] short text`), but substantive system content —
// inlined review bodies, AUTH notices with detail, multi-line blocks — is
// kept so transcript-send actually carries the work product to the
// recipient. Earlier this filter was "drop ALL system rows," which silently
// stripped review bodies and left the director seeing only the reviewer's
// narration without the findings.
export interface TranscriptInclude {
  operator: boolean;
  agent: boolean;
  /** Mail received from peers. */
  mail: boolean;
  /** The shortened echo of mail this member sent. Off unless asked for. */
  sentEchoes: boolean;
}

export const DEFAULT_TRANSCRIPT_INCLUDE: TranscriptInclude = { operator: true, agent: true, mail: true, sentEchoes: false };

export function formatRow(m: ChatMessage, selfName: string, include: TranscriptInclude = { operator: true, agent: true, mail: true, sentEchoes: true }): string | null {
  if (m.role === 'ctx-divider') return null;
  if (m.toolUse) return null;
  if (m.role === 'peer-sent' && !(include.mail && include.sentEchoes)) return null;
  if (m.role === 'peer-received' && !include.mail) return null;
  if (m.role === 'user' && !include.operator) return null;
  if (m.role === 'assistant' && !include.agent) return null;
  if (m.role === 'system') {
    const trimmed = m.content.trim();
    // Skip single-line bracketed pills (metadata-only). Keep anything with a
    // newline or substantial content past the leading tag.
    const singleLinePill = /^\[[^\]]+\][^\n]*$/.test(trimmed) && trimmed.length < 200;
    if (singleLinePill) return null;
    return `[system] ${m.content}`;
  }
  if (m.role === 'peer-sent') {
    return `[peer-sent → ${m.senderDisplayName ?? '?'}] ${m.content}`;
  }
  if (m.role === 'peer-received') {
    return `[peer-received ← ${m.senderDisplayName ?? '?'}] ${m.content}`;
  }
  if (m.role === 'user') {
    return `[operator → ${selfName}]\n${m.content}`;
  }
  // assistant
  return `[${selfName}]\n${m.content}`;
}

// Find turn boundaries — each user message starts a new turn. Returns the
// index array of user-message positions in chronological order; turn N
// (1-indexed from end) covers boundaries[boundaries.length - N] through
// boundaries[boundaries.length - N + 1] - 1.
export function turnBoundaries(messages: ChatMessage[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') out.push(i);
  }
  return out;
}
