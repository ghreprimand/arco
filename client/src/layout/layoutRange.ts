// Window-size layout (Settings > Appearance > Layout). The choice is saved per
// browser, so a laptop and a desktop each keep their own; nothing is stored
// per project. See docs/CLIENT.md "Layout ranges".
//
// - Automatic: the layout follows the window width, measured in interface
//   pixels (window width divided by the interface scale, so 1920 px at 150%
//   counts as 1280): narrow under 1100, medium from 1100 to 1599, wide from
//   1600.
// - Standard: the original layout at every width.
// - Compact: the medium layout at every width; under 1100 the narrow layout
//   still applies.

import { useEffect, useState } from 'react';

export type LayoutMode = 'auto' | 'standard' | 'compact';
export type LayoutRange = 'standard' | 'narrow' | 'medium' | 'wide';

export const LAYOUT_MODE_KEY = 'arco.layoutMode';
export const LAYOUT_MODE_EVENT = 'arco:layout-mode';
export const UI_SCALE_EVENT = 'arco:ui-scale';
export const NARROW_BELOW = 1100;
export const WIDE_FROM = 1600;

export const LAYOUT_MODES: Array<{ id: LayoutMode; label: string; hint: string }> = [
  { id: 'auto', label: 'Automatic', hint: 'By window width: narrow under 1100 px, medium to 1599 px, wide from 1600 px' },
  { id: 'standard', label: 'Standard', hint: 'The original layout at every width' },
  { id: 'compact', label: 'Compact', hint: 'The medium layout at every width; the narrow layout under 1100 px' },
];

export function isLayoutMode(value: unknown): value is LayoutMode {
  return value === 'auto' || value === 'standard' || value === 'compact';
}

// The layout to draw for a window `width` (CSS px of the window) at interface
// `scale` under `mode`.
export function layoutRange(width: number, scale: number, mode: LayoutMode): LayoutRange {
  if (mode === 'standard') return 'standard';
  const effective = width / (Number.isFinite(scale) && scale > 0 ? scale : 1);
  if (effective < NARROW_BELOW) return 'narrow';
  if (mode === 'compact' || effective < WIDE_FROM) return 'medium';
  return 'wide';
}

// Splitter positions are saved per range so narrowing a panel on a laptop does
// not change the desktop layout. Standard keeps the original key. The wide
// range starts from the original key's value when it has none of its own.
export function rangeWidthKey(baseKey: string, range: LayoutRange): string {
  return range === 'standard' ? baseKey : `${baseKey}.${range}`;
}

export function readRangeFraction(baseKey: string, range: LayoutRange, min: number, max: number, storage: Pick<Storage, 'getItem'> | null = safeStorage()): number | null {
  const valid = (raw: string | null) => {
    if (raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
  };
  if (!storage) return null;
  try {
    const own = valid(storage.getItem(rangeWidthKey(baseKey, range)));
    if (own !== null || range !== 'wide') return own;
    return valid(storage.getItem(baseKey));
  } catch { return null; }
}

export function writeRangeFraction(baseKey: string, range: LayoutRange, value: number, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try { storage?.setItem(rangeWidthKey(baseKey, range), String(value)); } catch { /* storage full or blocked */ }
}

function safeStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function readLayoutMode(storage: Pick<Storage, 'getItem'> | null = safeStorage()): LayoutMode {
  try {
    const raw = storage?.getItem(LAYOUT_MODE_KEY);
    return isLayoutMode(raw) ? raw : 'auto';
  } catch { return 'auto'; }
}

// Saves the choice and tells every mounted layout to redraw at once.
export function setLayoutMode(mode: LayoutMode): void {
  try { localStorage.setItem(LAYOUT_MODE_KEY, mode); } catch { /* storage blocked: applies until reload */ }
  currentMode = mode;
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(LAYOUT_MODE_EVENT, { detail: mode }));
}

let currentMode: LayoutMode | null = null;

function currentScale(): number {
  if (typeof document === 'undefined') return 1;
  const raw = parseFloat(document.documentElement.style.getPropertyValue('--ui-scale'));
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

function snapshot(): { mode: LayoutMode; range: LayoutRange } {
  const mode = currentMode ?? (currentMode = readLayoutMode());
  const width = typeof window === 'undefined' ? 1280 : window.innerWidth;
  return { mode, range: layoutRange(width, currentScale(), mode) };
}

// The layout mode and the range to draw now. Updates on window resize, on an
// interface scale change and when the mode changes (in this tab or another).
export function useLayout(): { mode: LayoutMode; range: LayoutRange } {
  const [state, setState] = useState(snapshot);
  useEffect(() => {
    const update = () => setState((prev) => {
      const next = snapshot();
      return prev.mode === next.mode && prev.range === next.range ? prev : next;
    });
    const onStorage = (e: StorageEvent) => {
      if (e.key !== LAYOUT_MODE_KEY) return;
      currentMode = isLayoutMode(e.newValue) ? e.newValue : 'auto';
      update();
    };
    window.addEventListener('resize', update);
    window.addEventListener(LAYOUT_MODE_EVENT, update);
    window.addEventListener(UI_SCALE_EVENT, update);
    window.addEventListener('storage', onStorage);
    update();
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener(LAYOUT_MODE_EVENT, update);
      window.removeEventListener(UI_SCALE_EVENT, update);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  return state;
}

export function useLayoutRange(): LayoutRange {
  return useLayout().range;
}
