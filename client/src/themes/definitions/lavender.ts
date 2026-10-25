import type { Theme } from '../types';

// Lavender — soft, pale, calming. Archon's other lights are utilitarian
// (braun / seismograph / solar-paper); this is the gentle pastel one, and the
// showcase for the frosted-glass mode. Light mood: primary stays dark enough
// to read on the pale bg (ChatMessage paints body text in accent-primary).
export const lavender: Theme = {
  id: 'lavender',
  name: 'Lavender',
  description: 'Soft frosted lilac — gentle purple on pale violet glass',
  mood: 'light',
  tokens: {
    // Glare pass (2026-06-05): deepened the lilac bg. Panels are OPAQUE lilac so
    // frosted OFF reads as solid; frosted mode (apply.ts) lowers their alpha to
    // produce the see-through glass. (They used to be translucent here, which
    // made frost-off already see-through and the toggle only changed the blur —
    // the "frosted seems backwards" report.) Text #3a3151 unchanged.
    'color-bg': '#e1d8f0',
    'color-bg-panel': '#ece6f7',
    'color-bg-input': '#f2edfb',
    'color-bg-elevated': '#f0eaf9',
    'color-fg': '#3a3151',
    'color-fg-muted': 'rgba(58, 49, 81, 0.66)',
    'color-accent-primary': '#7253b8',
    'color-accent-primary-dim': '#523a86',
    'color-accent-primary-tint': '#ddd2f0',
    'color-accent-primary-glow': 'rgba(114, 83, 184, 0.25)',
    'color-accent-secondary': '#a87fc4',
    'color-accent-secondary-dim': '#82589e',
    'color-accent-secondary-bright': '#c4a3da',
    'color-accent-secondary-glow': 'rgba(168, 127, 196, 0.22)',
    'color-border-hairline': 'rgba(58, 49, 81, 0.14)',
    'color-border-bright': 'rgba(114, 83, 184, 0.38)',
    'color-danger': '#d65a7a',
    'color-warning': '#d99a4a',
    'color-warning-dim': '#a5722f',
    'color-success': '#5cae8a',
    'color-shadow': 'rgba(58, 49, 81, 0.14)',
    'color-bg-sunken': 'rgba(58, 49, 81, 0.05)',
    'color-accent-primary-a03': 'rgba(114, 83, 184, 0.03)',
    'color-accent-primary-a04': 'rgba(114, 83, 184, 0.04)',
    'color-accent-primary-a05': 'rgba(114, 83, 184, 0.05)',
    'color-accent-primary-a06': 'rgba(114, 83, 184, 0.06)',
    'color-accent-primary-a08': 'rgba(114, 83, 184, 0.08)',
    'color-accent-primary-a10': 'rgba(114, 83, 184, 0.1)',
    'color-accent-primary-a15': 'rgba(114, 83, 184, 0.15)',
    'color-accent-secondary-a00': 'rgba(168, 127, 196, 0)',
    'color-accent-secondary-a04': 'rgba(168, 127, 196, 0.04)',
    'color-accent-secondary-a06': 'rgba(168, 127, 196, 0.06)',
    'color-accent-secondary-a08': 'rgba(168, 127, 196, 0.08)',
    'color-accent-secondary-a10': 'rgba(168, 127, 196, 0.1)',
    'color-accent-secondary-a12': 'rgba(168, 127, 196, 0.12)',
    'color-accent-secondary-a20': 'rgba(168, 127, 196, 0.2)',
    'color-accent-secondary-a25': 'rgba(168, 127, 196, 0.25)',
    'color-accent-secondary-a30': 'rgba(168, 127, 196, 0.3)',
    'color-accent-secondary-a55': 'rgba(168, 127, 196, 0.55)',
    'color-accent-secondary-a90': 'rgba(168, 127, 196, 0.9)',
    'color-link': '#6a3fb0',
    'color-link-hover': '#8458cc',
  },
  fonts: {
    display: "'Comfortaa', sans-serif",
    body: "'Nunito Sans', sans-serif",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Comfortaa:wght@400;500;600;700&family=Nunito+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap',
  },
  glyphs: {
    divider: '❖',
    cursor: '|',
    disclosureOpen: '▾',
    disclosureClosed: '▸',
    diamond: '✦',
    bullet: '·',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '8px',
    radiusMd: '14px',
    panelPadding: '14px',
  },
  shaderPreset: 'none',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: true, flicker: false, cursorBlink: true },
  frosted: true,
};
