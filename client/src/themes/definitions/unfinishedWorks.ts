import type { Theme } from '../types';

// Unfinished Works — ported from a terminal-style landing page:
// a static browser-terminal ("uwsh") rendered as a teal-phosphor CRT on
// pitch black. The site reads as a workbench records terminal — dotted
// leader lines, multi-color command prompts, and a big bloomed "UNFINISHED
// WORKS" display head in near-white. Distinct from matrix: no glyph rain,
// the green is pulled teal-ward (mint/spring rather than #4af066 lime), and
// the identity lives in the phosphor glow rather than falling code.
// Shader: 'none' — deliberately no animated WebGL background. The amber-crt
// preset (rolling hum bar + scanline drift) read as too aggressive against
// the otherwise-static site; the identity here is the pure-black ground plus
// the per-element text/panel glows from the tokens, matching the landing
// page's mostly-black backdrop. Element-level scan/halo stay on for the
// gentle terminal touch.
// Alpha ramps derive from primary #44e6a0 (68, 230, 160) and secondary
// #ecf6f0 (236, 246, 240).
export const unfinishedWorks: Theme = {
  id: 'unfinished-works',
  name: 'Unfinished Works',
  description: 'Workbench CRT — teal phosphor on pitch black, scanline bloom',
  mood: 'dark',
  tokens: {
    // Palette lifted verbatim from the site's :root (css/styles.css):
    //   --bg #020806 / --cyan-dim #86b8aa (body) / --green #00ff66 /
    //   --white #cfded4 / --amber #ffaa00 / --red #ff3344 / --magenta #ff44ff.
    'color-bg': '#020806',
    'color-bg-panel': 'rgba(5, 16, 12, 0.92)',
    'color-bg-input': 'rgba(3, 11, 8, 0.96)',
    'color-bg-elevated': 'rgba(8, 20, 15, 0.97)',

    // Body prose is the site's muted teal-grey (#86b8aa / --cyan-dim), NOT a
    // bright green. This is what gives the look its variation: dim teal prose
    // under saturated green / amber / white accents, the way the landing reads.
    'color-fg': '#86b8aa',
    'color-fg-muted': 'rgba(134, 184, 170, 0.55)',

    // Phosphor green — prompts, borders, active chrome. The site's raw --green
    // is #00ff66 (fully saturated), but on Arco — without the site's screen-
    // blend CRT film paling it — that read as too vivid/crisp. Nudged paler
    // toward a pastel phosphor green (#4ced95) so it matches the site's
    // rendered appearance. Glow stays teal-ward (rgba(0,138,112)-ish bloom).
    'color-accent-primary': '#4ced95',
    'color-accent-primary-dim': '#2cbf72',
    'color-accent-primary-tint': '#04220f',
    'color-accent-primary-glow': 'rgba(0, 180, 120, 0.32)',

    // The wordmark / bright-highlight white (#cfded4 / --white) — the grey-
    // white "UNFINISHED WORKS" head reads as honest white but stays family.
    'color-accent-secondary': '#cfded4',
    'color-accent-secondary-dim': '#8fa399',
    'color-accent-secondary-bright': '#ffffff',
    'color-accent-secondary-glow': 'rgba(207, 222, 212, 0.18)',

    'color-border-hairline': 'rgba(76, 237, 149, 0.12)',
    'color-border-bright': 'rgba(76, 237, 149, 0.30)',

    // Site --red / --amber for alert + warning roles (the amber is the same
    // hue used for the `read` / `list /games` command titles + BENCH row).
    'color-danger': '#ff3344',
    'color-warning': '#ffaa00',
    'color-warning-dim': '#c88500',
    'color-success': '#4ced95',
    'color-shadow': 'rgba(0, 0, 0, 0.85)',
    'color-bg-sunken': 'rgba(0, 12, 8, 0.5)',

    'color-accent-primary-a03': 'rgba(0, 255, 102, 0.03)',
    'color-accent-primary-a04': 'rgba(0, 255, 102, 0.04)',
    'color-accent-primary-a05': 'rgba(0, 255, 102, 0.05)',
    'color-accent-primary-a06': 'rgba(0, 255, 102, 0.06)',
    'color-accent-primary-a08': 'rgba(0, 255, 102, 0.08)',
    'color-accent-primary-a10': 'rgba(0, 255, 102, 0.1)',
    'color-accent-primary-a15': 'rgba(0, 255, 102, 0.15)',

    'color-accent-secondary-a00': 'rgba(207, 222, 212, 0)',
    'color-accent-secondary-a04': 'rgba(207, 222, 212, 0.04)',
    'color-accent-secondary-a06': 'rgba(207, 222, 212, 0.06)',
    'color-accent-secondary-a08': 'rgba(207, 222, 212, 0.08)',
    'color-accent-secondary-a10': 'rgba(207, 222, 212, 0.1)',
    'color-accent-secondary-a12': 'rgba(207, 222, 212, 0.12)',
    'color-accent-secondary-a20': 'rgba(207, 222, 212, 0.2)',
    'color-accent-secondary-a25': 'rgba(207, 222, 212, 0.25)',
    'color-accent-secondary-a30': 'rgba(207, 222, 212, 0.3)',
    'color-accent-secondary-a55': 'rgba(207, 222, 212, 0.55)',
    'color-accent-secondary-a90': 'rgba(207, 222, 212, 0.9)',
  },
  fonts: {
    display: "'JetBrains Mono', monospace",
    body: "'JetBrains Mono', monospace",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap',
  },
  glyphs: {
    // '·' echoes the dotted leader lines that run between the site's
    // command names and their descriptions.
    divider: '·',
    cursor: '█',
    disclosureOpen: '▼',
    disclosureClosed: '▶',
    diamond: '◆',
    bullet: '▸',
  },
  density: {
    spacingUnit: '4px',
    borderWidth: '1px',
    radiusSm: '0px',
    radiusMd: '2px',
    panelPadding: '12px',
  },
  shaderPreset: 'none',
  borderRenderer: 'css',
  // No moving background: scan-line sweep + flicker off. The phosphor bloom +
  // static scanline tile are pure CSS (see matrix.css § Unfinished Works).
  // Status-dot halo + terminal cursor blink stay on — they're informative.
  animations: { scan: false, pulseHalo: true, flicker: false, cursorBlink: true },
};
