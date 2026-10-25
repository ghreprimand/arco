import type { Theme } from '../types';

// Dark Academia — candle-lit library. Walnut bg warmed by a radial candle in
// the pen-and-ink shader; ivy primary, gilt secondary. Alpha ramps derive
// from primary #4a6b3a (ivy/olive) and secondary #d4b068 (gilt) so the
// Phase-1 tint surfaces read as faint warm-green / faint gold rather than
// leaking matrix defaults. Fleurons (❦ ❧ ☙) carry the literary register into
// dividers + disclosure glyphs.
export const darkAcademia: Theme = {
  id: 'dark-academia',
  name: 'Dark Academia',
  description: 'Candle-lit library — walnut, ivy, parchment, oxblood',
  mood: 'warm-dark',
  tokens: {
    'color-bg': '#1a1410',
    'color-bg-panel': 'rgba(43, 34, 26, 0.95)',
    'color-bg-input': 'rgba(30, 24, 18, 0.97)',
    'color-bg-elevated': 'rgba(52, 42, 32, 0.97)',

    'color-fg': '#e8dcc0',
    // Polish pass round 2 (2026-04-18): fg-muted brightened (#8a7a5c → #b5a27a)
    // so captions and worker sublines clear legibility against walnut bg.
    'color-fg-muted': '#b5a27a',

    // Polish pass round 2 (2026-04-18): primary brightened (#4a6b3a →
    // #8aab6a) so orchestrator chat bubbles (which paint their body text
    // in color-accent-primary) read clearly against walnut. dim/tint
    // follow the new hue at reduced luminance; glow + alpha ramps below
    // regenerated from the new rgb (138, 171, 106).
    'color-accent-primary': '#8aab6a',
    'color-accent-primary-dim': '#5e7944',
    'color-accent-primary-tint': '#2c3a21',
    'color-accent-primary-glow': 'rgba(138, 171, 106, 0.3)',

    'color-accent-secondary': '#d4b068',
    'color-accent-secondary-dim': '#a88848',
    'color-accent-secondary-bright': '#eccf8e',
    'color-accent-secondary-glow': 'rgba(212, 176, 104, 0.25)',

    'color-border-hairline': 'rgba(232, 220, 192, 0.15)',
    'color-border-bright': 'rgba(232, 220, 192, 0.4)',

    'color-danger': '#8b2f2f',
    'color-warning': '#d4b068',
    'color-warning-dim': '#a88848',
    'color-success': '#8aab6a',
    'color-shadow': 'rgba(0, 0, 0, 0.7)',
    'color-bg-sunken': 'rgba(10, 6, 2, 0.45)',

    'color-accent-primary-a03': 'rgba(138, 171, 106, 0.03)',
    'color-accent-primary-a04': 'rgba(138, 171, 106, 0.04)',
    'color-accent-primary-a05': 'rgba(138, 171, 106, 0.05)',
    'color-accent-primary-a06': 'rgba(138, 171, 106, 0.06)',
    'color-accent-primary-a08': 'rgba(138, 171, 106, 0.08)',
    'color-accent-primary-a10': 'rgba(138, 171, 106, 0.1)',
    'color-accent-primary-a15': 'rgba(138, 171, 106, 0.15)',

    'color-accent-secondary-a00': 'rgba(212, 176, 104, 0)',
    'color-accent-secondary-a04': 'rgba(212, 176, 104, 0.04)',
    'color-accent-secondary-a06': 'rgba(212, 176, 104, 0.06)',
    'color-accent-secondary-a08': 'rgba(212, 176, 104, 0.08)',
    'color-accent-secondary-a10': 'rgba(212, 176, 104, 0.1)',
    'color-accent-secondary-a12': 'rgba(212, 176, 104, 0.12)',
    'color-accent-secondary-a20': 'rgba(212, 176, 104, 0.2)',
    'color-accent-secondary-a25': 'rgba(212, 176, 104, 0.25)',
    'color-accent-secondary-a30': 'rgba(212, 176, 104, 0.3)',
    'color-accent-secondary-a55': 'rgba(212, 176, 104, 0.55)',
    'color-accent-secondary-a90': 'rgba(212, 176, 104, 0.9)',
  },
  fonts: {
    // Display kept as EB Garamond (fine at heading sizes).
    // Body swapped Crimson Pro → Lora: Lora is screen-optimised serif
    // body text, retains the literary feel without the thin-at-UI-sizes
    // legibility hit that Crimson takes.
    display: "'EB Garamond', Garamond, serif",
    body: "'Lora', 'EB Garamond', Garamond, serif",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;500;600;700&family=Lora:wght@400;500;600;700&family=JetBrains+Mono&display=swap',
  },
  glyphs: {
    divider: '❦',
    cursor: '|',
    disclosureOpen: '❧',
    disclosureClosed: '☙',
    diamond: '✦',
    bullet: '•',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '2px',
    radiusMd: '4px',
    panelPadding: '16px',
  },
  // Polish pass (2026-04-18): the pen-and-ink shader's radial candle glow
  // + cross-hatching read as a bright center blob fighting the UI rather
  // than as ambient ink. Shader flipped to 'none'. The paper grain body
  // overlay (html[data-theme="dark-academia"] body in matrix.css) stays
  // and now carries the theme identity on its own. penAndInk.frag.glsl +
  // its FRAGMENT_FOR_PRESET entry kept intact so the center effect can be
  // reinstated by flipping this string back.
  shaderPreset: 'none',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: true, flicker: true, cursorBlink: true },
};
