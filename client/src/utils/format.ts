import { CODEX_MODEL_INFO, CLAUDE_MODEL_EFFORTS, ollamaEffortsFor } from '@arco/shared';
import type { TokenUsage, ProviderName, ModelName, EffortLevel, ClaudeCatalogSnapshot, CodexCatalogSnapshot, OllamaThinkingInfo } from '@arco/shared';

// Ollama per-model graded-thinking levels, fed from the auth snapshot
// (appStore.setAuthStatus). A module registry rather than another parameter:
// effortsForModel has ~30 call sites and the levels only matter for Ollama.
let ollamaThinking: Record<string, OllamaThinkingInfo> = {};
export function setOllamaThinkingCatalog(
  caps: Record<string, { thinkingLevels?: string[]; thinkingCanDisable?: boolean }> | undefined,
): void {
  const next: Record<string, OllamaThinkingInfo> = {};
  for (const [model, c] of Object.entries(caps ?? {})) {
    if (c.thinkingLevels && c.thinkingLevels.length > 0) {
      next[model] = { levels: c.thinkingLevels, canDisable: c.thinkingCanDisable === true };
    }
  }
  ollamaThinking = next;
}

// Parse a CLI-emitted model string into a compact display label.
//   claude-opus-4-7    → "OPUS 4.7"
//   gemini-2.5-pro     → "GEMINI 2.5 PRO"
//   gemini-2.5-flash   → "GEMINI 2.5 FLASH"
// Falls back to the alias if unparseable so we always show something.
export function formatModelLabel(alias: string, resolved?: string): string {
  const upperAlias = alias.toUpperCase();
  const source = resolved || alias;

  const claude = source.match(/^claude-(\w+)-(\d+)-(\d+)/i);
  if (claude) return `${claude[1].toUpperCase()} ${claude[2]}.${claude[3]}`;

  const gemini = source.match(/^gemini-(\d+)\.(\d+)-([\w-]+)/i);
  if (gemini) return `GEMINI ${gemini[1]}.${gemini[2]} ${gemini[3].toUpperCase()}`;

  return upperAlias;
}

// Compact token count — 1234 → "1.2k", 1_234_567 → "1.2M".
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
}

// Total tokens processed for a turn/job. Caches count toward the billable
// pie chart but are much cheaper per-token, so we still surface them.
export function totalTokens(t: TokenUsage, provider?: ProviderName): number {
  if (provider === 'codex') {
    return t.total ?? ((t.input ?? 0) + (t.output ?? 0));
  }
  return t.input + t.output + (t.cacheRead ?? 0) + (t.cacheCreate ?? 0);
}

// The "fills the context window" number — provider-aware.
//
// CRITICAL: Anthropic and OpenAI report cache fields with OPPOSITE semantics.
//
//   Claude (Anthropic): input_tokens, cache_read_input_tokens, and
//     cache_creation_input_tokens are DISJOINT — they sum to the total
//     prompt. Arco's ctx for Claude is `input + cacheCreate`, matching
//     server/src/index.ts:maybeAutoCompact's threshold metric. Cache-reads
//     are deliberately excluded because the prior cached prefix isn't NEW
//     context being sent (it's already-counted cumulative state).
//
//   Codex (OpenAI): cached_input_tokens is a SUBSET of input_tokens —
//     `input_tokens` is the full prompt size, `cached_input_tokens` is
//     informational ("of those input_tokens, this many were served from
//     prefix cache"). Confirmed against real rollout payloads where
//     input=8402, cached=7296 with input being the only number that
//     matches what the model actually saw. So Arco's ctx for Codex is
//     just `input` — adding cacheRead would double-count the cached
//     portion (and was the source of an inflated "89k after 3 prompts"
//     report before this was fixed, 2026-04-26).
//
//   Other providers (Gemini, Ollama, Antigravity): default to the Claude
//     shape — they don't populate cacheRead/cacheCreate today, so the
//     result is just `input` regardless.
export function contextTokens(t: TokenUsage, provider?: ProviderName): number {
  if (provider === 'codex') {
    return t.input ?? 0;
  }
  return (t.input ?? 0) + (t.cacheCreate ?? 0);
}

// Hardcoded fallback for the Codex CTX-bar denominator. Used ONLY when the
// stream parser hasn't yet observed Codex's actual `model_context_window`
// field (first turn before turn.completed lands, or older Codex CLI versions
// that don't surface it).
//
// Important: GPT-5.5's published 400K window is misleading — it's a 272K
// input + 128K output split, not a unified usable window. Codex itself
// reports ~258K via `model_context_window` (272K × 0.95 effective-window
// multiplier). See Codex issues #19319, #19409, #19208 and docs/GOTCHAS.md
// "Codex" section. For now we default everything to 272K (the actual input
// portion); when Codex reports a real value via primary_complete.modelContextWindow
// the client uses THAT instead. No per-model pins because the stream value
// is the only honest source.
const DEFAULT_CODEX_WINDOW = 272_000;

export function codexModelWindow(model: ModelName | string): number {
  return CODEX_MODEL_INFO[model as string]?.fallbackOperationalWindow ?? DEFAULT_CODEX_WINDOW;
}

export function codexPublishedContextWindow(model: ModelName | string): number {
  return CODEX_MODEL_INFO[model as string]?.publishedContextWindow ?? 400_000;
}

export function codexPublishedMaxOutput(model: ModelName | string): number {
  return CODEX_MODEL_INFO[model as string]?.publishedMaxOutput ?? 128_000;
}

export function providerOperationalWindow(provider: ProviderName | undefined, model: ModelName | string): number {

  return codexModelWindow(model);
}

export function providerPublishedContextWindow(provider: ProviderName | undefined, model: ModelName | string): number {

  return codexPublishedContextWindow(model);
}

export function cacheHitPercent(t: TokenUsage): number | null {
  if (!t.input || !t.cacheRead) return null;
  return Math.round(Math.min(1, Math.max(0, t.cacheRead / t.input)) * 100);
}

// Default auto-compact threshold if settings.autoCompactInputTokens is unset.
// Mirrors AUTO_COMPACT_INPUT_TOKENS_THRESHOLD in server/src/index.ts.
// Claude-specific concept; Codex doesn't have an Arco-managed auto-compact.
export const DEFAULT_AUTO_COMPACT_THRESHOLD = 80_000;

// Per-provider effort levels that the CLI actually honors. Used by the
// effort picker in WorkflowCreator / HandoffDialog / SpawnDialog /
// ReviewDialog / the CONFIG tab.
//
//   Claude    — all 5 levels are real (low/medium/high/xhigh/max).
//   Codex     — this is only the no-catalog FALLBACK (low/medium/high). The real
//               surface is per-model and comes from the live catalog via
//               effortsForModel: gpt-5.5 adds xhigh, and gpt-6-astra goes on to
//               max and ultra. Don't widen this fallback to match Astra — a
//               model that genuinely stops at high must not be offered more.
//   Gemini    — CLI has no effort flag (gemini.ts:buildArgs comment confirms).
//               Value is ignored. Empty array → hide the picker entirely.
//   Ollama    — same as Gemini, no effort flag.
//   Antigravity — operator sets effort inside the desktop app; Arco
//               doesn't pass anything. Hide the picker.
//
// When the array is empty, callers should hide the effort UI rather than
// render an enabled-but-useless control.
export function effortsForProvider(provider: ProviderName | undefined): EffortLevel[] {
  if (provider === 'claude') return ['low', 'medium', 'high', 'xhigh', 'max'];
  if (provider === 'codex') return ['low', 'medium', 'high'];

  // Ollama: `low` injects `/no_think` into the system prompt so Qwen-family
  // models skip reasoning (fast-mode for trivial asks); `high` (or any
  // non-low value) leaves native Thinking Preservation on. Two values keep
  // the picker compact since there's no further inference-cost tier to
  // expose for a local daemon.
  if (provider === 'ollama') return ['low', 'high'];
  // llama.cpp: same /no_think convention via --jinja-aware chat templates.
  if (provider === 'llamacpp') return ['low', 'high'];
  // Strata exposes all four native thinking settings.
  if ((provider === 'strata' || provider === 'deepseek')) return ['none', 'low', 'medium', 'high'];
  // LM Studio (M13): same /no_think convention forwarded over the OpenAI-compat
  // endpoint for Qwen-family models. Two values keep the picker compact.
  if (provider === 'lmstudio') return ['low', 'high'];
  return [];
}

// Convenience: clamp an effort to what the provider actually accepts. Used
// when the operator switches provider mid-flow and the previously-selected
// effort is no longer valid (e.g. picking max on Claude, then switching to
// Codex — clamps to high).
export function clampEffortForProvider(
  effort: EffortLevel,
  provider: ProviderName | undefined,
): EffortLevel {
  const allowed = effortsForProvider(provider);
  if (allowed.length === 0) return effort; // no honored efforts; nothing to clamp
  if (allowed.includes(effort)) return effort;
  // Map xhigh/max to the closest allowed (highest in the list — usually high).
  return allowed[allowed.length - 1];
}

// Per-MODEL effort surface. Resolution order for Claude:
//   1. live catalog (from /api/claude-native/catalog → Anthropic's
//      /v1/models)
//   2. CLAUDE_MODEL_EFFORTS static doc override/fallback (covers aliases like
//      'opus' / 'sonnet' that aren't in /v1/models, and bridges catalog lag)
//   3. effortsForProvider (full set)
// Resolution order for Codex:
//   1. live catalog (from /api/codex/catalog → app-server's model/list,
//      the authoritative source). Codex's enum is wider than Arco's
//      (none/minimal/low/medium/high/xhigh/max/ultra); we filter to the
//      EffortLevel values the picker surfaces.
//   2. CODEX_MODEL_INFO.supportedEfforts (compile-time fallback)
//   3. effortsForProvider (low/medium/high)
export function effortsForModel(
  provider: ProviderName | undefined,
  modelId: ModelName | undefined,
  claudeCatalog?: ClaudeCatalogSnapshot | null,
  codexCatalog?: CodexCatalogSnapshot | null,
): EffortLevel[] {
  const id = typeof modelId === 'string' ? modelId : '';
  if (provider === 'codex' && id) {
    if (codexCatalog && codexCatalog.models.length > 0) {
      const live = codexCatalog.models.find((m) => m.id === id);
      if (live) {
        // Codex's enum carries values Arco has no picker slot for
        // (none/minimal); intersect with the EffortLevel values we surface.
        // 'max' and 'ultra' MUST be in this list — omitting them is how GPT-6
        // Astra's top two levels stayed invisible in the picker on release day
        // (2026-09-04) even though the live catalog advertised both.
        const arcoLevels: EffortLevel[] = [];
        for (const e of live.supportedReasoningEfforts) {
          if (e === 'low' || e === 'medium' || e === 'high' || e === 'xhigh' || e === 'max' || e === 'ultra') arcoLevels.push(e);
        }
        if (arcoLevels.length > 0) return arcoLevels;
      }
    }
    const info = CODEX_MODEL_INFO[id];
    if (info?.supportedEfforts) return info.supportedEfforts;
  }
  if (provider === 'ollama' && id) return ollamaEffortsFor(ollamaThinking[id]);
  if (provider === 'claude' && id) {
    const explicit = CLAUDE_MODEL_EFFORTS[id];
    if (claudeCatalog && claudeCatalog.models.length > 0) {
      const live = claudeCatalog.models.find((m) => m.id === id);
      if (live) {
        if (!explicit) return live.supportedEfforts;
        const liveSet = new Set(live.supportedEfforts);
        const explicitSet = new Set(explicit);
        return effortsForProvider('claude').filter((e) => liveSet.has(e) || explicitSet.has(e));
      }
    }
    if (explicit) return explicit;
  }
  return effortsForProvider(provider);
}

// Same clamp logic, model-aware.
export function clampEffortForModel(
  effort: EffortLevel,
  provider: ProviderName | undefined,
  modelId: ModelName | undefined,
  claudeCatalog?: ClaudeCatalogSnapshot | null,
  codexCatalog?: CodexCatalogSnapshot | null,
): EffortLevel {
  const allowed = effortsForModel(provider, modelId, claudeCatalog, codexCatalog);
  if (allowed.length === 0) return effort;
  if (allowed.includes(effort)) return effort;
  return allowed[allowed.length - 1];
}

// Fill-bar color for the ctx metric. 0–80% → dim, 80–95% → amber, 95%+ → red.
export function contextFillColor(fraction: number): string {
  if (fraction >= 0.95) return 'var(--color-danger, #f04a4a)';
  if (fraction >= 0.80) return 'var(--color-warning)';
  return 'var(--color-accent-primary-dim)';
}

// Color for the Phase 2 context-fill percentage (0–100 integer).
// More aggressive thresholds: green <50%, amber 50–75%, red >75%.
export function contextPercentColor(percent: number): string {
  if (percent >= 75) return 'var(--color-danger, #f04a4a)';
  if (percent >= 50) return 'var(--color-warning)';
  return 'var(--color-accent-primary-dim)';
}

// Human-readable hover-title for the token badge. Shows every component of
// the raw TokenUsage so operators who want the full arithmetic can see it.
// Provider-aware ctx label — for Codex the input field IS the full prompt
// (cacheRead is a subset shown for visibility), for Claude the three input
// flavours are disjoint and the ctx is input+cacheCreate.
export function tokenHoverTitle(t: TokenUsage, labelPrefix?: string, provider?: ProviderName): string {
  const total = totalTokens(t, provider);
  const ctx = contextTokens(t, provider);
  const ctxFormula = provider === 'codex' ? 'input (cacheRead is a subset)' : 'input+cacheCreate';
  const lines: string[] = [];
  if (labelPrefix) lines.push(labelPrefix);
  lines.push(`${total.toLocaleString()} total · ${ctx.toLocaleString()} ctx (${ctxFormula})`);
  lines.push(`${t.input.toLocaleString()} input · ${t.output.toLocaleString()} output`);
  if (t.cacheRead) lines.push(`${t.cacheRead.toLocaleString()} cache-read`);
  if (t.cacheCreate) lines.push(`${t.cacheCreate.toLocaleString()} cache-create`);
  if (t.reasoningOutput) lines.push(`${t.reasoningOutput.toLocaleString()} reasoning-output (subset of output)`);
  if (typeof t.total === 'number') lines.push(`${t.total.toLocaleString()} total (provider-reported)`);
  return lines.join('\n');
}

// Ollama generation speed. Null when there's nothing honest to show (no
// tokens, or a duration too short to divide by). Below ~50ms a rate is noise —
// a one-token tool-call round would read as thousands of tok/s.
export function tokensPerSecond(tokens: number, ms: number): number | null {
  if (!(tokens > 0) || !(ms >= 50)) return null;
  return tokens / (ms / 1000);
}

export function formatTokPerSec(rate: number): string {
  return rate < 10 ? rate.toFixed(1) : String(Math.round(rate));
}
