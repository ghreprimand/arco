import type { VoiceToolCallMessage, VoiceToolResultMessage } from '@arco/shared';
import { useVoiceStore } from './store';
import { useAppStore } from '../stores/appStore';
import { computerRequestActive } from './computerRequest';

// docs/VOICE.md - the browser half of the arco-voice relay. The
// server forwards a Computer-chat tool call to every observer of that chat;
// only the owning browser with hands-free enabled or an explicit typed request
// answers. Everything else ignores the call. Results are one-liners the
// model can read back to the operator.
type Handler = (call: VoiceToolCallMessage) => Promise<string>;
let handler: Handler | null = null;
let ownedChatId: string | null = null;
let textRequest: { id: string; revoke: () => void } | null = null;

// A typed operator request may use the same browser tools without opening the
// microphone. Its grant ends at settlement; opening the panel grants nothing.
export function allowComputerTextTools(id: string): () => void {
  textRequest?.revoke();
  let started = false;
  const revoke = () => { clearTimeout(timer); unsubscribe(); if (textRequest?.revoke === revoke) textRequest = null; };
  const timer = setTimeout(revoke, 10_000);
  const unsubscribe = useAppStore.subscribe((state) => {
    const job = state.jobs[id];
    if (!state.connected || !job) { revoke(); return; }
    if (computerRequestActive(job)) { started = true; clearTimeout(timer); }
    else if (started) revoke();
  });
  textRequest = { id, revoke };
  return revoke;
}

export function revokeComputerTextTools(id: string): void { if (textRequest?.id === id) textRequest.revoke(); }

export function registerVoiceToolHandler(chatId: string | null, fn: Handler | null): void {
  if (chatId !== ownedChatId || !fn) textRequest?.revoke();
  ownedChatId = chatId; handler = fn;
}

export async function dispatchVoiceToolCall(call: VoiceToolCallMessage, send: (m: VoiceToolResultMessage) => void): Promise<boolean> {
  // Mic-off calls need a separate, explicit typed request; no ambient grant.
  if (!handler || call.workflowId !== ownedChatId || (!useVoiceStore.getState().enabled && textRequest?.id !== call.workflowId)) return false;
  try {
    const result = await handler(call);
    send({ type: 'voice_tool_result', workflowId: call.workflowId, requestId: call.requestId, ok: true, result });
  } catch (e) {
    send({ type: 'voice_tool_result', workflowId: call.workflowId, requestId: call.requestId, ok: false, error: e instanceof Error ? e.message : 'The tool failed.' });
  }
  return true;
}
