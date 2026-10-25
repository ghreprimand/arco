import type { Theme } from '../types';

// Sonar — WWII ASDIC display transposed into a workbench. Deep green-black
// base, phosphor-green primary, pale-green contact dots secondary. Shader
// draws a rotating angular sweep from the bottom-center, a faint polar
// grid, and four persistent "contact" dots that fade over a sweep cycle.
// Sweep period tightens with uTension (6s calm, 2s crisis).
// Fonts: Space Mono — military-instrument register.
// Alpha ramps derive from primary #8cf090 (140, 240, 144) and secondary
// #d4f4d0 (212, 244, 208).
export const sonar: Theme = {
  id: 'sonar',
  name: 'Sonar',
  description: 'ASDIC sweep — phosphor grid, rotating wedge, fading contacts',
  mood: 'dark',
  tokens: {
    'color-bg': '#02080a',
    'color-bg-panel': 'rgba(6, 14, 12, 0.94)',
    'color-bg-input': 'rgba(4, 10, 8, 0.97)',
    'color-bg-elevated': 'rgba(14, 22, 18, 0.97)',

    'color-fg': '#8cf090',
    'color-fg-muted': 'rgba(140, 240, 144, 0.46)',

    'color-accent-primary': '#8cf090',
    'color-accent-primary-dim': '#5ab05e',
    'color-accent-primary-tint': '#0c2412',
    'color-accent-primary-glow': 'rgba(140, 240, 144, 0.26)',

    'color-accent-secondary': '#d4f4d0',
    'color-accent-secondary-dim': '#98b494',
    'color-accent-secondary-bright': '#e8fce4',
    'color-accent-secondary-glow': 'rgba(212, 244, 208, 0.22)',

    'color-border-hairline': 'rgba(140, 240, 144, 0.12)',
    'color-border-bright': 'rgba(140, 240, 144, 0.32)',

    'color-danger': '#ff5a5a',
    'color-warning': '#ffbb60',
    'color-warning-dim': '#b88244',
    'color-success': '#8cf090',
    'color-shadow': 'rgba(0, 4, 0, 0.88)',
    'color-bg-sunken': 'rgba(0, 4, 2, 0.55)',

    'color-accent-primary-a03': 'rgba(140, 240, 144, 0.03)',
    'color-accent-primary-a04': 'rgba(140, 240, 144, 0.04)',
    'color-accent-primary-a05': 'rgba(140, 240, 144, 0.05)',
    'color-accent-primary-a06': 'rgba(140, 240, 144, 0.06)',
    'color-accent-primary-a08': 'rgba(140, 240, 144, 0.08)',
    'color-accent-primary-a10': 'rgba(140, 240, 144, 0.10)',
    'color-accent-primary-a15': 'rgba(140, 240, 144, 0.15)',

    'color-accent-secondary-a00': 'rgba(212, 244, 208, 0)',
    'color-accent-secondary-a04': 'rgba(212, 244, 208, 0.04)',
    'color-accent-secondary-a06': 'rgba(212, 244, 208, 0.06)',
    'color-accent-secondary-a08': 'rgba(212, 244, 208, 0.08)',
    'color-accent-secondary-a10': 'rgba(212, 244, 208, 0.10)',
    'color-accent-secondary-a12': 'rgba(212, 244, 208, 0.12)',
    'color-accent-secondary-a20': 'rgba(212, 244, 208, 0.20)',
    'color-accent-secondary-a25': 'rgba(212, 244, 208, 0.25)',
    'color-accent-secondary-a30': 'rgba(212, 244, 208, 0.30)',
    'color-accent-secondary-a55': 'rgba(212, 244, 208, 0.55)',
    'color-accent-secondary-a90': 'rgba(212, 244, 208, 0.90)',
  },
  fonts: {
    display: "'Space Mono', monospace",
    body: "'Space Mono', monospace",
    code: "'Space Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap',
  },
  glyphs: {
    divider: '─',
    cursor: '▌',
    disclosureOpen: '▾',
    disclosureClosed: '▸',
    diamond: '◈',
    bullet: '●',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '0px',
    radiusMd: '2px',
    panelPadding: '14px',
  },
  shaderPreset: 'sonar',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: true, flicker: false, cursorBlink: true },
};
