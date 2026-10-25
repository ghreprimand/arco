import type { Theme } from '../types';

// Stealth — cold industrial luxury. Pitch base, tactical teal primary,
// safety-orange secondary used sparingly for warnings/run actions, steel
// grey text. Precision-grade, the opposite of Cassette Futurism's warmth.
// Shader: carbonWeave.frag.glsl — faint anisotropic carbon-fiber weave
// + a slow specular drift crossing the panel once per 28s.
// Fonts chosen for precision and readability: Syncopate display
// (geometric, technical, wide tracking), Inter body (UI-grade sans),
// JetBrains Mono code.
// Alpha ramps derive from primary #3a9c9c (58, 156, 156) and secondary
// #ff6a1a (255, 106, 26).
export const stealth: Theme = {
  id: 'stealth',
  name: 'Stealth',
  description: 'Carbon-fiber precision — tactical teal on pitch black',
  mood: 'dark',
  tokens: {
    'color-bg': '#050607',
    'color-bg-panel': 'rgba(10, 14, 16, 0.94)',
    'color-bg-input': 'rgba(6, 9, 11, 0.97)',
    'color-bg-elevated': 'rgba(18, 22, 26, 0.97)',

    'color-fg': '#c8d0d6',
    'color-fg-muted': 'rgba(200, 208, 214, 0.45)',

    'color-accent-primary': '#3a9c9c',
    'color-accent-primary-dim': '#2a7474',
    'color-accent-primary-tint': '#0a2424',
    'color-accent-primary-glow': 'rgba(58, 156, 156, 0.22)',

    'color-accent-secondary': '#ff6a1a',
    'color-accent-secondary-dim': '#b84a10',
    'color-accent-secondary-bright': '#ff9050',
    'color-accent-secondary-glow': 'rgba(255, 106, 26, 0.2)',

    'color-border-hairline': 'rgba(200, 208, 214, 0.08)',
    'color-border-bright': 'rgba(58, 156, 156, 0.35)',

    'color-danger': '#ff3a3a',
    'color-warning': '#ff6a1a',
    'color-warning-dim': '#b84a10',
    'color-success': '#3a9c9c',
    'color-shadow': 'rgba(0, 0, 0, 0.9)',
    'color-bg-sunken': 'rgba(2, 4, 5, 0.55)',

    'color-accent-primary-a03': 'rgba(58, 156, 156, 0.03)',
    'color-accent-primary-a04': 'rgba(58, 156, 156, 0.04)',
    'color-accent-primary-a05': 'rgba(58, 156, 156, 0.05)',
    'color-accent-primary-a06': 'rgba(58, 156, 156, 0.06)',
    'color-accent-primary-a08': 'rgba(58, 156, 156, 0.08)',
    'color-accent-primary-a10': 'rgba(58, 156, 156, 0.1)',
    'color-accent-primary-a15': 'rgba(58, 156, 156, 0.15)',

    'color-accent-secondary-a00': 'rgba(255, 106, 26, 0)',
    'color-accent-secondary-a04': 'rgba(255, 106, 26, 0.04)',
    'color-accent-secondary-a06': 'rgba(255, 106, 26, 0.06)',
    'color-accent-secondary-a08': 'rgba(255, 106, 26, 0.08)',
    'color-accent-secondary-a10': 'rgba(255, 106, 26, 0.1)',
    'color-accent-secondary-a12': 'rgba(255, 106, 26, 0.12)',
    'color-accent-secondary-a20': 'rgba(255, 106, 26, 0.2)',
    'color-accent-secondary-a25': 'rgba(255, 106, 26, 0.25)',
    'color-accent-secondary-a30': 'rgba(255, 106, 26, 0.3)',
    'color-accent-secondary-a55': 'rgba(255, 106, 26, 0.55)',
    'color-accent-secondary-a90': 'rgba(255, 106, 26, 0.9)',
  },
  fonts: {
    display: "'Syncopate', sans-serif",
    body: "'Inter', sans-serif",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@300;400;500;700&family=Syncopate:wght@400;700&display=swap',
  },
  glyphs: {
    divider: '▰',
    cursor: '▎',
    disclosureOpen: '▾',
    disclosureClosed: '▸',
    diamond: '◆',
    bullet: '▪',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '2px',
    radiusMd: '4px',
    panelPadding: '12px',
  },
  shaderPreset: 'carbon-weave',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: true, flicker: false, cursorBlink: true },
};
