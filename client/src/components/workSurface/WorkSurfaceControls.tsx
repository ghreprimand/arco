import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';

// Content windows share viewport-relative starting and maximum dimensions.
// UI scale is applied outside the surface, so convert viewport dimensions back
// into unscaled CSS pixels before sizing the surface.
export const contentSurfaceSize: CSSProperties = {
  width: 'min(calc(90vw / var(--ui-scale, 1)), 140em)',
  height: 'calc(85vh / var(--ui-scale, 1))',
  maxWidth: 'calc(96vw / var(--ui-scale, 1))',
  maxHeight: 'calc(94vh / var(--ui-scale, 1))',
  boxSizing: 'border-box',
  resize: 'both',
};

export const confirmationSurfaceSize: CSSProperties = {
  width: 'min(calc(96vw / var(--ui-scale, 1)), clamp(22em, calc(40vw / var(--ui-scale, 1)), 36em))',
  height: 'auto',
  maxWidth: 'calc(96vw / var(--ui-scale, 1))',
  maxHeight: 'calc(94vh / var(--ui-scale, 1))',
  boxSizing: 'border-box',
  overflow: 'auto',
  resize: 'both',
};

export const formSurfaceSize = (minimum = 0): CSSProperties => ({
  width: `min(calc(96vw / var(--ui-scale, 1)), clamp(max(36em, ${minimum / 14}em), calc(50vw / var(--ui-scale, 1)), 60em))`,
  height: 'auto',
  maxWidth: 'calc(96vw / var(--ui-scale, 1))', maxHeight: 'calc(90vh / var(--ui-scale, 1))',
  boxSizing: 'border-box', resize: 'both',
});

export const pickerSurfaceSize: CSSProperties = {
  width: 'min(calc(96vw / var(--ui-scale, 1)), clamp(40em, calc(70vw / var(--ui-scale, 1)), 90em))',
  height: 'min(calc(94vh / var(--ui-scale, 1)), clamp(24em, calc(75vh / var(--ui-scale, 1)), 60em))',
  maxWidth: 'calc(96vw / var(--ui-scale, 1))', maxHeight: 'calc(94vh / var(--ui-scale, 1))',
  boxSizing: 'border-box', resize: 'both',
};

// Only a stable dialog-kind key and dimensions are stored; project names and
// paths never enter this key. CSS viewport limits still apply after a resize.
export function WorkSurfaceControls({ surface, storageKey }: { surface: RefObject<HTMLElement | null>; storageKey?: string }) {
  const [maximized, setMaximized] = useState(false);
  const [gripSurface, setGripSurface] = useState<HTMLElement | null>(null);
  const restore = useRef<{ width: string; height: string } | null>(null);
  const initial = useRef<{ width: string; height: string }>({ width: '', height: '' });
  const key = storageKey && /^[a-z0-9._-]{1,80}$/i.test(storageKey) ? `arco.dialog-size.${storageKey}` : undefined;
  useEffect(() => {
    const el = surface.current;
    if (!el) return;
    initial.current = { width: el.style.width, height: el.style.height };
    if (window.getComputedStyle(el).position === 'static' || !window.getComputedStyle(el).position) el.style.position = 'relative';
    const computed = window.getComputedStyle(el);
    const outerScroll = /(auto|scroll)/.test(computed.overflowX + computed.overflowY);
    const originalRightPadding = el.style.paddingRight;
    if (outerScroll) {
      // Keep the frame grip outside scrolling controls and native scrollbars.
      el.style.paddingRight = `${Math.max(26, Number.parseFloat(computed.paddingRight) || 0)}px`;
      el.classList.add('work-surface-scroll-frame');
    }
    const followScroll = () => {
      // Absolute children scroll with their container. Cancel that movement
      // so the grip stays at the visible frame corner, even in short dialogs.
      el.style.setProperty('--work-surface-scroll-left', `${el.scrollLeft}px`);
      el.style.setProperty('--work-surface-scroll-top', `${el.scrollTop}px`);
    };
    followScroll();
    el.addEventListener('scroll', followScroll, { passive: true });
    el.classList.add('work-surface-resizable');
    setGripSurface(el);
    try {
      const saved = key ? JSON.parse(localStorage.getItem(key) || 'null') : null;
      if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height) && saved.width >= 200 && saved.width <= 10000 && saved.height >= 100 && saved.height <= 10000) {
        el.style.width = `${saved.width}px`; el.style.height = `${saved.height}px`;
        if (saved.maximized === true) {
          restore.current = { width: el.style.width, height: el.style.height };
          el.style.width = 'calc(96vw / var(--ui-scale, 1))'; el.style.height = 'calc(94vh / var(--ui-scale, 1))';
          setMaximized(true);
        }
      }
    } catch { /* Storage is optional. */ }
    let start: { width: number; height: number } | null = null;
    let suppressClick = false;
    const down = (event: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      if (event.clientX >= rect.right - 24 && event.clientY >= rect.bottom - 24) start = { width: rect.width, height: rect.height };
    };
    const up = () => {
      if (!start) return;
      const rect = el.getBoundingClientRect();
      if (Math.abs(rect.width - start.width) > 1 || Math.abs(rect.height - start.height) > 1) {
        const scale = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
        try { if (key) localStorage.setItem(key, JSON.stringify({ width: rect.width / scale, height: rect.height / scale, maximized: false })); } catch { /* Storage is optional. */ }
        setMaximized(false);
        // Releasing a native resize outside the box can produce a click on
        // its backdrop. That click must not close a dialog holding work.
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
      }
      start = null;
    };
    const click = (event: MouseEvent) => { if (suppressClick) { suppressClick = false; event.preventDefault(); event.stopImmediatePropagation(); } };
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointerup', up);
    window.addEventListener('click', click, true);
    return () => { el.removeEventListener('scroll', followScroll); if (outerScroll) { el.style.paddingRight = originalRightPadding; el.classList.remove('work-surface-scroll-frame'); } el.removeEventListener('pointerdown', down); window.removeEventListener('pointerup', up); window.removeEventListener('click', click, true); };
  }, [surface, key]);
  const drag = useRef<{ x: number; y: number; width: number; height: number; scale: number } | null>(null);
  const scale = () => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
  const save = (width: number, height: number, isMaximized = false) => {
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify({ width, height, maximized: isMaximized })); } catch { /* Storage is optional. */ }
  };
  const reset = () => {
    const el = surface.current;
    if (!el) return;
    el.style.width = initial.current.width; el.style.height = initial.current.height;
    restore.current = null; setMaximized(false);
    try { if (key) localStorage.removeItem(key); } catch { /* Storage is optional. */ }
  };
  const change = (width: number, height: number) => {
    const el = surface.current;
    if (!el) return;
    el.style.width = `${Math.max(280, width)}px`;
    el.style.height = `${Math.max(260, height)}px`;
    save(Math.max(280, width), Math.max(260, height));
  };
  const toggle = () => {
    const el = surface.current;
    if (!el) return;
    if (maximized) {
      el.style.width = restore.current?.width ?? '';
      el.style.height = restore.current?.height ?? '';
      setMaximized(false);
      const rect = el.getBoundingClientRect(); save(rect.width / scale(), rect.height / scale());
    } else {
      restore.current = { width: el.style.width, height: el.style.height };
      const rect = el.getBoundingClientRect(); save(rect.width / scale(), rect.height / scale(), true);
      el.style.width = 'calc(96vw / var(--ui-scale, 1))';
      el.style.height = 'calc(94vh / var(--ui-scale, 1))';
      setMaximized(true);
    }
  };
  return <><span className="work-surface-controls" data-help="dialog.size">
    <button type="button" onClick={toggle} aria-label={maximized ? 'Restore dialog size' : 'Maximize dialog'}>{maximized ? 'Restore' : 'Maximize'}</button>
    <button type="button" onClick={reset} aria-label="Reset dialog size">Reset size</button>
  </span>
    {gripSurface && createPortal(<button type="button" data-help="dialog.size" className="work-surface-resize" aria-label="Resize dialog" title="Drag to resize; arrow keys resize; Home resets size" onPointerDown={e => {
      const el = surface.current;
      if (!el) return;
      const s = scale(), rect = el.getBoundingClientRect();
      drag.current = { x: e.clientX, y: e.clientY, width: rect.width / s, height: rect.height / s, scale: s };
      e.currentTarget.setPointerCapture(e.pointerId);
      setMaximized(false);
    }} onPointerMove={e => {
      const start = drag.current;
      if (start) change(start.width + (e.clientX - start.x) * 2 / start.scale, start.height + (e.clientY - start.y) * 2 / start.scale);
    }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onKeyDown={e => {
      const el = surface.current;
      if (!el) return;
      if (e.key === 'Home') { e.preventDefault(); reset(); return; }
      const step = e.shiftKey ? 80 : 20;
      const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!delta) return;
      e.preventDefault(); e.stopPropagation();
      const rect = el.getBoundingClientRect(), s = scale();
      change(rect.width / s + delta[0], rect.height / s + delta[1]);
      setMaximized(false);
    }}><svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18"><path d="M4 15 15 4M9 15l6-6M14 15l1-1" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></button>, gripSurface)}
  </>;
}
