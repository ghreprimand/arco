import type { Theme } from '../types';

// Aurora — an arctic night sky. Near-black base, aurora-green primary,
// magenta fringe secondary. Shader draws morphing ribbons across the top
// third of the viewport with a slow hue walk green→cyan→magenta; a sparse
// star field fills the rest. Fonts: JetBrains Mono.
// Alpha ramps derive from primary #8cf0b0 (140, 240, 176) and secondary
// #ff88d0 (255, 136, 208).
export const aurora: Theme = {
  id: 'aurora',
  name: 'Aurora',
  description: 'Arctic ribbons — green/magenta curtains over a pinprick sky',
  mood: 'dark',
  tokens: {
    'color-bg': '#030612',
    'color-bg-panel': 'rgba(8, 14, 24, 0.93)',
    'color-bg-input': 'rgba(4, 10, 18, 0.97)',
    'color-bg-elevated': 'rgba(16, 22, 34, 0.97)',

    'color-fg': '#8cf0b0',
    'color-fg-muted': 'rgba(140, 240, 176, 0.46)',

    'color-accent-primary': '#8cf0b0',
    'color-accent-primary-dim': '#5ab07e',
    'color-accent-primary-tint': '#0c2418',
    'color-accent-primary-glow': 'rgba(140, 240, 176, 0.24)',

    'color-accent-secondary': '#ff88d0',
    'color-accent-secondary-dim': '#b85c94',
    'color-accent-secondary-bright': '#ffb4e0',
    'color-accent-secondary-glow': 'rgba(255, 136, 208, 0.22)',

    'color-border-hairline': 'rgba(140, 240, 176, 0.12)',
    'color-border-bright': 'rgba(140, 240, 176, 0.32)',

    'color-danger': '#ff6a70',
    'color-warning': '#ffbb60',
    'color-warning-dim': '#b88244',
    'color-success': '#8cf0b0',
    'color-shadow': 'rgba(0, 0, 8, 0.88)',
    'color-bg-sunken': 'rgba(0, 2, 8, 0.55)',

    'color-accent-primary-a03': 'rgba(140, 240, 176, 0.03)',
    'color-accent-primary-a04': 'rgba(140, 240, 176, 0.04)',
    'color-accent-primary-a05': 'rgba(140, 240, 176, 0.05)',
    'color-accent-primary-a06': 'rgba(140, 240, 176, 0.06)',
    'color-accent-primary-a08': 'rgba(140, 240, 176, 0.08)',
    'color-accent-primary-a10': 'rgba(140, 240, 176, 0.10)',
    'color-accent-primary-a15': 'rgba(140, 240, 176, 0.15)',

    'color-accent-secondary-a00': 'rgba(255, 136, 208, 0)',
    'color-accent-secondary-a04': 'rgba(255, 136, 208, 0.04)',
    'color-accent-secondary-a06': 'rgba(255, 136, 208, 0.06)',
    'color-accent-secondary-a08': 'rgba(255, 136, 208, 0.08)',
    'color-accent-secondary-a10': 'rgba(255, 136, 208, 0.10)',
    'color-accent-secondary-a12': 'rgba(255, 136, 208, 0.12)',
    'color-accent-secondary-a20': 'rgba(255, 136, 208, 0.20)',
    'color-accent-secondary-a25': 'rgba(255, 136, 208, 0.25)',
    'color-accent-secondary-a30': 'rgba(255, 136, 208, 0.30)',
    'color-accent-secondary-a55': 'rgba(255, 136, 208, 0.55)',
    'color-accent-secondary-a90': 'rgba(255, 136, 208, 0.90)',
  },
  fonts: {
    display: "'JetBrains Mono', monospace",
    body: "'JetBrains Mono', monospace",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap',
  },
  glyphs: {
    divider: '∼',
    cursor: '▌',
    disclosureOpen: '▾',
    disclosureClosed: '▸',
    diamond: '✦',
    bullet: '∙',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '2px',
    radiusMd: '4px',
    panelPadding: '14px',
  },
  shaderPreset: 'aurora',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: true, flicker: false, cursorBlink: true },
};
