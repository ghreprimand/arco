// Shared runner for utility jobs: one request to the operator's utility agent
// with no tools, a capped input, a timeout and a cancel. It returns the answer
// with the model that gave it and the facts it was given. It never acts on a
// worker, sends mail or keeps anything for a worker's context.
import {
  UTILITY_JOB_INPUT_MAX_CHARS, UTILITY_JOB_MAX_OUTPUT_TOKENS, UTILITY_JOB_TIMEOUT_MS,
  type UtilityAgent, type UtilityJobFact, type UtilityJobResult,
} from '@arco/shared';
import { evaluatorAdapter, EvaluatorRefused } from './smartPickupAdapters.js';
import { readSettings } from './settings.js';

export interface UtilityJobRequest {
  jobId: string;
  // What the agent is asked to do; fixed text from the calling feature.
  instructions: string;
  // The facts, shown to the operator beside the answer and sent to the agent.
  facts: UtilityJobFact[];
  // Extra bounded material (recent replies, for example), after the facts.
  material?: string;
  timeoutMs?: number;
  // Test seams.
  agent?: UtilityAgent | null;
  now?: () => number;
}

const running = new Map<string, AbortController>();

export function cancelUtilityJob(jobId: string): boolean {
  const controller = running.get(jobId);
  if (!controller) return false;
  controller.abort(new EvaluatorRefused('cancelled'));
  return true;
}

export function runningUtilityJobs(): string[] {
  return [...running.keys()];
}

// Fact lines first (each cut to 400 characters), then the material, all within
// the input limit. The same facts list is returned for display.
export function buildUtilityPrompt(facts: UtilityJobFact[], material: string | undefined, limit = UTILITY_JOB_INPUT_MAX_CHARS): { prompt: string; facts: UtilityJobFact[]; truncated: boolean } {
  let truncated = false;
  const shown = facts.map((f) => {
    const value = f.value.length > 400 ? (truncated = true, `${f.value.slice(0, 400)}...`) : f.value;
    return { label: f.label, value };
  });
  const head = `Facts:\n${shown.map((f) => `- ${f.label}: ${f.value}`).join('\n')}`;
  let body = head;
  if (material && material.trim()) {
    const room = Math.max(0, limit - head.length - 20);
    const cut = material.length > room;
    if (cut) truncated = true;
    body += `\n\nMaterial:\n${cut ? material.slice(-room) : material}`;
  }
  if (body.length > limit) { truncated = true; body = body.slice(0, limit); }
  return { prompt: body, facts: shown, truncated };
}

export async function runUtilityJob(req: UtilityJobRequest): Promise<UtilityJobResult> {
  const now = req.now ?? Date.now;
  const started = now();
  const built = buildUtilityPrompt(req.facts, req.material);
  const base = { jobId: req.jobId, facts: built.facts, ...(built.truncated ? { truncated: true } : {}) };
  const done = (status: UtilityJobResult['status'], extra: Partial<UtilityJobResult> = {}): UtilityJobResult => ({ ...base, status, elapsedMs: now() - started, ...extra });
  if (running.has(req.jobId)) return done('error', { reason: 'job_already_running' });
  const controller = new AbortController();
  running.set(req.jobId, controller);
  let agent: UtilityAgent | null = null;
  try {
    agent = req.agent !== undefined ? req.agent : (await readSettings()).utilityAgent ?? null;
    if (controller.signal.aborted) return done('cancelled', { ...(agent ? { agent } : {}), reason: 'cancelled' });
    if (!agent) return done('not_set');
    const adapter = evaluatorAdapter(agent.provider);
    const capability = await adapter.capability().catch(() => ({ available: false }));
    if (controller.signal.aborted) return done('cancelled', { agent, reason: 'cancelled' });
    if (!capability.available) return done('error', { agent, reason: agent.provider === 'claude' ? 'not_signed_in' : 'unavailable' });
    const text = await adapter.evaluate({
      model: agent.model,
      instructions: req.instructions,
      prompt: built.prompt,
      timeoutMs: req.timeoutMs ?? UTILITY_JOB_TIMEOUT_MS,
      maxOutputTokens: UTILITY_JOB_MAX_OUTPUT_TOKENS,
      freeText: true,
      signal: controller.signal,
    });
    if (controller.signal.aborted) return done('cancelled', { agent, reason: 'cancelled' });
    const trimmed = text.trim();
    return trimmed ? done('ok', { agent, text: trimmed }) : done('error', { agent, reason: 'empty_answer' });
  } catch (err) {
    const reason = err instanceof EvaluatorRefused ? err.message : 'request_failed';
    const extra = agent ? { agent, reason } : { reason };
    if (reason === 'timeout') return done('timeout', extra);
    if (reason === 'cancelled') return done('cancelled', extra);
    return done('error', { ...extra, reason: reason.slice(0, 80) });
  } finally {
    running.delete(req.jobId);
  }
}
