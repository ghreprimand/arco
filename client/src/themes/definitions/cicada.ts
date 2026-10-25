import type { Theme } from '../types';

// Cicada — cryptic data stream. Pitch-black base, dim green primary, rare
// flash-white secondary (anomaly cell). Shader is a scrolling LCD-style
// cell grid where each cell lights or stays dark per-frame based on a hash
// seed — reads as a hex dump or encoded telemetry without actually being
// characters. Tension raises the lit ratio.
// Fonts: JetBrains Mono — terminal register.
// Alpha ramps derive from primary #8cd890 (140, 216, 144) and secondary
// #f4f8d8 (244, 248, 216).
export const cicada: Theme = {
  id: 'cicada',
  name: 'Cicada',
  description: 'Cryptic data stream — dim-green LCD grid with anomaly flashes',
  mood: 'dark',
  tokens: {
    'color-bg': '#030305',
    'color-bg-panel': 'rgba(8, 10, 8, 0.95)',
    'color-bg-input': 'rgba(4, 6, 4, 0.97)',
    'color-bg-elevated': 'rgba(14, 16, 14, 0.97)',

    'color-fg': '#8cd890',
    'color-fg-muted': 'rgba(140, 216, 144, 0.46)',

    'color-accent-primary': '#8cd890',
    'color-accent-primary-dim': '#5c9260',
    'color-accent-primary-tint': '#0a1810',
    'color-accent-primary-glow': 'rgba(140, 216, 144, 0.22)',

    'color-accent-secondary': '#f4f8d8',
    'color-accent-secondary-dim': '#b8bc9e',
    'color-accent-secondary-bright': '#fcffe4',
    'color-accent-secondary-glow': 'rgba(244, 248, 216, 0.22)',

    'color-border-hairline': 'rgba(140, 216, 144, 0.12)',
    'color-border-bright': 'rgba(140, 216, 144, 0.30)',

    'color-danger': '#e8584a',
    'color-warning': '#e8b848',
    'color-warning-dim': '#a8853a',
    'color-success': '#8cd890',
    'color-shadow': 'rgba(0, 0, 0, 0.92)',
    'color-bg-sunken': 'rgba(0, 0, 0, 0.6)',

    'color-accent-primary-a03': 'rgba(140, 216, 144, 0.03)',
    'color-accent-primary-a04': 'rgba(140, 216, 144, 0.04)',
    'color-accent-primary-a05': 'rgba(140, 216, 144, 0.05)',
    'color-accent-primary-a06': 'rgba(140, 216, 144, 0.06)',
    'color-accent-primary-a08': 'rgba(140, 216, 144, 0.08)',
    'color-accent-primary-a10': 'rgba(140, 216, 144, 0.10)',
    'color-accent-primary-a15': 'rgba(140, 216, 144, 0.15)',

    'color-accent-secondary-a00': 'rgba(244, 248, 216, 0)',
    'color-accent-secondary-a04': 'rgba(244, 248, 216, 0.04)',
    'color-accent-secondary-a06': 'rgba(244, 248, 216, 0.06)',
    'color-accent-secondary-a08': 'rgba(244, 248, 216, 0.08)',
    'color-accent-secondary-a10': 'rgba(244, 248, 216, 0.10)',
    'color-accent-secondary-a12': 'rgba(244, 248, 216, 0.12)',
    'color-accent-secondary-a20': 'rgba(244, 248, 216, 0.20)',
    'color-accent-secondary-a25': 'rgba(244, 248, 216, 0.25)',
    'color-accent-secondary-a30': 'rgba(244, 248, 216, 0.30)',
    'color-accent-secondary-a55': 'rgba(244, 248, 216, 0.55)',
    'color-accent-secondary-a90': 'rgba(244, 248, 216, 0.90)',
  },
  fonts: {
    display: "'JetBrains Mono', monospace",
    body: "'JetBrains Mono', monospace",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap',
  },
  glyphs: {
    divider: '─',
    cursor: '▌',
    disclosureOpen: '▾',
    disclosureClosed: '▸',
    diamond: '◆',
    bullet: '▪',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '0px',
    radiusMd: '2px',
    panelPadding: '14px',
  },
  shaderPreset: 'cicada',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: false, flicker: true, cursorBlink: true },
};
