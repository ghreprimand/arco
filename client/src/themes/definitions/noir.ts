import type { Theme } from '../types';

// Noir — graphite and bone, one drop of blood. Almost monochrome: bg is
// warm black, fg is cream-bone, and the single crimson accent
// (color-accent-primary) is reserved for run / send / danger affordances
// so it reads as "the one thing in color." Secondary sits near bone so
// the chrome stays neutral. Body font is a display serif to distinguish
// this from every other dark theme in the set.
// Shader: filmGrain.frag.glsl — monochrome luminance noise + a breathing
// corner vignette + occasional hair-dust scratch. No hue.
// Alpha ramps derive from primary #c8102e (200, 16, 46) and secondary
// #e8dfd0 (232, 223, 208).
export const noir: Theme = {
  id: 'noir',
  name: 'Noir',
  description: 'Monochrome detective office — graphite, bone, one drop of blood',
  mood: 'dark',
  tokens: {
    'color-bg': '#0a0908',
    'color-bg-panel': 'rgba(18, 17, 15, 0.94)',
    'color-bg-input': 'rgba(12, 11, 10, 0.97)',
    'color-bg-elevated': 'rgba(28, 26, 24, 0.97)',

    'color-fg': '#e8dfd0',
    'color-fg-muted': 'rgba(232, 223, 208, 0.42)',

    'color-accent-primary': '#c8102e',
    'color-accent-primary-dim': '#8a0a1f',
    'color-accent-primary-tint': '#2a0508',
    'color-accent-primary-glow': 'rgba(200, 16, 46, 0.22)',

    'color-accent-secondary': '#e8dfd0',
    'color-accent-secondary-dim': '#a89d8c',
    'color-accent-secondary-bright': '#f5eee0',
    'color-accent-secondary-glow': 'rgba(232, 223, 208, 0.12)',

    'color-border-hairline': 'rgba(232, 223, 208, 0.1)',
    'color-border-bright': 'rgba(232, 223, 208, 0.28)',

    'color-danger': '#c8102e',
    'color-warning': '#d4a948',
    'color-warning-dim': '#8a6e28',
    'color-success': '#8ba876',
    'color-shadow': 'rgba(0, 0, 0, 0.92)',
    'color-bg-sunken': 'rgba(4, 4, 3, 0.6)',

    'color-accent-primary-a03': 'rgba(200, 16, 46, 0.03)',
    'color-accent-primary-a04': 'rgba(200, 16, 46, 0.04)',
    'color-accent-primary-a05': 'rgba(200, 16, 46, 0.05)',
    'color-accent-primary-a06': 'rgba(200, 16, 46, 0.06)',
    'color-accent-primary-a08': 'rgba(200, 16, 46, 0.08)',
    'color-accent-primary-a10': 'rgba(200, 16, 46, 0.1)',
    'color-accent-primary-a15': 'rgba(200, 16, 46, 0.15)',

    'color-accent-secondary-a00': 'rgba(232, 223, 208, 0)',
    'color-accent-secondary-a04': 'rgba(232, 223, 208, 0.04)',
    'color-accent-secondary-a06': 'rgba(232, 223, 208, 0.06)',
    'color-accent-secondary-a08': 'rgba(232, 223, 208, 0.08)',
    'color-accent-secondary-a10': 'rgba(232, 223, 208, 0.1)',
    'color-accent-secondary-a12': 'rgba(232, 223, 208, 0.12)',
    'color-accent-secondary-a20': 'rgba(232, 223, 208, 0.2)',
    'color-accent-secondary-a25': 'rgba(232, 223, 208, 0.25)',
    'color-accent-secondary-a30': 'rgba(232, 223, 208, 0.3)',
    'color-accent-secondary-a55': 'rgba(232, 223, 208, 0.55)',
    'color-accent-secondary-a90': 'rgba(232, 223, 208, 0.9)',
  },
  fonts: {
    // Single-font screenplay/case-file aesthetic — Courier Prime throughout.
    // Display, body, code all share the typewriter face so the UI reads as
    // one typed document. Previous Playfair/Spectral pairing was beautiful
    // in print sizes but too thin/distracting on screen at UI sizes.
    display: "'Courier Prime', monospace",
    body: "'Courier Prime', monospace",
    code: "'Courier Prime', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Courier+Prime:wght@400;700&display=swap',
  },
  glyphs: {
    divider: '—',
    cursor: '▋',
    disclosureOpen: '▾',
    disclosureClosed: '▸',
    diamond: '◆',
    bullet: '·',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '0px',
    radiusMd: '0px',
    panelPadding: '14px',
  },
  shaderPreset: 'film-grain',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: false, flicker: true, cursorBlink: true },
};
