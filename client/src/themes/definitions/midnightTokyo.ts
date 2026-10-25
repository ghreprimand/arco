import type { Theme } from '../types';

// Midnight Tokyo — wet asphalt street at night. Deliberately distinct from
// Matrix: not phosphor green, not code-rain. Hot magenta primary + ice
// cyan secondary over a blue-cast black. Slightly looser radii + padding
// than Matrix because it's nighttime mood, not terminal precision.
// Shader: rainGlass.frag.glsl — rain streaks on a sheet of glass over a
// diffuse neon bokeh.
// Alpha ramps derive from primary #ff2a7f (255, 42, 127) and secondary
// #7ff0ff (127, 240, 255).
export const midnightTokyo: Theme = {
  id: 'midnight-tokyo',
  name: 'Midnight Tokyo',
  description: 'Wet asphalt, neon signage — magenta and ice on blue-black',
  mood: 'dark',
  tokens: {
    'color-bg': '#0b0d14',
    'color-bg-panel': 'rgba(14, 16, 26, 0.92)',
    'color-bg-input': 'rgba(10, 12, 20, 0.96)',
    'color-bg-elevated': 'rgba(20, 22, 34, 0.97)',

    'color-fg': '#e8e4f0',
    'color-fg-muted': 'rgba(232, 228, 240, 0.42)',

    'color-accent-primary': '#ff2a7f',
    'color-accent-primary-dim': '#b01d5a',
    'color-accent-primary-tint': '#3a0a1f',
    'color-accent-primary-glow': 'rgba(255, 42, 127, 0.25)',

    'color-accent-secondary': '#7ff0ff',
    'color-accent-secondary-dim': '#4fb8c8',
    'color-accent-secondary-bright': '#b8f8ff',
    'color-accent-secondary-glow': 'rgba(127, 240, 255, 0.2)',

    'color-border-hairline': 'rgba(127, 240, 255, 0.12)',
    'color-border-bright': 'rgba(255, 42, 127, 0.35)',

    'color-danger': '#ff2a7f',
    'color-warning': '#ffcb47',
    'color-warning-dim': '#b88a28',
    'color-success': '#7ff0ff',
    'color-shadow': 'rgba(0, 0, 0, 0.85)',
    'color-bg-sunken': 'rgba(4, 6, 12, 0.55)',

    'color-accent-primary-a03': 'rgba(255, 42, 127, 0.03)',
    'color-accent-primary-a04': 'rgba(255, 42, 127, 0.04)',
    'color-accent-primary-a05': 'rgba(255, 42, 127, 0.05)',
    'color-accent-primary-a06': 'rgba(255, 42, 127, 0.06)',
    'color-accent-primary-a08': 'rgba(255, 42, 127, 0.08)',
    'color-accent-primary-a10': 'rgba(255, 42, 127, 0.1)',
    'color-accent-primary-a15': 'rgba(255, 42, 127, 0.15)',

    'color-accent-secondary-a00': 'rgba(127, 240, 255, 0)',
    'color-accent-secondary-a04': 'rgba(127, 240, 255, 0.04)',
    'color-accent-secondary-a06': 'rgba(127, 240, 255, 0.06)',
    'color-accent-secondary-a08': 'rgba(127, 240, 255, 0.08)',
    'color-accent-secondary-a10': 'rgba(127, 240, 255, 0.1)',
    'color-accent-secondary-a12': 'rgba(127, 240, 255, 0.12)',
    'color-accent-secondary-a20': 'rgba(127, 240, 255, 0.2)',
    'color-accent-secondary-a25': 'rgba(127, 240, 255, 0.25)',
    'color-accent-secondary-a30': 'rgba(127, 240, 255, 0.3)',
    'color-accent-secondary-a55': 'rgba(127, 240, 255, 0.55)',
    'color-accent-secondary-a90': 'rgba(127, 240, 255, 0.9)',
  },
  fonts: {
    display: "'Space Grotesk', sans-serif",
    body: "'JetBrains Mono', monospace",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Space+Grotesk:wght@400;500;700&display=swap',
  },
  glyphs: {
    divider: '◇',
    cursor: '▌',
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
    panelPadding: '14px',
  },
  shaderPreset: 'rain-glass',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: true, flicker: false, cursorBlink: true },
};
