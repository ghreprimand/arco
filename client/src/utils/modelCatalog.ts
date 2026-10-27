import { useMemo } from 'react';
import { CLAUDE_MODEL_LABELS, CLAUDE_MODELS, CODEX_PICKER_MODELS, DEFAULT_CODEX_MODEL, DEFAULT_ZAI_MODEL } from '@arco/shared';
import type { ClaudeCatalogSnapshot, CodexCatalogSnapshot, CursorCatalogSnapshot, ModelName, ProviderName } from '@arco/shared';
import { useAppStore } from '../stores/appStore';

// One provider → model-list resolver for every dialog picker (RUN AS, Review,
// Handoff, Spawn, cluster FRESH-spawn, tab context menu). Before 2026-09 each
// dialog carried its own `modelsFor` / `defaultModelFor` copy and they drifted:
// Review + Handoff never grew the Cursor provider branch described in
// docs/PROVIDERS.md in their provider arrays, so picking
// CURSOR there rendered an empty MODEL row. Rule per provider: live catalog
// first, static fallback second — the same order the composer popover uses.

export interface ModelCatalogs {
  claude: ClaudeCatalogSnapshot | null;
  codex: CodexCatalogSnapshot | null;
  cursor: CursorCatalogSnapshot | null;
  ollamaModels: string[];
  llamacppModels: string[];
  lmstudioModels: string[];
  strataModels: string[];
  deepseekModels?: string[];
  deepseekLabels?: Record<string, string>;
  strataLabels?: Record<string, string>;
  zaiModels: string[];
}

const STATIC_CLAUDE_MODELS: ModelName[] = [...CLAUDE_MODELS] as ModelName[];
const STATIC_CODEX_MODELS: ModelName[] = [...CODEX_PICKER_MODELS];
const STATIC_GEMINI_MODELS: ModelName[] = ['gemini-3.1-flash-lite-preview', 'gemini-3-flash-preview', 'gemini-3.1-pro-preview'];
// Antigravity has no Arco-side model choice — the model is whatever the
// operator picked inside the desktop composer. A stub id keeps the plumbing
// branch-free.
export const ANTIGRAVITY_STUB_MODEL: ModelName = 'antigravity-desktop';
// Cursor cold-catalog seed. `auto` is a real catalog id, not a synthesized one.
const CURSOR_COLD_MODELS: ModelName[] = ['auto'] as ModelName[];

export function modelsForProvider(provider: ProviderName, c: ModelCatalogs): ModelName[] {
  if (provider === 'claude') {
    // Live polled catalog = real model IDs from Anthropic /v1/models. The
    // static aliases only stand in until a Native auth lands a snapshot.
    if (c.claude?.models?.length) return c.claude.models.map((m) => m.id as ModelName);
    return STATIC_CLAUDE_MODELS;
  }
  if (provider === 'codex') {
    if (c.codex?.models?.length) return c.codex.models.filter((m) => !m.hidden).map((m) => m.id as ModelName);
    return STATIC_CODEX_MODELS;
  }
  if (provider === 'cursor') {
    if (c.cursor?.models?.length) return c.cursor.models.map((m) => m.id as ModelName);
    return CURSOR_COLD_MODELS;
  }
  if (provider === 'zai') return c.zaiModels as ModelName[];
  if (provider === 'gemini') return STATIC_GEMINI_MODELS;
  if (provider === 'antigravity') return [ANTIGRAVITY_STUB_MODEL];
  if (provider === 'ollama') return c.ollamaModels as ModelName[];
  if (provider === 'llamacpp') return c.llamacppModels as ModelName[];
  if (provider === 'deepseek') return (c.deepseekModels ?? []) as ModelName[];
  if (provider === 'strata') return c.strataModels as ModelName[];
  if (provider === 'lmstudio') return c.lmstudioModels as ModelName[];
  return [];
}

export function defaultModelForProvider(provider: ProviderName, c: ModelCatalogs): ModelName {
  if (provider === 'claude') {
    if (c.claude?.models?.length) return c.claude.models[0].id as ModelName;
    return 'sonnet';
  }
  if (provider === 'codex') {
    if (c.codex?.models?.length) {
      const def = c.codex.models.find((m) => m.isDefault && !m.hidden) ?? c.codex.models.find((m) => !m.hidden);
      if (def) return def.id as ModelName;
    }
    return DEFAULT_CODEX_MODEL;
  }
  if (provider === 'cursor') {
    const def = c.cursor?.models?.find((m) => m.isDefault) ?? c.cursor?.models?.[0];
    return (def?.id ?? 'auto') as ModelName;
  }
  if (provider === 'zai') return (c.zaiModels[0] ?? DEFAULT_ZAI_MODEL) as ModelName;
  if (provider === 'gemini') return 'gemini-3.1-pro-preview';
  if (provider === 'antigravity') return ANTIGRAVITY_STUB_MODEL;
  if (provider === 'ollama') return (c.ollamaModels[0] ?? '') as ModelName;
  if (provider === 'llamacpp') return (c.llamacppModels[0] ?? '') as ModelName;
  if (provider === 'deepseek') return (c.deepseekModels?.[0] ?? '') as ModelName;
  if (provider === 'strata') return (c.strataModels[0] ?? '') as ModelName;
  if (provider === 'lmstudio') return (c.lmstudioModels[0] ?? '') as ModelName;
  return '' as ModelName;
}

// Display label for Claude pills — prefer the catalog's displayName
// ("Claude Sonnet 4.6" → "SONNET 4.6"), fall back to static aliases.
export function claudeModelLabel(id: string, catalog: ClaudeCatalogSnapshot | null): string {
  const entry = catalog?.models?.find((m) => m.id === id);
  if (entry?.displayName) {
    return entry.displayName.replace(/^Claude\s+/i, '').toUpperCase();
  }
  return CLAUDE_MODEL_LABELS[id] ?? id;
}

// The seven store reads every picker needs, as one memoised object so it can
// sit in a useEffect dep list without re-firing each render. `overrides`
// lets account-scoped dialogs swap in `useCodexCatalogFor(accountRef)` for
// the default-account codex slice. The `?? []` defaults are applied OUTSIDE
// the store selector on purpose — inside one they'd mint a fresh array per
// call and trip React's getSnapshot loop (#185).
export function useModelCatalogs(overrides?: Partial<ModelCatalogs>): ModelCatalogs {
  const authStatus = useAppStore((s) => s.authStatus);
  const claude = useAppStore((s) => s.claudeNativeCatalog);
  const codex = useAppStore((s) => s.codexCatalog);
  const cursor = useAppStore((s) => s.cursorCatalog);
  const oClaude = overrides?.claude;
  const oCodex = overrides?.codex;
  const oCursor = overrides?.cursor;
  return useMemo<ModelCatalogs>(() => ({
    claude: oClaude !== undefined ? oClaude : claude,
    codex: oCodex !== undefined ? oCodex : codex,
    cursor: oCursor !== undefined ? oCursor : cursor,
    ollamaModels: authStatus?.ollama?.installedModels ?? [],
    llamacppModels: authStatus?.llamacpp?.installedModels ?? [],
    deepseekModels: authStatus?.deepseek?.installedModels ?? [],
    deepseekLabels: authStatus?.deepseek?.installedModelLabels,
    strataModels: authStatus?.strata?.installedModels ?? [],
    strataLabels: authStatus?.strata?.installedModelLabels,
    lmstudioModels: authStatus?.lmstudio?.installedModels ?? [],
    zaiModels: authStatus?.zai?.installedModels ?? [DEFAULT_ZAI_MODEL],
  }), [authStatus, claude, codex, cursor, oClaude, oCodex, oCursor]);
}
