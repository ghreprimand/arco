import type { Theme } from '../types';

// DSKY — Apollo Guidance Computer. Inside the capsule, not mission-
// control. Pure black base, electroluminescent green-yellow primary
// (real AGC EL phosphor was closer to yellow-green than pure green),
// warm amber only for warnings. No secondary hue — secondary tracks
// primary so the interface stays reverently single-toned.
// Shader: dskyBloom.frag.glsl — soft centered EL bloom breathing on 4s,
// tiny step-flicker for supply ripple, heavy vignette.
// Text bloom lives in CSS — see styles/matrix.css → [data-theme="dsky"]
// for the segment-glow text-shadow rule.
// Fonts chosen for legibility: Share Tech Mono display (wide, crisp,
// readable at all sizes — avoids the VT323/Major-Mono legibility hit),
// IBM Plex Mono body/code.
// Alpha ramps derive from primary #d4e84a (212, 232, 74).
export const dsky: Theme = {
  id: 'dsky',
  name: 'DSKY',
  description: 'Apollo guidance computer — electroluminescent green on pitch',
  mood: 'dark',
  tokens: {
    'color-bg': '#000000',
    'color-bg-panel': 'rgba(6, 8, 4, 0.96)',
    'color-bg-input': 'rgba(4, 6, 2, 0.98)',
    'color-bg-elevated': 'rgba(10, 14, 8, 0.98)',

    'color-fg': '#d4e84a',
    'color-fg-muted': 'rgba(212, 232, 74, 0.42)',

    'color-accent-primary': '#d4e84a',
    'color-accent-primary-dim': '#8a9a2a',
    'color-accent-primary-tint': '#1a2008',
    'color-accent-primary-glow': 'rgba(212, 232, 74, 0.28)',

    'color-accent-secondary': '#d4e84a',
    'color-accent-secondary-dim': '#8a9a2a',
    'color-accent-secondary-bright': '#e8f280',
    'color-accent-secondary-glow': 'rgba(212, 232, 74, 0.2)',

    'color-border-hairline': 'rgba(212, 232, 74, 0.14)',
    'color-border-bright': 'rgba(212, 232, 74, 0.36)',

    'color-danger': '#ff4a28',
    'color-warning': '#ffa828',
    'color-warning-dim': '#b8741a',
    'color-success': '#d4e84a',
    'color-shadow': 'rgba(0, 0, 0, 0.95)',
    'color-bg-sunken': 'rgba(0, 0, 0, 0.6)',

    'color-accent-primary-a03': 'rgba(212, 232, 74, 0.03)',
    'color-accent-primary-a04': 'rgba(212, 232, 74, 0.04)',
    'color-accent-primary-a05': 'rgba(212, 232, 74, 0.05)',
    'color-accent-primary-a06': 'rgba(212, 232, 74, 0.06)',
    'color-accent-primary-a08': 'rgba(212, 232, 74, 0.08)',
    'color-accent-primary-a10': 'rgba(212, 232, 74, 0.1)',
    'color-accent-primary-a15': 'rgba(212, 232, 74, 0.15)',

    'color-accent-secondary-a00': 'rgba(212, 232, 74, 0)',
    'color-accent-secondary-a04': 'rgba(212, 232, 74, 0.04)',
    'color-accent-secondary-a06': 'rgba(212, 232, 74, 0.06)',
    'color-accent-secondary-a08': 'rgba(212, 232, 74, 0.08)',
    'color-accent-secondary-a10': 'rgba(212, 232, 74, 0.1)',
    'color-accent-secondary-a12': 'rgba(212, 232, 74, 0.12)',
    'color-accent-secondary-a20': 'rgba(212, 232, 74, 0.2)',
    'color-accent-secondary-a25': 'rgba(212, 232, 74, 0.25)',
    'color-accent-secondary-a30': 'rgba(212, 232, 74, 0.3)',
    'color-accent-secondary-a55': 'rgba(212, 232, 74, 0.55)',
    'color-accent-secondary-a90': 'rgba(212, 232, 74, 0.9)',
  },
  fonts: {
    display: "'Share Tech Mono', monospace",
    body: "'IBM Plex Mono', monospace",
    code: "'IBM Plex Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;700&family=Share+Tech+Mono&display=swap',
  },
  glyphs: {
    divider: '─',
    cursor: '█',
    disclosureOpen: '▼',
    disclosureClosed: '▶',
    diamond: '◆',
    bullet: '■',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '0px',
    radiusMd: '0px',
    panelPadding: '12px',
  },
  shaderPreset: 'dsky-bloom',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: true, flicker: true, cursorBlink: true },
};
