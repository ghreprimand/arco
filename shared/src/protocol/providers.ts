// ── Provider / model / effort name types ──

export type WorkerStatus = 'spawning' | 'running' | 'completed' | 'failed';
export type ModelName = 'haiku' | 'sonnet' | 'opus' | (string & {});
// 'ultra' is Codex-only (GPT-6 Astra, 2026-09-03) and sits ABOVE 'max' — Codex
// describes it as "Maximum reasoning with automatic task delegation". It is
// representable here so the picker can offer it, but it only ever surfaces for
// a model whose live catalog entry advertises it (see effortsForModel); no
// Claude/local model lists it, so nothing else can select it.
// Strata exposes none explicitly; other providers keep their own picker sets.
export type EffortLevel = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type ProviderName = 'claude' | 'ollama' | 'codex' | 'llamacpp' | 'lmstudio' | 'strata' | 'deepseek' | 'cursor';

// Lite: only 'passthrough' remains — primary-worker output mirrored to chat.
// The old 'planning'/'synthesis' phases are gone with the orchestrator.
export type PrimaryPhase = 'passthrough';

export const PRIMARY_PROVIDERS: ProviderName[] = ['claude',  'codex',  'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek', 'cursor'];

export type AuthLoginTarget = ProviderName | 'github';

// POST /api/auth-login response. `command` is the headless login command the
// operator runs in Arco's own terminal (a shell on the server box): every
// supported CLI prints a URL / device code instead of needing a local browser,
// so the same flow works at the desk, from a laptop over the tailnet, or from
// a phone. Connections can explicitly request an in-app session; other
// callers keep the terminal command flow.
export interface AuthLoginResult {
  started: boolean;
  manual?: string;
  command?: string;
  // Docker deployment: run from the host folder containing compose.yaml.
  // `command` remains the command for Arco's in-container terminal.
  hostCommand?: string;
  // In-app login: the server runs the provider CLI itself and relays the
  // link and code. Present for explicitly requested Codex or Claude sessions.
  session?: AuthLoginSession;
}

// One provider login run by the server (server/src/authLoginSession.ts).
export interface AuthLoginSession {
  provider: AuthLoginTarget;
  status: 'pending' | 'completed' | 'failed' | 'cancelled';
  // Claude: the browser shows a code the operator pastes back here.
  needsCode: boolean;
  // The CLI reached its paste prompt (Claude).
  awaitingCode?: boolean;
  codeSubmitted?: boolean;
  url?: string;
  // Codex: the one-time code to enter on the page.
  code?: string;
  message?: string;
  startedAt: number;
  finishedAt?: number;
}

// Ordering helper for the effort floor. Typed as a total Record so a new
// EffortLevel cannot be added without ranking it — the compiler catches the
// omission that would otherwise sort the new level to the bottom.
export const EFFORT_RANK: Record<EffortLevel, number> = {
  none: -1,
  low: 0,
  medium: 1,
  high: 2,
  xhigh: 3,
  max: 4,
  ultra: 5,
};

// Historical configurations retain their provider identity until explicitly
// changed. Settings and workflow metadata use this to decide what to keep, so
// it covers only providers whose saved identity is retained (Gemini,
// Antigravity). For user-facing messages use removedProviderReason.
export function retiredProviderReason(provider: unknown): string | undefined {
  if (provider === 'gemini') return 'Gemini support has been removed. Saved work is preserved; choose a supported provider explicitly for new work.';
  return provider === 'antigravity'
    ? 'Antigravity support has been removed. Saved work is preserved; choose a supported provider explicitly for new work.'
    : undefined;
}

// Z.ai was removed with its saved settings discarded (legacy defaults are
// ignored rather than retained), so it is not a retained retired provider,
// but anything that still names it gets a removal notice instead of a generic
// "unsupported provider" error.
const ZAI_REMOVED_REASON = 'Z.ai support has been removed. Choose a supported provider explicitly for new work.';

// The notice shown wherever a removed provider is named: retained retired
// providers (Gemini, Antigravity) and Z.ai. Undefined for anything else.
export function removedProviderReason(provider: unknown): string | undefined {
  return retiredProviderReason(provider) ?? (provider === 'zai' ? ZAI_REMOVED_REASON : undefined);
}
