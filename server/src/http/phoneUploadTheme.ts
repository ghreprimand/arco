import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../server/constants.js';

// The look of the phone upload page: a snapshot of the Arco theme that was
// active on the computer when the code was opened. Only these fixed values
// are accepted, each checked against a strict form, so the phone page never
// receives CSS, HTML or a URL from the browser that sent them. A value that
// fails its check is dropped and the page keeps its plain default for it.

export const PHONE_THEME_COLORS = [
  'color-bg', 'color-bg-dialog', 'color-fg', 'color-fg-muted', 'color-border',
  'color-accent-primary', 'color-control-fg', 'color-success', 'color-error',
] as const;
const LENGTHS = ['border-width', 'radius-sm'] as const;
const FONTS = ['font-display', 'font-body'] as const;
const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-monospace', 'ui-sans-serif', 'ui-serif']);

// Fonts that ship inside Arco itself. The phone page may fetch these, and
// only these, through its own token-checked path. A theme font that the
// computer loads from the internet falls back to the phone's own fonts.
const BUNDLED_FONTS: Record<string, { family: string; weight: string; type: string; file: string }> = {
  'victor-mono-400': { family: 'Victor Mono', weight: '400', type: 'font/otf', file: 'themes/victor-mono/VictorMono-Regular.otf' },
  'victor-mono-700': { family: 'Victor Mono', weight: '700', type: 'font/otf', file: 'themes/victor-mono/VictorMono-Bold.otf' },
  'excalifont-400': { family: 'Excalifont', weight: '400', type: 'font/woff2', file: 'themes/excalifont/Excalifont-Regular.woff2' },
};

export interface PhoneTheme {
  vars: Record<string, string>;
  scheme?: 'light' | 'dark';
  fonts: { id: string; family: string; weight: string }[];
}

function color(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const m = /^rgba?\((\d{1,3}), (\d{1,3}), (\d{1,3})(?:, (0|1|0?\.\d{1,6}))?\)$/.exec(value);
  return m && [m[1], m[2], m[3]].every(n => Number(n) <= 255) ? value : undefined;
}

function length(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const m = /^(\d{1,2}(?:\.\d{1,3})?)px$/.exec(value);
  return m && Number(m[1]) <= 24 ? value : undefined;
}

function families(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.length > 240) return undefined;
  const names: string[] = [];
  for (const part of value.split(',').slice(0, 6)) {
    const name = part.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (GENERIC_FONTS.has(name) || /^[A-Za-z0-9][A-Za-z0-9 _-]{0,47}$/.test(name)) names.push(name);
    else return undefined;
  }
  return names.length ? names : undefined;
}

const stack = (names: string[]) => names.map(n => GENERIC_FONTS.has(n) ? n : `"${n}"`).join(', ');

/** Keep only the values that pass their checks; undefined when none do. */
export function checkedPhoneTheme(input: unknown): PhoneTheme | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const raw = input as Record<string, unknown>;
  const vars: Record<string, string> = {};
  for (const key of PHONE_THEME_COLORS) {
    const value = color(raw[key]);
    if (value) vars[key] = value;
  }
  for (const key of LENGTHS) {
    const value = length(raw[key]);
    if (value) vars[key] = value;
  }
  const fonts = new Map<string, { id: string; family: string; weight: string }>();
  for (const key of FONTS) {
    const names = families(raw[key]);
    if (!names) continue;
    vars[key] = stack(names);
    // The first family is the one the theme shows; bring it along when it
    // is bundled with Arco.
    for (const [id, font] of Object.entries(BUNDLED_FONTS)) {
      if (font.family === names[0]) fonts.set(id, { id, family: font.family, weight: font.weight });
    }
  }
  const scheme = raw.scheme === 'light' || raw.scheme === 'dark' ? raw.scheme : undefined;
  if (!Object.keys(vars).length && !scheme) return undefined;
  return { vars, ...(scheme ? { scheme } : {}), fonts: [...fonts.values()] };
}

/** The bytes of one bundled font that the theme names, or null. */
export async function bundledPhoneFont(theme: PhoneTheme | undefined, id: string): Promise<{ type: string; bytes: Buffer } | null> {
  const font = Object.hasOwn(BUNDLED_FONTS, id) ? BUNDLED_FONTS[id] : undefined;
  if (!font || !theme?.fonts.some(f => f.id === id)) return null;
  try {
    return { type: font.type, bytes: await readFile(join(PROJECT_ROOT, 'client', 'dist', font.file)) };
  } catch {
    return null;
  }
}
