import type { ServerMessage } from '@arco/shared';

export interface ComputerHistoryMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: Record<string, unknown> } }>;
  tool_call_id?: string;
}
// Local APIs are stateless. Replaying only "Done." drops the actions that
// earned it and teaches smaller models to claim success without calling tools.
export function renderComputerHistory(events: ServerMessage[]): string {
  const messages: ComputerHistoryMessage[] = [];
  const completed = new Set<string>();
  let text = '';
  const flush = () => { if (text.trim()) messages.push({ role: 'assistant', content: text.trim() }); text = ''; };
  for (const event of events) {
    if (event.type === 'user_message_echo') { flush(); messages.push({ role: 'user', content: event.content }); }
    else if (event.type === 'primary_text' && event.phase === 'passthrough') text += event.text;
    else if (event.type === 'primary_complete') flush();
    else if (event.type === 'primary_tool_use' && (event.status === 'completed' || event.status === 'failed')) {
      const id = event.toolUseId ?? `history-${messages.length}`;
      if (completed.has(id)) continue;
      let args: Record<string, unknown>;
      try { args = JSON.parse(event.input); } catch { continue; }
      completed.add(id);
      messages.push({ role: 'assistant', content: text, tool_calls: [{ id, type: 'function', function: { name: event.tool, arguments: args } }] });
      text = '';
      messages.push({ role: 'tool', tool_call_id: id, content: event.output ?? `[${event.status}]` });
    }
  }
  flush();
  return JSON.stringify({ arcoComputerHistory: 1, messages });
}
export function parseComputerHistory(text: string): ComputerHistoryMessage[] {
  const value = JSON.parse(text);
  if (value?.arcoComputerHistory !== 1 || !Array.isArray(value.messages)) throw Error('Invalid Computer history envelope.');
  return value.messages;
}
