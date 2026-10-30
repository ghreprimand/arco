// ── Model catalogs / effort levels / capability + auth types ──

import type { EffortLevel, ModelName, ProviderName } from './providers.js';

// Claude Code accepts family aliases ("opus") and concrete model names
// ("claude-opus-4-8"). Keep both in the picker so operators can pin a
// known-good version without losing the latest-family aliases.
export const CLAUDE_MODELS = [
  'haiku',
  'sonnet',
  'opus',
  'claude-fable-5-1',
  'claude-fable-5',
  'claude-sonnet-5',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'opus[1m]',
] as const;

export const CLAUDE_MODEL_LABELS: Record<string, string> = {
  haiku: 'HAIKU',
  sonnet: 'SONNET',
  opus: 'OPUS LATEST',
  'claude-fable-5-1': 'FABLE 5.1',
  'claude-fable-5': 'FABLE 5',
  'claude-sonnet-5': 'SONNET 5',
  'claude-opus-5-5': 'OPUS 5.5',
  'claude-opus-5': 'OPUS 5',
  'claude-opus-4-8': 'OPUS 4.8',
  'claude-opus-4-7': 'OPUS 4.7',
  'claude-opus-4-6': 'OPUS 4.6',
  'opus[1m]': 'OPUS 1M',
};

// Codex CLI's GPT family. Frontier first, mini-tier last. Spans GPT-5.x and
// GPT-6 (Astra 2026-09-03; Sol + Luna 2026-09-22; 6.1 Sol 2026-09-29) — don't
// re-pin the naming to a single generation, and don't assume a single-dash
// `gpt-<major>-<name>` shape: 6.1 brought the dotted minor back.
export const CODEX_MODELS = [
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.5',
  'gpt-5.3-codex',
  'gpt-5.2-codex',
  'gpt-5.1-codex-max',
  'gpt-5.4-mini',
  'gpt-5.2',
  'gpt-5.1-codex-mini',
] as const;

export interface CodexModelInfo {
  id: string;
  label: string;
  picker: boolean;
  defaultForCodex?: boolean;
  publishedContextWindow: number;
  publishedMaxOutput: number;
  // Fallback for the CTX bar until Codex emits model_context_window. Public
  // docs usually describe total context (for example 400K with 128K output),
  // while Codex rollouts report the more useful operational input window.
  fallbackOperationalWindow: number;
  // Per-model effort surface. When unset, the provider-default
  // (`['low','medium','high']` for Codex) is used. Set explicitly when a
  // model accepts a wider range — gpt-5.5 honors xhigh, gpt-6-astra goes two
  // further (max, then ultra). This is only the compile-time fallback; the live
  // catalog wins when it has an entry for the model.
  supportedEfforts?: EffortLevel[];
}

export const CODEX_MODEL_INFO: Record<string, CodexModelInfo> = {
  // GPT-6 Astra (2026-09-03). Codex's own catalog reports isDefault:true for it,
  // so it is Arco's default too. Two things here are unlike every 5.x entry:
  // Arco asks for the live catalog maximum by default. This fallback is the
  // current 872K max after Codex's 95% effective-window margin. Its effort
  // surface runs all the way to 'ultra'.
  'gpt-6-astra': {
    id: 'gpt-6-astra',
    label: '6 ASTRA',
    picker: true,
    defaultForCodex: true,
    publishedContextWindow: 1_050_000,
    publishedMaxOutput: 128_000,
    fallbackOperationalWindow: 828_400,
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  // GPT-6 Sol ("workhorse for coding and everyday work") and Luna ("fast and
  // affordable") — 2026-09-22. Same harness fields as Astra in Codex's catalog
  // (tool_mode, shell, apply_patch, 272K standard / 872K max window), so code
  // mode, the MAX context override and effort clamping all come from the live
  // catalog with no per-model code. These entries only cover the cold catalog.
  // The window figures are Codex's catalog max, not an OpenAI-published number;
  // the 128K output cap is unconfirmed (the catalog carries none). Luna stops
  // at 'max' — no 'ultra'.
  'gpt-6-sol': {
    id: 'gpt-6-sol',
    label: '6 SOL',
    picker: true,
    publishedContextWindow: 872_000,
    publishedMaxOutput: 128_000,
    fallbackOperationalWindow: 828_400,
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  // GPT-6.1 Sol (2026-09-29) — "near-Astra performance at a lower cost".
  // Harness fields identical to gpt-6-sol (code_mode_only, freeform
  // apply_patch, 272K standard / 872K max window), so nothing per-model beyond
  // this cold-catalog entry. Two catalog differences worth knowing: Codex's
  // default effort for it is 'low' (6-sol was 'medium'), and its
  // multi_agent_reasoning_effort is 'xhigh' — the effort sub-agents run at
  // under 'ultra' delegation. Codex's live catalog took isDefault away from
  // Astra and gave it to this model on release.
  'gpt-6.1-sol': {
    id: 'gpt-6.1-sol',
    label: '6.1 SOL',
    picker: true,
    publishedContextWindow: 872_000,
    publishedMaxOutput: 128_000,
    fallbackOperationalWindow: 828_400,
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  'gpt-6-luna': {
    id: 'gpt-6-luna',
    label: '6 LUNA',
    picker: true,
    publishedContextWindow: 872_000,
    publishedMaxOutput: 128_000,
    fallbackOperationalWindow: 828_400,
    supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  'gpt-5.5': {
    id: 'gpt-5.5',
    label: '5.5',
    picker: true,
    publishedContextWindow: 400_000,
    publishedMaxOutput: 128_000,
    fallbackOperationalWindow: 272_000,
    supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
  },
  'gpt-5.3-codex': {
    id: 'gpt-5.3-codex',
    label: '5.3 CODEX',
    picker: true,
    publishedContextWindow: 400_000,
    publishedMaxOutput: 128_000,
    fallbackOperationalWindow: 272_000,
  },
  'gpt-5.2-codex': {
    id: 'gpt-5.2-codex',
    label: '5.2 CODEX',
    picker: false,
    publishedContextWindow: 400_000,
    publishedMaxOutput: 128_000,
    fallbackOperationalWindow: 272_000,
  },
  'gpt-5.1-codex-max': {
    id: 'gpt-5.1-codex-max',
    label: '5.1 CODEX MAX',
    picker: false,
    publishedContextWindow: 400_000,
    publishedMaxOutput: 128_000,
    fallbackOperationalWindow: 272_000,
  },
  'gpt-5.4-mini': {
    id: 'gpt-5.4-mini',
    label: '5.4 MINI',
    picker: true,
    publishedContextWindow: 400_000,
    publishedMaxOutput: 128_000,
    fallbackOperationalWindow: 272_000,
  },
  'gpt-5.2': {
    id: 'gpt-5.2',
    label: '5.2',
    picker: false,
    publishedContextWindow: 400_000,
    publishedMaxOutput: 128_000,
    fallbackOperationalWindow: 272_000,
  },
  'gpt-5.1-codex-mini': {
    id: 'gpt-5.1-codex-mini',
    label: '5.1 CODEX MINI',
    picker: false,
    publishedContextWindow: 400_000,
    publishedMaxOutput: 128_000,
    fallbackOperationalWindow: 272_000,
  },
};

export const CODEX_PICKER_MODELS = CODEX_MODELS.filter((id) => CODEX_MODEL_INFO[id]?.picker);
export const DEFAULT_CODEX_MODEL = CODEX_MODELS.find((id) => CODEX_MODEL_INFO[id]?.defaultForCodex) ?? 'gpt-5.5';

// Live catalog shape — populated from Anthropic's /v1/models endpoint
// (server cache; refreshed hourly). Drives the Claude picker, per-model
// effort gating, and the context-window subline. When no auth /
// no fetch yet, the client falls back to CLAUDE_MODELS aliases.
export interface ClaudeCatalogModel {
  id: string;
  displayName: string;
  createdAt: string;
  contextWindow: number;          // max_input_tokens
  maxOutputTokens: number;        // max_tokens
  supportedEfforts: EffortLevel[];
  supportsAdaptiveThinking: boolean;
  supportsBudgetThinking: boolean;
  // Phase 7c-followup — Anthropic /v1/models advertises three
  // context-management capability keys on adaptive-thinking models. Used
  // by the Claude Native worker to gate per-model beta-header inclusion
  // and by the CONFIG-tab toggle to hide the compact row on models that
  // don't support it. Catalog keys (Anthropic): `clear_thinking_20251015`,
  // `clear_tool_uses_20250919`, `compact_20260112`.
  supportsClearThinking: boolean;
  supportsClearToolUses: boolean;
  supportsCompact: boolean;
}

export interface ClaudeCatalogSnapshot {
  fetchedAt: number;
  models: ClaudeCatalogModel[];
  fresh: boolean;
}

// Live Codex model catalog, fetched via the appserver `model/list` JSON-RPC.
// Same lazy-1h-cache pattern as the Claude catalog. Codex's reasoning-effort
// enum on the wire is "none"|"minimal"|"low"|"medium"|"high"|"xhigh"; we keep
// the union narrow to the values the picker actually surfaces.
// Mirrors Codex's ReasoningEffort enum. 'max' and 'ultra' arrived with GPT-6
// Astra (2026-09-03) — before that Codex genuinely did top out at 'xhigh', which
// is why Arco used to collapse its own 'max' down to 'xhigh'. Keep this in
// sync with providers/codex-appserver/bindings/ReasoningEffort.ts.
export type CodexReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export interface CodexCatalogModel {
  id: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  // Sorted ascending by capability so callers can pick the highest available.
  supportedReasoningEfforts: CodexReasoningEffort[];
  defaultReasoningEffort: CodexReasoningEffort;
  supportsImageInput: boolean;
  supportsPersonality: boolean;
  // 'fast' / 'priority' / etc — Codex's speed-tier surface beyond default.
  additionalSpeedTiers: string[];
  // Read from this account's models_cache.json because app-server model/list
  // does not expose them. Optional on cold/older catalogs.
  contextWindow?: number;
  maxContextWindow?: number;
  effectiveContextWindowPercent?: number;
}

export interface CodexCatalogSnapshot {
  fetchedAt: number;
  models: CodexCatalogModel[];
  fresh: boolean;
}

export interface CursorCatalogModel {
  id: string;           // "grok-4.5-xhigh", "auto", "claude-opus-4-8-high"
  displayName: string;  // "Cursor Grok 4.5", "Auto (current, default)"
  isDefault: boolean;   // the `auto` row (cursor-agent marks it "(current, default)")
}

export interface CursorCatalogSnapshot {
  fetchedAt: number;
  models: CursorCatalogModel[];
  fresh: boolean;
}

// ── Cursor model-id parser + family index (Phase 8) ──────────────────────────
//
// `cursor-agent models` returns ~189 ids that are really family × effort × flag
// permutations dumped flat. Rather than list 189 options, the picker groups them
// by FAMILY and offers only the EFFORT / FAST / THINKING variants that actually
// exist for the chosen family. The load-bearing rule: the UI never *synthesizes*
// an id string — it looks up the exact id the catalog advertises via the index
// below. So it is structurally impossible to send `xhigh` when the operator
// picked `high`, and the status chip reads effort *back out* of the resolved id
// rather than trusting `config.primaryEffort` (which the Cursor worker ignores).
//
// The id grammar is irregular and every quirk below is real, from the live
// catalog — do not "simplify" without re-checking against `cursor-agent models`:
//   - effort is a trailing token (`-low`/`-high`/`-xhigh`/`-max`/`-none`) OR
//     absent (bare id = the family's default slot, e.g. `gpt-5.1`, `gpt-5.3-codex`)
//   - `gpt-5.5` spells extra-high as the TWO tokens `-extra-high`, not `-xhigh`
//   - `-fast` is trailing everywhere EXCEPT grok, where it sits mid-id
//     (`grok-4.5-fast-xhigh`)
//   - `-thinking` sits before the effort for opus-4-8 (`…-thinking-high`) but
//     AFTER it for sonnet-4.6 (`claude-4.6-sonnet-medium-thinking`)
//   - family names themselves can end in an effort-looking word
//     (`gpt-5.1-codex-max` is a family; `-max-low` = that family at effort low),
//     so only ONE trailing effort token is ever stripped
//   - `(NO ZDR)` in the display name is a per-family property (fable), not a
//     selectable variant — surfaced as a family badge, never a toggle.
export type CursorEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const CURSOR_EFFORT_TOKENS = new Set<string>(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

export interface CursorParsedModel {
  family: string;               // id stem, e.g. 'claude-opus-4-8', 'grok-4.5', 'gpt-5.6-sol', 'auto'
  effort: CursorEffort | null;  // null = bare id (family default slot, no effort token)
  fast: boolean;
  thinking: boolean;
}

// Parse a catalog id into its (family, effort, flags) coordinates. Pure; total —
// an unknown/edge id degrades to {family: <whole id>, effort:null, fast, thinking}
// rather than throwing, so a future catalog addition can't crash the picker.
export function parseCursorModelId(id: string): CursorParsedModel {
  if (id === 'auto') return { family: 'auto', effort: null, fast: false, thinking: false };
  let fast = false;
  let thinking = false;
  // Strip flag tokens wherever they appear (fast is mid-id for grok, trailing
  // elsewhere; thinking is before/after the effort depending on family). No
  // real family token equals 'fast' or 'thinking', so value-matching is safe.
  const kept: string[] = [];
  for (const t of id.split('-')) {
    if (t === 'fast' && !fast) { fast = true; continue; }
    if (t === 'thinking' && !thinking) { thinking = true; continue; }
    kept.push(t);
  }
  let effort: CursorEffort | null = null;
  const n = kept.length;
  if (n >= 2 && kept[n - 2] === 'extra' && kept[n - 1] === 'high') {
    effort = 'xhigh';              // gpt-5.5's two-token spelling
    kept.splice(n - 2, 2);
  } else if (n >= 1 && CURSOR_EFFORT_TOKENS.has(kept[n - 1])) {
    effort = kept[n - 1] as CursorEffort;
    kept.pop();
  }
  return { family: kept.join('-'), effort, fast, thinking };
}

// Display rank / labels for the effort dropdown. `null` (bare) sorts as the
// family default, between medium and high in the few families that ship it.
export const CURSOR_EFFORT_ORDER: (CursorEffort | null)[] = ['none', 'low', 'medium', null, 'high', 'xhigh', 'max'];
export const CURSOR_EFFORT_LABELS: Record<string, string> = {
  none: 'None', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max', default: 'Default',
};
export function cursorEffortKey(effort: CursorEffort | null): string {
  return effort ?? 'default';
}

export interface CursorFamily {
  family: string;                       // id stem (grouping key)
  label: string;                        // human label (word-common-prefix of member display names)
  isDefault: boolean;                   // the 'auto' family
  noZdr: boolean;                       // every member is "(NO ZDR)" (fable)
  hasFast: boolean;                     // some member has a `-fast` variant
  hasThinking: boolean;                 // some member has a `-thinking` variant
  efforts: (CursorEffort | null)[];     // efforts present across ALL flag combos, display-ordered
}

export interface CursorModelIndex {
  families: CursorFamily[];             // display-ordered (catalog first-appearance, 'auto' first)
  byId: Map<string, CursorParsedModel>; // id -> parsed
  byKey: Map<string, string>;           // selectionKey -> exact catalog id
}

// Selection coordinates -> stable string key for the resolve map.
export function cursorSelectionKey(family: string, effort: CursorEffort | null, fast: boolean, thinking: boolean): string {
  return `${family}|${cursorEffortKey(effort)}|${fast ? 'F' : ''}|${thinking ? 'T' : ''}`;
}

// Longest common leading run of whitespace-separated words across the family's
// display names, after dropping the trailing `(NO ZDR)` / `(current, default)`
// parentheticals. Robust family label without trusting per-row effort words
// (grok's display labels are offset from their ids — a known catalog bug).
function cursorFamilyLabel(displayNames: string[], family: string): string {
  const clean = (s: string) => s.replace(/\s*\((?:NO ZDR|current, default)\)\s*/gi, ' ').trim();
  const wordLists = displayNames.map((d) => clean(d).split(/\s+/).filter(Boolean));
  if (wordLists.length === 0) return family;
  let prefix = wordLists[0];
  for (const words of wordLists.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < words.length && prefix[i] === words[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) break;
  }
  return prefix.length ? prefix.join(' ') : family;
}

// Turn the flat catalog into the family index the picker drives. Deterministic;
// pure. Families are sorted alphabetically by display label so the picker is
// scannable ('auto' pinned first as the default router); catalog first-appearance
// order isn't meaningful to the operator.
export function buildCursorModelIndex(models: CursorCatalogModel[]): CursorModelIndex {
  const byId = new Map<string, CursorParsedModel>();
  const byKey = new Map<string, string>();
  // family stem -> accumulator
  const order: string[] = [];
  const acc = new Map<string, {
    displayNames: string[];
    efforts: Set<string>;        // cursorEffortKey values
    fast: boolean;
    thinking: boolean;
    isDefault: boolean;
    allNoZdr: boolean;
    any: boolean;
  }>();
  for (const m of models) {
    const parsed = parseCursorModelId(m.id);
    byId.set(m.id, parsed);
    byKey.set(cursorSelectionKey(parsed.family, parsed.effort, parsed.fast, parsed.thinking), m.id);
    let a = acc.get(parsed.family);
    if (!a) {
      a = { displayNames: [], efforts: new Set(), fast: false, thinking: false, isDefault: false, allNoZdr: true, any: false };
      acc.set(parsed.family, a);
      order.push(parsed.family);
    }
    a.displayNames.push(m.displayName);
    a.efforts.add(cursorEffortKey(parsed.effort));
    a.fast ||= parsed.fast;
    a.thinking ||= parsed.thinking;
    a.isDefault ||= m.isDefault;
    a.allNoZdr &&= /\(NO ZDR\)/i.test(m.displayName);
    a.any = true;
  }
  const families: CursorFamily[] = order.map((family) => {
    const a = acc.get(family)!;
    const efforts = CURSOR_EFFORT_ORDER.filter((e) => a.efforts.has(cursorEffortKey(e)));
    return {
      family,
      label: family === 'auto' ? 'Auto' : cursorFamilyLabel(a.displayNames, family),
      isDefault: a.isDefault,
      noZdr: a.any && a.allNoZdr,
      hasFast: a.fast,
      hasThinking: a.thinking,
      efforts,
    };
  });
  // Alphabetical by label, 'auto' pinned first. `numeric` so version-numbered
  // families sort naturally (Grok 4 < Grok 4.5 < Grok 10, not lexically).
  families.sort((a, b) => {
    if (a.family === 'auto') return -1;
    if (b.family === 'auto') return 1;
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true });
  });
  return { families, byId, byKey };
}

// Efforts available for a family at the given flag state (only combos that
// resolve to a real id). Display-ordered.
export function cursorEffortsFor(index: CursorModelIndex, family: string, fast: boolean, thinking: boolean): (CursorEffort | null)[] {
  return CURSOR_EFFORT_ORDER.filter((e) => index.byKey.has(cursorSelectionKey(family, e, fast, thinking)));
}

// Resolve selection coordinates to the exact catalog id, or null if that exact
// combination isn't advertised. The picker uses this to snap invalid combos
// (e.g. toggling FAST on an effort with no fast variant) to a real neighbour.
export function resolveCursorModelId(index: CursorModelIndex, family: string, effort: CursorEffort | null, fast: boolean, thinking: boolean): string | null {
  return index.byKey.get(cursorSelectionKey(family, effort, fast, thinking)) ?? null;
}

// Distil the rich /v1/models response into the picker-relevant shape.
// Maps the API's per-effort `{supported}` flags onto our EffortLevel
// union; an empty array means the model doesn't accept the effort
// parameter at all (haiku-4-5 in current catalog).
export function distillCatalogModel(raw: {
  id: string;
  display_name: string;
  created_at: string;
  max_input_tokens: number;
  max_tokens: number;
  capabilities?: {
    effort?: {
      low?: { supported?: boolean };
      medium?: { supported?: boolean };
      high?: { supported?: boolean };
      xhigh?: { supported?: boolean };
      max?: { supported?: boolean };
    };
    thinking?: {
      types?: {
        enabled?: { supported?: boolean };
        adaptive?: { supported?: boolean };
      };
    };
    context_management?: {
      supported?: boolean;
      clear_thinking_20251015?: { supported?: boolean };
      clear_tool_uses_20250919?: { supported?: boolean };
      compact_20260112?: { supported?: boolean };
    };
  };
}): ClaudeCatalogModel {
  const efforts: EffortLevel[] = [];
  const cap = raw.capabilities?.effort;
  if (cap?.low?.supported) efforts.push('low');
  if (cap?.medium?.supported) efforts.push('medium');
  if (cap?.high?.supported) efforts.push('high');
  if (cap?.xhigh?.supported) efforts.push('xhigh');
  if (cap?.max?.supported) efforts.push('max');
  const ctxMgmt = raw.capabilities?.context_management;
  return {
    id: raw.id,
    displayName: raw.display_name,
    createdAt: raw.created_at,
    contextWindow: raw.max_input_tokens,
    maxOutputTokens: raw.max_tokens,
    supportedEfforts: efforts,
    supportsAdaptiveThinking: !!raw.capabilities?.thinking?.types?.adaptive?.supported,
    supportsBudgetThinking: !!raw.capabilities?.thinking?.types?.enabled?.supported,
    supportsClearThinking: !!ctxMgmt?.clear_thinking_20251015?.supported,
    supportsClearToolUses: !!ctxMgmt?.clear_tool_uses_20250919?.supported,
    supportsCompact: !!ctxMgmt?.compact_20260112?.supported,
  };
}

// Pi-derived: opus-4-6+ / sonnet-4-6 / the Claude 5 family use adaptive thinking
// (Claude allocates the thinking budget itself based on `output_config.effort`).
// Older 4.x and 3.x families use budget-based thinking or no thinking at all.
// Used by claude-native worker (request build) AND the client effort picker
// (gating xhigh / max). Single source of truth.
export function supportsClaudeAdaptiveThinking(modelId: string): boolean {
  // The bare family aliases resolve server-side to the newest member of the
  // family — currently claude-opus-5-5 — and every current/future resolution
  // target is adaptive. Without these entries an alias tab silently fell
  // through to no-thinking + DEFAULT_MAX_TOKENS 8192 (Opus-5 plan Phase 2).
  return modelId === 'opus'
    || modelId === 'opus[1m]'
    || modelId.includes('fable-5')
    || modelId.includes('mythos-5')
    || modelId.includes('opus-5')
    || modelId.includes('opus-4-6')
    || modelId.includes('opus-4.6')
    || modelId.includes('opus-4-7')
    || modelId.includes('opus-4.7')
    || modelId.includes('opus-4-8')
    || modelId.includes('opus-4.8')
    || modelId.includes('sonnet-4-6')
    || modelId.includes('sonnet-4.6')
    || modelId.includes('sonnet-5');
}

// -- Fable 5.1 / append-only prefix capabilities (docs/PROVIDERS.md) --
// All keyed on the CONCRETE served id (Native resolves aliases before asking).
// Kept as substring checks like supportsClaudeAdaptiveThinking so a dated
// variant (`claude-fable-5-1-20260901`) lands on the right branch.

// Which models bind thinking-block signatures to the conversation prefix and
// (on enforced accounts) 400 when an earlier turn was edited. Also the models
// that accept `thinking.block_binding` + the binding-controls beta. Opus 5.5
// ships the same preserved-thinking mechanism as Fable 5.1. Note `opus-5-5`,
// not `opus-5`: Opus 5 does not bind and would 400 on block_binding.
export function enforcesPreservedThinking(modelId: string): boolean {
  return modelId.includes('fable-5-1') || modelId.includes('mythos-5-1') || modelId.includes('opus-5-5');
}

// `{role: 'system'}` messages inside `messages[]` (GA, no header). Opus 4.8,
// Opus 5, Fable 5 / 5.1, Mythos 5 / 5.1. NOT Sonnet 5 (docs pages omit it;
// treat as unsupported), not Opus 4.7 or older, not Haiku. The alias `opus`
// resolves to Opus 5 today, but the worker keys on the served concrete id.
export function supportsMidConversationSystemMessages(modelId: string): boolean {
  return modelId.includes('fable-5')
    || modelId.includes('mythos-5')
    || modelId.includes('opus-5')
    || modelId.includes('opus-4-8')
    || modelId.includes('opus-4.8');
}

// `tool_addition` / `tool_removal` blocks under beta
// `mid-conversation-tool-changes-2026-07-01` — "Claude Opus 5 onward".
export function supportsMidConversationToolChanges(modelId: string): boolean {
  return modelId.includes('fable-5')
    || modelId.includes('mythos-5')
    || modelId.includes('opus-5');
}

// `thinking.display: 'updates'` (between-tool-call progress notes) under beta
// `thinking-display-updates-2026-08-18` — Fable 5, Fable 5.1, Mythos 5.1,
// Opus 5.5. On Opus 5.5 the between-tool-call notes that Opus 5 returned as
// `text` come back as thinking blocks, empty under 'omitted'.
export function supportsThinkingDisplayUpdates(modelId: string): boolean {
  return modelId.includes('fable-5') || modelId.includes('mythos-5-1') || modelId.includes('opus-5-5');
}

// Adaptive-thinking display modes the Native worker can request. 'updates' is
// gated per model by supportsThinkingDisplayUpdates and degrades to 'omitted'.
export type ClaudeNativeThinkingDisplay = 'omitted' | 'summarized' | 'updates';

// The picker's bare family aliases. The Claude Code CLI resolves these to the
// newest family member before it calls the API; the Messages API itself does
// NOT — a request with `model: "opus"` comes back
// `not_found_error: model: opus`. They also never appear in /v1/models, so
// catalog-keyed capability lookups miss on them (Opus-5 plan Phase 2 — the
// Native worker substitutes the echoed concrete id instead).
//
// 2026-07-28 incident: the Opus-5 commit's comment claimed the alias could
// ride in the request `model:` field to "keep auto-tracking". It can't — every
// alias tab on the Native transport 404'd on turn 1. Native now resolves the
// alias to a concrete id before the request (see catalog.ts
// resolveClaudeAliasFromCatalog); the CLI transport keeps passing it through.
export function isClaudeModelAlias(modelId: string): boolean {
  return modelId === 'opus' || modelId === 'opus[1m]' || modelId === 'sonnet' || modelId === 'haiku';
}

// Which family an alias names. Concrete ids return null (nothing to resolve).
export function claudeAliasFamily(modelId: string): 'opus' | 'sonnet' | 'haiku' | null {
  if (modelId === 'opus' || modelId === 'opus[1m]') return 'opus';
  if (modelId === 'sonnet') return 'sonnet';
  if (modelId === 'haiku') return 'haiku';
  return null;
}

// Last-resort alias targets for when the live catalog is cold (no Native auth
// yet, fetch failed, first turn after a restart). The catalog is authoritative
// — this map only keeps an alias tab running until it lands, and goes stale by
// design when a new family member ships.
export const CLAUDE_ALIAS_FALLBACK: Record<'opus' | 'sonnet' | 'haiku', string> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001',
};

// Per-Claude-model effort sets. Static fallback and doc override for cases
// where /v1/models is cold or lags the published model behavior.
export const CLAUDE_MODEL_EFFORTS: Record<string, EffortLevel[]> = {
  'claude-fable-5-1': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-mythos-5-1': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-fable-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-mythos-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-6': ['low', 'medium', 'high', 'max'],
  'opus[1m]': ['low', 'medium', 'high', 'xhigh', 'max'],
  opus: ['low', 'medium', 'high', 'xhigh', 'max'],
  sonnet: ['low', 'medium', 'high', 'max'],
  haiku: ['low', 'medium', 'high'],
};

export interface Capabilities {
  efforts: EffortLevel[];
  models: ModelName[];
  cliVersion: string;
  codexVersion?: string;
  // `cursor-agent --version` — date-stamped (e.g. "2026.07.08-0c04a8a"), not
  // semver, and not npm-installed, so there's no upstream `latestVersions.cursor`
  // and no self-update path: display-only in the PROVIDERS popover.
  cursorVersion?: string;
  // Live engine version, falling back to prepared engine/BUILD.json while stopped.
  strataVersion?: string;
  // Xolotl checkout revision; source tracking, not a claim about a rebuilt binary.
  xolotlRevision?: string;
  // Latest published versions from upstream (npm registry for the three
  // npm-installed CLIs, GitHub Releases for Ollama). Best-effort: any
  // probe failure leaves that key undefined and the UI falls back to the
  // installed-only display. Refreshed on the same cadence as the local
  // CLI re-probe.
  latestVersions?: {
    claude?: string;
    codex?: string;
    ollama?: string;
    strata?: string;
    xolotl?: string;
    llamacpp?: string;
  };
}

// Identifies a credential store, not an account or a named profile. Revision
// is an opaque change stamp, never a token. Native has one store per Arco home.
export interface ClaudeCredentialBinding {
  source: 'claude-native' | 'claude-cli';
  storeId: 'claude.native' | 'claude-cli-default';
  revision?: string;
}

export interface ClaudeCliAuthStatus {
  loggedIn: boolean;
  probeFailed?: boolean;
  stale?: boolean;
  checkedAt?: number;
  binding: ClaudeCredentialBinding;
  bindingCheckedAt?: number;
  email?: string;
  subscriptionType?: string;
  orgName?: string;
  apiProvider?: string;
  error?: string;
}

export interface ClaudeNativeAuthStatus {
  state: 'missing' | 'present' | 'refresh-needed' | 'needs-attention' | 'unknown';
  credentialsPresent: boolean;
  // A local status read never verifies an execution request.
  execution: 'unverified';
  binding: ClaudeCredentialBinding;
  checkedAt: number;
  expiresAt?: number;
  scopes?: string[];
  problemSince?: number;
  probeFailed?: boolean;
  stale?: boolean;
  error?: string;
}

export interface AuthStatus {
  loggedIn: boolean;
  // Claude-only: loggedIn means at least one local credential path is
  // available. Transport-specific status and recovery use these fields.
  native?: ClaudeNativeAuthStatus;
  cli?: ClaudeCliAuthStatus;
  // Claude-only: a required status read failed. Transport-specific freshness
  // stays in native/cli; a failed probe must never read as a new logout.
  probeFailed?: boolean;
  email?: string;
  subscriptionType?: string;
  orgName?: string;
  apiProvider?: string;
  error?: string;
  accountStatuses?: Array<{
    id: string;
    label: string;
    shortLabel?: string;
    loggedIn: boolean;
    email?: string;
    apiProvider?: string;
    error?: string;
  }>;
  installedModels?: string[];
  // Optional display names; values sent to providers remain exact model IDs.
  installedModelLabels?: Record<string, string>;
  // Local providers: per-model capabilities and configured context. Strata
  // supplies live modalities + n_ctx from /v1/models.
  // Surfaced to the model picker so it can show "tools"/"vision" affordances
  // and pre-seed the CTX-bar denominator before the first turn fires.
  installedModelCapabilities?: Record<string, {
    tools: boolean;
    vision: boolean;
    thinking: boolean;
    numCtx?: number;
    // Ollama arch max (`<arch>.context_length`) — the operator num_ctx ceiling
    // when the Modelfile sets none. NOT a CTX-bar denominator (numCtx is).
    archCtx?: number;
    // Ollama graded thinking (ascending) — drives the per-model effort picker.
    thinkingLevels?: string[];
    thinkingCanDisable?: boolean;
  }>;
}

export interface AuthStatusByProvider {
  claude: AuthStatus;
  ollama: AuthStatus;
  codex: AuthStatus;
  github: AuthStatus;
  // llama.cpp is local + auth-less like Ollama. loggedIn == llama-server
  // binary present on PATH AND ~/.arco/llamacpp.json parses cleanly. The
  // operator-declared model registry populates installedModels +
  // installedModelCapabilities so the picker UI behaves identically to
  // Ollama's flow (capability badges, ctx-window pre-seed).
  llamacpp: AuthStatus;
  // LM Studio (M13) is a remote OpenAI-compatible runtime. loggedIn ==
  // `GET <baseUrl>/v1/models` reachable. The discovered model ids populate
  // installedModels so the picker behaves like Ollama's (the standing
  // verdict: OpenAI-compat HTTP, not the lmstudio.js SDK). Capability
  // metadata is sparse on /v1/models; the optional `lms` CLI side-channel
  // would enrich it but is a documented follow-up.
  lmstudio: AuthStatus;
  strata: AuthStatus;
  deepseek: AuthStatus;
  // Cursor (ACP): loggedIn == ~/.config/cursor/auth.json carries a session
  // token maintained by `cursor-agent`. No Arco-managed login flow; the
  // operator runs `cursor-agent login` once.
  cursor: AuthStatus;
}

// Fired on WS connect when the server has detected one or more CLI help
// surface changes since the last boot that haven't been acknowledged.
// Drives the red dot on the CONFIG tab + the CLI STATUS card. Cleared
// by writing the `toVersion` to settings.acknowledgedCliVersions.
export interface CliChangeEntry {
  provider: 'claude' | 'codex';
  fromVersion: string;
  toVersion: string;
  newFlags: string[];
  removedFlags: string[];
  diffFileName: string;
}
