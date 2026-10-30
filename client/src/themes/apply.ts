import type { Theme } from './types';
import { getFontPack } from './fontPacks';
import { phosphorEmission } from './phosphor/emission';

// Idempotent — safe to call on every settings refresh. Mutates :root CSS vars,
// sets data-theme on <html>, and lazy-loads the theme's Google Fonts stylesheet
// (once per session, keyed by theme id). No component remounts; active workers
// / streaming messages survive the swap.
//
// `arco:theme-changed` fires after the DOM updates so ThemedBackgroundShader
// and any Rough.js-rendered panels can react without prop-drilling.
//
// `fontPackOverrideId` (optional) substitutes the active theme's display/body/
// code fonts with a curated pack. Pack's googleFontsUrl is loaded once per
// session under a separate id so theme + pack stylesheets coexist without
// fighting for the same <link>.
// Force a panel color token to a given alpha so frosted mode can see the
// (blurred) backdrop through it. Accepts hex (#rgb / #rrggbb) or rgb()/rgba();
// returns an rgba() string. Anything unparseable is returned unchanged so we
// fail soft rather than blanking a panel.
function withAlpha(token: string, alpha: number): string {
  const t = token.trim();
  const rgbMatch = t.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (rgbMatch) {
    return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${alpha})`;
  }
  const hex = t.replace(/^#/, '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  if (full.length === 6 && /^[0-9a-f]{6}$/i.test(full)) {
    const n = parseInt(full, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  return token;
}

// Parse a token to {r,g,b} (0–255) + alpha, or null if unparseable. Hex
// (#rgb / #rrggbb) and rgb()/rgba() inputs supported.
function parseRgb(token: string): { r: number; g: number; b: number; a: number } | null {
  const t = token.trim();
  const m = t.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?/i);
  if (m) {
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] !== undefined ? Number(m[4]) : 1 };
  }
  const hex = t.replace(/^#/, '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  if (full.length !== 6 || !/^[0-9a-f]{6}$/i.test(full)) return null;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
}

function formatRgb(r: number, g: number, b: number, a: number): string {
  const R = Math.round(r), G = Math.round(g), B = Math.round(b);
  return a < 1 ? `rgba(${R}, ${G}, ${B}, ${a})` : `rgb(${R}, ${G}, ${B})`;
}

// Filled controls need ink paired with their final paint, including brightness.
// Prefer existing theme ink; black/white are the bounded fallback for a fill
// whose luminance falls between the theme's own foreground and background.
function controlInk(background: string, candidates: string[]): string {
  const bg = parseRgb(background);
  if (!bg) return candidates[0];
  const luminance = ({ r, g, b }: { r: number; g: number; b: number }): number =>
    [r, g, b].map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const ratio = (ink: string): number => {
    const fg = parseRgb(ink);
    if (!fg) return 0;
    const a = luminance({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) });
    const b = luminance(bg);
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  };
  return candidates.find(ink => ratio(ink) >= 4.6)
    ?? (ratio('#000000') >= ratio('#ffffff') ? '#000000' : '#ffffff');
}

// Background shift — adds `amount` signed HSL *lightness* points (−30…+30,
// clamped [0,100]) to a token. For near-black surfaces this raises/lowers the
// "how light is this surface" level, which is the intuitive background dimmer.
// Hue/sat/alpha preserved; unparseable tokens return unchanged (fail soft).
function liftLightness(token: string, amount: number): string {
  const c = parseRgb(token);
  if (!c) return token;
  const rn = c.r / 255, gn = c.g / 255, bn = c.b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0, s = 0; const l = (max + min) / 2;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break;
      case gn: h = (bn - rn) / d + 2; break;
      default: h = (rn - gn) / d + 4; break;
    }
    h /= 6;
  }
  const l2 = Math.max(0, Math.min(1, l + amount / 100));
  const hue2rgb = (p: number, q: number, tt: number): number => {
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  let r2: number, g2: number, b2: number;
  if (s === 0) {
    r2 = g2 = b2 = l2;
  } else {
    const q = l2 < 0.5 ? l2 * (1 + s) : l2 + s - l2 * s;
    const p = 2 * l2 - q;
    r2 = hue2rgb(p, q, h + 1 / 3);
    g2 = hue2rgb(p, q, h);
    b2 = hue2rgb(p, q, h - 1 / 3);
  }
  return formatRgb(r2 * 255, g2 * 255, b2 * 255, c.a);
}

// Text/ink brightness — signed value-points. Positive raises HSV *value* first
// (brightens the colour toward its vivid form, hue + saturation kept → no white
// wash), and ONLY once value saturates at 1 does the remainder desaturate
// toward white. So normal levels read as "brighter, not paler" (the behaviour
// that fixed the original complaint), while the top of the range can still push
// past the vivid ceiling toward white for maximum brightness when the operator
// cranks it. Negative dims toward black (value down). Hue/alpha preserved at
// normal levels; unparseable returns unchanged.
function shiftValue(token: string, amount: number): string {
  const c = parseRgb(token);
  if (!c) return token;
  const rn = c.r / 255, gn = c.g / 255, bn = c.b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  const v = max;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d !== 0) {
    switch (max) {
      case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break;
      case gn: h = (bn - rn) / d + 2; break;
      default: h = (rn - gn) / d + 4; break;
    }
    h /= 6;
  }
  let v2: number, s2: number;
  if (amount >= 0) {
    const inc = amount / 100;
    v2 = Math.min(1, v + inc);
    const leftover = inc - (v2 - v); // unused brightening after value capped at 1
    s2 = leftover > 0 ? Math.max(0, s - leftover) : s; // then whiten
  } else {
    v2 = Math.max(0, v + amount / 100);
    s2 = s;
  }
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v2 * (1 - s2);
  const q = v2 * (1 - f * s2);
  const tt = v2 * (1 - (1 - f) * s2);
  let r2: number, g2: number, b2: number;
  switch (i % 6) {
    case 0: r2 = v2; g2 = tt; b2 = p; break;
    case 1: r2 = q; g2 = v2; b2 = p; break;
    case 2: r2 = p; g2 = v2; b2 = tt; break;
    case 3: r2 = p; g2 = q; b2 = v2; break;
    case 4: r2 = tt; g2 = p; b2 = v2; break;
    default: r2 = v2; g2 = p; b2 = q; break;
  }
  return formatRgb(r2 * 255, g2 * 255, b2 * 255, c.a);
}

// Default frosted panel opacity when the operator hasn't tuned the slider.
// Matches the historical hardcoded panel alpha so existing setups are unchanged.
export const DEFAULT_FROSTED_OPACITY = 0.6;
let previousPhosphorKeys: string[] = [];

export function applyTheme(
  theme: Theme,
  fontPackOverrideId?: string | null,
  frostedOverride?: 'on' | 'off' | null,
  frostedOpacity?: number | null,
  brightness?: { bg?: number | null; text?: number | null } | null,
): void {
  const root = document.documentElement;
  const phosphor = theme.family === 'phosphor';
  for (const key of previousPhosphorKeys) if (!(key in theme.tokens)) root.style.removeProperty(`--${key}`);
  previousPhosphorKeys = phosphor ? Object.keys(theme.tokens) : [];
  root.dataset.themeFamily = phosphor ? 'phosphor' : 'classic';
  if (phosphor) root.style.setProperty('--phosphor-text', phosphorEmission(Number(root.dataset.phosphorSoftness ?? 50)));
  else root.style.removeProperty('--phosphor-text');

  // Operator override (Settings toggle) wins over the theme's own default.
  const frosted = phosphor && root.dataset.phosphorEffects === 'off' ? false : frostedOverride === 'on' ? true
    : frostedOverride === 'off' ? false
    : !!theme.frosted;

  // Two signed brightness shifts (−30…+30, default 0 = no-op). Backgrounds
  // (`color-bg*` tokens) take `bg`; everything else drawn on top (text,
  // accents, borders, status, shadows) takes `text`. `tok` returns the
  // original string untouched when its bucket's shift is 0, so the unshifted
  // render is byte-identical to before.
  const clampB = (v: number | null | undefined): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(-100, v)) : 0;
  const bgLift = clampB(brightness?.bg);
  const textLift = clampB(brightness?.text);
  // Backgrounds shift HSL lightness (surface dimmer); text/ink shifts HSV value
  // (brightens the colour without washing to white). See the two helpers.
  const tok = (key: string, value: string): string => {
    if (key.startsWith('color-bg')) return bgLift !== 0 ? liftLightness(value, bgLift) : value;
    return textLift !== 0 ? shiftValue(value, textLift) : value;
  };

  for (const [key, value] of Object.entries(theme.tokens)) {
    root.style.setProperty(`--${key}`, tok(key, value));
  }

  // Phosphor glass is paint-only; no padding, grouping or component changes.
  // Frosted override retains its separate backdrop-blur/opacity behavior below.
  if (phosphor && root.dataset.phosphorEffects !== 'off') {
    root.style.setProperty('--color-bg-panel', withAlpha(tok('color-bg-panel', theme.tokens['color-bg-panel']), .68));
    root.style.setProperty('--color-bg-input', withAlpha(tok('color-bg-input', theme.tokens['color-bg-input']), .88));
    root.style.setProperty('--color-bg-elevated', withAlpha(tok('color-bg-elevated', theme.tokens['color-bg-elevated']), .97));
  }

  // Frosted glass = translucent panels + a backdrop blur (the blur lives in
  // matrix.css, gated on data-frosted). Lowering the panel-surface alpha is
  // what actually makes panels *see-through*; the blur then diffuses whatever
  // shows through. Without this, frost only blurred panels that some theme
  // already made translucent — so it read as "more opaque" and did nothing on
  // opaque-panel themes. Overriding the CSS vars flows through every panel
  // (they all read --color-bg-panel etc., including inline styles).
  if (frosted) {
    // Operator-tunable panel opacity. The base controls the panel surface; the
    // input/elevated surfaces keep their original +0.12 / +0.06 offsets above it
    // so the relative depth between surfaces is preserved at every slider value.
    // Default 0.6 reproduces the historical 0.6 / 0.72 / 0.66 triple exactly.
    const base = typeof frostedOpacity === 'number' && Number.isFinite(frostedOpacity)
      ? Math.min(0.95, Math.max(0.3, frostedOpacity))
      : DEFAULT_FROSTED_OPACITY;
    root.style.setProperty('--color-bg-panel', withAlpha(tok('color-bg-panel', theme.tokens['color-bg-panel'] ?? ''), base));
    root.style.setProperty('--color-bg-input', withAlpha(tok('color-bg-input', theme.tokens['color-bg-input'] ?? ''), Math.min(1, base + 0.12)));
    root.style.setProperty('--color-bg-elevated', withAlpha(tok('color-bg-elevated', theme.tokens['color-bg-elevated'] ?? ''), Math.min(1, base + 0.06)));
  }

  const base = parseRgb(root.style.getPropertyValue('--color-bg')) ?? { r: 0, g: 0, b: 0, a: 1 };
  const panel = parseRgb(root.style.getPropertyValue('--color-bg-panel')) ?? base;
  const surface = formatRgb(panel.r * panel.a + base.r * (1 - panel.a), panel.g * panel.a + base.g * (1 - panel.a), panel.b * panel.a + base.b * (1 - panel.a), 1);
  const fg = root.style.getPropertyValue('--color-fg');
  root.style.setProperty('--color-control-fg', controlInk(surface, [root.style.getPropertyValue('--color-fg-muted'), fg]));
  root.style.setProperty('--color-control-selected-fg', controlInk(root.style.getPropertyValue('--color-accent-primary-dim'), [root.style.getPropertyValue('--color-bg'), fg]));

  // Fixed background image (opt-in via theme.background) — Arco's first
  // image-backed theme. Painted on <body> as a scrim-over-image so it sits
  // behind every panel; it only *reads* where panel surfaces are translucent
  // (this theme lowers its panel alphas for exactly that). The scrim is a flat
  // layer of --color-bg at `scrim` alpha, keeping text legible over the art.
  // Applied to document.body (global.css sets `body { background: var(--color-bg) }`;
  // an inline background-image wins, and clearing it falls back to that rule).
  const bg = theme.background;
  if (bg?.image) {
    const scrim = Math.min(1, Math.max(0, typeof bg.scrim === 'number' ? bg.scrim : 0.5));
    const scrimColor = withAlpha(tok('color-bg', theme.tokens['color-bg'] ?? '#000'), scrim);
    document.body.style.backgroundImage = `linear-gradient(${scrimColor}, ${scrimColor}), url("${bg.image}")`;
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center center';
    document.body.style.backgroundAttachment = 'fixed';
    document.body.style.backgroundRepeat = 'no-repeat';
    root.dataset.bgImage = '1';
  } else {
    // Reset so switching to a flat-bg theme drops the previous image.
    document.body.style.backgroundImage = '';
    document.body.style.backgroundSize = '';
    document.body.style.backgroundPosition = '';
    document.body.style.backgroundAttachment = '';
    document.body.style.backgroundRepeat = '';
    root.dataset.bgImage = '0';
  }

  root.style.setProperty('--spacing-unit', theme.density.spacingUnit);
  root.style.setProperty('--border-width', theme.density.borderWidth);
  root.style.setProperty('--radius-sm', theme.density.radiusSm);
  root.style.setProperty('--radius-md', theme.density.radiusMd);
  root.style.setProperty('--panel-padding', theme.density.panelPadding);

  const overridePack = getFontPack(fontPackOverrideId ?? null);
  const display = overridePack?.display ?? theme.fonts.display;
  const body = overridePack?.body ?? theme.fonts.body;
  const code = overridePack?.code ?? theme.fonts.code;
  root.style.setProperty('--font-display', display);
  root.style.setProperty('--font-body', body);
  root.style.setProperty('--font-code', code);

  if (theme.fonts.googleFontsUrl) {
    const id = `theme-font-${theme.id}`;
    if (!document.getElementById(id)) {
      const link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href = theme.fonts.googleFontsUrl;
      document.head.appendChild(link);
    }
  }
  // Guard on googleFontsUrl: self-hosted packs (e.g. Victor Mono, loaded via
  // @font-face in global.css) leave it blank and need no <link> injection.
  if (overridePack && overridePack.googleFontsUrl) {
    const id = `font-pack-${overridePack.id}`;
    if (!document.getElementById(id)) {
      const link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href = overridePack.googleFontsUrl;
      document.head.appendChild(link);
    }
  }

  root.dataset.theme = theme.id;
  // Expose per-theme animation flags as data attributes so matrix.css can gate
  // the scan overlay / pulse-halo keyframe without each theme's backdrop
  // re-asserting the rule. Components that don't key on `animations.*` still
  // respect the flag because the CSS rule is gated at the root.
  root.dataset.animScan = theme.animations.scan ? '1' : '0';
  root.dataset.animPulseHalo = theme.animations.pulseHalo ? '1' : '0';
  root.dataset.animFlicker = theme.animations.flicker ? '1' : '0';
  // Frosted-glass mode — matrix.css gates the backdrop-filter blur on panel
  // surfaces off this attribute (the panel translucency is applied above).
  root.dataset.frosted = frosted ? '1' : '0';

  window.dispatchEvent(new CustomEvent('arco:theme-changed', { detail: theme }));
}

// Global "crisp text" toggle. Sets data-crisp on <html>; global.css keys the
// text-shadow kill-switch off it. Deliberately NOT a param to applyTheme: the
// attribute is independent of theme tokens and survives theme swaps (applyTheme
// never clears it), so threading it through every applyThemeForSelection call
// site would be noise. Call it once at bootstrap and whenever the setting
// changes.
export function applyCrispText(on: boolean): void {
  document.documentElement.dataset.crisp = on ? '1' : '0';
}
