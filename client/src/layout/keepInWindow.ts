import { useMemo, type RefCallback } from 'react';
import { UI_SCALE_EVENT } from './layoutRange';

// One placement rule for every dropdown, popover, menu and hover card.
//
// Each floating panel keeps its own CSS position (below or above its trigger,
// at a pointer, centered). After it is drawn the rule measures it and, only
// where it would leave the window:
//   1. caps its width to the window less the margin on both sides;
//   2. flips it to the other side of its trigger when that side has more room;
//   3. caps its height to the room on the chosen side and scrolls inside;
//   4. shifts it along the edge so it stays fully inside, with the margin.
// It re-runs on window resize, interface scale change, page scroll and when
// the panel or its trigger changes size.
//
// Coordinates: getBoundingClientRect and window.innerWidth/innerHeight are in
// window pixels; with an interface scale (CSS zoom on the root element) a
// style length of 1px covers `scale` window pixels, so lengths written back
// are divided by the scale.

export interface Box { left: number; top: number; right: number; bottom: number; width: number; height: number }
export type PlacementSide = 'below' | 'above' | 'free';
export interface Placement {
  /** Where the panel's top-left corner goes, in window pixels. */
  left: number;
  top: number;
  /** Height cap in window pixels, or null when the panel fits as drawn. */
  maxHeight: number | null;
  side: PlacementSide;
}

/** Default distance kept between a panel and the window edge, in style pixels. */
export const WINDOW_MARGIN = 8;
/** Attribute set on every panel the rule manages; tests and tools find them by it. */
export const PLACEMENT_ATTRIBUTE = 'data-window-placement';

/** Width cap in window pixels, or null when the panel already fits across. */
export function widthCap(width: number, viewportWidth: number, margin: number): number | null {
  const room = Math.max(0, viewportWidth - 2 * margin);
  return width > room + 0.5 ? room : null;
}

/** The side of the trigger the panel was drawn on. Overlapping panels are free. */
export function drawnSide(box: Box, anchor: Box | null): PlacementSide {
  if (!anchor) return 'free';
  if (box.top >= anchor.bottom - 1) return 'below';
  if (box.bottom <= anchor.top + 1) return 'above';
  return 'free';
}

/**
 * Where a panel of size `box` should go. `box` is the panel as its own CSS
 * placed it; `anchor` is its trigger (null for panels at a pointer or without
 * a trigger). Pure: the DOM side applies the result.
 */
export function planPlacement(box: Box, anchor: Box | null, viewport: { width: number; height: number }, margin: number): Placement {
  const side = drawnSide(box, anchor);
  let top = box.top;
  let maxHeight: number | null = null;
  let chosen: PlacementSide = side;
  let height = box.height;
  if (anchor && side !== 'free') {
    const gap = Math.max(0, side === 'below' ? box.top - anchor.bottom : anchor.top - box.bottom);
    const room = {
      below: Math.max(0, viewport.height - margin - (anchor.bottom + gap)),
      above: Math.max(0, anchor.top - gap - margin),
    };
    const other: PlacementSide = side === 'below' ? 'above' : 'below';
    if (height > room[side] + 0.5 && room[other] > room[side]) chosen = other;
    const space = room[chosen as 'below' | 'above'];
    if (height > space + 0.5) { maxHeight = space; height = space; }
    top = chosen === 'below' ? anchor.bottom + gap : anchor.top - gap - height;
  } else {
    const room = Math.max(0, viewport.height - 2 * margin);
    if (height > room + 0.5) { maxHeight = room; height = room; }
  }
  // Last, keep the whole panel inside vertically (a trigger itself can sit
  // partly outside the window, or a pointer menu can open near the bottom).
  if (top + height > viewport.height - margin) top = viewport.height - margin - height;
  if (top < margin) top = margin;
  let left = box.left;
  if (left + box.width > viewport.width - margin) left = viewport.width - margin - box.width;
  if (left < margin) left = margin;
  return { left, top, maxHeight, side: chosen };
}

// The window the panel is drawn in. Without a laid-out window (server-side
// rendering, unit tests with a minimal DOM) the rule does nothing.
function viewOf(el: HTMLElement): (Window & typeof globalThis) | null {
  const view = el.ownerDocument?.defaultView as (Window & typeof globalThis) | null | undefined;
  return view && typeof view.getComputedStyle === 'function' && typeof el.getBoundingClientRect === 'function' ? view : null;
}

function scaleOf(view: Window): number {
  const raw = Number.parseFloat(view.getComputedStyle(view.document.documentElement).zoom);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

interface Saved { maxHeight: string; maxWidth: string; overflowY: string }
const saved = new WeakMap<HTMLElement, Saved>();

function defaultAnchor(view: Window, el: HTMLElement): Element | null {
  return view.getComputedStyle(el).position === 'absolute' ? el.offsetParent : null;
}

/** Measure `el` and move it inside the window. Safe to call repeatedly. */
export function placeInWindow(el: HTMLElement, anchor?: Element | null, marginPx: number = WINDOW_MARGIN): void {
  const view = viewOf(el);
  if (!view || !el.isConnected) return;
  let original = saved.get(el);
  if (!original) {
    original = { maxHeight: el.style.maxHeight, maxWidth: el.style.maxWidth, overflowY: el.style.overflowY };
    saved.set(el, original);
  }
  // Start from the panel's own placement every time.
  el.style.translate = '';
  el.style.maxHeight = original.maxHeight;
  el.style.maxWidth = original.maxWidth;
  el.style.overflowY = original.overflowY;
  let box = el.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return; // hidden (display: none, closed details)
  const scale = scaleOf(view);
  const margin = marginPx * scale;
  const viewport = { width: view.innerWidth, height: view.innerHeight };
  const capW = widthCap(box.width, viewport.width, margin);
  if (capW !== null) {
    el.style.maxWidth = `${capW / scale}px`;
    box = el.getBoundingClientRect();
  }
  const trigger = anchor === undefined ? defaultAnchor(view, el) : anchor;
  const anchorBox = trigger ? trigger.getBoundingClientRect() : null;
  const plan = planPlacement(box, anchorBox, viewport, margin);
  if (plan.maxHeight !== null) {
    el.style.maxHeight = `${plan.maxHeight / scale}px`;
    if (!['auto', 'scroll'].includes(view.getComputedStyle(el).overflowY)) el.style.overflowY = 'auto';
    box = el.getBoundingClientRect();
  }
  const dx = plan.left - box.left;
  const dy = plan.top - box.top;
  if (Math.abs(dx) > 0.25 || Math.abs(dy) > 0.25) el.style.translate = `${dx / scale}px ${dy / scale}px`;
  el.setAttribute(PLACEMENT_ATTRIBUTE, plan.side);
}

/**
 * Watch `el` until it is removed and keep it inside the window. Returns the
 * function that stops watching.
 */
export function keepElementInWindow(el: HTMLElement, getAnchor?: () => Element | null | undefined, margin: number = WINDOW_MARGIN): () => void {
  const view = viewOf(el);
  if (!view) return () => {};
  let frame = 0;
  const anchorNow = () => (getAnchor ? getAnchor() ?? null : undefined);
  const run = () => { frame = 0; placeInWindow(el, anchorNow(), margin); };
  const schedule = () => {
    if (frame) return;
    if (typeof view.requestAnimationFrame === 'function') frame = view.requestAnimationFrame(run);
    else run();
  };
  run();
  const resize = typeof view.ResizeObserver === 'function' ? new view.ResizeObserver(schedule) : null;
  resize?.observe(el);
  const anchor = getAnchor ? getAnchor() : defaultAnchor(view, el);
  if (anchor) resize?.observe(anchor);
  view.addEventListener('resize', schedule);
  view.addEventListener(UI_SCALE_EVENT, schedule);
  view.addEventListener('scroll', schedule, { capture: true, passive: true });
  el.addEventListener('animationend', schedule);
  el.addEventListener('transitionend', schedule);
  // A menu inside <details> is laid out again when the details opens.
  const details = el.closest('details');
  details?.addEventListener('toggle', schedule);
  return () => {
    details?.removeEventListener('toggle', schedule);
    if (frame) view.cancelAnimationFrame(frame);
    resize?.disconnect();
    view.removeEventListener('resize', schedule);
    view.removeEventListener(UI_SCALE_EVENT, schedule);
    view.removeEventListener('scroll', schedule, { capture: true });
    el.removeEventListener('animationend', schedule);
    el.removeEventListener('transitionend', schedule);
  };
}

type AnchorSource = { current: Element | null } | (() => Element | null);
export interface KeepInWindowOptions<T> {
  /** The trigger; defaults to the panel's positioned parent for absolute panels. */
  anchor?: AnchorSource;
  /** A ref object the component already uses for the panel; it is kept current. */
  ref?: { current: T | null };
  /** Distance from the window edge in style pixels. */
  margin?: number;
}

export function keepInWindowRef<T extends HTMLElement>(options: KeepInWindowOptions<T> = {}): RefCallback<T> {
  let stop: (() => void) | null = null;
  const { anchor, ref, margin = WINDOW_MARGIN } = options;
  const getAnchor = anchor === undefined ? undefined : typeof anchor === 'function' ? anchor : () => anchor.current;
  return (el: T | null) => {
    if (ref) ref.current = el;
    stop?.();
    stop = el ? keepElementInWindow(el, getAnchor, margin) : null;
  };
}

/**
 * Callback ref for a floating panel: attach it to the panel's element. The
 * trigger defaults to the panel's positioned parent (absolute panels); pass
 * `anchor` for panels placed some other way.
 */
export function useKeepInWindow<T extends HTMLElement = HTMLDivElement>(options?: KeepInWindowOptions<T>): RefCallback<T> {
  // One stable callback per component: React calls it with the element when
  // the panel appears and with null when it goes. Options are read once; refs
  // passed in are objects, so their later values are still seen.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => keepInWindowRef<T>(options), []);
}
