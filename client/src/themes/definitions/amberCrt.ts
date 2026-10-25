import type { Theme } from '../types';

// Amber CRT — monochrome datacenter terminal. Amber phosphor on near-pitch
// black, scanlines + barrel distortion + corner vignette in the background
// shader (Phase 3 preset 'amber-crt'). No falling glyphs — that effect is
// matrix-exclusive.
//
// Alpha ramps derive from primary #ffb000 (amber 255, 176, 0) and secondary
// #ffd866 (cream 255, 216, 102) so the Phase 1 tint surfaces stay amber
// across the app without leaking the matrix green defaults.
export const amberCrt: Theme = {
  id: 'amber-crt',
  name: 'Amber CRT',
  description: 'Monochrome datacenter terminal — amber phosphor on pitch black',
  mood: 'dark',
  tokens: {
    'color-bg': '#0a0603',
    'color-bg-panel': 'rgba(16, 10, 4, 0.94)',
    'color-bg-input': 'rgba(10, 6, 3, 0.98)',
    'color-bg-elevated': 'rgba(24, 16, 8, 0.97)',

    'color-fg': '#ffb000',
    'color-fg-muted': 'rgba(255, 176, 0, 0.45)',

    'color-accent-primary': '#ffb000',
    'color-accent-primary-dim': '#a87300',
    'color-accent-primary-tint': '#3a2600',
    'color-accent-primary-glow': 'rgba(255, 176, 0, 0.25)',

    'color-accent-secondary': '#ffd866',
    'color-accent-secondary-dim': '#c2a649',
    'color-accent-secondary-bright': '#ffe699',
    'color-accent-secondary-glow': 'rgba(255, 216, 102, 0.2)',

    'color-border-hairline': 'rgba(255, 176, 0, 0.15)',
    'color-border-bright': 'rgba(255, 176, 0, 0.35)',

    'color-danger': '#ff4500',
    'color-warning': '#ffd866',
    'color-warning-dim': '#c2a649',
    'color-success': '#ffb000',
    'color-shadow': 'rgba(0, 0, 0, 0.9)',
    'color-bg-sunken': 'rgba(20, 12, 4, 0.5)',

    'color-accent-primary-a03': 'rgba(255, 176, 0, 0.03)',
    'color-accent-primary-a04': 'rgba(255, 176, 0, 0.04)',
    'color-accent-primary-a05': 'rgba(255, 176, 0, 0.05)',
    'color-accent-primary-a06': 'rgba(255, 176, 0, 0.06)',
    'color-accent-primary-a08': 'rgba(255, 176, 0, 0.08)',
    'color-accent-primary-a10': 'rgba(255, 176, 0, 0.1)',
    'color-accent-primary-a15': 'rgba(255, 176, 0, 0.15)',

    'color-accent-secondary-a00': 'rgba(255, 216, 102, 0)',
    'color-accent-secondary-a04': 'rgba(255, 216, 102, 0.04)',
    'color-accent-secondary-a06': 'rgba(255, 216, 102, 0.06)',
    'color-accent-secondary-a08': 'rgba(255, 216, 102, 0.08)',
    'color-accent-secondary-a10': 'rgba(255, 216, 102, 0.1)',
    'color-accent-secondary-a12': 'rgba(255, 216, 102, 0.12)',
    'color-accent-secondary-a20': 'rgba(255, 216, 102, 0.2)',
    'color-accent-secondary-a25': 'rgba(255, 216, 102, 0.25)',
    'color-accent-secondary-a30': 'rgba(255, 216, 102, 0.3)',
    'color-accent-secondary-a55': 'rgba(255, 216, 102, 0.55)',
    'color-accent-secondary-a90': 'rgba(255, 216, 102, 0.9)',
  },
  fonts: {
    // Polish pass round 5 (2026-04-18): VT323 rendered blurry/bitmap-soft
    // at our UI sizes even with font-size-adjust. Swapped to the Matrix
    // theme's font stack (Share Tech Mono display, JetBrains Mono body/
    // code) — same terminal register, crisp outline font, and the amber
    // palette already carries the CRT identity without leaning on a
    // period-correct bitmap face.
    display: "'Share Tech Mono', monospace",
    body: "'JetBrains Mono', monospace",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Share+Tech+Mono&display=swap',
  },
  glyphs: {
    divider: '▓',
    cursor: '█',
    disclosureOpen: '▼',
    disclosureClosed: '▶',
    diamond: '◉',
    bullet: '■',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '0px',
    radiusMd: '0px',
    panelPadding: '10px',
  },
  // Polish pass (2026-04-18): operator smoke-test found the barrel +
  // scanlines + vignette + hum-bar combination too distracting. Shader
  // flipped to 'none' — canvas stays unmounted, zero GPU cost. The
  // amberCRT.frag.glsl file + its FRAGMENT_FOR_PRESET entry are intentionally
  // kept in place so an operator who wants the CRT wash back only needs to
  // flip this string; removing the shader entirely would turn it into
  // silently-dead code.
  shaderPreset: 'none',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: true, flicker: true, cursorBlink: true },
};
