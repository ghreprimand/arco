import type { Theme } from '../types';

// Matrix — default theme. Polish pass 2026-04-24: deepened the base black
// (0c0e10 → 050708) so the rain shader's phosphor trails read more
// vividly; bumped primary-glow alpha so the halo layers stack heavier;
// tightened panel opacity for crisper text. 2026-04-28: pushed body bg
// to pure black — 050708 had G>R / B>R, a tiny cool-green cast that
// against the green rain trails read as "not quite black." Cicada uses
// 030305 (neutral) and the operator noted it looks more solidly black; pure
// 000000 commits fully. Panel/input/elevated bgs keep their slight green
// cast for the phosphor-surface feel; only the body matters here.
// The global.css :root still uses the pre-polish values; that only
// matters if bootstrap.ts fails to read localStorage, and applyTheme
// will overwrite either way.
export const matrix: Theme = {
  id: 'matrix',
  name: 'Matrix',
  description: 'Phosphor terminal — green code rain on pitch black',
  mood: 'dark',
  tokens: {
    'color-bg': '#000000',
    'color-bg-panel': 'rgba(6, 12, 8, 0.94)',
    'color-bg-input': 'rgba(4, 10, 6, 0.97)',
    'color-bg-elevated': 'rgba(10, 18, 12, 0.97)',

    'color-fg': '#4af066',
    'color-fg-muted': 'rgba(74, 240, 102, 0.58)',

    'color-accent-primary': '#4af066',
    'color-accent-primary-dim': '#2ecc52',
    'color-accent-primary-tint': '#0f2818',
    'color-accent-primary-glow': 'rgba(74, 240, 102, 0.28)',

    // Phosphor white — near-pure white with the faintest green-cyan cast
    // (R 245 / G 255 / B 248). Reads as honest white in any context but
    // keeps a "metallic chemical reaction" glow on a green-rain ground —
    // think magnesium-burn, glowstick at peak, welding spark. Used for
    // "active / focused / alive" states. The bright variant maxes pure
    // white; dim drops to a cool-leaning gray-green so muted secondary
    // states still feel like the same family.
    'color-accent-secondary': '#f5fff8',
    'color-accent-secondary-dim': '#bcccc4',
    'color-accent-secondary-bright': '#ffffff',
    'color-accent-secondary-glow': 'rgba(245, 255, 248, 0.15)',

    'color-border-hairline': 'rgba(74, 240, 102, 0.12)',
    'color-border-bright': 'rgba(74, 240, 102, 0.3)',

    // True CRT red rather than the magenta-leaning #ff0040. Same alert
    // role; just reads as honest phosphor red instead of LED.
    'color-danger': '#ff2d2d',
    'color-warning': '#ffbf00',
    'color-warning-dim': '#c89900',
    'color-success': '#4af066',
    'color-shadow': 'rgba(0, 0, 0, 0.8)',
    'color-bg-sunken': 'rgba(0, 10, 5, 0.5)',

    'color-accent-primary-a03': 'rgba(74, 240, 102, 0.03)',
    'color-accent-primary-a04': 'rgba(74, 240, 102, 0.04)',
    'color-accent-primary-a05': 'rgba(74, 240, 102, 0.05)',
    'color-accent-primary-a06': 'rgba(74, 240, 102, 0.06)',
    'color-accent-primary-a08': 'rgba(74, 240, 102, 0.08)',
    'color-accent-primary-a10': 'rgba(74, 240, 102, 0.1)',
    'color-accent-primary-a15': 'rgba(74, 240, 102, 0.15)',

    'color-accent-secondary-a00': 'rgba(245, 255, 248, 0)',
    'color-accent-secondary-a04': 'rgba(245, 255, 248, 0.04)',
    'color-accent-secondary-a06': 'rgba(245, 255, 248, 0.06)',
    'color-accent-secondary-a08': 'rgba(245, 255, 248, 0.08)',
    'color-accent-secondary-a10': 'rgba(245, 255, 248, 0.1)',
    'color-accent-secondary-a12': 'rgba(245, 255, 248, 0.12)',
    'color-accent-secondary-a20': 'rgba(245, 255, 248, 0.2)',
    'color-accent-secondary-a25': 'rgba(245, 255, 248, 0.25)',
    'color-accent-secondary-a30': 'rgba(245, 255, 248, 0.3)',
    'color-accent-secondary-a55': 'rgba(245, 255, 248, 0.55)',
    'color-accent-secondary-a90': 'rgba(245, 255, 248, 0.9)',
  },
  fonts: {
    display: "'JetBrains Mono', monospace",
    body: "'JetBrains Mono', monospace",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap',
  },
  glyphs: {
    divider: '◆',
    cursor: '█',
    disclosureOpen: '▼',
    disclosureClosed: '▶',
    diamond: '◆',
    bullet: '●',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '0px',
    radiusMd: '2px',
    panelPadding: '12px',
  },
  shaderPreset: 'matrix-rain',
  borderRenderer: 'css',
  animations: { scan: true, pulseHalo: true, flicker: true, cursorBlink: true },
};
