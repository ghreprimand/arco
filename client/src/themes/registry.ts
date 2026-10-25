import type { Theme } from './types';
import { matrix } from './definitions/matrix';
import { braun } from './definitions/braun';
import { amberCrt } from './definitions/amberCrt';
import { blueprint } from './definitions/blueprint';
import { darkAcademia } from './definitions/darkAcademia';
import { solarPaper } from './definitions/solarPaper';
import { holographic } from './definitions/holographic';
import { frutigerAero } from './definitions/frutigerAero';
import { abyssal } from './definitions/abyssal';
import { voyager } from './definitions/voyager';
import { noir } from './definitions/noir';
import { midnightTokyo } from './definitions/midnightTokyo';
import { arrakis } from './definitions/arrakis';
import { oscilloscope } from './definitions/oscilloscope';
import { concrete } from './definitions/concrete';
import { cassetteFuturism } from './definitions/cassetteFuturism';
import { bloodmoon } from './definitions/bloodmoon';
import { redPlanet } from './definitions/redPlanet';
import { stealth } from './definitions/stealth';
import { dsky } from './definitions/dsky';
import { sentinel } from './definitions/sentinel';
import { cherenkov } from './definitions/cherenkov';
import { infrared } from './definitions/infrared';
import { aurora } from './definitions/aurora';
import { nebula } from './definitions/nebula';
import { sonar } from './definitions/sonar';
import { seismograph } from './definitions/seismograph';
import { kintsugi } from './definitions/kintsugi';
import { cicada } from './definitions/cicada';
import { tarkovsky } from './definitions/tarkovsky';
import { nightCity } from './definitions/nightCity';
// Gap themes ported in spirit from the Odysseus set (2026-06-05) — the cozy /
// soft / organic registers Arco's otherwise-grave palette was missing.
import { cute } from './definitions/cute';
import { forest } from './definitions/forest';
import { everforest } from './definitions/everforest';
import { ocean } from './definitions/ocean';
import { lavender } from './definitions/lavender';
import { ume } from './definitions/ume';
import { copper } from './definitions/copper';
// Arco Jungle — ported from OdyTTY's `arco-jungle` builtin (2026-06-21).
import { arcoJungle } from './definitions/arcoJungle';
// Arco Default — faithful port of OdyTTY's flagship `arco-default.theme`
// (raw spec hexes; the greener/saturated counterpart to jungle's bloom-tuned mint).
import { arcoDefault } from './definitions/arcoDefault';
// Unfinished Works — a terminal-style landing page, ported as a theme.
import { unfinishedWorks } from './definitions/unfinishedWorks';
// Arch — Catppuccin Mocha (this machine's desktop palette) with the entire
// GPU cost surface switched off. The low-power option; see its definition.
import { arch } from './definitions/arch';
// Provider auto-tint sentinel — picker-visible; resolves to a per-provider
// palette at apply time. See themes/providerThemes.ts.
import { providerAuto } from './providerThemes';
import { phosphorTheme } from './phosphor/paletteAdapter';
import { arcoThemes } from './phosphor/arco-palette';

export const CLASSIC_THEME_REGISTRY: Record<string, Theme> = {
  matrix,
  arch,
  sentinel,
  cherenkov,
  infrared,
  aurora,
  nebula,
  sonar,
  seismograph,
  kintsugi,
  cicada,
  tarkovsky,
  'night-city': nightCity,
  abyssal,
  voyager,
  noir,
  'midnight-tokyo': midnightTokyo,
  arrakis,
  oscilloscope,
  concrete,
  'cassette-futurism': cassetteFuturism,
  bloodmoon,
  'red-planet': redPlanet,
  stealth,
  dsky,
  'amber-crt': amberCrt,
  braun,
  blueprint,
  'dark-academia': darkAcademia,
  'solar-paper': solarPaper,
  holographic,
  'frutiger-aero': frutigerAero,
  cute,
  forest,
  everforest,
  ocean,
  lavender,
  ume,
  copper,
  'arco-jungle': arcoJungle,
  'arco-default': arcoDefault,
  'unfinished-works': unfinishedWorks,
  'provider-auto': providerAuto,
};

export const DEFAULT_THEME_ID = 'matrix';
export const PHOSPHOR_THEME_REGISTRY: Record<string, Theme> = Object.fromEntries(arcoThemes.map(p => {
  const theme = phosphorTheme(p.id);
  return [theme.id, theme];
}));
export const THEME_REGISTRY: Record<string, Theme> = { ...CLASSIC_THEME_REGISTRY, ...PHOSPHOR_THEME_REGISTRY };

export function getTheme(id: string | undefined | null): Theme {
  if (id && THEME_REGISTRY[id]) return THEME_REGISTRY[id];
  return THEME_REGISTRY[DEFAULT_THEME_ID];
}
