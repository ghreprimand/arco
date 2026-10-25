import type { ProviderName } from '@archon/shared';
import type { Theme } from './types';

// Provider auto-tint (idea ported from the Odysseus gpt/claude "mimic the app"
// themes, 2026-06-05). Archon is a multi-provider workbench, so the novel move
// is a single `provider-auto` theme that re-tints the whole UI to match the
// ACTIVE tab's provider — Claude tab → Claude clay, Codex tab → OpenAI green,
// Gemini tab → Google blue, etc. The picker shows only `provider-auto`; the
// per-provider palettes below are resolved at apply time from the active job's
// primaryProvider (see appStore.applyResolvedTheme).
//
// These are deliberately flat, opaque, distraction-free brand palettes
// (shaderPreset 'none', no frosted) — the point is "you can tell which provider
// you're talking to at a glance," not another animated backdrop.

type RGB = [number, number, number];

interface ProviderPalette {
  id: string;
  name: string;
  description: string;
  bg: string;
  panel: string;
  input: string;
  elevated: string;
  fg: string;
  fgRgb: RGB;
  fgMuted: number;
  primary: string;
  primaryRgb: RGB;
  primaryDim: string;
  primaryTint: string;
  secondary: string;
  secondaryRgb: RGB;
  secondaryDim: string;
  secondaryBright: string;
  danger: string;
  warning: string;
  warningDim: string;
  success: string;
}

const rgba = ([r, g, b]: RGB, a: number | string) => `rgba(${r}, ${g}, ${b}, ${a})`;

function ramp(prefix: string, rgb: RGB, stops: number[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (const s of stops) {
    o[`${prefix}-a${String(s).padStart(2, '0')}`] = rgba(rgb, s === 0 ? '0' : s / 100);
  }
  return o;
}

// Shared chrome for every provider theme — same fonts/glyphs/density so swapping
// providers only changes color, never layout. Mono-forward like the workbench's
// default voice.
const SHARED = {
  fonts: {
    display: "'Inter', system-ui, sans-serif",
    body: "'Inter', system-ui, sans-serif",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
  },
  glyphs: { divider: '·', cursor: '▋', disclosureOpen: '▾', disclosureClosed: '▸', diamond: '◆', bullet: '·' },
  density: { spacingUnit: '4px', borderWidth: '1px', radiusSm: '4px', radiusMd: '8px', panelPadding: '14px' },
} as const;

function buildProviderTheme(p: ProviderPalette): Theme {
  const tokens: Record<string, string> = {
    'color-bg': p.bg,
    'color-bg-panel': p.panel,
    'color-bg-input': p.input,
    'color-bg-elevated': p.elevated,
    'color-fg': p.fg,
    'color-fg-muted': rgba(p.fgRgb, p.fgMuted),
    'color-accent-primary': p.primary,
    'color-accent-primary-dim': p.primaryDim,
    'color-accent-primary-tint': p.primaryTint,
    'color-accent-primary-glow': rgba(p.primaryRgb, 0.25),
    'color-accent-secondary': p.secondary,
    'color-accent-secondary-dim': p.secondaryDim,
    'color-accent-secondary-bright': p.secondaryBright,
    'color-accent-secondary-glow': rgba(p.secondaryRgb, 0.22),
    'color-border-hairline': rgba(p.fgRgb, 0.12),
    'color-border-bright': rgba(p.primaryRgb, 0.38),
    'color-danger': p.danger,
    'color-warning': p.warning,
    'color-warning-dim': p.warningDim,
    'color-success': p.success,
    'color-shadow': 'rgba(0, 0, 0, 0.85)',
    'color-bg-sunken': 'rgba(0, 0, 0, 0.45)',
    ...ramp('color-accent-primary', p.primaryRgb, [3, 4, 5, 6, 8, 10, 15]),
    ...ramp('color-accent-secondary', p.secondaryRgb, [0, 4, 6, 8, 10, 12, 20, 25, 30, 55, 90]),
  };
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    mood: 'dark',
    tokens,
    fonts: { ...SHARED.fonts },
    glyphs: { ...SHARED.glyphs },
    density: { ...SHARED.density },
    shaderPreset: 'none',
    borderRenderer: 'css',
    animations: { scan: false, pulseHalo: true, flicker: false, cursorBlink: true },
  };
}

// Per-provider brand palettes. Keyed by ProviderName.
export const PROVIDER_THEMES: Record<ProviderName, Theme> = {
  claude: buildProviderTheme({
    id: 'provider-claude', name: 'Claude', description: "Anthropic — warm graphite and clay",
    bg: '#262624', panel: 'rgba(48, 48, 46, 0.95)', input: 'rgba(34, 34, 32, 0.97)', elevated: 'rgba(58, 58, 55, 0.96)',
    fg: '#f5f4f0', fgRgb: [245, 244, 240], fgMuted: 0.55,
    primary: '#cc785c', primaryRgb: [204, 120, 92], primaryDim: '#9c5742', primaryTint: '#3a2620',
    secondary: '#b5a690', secondaryRgb: [181, 166, 144], secondaryDim: '#8a7c66', secondaryBright: '#d4c8b2',
    danger: '#d9544d', warning: '#d9a441', warningDim: '#8f6d2c', success: '#8aab73',
  }),
  codex: buildProviderTheme({
    id: 'provider-codex', name: 'Codex', description: 'OpenAI — graphite and signal green',
    bg: '#1a1a1a', panel: 'rgba(38, 38, 38, 0.95)', input: 'rgba(26, 26, 26, 0.97)', elevated: 'rgba(48, 48, 48, 0.96)',
    fg: '#ececec', fgRgb: [236, 236, 236], fgMuted: 0.55,
    primary: '#19c37d', primaryRgb: [25, 195, 125], primaryDim: '#138a59', primaryTint: '#0d2c20',
    secondary: '#9a9aa8', secondaryRgb: [154, 154, 168], secondaryDim: '#70707e', secondaryBright: '#c2c2d0',
    danger: '#ef4444', warning: '#e0b341', warningDim: '#94762c', success: '#19c37d',
  }),
  zai: buildProviderTheme({
    id: 'provider-zai', name: 'Z.ai', description: 'Z.ai GLM — graphite and electric cyan',
    bg: '#17191b', panel: 'rgba(34, 37, 40, 0.95)', input: 'rgba(22, 24, 26, 0.97)', elevated: 'rgba(44, 48, 52, 0.96)',
    fg: '#e9edf0', fgRgb: [233, 237, 240], fgMuted: 0.54,
    primary: '#35c7d8', primaryRgb: [53, 199, 216], primaryDim: '#248996', primaryTint: '#0e3035',
    secondary: '#9aa7b1', secondaryRgb: [154, 167, 177], secondaryDim: '#71808a', secondaryBright: '#c0cbd3',
    danger: '#ef5350', warning: '#dfb64a', warningDim: '#927833', success: '#54c38c',
  }),
  gemini: buildProviderTheme({
    id: 'provider-gemini', name: 'Gemini', description: 'Google — signal blue and violet',
    bg: '#1b1c1f', panel: 'rgba(38, 39, 43, 0.95)', input: 'rgba(27, 28, 31, 0.97)', elevated: 'rgba(48, 50, 55, 0.96)',
    fg: '#e3e3e3', fgRgb: [227, 227, 227], fgMuted: 0.55,
    primary: '#5b9bf6', primaryRgb: [91, 155, 246], primaryDim: '#3a6cb8', primaryTint: '#16243a',
    secondary: '#a98bdb', secondaryRgb: [169, 139, 219], secondaryDim: '#7d61ab', secondaryBright: '#c6b0ea',
    danger: '#ef5350', warning: '#e6b54a', warningDim: '#977430', success: '#5cc98a',
  }),
  antigravity: buildProviderTheme({
    id: 'provider-antigravity', name: 'Antigravity', description: 'Google Antigravity — deep violet',
    bg: '#16131f', panel: 'rgba(32, 27, 44, 0.95)', input: 'rgba(22, 18, 31, 0.97)', elevated: 'rgba(42, 35, 56, 0.96)',
    fg: '#e8e3f2', fgRgb: [232, 227, 242], fgMuted: 0.52,
    primary: '#a78bfa', primaryRgb: [167, 139, 250], primaryDim: '#7657c4', primaryTint: '#241a3a',
    secondary: '#7c9fe0', secondaryRgb: [124, 159, 224], secondaryDim: '#5573ad', secondaryBright: '#a6c0ef',
    danger: '#e85d6e', warning: '#dcab4f', warningDim: '#937134', success: '#83c08c',
  }),
  ollama: buildProviderTheme({
    id: 'provider-ollama', name: 'Ollama', description: 'Local Ollama — neutral slate',
    bg: '#18181b', panel: 'rgba(36, 36, 40, 0.95)', input: 'rgba(24, 24, 27, 0.97)', elevated: 'rgba(46, 46, 51, 0.96)',
    fg: '#e4e4e7', fgRgb: [228, 228, 231], fgMuted: 0.52,
    primary: '#b4b4bd', primaryRgb: [180, 180, 189], primaryDim: '#7d7d86', primaryTint: '#28282c',
    secondary: '#8a8a94', secondaryRgb: [138, 138, 148], secondaryDim: '#62626c', secondaryBright: '#b6b6c0',
    danger: '#d9544d', warning: '#cfa54a', warningDim: '#8a6e30', success: '#7fae7f',
  }),
  llamacpp: buildProviderTheme({
    id: 'provider-llamacpp', name: 'llama.cpp', description: 'Local llama.cpp — warm terracotta',
    bg: '#1c1714', panel: 'rgba(36, 28, 24, 0.95)', input: 'rgba(26, 20, 16, 0.97)', elevated: 'rgba(46, 36, 28, 0.96)',
    fg: '#ece1d4', fgRgb: [236, 225, 212], fgMuted: 0.52,
    primary: '#d98e5a', primaryRgb: [217, 142, 90], primaryDim: '#a3653a', primaryTint: '#321f12',
    secondary: '#b59070', secondaryRgb: [181, 144, 112], secondaryDim: '#876a50', secondaryBright: '#d4b496',
    danger: '#d95a47', warning: '#d9a84a', warningDim: '#8f6e30', success: '#9aab66',
  }),
  // M13 — LM Studio. Cool indigo/violet to read as distinct from llama.cpp's
  // terracotta and Ollama's neutral slate (the other two local runtimes).
  lmstudio: buildProviderTheme({
    id: 'provider-lmstudio', name: 'LM Studio', description: 'Local LM Studio — cool indigo',
    bg: '#15161d', panel: 'rgba(30, 32, 44, 0.95)', input: 'rgba(20, 21, 29, 0.97)', elevated: 'rgba(40, 42, 58, 0.96)',
    fg: '#e2e3ef', fgRgb: [226, 227, 239], fgMuted: 0.52,
    primary: '#8b95f2', primaryRgb: [139, 149, 242], primaryDim: '#5d65b3', primaryTint: '#1d2038',
    secondary: '#9499c2', secondaryRgb: [148, 153, 194], secondaryDim: '#6a6e92', secondaryBright: '#b9bce0',
    danger: '#d9544d', warning: '#cfa54a', warningDim: '#8a6e30', success: '#7fae8f',
  }),
  strata: buildProviderTheme({
    id: 'provider-strata', name: 'Strata', description: 'Local Strata — cool indigo',
    bg: '#15161d', panel: 'rgba(30, 32, 44, 0.95)', input: 'rgba(20, 21, 29, 0.97)', elevated: 'rgba(40, 42, 58, 0.96)',
    fg: '#e2e3ef', fgRgb: [226, 227, 239], fgMuted: 0.52,
    primary: '#e5ae71', primaryRgb: [229, 174, 113], primaryDim: '#5d65b3', primaryTint: '#1d2038',
    secondary: '#9499c2', secondaryRgb: [148, 153, 194], secondaryDim: '#6a6e92', secondaryBright: '#b9bce0',
    danger: '#d9544d', warning: '#cfa54a', warningDim: '#8a6e30', success: '#7fae8f',
  }),
  deepseek: buildProviderTheme({
    id: 'provider-deepseek', name: 'Xolotl', description: 'Xolotl · DeepSeek Exact / Light',
    bg: '#15161d', panel: 'rgba(30, 32, 44, 0.95)', input: 'rgba(20, 21, 29, 0.97)', elevated: 'rgba(40, 42, 58, 0.96)',
    fg: '#e2e3ef', fgRgb: [226, 227, 239], fgMuted: 0.52,
    primary: '#64a8fa', primaryRgb: [100, 168, 250], primaryDim: '#5d65b3', primaryTint: '#1d2038',
    secondary: '#9499c2', secondaryRgb: [148, 153, 194], secondaryDim: '#6a6e92', secondaryBright: '#b9bce0',
    danger: '#d9544d', warning: '#cfa54a', warningDim: '#8a6e30', success: '#7fae8f',
  }),
  // Cursor (ACP) — near-monochrome graphite (Cursor's black/white brand) lifted
  // by a cool steel-cyan accent so it reads distinct from the other providers.
  cursor: buildProviderTheme({
    id: 'provider-cursor', name: 'Cursor', description: 'Cursor — graphite and steel cyan',
    bg: '#161719', panel: 'rgba(31, 33, 36, 0.95)', input: 'rgba(21, 22, 24, 0.97)', elevated: 'rgba(42, 44, 48, 0.96)',
    fg: '#e8eaec', fgRgb: [232, 234, 236], fgMuted: 0.52,
    primary: '#6cc6d6', primaryRgb: [108, 198, 214], primaryDim: '#468d99', primaryTint: '#14262b',
    secondary: '#9aa3a8', secondaryRgb: [154, 163, 168], secondaryDim: '#6c757a', secondaryBright: '#c3ccd0',
    danger: '#d9574d', warning: '#cca94e', warningDim: '#88702f', success: '#7bae94',
  }),
};

// The picker-visible sentinel. Its own tokens are a neutral slate used only as
// the first-paint / no-active-job fallback before a provider is known.
export const providerAuto: Theme = {
  ...buildProviderTheme({
    id: 'provider-auto', name: 'Provider Auto', description: "Auto-tints to the active tab's provider",
    bg: '#1a1a1d', panel: 'rgba(38, 38, 42, 0.95)', input: 'rgba(26, 26, 29, 0.97)', elevated: 'rgba(48, 48, 53, 0.96)',
    fg: '#e6e6ea', fgRgb: [230, 230, 234], fgMuted: 0.52,
    primary: '#8ab4f8', primaryRgb: [138, 180, 248], primaryDim: '#5a7cb0', primaryTint: '#1c2738',
    secondary: '#9a9aa8', secondaryRgb: [154, 154, 168], secondaryDim: '#70707e', secondaryBright: '#c2c2d0',
    danger: '#d9544d', warning: '#d9a441', warningDim: '#8f6d2c', success: '#8aab73',
  }),
  id: 'provider-auto',
  name: 'Provider Auto',
};

export const PROVIDER_AUTO_ID = 'provider-auto';

// Resolve the concrete Theme to apply for a given selected themeId + active
// provider. Only `provider-auto` is dynamic; every other id is a no-op here
// (the caller falls back to THEME_REGISTRY).
export function resolveProviderTheme(provider: ProviderName | null | undefined): Theme {
  if (provider && PROVIDER_THEMES[provider]) return PROVIDER_THEMES[provider];
  return providerAuto;
}
