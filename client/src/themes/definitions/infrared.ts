import type { Theme } from '../types';

// Infrared — false-color thermogram. Deep indigo base, hot amber primary
// (readable against dark), cool indigo-violet secondary used for grain and
// cold-pole tint. Shader pipes a two-octave noise field through a 5-stop
// turbo-ish colormap. Fonts: Space Mono — wide, instrument-ish register.
// Alpha ramps derive from primary #ffd880 (255, 216, 128) and secondary
// #7c7cff (124, 124, 255).
export const infrared: Theme = {
  id: 'infrared',
  name: 'Infrared',
  description: 'Thermogram — indigo cold, amber hot, slow heat drift',
  mood: 'dark',
  tokens: {
    'color-bg': '#08081a',
    'color-bg-panel': 'rgba(14, 14, 30, 0.94)',
    'color-bg-input': 'rgba(10, 10, 24, 0.97)',
    'color-bg-elevated': 'rgba(22, 20, 40, 0.97)',

    'color-fg': '#ffd880',
    'color-fg-muted': 'rgba(255, 216, 128, 0.48)',

    'color-accent-primary': '#ffd880',
    'color-accent-primary-dim': '#b89848',
    'color-accent-primary-tint': '#2a2010',
    'color-accent-primary-glow': 'rgba(255, 216, 128, 0.26)',

    'color-accent-secondary': '#7c7cff',
    'color-accent-secondary-dim': '#5a5ac0',
    'color-accent-secondary-bright': '#a4a4ff',
    'color-accent-secondary-glow': 'rgba(124, 124, 255, 0.22)',

    'color-border-hairline': 'rgba(255, 216, 128, 0.12)',
    'color-border-bright': 'rgba(255, 216, 128, 0.32)',

    'color-danger': '#ff4060',
    'color-warning': '#ffa040',
    'color-warning-dim': '#b87230',
    'color-success': '#88d090',
    'color-shadow': 'rgba(0, 0, 10, 0.85)',
    'color-bg-sunken': 'rgba(2, 2, 12, 0.55)',

    'color-accent-primary-a03': 'rgba(255, 216, 128, 0.03)',
    'color-accent-primary-a04': 'rgba(255, 216, 128, 0.04)',
    'color-accent-primary-a05': 'rgba(255, 216, 128, 0.05)',
    'color-accent-primary-a06': 'rgba(255, 216, 128, 0.06)',
    'color-accent-primary-a08': 'rgba(255, 216, 128, 0.08)',
    'color-accent-primary-a10': 'rgba(255, 216, 128, 0.10)',
    'color-accent-primary-a15': 'rgba(255, 216, 128, 0.15)',

    'color-accent-secondary-a00': 'rgba(124, 124, 255, 0)',
    'color-accent-secondary-a04': 'rgba(124, 124, 255, 0.04)',
    'color-accent-secondary-a06': 'rgba(124, 124, 255, 0.06)',
    'color-accent-secondary-a08': 'rgba(124, 124, 255, 0.08)',
    'color-accent-secondary-a10': 'rgba(124, 124, 255, 0.10)',
    'color-accent-secondary-a12': 'rgba(124, 124, 255, 0.12)',
    'color-accent-secondary-a20': 'rgba(124, 124, 255, 0.20)',
    'color-accent-secondary-a25': 'rgba(124, 124, 255, 0.25)',
    'color-accent-secondary-a30': 'rgba(124, 124, 255, 0.30)',
    'color-accent-secondary-a55': 'rgba(124, 124, 255, 0.55)',
    'color-accent-secondary-a90': 'rgba(124, 124, 255, 0.90)',
  },
  fonts: {
    display: "'Space Mono', monospace",
    body: "'Space Mono', monospace",
    code: "'Space Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap',
  },
  glyphs: {
    divider: '═',
    cursor: '▌',
    disclosureOpen: '▾',
    disclosureClosed: '▸',
    diamond: '◆',
    bullet: '■',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '0px',
    radiusMd: '2px',
    panelPadding: '14px',
  },
  shaderPreset: 'infrared',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: true, flicker: false, cursorBlink: true },
};
