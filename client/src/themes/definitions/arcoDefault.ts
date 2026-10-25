import type { Theme } from '../types';

// Arco Default — OdyTTY's flagship `arco-default.theme` palette, tuned for
// the RENDER (not the raw hexes). OdyTTY draws this through a GPU bloom pass that
// lifts bright pixels toward white, so the terminal reads as bright cool mint on
// near-black. The raw spec fg (#88d8b0) rendered FLAT in a browser (no bloom) sits
// at medium luminance and reads as muddy "forest green"; the raw bg greens pile on
// top. `arco-jungle` over-corrected (washed to near-white, lost the color); this
// lands between: foreground brightened + cooled toward the on-screen mint, panels
// pushed toward true black so the mint pops, vivid teal/cyan accents kept, borders
// made visible like btop's box frames. Anchor hexes still honored: accent/cursor
// #40c898 family, palette cyan #18a898 family, warm gold reserved for warnings only.
export const arcoDefault: Theme = {
  id: 'arco-default',
  name: 'Arco Default',
  description: 'OdyTTY flagship — warm cream-mint over near-black with a palette-blue accent',
  mood: 'dark',
  tokens: {
    // Near-black backgrounds — the terminal/btop bg is nearly pure black with a
    // faint green cast; keep the green lift minimal so text carries the color.
    // Panel/base fills are near-black NEUTRAL (only a whisper of green) — the
    // green identity lives in the mint text, teal accents, and waves, not in the
    // box fills. The scrim is built from --color-bg, so a neutral base also
    // de-greens the image showing through. Alphas held below 1 so the waves read
    // through; composer/input kept a touch more opaque for text legibility.
    'color-bg': '#050605',
    'color-bg-panel': 'rgba(7, 8, 8, 0.85)',
    'color-bg-input': 'rgba(4, 5, 5, 0.9)',
    'color-bg-elevated': 'rgba(12, 14, 13, 0.88)',
    'color-bg-sunken': 'rgba(2, 2, 2, 0.72)',
    // Foreground warmed toward OdyTTY's body cream-mint (a touch more yellow,
    // less cyan) so it matches the terminal's soft warm phosphor, not a cold mint.
    'color-fg': '#bee0bc',
    'color-fg-muted': '#68a082',
    // Primary = agent-prose + primary-chrome colour. Warmed from the teal #3fd0a8
    // toward a cream-mint so the bulk of the transcript reads warm like OdyTTY;
    // the cyan secondary below stays as the cool accent pop.
    'color-accent-primary': '#5fd29a',
    'color-accent-primary-dim': '#3fa876',
    'color-accent-primary-tint': '#0a2414',
    'color-accent-primary-glow': 'rgba(95, 210, 154, 0.28)',
    // Secondary — palette BLUE (color12 #5898d8), not cyan. This is the accent
    // for links / bold / user messages / headers; OdyTTY renders inline-code in
    // this blue, and a warm-green body + blue accent reads far better than the
    // green-on-teal it replaced. Bright/dim are lighter/darker steps of the blue.
    // Paled toward periwinkle as a FAMILY (was #78b2ec / #5a90cc / #a0caf5) — the
    // flatter medium blues read too saturated against the near-black. `-dim` is the
    // dominant one: it's the user-message BODY text plus wfid prefixes, role badges,
    // the ACTIVE-PLAN header, and the NORTH-STAR chip — so it gets the same lift as
    // the base, landing a touch softer for hierarchy. Base drives rails / links /
    // inline-code; bright is the hover step. Alpha ramp + glow rebased to the new
    // RGB below so halos and faint fills stay in-family.
    'color-accent-secondary': '#94c1f2',
    'color-accent-secondary-dim': '#86b2ea',
    'color-accent-secondary-bright': '#b6d5f8',
    'color-accent-secondary-glow': 'rgba(148, 193, 242, 0.24)',
    // Borders — btop's box frames are clearly visible dim green, not near-black;
    // give the hairline real presence instead of the invisible raw #102814.
    'color-border-hairline': 'rgba(52, 150, 120, 0.24)',
    'color-border-bright': 'rgba(72, 212, 160, 0.45)',
    'color-danger': '#e05a5a',
    'color-warning': '#d8b030',
    'color-warning-dim': '#8f7420',
    'color-success': '#54d068',
    'color-shadow': 'rgba(0, 0, 0, 0.92)',
    'color-accent-primary-a03': 'rgba(72, 212, 160, 0.03)',
    'color-accent-primary-a04': 'rgba(72, 212, 160, 0.04)',
    'color-accent-primary-a05': 'rgba(72, 212, 160, 0.05)',
    'color-accent-primary-a06': 'rgba(72, 212, 160, 0.06)',
    'color-accent-primary-a08': 'rgba(72, 212, 160, 0.08)',
    'color-accent-primary-a10': 'rgba(72, 212, 160, 0.1)',
    'color-accent-primary-a15': 'rgba(72, 212, 160, 0.15)',
    'color-accent-secondary-a00': 'rgba(148, 193, 242, 0)',
    'color-accent-secondary-a04': 'rgba(148, 193, 242, 0.04)',
    'color-accent-secondary-a06': 'rgba(148, 193, 242, 0.06)',
    'color-accent-secondary-a08': 'rgba(148, 193, 242, 0.08)',
    'color-accent-secondary-a10': 'rgba(148, 193, 242, 0.1)',
    'color-accent-secondary-a12': 'rgba(148, 193, 242, 0.12)',
    'color-accent-secondary-a20': 'rgba(148, 193, 242, 0.2)',
    'color-accent-secondary-a25': 'rgba(148, 193, 242, 0.25)',
    'color-accent-secondary-a30': 'rgba(148, 193, 242, 0.3)',
    'color-accent-secondary-a55': 'rgba(148, 193, 242, 0.55)',
    'color-accent-secondary-a90': 'rgba(148, 193, 242, 0.9)',
  },
  fonts: {
    display: "'Victor Mono', monospace",
    body: "'Victor Mono', monospace",
    code: "'Victor Mono', monospace",
    // Victor Mono is self-hosted in global.css (OdyTTY's terminal font); no
    // Google Fonts URL so the self-hosted Oblique italics win the style match.
    googleFontsUrl: '',
  },
  glyphs: {
    divider: '❧',
    cursor: '▋',
    disclosureOpen: '▾',
    disclosureClosed: '▸',
    diamond: '✦',
    bullet: '·',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '2px',
    radiusMd: '4px',
    panelPadding: '14px',
  },
  shaderPreset: 'none',
  borderRenderer: 'css',
  animations: { scan: true, pulseHalo: true, flicker: false, cursorBlink: true },
  // OdyTTY's bundled "Dark Waves" wallpaper (downscaled to 1920px, ~356KB).
  // Scrim raised above the terminal's 0.5 default: with translucent (frosted)
  // panels, a darker base image is what keeps text legible while still letting
  // the waves read through — the scrim, not panel opacity, is the readability
  // lever for an image-backed theme. Tune down for louder waves, up for contrast.
  background: { image: '/backgrounds/odytty-dark-waves.webp', scrim: 0.8 },
};
