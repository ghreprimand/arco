import { workflows, workflowCwds } from '../server/state.js';
import type { WorkflowState } from '../workflows/types.js';
import { scanEventsOfTypes } from '../workflowStore.js';
import { latestCodexTokenSnapshot } from '../workflows/transcripts.js';
import { resolveProviderAccount } from '../providerAccounts.js';
import { observedWorker, type ObservedWorker } from './conditionFacts.js';

const types = ['primary_complete', 'primary_turn_token_usage', 'ctx_action', 'native_compacted', 'context_folded', 'handoff_complete', 'leaf_move'] as const;
type Reading = { tokens: number; window: number | null; percent: number | null };
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const reading = (tokens: number, window: unknown): Reading => ({ tokens, window: positive(window) ? window : null, percent: positive(window) ? tokens / window * 100 : null });

// Billing totals cannot reconstruct context. Only a final-request measurement
// or the current Codex session's last_token_usage can restore it after restart.
export async function readConditionContext(id: string, wf: WorkflowState): Promise<Reading | null> {
  if (wf.config.incognito || wf.config.voiceOperator || wf.config.kind === 'chat') return null;
  const cwd = workflowCwds.get(id) ?? wf.config.workingDirectory;
  const events = await scanEventsOfTypes(cwd, id, types);
  let measured: Reading | null = null, boundary = false;
  for (const event of events) {
    if (event.type === 'primary_complete') {
      boundary = false;
      measured = positive(event.lastPromptTokens) ? reading(event.lastPromptTokens, event.modelContextWindow) : null;
    } else if (event.type === 'primary_turn_token_usage') {
      if (event.provider !== wf.primary.provider) { measured = null; boundary = true; }
    } else if (event.type !== 'ctx_action' || event.action === 'compact') {
      // Do not resurrect pre-compaction/handoff/rewind tokens. The next real
      // measurement will replace unknown; a summary is not a zero-token prompt.
      measured = null; boundary = true;
    }
  }
  if (measured || boundary || wf.primary.provider !== 'codex' || !wf.primarySessionId) return measured;
  const account = await resolveProviderAccount('codex', wf.config.providerAccountRef, cwd);
  const snapshot = await latestCodexTokenSnapshot(wf.primarySessionId, account?.codexHome);
  return snapshot && positive(snapshot.tokens.input) ? reading(snapshot.tokens.input, snapshot.modelContextWindow) : null;
}

const restored = new WeakSet<ObservedWorker>();
const pending = new WeakMap<ObservedWorker, Promise<void>>();
// One read per uninitialized public worker, coalesced across HTTP/rule checks.
// Live measurements, removal and compaction fence every asynchronous read.
export async function restoreConditionContext(id: string, wf: WorkflowState): Promise<void> {
  const f = observedWorker(id);
  if (restored.has(f) || f.tokens !== null || f.window !== null || wf.busy || f.compacting) return;
  const existing = pending.get(f); if (existing) return existing;
  const revision = f.contextRevision, provider = wf.primary.provider, model = wf.primary.model, session = wf.primarySessionId;
  const run = (async () => {
    const value = await readConditionContext(id, wf).catch(() => null);
    if (workflows.get(id) !== wf || observedWorker(id) !== f || wf.config.incognito || wf.busy || f.compacting
        || f.contextRevision !== revision || wf.primary.provider !== provider || wf.primary.model !== model || wf.primarySessionId !== session) return;
    restored.add(f);
    if (value) { f.tokens = value.tokens; f.window = value.window; f.percent = value.percent; }
  })();
  pending.set(f, run);
  try { await run; } finally { pending.delete(f); }
}
