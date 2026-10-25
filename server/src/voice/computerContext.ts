import { computerProjectionChanged } from './activityBus.js';
import { clearPrivateWatches } from './watches.js';
import type { WebSocket } from 'ws';
import { computerResetPercent, type ComputerContextState, type ComputerContextControlMessage } from '@arco/shared';
import { withFileLock } from '../atomicFile.js';
import { readMeta, updateMeta } from '../workflowMeta.js';
import { scanEventsOfTypes, replayEventsWithTs } from '../workflowStore.js';
import { workflows } from '../server/state.js';
import { broadcastWorkflow, broadcastTransient, send } from '../server/broadcast.js';
import { releaseCodexAppServerWorker } from '../providers/codex-appserver/index.js';
import { disposeClaudeNativeWorker } from '../providers/claude-native/index.js';
import { claimBusy, releaseBusy, drainQueueIfIdle } from '../ws/turnEngine.js';
import type { WorkflowState } from '../workflows/types.js';

export const isComputer = (wf: WorkflowState): boolean => wf.config.kind === 'chat'
  && wf.config.voiceOperator === true && ['codex', 'claude', 'ollama', 'strata'].includes(wf.primary.provider);

export async function computerContextState(workflowId: string, wf: WorkflowState): Promise<ComputerContextState> {
  if (wf.config.incognito) return wf.config.computerContext ??= { keepContext: false, resets: 0 };
  const meta = await readMeta(wf.config.workingDirectory, workflowId);
  wf.config.computerContext = meta?.computerContext ?? wf.config.computerContext ?? {
    keepContext: false, resets: 0,
  };
  return wf.config.computerContext!;
}

// The turn engine calls this AFTER its entire follow-up queue has settled.
// A threshold is a deterministic trigger, never a model completion verdict.
export async function maybeFreshComputerContext(workflowId: string, allowAutomatic = true): Promise<void> {
  const wf = workflows.get(workflowId);
  if (!wf || !isComputer(wf)) return;
  await withFileLock(`computer-context:${workflowId}`, async () => {
    const state = await computerContextState(workflowId, wf);
    if (workflows.get(workflowId) !== wf || wf.busy || wf.computerResetting
        || wf.queue.steering.length || wf.queue.followUp.length) return;
    const threshold = state.resetAtPercent === undefined ? computerResetPercent(wf.primary.provider) : state.resetAtPercent;
    const due = allowAutomatic && !state.keepContext && threshold !== null
      && (wf.lastContextUsage?.percent ?? wf.lastContextPercent) >= threshold;
    if (!state.pendingFresh && !due) return;

    const previousSessionId = wf.primarySessionId;
    const used = wf.lastContextUsage;
    const reason = state.pendingFresh ? state.pendingFreshReason ?? 'operator' : 'threshold';
    const boundaryAt = Date.now();
    // STOP may release busy during a disk write. This separate flag keeps a
    // new prompt queued until the durable session boundary is installed.
    wf.computerResetting = true;
    const token = claimBusy(wf);
    broadcastTransient(workflowId, { type: 'primary_turn_started', workflowId, startedAt: Date.now() });
    try {
      await releaseCodexAppServerWorker(workflowId);
      disposeClaudeNativeWorker(workflowId);
      const turns = wf.config.incognito ? [] : await scanEventsOfTypes(wf.config.workingDirectory, workflowId, ['user_message_echo']);
      const turnCount = turns.filter((event) => event.type === 'user_message_echo'
        && event.timestamp >= (state.lastResetAt ?? 0) && event.timestamp < boundaryAt).length;
      const tail = wf.config.incognito ? undefined : (await replayEventsWithTs(wf.config.workingDirectory, workflowId, 0)).at(-1)?.message;
      const lastResetSeq = tail && 'seq' in tail && typeof tail.seq === 'number' ? tail.seq : undefined;
      const next: ComputerContextState = { ...state, pendingFresh: false, pendingFreshReason: undefined, resets: state.resets + 1,
        lastResetAt: boundaryAt, lastResetSeq, lastResetReason: reason, previousSessionId };
      const saved = wf.config.incognito ? true : await updateMeta(wf.config.workingDirectory, workflowId, (meta) => {
        if (previousSessionId) {
          const entry = meta.cliSessions.find((s) => s.provider === wf.primary.provider && s.sessionId === previousSessionId);
          (meta.history ??= []).push({ sessionId: previousSessionId, provider: wf.primary.provider,
            startedAt: entry?.createdAt ?? meta.createdAt, endedAt: next.lastResetAt!, turnCount,
            archivedReason: 'computer-fresh-context' });
        }
        // A restart before the next request must not resume the old thread.
        // Its rollout, transcript and archived session id remain available.
        meta.cliSessions = meta.cliSessions.filter((s) => s.provider !== wf.primary.provider);
        meta.computerContext = next;
        meta.lastActiveAt = next.lastResetAt!;
      });
      if (!saved) throw new Error('Computer metadata is unavailable; context was kept.');
      if (wf.config.incognito) { wf.incognitoEvents = []; clearPrivateWatches(workflowId); }
      wf.config.computerContext = next;
      wf.primarySessionId = undefined;
      delete wf.config.resumeSessionId;
      wf.lastContextPercent = 0;
      if (used) wf.lastContextUsage = { tokens: 0, window: used.window, percent: 0 };
      broadcastWorkflow(workflowId, { type: 'computer_context_updated', workflowId, state: next, fresh: true, discardTranscript: wf.config.incognito === true });
      broadcastWorkflow(workflowId, { type: 'system_notice', workflowId,
        content: `[COMPUTER] Fresh context (${reason === 'operator' ? 'requested' : reason === 'recovery' ? 'connection recovery' : `${threshold}% threshold`}${used ? `; ${used.tokens.toLocaleString()} / ${used.window.toLocaleString()} tokens` : ''}). ${wf.config.incognito ? 'Memory-only transcript discarded.' : 'Previous conversation archived.'} The next request starts a new thread with no summary or earlier messages.` });
    } catch (err) {
      broadcastWorkflow(workflowId, { type: 'system_notice', workflowId,
        content: `[COMPUTER] Fresh context failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      wf.computerResetting = false;
      if (releaseBusy(wf, token)) broadcastTransient(workflowId, { type: 'primary_turn_ended', workflowId, endedAt: Date.now() });
    }
  }).catch((err) => {
    broadcastWorkflow(workflowId, { type: 'system_notice', workflowId,
      content: `[COMPUTER] Context reset check failed; context was kept: ${err instanceof Error ? err.message : String(err)}` });
  });
}

export async function handleComputerContextControl(ws: WebSocket, msg: ComputerContextControlMessage): Promise<void> {
  const wf = workflows.get(msg.workflowId);
  if (!wf || !isComputer(wf)) { send(ws, { type: 'error', workflowId: msg.workflowId, message: 'Context controls require a Computer chat.' }); return; }
  if (msg.action !== 'fresh' && msg.action !== 'configure') return;
  if (msg.resetAtPercent !== undefined && msg.resetAtPercent !== null
      && (!Number.isInteger(msg.resetAtPercent) || msg.resetAtPercent < 10 || msg.resetAtPercent > 75)) {
    send(ws, { type: 'error', workflowId: msg.workflowId, message: 'Computer reset threshold must be between 10% and 75%.' }); return;
  }
  if (msg.keepContext !== undefined && typeof msg.keepContext !== 'boolean') return;
  await withFileLock(`computer-context:${msg.workflowId}`, async () => {
    const state = await computerContextState(msg.workflowId, wf);
    const next = { ...state,
      ...(msg.action === 'fresh' ? { pendingFresh: true, pendingFreshReason: 'operator' as const } : {}),
      ...(msg.resetAtPercent !== undefined ? { resetAtPercent: msg.resetAtPercent } : {}),
      ...(msg.keepContext !== undefined ? { keepContext: msg.keepContext } : {}),
    };
    const saved = wf.config.incognito ? true : await updateMeta(wf.config.workingDirectory, msg.workflowId, (meta) => { meta.computerContext = next; });
    if (!saved) throw new Error('Computer metadata is unavailable.');
    wf.config.computerContext = next;
    broadcastWorkflow(msg.workflowId, { type: 'computer_context_updated', workflowId: msg.workflowId, state: next });
  });
  await maybeFreshComputerContext(msg.workflowId);
  await drainQueueIfIdle(msg.workflowId);
  await announceComputerSettled(msg.workflowId);
}

export async function computerReplayEvents(cwd: string, id: string, since = 0, afterSeq?: number) {
  const events = (await replayEventsWithTs(cwd, id, 0)).filter((e) => afterSeq !== undefined ? (('seq' in e.message && typeof e.message.seq === 'number') ? e.message.seq : 0) > afterSeq : e.ts > since).map((e) => e.message);
  // The current request was already echoed; it rides the provider input once.
  return events.slice(0, events.findLastIndex((e) => e.type === 'primary_complete') + 1);
}

export async function announceComputerSettled(id: string): Promise<void> {
  const wf = workflows.get(id);
  if (!wf || !isComputer(wf) || wf.busy || wf.computerResetting || wf.queue.steering.length || wf.queue.followUp.length) return;
  const state = await computerContextState(id, wf);
  if (wf.busy || wf.computerResetting) return;
  wf.computerSettled=true;
  broadcastTransient(id, { type: 'computer_context_updated', workflowId: id, state, settled: true });
  computerProjectionChanged();
}
