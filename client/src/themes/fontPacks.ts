// Font packs — operator-selectable typography overrides that supersede the
// active theme's `fonts` block when set. The original packs are curated from
// font stacks already used across the theme registry (no new Google Fonts
// loads beyond what some theme can already pull). The "Legibility packs" block
// at the bottom is the deliberate exception: those bring typefaces no theme
// uses, picked purely for small-size clarity, and load on demand when selected.
//
// When override is set, applyTheme substitutes display/body/code and ensures
// the pack's googleFontsUrl link tag is in the document head (idempotent —
// the link's id is keyed by pack id, so rapid switches don't accumulate
// duplicates).

export interface FontPack {
  id: string;
  name: string;
  // Short label of where this pack is "from" — orients the operator. Not
  // load-bearing, just shown in the dropdown caption.
  origin: string;
  display: string;
  body: string;
  code: string;
  googleFontsUrl: string;
}

export const FONT_PACKS: FontPack[] = [
  {
    id: 'jetbrains-uniform',
    name: 'JetBrains Mono',
    origin: 'Matrix / Cicada / Sentinel',
    display: "'JetBrains Mono', monospace",
    body: "'JetBrains Mono', monospace",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap',
  },
  {
    id: 'space-mono-uniform',
    name: 'Space Mono',
    origin: 'Infrared / Sonar',
    display: "'Space Mono', monospace",
    body: "'Space Mono', monospace",
    code: "'Space Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap',
  },
  {
    id: 'ibm-plex-mono-uniform',
    name: 'IBM Plex Mono',
    origin: 'Cherenkov / Seismograph',
    display: "'IBM Plex Mono', monospace",
    body: "'IBM Plex Mono', monospace",
    code: "'IBM Plex Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600;700&display=swap',
  },
  {
    id: 'share-tech-mono',
    name: 'Share Tech Mono',
    origin: 'DSKY / Oscilloscope',
    display: "'Share Tech Mono', monospace",
    body: "'Share Tech Mono', monospace",
    code: "'Share Tech Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap',
  },
  {
    id: 'courier-prime',
    name: 'Courier Prime',
    origin: 'Noir',
    display: "'Courier Prime', monospace",
    body: "'Courier Prime', monospace",
    code: "'Courier Prime', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Courier+Prime:wght@400;700&display=swap',
  },
  {
    id: 'cinzel-lora-courier',
    name: 'Cinzel + Lora',
    origin: 'Bloodmoon',
    display: "'Cinzel', serif",
    body: "'Lora', serif",
    code: "'Courier Prime', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;500;600;700&family=Lora:wght@400;500;600&family=Courier+Prime&display=swap',
  },
  {
    id: 'cormorant-plex',
    name: 'Cormorant + Plex Mono',
    origin: 'Kintsugi / Tarkovsky',
    display: "'Cormorant Garamond', Garamond, serif",
    body: "'IBM Plex Mono', monospace",
    code: "'IBM Plex Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=IBM+Plex+Mono:wght@300;400;500;600&display=swap',
  },
  {
    id: 'eb-garamond-lora',
    name: 'EB Garamond + Lora',
    origin: 'Dark Academia',
    display: "'EB Garamond', Garamond, serif",
    body: "'Lora', 'EB Garamond', Garamond, serif",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=EB+Garamond:wght@400;500;600;700&family=Lora:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap',
  },
  {
    id: 'fraunces-lora',
    name: 'Fraunces + Lora',
    origin: 'Solar Paper',
    display: "'Fraunces', Georgia, serif",
    body: "'Lora', Georgia, serif",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Fraunces:wght@400;500;600;700&family=Lora:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap',
  },
  {
    id: 'inter-jetbrains',
    name: 'Inter + JetBrains',
    origin: 'Holographic / Frutiger',
    display: "'Inter', sans-serif",
    body: "'Inter', sans-serif",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
  },
  {
    id: 'inter-tight',
    name: 'Inter Tight',
    origin: 'Braun',
    display: "'Inter Tight', 'Inter', sans-serif",
    body: "'Inter Tight', 'Inter', sans-serif",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Inter+Tight:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
  },
  {
    id: 'syncopate-inter',
    name: 'Syncopate + Inter',
    origin: 'Stealth',
    display: "'Syncopate', sans-serif",
    body: "'Inter', sans-serif",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Syncopate:wght@400;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap',
  },
  {
    id: 'space-grotesk-jetbrains',
    name: 'Space Grotesk + JetBrains',
    origin: 'Midnight Tokyo',
    display: "'Space Grotesk', sans-serif",
    body: "'JetBrains Mono', monospace",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
  },
  {
    id: 'cinzel-jetbrains',
    name: 'Cinzel + JetBrains',
    origin: 'Arrakis',
    display: "'Cinzel', serif",
    body: "'JetBrains Mono', monospace",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Cinzel:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
  },

  // ── Legibility packs (2026-06-16) ──────────────────────────────────────────
  // Unlike the packs above (curated from fonts a theme already pulls), these
  // intentionally introduce typefaces NOT used by any theme, chosen for one
  // job: staying crisp and disambiguable at small sizes / on monitors that
  // soften text. Each loads its own families on demand when selected.
  {
    id: 'atkinson-jetbrains',
    name: 'Atkinson Hyperlegible + JetBrains',
    origin: 'Legibility — max character disambiguation',
    display: "'Atkinson Hyperlegible', sans-serif",
    body: "'Atkinson Hyperlegible', sans-serif",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400;1,700&family=JetBrains+Mono:wght@400;500&display=swap',
  },
  {
    id: 'lexend-jetbrains',
    name: 'Lexend + JetBrains',
    origin: 'Legibility — reduced visual stress',
    display: "'Lexend', sans-serif",
    body: "'Lexend', sans-serif",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Lexend:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
  },
  {
    id: 'ibm-plex-sans',
    name: 'IBM Plex Sans + Mono',
    origin: 'Legibility — neutral UI grotesque',
    display: "'IBM Plex Sans', sans-serif",
    body: "'IBM Plex Sans', sans-serif",
    code: "'IBM Plex Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@300;400;500;600&display=swap',
  },
  {
    id: 'source-sans-code',
    name: 'Source Sans 3 + Source Code',
    origin: 'Legibility — Adobe screen-first',
    display: "'Source Sans 3', sans-serif",
    body: "'Source Sans 3', sans-serif",
    code: "'Source Code Pro', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@300;400;500;600;700&family=Source+Code+Pro:wght@400;500;600&display=swap',
  },
  {
    id: 'public-sans-jetbrains',
    name: 'Public Sans + JetBrains',
    origin: 'Legibility — USWDS accessibility',
    display: "'Public Sans', sans-serif",
    body: "'Public Sans', sans-serif",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Public+Sans:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
  },
  {
    id: 'inter-source-code',
    name: 'Inter + Source Code',
    origin: 'Legibility — Inter body, wider mono',
    display: "'Inter', sans-serif",
    body: "'Inter', sans-serif",
    code: "'Source Code Pro', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Source+Code+Pro:wght@400;500;600&display=swap',
  },

  // ── Large-x-height grotesques (2026-06-16) ─────────────────────────────────
  // Second legibility wave, picked specifically to beat Inter/Lexend at small
  // sizes: bigger x-heights + open apertures = text that reads "larger" at the
  // same px. All paired with JetBrains Mono for code.
  {
    id: 'hanken-jetbrains',
    name: 'Hanken Grotesk + JetBrains',
    origin: 'Legibility — large x-height, open',
    display: "'Hanken Grotesk', sans-serif",
    body: "'Hanken Grotesk', sans-serif",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
  },
  {
    id: 'onest-jetbrains',
    name: 'Onest + JetBrains',
    origin: 'Legibility — built for small UI',
    display: "'Onest', sans-serif",
    body: "'Onest', sans-serif",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Onest:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
  },
  {
    id: 'figtree-jetbrains',
    name: 'Figtree + JetBrains',
    origin: 'Legibility — clean, big x-height',
    display: "'Figtree', sans-serif",
    body: "'Figtree', sans-serif",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Figtree:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
  },
  {
    id: 'geist-jetbrains',
    name: 'Geist + JetBrains',
    origin: 'Legibility — Vercel UI grotesque',
    display: "'Geist', sans-serif",
    body: "'Geist', sans-serif",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
  },
  {
    id: 'readex-jetbrains',
    name: 'Readex Pro + JetBrains',
    origin: 'Legibility — calm, open',
    display: "'Readex Pro', sans-serif",
    body: "'Readex Pro', sans-serif",
    code: "'JetBrains Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Readex+Pro:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
  },

  // ── Monospace-everywhere packs (2026-06-16) ────────────────────────────────
  // Same shape as the JetBrains Mono uniform pack — one mono across display,
  // body, and code — for operators who like JetBrains Mono's large-x-height
  // small-size read and want it everywhere. Plus a Geist Sans + Geist Mono
  // split for proportional prose with matching mono code.
  {
    id: 'geist-mono-uniform',
    name: 'Geist Mono',
    origin: 'Uniform mono — Vercel, crisp',
    display: "'Geist Mono', monospace",
    body: "'Geist Mono', monospace",
    code: "'Geist Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Geist+Mono:wght@300;400;500;600;700&display=swap',
  },
  {
    id: 'martian-mono-uniform',
    name: 'Martian Mono',
    origin: 'Uniform mono — biggest x-height, wide',
    display: "'Martian Mono', monospace",
    body: "'Martian Mono', monospace",
    code: "'Martian Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Martian+Mono:wght@300;400;500;600;700&display=swap',
  },
  {
    id: 'geist-geistmono',
    name: 'Geist + Geist Mono',
    origin: 'Vercel set — sans prose, mono code',
    display: "'Geist', sans-serif",
    body: "'Geist', sans-serif",
    code: "'Geist Mono', monospace",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500;600&display=swap',
  },
  {
    id: 'victor-mono-uniform',
    name: 'Victor Mono',
    origin: 'Arco Jungle — OdyTTY terminal font',
    display: "'Victor Mono', monospace",
    body: "'Victor Mono', monospace",
    code: "'Victor Mono', monospace",
    // Empty: Victor Mono is self-hosted in global.css (Oblique italics, not
    // Google's cursive Italic). apply.ts skips link injection when this is blank.
    googleFontsUrl: '',
  },
];

export const FONT_PACK_BY_ID: Record<string, FontPack> = Object.fromEntries(
  FONT_PACKS.map((p) => [p.id, p]),
);

export function getFontPack(id: string | null | undefined): FontPack | null {
  if (!id) return null;
  return FONT_PACK_BY_ID[id] ?? null;
}
