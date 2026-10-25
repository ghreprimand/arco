import type { Theme } from '../types';

// Blueprint — engineering schematic on deep navy. Cyan linework at 4/20px
// scales reads as a drafting table: minor grid for fine references, major grid
// for legibility. Alpha ramps derive from primary #5dd7fb (cyan) and secondary
// #e3f2fd (near-white) so Phase-1 tints read as faint cyan wash on navy rather
// than leaking matrix-green defaults. Shader preset 'blueprint-grid'.
export const blueprint: Theme = {
  id: 'blueprint',
  name: 'Blueprint',
  description: 'Engineering schematic — cyan linework on deep navy, drafting-lamp glow',
  mood: 'dark',
  tokens: {
    'color-bg': '#0b2a5e',
    'color-bg-panel': 'rgba(13, 58, 122, 0.88)',
    'color-bg-input': 'rgba(8, 36, 82, 0.95)',
    'color-bg-elevated': 'rgba(18, 70, 140, 0.95)',

    'color-fg': '#e3f2fd',
    'color-fg-muted': '#6b8cc7',

    'color-accent-primary': '#5dd7fb',
    'color-accent-primary-dim': '#3ba8c9',
    'color-accent-primary-tint': '#123d6b',
    'color-accent-primary-glow': 'rgba(93, 215, 251, 0.35)',

    'color-accent-secondary': '#e3f2fd',
    'color-accent-secondary-dim': '#a8c5db',
    'color-accent-secondary-bright': '#ffffff',
    'color-accent-secondary-glow': 'rgba(227, 242, 253, 0.2)',

    'color-border-hairline': 'rgba(93, 215, 251, 0.25)',
    'color-border-bright': 'rgba(93, 215, 251, 0.6)',

    'color-danger': '#ff8fa3',
    'color-warning': '#ffd76b',
    'color-warning-dim': '#c29e3a',
    'color-success': '#5dd7fb',
    'color-shadow': 'rgba(0, 10, 30, 0.7)',
    'color-bg-sunken': 'rgba(4, 20, 50, 0.55)',

    'color-accent-primary-a03': 'rgba(93, 215, 251, 0.03)',
    'color-accent-primary-a04': 'rgba(93, 215, 251, 0.04)',
    'color-accent-primary-a05': 'rgba(93, 215, 251, 0.05)',
    'color-accent-primary-a06': 'rgba(93, 215, 251, 0.06)',
    'color-accent-primary-a08': 'rgba(93, 215, 251, 0.08)',
    'color-accent-primary-a10': 'rgba(93, 215, 251, 0.1)',
    'color-accent-primary-a15': 'rgba(93, 215, 251, 0.15)',

    'color-accent-secondary-a00': 'rgba(227, 242, 253, 0)',
    'color-accent-secondary-a04': 'rgba(227, 242, 253, 0.04)',
    'color-accent-secondary-a06': 'rgba(227, 242, 253, 0.06)',
    'color-accent-secondary-a08': 'rgba(227, 242, 253, 0.08)',
    'color-accent-secondary-a10': 'rgba(227, 242, 253, 0.1)',
    'color-accent-secondary-a12': 'rgba(227, 242, 253, 0.12)',
    'color-accent-secondary-a20': 'rgba(227, 242, 253, 0.2)',
    'color-accent-secondary-a25': 'rgba(227, 242, 253, 0.25)',
    'color-accent-secondary-a30': 'rgba(227, 242, 253, 0.3)',
    'color-accent-secondary-a55': 'rgba(227, 242, 253, 0.55)',
    'color-accent-secondary-a90': 'rgba(227, 242, 253, 0.9)',
  },
  fonts: {
    // Polish pass (2026-04-18): Major Mono Display is decorative-only and
    // falls apart at UI sizes (10–12 px worker/status labels render
    // unreadably). Swap display to JetBrains Mono — the body font already
    // carries the drafting register through monospaced cadence, and the
    // cyan palette + grid shader do the rest of the theme's heavy lifting.
    // googleFontsUrl drops the Major Mono request.
    display: "'JetBrains Mono', monospace",
    body: "'JetBrains Mono', monospace",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap',
  },
  glyphs: {
    divider: '┄',
    cursor: '|',
    disclosureOpen: '▽',
    disclosureClosed: '▷',
    diamond: '◇',
    bullet: '○',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '0px',
    radiusMd: '0px',
    panelPadding: '12px',
  },
  shaderPreset: 'blueprint-grid',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: true, flicker: false, cursorBlink: true },
};
