import type { Theme } from '../types';

// Arch — the low-power theme (2026-08-06).
//
// Two jobs, in this order:
//
// 1. **Cost.** Built for a 15W ultrabook with an Intel iGPU (the HP EliteBook
//    x360 1040 G6 / i5-8265U / UHD 620 this was measured on). Every other
//    theme in the registry either runs a fullscreen WebGL fragment shader or
//    leans on glow/blur/animated-filter CSS. Measured on that machine at
//    native 1920x1080 / DPR 1: the matrix-rain fragment program costs
//    4.76 ms of GPU per frame net of draw overhead, so the app's 24fps
//    decorative loop burns ~11% of the iGPU continuously and forever — on a
//    part that shares its power budget with the CPU, that is turbo headroom
//    taken away from actual work, plus the WebGL-compositor power-state floor
//    documented in GOTCHAS.md § Themes / shaders.
//
//    So this theme opts out of the whole cost surface, not just the shader:
//      - `shaderPreset: 'none'`   -> ThemedBackgroundShader returns null and
//                                    the WebGL context is never created.
//      - every `animations` flag false, `frosted` unset, no `background`.
//      - **opaque** surface tokens (no rgba on any `color-bg*`) so panels
//        composite without a per-pixel alpha blend against the body.
//      - **no `googleFontsUrl`** — JetBrains Mono is already installed
//        locally on this machine (it is what kitty renders), so the theme
//        costs zero network round-trips and zero webfont rasterization.
//    The remaining per-element glow/filter work is neutralized by the
//    `html[data-theme="arch"]` block in styles/matrix.css.
//
// 2. **Colour.** Catppuccin Mocha — the palette this laptop actually runs
//    (HyDE desktop; hexes lifted verbatim from ~/.config/kitty/theme.conf, so
//    the app matches the terminal sitting next to it). Blue #87b0f9 leads
//    because it is both kitty's `color4` and the closest thing in the palette
//    to Arch's own blue; teal #94e2d5 (kitty `color6`) is the secondary.
export const arch: Theme = {
  id: 'arch',
  name: 'Arch',
  description: 'Catppuccin Mocha — no shader, no glow, no webfont. Built for weak iGPUs.',
  mood: 'dark',
  tokens: {
    // Surfaces: base / mantle / crust / surface0. All opaque on purpose —
    // a translucent panel forces the compositor to blend it against the body
    // every paint, which is exactly the kind of free-floating cost this theme
    // exists to delete.
    'color-bg': '#1e1e2e',
    'color-bg-panel': '#181825',
    'color-bg-input': '#11111b',
    'color-bg-elevated': '#313244',
    'color-bg-sunken': '#11111b',

    // text / overlay2
    'color-fg': '#cdd6f4',
    'color-fg-muted': '#9399b2',

    // blue (kitty color4) — lead accent
    'color-accent-primary': '#87b0f9',
    'color-accent-primary-dim': '#6e93d6',
    'color-accent-primary-tint': '#2a3450',
    'color-accent-primary-glow': 'rgba(135, 176, 249, 0.22)',

    // teal (kitty color6) — secondary
    'color-accent-secondary': '#94e2d5',
    'color-accent-secondary-dim': '#6fbfb3',
    'color-accent-secondary-bright': '#b4f0e6',
    'color-accent-secondary-glow': 'rgba(148, 226, 213, 0.15)',

    // surface0 / surface2 — solid hairlines rather than alpha-over-body.
    'color-border-hairline': '#313244',
    'color-border-bright': '#585b70',

    // red / yellow / green, straight off the kitty palette.
    'color-danger': '#f38ba8',
    'color-warning': '#f9e2af',
    'color-warning-dim': '#d9c48f',
    'color-success': '#a6e3a1',
    'color-shadow': 'rgba(17, 17, 27, 0.6)',

    // Alpha ramps — unavoidable (they are hover/selection tints, which have to
    // read the surface underneath), but a flat alpha blend over an opaque
    // panel is cheap. Nothing here triggers a filter or a blur.
    'color-accent-primary-a03': 'rgba(135, 176, 249, 0.03)',
    'color-accent-primary-a04': 'rgba(135, 176, 249, 0.04)',
    'color-accent-primary-a05': 'rgba(135, 176, 249, 0.05)',
    'color-accent-primary-a06': 'rgba(135, 176, 249, 0.06)',
    'color-accent-primary-a08': 'rgba(135, 176, 249, 0.08)',
    'color-accent-primary-a10': 'rgba(135, 176, 249, 0.1)',
    'color-accent-primary-a15': 'rgba(135, 176, 249, 0.15)',

    'color-accent-secondary-a00': 'rgba(148, 226, 213, 0)',
    'color-accent-secondary-a04': 'rgba(148, 226, 213, 0.04)',
    'color-accent-secondary-a06': 'rgba(148, 226, 213, 0.06)',
    'color-accent-secondary-a08': 'rgba(148, 226, 213, 0.08)',
    'color-accent-secondary-a10': 'rgba(148, 226, 213, 0.1)',
    'color-accent-secondary-a12': 'rgba(148, 226, 213, 0.12)',
    'color-accent-secondary-a20': 'rgba(148, 226, 213, 0.2)',
    'color-accent-secondary-a25': 'rgba(148, 226, 213, 0.25)',
    'color-accent-secondary-a30': 'rgba(148, 226, 213, 0.3)',
    'color-accent-secondary-a55': 'rgba(148, 226, 213, 0.55)',
    'color-accent-secondary-a90': 'rgba(148, 226, 213, 0.9)',
  },
  // No googleFontsUrl — deliberate. JetBrains Mono is installed locally (it is
  // the font kitty renders on this machine), so the browser resolves it from
  // the system font cache: no network fetch, no FOUT, no webfont rasterization
  // pass. Nerd Font first for the same glyph-coverage reason as global.css.
  fonts: {
    display: "'JetBrainsMono Nerd Font', 'JetBrains Mono', ui-monospace, monospace",
    body: "'JetBrainsMono Nerd Font', 'JetBrains Mono', ui-monospace, monospace",
    code: "'JetBrainsMono Nerd Font', 'JetBrains Mono', ui-monospace, monospace",
  },
  glyphs: {
    divider: '·',
    cursor: '▌',
    disclosureOpen: '▾',
    disclosureClosed: '▸',
    diamond: '◆',
    bullet: '•',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '3px',
    radiusMd: '6px',
    panelPadding: '12px',
  },
  shaderPreset: 'none',
  borderRenderer: 'css',
  animations: { scan: false, pulseHalo: false, flicker: false, cursorBlink: false },
};
