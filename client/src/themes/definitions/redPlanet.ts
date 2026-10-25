import type { Theme } from '../types';

// Red Planet — faithful palette port from the operator-supplied Paletty
// preview of mbadolato/iTerm2-Color-Schemes. The Core + ANSI values below are
// copied exactly; Archon's role tokens map that terminal vocabulary onto app
// chrome (bright red lead, bright cyan secondary, sand text, moss success).
// Flat charcoal surfaces, JetBrains Mono, no shader: the source identity is
// the palette itself rather than an effect layered over it.
export const redPlanet: Theme = {
  id: 'red-planet',
  name: 'Red Planet',
  description: 'Warm red, sand, and cyan on charcoal — a faithful terminal-palette port',
  mood: 'warm-dark',
  tokens: {
    'color-bg': '#222222',
    'color-bg-panel': '#202020',
    'color-bg-input': '#202020',
    'color-bg-elevated': '#2b2b2b',
    'color-bg-sunken': '#202020',

    'color-fg': '#c2b790',
    'color-fg-muted': '#676767',

    'color-accent-primary': '#b55242',
    'color-accent-primary-dim': '#8c3432',
    'color-accent-primary-tint': '#3a2422',
    'color-accent-primary-glow': 'rgba(181, 82, 66, 0.18)',

    'color-accent-secondary': '#38add8',
    'color-accent-secondary-dim': '#5b8390',
    'color-accent-secondary-bright': '#6bc7e7',
    'color-accent-secondary-glow': 'rgba(56, 173, 216, 0.14)',

    'color-border-hairline': 'rgba(194, 183, 144, 0.12)',
    'color-border-bright': 'rgba(181, 82, 66, 0.42)',

    'color-danger': '#de4974',
    'color-warning': '#e8bf6a',
    'color-warning-dim': '#9f8248',
    'color-success': '#869985',
    'color-shadow': 'rgba(0, 0, 0, 0.78)',

    'color-accent-primary-a03': 'rgba(181, 82, 66, 0.03)',
    'color-accent-primary-a04': 'rgba(181, 82, 66, 0.04)',
    'color-accent-primary-a05': 'rgba(181, 82, 66, 0.05)',
    'color-accent-primary-a06': 'rgba(181, 82, 66, 0.06)',
    'color-accent-primary-a08': 'rgba(181, 82, 66, 0.08)',
    'color-accent-primary-a10': 'rgba(181, 82, 66, 0.1)',
    'color-accent-primary-a15': 'rgba(181, 82, 66, 0.15)',

    'color-accent-secondary-a00': 'rgba(56, 173, 216, 0)',
    'color-accent-secondary-a04': 'rgba(56, 173, 216, 0.04)',
    'color-accent-secondary-a06': 'rgba(56, 173, 216, 0.06)',
    'color-accent-secondary-a08': 'rgba(56, 173, 216, 0.08)',
    'color-accent-secondary-a10': 'rgba(56, 173, 216, 0.1)',
    'color-accent-secondary-a12': 'rgba(56, 173, 216, 0.12)',
    'color-accent-secondary-a20': 'rgba(56, 173, 216, 0.2)',
    'color-accent-secondary-a25': 'rgba(56, 173, 216, 0.25)',
    'color-accent-secondary-a30': 'rgba(56, 173, 216, 0.3)',
    'color-accent-secondary-a55': 'rgba(56, 173, 216, 0.55)',
    'color-accent-secondary-a90': 'rgba(56, 173, 216, 0.9)',
  },
  fonts: {
    display: "'JetBrains Mono', monospace",
    body: "'JetBrains Mono', monospace",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap',
  },
  glyphs: {
    divider: '·',
    cursor: '▋',
    disclosureOpen: '▾',
    disclosureClosed: '▸',
    diamond: '◆',
    bullet: '•',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '3px',
    radiusMd: '6px',
    panelPadding: '12px',
  },
  terminal: {
    background: '#222222',
    foreground: '#c2b790',
    cursor: '#c2b790',
    cursorAccent: '#202020',
    selectionBackground: '#c2b790',
    selectionForeground: '#222222',
    black: '#202020',
    brightBlack: '#676767',
    red: '#8c3432',
    brightRed: '#b55242',
    green: '#728271',
    brightGreen: '#869985',
    yellow: '#e8bf6a',
    brightYellow: '#ebeb91',
    blue: '#69819e',
    brightBlue: '#60827e',
    magenta: '#896492',
    brightMagenta: '#de4974',
    cyan: '#5b8390',
    brightCyan: '#38add8',
    white: '#b9aa99',
    brightWhite: '#d6bfb8',
  },
  shaderPreset: 'none',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: false, flicker: false, cursorBlink: true },
};
