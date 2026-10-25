import type { Theme } from '../types';

// Voyager — NASA mission-control aesthetic. Graphite hull, NASA orange
// primary accent, muted signal-blue secondary, dimmed phosphor white text.
// Shader: starDrift.frag.glsl — slow parallax starfield, faint engineering
// grid, and a single telemetry ping sweeping top→bottom every ~18s.
// Alpha ramps derive from primary #ff6b1a (255, 107, 26) and secondary
// #5a9cd6 (90, 156, 214).
export const voyager: Theme = {
  id: 'voyager',
  name: 'Voyager',
  description: 'Spacecraft telemetry — NASA orange on graphite, deep-space drift',
  mood: 'dark',
  tokens: {
    'color-bg': '#0f1216',
    'color-bg-panel': 'rgba(18, 22, 28, 0.93)',
    'color-bg-input': 'rgba(14, 18, 24, 0.96)',
    'color-bg-elevated': 'rgba(24, 28, 36, 0.97)',

    'color-fg': '#e8e6d8',
    'color-fg-muted': 'rgba(232, 230, 216, 0.45)',

    'color-accent-primary': '#ff6b1a',
    'color-accent-primary-dim': '#b84c10',
    'color-accent-primary-tint': '#3a1a08',
    'color-accent-primary-glow': 'rgba(255, 107, 26, 0.22)',

    'color-accent-secondary': '#5a9cd6',
    'color-accent-secondary-dim': '#3f74a4',
    'color-accent-secondary-bright': '#8fc0e8',
    'color-accent-secondary-glow': 'rgba(90, 156, 214, 0.18)',

    'color-border-hairline': 'rgba(232, 230, 216, 0.1)',
    'color-border-bright': 'rgba(255, 107, 26, 0.35)',

    'color-danger': '#ff3d3d',
    'color-warning': '#ffb000',
    'color-warning-dim': '#b87d00',
    'color-success': '#5ad16c',
    'color-shadow': 'rgba(0, 0, 0, 0.85)',
    'color-bg-sunken': 'rgba(8, 10, 14, 0.5)',

    'color-accent-primary-a03': 'rgba(255, 107, 26, 0.03)',
    'color-accent-primary-a04': 'rgba(255, 107, 26, 0.04)',
    'color-accent-primary-a05': 'rgba(255, 107, 26, 0.05)',
    'color-accent-primary-a06': 'rgba(255, 107, 26, 0.06)',
    'color-accent-primary-a08': 'rgba(255, 107, 26, 0.08)',
    'color-accent-primary-a10': 'rgba(255, 107, 26, 0.1)',
    'color-accent-primary-a15': 'rgba(255, 107, 26, 0.15)',

    'color-accent-secondary-a00': 'rgba(90, 156, 214, 0)',
    'color-accent-secondary-a04': 'rgba(90, 156, 214, 0.04)',
    'color-accent-secondary-a06': 'rgba(90, 156, 214, 0.06)',
    'color-accent-secondary-a08': 'rgba(90, 156, 214, 0.08)',
    'color-accent-secondary-a10': 'rgba(90, 156, 214, 0.1)',
    'color-accent-secondary-a12': 'rgba(90, 156, 214, 0.12)',
    'color-accent-secondary-a20': 'rgba(90, 156, 214, 0.2)',
    'color-accent-secondary-a25': 'rgba(90, 156, 214, 0.25)',
    'color-accent-secondary-a30': 'rgba(90, 156, 214, 0.3)',
    'color-accent-secondary-a55': 'rgba(90, 156, 214, 0.55)',
    'color-accent-secondary-a90': 'rgba(90, 156, 214, 0.9)',
  },
  fonts: {
    display: "'Space Mono', monospace",
    body: "'JetBrains Mono', monospace",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Space+Mono:wght@400;700&display=swap',
  },
  glyphs: {
    divider: '▸',
    cursor: '▍',
    disclosureOpen: '▾',
    disclosureClosed: '▸',
    diamond: '◇',
    bullet: '·',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '1px',
    radiusMd: '2px',
    panelPadding: '12px',
  },
  shaderPreset: 'star-drift',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: true, flicker: false, cursorBlink: true },
};
