// Window-size layout (Settings > Appearance > Layout). The choice is saved per
// browser, so a laptop and a desktop each keep their own; nothing is stored
// per project. See docs/CLIENT.md "Layout ranges".
//
// Automatic selects Narrow under 1500 interface pixels, Compact from 1500,
// and Standard from 2000. Fixed modes apply at every width.

import { useEffect, useState } from 'react';

export type LayoutMode = 'auto' | 'standard' | 'compact' | 'narrow';
export type LayoutRange = 'standard' | 'narrow' | 'medium';

export const LAYOUT_MODE_KEY = 'arco.layoutMode';
export const LAYOUT_MODE_EVENT = 'arco:layout-mode';
export const UI_SCALE_EVENT = 'arco:ui-scale';
export const COMPACT_FROM = 1500;
export const STANDARD_FROM = 2000;
export const AUTOMATIC_LAYOUT_DESCRIPTION = 'Automatic picks by window width: Narrow under 1500, Compact from 1500, Standard from 2000 (interface pixels: window width divided by the text size).';

export const LAYOUT_MODES: Array<{ id: LayoutMode; label: string; hint: string }> = [
  { id: 'auto', label: 'Automatic', hint: AUTOMATIC_LAYOUT_DESCRIPTION },
  { id: 'standard', label: 'Standard', hint: 'The original layout at every width' },
  { id: 'compact', label: 'Compact', hint: 'Compact layout at every width' },
  { id: 'narrow', label: 'Narrow', hint: 'Narrow layout at every width' },
];

export function isLayoutMode(value: unknown): value is LayoutMode {
  return value === 'auto' || value === 'standard' || value === 'compact' || value === 'narrow';
}

// The layout to draw for a window `width` (CSS px of the window) at interface
// `scale` under `mode`.
export function layoutRange(width: number, scale: number, mode: LayoutMode): LayoutRange {
  if (mode === 'standard') return 'standard';
  if (mode === 'compact') return 'medium';
  if (mode === 'narrow') return 'narrow';
  const effective = width / (Number.isFinite(scale) && scale > 0 ? scale : 1);
  if (effective < COMPACT_FROM) return 'narrow';
  if (effective < STANDARD_FROM) return 'medium';
  return 'standard';
}

// Splitter positions are saved per range so narrowing a panel on a laptop does
// not change the desktop layout. Standard keeps the original key.
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
    return valid(storage.getItem(rangeWidthKey(baseKey, range)));
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

function snapshot(): { mode: LayoutMode; range: LayoutRange; interfaceWidth: number } {
  const mode = currentMode ?? (currentMode = readLayoutMode());
  const width = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const scale = currentScale();
  return { mode, range: layoutRange(width, scale, mode), interfaceWidth: Math.floor(width / scale) };
}

// The layout mode and the range to draw now. Updates on window resize, on an
// interface scale change and when the mode changes (in this tab or another).
export function useLayout(): { mode: LayoutMode; range: LayoutRange; interfaceWidth: number } {
  const [state, setState] = useState(snapshot);
  useEffect(() => {
    const update = () => setState((prev) => {
      const next = snapshot();
      return prev.mode === next.mode && prev.range === next.range && prev.interfaceWidth === next.interfaceWidth ? prev : next;
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
