import type { Theme } from '../types';

// Oscilloscope — 1970s lab-bench instrument, not hacker terminal. P31
// phosphor green-white (cooler and more trace-like than Matrix's saturated
// green), a single sharp red for trigger/danger, no secondary accent hue
// (secondary tracks primary so the UI stays monochrome-phosphor).
// Shader: oscilloscope.frag.glsl — animated waveform with beam persistence,
// fine scanlines, gentle barrel curvature.
// Alpha ramps derive from primary #33ff99 (51, 255, 153) — saturated
// P1-style phosphor green matching the reference tube photograph.
// Secondary matches primary so panel accents stay single-hue.
export const oscilloscope: Theme = {
  id: 'oscilloscope',
  name: 'Oscilloscope',
  description: '1970s lab instrument — P31 phosphor waveform on a tube face',
  mood: 'dark',
  tokens: {
    'color-bg': '#030605',
    'color-bg-panel': 'rgba(6, 14, 10, 0.94)',
    'color-bg-input': 'rgba(4, 10, 7, 0.97)',
    'color-bg-elevated': 'rgba(10, 22, 16, 0.97)',

    'color-fg': '#33ff99',
    'color-fg-muted': 'rgba(51, 255, 153, 0.42)',

    'color-accent-primary': '#33ff99',
    'color-accent-primary-dim': '#1fb870',
    'color-accent-primary-tint': '#0a2a1a',
    'color-accent-primary-glow': 'rgba(51, 255, 153, 0.3)',

    'color-accent-secondary': '#33ff99',
    'color-accent-secondary-dim': '#1fb870',
    'color-accent-secondary-bright': '#7dffbc',
    'color-accent-secondary-glow': 'rgba(51, 255, 153, 0.2)',

    'color-border-hairline': 'rgba(51, 255, 153, 0.14)',
    'color-border-bright': 'rgba(51, 255, 153, 0.36)',

    'color-danger': '#ff3030',
    'color-warning': '#ffd060',
    'color-warning-dim': '#b09440',
    'color-success': '#33ff99',
    'color-shadow': 'rgba(0, 0, 0, 0.9)',
    'color-bg-sunken': 'rgba(2, 4, 3, 0.55)',

    'color-accent-primary-a03': 'rgba(51, 255, 153, 0.03)',
    'color-accent-primary-a04': 'rgba(51, 255, 153, 0.04)',
    'color-accent-primary-a05': 'rgba(51, 255, 153, 0.05)',
    'color-accent-primary-a06': 'rgba(51, 255, 153, 0.06)',
    'color-accent-primary-a08': 'rgba(51, 255, 153, 0.08)',
    'color-accent-primary-a10': 'rgba(51, 255, 153, 0.1)',
    'color-accent-primary-a15': 'rgba(51, 255, 153, 0.15)',

    'color-accent-secondary-a00': 'rgba(51, 255, 153, 0)',
    'color-accent-secondary-a04': 'rgba(51, 255, 153, 0.04)',
    'color-accent-secondary-a06': 'rgba(51, 255, 153, 0.06)',
    'color-accent-secondary-a08': 'rgba(51, 255, 153, 0.08)',
    'color-accent-secondary-a10': 'rgba(51, 255, 153, 0.1)',
    'color-accent-secondary-a12': 'rgba(51, 255, 153, 0.12)',
    'color-accent-secondary-a20': 'rgba(51, 255, 153, 0.2)',
    'color-accent-secondary-a25': 'rgba(51, 255, 153, 0.25)',
    'color-accent-secondary-a30': 'rgba(51, 255, 153, 0.3)',
    'color-accent-secondary-a55': 'rgba(51, 255, 153, 0.55)',
    'color-accent-secondary-a90': 'rgba(51, 255, 153, 0.9)',
  },
  fonts: {
    // Display = Share Tech Mono — wide, angular, instrument-panel face,
    // stays crisp at all UI sizes. Replaces VT323 which rendered
    // bitmap-soft at small sizes (same issue Amber CRT documented in its
    // 2026-04-18 polish pass).
    // Body + code = IBM Plex Mono — clean technical prose + code.
    display: "'Share Tech Mono', monospace",
    body: "'IBM Plex Mono', monospace",
    code: "'IBM Plex Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;700&family=Share+Tech+Mono&display=swap',
  },
  glyphs: {
    divider: '─',
    cursor: '█',
    disclosureOpen: '▼',
    disclosureClosed: '▶',
    diamond: '◆',
    bullet: '■',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '0px',
    radiusMd: '0px',
    panelPadding: '10px',
  },
  shaderPreset: 'oscilloscope',
  borderRenderer: 'css',
  animations: { scan: true, pulseHalo: true, flicker: true, cursorBlink: true },
};
