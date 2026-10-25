import type { Theme } from '../types';

// Nebula — Hubble deep field. Near-black violet base, lavender primary,
// cyan-indigo secondary, cathedral register. Shader sums three slow-drifting
// octaves into a density field, hue-cycles between primary/secondary through
// a deep indigo trough, adds a sparse pinprick star field.
// Fonts: Space Mono display (wide, instrument-like), JetBrains Mono body/code
// for legibility at chat sizes. (Experimented with Garamond display — the
// drift of a space theme reads wrong against literary serif.)
// Alpha ramps derive from primary #c4a8f0 (196, 168, 240) and secondary
// #88d8f0 (136, 216, 240).
export const nebula: Theme = {
  id: 'nebula',
  name: 'Nebula',
  description: 'Deep field — violet density, cyan fringe, pinprick stars',
  mood: 'dark',
  tokens: {
    'color-bg': '#06040a',
    'color-bg-panel': 'rgba(14, 10, 22, 0.94)',
    'color-bg-input': 'rgba(10, 6, 16, 0.97)',
    'color-bg-elevated': 'rgba(22, 18, 34, 0.97)',

    'color-fg': '#c4a8f0',
    'color-fg-muted': 'rgba(196, 168, 240, 0.48)',

    'color-accent-primary': '#c4a8f0',
    'color-accent-primary-dim': '#8a74b0',
    'color-accent-primary-tint': '#1c1428',
    'color-accent-primary-glow': 'rgba(196, 168, 240, 0.24)',

    'color-accent-secondary': '#88d8f0',
    'color-accent-secondary-dim': '#5e9bae',
    'color-accent-secondary-bright': '#b4e8f8',
    'color-accent-secondary-glow': 'rgba(136, 216, 240, 0.22)',

    'color-border-hairline': 'rgba(196, 168, 240, 0.12)',
    'color-border-bright': 'rgba(196, 168, 240, 0.32)',

    'color-danger': '#ff6aa0',
    'color-warning': '#ffb880',
    'color-warning-dim': '#b8825a',
    'color-success': '#88d8f0',
    'color-shadow': 'rgba(0, 0, 6, 0.88)',
    'color-bg-sunken': 'rgba(2, 0, 6, 0.55)',

    'color-accent-primary-a03': 'rgba(196, 168, 240, 0.03)',
    'color-accent-primary-a04': 'rgba(196, 168, 240, 0.04)',
    'color-accent-primary-a05': 'rgba(196, 168, 240, 0.05)',
    'color-accent-primary-a06': 'rgba(196, 168, 240, 0.06)',
    'color-accent-primary-a08': 'rgba(196, 168, 240, 0.08)',
    'color-accent-primary-a10': 'rgba(196, 168, 240, 0.10)',
    'color-accent-primary-a15': 'rgba(196, 168, 240, 0.15)',

    'color-accent-secondary-a00': 'rgba(136, 216, 240, 0)',
    'color-accent-secondary-a04': 'rgba(136, 216, 240, 0.04)',
    'color-accent-secondary-a06': 'rgba(136, 216, 240, 0.06)',
    'color-accent-secondary-a08': 'rgba(136, 216, 240, 0.08)',
    'color-accent-secondary-a10': 'rgba(136, 216, 240, 0.10)',
    'color-accent-secondary-a12': 'rgba(136, 216, 240, 0.12)',
    'color-accent-secondary-a20': 'rgba(136, 216, 240, 0.20)',
    'color-accent-secondary-a25': 'rgba(136, 216, 240, 0.25)',
    'color-accent-secondary-a30': 'rgba(136, 216, 240, 0.30)',
    'color-accent-secondary-a55': 'rgba(136, 216, 240, 0.55)',
    'color-accent-secondary-a90': 'rgba(136, 216, 240, 0.90)',
  },
  fonts: {
    display: "'Space Mono', monospace",
    body: "'JetBrains Mono', monospace",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Space+Mono:wght@400;700&display=swap',
  },
  glyphs: {
    divider: '✧',
    cursor: '▌',
    disclosureOpen: '▾',
    disclosureClosed: '▸',
    diamond: '✦',
    bullet: '·',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '2px',
    radiusMd: '4px',
    panelPadding: '14px',
  },
  shaderPreset: 'nebula',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: true, flicker: false, cursorBlink: true },
};
