import type { Theme } from '../types';

// Tarkovsky — Stalker / Mirror register. Sepia-black base, rust primary for
// body/accent, moss secondary used as an occasional chromatic bleed in the
// shader's bright scan bands. Very slow, very warm, heavy grain. Nothing
// pulses; nothing shines. Mood is contemplative, damp, abandoned.
// Fonts: Cormorant Garamond display for a literary mark; IBM Plex Mono
// body/code so long logs stay readable.
// Alpha ramps derive from primary #d89870 (216, 152, 112) and secondary
// #8ca078 (140, 160, 120).
export const tarkovsky: Theme = {
  id: 'tarkovsky',
  name: 'Tarkovsky',
  description: 'The Zone — sepia rust, slow vertical bands, heavy grain',
  mood: 'warm-dark',
  tokens: {
    'color-bg': '#1a120c',
    'color-bg-panel': 'rgba(32, 22, 14, 0.94)',
    'color-bg-input': 'rgba(22, 16, 10, 0.97)',
    'color-bg-elevated': 'rgba(42, 30, 20, 0.97)',

    'color-fg': '#d89870',
    'color-fg-muted': 'rgba(216, 152, 112, 0.50)',

    'color-accent-primary': '#d89870',
    'color-accent-primary-dim': '#986844',
    'color-accent-primary-tint': '#2a180e',
    'color-accent-primary-glow': 'rgba(216, 152, 112, 0.24)',

    'color-accent-secondary': '#8ca078',
    'color-accent-secondary-dim': '#627056',
    'color-accent-secondary-bright': '#a8bc94',
    'color-accent-secondary-glow': 'rgba(140, 160, 120, 0.20)',

    'color-border-hairline': 'rgba(216, 152, 112, 0.14)',
    'color-border-bright': 'rgba(216, 152, 112, 0.34)',

    'color-danger': '#a83a28',
    'color-warning': '#d89870',
    'color-warning-dim': '#986844',
    'color-success': '#8ca078',
    'color-shadow': 'rgba(10, 4, 0, 0.92)',
    'color-bg-sunken': 'rgba(8, 4, 0, 0.55)',

    'color-accent-primary-a03': 'rgba(216, 152, 112, 0.03)',
    'color-accent-primary-a04': 'rgba(216, 152, 112, 0.04)',
    'color-accent-primary-a05': 'rgba(216, 152, 112, 0.05)',
    'color-accent-primary-a06': 'rgba(216, 152, 112, 0.06)',
    'color-accent-primary-a08': 'rgba(216, 152, 112, 0.08)',
    'color-accent-primary-a10': 'rgba(216, 152, 112, 0.10)',
    'color-accent-primary-a15': 'rgba(216, 152, 112, 0.15)',

    'color-accent-secondary-a00': 'rgba(140, 160, 120, 0)',
    'color-accent-secondary-a04': 'rgba(140, 160, 120, 0.04)',
    'color-accent-secondary-a06': 'rgba(140, 160, 120, 0.06)',
    'color-accent-secondary-a08': 'rgba(140, 160, 120, 0.08)',
    'color-accent-secondary-a10': 'rgba(140, 160, 120, 0.10)',
    'color-accent-secondary-a12': 'rgba(140, 160, 120, 0.12)',
    'color-accent-secondary-a20': 'rgba(140, 160, 120, 0.20)',
    'color-accent-secondary-a25': 'rgba(140, 160, 120, 0.25)',
    'color-accent-secondary-a30': 'rgba(140, 160, 120, 0.30)',
    'color-accent-secondary-a55': 'rgba(140, 160, 120, 0.55)',
    'color-accent-secondary-a90': 'rgba(140, 160, 120, 0.90)',
  },
  fonts: {
    display: "'Cormorant Garamond', Garamond, serif",
    body: "'IBM Plex Mono', monospace",
    code: "'IBM Plex Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=IBM+Plex+Mono:wght@300;400;500;600;700&display=swap',
  },
  glyphs: {
    divider: '—',
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
  shaderPreset: 'tarkovsky',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: false, flicker: false, cursorBlink: true },
};
