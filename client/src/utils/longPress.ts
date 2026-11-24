// Mobile view: a long press on a chat message selects it, in place of the
// selection box the workbench draws beside each message. While any message is
// selected, a tap on a message adds or removes it.

import { useMemo, useRef, type MouseEvent, type PointerEvent } from 'react';

export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP_PX = 10;

export interface LongPress {
  down: (x: number, y: number) => void;
  move: (x: number, y: number) => void;
  // The finger lifted or the gesture was taken over (a scroll).
  end: () => void;
  // True once, for the click that follows a press that fired.
  takeFired: () => boolean;
}

/** Fires once when a press is held for LONG_PRESS_MS without moving more than
 * LONG_PRESS_SLOP_PX. A scroll, an early lift or a second press cancels it. */
export function createLongPress(fire: () => void): LongPress {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start = { x: 0, y: 0 };
  let fired = false;
  const end = () => { if (timer) { clearTimeout(timer); timer = null; } };
  return {
    down: (x, y) => {
      end();
      fired = false;
      start = { x, y };
      timer = setTimeout(() => { timer = null; fired = true; fire(); }, LONG_PRESS_MS);
    },
    move: (x, y) => { if (timer && Math.hypot(x - start.x, y - start.y) > LONG_PRESS_SLOP_PX) end(); },
    end,
    takeFired: () => { const was = fired; fired = false; return was; },
  };
}

const CONTROL = 'button, a, input, textarea, select, summary, [role="button"]';

/** Props for a message row. `enabled` is false outside the mobile view, where
 * the row keeps its selection box. `selecting` is true while the tab has a
 * selection, so a plain tap toggles this message too. */
export function useLongPressSelect(enabled: boolean, selecting: boolean, toggle: () => void) {
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  const press = useMemo(() => createLongPress(() => toggleRef.current()), []);
  if (!enabled) return {};
  return {
    onPointerDown: (e: PointerEvent) => { if (e.pointerType !== 'mouse' && !(e.target as HTMLElement).closest(CONTROL)) press.down(e.clientX, e.clientY); },
    onPointerMove: (e: PointerEvent) => press.move(e.clientX, e.clientY),
    onPointerUp: () => press.end(),
    onPointerCancel: () => press.end(),
    // The press selected the message; the browser's own long-press menu stays shut.
    onContextMenu: (e: MouseEvent) => { if (press.takeFired()) e.preventDefault(); },
    onClickCapture: (e: MouseEvent) => {
      if (press.takeFired()) { e.preventDefault(); e.stopPropagation(); return; }
      if (!selecting || (e.target as HTMLElement).closest(CONTROL)) return;
      e.preventDefault();
      e.stopPropagation();
      toggleRef.current();
    },
  };
}
