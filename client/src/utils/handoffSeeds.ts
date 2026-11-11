import type { ChatMessage } from '@arco/shared';

export function isHandoffSeed(content: string): boolean {
  return content.startsWith('[HANDOFF: new session initialized for this tab.')
    || content.startsWith('[HANDOFF \u2014 new session initialized for this tab.');
}
export function isSpawnSeed(content: string): boolean {
  return content.includes('\n\n---\n\nNew direction: ')
    || content.includes('\n\n---\n\nRead the handoff above. Acknowledge with "READY"');
}
export function latestHandoffSeed(messages: ChatMessage[]): ChatMessage | undefined {
  return messages.findLast(m => m.role === 'user' && (isHandoffSeed(m.content) || isSpawnSeed(m.content)));
}
