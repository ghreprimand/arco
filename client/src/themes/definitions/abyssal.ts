import type { Theme } from '../types';

// Abyssal — deep-sea research sub. Ink-black pressurised hull, bioluminescent
// cyan primary, lilac jellyfish secondary, single sodium-amber warning pop.
// Shader: marineSnow.frag.glsl — slow drifting particles with a distant
// bloom passing every ~24s. Feels quiet and cold, the opposite of Matrix's
// rain. Alpha ramps derive from primary #3fe0d0 (63, 224, 208) and
// secondary #b8a4ff (184, 164, 255).
export const abyssal: Theme = {
  id: 'abyssal',
  name: 'Abyssal',
  description: 'Deep-sea sub — bioluminescent cyan on pressurised black',
  mood: 'dark',
  tokens: {
    'color-bg': '#04080c',
    'color-bg-panel': 'rgba(6, 14, 22, 0.92)',
    'color-bg-input': 'rgba(4, 10, 18, 0.96)',
    'color-bg-elevated': 'rgba(10, 20, 30, 0.97)',

    'color-fg': '#3fe0d0',
    'color-fg-muted': 'rgba(63, 224, 208, 0.42)',

    'color-accent-primary': '#3fe0d0',
    'color-accent-primary-dim': '#2aa89b',
    'color-accent-primary-tint': '#0a2a28',
    'color-accent-primary-glow': 'rgba(63, 224, 208, 0.2)',

    'color-accent-secondary': '#b8a4ff',
    'color-accent-secondary-dim': '#8676c8',
    'color-accent-secondary-bright': '#d4c8ff',
    'color-accent-secondary-glow': 'rgba(184, 164, 255, 0.18)',

    'color-border-hairline': 'rgba(63, 224, 208, 0.12)',
    'color-border-bright': 'rgba(63, 224, 208, 0.3)',

    'color-danger': '#ff6a3d',
    'color-warning': '#ffa04a',
    'color-warning-dim': '#c27a36',
    'color-success': '#3fe0d0',
    'color-shadow': 'rgba(0, 0, 0, 0.85)',
    'color-bg-sunken': 'rgba(2, 8, 14, 0.5)',

    'color-accent-primary-a03': 'rgba(63, 224, 208, 0.03)',
    'color-accent-primary-a04': 'rgba(63, 224, 208, 0.04)',
    'color-accent-primary-a05': 'rgba(63, 224, 208, 0.05)',
    'color-accent-primary-a06': 'rgba(63, 224, 208, 0.06)',
    'color-accent-primary-a08': 'rgba(63, 224, 208, 0.08)',
    'color-accent-primary-a10': 'rgba(63, 224, 208, 0.1)',
    'color-accent-primary-a15': 'rgba(63, 224, 208, 0.15)',

    'color-accent-secondary-a00': 'rgba(184, 164, 255, 0)',
    'color-accent-secondary-a04': 'rgba(184, 164, 255, 0.04)',
    'color-accent-secondary-a06': 'rgba(184, 164, 255, 0.06)',
    'color-accent-secondary-a08': 'rgba(184, 164, 255, 0.08)',
    'color-accent-secondary-a10': 'rgba(184, 164, 255, 0.1)',
    'color-accent-secondary-a12': 'rgba(184, 164, 255, 0.12)',
    'color-accent-secondary-a20': 'rgba(184, 164, 255, 0.2)',
    'color-accent-secondary-a25': 'rgba(184, 164, 255, 0.25)',
    'color-accent-secondary-a30': 'rgba(184, 164, 255, 0.3)',
    'color-accent-secondary-a55': 'rgba(184, 164, 255, 0.55)',
    'color-accent-secondary-a90': 'rgba(184, 164, 255, 0.9)',
  },
  fonts: {
    display: "'Space Mono', monospace",
    body: "'JetBrains Mono', monospace",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Space+Mono:wght@400;700&display=swap',
  },
  glyphs: {
    divider: '∴',
    cursor: '▌',
    disclosureOpen: '▾',
    disclosureClosed: '▸',
    diamond: '◇',
    bullet: '∙',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '2px',
    radiusMd: '4px',
    panelPadding: '12px',
  },
  shaderPreset: 'marine-snow',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: true, flicker: false, cursorBlink: true },
};
