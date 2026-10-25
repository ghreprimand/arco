// VOICE_AGENT_PLAN.md — server-side relay for the arco-voice MCP child.
// The server never executes a voice tool: it forwards the call to the browser
// that owns the hands-free session (a subscriber of the Computer chat) and
// hands the browser's answer back to the MCP child. Pending calls are
// process-local; a browser that disappears times out the call.
import { randomUUID } from 'node:crypto';
import { VOICE_TOOL_TIMEOUT_MS, isVoiceOperatorTool, voiceText, type VoiceOperatorTool, type VoiceToolCallMessage, type VoiceToolResultMessage } from '@arco/shared';

type Publish = (workflowId: string, message: VoiceToolCallMessage) => number;
let publish: Publish | null = null;
export function setVoiceToolPublisher(fn: Publish): void { publish = fn; }

interface Pending { workflowId: string; tool: VoiceOperatorTool; resolve: (r: { ok: boolean; result?: string; error?: string }) => void; timer: ReturnType<typeof setTimeout> }
const pending = new Map<string, Pending>();
type ToolActivity = { tool: VoiceOperatorTool; phase: 'requested' | 'answered' };
const observers = new Map<string, Set<(event: ToolActivity) => void>>();
const blocked = new Set<string>();
export function observeVoiceTools(id: string, fn: (event: ToolActivity) => void): () => void {
  const listeners = observers.get(id) ?? new Set(); observers.set(id, listeners); listeners.add(fn);
  return () => { listeners.delete(fn); if (!listeners.size) observers.delete(id); };
}
function activity(id: string, event: ToolActivity): void { for (const fn of observers.get(id) ?? []) fn(event); }
export function allowVoiceTools(id: string): void { blocked.delete(id); }
export function blockVoiceTools(id: string): void {
  blocked.add(id);
  for (const [key, entry] of pending) if (entry.workflowId === id) {
    clearTimeout(entry.timer); pending.delete(key);
    entry.resolve({ ok: false, error: 'Computer request stopped. Its tool connection is being replaced; no action was retried.' });
  }
}

export function voiceToolCallsPending(workflowId: string): number {
  return [...pending.values()].filter((p) => p.workflowId === workflowId).length;
}

const backgroundClaims = new Map<string, number>();
export function setComputerBackgroundClaim(id: string, token: number) { backgroundClaims.set(id, token); }
export function clearComputerBackgroundClaim(id: string, token: number) { if (backgroundClaims.get(id) === token) backgroundClaims.delete(id); }
export function isComputerBackgroundClaim(id: string) { return backgroundClaims.has(id); }

export async function requestVoiceTool(workflowId: string, tool: unknown, args: unknown): Promise<{ ok: boolean; result?: string; error?: string }> {
  if (backgroundClaims.has(workflowId)) return { ok: false, error: 'Background activity updates cannot use operator tools. Record the provided facts and reply Done.' };
  if (blocked.has(workflowId)) return { ok: false, error: 'Computer request stopped. Wait for a new request before using tools.' };
  if (!isVoiceOperatorTool(tool)) return { ok: false, error: 'Unknown voice tool.' };
  const record = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    if (typeof v !== 'string' || k.length > 32 || v.length > 8000) return { ok: false, error: 'Invalid tool arguments.' };
    clean[k] = v;
  }
  if (!publish) return { ok: false, error: 'Voice tools are not wired.' };
  if (voiceToolCallsPending(workflowId) >= 4) return { ok: false, error: 'Too many pending voice tool calls.' };
  const requestId = randomUUID();
  const message: VoiceToolCallMessage = { type: 'voice_tool_call', workflowId, requestId, tool: tool as VoiceOperatorTool, args: clean };
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(requestId); resolve({ ok: false, error: 'No hands-free window answered in time.' }); }, VOICE_TOOL_TIMEOUT_MS);
    timer.unref?.();
    pending.set(requestId, { workflowId, tool: tool as VoiceOperatorTool, resolve, timer });
    activity(workflowId, { tool: tool as VoiceOperatorTool, phase: 'requested' });
    const delivered = publish!(workflowId, message);
    if (delivered === 0) { clearTimeout(timer); pending.delete(requestId); resolve({ ok: false, error: 'No window is subscribed to the Computer chat.' }); }
  });
}

export function resolveVoiceTool(message: VoiceToolResultMessage): boolean {
  const entry = pending.get(message.requestId);
  if (!entry || entry.workflowId !== message.workflowId) return false;
  clearTimeout(entry.timer); pending.delete(message.requestId);
  // The observer needs progress, never the operator's arguments or result text.
  activity(entry.workflowId, { tool: entry.tool, phase: 'answered' });
  entry.resolve(message.ok ? { ok: true, result: typeof message.result === 'string' ? voiceText(message.result, 16_000) : '' }
    : { ok: false, error: typeof message.error === 'string' ? voiceText(message.error, 2000) : 'The window could not run that tool.' });
  return true;
}
