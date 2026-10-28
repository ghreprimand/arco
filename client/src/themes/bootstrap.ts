import { DEFAULT_UI_SCALE, normalizeUiScale } from '@arco/shared';
import { getTheme } from './registry';
import { applyTheme, applyCrispText } from './apply';
import { applyPhosphorPreferences, readPhosphorPreferences } from './phosphor/preferences';

// Client-side theme cache. Without this, the first paint uses global.css
// :root defaults (matrix green) until `/api/settings` resolves — on slow
// connections that flash reads as "defaulted to matrix on restart."
//
// Flow:
//   1. setThemeId / setSettings writes the current themeId here.
//   2. bootstrapCachedTheme() runs synchronously in main.tsx before
//      React mounts, reads the cache, applies the theme to :root.
//   3. The async /api/settings fetch still happens; if it returns a
//      different themeId (another tab changed it, or the cache was
//      stale), appStore.setSettings re-applies over the bootstrap
//      choice. applyTheme is idempotent.
//
// The server is the source of truth; this cache exists purely to avoid
// the paint flicker.

const LS_UI_SCALE_KEY = 'arco_ui_scale';
const LS_KEY = 'arco_theme_id';
const LS_FONT_PACK_KEY = 'arco_font_pack_override';
const LS_FROSTED_KEY = 'arco_frosted_override';
const LS_FROSTED_OPACITY_KEY = 'arco_frosted_opacity';
const LS_BG_BRIGHTNESS_KEY = 'arco_bg_brightness';
const LS_TEXT_BRIGHTNESS_KEY = 'arco_text_brightness';
const LS_CRISP_TEXT_KEY = 'arco_crisp_text';

export function readCachedThemeId(): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null;
  } catch {
    return null;
  }
}

export function writeCachedThemeId(id: string | undefined | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (!id) {
      localStorage.removeItem(LS_KEY);
      return;
    }
    localStorage.setItem(LS_KEY, id);
  } catch {
    // Private-mode Safari etc. — silently fall through; the flash just
    // recurs on next reload, which isn't a correctness issue.
  }
}

export function readCachedFontPackOverride(): string | null | undefined {
  try {
    const cached = typeof localStorage !== 'undefined' ? localStorage.getItem(LS_FONT_PACK_KEY) : null;
    return cached === null ? undefined : cached === '' ? null : cached;
  } catch {
    return undefined;
  }
}

export function writeCachedFontPackOverride(id: string | undefined | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (id === undefined) localStorage.removeItem(LS_FONT_PACK_KEY);
    else localStorage.setItem(LS_FONT_PACK_KEY, id ?? '');
  } catch {
    // Same fallback as the theme cache — silent.
  }
}

export function readCachedFrostedOverride(): 'on' | 'off' | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const v = localStorage.getItem(LS_FROSTED_KEY);
    return v === 'on' || v === 'off' ? v : null;
  } catch {
    return null;
  }
}

export function writeCachedFrostedOverride(v: 'on' | 'off' | undefined | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (v !== 'on' && v !== 'off') {
      localStorage.removeItem(LS_FROSTED_KEY);
      return;
    }
    localStorage.setItem(LS_FROSTED_KEY, v);
  } catch {
    // Same fallback as the theme cache — silent.
  }
}

export function readCachedFrostedOpacity(): number | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const v = localStorage.getItem(LS_FROSTED_OPACITY_KEY);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function writeCachedFrostedOpacity(v: number | undefined | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      localStorage.removeItem(LS_FROSTED_OPACITY_KEY);
      return;
    }
    localStorage.setItem(LS_FROSTED_OPACITY_KEY, String(v));
  } catch {
    // Same fallback as the theme cache — silent.
  }
}

function readCachedNum(key: string): number | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const v = localStorage.getItem(key);
    if (v === null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeCachedNum(key: string, v: number | undefined | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, String(v));
  } catch {
    // Same fallback as the theme cache — silent.
  }
}

export const readCachedBgBrightness = (): number | null => readCachedNum(LS_BG_BRIGHTNESS_KEY);
export const writeCachedBgBrightness = (v: number | undefined | null): void => writeCachedNum(LS_BG_BRIGHTNESS_KEY, v);
export const readCachedTextBrightness = (): number => readCachedNum(LS_TEXT_BRIGHTNESS_KEY) ?? 30;
export const writeCachedTextBrightness = (v: number | undefined | null): void => writeCachedNum(LS_TEXT_BRIGHTNESS_KEY, v);

export function readCachedCrispText(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(LS_CRISP_TEXT_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeCachedCrispText(v: boolean | undefined | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (v) localStorage.setItem(LS_CRISP_TEXT_KEY, '1');
    else localStorage.removeItem(LS_CRISP_TEXT_KEY);
  } catch {
    // Same fallback as the theme cache — silent.
  }
}

export function applyUiScale(value: number): void {
  if (typeof document !== 'undefined') {
    const scale = String(normalizeUiScale(value));
    document.documentElement.style.zoom = scale;
    document.documentElement.style.setProperty('--ui-scale', scale);
  }
}
export function readCachedUiScale(): number {
  const value = readCachedNum(LS_UI_SCALE_KEY);
  return value === null ? DEFAULT_UI_SCALE : normalizeUiScale(value);
}
export function writeCachedUiScale(value: number): void {
  writeCachedNum(LS_UI_SCALE_KEY, normalizeUiScale(value));
}

export function bootstrapCachedTheme(): void {
  applyUiScale(readCachedUiScale());
  applyPhosphorPreferences(readPhosphorPreferences());
  const cached = readCachedThemeId();
  const theme = getTheme(cached);
  const cachedFont = readCachedFontPackOverride();
  applyTheme(theme, cachedFont === undefined ? 'victor-mono-uniform' : cachedFont, readCachedFrostedOverride(), readCachedFrostedOpacity(), { bg: readCachedBgBrightness(), text: readCachedTextBrightness() });
  applyCrispText(readCachedCrispText());
}
