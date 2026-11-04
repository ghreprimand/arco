// §H2 model-title trigger on the Ollama utility model (M7). The session index
// has carried a `model` title layer + `applyModelTitle` + `buildTitleFraming`
// since H2, with no caller; this is it.
//
// Four-question test:
//   1. Opt-in twice over — needs `settings.ollama.utility.model` (the utility
//      model) AND `settings.ollama.utility.titles: true`. Arming the utility
//      model for compaction does NOT arm titles. Local model only; no cloud call.
//   2. Bounded — one-shot per session (skips once a `model` or `operator`
//      title exists), first few operator messages only, 32-token cap,
//      stream:false via runUtilityJob.
//   3. Visible — runUtilityJob's per-call system_notice lands in the tab's
//      events.jsonl; the applied change is logged to title-events.jsonl.
//   4. Reversible — the operator's RESUME-picker rename outranks it forever;
//      unset the flag and the derived titles are untouched.
// Never throws, never blocks the turn (writeMeta fires-and-logs it).

import type { WorkflowMeta } from '../workflowMeta.js';
import { applyModelTitle, buildTitleFraming, readSessionIndex, scanOperatorMessages } from './sessionIndex.js';

// Operator messages fed to the model: the opening asks carry the session's
// goal; later turns are mostly "continue" / follow-ups.
const TITLE_SOURCE_MESSAGES = 4;
const TITLE_SOURCE_MSG_CHARS = 600;
const TITLE_MAX_TOKENS = 32;

// Workflows with a generation in flight — a fast second turn must not fire a
// duplicate call before the first one's applyModelTitle lands.
const inFlight = new Set<string>();

// Normalize a small model's reply to a bare title: first non-empty line, no
// "Title:" prefix, no wrapping quotes/markdown, no trailing punctuation.
// Returns null when nothing usable survives (the derived title stays).
export function cleanModelTitle(raw: string): string | null {
  const line = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;
  const t = line
    .replace(/^#+\s*/, '')
    .replace(/^\*\*(.*)\*\*$/, '$1')
    .replace(/^title\s*:\s*/i, '')
    .replace(/^["'`“‘]+|["'`”’]+$/g, '')
    .replace(/[.!?;:,\s]+$/, '')
    .trim();
  if (!t || t.length > 100) return null;
  return t;
}

export interface ModelTitleDeps {
  readSettings: () => Promise<{ ollama?: { utility?: { model?: string; baseUrl?: string; titles?: boolean; enabled?: boolean } } }>;
  runUtilityJob: typeof import('../providers/ollamaUtility.js').runUtilityJob;
  notify: (workflowId: string, line: string) => void;
}

async function defaultDeps(): Promise<ModelTitleDeps> {
  const [{ readSettings }, { runUtilityJob }, { broadcastWorkflow }] = await Promise.all([
    import('../settings.js'),
    import('../providers/ollamaUtility.js'),
    import('../server/broadcast.js'),
  ]);
  return {
    readSettings,
    runUtilityJob,
    notify: (workflowId, content) => broadcastWorkflow(workflowId, { type: 'system_notice', workflowId, content }),
  };
}

export async function maybeGenerateModelTitle(
  meta: WorkflowMeta,
  deps?: ModelTitleDeps,
): Promise<'skipped' | 'applied' | 'failed'> {
  const wfid = meta.workflowId;
  if (!meta.cwd || meta.kind === 'chat' || inFlight.has(wfid)) return 'skipped';
  inFlight.add(wfid);
  try {
    const d = deps ?? await defaultDeps();
    const utility = (await d.readSettings()).ollama?.utility;
    if (!utility?.titles || utility.enabled === false || !utility.model?.trim()) return 'skipped';

    const index = await readSessionIndex(meta.cwd);
    const entry = index.entries.find((e) => e.workflowId === wfid);
    if (!entry || entry.titleSource === 'model' || entry.titleSource === 'operator') return 'skipped';

    const messages = (await scanOperatorMessages(meta.cwd, wfid))
      .slice(0, TITLE_SOURCE_MESSAGES)
      .map((m) => (m.length > TITLE_SOURCE_MSG_CHARS ? m.slice(0, TITLE_SOURCE_MSG_CHARS) + '…' : m));
    if (messages.length === 0) return 'skipped';

    const result = await d.runUtilityJob({
      job: 'session-title',
      prompt: buildTitleFraming(messages.map((m) => `Operator: ${m}`).join('\n\n')),
      maxTokens: TITLE_MAX_TOKENS,
      onNotice: (line) => d.notify(wfid, line),
    });
    if (!result.ok) return 'failed';
    const title = cleanModelTitle(result.text);
    if (!title) return 'failed';
    const applied = await applyModelTitle(meta.cwd, wfid, title, { sourceHash: entry.sourceHash });
    return applied.status === 'applied' ? 'applied' : 'skipped';
  } catch (err) {
    console.error('[arco] model title generation failed:', err);
    return 'failed';
  } finally {
    inFlight.delete(wfid);
  }
}
