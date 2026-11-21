// Mobile view (docs/CLIENT.md "Mobile view"): a sheet, a full-width side
// panel or the terminal window covers the conversation. Everything it covers is
// made inert, so Tab and touch reach only the overlay and the phone header,
// never the hidden chat controls underneath.
import { useEffect, type RefObject } from 'react';

// The DOM members used here, so the walk can be checked without a browser.
export interface InertNode {
  parentElement: InertNode | null;
  readonly children: ArrayLike<InertNode>;
  contains(other: InertNode | null): boolean;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

// How many overlays shut each element out, so a second overlay opening while
// the first closes never clears the other's inert mark, and an element that
// was already inert stays inert.
const holds = new Map<InertNode, number>();

export type Reach = 'keep' | 'descend' | 'shut';

/** Marks everything inside `root` as inert except the overlay, its ancestors
 * and what `reach` keeps (the phone header). An element that only holds a kept
 * one ('descend') is not marked itself; its other children are. Returns the
 * undo. */
export function shutOutside(overlay: InertNode, root: InertNode, reach: (el: InertNode) => Reach): () => void {
  if (overlay === root || !root.contains(overlay)) return () => {};
  const marked: InertNode[] = [];
  const shut = (el: InertNode) => {
    const kind = reach(el);
    if (kind === 'keep') return;
    if (kind === 'descend') { for (const child of Array.from(el.children)) shut(child); return; }
    const count = holds.get(el);
    if (count === undefined && el.hasAttribute('inert')) return;
    holds.set(el, (count ?? 0) + 1);
    el.setAttribute('inert', '');
    marked.push(el);
  };
  for (let node: InertNode = overlay; node !== root && node.parentElement; node = node.parentElement) {
    for (const el of Array.from(node.parentElement.children)) if (el !== node) shut(el);
  }
  return () => {
    for (const el of marked) {
      const count = (holds.get(el) ?? 1) - 1;
      if (count > 0) { holds.set(el, count); continue; }
      holds.delete(el);
      el.removeAttribute('inert');
    }
  };
}

const PHONE_HEADER = '[data-testid="phone-header"]';
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** While `active`, the overlay in `ref` is the only reachable part of the phone
 * screen besides the phone header. Focus moves into it if it is elsewhere, and
 * returns to where it came from (or to `fallback` in the header) on close. */
export function usePhoneOverlay(ref: RefObject<HTMLElement | null>, active: boolean, fallback = '[data-testid="phone-panels"]'): void {
  useEffect(() => {
    const el = ref.current;
    const root = el?.closest<HTMLElement>('[data-phone-layout]');
    if (!active || !el || !root) return;
    const opener = document.activeElement as HTMLElement | null;
    const undo = shutOutside(el as unknown as InertNode, root as unknown as InertNode, (node) => {
      const element = node as unknown as HTMLElement;
      if (element.matches?.(PHONE_HEADER)) return 'keep';
      return element.querySelector?.(PHONE_HEADER) ? 'descend' : 'shut';
    });
    if (!el.contains(document.activeElement)) el.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      undo();
      // Leave focus alone when another overlay already took it.
      const now = document.activeElement;
      if (now && now !== document.body && !el.contains(now)) return;
      const back = opener && opener !== document.body && !el.contains(opener) && document.contains(opener) && !opener.closest('[inert]');
      (back ? opener : document.querySelector<HTMLElement>(fallback))?.focus();
    };
  }, [ref, active, fallback]);
}
