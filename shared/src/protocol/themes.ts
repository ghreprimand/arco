// ── Theme + font-pack registries ──
import { PHOSPHOR_PALETTE_IDS } from './phosphorPaletteIds.js';
export { PHOSPHOR_PALETTE_IDS } from './phosphorPaletteIds.js';

// Closed registry of valid theme ids. MUST stay in sync with the client's
// THEME_REGISTRY (client/src/themes/registry.ts) — the server sanitizes
// settings.themeId against this list, so any id missing here is silently
// dropped and the UI reverts to the prior theme on the authoritative response.
// The trailing block (cute…provider-auto) was added 2026-06-05; 'arch' (the
// low-power / no-shader theme) 2026-08-06; 'red-planet' (exact Paletty Core +
// ANSI port) 2026-08-30; 'everforest' (reference monitor palette) 2026-08-31.
export const CLASSIC_THEME_IDS = ['matrix', 'arch', 'amber-crt', 'braun', 'blueprint', 'dark-academia', 'solar-paper', 'holographic', 'frutiger-aero', 'abyssal', 'voyager', 'noir', 'midnight-tokyo', 'arrakis', 'oscilloscope', 'concrete', 'cassette-futurism', 'bloodmoon', 'red-planet', 'stealth', 'dsky', 'sentinel', 'cherenkov', 'infrared', 'aurora', 'nebula', 'sonar', 'seismograph', 'kintsugi', 'cicada', 'tarkovsky', 'night-city', 'cute', 'forest', 'everforest', 'ocean', 'lavender', 'ume', 'copper', 'arco-jungle', 'arco-default', 'unfinished-works', 'provider-auto'] as const;
export const VALID_THEME_IDS = [...CLASSIC_THEME_IDS, ...PHOSPHOR_PALETTE_IDS.map(id => `phosphor:arco:${id}` as const)] as const;
export type ThemeId = typeof VALID_THEME_IDS[number];

// Saved settings from Archon builds name the two ported terminal themes, the
// Phosphor family token and its CRT palette with a different leading word
// (`<word>-default`, `<word>-jungle`, `phosphor:<word>:<id>`, `<word>-crt`).
// Map any such id onto the Arco id with the same suffix so a theme chosen in
// Archon still resolves in Arco. Ids that are already valid pass through.
export function normalizeLegacyThemeId(raw: string): string | undefined {
  const valid = VALID_THEME_IDS as readonly string[];
  if (valid.includes(raw)) return raw;
  const renamed = (id: string) => {
    const m = /^[a-z0-9]+-(default|jungle|crt)$/.exec(id);
    return m ? `arco-${m[1]}` : id;
  };
  const phosphor = /^phosphor:[a-z0-9-]+:(.+)$/.exec(raw);
  const candidate = phosphor ? `phosphor:arco:${renamed(phosphor[1])}` : renamed(raw);
  return valid.includes(candidate) ? candidate : undefined;
}

// Closed registry of valid font-pack ids — must match the keys in the
// client's FONT_PACKS list. Server validates patches against this set.
export const VALID_FONT_PACK_IDS = [
  'jetbrains-uniform',
  'space-mono-uniform',
  'ibm-plex-mono-uniform',
  'share-tech-mono',
  'courier-prime',
  'cinzel-lora-courier',
  'cormorant-plex',
  'eb-garamond-lora',
  'fraunces-lora',
  'inter-jetbrains',
  'inter-tight',
  'syncopate-inter',
  'space-grotesk-jetbrains',
  'cinzel-jetbrains',
  // Legibility packs (2026-06-16) — chosen for clarity at small sizes / on
  // monitors that soften text. Not tied to any theme; pull fonts on demand.
  'atkinson-jetbrains',
  'lexend-jetbrains',
  'ibm-plex-sans',
  'source-sans-code',
  'public-sans-jetbrains',
  'inter-source-code',
  // Large-x-height grotesques (2026-06-16) — picked for maximum small-size
  // legibility, paired with JetBrains Mono for code.
  'hanken-jetbrains',
  'onest-jetbrains',
  'figtree-jetbrains',
  'geist-jetbrains',
  'readex-jetbrains',
  // Monospace-everywhere packs (2026-06-16) — large-x-height monos in the
  // JetBrains Mono spirit, for operators who like a uniform coding-font UI.
  'geist-mono-uniform',
  'martian-mono-uniform',
  'geist-geistmono',
  // Victor Mono (2026-06-21) — OdyTTY's terminal font; pairs with arco-jungle.
  'victor-mono-uniform',
] as const;
export type FontPackId = typeof VALID_FONT_PACK_IDS[number];
