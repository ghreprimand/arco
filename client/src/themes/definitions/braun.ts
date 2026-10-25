import type { Theme } from '../types';

// Braun / Rams — industrial minimalism. Near-achromatic, with warm-yellow as
// the single functional accent. Alpha ramps derive from primary #1A1A18 (cool
// near-black) and secondary #D4B018 (warm yellow) so tints composed from the
// Phase 1 matrix rename stay legible on a light canvas.
export const braun: Theme = {
  id: 'braun',
  name: 'Braun',
  description: 'Dieter Rams discipline — near-achromatic, color only where function demands',
  mood: 'light',
  tokens: {
    // Glare pass (2026-06-05): the original near-white bg + pure-#ffffff panels
    // read as too bright. bg muted to a warm grey and panels toned off pure
    // white. Text (#1A1A18) is unchanged, so contrast stays ~15:1 — lowering
    // the surface luminance only widens the gap.
    'color-bg': '#E3DFD4',
    'color-bg-panel': '#F4F1EA',
    'color-bg-input': '#EEEAE0',
    'color-bg-elevated': '#F7F4ED',

    'color-fg': '#1A1A18',
    // Polish pass (2026-04-18): fg-muted at #8A8A87 on #F0EDE5 scores ~2.95
    // contrast — below AA for normal text and even for 3.0 large-text floor.
    // Darkened to #5A5A56 (~5.8 contrast) so muted labels (worker-card
    // secondary text, settings row sublines) actually read. accent-primary-dim
    // shares the same value by design (Braun's "dim" is a single de-emphasized
    // neutral), so the same bump fixes the second reported symptom.
    'color-fg-muted': '#5A5A56',

    'color-accent-primary': '#1A1A18',
    'color-accent-primary-dim': '#5A5A56',
    'color-accent-primary-tint': '#C5C3BE',
    'color-accent-primary-glow': 'rgba(26, 26, 24, 0.08)',

    'color-accent-secondary': '#D4B018',
    'color-accent-secondary-dim': '#A88A10',
    'color-accent-secondary-bright': '#EBC620',
    'color-accent-secondary-glow': 'rgba(212, 176, 24, 0.2)',

    'color-border-hairline': 'rgba(26, 26, 24, 0.12)',
    'color-border-bright': 'rgba(26, 26, 24, 0.4)',

    'color-danger': '#C02820',
    'color-warning': '#D4B018',
    'color-warning-dim': '#A88A10',
    'color-success': '#1A1A18',
    'color-shadow': 'rgba(26, 26, 24, 0.08)',
    'color-bg-sunken': 'rgba(26, 26, 24, 0.04)',

    'color-accent-primary-a03': 'rgba(26, 26, 24, 0.03)',
    'color-accent-primary-a04': 'rgba(26, 26, 24, 0.04)',
    'color-accent-primary-a05': 'rgba(26, 26, 24, 0.05)',
    'color-accent-primary-a06': 'rgba(26, 26, 24, 0.06)',
    'color-accent-primary-a08': 'rgba(26, 26, 24, 0.08)',
    'color-accent-primary-a10': 'rgba(26, 26, 24, 0.1)',
    'color-accent-primary-a15': 'rgba(26, 26, 24, 0.15)',

    'color-accent-secondary-a00': 'rgba(212, 176, 24, 0)',
    'color-accent-secondary-a04': 'rgba(212, 176, 24, 0.04)',
    'color-accent-secondary-a06': 'rgba(212, 176, 24, 0.06)',
    'color-accent-secondary-a08': 'rgba(212, 176, 24, 0.08)',
    'color-accent-secondary-a10': 'rgba(212, 176, 24, 0.1)',
    'color-accent-secondary-a12': 'rgba(212, 176, 24, 0.12)',
    'color-accent-secondary-a20': 'rgba(212, 176, 24, 0.2)',
    'color-accent-secondary-a25': 'rgba(212, 176, 24, 0.25)',
    'color-accent-secondary-a30': 'rgba(212, 176, 24, 0.3)',
    'color-accent-secondary-a55': 'rgba(212, 176, 24, 0.55)',
    'color-accent-secondary-a90': 'rgba(212, 176, 24, 0.9)',
  },
  fonts: {
    display: "'Inter Tight', 'Inter', sans-serif",
    body: "'Inter Tight', 'Inter', sans-serif",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Inter+Tight:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
  },
  glyphs: {
    divider: '—',
    cursor: '|',
    disclosureOpen: '−',
    disclosureClosed: '+',
    diamond: '●',
    bullet: '·',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '0px',
    radiusMd: '2px',
    panelPadding: '16px',
  },
  shaderPreset: 'none',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: false, flicker: false, cursorBlink: true },
};
