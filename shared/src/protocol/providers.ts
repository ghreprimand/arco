// ── Provider / model / effort name types ──

export type WorkerStatus = 'spawning' | 'running' | 'completed' | 'failed';
export type ModelName = 'haiku' | 'sonnet' | 'opus' | (string & {});
// 'ultra' is Codex-only (GPT-6 Astra, 2026-09-03) and sits ABOVE 'max' — Codex
// describes it as "Maximum reasoning with automatic task delegation". It is
// representable here so the picker can offer it, but it only ever surfaces for
// a model whose live catalog entry advertises it (see effortsForModel); no
// Claude/Gemini/local model lists it, so nothing else can select it.
// Strata exposes none explicitly; other providers keep their own picker sets.
export type EffortLevel = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type ProviderName = 'claude' | 'gemini' | 'ollama' | 'codex' | 'zai' | 'antigravity' | 'llamacpp' | 'lmstudio' | 'strata' | 'deepseek' | 'cursor';

// Lite: only 'passthrough' remains — primary-worker output mirrored to chat.
// The old 'planning'/'synthesis' phases are gone with the orchestrator.
export type PrimaryPhase = 'passthrough';

// Providers that can run as a primary worker (the long-lived chat agent per
// tab). Ollama is primary-capable: no native session concept, so each turn
// re-prepends the workflow's events.jsonl transcript as structured /api/chat
// messages and lets Ollama's prefix cache absorb the unchanged prefix bytes.
// Antigravity is primary-capable via the desktop app's local RPC path. It
// resumes primary turns by opaque cascade id; reviewer-style turns start a
// fresh cascade and do not persist that id.
// LM Studio (M13) is primary-capable like llama.cpp — same OpenAI-compatible
// HTTP transport (the standing verdict: NOT the native lmstudio.js SDK), just
// pointed at a configurable remote endpoint instead of a locally-spawned
// llama-server. It reuses the same transcript-rebuild + skills/cluster
// scaffolding as llama.cpp in turnEngine.
export const PRIMARY_PROVIDERS: ProviderName[] = ['claude', 'gemini', 'codex', 'zai', 'antigravity', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek', 'cursor'];

export type AuthLoginTarget = ProviderName | 'github';

// POST /api/auth-login response. `command` is the headless login command the
// operator runs in Arco's own terminal (a shell on the server box): every
// supported CLI prints a URL / device code instead of needing a local browser,
// so the same flow works at the desk, from a laptop over the tailnet, or from
// a phone. The server no longer spawns logins itself — the old detached
// `claude auth login` (stdio ignored) and desktop-terminal launches failed
// silently whenever no browser/display was reachable.
export interface AuthLoginResult {
  started: boolean;
  manual?: string;
  command?: string;
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
