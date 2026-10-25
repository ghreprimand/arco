import type { Theme } from '../types';

// Arrakis — dune at night. Warm-dark: burnt black bg, ochre primary, rust
// for danger, pale bone text. Cormorant serif display font evokes the
// Villeneuve/Herbert wide-spaced lettering. The theme's warmth is the
// main differentiator — every other dark theme in the set is either cool
// or neutral. Mood = 'warm-dark'.
// Shader: heatHaze.frag.glsl — slow horizontal shimmer, fine sand grain,
// two soft dust bands drifting at different altitudes.
// Alpha ramps derive from primary #c48f4a (196, 143, 74) and secondary
// #d8c9a8 (216, 201, 168).
export const arrakis: Theme = {
  id: 'arrakis',
  name: 'Arrakis',
  description: 'Dune at night — ochre and rust over burnt black',
  mood: 'warm-dark',
  tokens: {
    'color-bg': '#0f0a06',
    'color-bg-panel': 'rgba(22, 16, 10, 0.93)',
    'color-bg-input': 'rgba(16, 11, 7, 0.97)',
    'color-bg-elevated': 'rgba(32, 24, 16, 0.97)',

    'color-fg': '#d8c9a8',
    'color-fg-muted': 'rgba(216, 201, 168, 0.45)',

    'color-accent-primary': '#c48f4a',
    'color-accent-primary-dim': '#8a6328',
    'color-accent-primary-tint': '#2e1e0c',
    'color-accent-primary-glow': 'rgba(196, 143, 74, 0.22)',

    'color-accent-secondary': '#d8c9a8',
    'color-accent-secondary-dim': '#a39476',
    'color-accent-secondary-bright': '#ece0c2',
    'color-accent-secondary-glow': 'rgba(216, 201, 168, 0.15)',

    'color-border-hairline': 'rgba(196, 143, 74, 0.12)',
    'color-border-bright': 'rgba(196, 143, 74, 0.32)',

    'color-danger': '#8a2a1a',
    'color-warning': '#c48f4a',
    'color-warning-dim': '#8a6328',
    'color-success': '#a8b47a',
    'color-shadow': 'rgba(0, 0, 0, 0.9)',
    'color-bg-sunken': 'rgba(8, 5, 3, 0.55)',

    'color-accent-primary-a03': 'rgba(196, 143, 74, 0.03)',
    'color-accent-primary-a04': 'rgba(196, 143, 74, 0.04)',
    'color-accent-primary-a05': 'rgba(196, 143, 74, 0.05)',
    'color-accent-primary-a06': 'rgba(196, 143, 74, 0.06)',
    'color-accent-primary-a08': 'rgba(196, 143, 74, 0.08)',
    'color-accent-primary-a10': 'rgba(196, 143, 74, 0.1)',
    'color-accent-primary-a15': 'rgba(196, 143, 74, 0.15)',

    'color-accent-secondary-a00': 'rgba(216, 201, 168, 0)',
    'color-accent-secondary-a04': 'rgba(216, 201, 168, 0.04)',
    'color-accent-secondary-a06': 'rgba(216, 201, 168, 0.06)',
    'color-accent-secondary-a08': 'rgba(216, 201, 168, 0.08)',
    'color-accent-secondary-a10': 'rgba(216, 201, 168, 0.1)',
    'color-accent-secondary-a12': 'rgba(216, 201, 168, 0.12)',
    'color-accent-secondary-a20': 'rgba(216, 201, 168, 0.2)',
    'color-accent-secondary-a25': 'rgba(216, 201, 168, 0.25)',
    'color-accent-secondary-a30': 'rgba(216, 201, 168, 0.3)',
    'color-accent-secondary-a55': 'rgba(216, 201, 168, 0.55)',
    'color-accent-secondary-a90': 'rgba(216, 201, 168, 0.9)',
  },
  fonts: {
    // Display = Cinzel — stone-carved Roman caps, wide letterforms; reads
    // as temple inscription or title card, very Villeneuve/Herbert.
    // Body = Lora — designed for screens, warm readable serif; replaces
    // Cormorant Garamond which was too thin/literary at UI sizes.
    // Code = IBM Plex Mono — clean technical counterpoint to the serifs.
    display: "'Cinzel', serif",
    body: "'Lora', serif",
    code: "'IBM Plex Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;500;600;700&family=Lora:wght@400;500;600;700&family=IBM+Plex+Mono:wght@300;400;500;700&display=swap',
  },
  glyphs: {
    divider: '☉',
    cursor: '▌',
    disclosureOpen: '▾',
    disclosureClosed: '▸',
    diamond: '⌬',
    bullet: '⋄',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '1px',
    radiusMd: '2px',
    panelPadding: '14px',
  },
  // Background effect removed by operator preference (2026-06-05) — the
  // heat-haze shimmer was distracting. Palette retained, no backdrop.
  shaderPreset: 'none',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: true, flicker: false, cursorBlink: true },
};
