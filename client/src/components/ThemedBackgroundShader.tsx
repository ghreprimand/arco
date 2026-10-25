import { lazy, Suspense } from 'react';
import { useAppStore } from '../stores/appStore';
import { THEME_REGISTRY, DEFAULT_THEME_ID } from '../themes/registry';
import { readCachedThemeId } from '../themes/bootstrap';
import { readPhosphorPreferences } from '../themes/phosphor/preferences';

// Code-split gate for the decorative background shader (2026-08-06).
//
// The implementation pulls in three.js (~636 KB) plus 29 `?raw` GLSL programs
// (~120 KB). Those used to sit in the main chunk because App.tsx imported the
// component statically — so every load paid to download, parse and evaluate
// ~750 KB of WebGL machinery even under a theme that never creates a GL
// context. On a 15W ultrabook that is startup latency spent on nothing.
//
// This module is deliberately cheap: the store selector, the theme registry
// (plain object literals) and a preset check. When the active theme has
// `shaderPreset: 'none'` — Arch and the other flat themes — we return null and
// the lazy import is NEVER triggered, so the browser never fetches the chunk
// at all. Shader themes fetch it once on first use; Vite then keeps it cached.
//
// The preset check is duplicated from the impl (which still short-circuits on
// `needsCanvas`) on purpose: the whole point is to decide WITHOUT loading the
// module that holds the real logic. Keep the two in sync.
const ThemedBackgroundShaderImpl = lazy(() => import('./ThemedBackgroundShaderImpl'));
const PhosphorBackdrop = lazy(() => import('../themes/phosphor/PhosphorBackdrop'));

export function ThemedBackgroundShader() {
  // Same themeId resolution as the impl — settings first, then the bootstrap
  // cache, so a reload doesn't briefly gate on the default theme's preset.
  const themeId = useAppStore((s) => s.settings?.themeId ?? readCachedThemeId() ?? DEFAULT_THEME_ID);
  const theme = THEME_REGISTRY[themeId] ?? THEME_REGISTRY[DEFAULT_THEME_ID];
  const effects = useAppStore(s => s.settings?.phosphorEffects ?? readPhosphorPreferences().phosphorEffects);

  if (theme.family === 'phosphor') return effects ? <Suspense fallback={null}><PhosphorBackdrop /></Suspense> : null;

  if (theme.shaderPreset === 'none') return null;

  // fallback={null} matches the pre-split first paint: the canvas is a
  // decorative backdrop, so "not there yet" is exactly what it looked like
  // before the chunk finished loading anyway.
  return (
    <Suspense fallback={null}>
      <ThemedBackgroundShaderImpl />
    </Suspense>
  );
}
