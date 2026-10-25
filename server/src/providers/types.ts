import type { EventEmitter } from 'events';
import type { GenerationSpeed, WorkerConfig } from '@arco/shared';

// Events a provider process emits. Matches the shape our StreamParser and
// WorkerManager already expect — so swapping providers is invisible upstream.
export interface ProviderEvents {
  init: (data: { model?: string; sessionId?: string }) => void;
  text: (text: string) => void;
  thinking: (text: string) => void;
  tool_use: (data: {
    id?: string;
    name: string;
    input: string;
    status?: 'started' | 'in_progress' | 'completed' | 'failed';
    provider?: WorkerConfig['provider'];
    itemType?: string;
    itemId?: string;
    output?: string;
    exitCode?: number;
  }) => void;
  result: (data: {
    text: string;
    costUsd: number;
    durationMs: number;
    usage?: Record<string, number>;
    genSpeed?: GenerationSpeed;
    modelContextWindow?: number;
    // Last call's prompt-token count = the context-fill numerator (resident
    // tokens), distinct from `usage.input_tokens` (which providers sum across
    // internal calls for billing). Native Claude and Ollama (M6) both fill it;
    // the server turns it into a ground-truth context_usage for the CTX bar.
    lastPromptTokens?: number;
    // EFFICIENCY_PLAN.md Phase A — per-turn byte counts. Native fills both;
    // CLI/Codex set thinkingBytes=0 and toolResultBytes=-1 (unknown) since
    // we spawn the CLI and don't see its inner messages[] array.
    thinkingBytes?: number;
    toolResultBytes?: number;
    // Pre-filter equivalent of toolResultBytes. Equals toolResultBytes until
    // Phase C lands the filter pipeline.
    toolResultBytesRaw?: number;
  }) => void;
  error: (error: string) => void;
  // Out-of-band status messages (transient API errors, retry notifications).
  // Not part of the assistant text stream — WorkerManager wraps this in a
  // `worker_system_notice` event that seedWorker translates into a chat-level
  // `system_notice` broadcast.
  system_notice: (notice: string) => void;
}

export interface ProviderProcess extends EventEmitter {
  readonly id: string;
  readonly status: 'spawning' | 'running' | 'completed' | 'failed';
  readonly output: string;
  // OS process id when the provider runs as a subprocess (claude, gemini,
  // codex). Undefined for non-subprocess providers like Ollama (HTTP-only).
  // Used by processActivity to probe /proc/<pid>/stat.
  readonly pid?: number;
  spawn(prompt: string): void;
  kill(): void;
  // Stronger than STOP: wait for teardown before resuming the same session.
  // false means startup was cancelled before the prompt entered history.
  interrupt?(): Promise<boolean | void>;
}

export interface Provider {
  create(id: string, config: WorkerConfig): ProviderProcess;
}
