// Pure helpers for the cluster tab's single typing surface: where the
// director sits, which member is focused on open, and when the director's
// card shows a quiet NEW REPLY mark. Display only; nothing here sends.
import { isClusterDirector } from '@arco/shared';
import type { ChatMessage } from '@arco/shared';

interface MemberLike { workflowId: string; role?: string }

export function findDirector<T extends MemberLike>(members: readonly T[]): T | undefined {
  return members.find((m) => isClusterDirector(m.role));
}

/** Director first, others keep their order; unchanged once the operator has reordered. */
export function orderMembers<T extends MemberLike>(members: readonly T[], operatorReordered: boolean): T[] {
  const director = findDirector(members);
  if (operatorReordered || !director || members[0] === director) return [...members];
  return [director, ...members.filter((m) => m !== director)];
}

/** The member to focus when the tab opens: keep a still-valid focus, else the director, else the first. */
export function initialFocus(members: readonly MemberLike[], focusedId: string | undefined): string | undefined {
  if (members.length === 0) return undefined;
  if (focusedId && members.some((m) => m.workflowId === focusedId)) return focusedId;
  return (findDirector(members) ?? members[0]).workflowId;
}

/** Id of the director's latest finished reply, or null when there is none. */
export function latestReplyId(messages: readonly ChatMessage[] | undefined): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && !m.toolUse && !m.isStreaming && m.content && m.content.trim()) return m.id;
  }
  return null;
}

/** NEW REPLY shows while the director is not focused and its latest reply was not seen. */
export function hasNewReply(latestId: string | null, seenId: string | null | undefined, directorFocused: boolean): boolean {
  return !directorFocused && latestId !== null && latestId !== seenId;
}
