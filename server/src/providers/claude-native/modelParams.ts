// Phase P0 (WORKBENCH_EXPANSION_PLAN) — extracted from worker.ts to keep that
// file under the 2000-line cap. Pure model-parameter helpers: token ceilings,
// thinking/effort params, and context-window lookup. No worker state here.

import {
  enforcesPreservedThinking,
  supportsClaudeAdaptiveThinking,
  supportsThinkingDisplayUpdates,
  type ClaudeNativeThinkingDisplay,
} from '@archon/shared';

export const DEFAULT_MAX_TOKENS = 8192;

// Adaptive-thinking models do not take an explicit thinking budget. Claude's
// Messages API lets these models use their generated model maxTokens cap and
// relies on output_config.effort to control reasoning depth. Keep the same
// model-family caps here instead of an Archon-only per-effort ceiling: Fable /
// Mythos, Opus 5, Opus 4.6/4.7/4.8, and Sonnet 5 advertise 128K output;
// Sonnet 4.6 advertises 64K.
export function adaptiveMaxTokensForModel(modelId: string): number {
  if (
    // Family aliases resolve to the newest opus, which advertises 128K.
    modelId === 'opus' ||
    modelId === 'opus[1m]' ||
    modelId.includes('fable-5') ||
    modelId.includes('mythos-5') ||
    modelId.includes('opus-5') ||
    modelId.includes('opus-4-6') ||
    modelId.includes('opus-4.6') ||
    modelId.includes('opus-4-7') ||
    modelId.includes('opus-4.7') ||
    modelId.includes('opus-4-8') ||
    modelId.includes('opus-4.8')
  ) {
    return 128_000;
  }
  if (modelId.includes('sonnet-4-6') || modelId.includes('sonnet-4.6')) {
    return 64_000;
  }
  // Sonnet 5 advertises 128K output (up from Sonnet 4.6's 64K).
  if (modelId.includes('sonnet-5')) {
    return 128_000;
  }
  return 64_000;
}

// supportsClaudeAdaptiveThinking lives in shared/protocol.ts so the client
// effort picker and this worker share one definition.

// Older 4.x family that supports budget-based thinking (claude-sonnet-4 /
// claude-opus-4 / claude-3-7-sonnet etc). Conservative — when in doubt,
// don't send thinking.
function supportsBudgetThinking(modelId: string): boolean {
  return /opus-4(?!-[67])|sonnet-4(?!-6)|3-7-sonnet/.test(modelId);
}

// Map effort → budget_tokens for older models. low disables thinking.
const EFFORT_BUDGET_TOKENS: Record<string, number> = {
  low: 0,
  medium: 4_096,
  high: 16_384,
  xhigh: 32_768,
  max: 64_000,
};

// Build thinking + output_config params for the messages.create call.
// Returns the partial request shape to spread into the call site.
export function buildThinkingParams(
  modelId: string,
  effort: string,
  // Adaptive-model thinking display. 'omitted' (default) is the Claude-Code-
  // parity choice; 'summarized' is the operator's CONFIG-tab opt-in so a long
  // Fable/Opus think streams into the Activity tab instead of reading as a
  // stuck worker; 'updates' (Fable 5 / 5.1 / Mythos 5.1 only, beta) returns
  // the model's between-tool-call progress notes as non-empty thinking blocks
  // while reasoning stays hidden — degrades to 'omitted' elsewhere. Budget-
  // thinking models ignore this (always summarized).
  display: ClaudeNativeThinkingDisplay = 'omitted',
): Record<string, unknown> {
  if (effort === 'low' && !supportsClaudeAdaptiveThinking(modelId)) {
    // Older models: low disables thinking entirely.
    return {};
  }
  if (supportsClaudeAdaptiveThinking(modelId)) {
    // SDK ^0.91 type defs may lag 'xhigh'/'max'; cast through unknown.
    const params: Record<string, unknown> = {
      // Opus 4.8 / 4.7 default to omitted thinking in the Messages API, and
      // Claude Code's UI behaves that way too: it preserves signed thinking
      // blocks for continuity without asking the API to stream summarized
      // thinking text back through Archon's hand-rolled loop. For Native parity
      // with Claude Code, adaptive thinking defaults to omitted; the operator
      // flips to summarized per tab via WorkflowConfig.claudeNativeThinkingDisplay.
      thinking: {
        type: 'adaptive',
        display: resolveThinkingDisplay(modelId, display),
        // FABLE_51_APPEND_ONLY_PLAN.md §2 — opt the request into the preserved-
        // thinking check explicitly (the defaults differ by surface) and ask
        // for drop-not-error so an edited prefix degrades instead of killing
        // the turn. Requires BETA_THINKING_BINDING_CONTROLS on the header; the
        // worker pairs them. Enforcing models only — older ones would 400 on
        // the unknown field without the beta.
        ...(enforcesPreservedThinking(modelId)
          ? { block_binding: { prefix_mismatch_behavior: 'drop_block' } }
          : {}),
      },
      output_config: { effort },
    };
    return params;
  }
  if (supportsBudgetThinking(modelId)) {
    const budget = EFFORT_BUDGET_TOKENS[effort] ?? EFFORT_BUDGET_TOKENS.high;
    if (budget === 0) return {};
    return {
      thinking: { type: 'enabled', budget_tokens: budget, display: 'summarized' },
    };
  }
  return {};
}

// When budget thinking is on, max_tokens must exceed budget_tokens. Bump
// to fit headroom for the actual output. Adaptive thinking has no budget
// to budget against — DEFAULT_MAX_TOKENS is fine.
export function chooseMaxTokens(modelId: string, effort: string): number {
  if (supportsClaudeAdaptiveThinking(modelId)) {
    return adaptiveMaxTokensForModel(modelId);
  }
  if (supportsBudgetThinking(modelId)) {
    const budget = EFFORT_BUDGET_TOKENS[effort] ?? 0;
    if (budget === 0) return DEFAULT_MAX_TOKENS;
    return budget + DEFAULT_MAX_TOKENS;
  }
  return DEFAULT_MAX_TOKENS;
}

// 'updates' is only a valid `display` value on the models that ship progress
// notes AND only with the beta header; anywhere else it silently becomes the
// Claude-Code-parity default rather than 400ing on an unknown enum value.
export function resolveThinkingDisplay(modelId: string, display: ClaudeNativeThinkingDisplay): 'omitted' | 'summarized' | 'updates' {
  if (display === 'updates' && !supportsThinkingDisplayUpdates(modelId)) return 'omitted';
  return display;
}

export function shouldSendInterleavedThinkingBeta(modelId: string, forceForAdaptive = false): boolean {
  // Current Pi parity: adaptive-thinking Claude models have interleaved
  // thinking built in, so Pi deliberately skips the beta for those models and
  // only appends it for non-adaptive Anthropic thinking paths.
  return forceForAdaptive || !supportsClaudeAdaptiveThinking(modelId);
}

type ContextWindowMap = Record<string, number>;
const KNOWN_CTX: ContextWindowMap = {
  // Family aliases resolve to the newest opus (1M window).
  opus: 1_000_000,
  'opus[1m]': 1_000_000,
  'claude-fable-5-1': 1_000_000,
  'claude-mythos-5-1': 1_000_000,
  'claude-fable-5': 1_000_000,
  'claude-mythos-5': 1_000_000,
  'claude-opus-5-5': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-4-5-20251001': 200_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-4-5': 1_000_000,
};

export function lookupCtx(model: string): number | undefined {
  if (model in KNOWN_CTX) return KNOWN_CTX[model];
  // Fall back on family heuristic when an unknown variant lands.
  if (model.includes('fable-5')) return 1_000_000;
  if (model.includes('mythos-5')) return 1_000_000;
  if (model.includes('opus-5')) return 1_000_000;
  if (model.includes('opus-4')) return 1_000_000;
  if (model.includes('sonnet-5')) return 1_000_000;
  if (model.includes('sonnet-4')) return 1_000_000;
  if (model.includes('haiku-4')) return 200_000;
  return undefined;
}
