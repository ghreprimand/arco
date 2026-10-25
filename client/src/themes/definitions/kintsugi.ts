import type { Theme } from '../types';

// Kintsugi — broken pottery mended with gold. Lacquer-black base, warm gold
// primary, pale ivory secondary. Shader traces slow Worley feature-edge
// "cracks" filled with gold — they breathe over ~30s and wander via slow
// jitter animation. Very restrained; meant to be the quiet, elegant option
// for long reading sessions.
// Fonts: Cormorant Garamond display for a hand-calligraphic display mark,
// IBM Plex Mono body/code for chat legibility.
// Alpha ramps derive from primary #d4b470 (212, 180, 112) and secondary
// #e8dcc4 (232, 220, 196).
export const kintsugi: Theme = {
  id: 'kintsugi',
  name: 'Kintsugi',
  description: 'Lacquered black with slow gold veins — quiet and elegant',
  mood: 'dark',
  tokens: {
    'color-bg': '#0a0807',
    'color-bg-panel': 'rgba(16, 12, 10, 0.95)',
    'color-bg-input': 'rgba(10, 8, 6, 0.97)',
    'color-bg-elevated': 'rgba(22, 18, 14, 0.97)',

    'color-fg': '#d4b470',
    'color-fg-muted': 'rgba(212, 180, 112, 0.48)',

    'color-accent-primary': '#d4b470',
    'color-accent-primary-dim': '#987e4a',
    'color-accent-primary-tint': '#24180c',
    'color-accent-primary-glow': 'rgba(212, 180, 112, 0.24)',

    'color-accent-secondary': '#e8dcc4',
    'color-accent-secondary-dim': '#a89e8a',
    'color-accent-secondary-bright': '#f4ecd8',
    'color-accent-secondary-glow': 'rgba(232, 220, 196, 0.22)',

    'color-border-hairline': 'rgba(212, 180, 112, 0.14)',
    'color-border-bright': 'rgba(212, 180, 112, 0.34)',

    'color-danger': '#b83a30',
    'color-warning': '#d4b470',
    'color-warning-dim': '#987e4a',
    'color-success': '#9ab070',
    'color-shadow': 'rgba(0, 0, 0, 0.92)',
    'color-bg-sunken': 'rgba(0, 0, 0, 0.55)',

    'color-accent-primary-a03': 'rgba(212, 180, 112, 0.03)',
    'color-accent-primary-a04': 'rgba(212, 180, 112, 0.04)',
    'color-accent-primary-a05': 'rgba(212, 180, 112, 0.05)',
    'color-accent-primary-a06': 'rgba(212, 180, 112, 0.06)',
    'color-accent-primary-a08': 'rgba(212, 180, 112, 0.08)',
    'color-accent-primary-a10': 'rgba(212, 180, 112, 0.10)',
    'color-accent-primary-a15': 'rgba(212, 180, 112, 0.15)',

    'color-accent-secondary-a00': 'rgba(232, 220, 196, 0)',
    'color-accent-secondary-a04': 'rgba(232, 220, 196, 0.04)',
    'color-accent-secondary-a06': 'rgba(232, 220, 196, 0.06)',
    'color-accent-secondary-a08': 'rgba(232, 220, 196, 0.08)',
    'color-accent-secondary-a10': 'rgba(232, 220, 196, 0.10)',
    'color-accent-secondary-a12': 'rgba(232, 220, 196, 0.12)',
    'color-accent-secondary-a20': 'rgba(232, 220, 196, 0.20)',
    'color-accent-secondary-a25': 'rgba(232, 220, 196, 0.25)',
    'color-accent-secondary-a30': 'rgba(232, 220, 196, 0.30)',
    'color-accent-secondary-a55': 'rgba(232, 220, 196, 0.55)',
    'color-accent-secondary-a90': 'rgba(232, 220, 196, 0.90)',
  },
  fonts: {
    display: "'Cormorant Garamond', Garamond, serif",
    body: "'IBM Plex Mono', monospace",
    code: "'IBM Plex Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=IBM+Plex+Mono:wght@300;400;500;600;700&display=swap',
  },
  glyphs: {
    divider: '⟡',
    cursor: '|',
    disclosureOpen: '▾',
    disclosureClosed: '▸',
    diamond: '◆',
    bullet: '·',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '2px',
    radiusMd: '4px',
    panelPadding: '16px',
  },
  // Background effect removed by operator preference (2026-06-05) — the slow
  // gold-vein Worley shader was distracting. Kept the palette; no backdrop.
  shaderPreset: 'none',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: true, flicker: false, cursorBlink: true },
};
