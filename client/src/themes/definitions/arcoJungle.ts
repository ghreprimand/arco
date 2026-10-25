import type { Theme } from '../types';

// Arco Jungle — ported from OdyTTY's `arco-jungle` builtin (the Arco
// terminal the operator runs). OdyTTY renders this through a GPU bloom pass that pulls
// every bright pixel toward white, so on screen it reads as a cool, almost-white
// mint — much less lime/yellow than the raw .theme palette (#88d8b0 / #50cc60 /
// #d8b030). We deliberately diverge from the spec hexes and tune for the *render*:
// near-white cool-mint foreground, cool bright-mint primary, desaturated pale
// honey secondary. Full Victor Mono (the terminal's font) + CRT bloom + scanline.
//   render targets: fg ~#cdeede  primary ~#90e6c4  bg near-black
export const arcoJungle: Theme = {
  id: 'arco-jungle',
  name: 'Arco Jungle',
  description: 'OdyTTY jungle phosphor — cool near-white mint over moss black',
  mood: 'dark',
  tokens: {
    'color-bg': '#040b08',
    'color-bg-panel': 'rgba(9, 20, 14, 0.95)',
    'color-bg-input': 'rgba(4, 12, 8, 0.97)',
    'color-bg-elevated': 'rgba(14, 30, 20, 0.96)',
    'color-fg': '#9cdfb4',
    'color-fg-muted': 'rgba(156, 223, 180, 0.5)',
    'color-accent-primary': '#90e6c4',
    'color-accent-primary-dim': '#5fb894',
    'color-accent-primary-tint': '#0c2418',
    'color-accent-primary-glow': 'rgba(144, 230, 196, 0.25)',
    'color-accent-secondary': '#d8c88c',
    'color-accent-secondary-dim': '#a89a64',
    'color-accent-secondary-bright': '#ece0b8',
    'color-accent-secondary-glow': 'rgba(216, 200, 140, 0.22)',
    'color-border-hairline': 'rgba(205, 238, 222, 0.12)',
    'color-border-bright': 'rgba(144, 230, 196, 0.38)',
    'color-danger': '#e05555',
    'color-warning': '#d8c070',
    'color-warning-dim': '#8f7e40',
    'color-success': '#90e6c4',
    'color-shadow': 'rgba(0, 0, 0, 0.9)',
    'color-bg-sunken': 'rgba(0, 4, 2, 0.65)',
    'color-accent-primary-a03': 'rgba(144, 230, 196, 0.03)',
    'color-accent-primary-a04': 'rgba(144, 230, 196, 0.04)',
    'color-accent-primary-a05': 'rgba(144, 230, 196, 0.05)',
    'color-accent-primary-a06': 'rgba(144, 230, 196, 0.06)',
    'color-accent-primary-a08': 'rgba(144, 230, 196, 0.08)',
    'color-accent-primary-a10': 'rgba(144, 230, 196, 0.1)',
    'color-accent-primary-a15': 'rgba(144, 230, 196, 0.15)',
    'color-accent-secondary-a00': 'rgba(216, 200, 140, 0)',
    'color-accent-secondary-a04': 'rgba(216, 200, 140, 0.04)',
    'color-accent-secondary-a06': 'rgba(216, 200, 140, 0.06)',
    'color-accent-secondary-a08': 'rgba(216, 200, 140, 0.08)',
    'color-accent-secondary-a10': 'rgba(216, 200, 140, 0.1)',
    'color-accent-secondary-a12': 'rgba(216, 200, 140, 0.12)',
    'color-accent-secondary-a20': 'rgba(216, 200, 140, 0.2)',
    'color-accent-secondary-a25': 'rgba(216, 200, 140, 0.25)',
    'color-accent-secondary-a30': 'rgba(216, 200, 140, 0.3)',
    'color-accent-secondary-a55': 'rgba(216, 200, 140, 0.55)',
    'color-accent-secondary-a90': 'rgba(216, 200, 140, 0.9)',
  },
  fonts: {
    display: "'Victor Mono', monospace",
    body: "'Victor Mono', monospace",
    code: "'Victor Mono', monospace",
    // No googleFontsUrl: Victor Mono is self-hosted in global.css so italics use
    // the Oblique faces, not Google's cursive Italic. Loading Google's faces here
    // would re-register the cursive italic and let it win the style match.
    googleFontsUrl: '',
  },
  glyphs: {
    divider: '❧',
    cursor: '▋',
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
  shaderPreset: 'none',
  borderRenderer: 'css',
  animations: { scan: true, pulseHalo: true, flicker: false, cursorBlink: true },
};
