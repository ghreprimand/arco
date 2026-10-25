// Theme manifest shape — drives runtime var/font/density/glyph swaps.
// See docs/THEMES_IMPLEMENTATION_PLAN.md §2.2 for the design rationale.

export type ShaderPreset =
  | 'matrix-rain'
  | 'amber-crt'
  | 'liquid-glass'
  | 'blueprint-grid'
  | 'pen-and-ink'
  | 'watercolor'
  | 'marine-snow'
  | 'star-drift'
  | 'film-grain'
  | 'rain-glass'
  | 'heat-haze'
  | 'oscilloscope'
  | 'concrete'
  | 'tape-drift'
  | 'bloodmoon'
  | 'carbon-weave'
  | 'dsky-bloom'
  | 'sentinel'
  | 'cherenkov'
  | 'infrared'
  | 'aurora'
  | 'nebula'
  | 'sonar'
  | 'seismograph'
  | 'kintsugi'
  | 'cicada'
  | 'tarkovsky'
  | 'night-city'
  | 'sakura-petals'
  | 'none';

export type BorderRenderer = 'css' | 'rough';

export type ThemeMood = 'dark' | 'light' | 'warm-dark' | 'warm-light';

export interface Theme {
  id: string;
  family?: 'classic' | 'phosphor';
  category?: string;
  name: string;
  description: string;
  mood: ThemeMood;
  tokens: Record<string, string>;
  fonts: {
    display: string;
    body: string;
    code: string;
    googleFontsUrl?: string;
  };
  glyphs: {
    divider: string;
    cursor: string;
    disclosureOpen: string;
    disclosureClosed: string;
    diamond: string;
    bullet: string;
  };
  density: {
    spacingUnit: string;
    borderWidth: string;
    radiusSm: string;
    radiusMd: string;
    panelPadding: string;
  };
  shaderPreset: ShaderPreset;
  borderRenderer: BorderRenderer;
  animations: {
    scan: boolean;
    pulseHalo: boolean;
    flicker: boolean;
    cursorBlink: boolean;
  };
  // Optional exact xterm palette. Most themes let xterm retain its ANSI
  // defaults and only inherit Archon's surface/text/cursor roles; terminal-
  // palette ports can provide the complete Core + ANSI table without forcing
  // 22 extra CSS variables onto every app theme.
  terminal?: {
    background: string;
    foreground: string;
    cursor: string;
    cursorAccent: string;
    selectionBackground: string;
    selectionForeground: string;
    black: string;
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    white: string;
    brightBlack: string;
    brightRed: string;
    brightGreen: string;
    brightYellow: string;
    brightBlue: string;
    brightMagenta: string;
    brightCyan: string;
    brightWhite: string;
  };
  // Frosted-glass mode (ported from the Odysseus theme system, 2026-06-05).
  // When true, applyTheme sets data-frosted=1 on <html> and matrix.css adds a
  // backdrop-filter blur + raised translucency to panel/elevated surfaces, so
  // the backdrop reads through softly. Optional — omit/false for opaque themes.
  frosted?: boolean;
  // Fixed background image (2026-07-09) — Archon's first image-backed theme
  // capability, ported from OdyTTY's bundled wallpaper. `image` is a URL served
  // from client/public (e.g. '/backgrounds/foo.webp'). applyTheme paints it on
  // <body> under a `scrim` layer of --color-bg (0..1, default 0.5, matching
  // OdyTTY's DEFAULT_BACKGROUND_IMAGE_SCRIM) so text stays legible; it only reads
  // through where panel surfaces are translucent. Optional — omit for flat bg.
  background?: {
    image: string;
    scrim?: number;
  };
}
