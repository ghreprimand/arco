import type { Theme } from '../types';

// SENTINEL — you are on shift. DARKN0DE's diegetic operator register
// transposed into a theme: pitch black with a hint of cool, steel-blue
// primary, amber secondary reserved for warnings + corner pulse markers.
// Fonts mirror DARKN0DE itself (JetBrains Mono everywhere).
// Shader: sentinel.frag.glsl — two-octave value-noise atmosphere, heavy
// vignette, luminance-aware grain, pulsing amber diamonds in the four
// corners whose period shortens with uTension.
// Alpha ramps derive from primary #7eb8d9 (126, 184, 217) and secondary
// #e8a83a (232, 168, 58).
export const sentinel: Theme = {
  id: 'sentinel',
  name: 'Sentinel',
  description: 'Operator on shift — steel-blue atmosphere, amber corner pulses',
  mood: 'dark',
  tokens: {
    'color-bg': '#050608',
    'color-bg-panel': 'rgba(10, 14, 20, 0.94)',
    'color-bg-input': 'rgba(6, 10, 16, 0.97)',
    'color-bg-elevated': 'rgba(16, 22, 30, 0.97)',

    'color-fg': '#cfd6df',
    'color-fg-muted': 'rgba(207, 214, 223, 0.48)',

    'color-accent-primary': '#7eb8d9',
    'color-accent-primary-dim': '#4a7a98',
    'color-accent-primary-tint': '#0e1820',
    'color-accent-primary-glow': 'rgba(126, 184, 217, 0.22)',

    'color-accent-secondary': '#e8a83a',
    'color-accent-secondary-dim': '#a87828',
    'color-accent-secondary-bright': '#f4c868',
    'color-accent-secondary-glow': 'rgba(232, 168, 58, 0.22)',

    'color-border-hairline': 'rgba(126, 184, 217, 0.12)',
    'color-border-bright': 'rgba(126, 184, 217, 0.32)',

    'color-danger': '#e83030',
    'color-warning': '#e8a83a',
    'color-warning-dim': '#a87828',
    'color-success': '#4ec08c',
    'color-shadow': 'rgba(0, 0, 0, 0.88)',
    'color-bg-sunken': 'rgba(2, 4, 8, 0.55)',

    'color-accent-primary-a03': 'rgba(126, 184, 217, 0.03)',
    'color-accent-primary-a04': 'rgba(126, 184, 217, 0.04)',
    'color-accent-primary-a05': 'rgba(126, 184, 217, 0.05)',
    'color-accent-primary-a06': 'rgba(126, 184, 217, 0.06)',
    'color-accent-primary-a08': 'rgba(126, 184, 217, 0.08)',
    'color-accent-primary-a10': 'rgba(126, 184, 217, 0.1)',
    'color-accent-primary-a15': 'rgba(126, 184, 217, 0.15)',

    'color-accent-secondary-a00': 'rgba(232, 168, 58, 0)',
    'color-accent-secondary-a04': 'rgba(232, 168, 58, 0.04)',
    'color-accent-secondary-a06': 'rgba(232, 168, 58, 0.06)',
    'color-accent-secondary-a08': 'rgba(232, 168, 58, 0.08)',
    'color-accent-secondary-a10': 'rgba(232, 168, 58, 0.1)',
    'color-accent-secondary-a12': 'rgba(232, 168, 58, 0.12)',
    'color-accent-secondary-a20': 'rgba(232, 168, 58, 0.2)',
    'color-accent-secondary-a25': 'rgba(232, 168, 58, 0.25)',
    'color-accent-secondary-a30': 'rgba(232, 168, 58, 0.3)',
    'color-accent-secondary-a55': 'rgba(232, 168, 58, 0.55)',
    'color-accent-secondary-a90': 'rgba(232, 168, 58, 0.9)',
  },
  fonts: {
    display: "'JetBrains Mono', monospace",
    body: "'JetBrains Mono', monospace",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap',
  },
  glyphs: {
    divider: '─',
    cursor: '▌',
    disclosureOpen: '▾',
    disclosureClosed: '▸',
    diamond: '◆',
    bullet: '▪',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '2px',
    radiusMd: '3px',
    panelPadding: '14px',
  },
  shaderPreset: 'sentinel',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: true, flicker: false, cursorBlink: true },
};
