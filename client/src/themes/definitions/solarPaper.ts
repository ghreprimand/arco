import type { Theme } from '../types';

// Solar Paper — warm parchment with sage + terracotta watercolor blooms. Alpha
// ramps derive from primary #7ba05b (sage) and secondary #c67e4e (terracotta).
// The Phase-1 tints therefore read as faint sage / terracotta washes on
// parchment rather than leaking matrix-green defaults. Fraunces (display)
// + Lora (body) + JetBrains Mono (code) keep literary register. Radiuses
// lean generous (8/14 px) to feel handcrafted. Shader preset 'watercolor'.
export const solarPaper: Theme = {
  id: 'solar-paper',
  name: 'Solar Paper',
  description: 'Solarpunk warm parchment — oatmeal, sage, terracotta',
  mood: 'warm-light',
  tokens: {
    'color-bg': '#d9c9a0',
    'color-bg-panel': '#e3d5af',
    'color-bg-input': '#ede0bf',
    'color-bg-elevated': '#ede0bf',

    'color-fg': '#3d3520',
    // Polish pass (2026-04-18): fg-muted at #a89878 on #f4ead5 scores ~2.5
    // contrast — fails AA for body text. Darkened to #6e5f3e (~5.5) so
    // muted labels read cleanly on parchment. accent-primary-dim also
    // nudged darker (#466630) because the sage was borderline on AA and
    // serves the same de-emphasized-label role in worker-card sublines.
    'color-fg-muted': '#6e5f3e',

    // Polish pass round 3 (2026-04-18): primary darkened (#7ba05b →
    // #3f5a28) because ChatMessage paints orchestrator body text in
    // color-accent-primary; sage green failed AA against parchment.
    // Secondary (terracotta) similarly darkened so user-bubble text
    // clears contrast. Glow/ramps regenerated from new rgbs.
    'color-accent-primary': '#3f5a28',
    'color-accent-primary-dim': '#2d4119',
    'color-accent-primary-tint': '#c9d8b4',
    'color-accent-primary-glow': 'rgba(63, 90, 40, 0.3)',

    'color-accent-secondary': '#8a4a22',
    'color-accent-secondary-dim': '#5f3214',
    'color-accent-secondary-bright': '#b26333',
    'color-accent-secondary-glow': 'rgba(138, 74, 34, 0.3)',

    'color-border-hairline': 'rgba(61, 53, 32, 0.15)',
    'color-border-bright': 'rgba(61, 53, 32, 0.35)',

    'color-danger': '#8a2e26',
    'color-warning': '#8a4a22',
    'color-warning-dim': '#5f3214',
    'color-success': '#3f5a28',
    'color-shadow': 'rgba(61, 53, 32, 0.1)',
    'color-bg-sunken': 'rgba(61, 53, 32, 0.06)',

    'color-accent-primary-a03': 'rgba(63, 90, 40, 0.03)',
    'color-accent-primary-a04': 'rgba(63, 90, 40, 0.04)',
    'color-accent-primary-a05': 'rgba(63, 90, 40, 0.05)',
    'color-accent-primary-a06': 'rgba(63, 90, 40, 0.06)',
    'color-accent-primary-a08': 'rgba(63, 90, 40, 0.08)',
    'color-accent-primary-a10': 'rgba(63, 90, 40, 0.1)',
    'color-accent-primary-a15': 'rgba(63, 90, 40, 0.15)',

    'color-accent-secondary-a00': 'rgba(138, 74, 34, 0)',
    'color-accent-secondary-a04': 'rgba(138, 74, 34, 0.04)',
    'color-accent-secondary-a06': 'rgba(138, 74, 34, 0.06)',
    'color-accent-secondary-a08': 'rgba(138, 74, 34, 0.08)',
    'color-accent-secondary-a10': 'rgba(138, 74, 34, 0.1)',
    'color-accent-secondary-a12': 'rgba(138, 74, 34, 0.12)',
    'color-accent-secondary-a20': 'rgba(138, 74, 34, 0.2)',
    'color-accent-secondary-a25': 'rgba(138, 74, 34, 0.25)',
    'color-accent-secondary-a30': 'rgba(138, 74, 34, 0.3)',
    'color-accent-secondary-a55': 'rgba(138, 74, 34, 0.55)',
    'color-accent-secondary-a90': 'rgba(138, 74, 34, 0.9)',
  },
  fonts: {
    display: "'Fraunces', Georgia, serif",
    body: "'Lora', Georgia, serif",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Lora:wght@400;500;600;700&family=JetBrains+Mono&display=swap',
  },
  glyphs: {
    divider: '❧',
    cursor: '|',
    disclosureOpen: '▾',
    disclosureClosed: '▸',
    diamond: '✦',
    bullet: '•',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '8px',
    radiusMd: '14px',
    panelPadding: '16px',
  },
  // Polish pass round 2 (2026-04-18): watercolor bloom shader disabled per
  // operator request — the washes fought text even at opacity 0.32. Parchment
  // bg + deckle pseudo-elements carry the paper identity on their own.
  // watercolor.frag.glsl + its FRAGMENT_FOR_PRESET entry retained so the
  // effect can be reinstated by flipping this string back.
  shaderPreset: 'none',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: true, flicker: false, cursorBlink: true },
};
