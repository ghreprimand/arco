import type { Theme } from '../types';

// Holographic — iridescent dichroic sheen on deep indigo-black. Primary
// #7d5fff (ultraviolet) / secondary #5cc8ff (thin-film cyan). Iridescence
// is NOT a fullscreen shader (shaderPreset: 'none') — it lives on a handful
// of top-level headers via conic-gradient text-clipping + (when the node
// graph becomes three.js) MeshPhysicalMaterial.iridescence=1.0 on the
// orchestrator/worker nodes. Discipline rule: 1–2 iridescent elements per
// screen max, scarcity carries the read. Alpha ramps derive from primary
// (125, 95, 255) + secondary (92, 200, 255). See §4.8 + §5 gotcha #11.
export const holographic: Theme = {
  id: 'holographic',
  name: 'Holographic',
  description: 'Iridescent dichroic sheen — thin-film interference on dark backdrop',
  mood: 'dark',
  tokens: {
    'color-bg': '#0a0a1a',
    'color-bg-panel': 'rgba(18, 18, 36, 0.92)',
    'color-bg-input': 'rgba(12, 12, 28, 0.97)',
    'color-bg-elevated': 'rgba(26, 26, 48, 0.97)',

    'color-fg': '#f0f0ff',
    // Polish pass round 2 (2026-04-18): fg-muted alpha bumped (0.5 → 0.75)
    // so muted labels clear against indigo-black.
    'color-fg-muted': 'rgba(240, 240, 255, 0.75)',

    // Polish pass round 2 (2026-04-18): primary brightened (#7d5fff →
    // #a088ff) because ChatMessage paints orchestrator body text in
    // color-accent-primary; deeper ultraviolet fell below legibility
    // against the dark indigo bg. dim/tint/glow regenerated from the new
    // rgb (160, 136, 255).
    'color-accent-primary': '#a088ff',
    'color-accent-primary-dim': '#7a5fe0',
    'color-accent-primary-tint': 'rgba(160, 136, 255, 0.2)',
    'color-accent-primary-glow': 'rgba(160, 136, 255, 0.4)',

    'color-accent-secondary': '#5cc8ff',
    'color-accent-secondary-dim': '#3d9dce',
    'color-accent-secondary-bright': '#a8e0ff',
    'color-accent-secondary-glow': 'rgba(92, 200, 255, 0.35)',

    'color-border-hairline': 'rgba(240, 240, 255, 0.12)',
    'color-border-bright': 'rgba(240, 240, 255, 0.4)',

    'color-danger': '#ff4466',
    'color-warning': '#ffc85c',
    'color-warning-dim': '#c89a3a',
    'color-success': '#5cffc8',
    'color-shadow': 'rgba(0, 0, 20, 0.7)',
    'color-bg-sunken': 'rgba(6, 6, 16, 0.55)',

    'color-accent-primary-a03': 'rgba(160, 136, 255, 0.03)',
    'color-accent-primary-a04': 'rgba(160, 136, 255, 0.04)',
    'color-accent-primary-a05': 'rgba(160, 136, 255, 0.05)',
    'color-accent-primary-a06': 'rgba(160, 136, 255, 0.06)',
    'color-accent-primary-a08': 'rgba(160, 136, 255, 0.08)',
    'color-accent-primary-a10': 'rgba(160, 136, 255, 0.1)',
    'color-accent-primary-a15': 'rgba(160, 136, 255, 0.15)',

    'color-accent-secondary-a00': 'rgba(92, 200, 255, 0)',
    'color-accent-secondary-a04': 'rgba(92, 200, 255, 0.04)',
    'color-accent-secondary-a06': 'rgba(92, 200, 255, 0.06)',
    'color-accent-secondary-a08': 'rgba(92, 200, 255, 0.08)',
    'color-accent-secondary-a10': 'rgba(92, 200, 255, 0.1)',
    'color-accent-secondary-a12': 'rgba(92, 200, 255, 0.12)',
    'color-accent-secondary-a20': 'rgba(92, 200, 255, 0.2)',
    'color-accent-secondary-a25': 'rgba(92, 200, 255, 0.25)',
    'color-accent-secondary-a30': 'rgba(92, 200, 255, 0.3)',
    'color-accent-secondary-a55': 'rgba(92, 200, 255, 0.55)',
    'color-accent-secondary-a90': 'rgba(92, 200, 255, 0.9)',
  },
  fonts: {
    display: "'Mona Sans', 'Inter', sans-serif",
    body: "'Inter', sans-serif",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Mona+Sans:wght@400;500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono&display=swap',
  },
  glyphs: {
    divider: '✦',
    cursor: '|',
    disclosureOpen: '▼',
    disclosureClosed: '▶',
    diamond: '⟡',
    bullet: '◈',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '4px',
    radiusMd: '8px',
    panelPadding: '12px',
  },
  // No fullscreen shader — iridescence lives on text-clipped headers (CSS)
  // and on MeshPhysicalMaterial when the node graph becomes three.js. See
  // matrix.css [data-theme="holographic"] rules + §5 gotcha #11.
  shaderPreset: 'none',
  borderRenderer: 'css',
  animations: { scan: true, pulseHalo: true, flicker: false, cursorBlink: true },
};
