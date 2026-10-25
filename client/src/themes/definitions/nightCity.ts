import type { Theme } from '../types';

// Night City — aerial view of a sleeping city grid. Near-black blue base,
// window-yellow primary for body/accent, street-lamp white secondary for
// traffic pinpricks. Shader paints an abstract block grid with sparse lit
// windows that flicker on a slow hash schedule and two horizontal + two
// vertical "thoroughfares" with pinprick traffic scrolling along them.
// Fonts: JetBrains Mono — tech-noir register.
// Alpha ramps derive from primary #e8ce80 (232, 206, 128) and secondary
// #d4e0f0 (212, 224, 240).
export const nightCity: Theme = {
  id: 'night-city',
  name: 'Night City',
  description: 'Aerial view — window yellow, traffic pinpricks, sleeping grid',
  mood: 'dark',
  tokens: {
    'color-bg': '#03060c',
    'color-bg-panel': 'rgba(10, 14, 22, 0.94)',
    'color-bg-input': 'rgba(6, 10, 18, 0.97)',
    'color-bg-elevated': 'rgba(16, 22, 32, 0.97)',

    'color-fg': '#e8ce80',
    'color-fg-muted': 'rgba(232, 206, 128, 0.48)',

    'color-accent-primary': '#e8ce80',
    'color-accent-primary-dim': '#a89048',
    'color-accent-primary-tint': '#241e0c',
    'color-accent-primary-glow': 'rgba(232, 206, 128, 0.24)',

    'color-accent-secondary': '#d4e0f0',
    'color-accent-secondary-dim': '#8a9bad',
    'color-accent-secondary-bright': '#e8f0fa',
    'color-accent-secondary-glow': 'rgba(212, 224, 240, 0.22)',

    'color-border-hairline': 'rgba(232, 206, 128, 0.12)',
    'color-border-bright': 'rgba(232, 206, 128, 0.32)',

    'color-danger': '#ff5a58',
    'color-warning': '#e8ce80',
    'color-warning-dim': '#a89048',
    'color-success': '#8ad08a',
    'color-shadow': 'rgba(0, 0, 6, 0.90)',
    'color-bg-sunken': 'rgba(0, 0, 6, 0.55)',

    'color-accent-primary-a03': 'rgba(232, 206, 128, 0.03)',
    'color-accent-primary-a04': 'rgba(232, 206, 128, 0.04)',
    'color-accent-primary-a05': 'rgba(232, 206, 128, 0.05)',
    'color-accent-primary-a06': 'rgba(232, 206, 128, 0.06)',
    'color-accent-primary-a08': 'rgba(232, 206, 128, 0.08)',
    'color-accent-primary-a10': 'rgba(232, 206, 128, 0.10)',
    'color-accent-primary-a15': 'rgba(232, 206, 128, 0.15)',

    'color-accent-secondary-a00': 'rgba(212, 224, 240, 0)',
    'color-accent-secondary-a04': 'rgba(212, 224, 240, 0.04)',
    'color-accent-secondary-a06': 'rgba(212, 224, 240, 0.06)',
    'color-accent-secondary-a08': 'rgba(212, 224, 240, 0.08)',
    'color-accent-secondary-a10': 'rgba(212, 224, 240, 0.10)',
    'color-accent-secondary-a12': 'rgba(212, 224, 240, 0.12)',
    'color-accent-secondary-a20': 'rgba(212, 224, 240, 0.20)',
    'color-accent-secondary-a25': 'rgba(212, 224, 240, 0.25)',
    'color-accent-secondary-a30': 'rgba(212, 224, 240, 0.30)',
    'color-accent-secondary-a55': 'rgba(212, 224, 240, 0.55)',
    'color-accent-secondary-a90': 'rgba(212, 224, 240, 0.90)',
  },
  fonts: {
    display: "'JetBrains Mono', monospace",
    body: "'JetBrains Mono', monospace",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap',
  },
  glyphs: {
    divider: '─',
    cursor: '▌',
    disclosureOpen: '▾',
    disclosureClosed: '▸',
    diamond: '◆',
    bullet: '·',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '1px',
    radiusMd: '2px',
    panelPadding: '14px',
  },
  // Background effect removed by operator preference (2026-06-05) — the
  // twinkling-grid backdrop was too distracting. Palette retained, no backdrop.
  shaderPreset: 'none',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: true, flicker: false, cursorBlink: true },
};
