import type { Theme } from '../types';

// Bloodmoon — gothic horror. Warm-dark red, the only theme in the set
// where red is the *base* hue rather than a danger accent. Oxblood-black
// bg, saturated blood-red primary, bone-pale text, deep plum secondary.
// Shader: bloodmoon.frag.glsl — slow corner haze + rare vertical film-
// leader wash.
// Fonts chosen for readability: Cinzel display (Roman caps; gothic feel
// without the blackletter-readability hit), Lora body (screen-optimized
// serif), Courier Prime code (period-correct, highly legible).
// Deliberately skipped UnifrakturCook — too hard to read at UI sizes.
// Alpha ramps derive from primary #b0162c (176, 22, 44) and secondary
// #6b2e5a (107, 46, 90).
export const bloodmoon: Theme = {
  id: 'bloodmoon',
  name: 'Bloodmoon',
  description: 'Gothic horror — blood-red and bone over oxblood-black',
  mood: 'warm-dark',
  tokens: {
    'color-bg': '#0c0305',
    'color-bg-panel': 'rgba(20, 8, 10, 0.94)',
    'color-bg-input': 'rgba(14, 5, 7, 0.97)',
    'color-bg-elevated': 'rgba(30, 12, 16, 0.97)',

    'color-fg': '#e8dfd0',
    'color-fg-muted': 'rgba(232, 223, 208, 0.45)',

    'color-accent-primary': '#d11f38',
    // Top-bar buttons paint their label in -primary-dim; the old #7a0e1c
    // (near-black blood red) sat at ~1.5:1 on the oxblood-black bg and was
    // unreadable (operator report 2026-06-05). Raised to a rosy blood red
    // (~4.6:1) so header labels are legible; primary itself nudged a touch
    // brighter to match. The deep oxblood survives as -tint / the bg ramp.
    'color-accent-primary-dim': '#d4566a',
    'color-accent-primary-tint': '#2a0508',
    'color-accent-primary-glow': 'rgba(176, 22, 44, 0.25)',

    'color-accent-secondary': '#6b2e5a',
    'color-accent-secondary-dim': '#4a1f3e',
    'color-accent-secondary-bright': '#9a4d82',
    'color-accent-secondary-glow': 'rgba(107, 46, 90, 0.2)',

    'color-border-hairline': 'rgba(232, 223, 208, 0.09)',
    'color-border-bright': 'rgba(176, 22, 44, 0.38)',

    'color-danger': '#ff3850',
    'color-warning': '#d4a948',
    'color-warning-dim': '#8a6e28',
    'color-success': '#8ba876',
    'color-shadow': 'rgba(0, 0, 0, 0.92)',
    'color-bg-sunken': 'rgba(6, 2, 3, 0.6)',

    'color-accent-primary-a03': 'rgba(176, 22, 44, 0.03)',
    'color-accent-primary-a04': 'rgba(176, 22, 44, 0.04)',
    'color-accent-primary-a05': 'rgba(176, 22, 44, 0.05)',
    'color-accent-primary-a06': 'rgba(176, 22, 44, 0.06)',
    'color-accent-primary-a08': 'rgba(176, 22, 44, 0.08)',
    'color-accent-primary-a10': 'rgba(176, 22, 44, 0.1)',
    'color-accent-primary-a15': 'rgba(176, 22, 44, 0.15)',

    'color-accent-secondary-a00': 'rgba(107, 46, 90, 0)',
    'color-accent-secondary-a04': 'rgba(107, 46, 90, 0.04)',
    'color-accent-secondary-a06': 'rgba(107, 46, 90, 0.06)',
    'color-accent-secondary-a08': 'rgba(107, 46, 90, 0.08)',
    'color-accent-secondary-a10': 'rgba(107, 46, 90, 0.1)',
    'color-accent-secondary-a12': 'rgba(107, 46, 90, 0.12)',
    'color-accent-secondary-a20': 'rgba(107, 46, 90, 0.2)',
    'color-accent-secondary-a25': 'rgba(107, 46, 90, 0.25)',
    'color-accent-secondary-a30': 'rgba(107, 46, 90, 0.3)',
    'color-accent-secondary-a55': 'rgba(107, 46, 90, 0.55)',
    'color-accent-secondary-a90': 'rgba(107, 46, 90, 0.9)',
  },
  fonts: {
    display: "'Cinzel', serif",
    body: "'Lora', serif",
    code: "'Courier Prime', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;500;600;700&family=Courier+Prime:wght@400;700&family=Lora:wght@400;500;600;700&display=swap',
  },
  glyphs: {
    divider: '†',
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
    radiusMd: '1px',
    panelPadding: '14px',
  },
  shaderPreset: 'bloodmoon',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: true, flicker: false, cursorBlink: true },
};
