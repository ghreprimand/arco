// Themes Phase 3 — helpers for the themed background shader pipeline.
//
// Shader fragments are stored alongside this file as `*.frag.glsl` and
// imported with Vite's `?raw` suffix to get them as strings.

// Parse a `#rrggbb` or `#rgb` hex literal into a normalized [r, g, b] triple
// in [0, 1]. Throws on non-hex input (rgba/hsl tokens) — callers should only
// pass `color-bg` / `color-accent-*` values, which are hex in every theme
// manifest today. See section 4 of docs/CLIENT.md.
export function hexToVec3(hex: string): [number, number, number] {
  const raw = hex.trim().replace(/^#/, '');
  let full: string;
  if (raw.length === 3) {
    full = raw.split('').map((c) => c + c).join('');
  } else if (raw.length === 6) {
    full = raw;
  } else {
    throw new Error(`hexToVec3: expected #rgb or #rrggbb, got "${hex}"`);
  }
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) {
    throw new Error(`hexToVec3: unparseable hex "${hex}"`);
  }
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  return [r, g, b];
}
