import type { Theme } from '../types';

// Cherenkov — you are staring down into the reactor cooling pool.
// Pitch-navy base, bright caustic cyan primary, pale-ice secondary used for
// rising bubble streaks. Fonts: IBM Plex Mono across the board — clean,
// scientific, neutral weight for reading long logs in a cold environment.
// Shader: cherenkov.frag.glsl — domain-warped caustic ribbons + sparse
// rising bubbles + heavy blue-shift vignette.
// Alpha ramps derive from primary #a4e4f0 (164, 228, 240) and secondary
// #dcf4ff (220, 244, 255).
export const cherenkov: Theme = {
  id: 'cherenkov',
  name: 'Cherenkov',
  description: 'Reactor pool — caustic cyan, rising bubbles, blue-shift vignette',
  mood: 'dark',
  tokens: {
    'color-bg': '#020810',
    'color-bg-panel': 'rgba(6, 14, 22, 0.93)',
    'color-bg-input': 'rgba(4, 10, 18, 0.97)',
    'color-bg-elevated': 'rgba(10, 20, 30, 0.97)',

    'color-fg': '#a4e4f0',
    'color-fg-muted': 'rgba(164, 228, 240, 0.46)',

    'color-accent-primary': '#a4e4f0',
    'color-accent-primary-dim': '#6ea8b8',
    'color-accent-primary-tint': '#0a1e24',
    'color-accent-primary-glow': 'rgba(164, 228, 240, 0.26)',

    'color-accent-secondary': '#dcf4ff',
    'color-accent-secondary-dim': '#8aaebe',
    'color-accent-secondary-bright': '#f4fcff',
    'color-accent-secondary-glow': 'rgba(220, 244, 255, 0.20)',

    'color-border-hairline': 'rgba(164, 228, 240, 0.12)',
    'color-border-bright': 'rgba(164, 228, 240, 0.32)',

    'color-danger': '#ff6a6a',
    'color-warning': '#ffb64a',
    'color-warning-dim': '#b8843a',
    'color-success': '#a4e4f0',
    'color-shadow': 'rgba(0, 4, 12, 0.9)',
    'color-bg-sunken': 'rgba(0, 4, 10, 0.6)',

    'color-accent-primary-a03': 'rgba(164, 228, 240, 0.03)',
    'color-accent-primary-a04': 'rgba(164, 228, 240, 0.04)',
    'color-accent-primary-a05': 'rgba(164, 228, 240, 0.05)',
    'color-accent-primary-a06': 'rgba(164, 228, 240, 0.06)',
    'color-accent-primary-a08': 'rgba(164, 228, 240, 0.08)',
    'color-accent-primary-a10': 'rgba(164, 228, 240, 0.10)',
    'color-accent-primary-a15': 'rgba(164, 228, 240, 0.15)',

    'color-accent-secondary-a00': 'rgba(220, 244, 255, 0)',
    'color-accent-secondary-a04': 'rgba(220, 244, 255, 0.04)',
    'color-accent-secondary-a06': 'rgba(220, 244, 255, 0.06)',
    'color-accent-secondary-a08': 'rgba(220, 244, 255, 0.08)',
    'color-accent-secondary-a10': 'rgba(220, 244, 255, 0.10)',
    'color-accent-secondary-a12': 'rgba(220, 244, 255, 0.12)',
    'color-accent-secondary-a20': 'rgba(220, 244, 255, 0.20)',
    'color-accent-secondary-a25': 'rgba(220, 244, 255, 0.25)',
    'color-accent-secondary-a30': 'rgba(220, 244, 255, 0.30)',
    'color-accent-secondary-a55': 'rgba(220, 244, 255, 0.55)',
    'color-accent-secondary-a90': 'rgba(220, 244, 255, 0.90)',
  },
  fonts: {
    display: "'IBM Plex Mono', monospace",
    body: "'IBM Plex Mono', monospace",
    code: "'IBM Plex Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&display=swap',
  },
  glyphs: {
    divider: '∼',
    cursor: '▌',
    disclosureOpen: '▾',
    disclosureClosed: '▸',
    diamond: '◇',
    bullet: '∘',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '2px',
    radiusMd: '4px',
    panelPadding: '14px',
  },
  shaderPreset: 'cherenkov',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: true, flicker: false, cursorBlink: true },
};
