import { scanEventsOfTypes } from '../workflowStore.js';
import { workflows, workflowCwds } from '../server/state.js';
import type { WorkflowState } from '../workflows/types.js';
import { observedWorker, type ObservedWorker } from './conditionFacts.js';

const types = ['user_message_echo', 'primary_turn_started', 'primary_text', 'native_compacted', 'context_folded', 'handoff_complete', 'leaf_move'] as const;
const CAP = 32000;
// Metadata can fill megabytes after the last short reply. Stream only the
// relevant events and retain one bounded reply, rather than enlarging a tail.
export async function readConditionReply(cwd: string, id: string): Promise<{ text: string; truncated: boolean }> {
  let text = '', truncated = false, boundary = false;
  await scanEventsOfTypes(cwd, id, types, (event) => {
    if (event.type === 'user_message_echo' || event.type === 'primary_turn_started') {
      text = ''; truncated = false; boundary = true;
    } else if (event.type === 'primary_text') {
      text += event.text;
      if (!boundary || text.length > CAP) truncated = true;
      if (text.length > CAP) text = text.slice(-CAP);
    } else {
      text = ''; truncated = true; boundary = false;
    }
  });
  return { text, truncated };
}

const restored = new WeakSet<ObservedWorker>();
const pending = new WeakMap<ObservedWorker, Promise<void>>();
export function retryConditionReply(id: string): void {
  const f = observedWorker(id);
  if (f.version) return; // Live replies need a new human turn, not a disk rewind.
  restored.delete(f); f.text = ''; f.truncated = false;
}
export async function restoreConditionReply(id: string, wf: WorkflowState): Promise<void> {
  const f = observedWorker(id);
  if (wf.config.incognito || wf.config.voiceOperator || wf.config.kind === 'chat' || wf.busy || f.version || f.text || restored.has(f)) return;
  const existing = pending.get(f); if (existing) return existing;
  const version = f.version, session = wf.primarySessionId, provider = wf.primary.provider;
  const run = (async () => {
    let reply: Awaited<ReturnType<typeof readConditionReply>>;
    try { reply = await readConditionReply(workflowCwds.get(id) ?? wf.config.workingDirectory, id); }
    catch { reply = { text: '', truncated: true }; }
    if (workflows.get(id) !== wf || observedWorker(id) !== f || wf.busy || wf.config.incognito || f.version !== version
        || wf.primarySessionId !== session || wf.primary.provider !== provider) return;
    restored.add(f); f.text = reply.text; f.truncated = reply.truncated;
  })();
  pending.set(f, run);
  try { await run; } finally { pending.delete(f); }
}
