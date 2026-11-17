import type { ProviderName } from '@arco/shared';
import type { WorkflowState } from './workflows/types.js';
import { resolveClaudeTransport } from './claudeTransport.js';
import { readMeta, persistInitialMeta, reconcileLatestCliSession, workflowMetaSeed, updateMeta } from './workflowMeta.js';
import { scanEventsOfTypes } from './workflowStore.js';
import { broadcastWorkflow, broadcastTransient } from './server/broadcast.js';

const historyLoadNotices = new WeakMap<object, Set<string>>();
export function reportHistoryLoadFailure(workflowId: string, owner: object, provider: 'native' | 'cli', emit?: (content: string) => void, nativeLimitBytes?: number): void {
  const shown = historyLoadNotices.get(owner) ?? new Set<string>();
  if (shown.has(provider)) return;
  shown.add(provider);
  historyLoadNotices.set(owner, shown);
  const content = provider === 'native'
    ? nativeLimitBytes !== undefined
      ? `Earlier context could not be rebuilt within the ${nativeLimitBytes / (1024 * 1024)} MiB reconstruction limit, so the agent continues without it. Earlier messages remain in this tab.`
      : 'Earlier context could not be rebuilt for this conversation, so the agent continues without it. Earlier messages remain in this tab.'
    : 'Earlier Claude CLI session history could not be loaded in this tab. The saved conversation is intact; new session messages will appear when the file can be read.';
  if (emit) emit(content);
  else broadcastWorkflow(workflowId, { type: 'system_notice', workflowId, content });
}

export async function hasConversationHistory(cwd: string, workflowId: string, afterSeq = 0): Promise<boolean> {
  let found = false;
  await scanEventsOfTypes(cwd, workflowId, ['primary_complete', 'primary_text'], event => { if ((('seq' in event && typeof event.seq === 'number') ? event.seq : 0) > afterSeq) found = true; });
  return found;
}

export function reportConversationSaveFailure(workflowId: string, err: unknown): void {
  console.error(`[arco] [${workflowId.slice(0, 8)}] conversation metadata save failed:`, err);
  broadcastWorkflow(workflowId, { type: 'system_notice', workflowId,
    content: 'Could not save the provider conversation metadata. A restart may lose its resume id. Check that the project folder is writable.' });
}

export async function ensureWorkflowMetadata(cwd: string, workflowId: string, wf: WorkflowState): Promise<void> {
  if (wf.config.incognito) return;
  try {
    await persistInitialMeta(cwd, workflowId, wf.config, wf.primary, { sessionId: wf.primarySessionId, pendingReading: wf.providerConversation === 'awaiting-reading' });
    const meta = await readMeta(cwd, workflowId);
    if (meta?.providerConversationPendingReading) wf.providerConversation = 'awaiting-reading';
  } catch (err) { reportConversationSaveFailure(workflowId, err); }
}

export async function providerConversationState(cwd: string, workflowId: string, wf: WorkflowState): Promise<WorkflowState['providerConversation']> {
  if (wf.config.incognito) return undefined;
  const provider = wf.primary.provider;
  const external = provider === 'codex' || provider === 'cursor'
    || (provider === 'claude' && await resolveClaudeTransport(wf, cwd) === 'cli');
  if (!external) return undefined;
  if (!wf.primarySessionId) {
    const boundary = wf.config.voiceOperator ? wf.config.computerContext?.lastResetSeq ?? 0 : 0;
    return await hasConversationHistory(cwd, workflowId, boundary) ? 'unavailable' : undefined;
  }
  return wf.providerConversation === 'awaiting-reading' ? wf.providerConversation : undefined;
}

export async function saveProviderSession(cwd: string, workflowId: string, wf: WorkflowState, provider: ProviderName, sessionId: string, providerAccountRef?: string): Promise<void> {
  if (wf.config.incognito) return;
  const seed = workflowMetaSeed(cwd, workflowId, wf.config, wf.primary);
  seed.providerConversationPendingReading = wf.providerConversation === 'awaiting-reading';
  try {
    await reconcileLatestCliSession(cwd, workflowId, provider, sessionId, providerAccountRef, seed);
  } catch (err) { reportConversationSaveFailure(workflowId, err); }
}

// Only session discovery proves that the provider actually started the new
// conversation. Reconnecting or a failed pre-dispatch attempt is not a start.
export function announceReplacementConversation(workflowId: string, wf: WorkflowState): void {
  if (wf.providerConversation !== 'unavailable') return;
  const provider = wf.primary.provider === 'codex' ? 'Codex' : wf.primary.provider === 'cursor' ? 'Cursor' : 'Claude CLI';
  wf.providerConversation = 'awaiting-reading';
  broadcastWorkflow(workflowId, { type: 'provider_conversation_state', workflowId, state: 'awaiting-reading' });
  broadcastWorkflow(workflowId, { type: 'system_notice', workflowId,
    content: `A new ${provider} conversation started because no saved thread id is available. Earlier messages remain in this tab.` });
}

export async function markConversationReading(cwd: string, workflowId: string, wf: WorkflowState): Promise<void> {
  if (wf.providerConversation !== 'awaiting-reading') return;
  wf.providerConversation = undefined;
  broadcastTransient(workflowId, { type: 'provider_conversation_state', workflowId, state: 'ready' });
  try {
    const saved = await updateMeta(cwd, workflowId, meta => { delete meta.providerConversationPendingReading; });
    if (!saved) throw new Error('Workflow metadata disappeared before the context reading was saved.');
  }
  catch (err) { reportConversationSaveFailure(workflowId, err); }
}
