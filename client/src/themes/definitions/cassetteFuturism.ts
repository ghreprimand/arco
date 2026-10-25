import type { Theme } from '../types';

// Cassette Futurism — 1970s Moog studio. Warm-dark but technological:
// rust-brown deck surface, patch-cable orange primary, cream knob-label
// secondary, muted avocado accents. The anti-digital theme — analog
// warmth, tactile knobs, VU meters.
// Shader: tapeDrift.frag.glsl — warm bottom gradient, fine horizontal
// tape grain drifting right→left, VU-meter pulse in the lower-right.
// Fonts: Space Mono (instrument chrome) + IBM Plex Mono (body/code).
// Kept all-mono for readability; skipped the "classic chunky display
// mono" like Major Mono because it reads as novelty at UI sizes.
// Alpha ramps derive from primary #ff8a3c (255, 138, 60) and secondary
// #ebd9b0 (235, 217, 176).
export const cassetteFuturism: Theme = {
  id: 'cassette-futurism',
  name: 'Cassette Futurism',
  description: '1970s Moog studio — patch-cable orange on warm rust-brown',
  mood: 'warm-dark',
  tokens: {
    'color-bg': '#1a110a',
    'color-bg-panel': 'rgba(28, 20, 14, 0.93)',
    'color-bg-input': 'rgba(20, 14, 10, 0.97)',
    'color-bg-elevated': 'rgba(38, 28, 18, 0.97)',

    'color-fg': '#ebd9b0',
    'color-fg-muted': 'rgba(235, 217, 176, 0.48)',

    'color-accent-primary': '#ff8a3c',
    'color-accent-primary-dim': '#b85f22',
    'color-accent-primary-tint': '#3a1e0a',
    'color-accent-primary-glow': 'rgba(255, 138, 60, 0.25)',

    'color-accent-secondary': '#ebd9b0',
    'color-accent-secondary-dim': '#a89a7c',
    'color-accent-secondary-bright': '#f5ebc8',
    'color-accent-secondary-glow': 'rgba(235, 217, 176, 0.18)',

    'color-border-hairline': 'rgba(255, 138, 60, 0.14)',
    'color-border-bright': 'rgba(255, 138, 60, 0.36)',

    'color-danger': '#e84a3a',
    'color-warning': '#ffcb47',
    'color-warning-dim': '#b88c28',
    'color-success': '#8a9a5b',
    'color-shadow': 'rgba(0, 0, 0, 0.88)',
    'color-bg-sunken': 'rgba(12, 8, 4, 0.55)',

    'color-accent-primary-a03': 'rgba(255, 138, 60, 0.03)',
    'color-accent-primary-a04': 'rgba(255, 138, 60, 0.04)',
    'color-accent-primary-a05': 'rgba(255, 138, 60, 0.05)',
    'color-accent-primary-a06': 'rgba(255, 138, 60, 0.06)',
    'color-accent-primary-a08': 'rgba(255, 138, 60, 0.08)',
    'color-accent-primary-a10': 'rgba(255, 138, 60, 0.1)',
    'color-accent-primary-a15': 'rgba(255, 138, 60, 0.15)',

    'color-accent-secondary-a00': 'rgba(235, 217, 176, 0)',
    'color-accent-secondary-a04': 'rgba(235, 217, 176, 0.04)',
    'color-accent-secondary-a06': 'rgba(235, 217, 176, 0.06)',
    'color-accent-secondary-a08': 'rgba(235, 217, 176, 0.08)',
    'color-accent-secondary-a10': 'rgba(235, 217, 176, 0.1)',
    'color-accent-secondary-a12': 'rgba(235, 217, 176, 0.12)',
    'color-accent-secondary-a20': 'rgba(235, 217, 176, 0.2)',
    'color-accent-secondary-a25': 'rgba(235, 217, 176, 0.25)',
    'color-accent-secondary-a30': 'rgba(235, 217, 176, 0.3)',
    'color-accent-secondary-a55': 'rgba(235, 217, 176, 0.55)',
    'color-accent-secondary-a90': 'rgba(235, 217, 176, 0.9)',
  },
  fonts: {
    display: "'Space Mono', monospace",
    body: "'IBM Plex Mono', monospace",
    code: "'IBM Plex Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;700&family=Space+Mono:wght@400;700&display=swap',
  },
  glyphs: {
    divider: '◈',
    cursor: '▌',
    disclosureOpen: '▾',
    disclosureClosed: '▸',
    diamond: '◇',
    bullet: '●',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '2px',
    radiusMd: '4px',
    panelPadding: '12px',
  },
  shaderPreset: 'tape-drift',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: true, flicker: false, cursorBlink: true },
};
