import type { Theme } from '../types';

// Concrete — brutalist industrial. Raw charcoal base with a single
// safety-yellow accent (construction, civil-engineering signage) and a
// cool steel secondary for chrome. Stark geometric density: zero radii,
// firm padding, high-contrast text. The theme is about weight and
// stillness — think Barbican, Herzog & de Meuron, Kraftwerk sleeves.
// Shader: concrete.frag.glsl — static aggregate speckle + a slow
// diagonal shadow pass once per 90s.
// Alpha ramps derive from primary #ffc300 (255, 195, 0) and secondary
// #6b7580 (107, 117, 128).
export const concrete: Theme = {
  id: 'concrete',
  name: 'Concrete',
  description: 'Brutalist industrial — safety yellow on raw charcoal',
  mood: 'dark',
  tokens: {
    'color-bg': '#1a1a1c',
    'color-bg-panel': 'rgba(28, 28, 30, 0.94)',
    'color-bg-input': 'rgba(20, 20, 22, 0.97)',
    'color-bg-elevated': 'rgba(36, 36, 40, 0.97)',

    'color-fg': '#f0f0f0',
    'color-fg-muted': 'rgba(240, 240, 240, 0.48)',

    'color-accent-primary': '#ffc300',
    'color-accent-primary-dim': '#b88a00',
    'color-accent-primary-tint': '#3a2a00',
    'color-accent-primary-glow': 'rgba(255, 195, 0, 0.2)',

    'color-accent-secondary': '#6b7580',
    'color-accent-secondary-dim': '#4a525a',
    'color-accent-secondary-bright': '#9aa4b0',
    'color-accent-secondary-glow': 'rgba(107, 117, 128, 0.15)',

    'color-border-hairline': 'rgba(240, 240, 240, 0.1)',
    'color-border-bright': 'rgba(255, 195, 0, 0.35)',

    'color-danger': '#ff3d3d',
    'color-warning': '#ffc300',
    'color-warning-dim': '#b88a00',
    'color-success': '#8bc34a',
    'color-shadow': 'rgba(0, 0, 0, 0.85)',
    'color-bg-sunken': 'rgba(10, 10, 12, 0.55)',

    'color-accent-primary-a03': 'rgba(255, 195, 0, 0.03)',
    'color-accent-primary-a04': 'rgba(255, 195, 0, 0.04)',
    'color-accent-primary-a05': 'rgba(255, 195, 0, 0.05)',
    'color-accent-primary-a06': 'rgba(255, 195, 0, 0.06)',
    'color-accent-primary-a08': 'rgba(255, 195, 0, 0.08)',
    'color-accent-primary-a10': 'rgba(255, 195, 0, 0.1)',
    'color-accent-primary-a15': 'rgba(255, 195, 0, 0.15)',

    'color-accent-secondary-a00': 'rgba(107, 117, 128, 0)',
    'color-accent-secondary-a04': 'rgba(107, 117, 128, 0.04)',
    'color-accent-secondary-a06': 'rgba(107, 117, 128, 0.06)',
    'color-accent-secondary-a08': 'rgba(107, 117, 128, 0.08)',
    'color-accent-secondary-a10': 'rgba(107, 117, 128, 0.1)',
    'color-accent-secondary-a12': 'rgba(107, 117, 128, 0.12)',
    'color-accent-secondary-a20': 'rgba(107, 117, 128, 0.2)',
    'color-accent-secondary-a25': 'rgba(107, 117, 128, 0.25)',
    'color-accent-secondary-a30': 'rgba(107, 117, 128, 0.3)',
    'color-accent-secondary-a55': 'rgba(107, 117, 128, 0.55)',
    'color-accent-secondary-a90': 'rgba(107, 117, 128, 0.9)',
  },
  fonts: {
    // Display = IBM Plex Sans Condensed Bold — chunky architectural sans,
    // wide enough to feel carved, dense enough to feel industrial.
    // Body = IBM Plex Sans — workhorse sans, highly legible at UI sizes.
    // Code = IBM Plex Mono — matches the Plex family.
    display: "'IBM Plex Sans Condensed', sans-serif",
    body: "'IBM Plex Sans', sans-serif",
    code: "'IBM Plex Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;700&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Sans+Condensed:wght@500;600;700&display=swap',
  },
  glyphs: {
    divider: '▬',
    cursor: '▊',
    disclosureOpen: '▼',
    disclosureClosed: '▶',
    diamond: '■',
    bullet: '▪',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '0px',
    radiusMd: '0px',
    panelPadding: '14px',
  },
  shaderPreset: 'concrete',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: false, flicker: false, cursorBlink: true },
};
