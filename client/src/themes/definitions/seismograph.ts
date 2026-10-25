import type { Theme } from '../types';

// Seismograph — warm-grey paper stretched across a drum, graphite trace
// scrolling horizontally, faint ruled grid beneath. Light theme. Amplitude
// of the trace ramps with uTension — quiet at rest, agitated under load.
// Fonts: IBM Plex Mono across (instrument-print register, reads well small).
// Alpha ramps derive from primary #2a2a26 (42, 42, 38, graphite) and
// secondary #a85a3a (168, 90, 58, rust — spike tint only).
export const seismograph: Theme = {
  id: 'seismograph',
  name: 'Seismograph',
  description: 'Drum-printed paper — graphite trace, ruled grid, rust spikes',
  mood: 'warm-light',
  tokens: {
    'color-bg': '#e8e2d4',
    'color-bg-panel': '#efe8d8',
    'color-bg-input': '#f4eddc',
    'color-bg-elevated': '#f4eddc',

    'color-fg': '#2a2a26',
    'color-fg-muted': '#6a6458',

    'color-accent-primary': '#2a2a26',
    'color-accent-primary-dim': '#4a463c',
    'color-accent-primary-tint': '#d4cdb8',
    'color-accent-primary-glow': 'rgba(42, 42, 38, 0.20)',

    'color-accent-secondary': '#a85a3a',
    'color-accent-secondary-dim': '#7a4028',
    'color-accent-secondary-bright': '#c67448',
    'color-accent-secondary-glow': 'rgba(168, 90, 58, 0.22)',

    'color-border-hairline': 'rgba(42, 42, 38, 0.18)',
    'color-border-bright': 'rgba(42, 42, 38, 0.42)',

    'color-danger': '#8a2820',
    'color-warning': '#a85a3a',
    'color-warning-dim': '#7a4028',
    'color-success': '#3c6e3c',
    'color-shadow': 'rgba(42, 42, 38, 0.12)',
    'color-bg-sunken': 'rgba(42, 42, 38, 0.05)',

    'color-accent-primary-a03': 'rgba(42, 42, 38, 0.03)',
    'color-accent-primary-a04': 'rgba(42, 42, 38, 0.04)',
    'color-accent-primary-a05': 'rgba(42, 42, 38, 0.05)',
    'color-accent-primary-a06': 'rgba(42, 42, 38, 0.06)',
    'color-accent-primary-a08': 'rgba(42, 42, 38, 0.08)',
    'color-accent-primary-a10': 'rgba(42, 42, 38, 0.10)',
    'color-accent-primary-a15': 'rgba(42, 42, 38, 0.15)',

    'color-accent-secondary-a00': 'rgba(168, 90, 58, 0)',
    'color-accent-secondary-a04': 'rgba(168, 90, 58, 0.04)',
    'color-accent-secondary-a06': 'rgba(168, 90, 58, 0.06)',
    'color-accent-secondary-a08': 'rgba(168, 90, 58, 0.08)',
    'color-accent-secondary-a10': 'rgba(168, 90, 58, 0.10)',
    'color-accent-secondary-a12': 'rgba(168, 90, 58, 0.12)',
    'color-accent-secondary-a20': 'rgba(168, 90, 58, 0.20)',
    'color-accent-secondary-a25': 'rgba(168, 90, 58, 0.25)',
    'color-accent-secondary-a30': 'rgba(168, 90, 58, 0.30)',
    'color-accent-secondary-a55': 'rgba(168, 90, 58, 0.55)',
    'color-accent-secondary-a90': 'rgba(168, 90, 58, 0.90)',
  },
  fonts: {
    display: "'IBM Plex Mono', monospace",
    body: "'IBM Plex Mono', monospace",
    code: "'IBM Plex Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&display=swap',
  },
  glyphs: {
    divider: '─',
    cursor: '|',
    disclosureOpen: '▾',
    disclosureClosed: '▸',
    diamond: '◆',
    bullet: '•',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '1px',
    radiusMd: '2px',
    panelPadding: '14px',
  },
  shaderPreset: 'seismograph',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: false, flicker: false, cursorBlink: true },
};
