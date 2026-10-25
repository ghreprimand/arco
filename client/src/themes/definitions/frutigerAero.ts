import type { Theme } from '../types';

// Frutiger Aero — Vista-era bubble optimism. Sky-blue primary #00a8e8 +
// mint secondary #7dd3a0 on a pale-sky bg. Translucent panels (~55% white)
// show the cloudscape shader + body frost through directly; theme-scoped
// CSS rules in matrix.css add backdrop-filter blur on `.glow-border`
// surfaces + a viewport-wide top specular highlight. Alpha ramps derive
// from primary (0, 168, 232) + secondary (125, 211, 160). Shader preset
// 'liquid-glass'. See plan §4.3 + §3 Phase 6.
export const frutigerAero: Theme = {
  id: 'frutiger-aero',
  name: 'Frutiger Aero',
  description: 'Glossy glass — Vista-era bubble optimism',
  mood: 'light',
  tokens: {
    // Polish pass (2026-04-18): sky bg dropped from #d6eaf5 → #b8d4e8
    // (deeper sky). Original bg + body frost overlay + top specular
    // read as overall bright wash, fighting text legibility. The deeper
    // bg keeps the Vista-sky identity while giving text a canvas that
    // doesn't blow out. Top-specular alpha halved in matrix.css (0.4→0.2)
    // alongside this change.
    // Glare pass (2026-06-05): nudged the sky bg a touch deeper and pulled the
    // white translucency on input/elevated surfaces down — they were the bright
    // spots. Kept the glass identity (panels still translucent white). Text
    // (#051c33) unchanged.
    'color-bg': '#a8c8de',
    'color-bg-panel': 'rgba(255, 255, 255, 0.5)',
    'color-bg-input': 'rgba(255, 255, 255, 0.68)',
    'color-bg-elevated': 'rgba(255, 255, 255, 0.76)',

    // fg darkened (#0a2540 → #051c33) + fg-muted opacity bumped 0.55→0.75
    // so both clear AA against the new deeper-sky bg. Panel surfaces stay
    // translucent (~55% white) so the underlying bg tint doesn't suddenly
    // flip dark — text reads against a muted sky filtered through frost.
    'color-fg': '#051c33',
    'color-fg-muted': 'rgba(5, 28, 51, 0.75)',

    // Polish pass round 2 (2026-04-18): primary darkened (#00a8e8 →
    // #005a82) because ChatMessage paints its orchestrator body text in
    // color-accent-primary; bright sky-blue fell below legibility against
    // the glass panels + sky bg. dim/tint/glow follow the new rgb
    // (0, 90, 130) so derived surfaces stay coherent.
    'color-accent-primary': '#005a82',
    'color-accent-primary-dim': '#003e5c',
    'color-accent-primary-tint': '#b3d7ea',
    'color-accent-primary-glow': 'rgba(0, 90, 130, 0.35)',

    'color-accent-secondary': '#7dd3a0',
    'color-accent-secondary-dim': '#4aa574',
    'color-accent-secondary-bright': '#a8e6c1',
    'color-accent-secondary-glow': 'rgba(125, 211, 160, 0.25)',

    'color-border-hairline': 'rgba(10, 37, 64, 0.08)',
    'color-border-bright': 'rgba(0, 90, 130, 0.55)',

    // Markdown links: accent-secondary (mint #7dd3a0) washed out on the light
    // glass bg and was unreadable (operator report 2026-06-05). Override with a
    // dark emerald (~5.4:1 on the sky bg) that keeps the green link identity
    // distinct from accent-primary body text. Consumed by .archon-markdown a.
    'color-link': '#0a6b46',
    'color-link-hover': '#0d8a5a',

    'color-danger': '#ff6b6b',
    'color-warning': '#ffb347',
    'color-warning-dim': '#c2872e',
    'color-success': '#7dd3a0',
    'color-shadow': 'rgba(10, 37, 64, 0.15)',
    'color-bg-sunken': 'rgba(10, 37, 64, 0.05)',

    'color-accent-primary-a03': 'rgba(0, 90, 130, 0.03)',
    'color-accent-primary-a04': 'rgba(0, 90, 130, 0.04)',
    'color-accent-primary-a05': 'rgba(0, 90, 130, 0.05)',
    'color-accent-primary-a06': 'rgba(0, 90, 130, 0.06)',
    'color-accent-primary-a08': 'rgba(0, 90, 130, 0.08)',
    'color-accent-primary-a10': 'rgba(0, 90, 130, 0.1)',
    'color-accent-primary-a15': 'rgba(0, 90, 130, 0.15)',

    'color-accent-secondary-a00': 'rgba(125, 211, 160, 0)',
    'color-accent-secondary-a04': 'rgba(125, 211, 160, 0.04)',
    'color-accent-secondary-a06': 'rgba(125, 211, 160, 0.06)',
    'color-accent-secondary-a08': 'rgba(125, 211, 160, 0.08)',
    'color-accent-secondary-a10': 'rgba(125, 211, 160, 0.1)',
    'color-accent-secondary-a12': 'rgba(125, 211, 160, 0.12)',
    'color-accent-secondary-a20': 'rgba(125, 211, 160, 0.2)',
    'color-accent-secondary-a25': 'rgba(125, 211, 160, 0.25)',
    'color-accent-secondary-a30': 'rgba(125, 211, 160, 0.3)',
    'color-accent-secondary-a55': 'rgba(125, 211, 160, 0.55)',
    'color-accent-secondary-a90': 'rgba(125, 211, 160, 0.9)',
  },
  fonts: {
    display: "'Figtree', 'Inter', sans-serif",
    body: "'Inter', sans-serif",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap',
  },
  glyphs: {
    divider: '●',
    cursor: '|',
    disclosureOpen: '▾',
    disclosureClosed: '▸',
    diamond: '✦',
    bullet: '○',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '6px',
    radiusMd: '10px',
    panelPadding: '14px',
  },
  shaderPreset: 'liquid-glass',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: true, flicker: false, cursorBlink: true },
};
