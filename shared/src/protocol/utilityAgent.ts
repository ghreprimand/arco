// Utility agent: one operator-chosen provider and model for small side jobs
// outside workflows. A utility job is operator-initiated, read-only, has no
// tools, bounded input, a timeout and a cancel, and returns the answer with
// the model that gave it and the facts it was given.

// Providers whose adapters can make one request that cannot use tools:
// Claude Native (no tools field), Cursor (Ask mode, no capabilities), Ollama
// (no tools field) and Codex (one-shot app-server, read-only sandbox, any
// tool item or approval request ends the turn).
export const UTILITY_AGENT_PROVIDERS = ['claude', 'codex', 'cursor', 'ollama'] as const;
export type UtilityAgentProvider = typeof UTILITY_AGENT_PROVIDERS[number];

export interface UtilityAgent {
  provider: UtilityAgentProvider;
  model: string;
}

export const UTILITY_AGENT_MODEL_MAX = 200;
// Input beyond this many characters is cut before it is sent.
export const UTILITY_JOB_INPUT_MAX_CHARS = 24_000;
export const UTILITY_JOB_TIMEOUT_MS = 60_000;
export const UTILITY_JOB_MAX_OUTPUT_TOKENS = 600;

export function sanitizeUtilityAgent(raw: unknown): UtilityAgent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.provider !== 'string' || !(UTILITY_AGENT_PROVIDERS as readonly string[]).includes(r.provider)) return null;
  if (typeof r.model !== 'string') return null;
  const model = r.model.trim();
  if (model.length === 0 || model.length > UTILITY_AGENT_MODEL_MAX) return null;
  return { provider: r.provider as UtilityAgentProvider, model };
}

// A hint for choosing a cheap, fast model: a Claude model id containing this
// text, or the Cursor model with exactly this id; null when none can be
// suggested. A hint is only shown beside the picker, never selected.
export function utilityModelHint(provider: UtilityAgentProvider): string | null {
  if (provider === 'claude') return 'haiku';
  if (provider === 'cursor') return 'auto';
  if (provider === 'codex') return 'luna';
  return null;
}

export function suggestUtilityModel(provider: UtilityAgentProvider, models: readonly string[]): string | null {
  const hint = utilityModelHint(provider);
  if (!hint) return null;
  return (provider === 'cursor' ? models.find((m) => m === hint) : models.find((m) => m.toLowerCase().includes(hint))) ?? null;
}

export interface UtilityAgentCapability {
  provider: UtilityAgentProvider;
  available: boolean;
  reason?: string;
}

// One line of the facts a job was given; shown beside every answer.
export interface UtilityJobFact {
  label: string;
  value: string;
}

export type UtilityJobStatus = 'ok' | 'not_set' | 'timeout' | 'cancelled' | 'error';

export interface UtilityJobResult {
  jobId: string;
  status: UtilityJobStatus;
  text?: string;
  // Provider and model that answered (or were asked).
  agent?: UtilityAgent;
  facts: UtilityJobFact[];
  // Facts or input were cut to the size limit.
  truncated?: boolean;
  elapsedMs: number;
  // Short machine reason for a non-ok status.
  reason?: string;
}

// BRIEF: a short synopsis of one worker or of a whole cluster, written by the
// utility agent from facts the client collected deterministically.
export type UtilityBriefScope = 'worker' | 'cluster';
export const UTILITY_BRIEF_MAX_FACTS = 80;
export const UTILITY_BRIEF_LABEL_MAX = 80;
export const UTILITY_BRIEF_VALUE_MAX = 600;
export const UTILITY_BRIEF_BODY_MAX_BYTES = 64 * 1024;

export interface UtilityBriefRequest {
  jobId: string;
  scope: UtilityBriefScope;
  facts: UtilityJobFact[];
}
