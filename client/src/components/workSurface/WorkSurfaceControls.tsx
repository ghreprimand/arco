import { useEffect, useRef, useState, type RefObject } from 'react';

// Geometry is local to the open dialog. CSS viewport limits continue to apply
// after a window or browser zoom change, without storing project information.
export function WorkSurfaceControls({ surface }: { surface: RefObject<HTMLElement | null> }) {
  const [maximized, setMaximized] = useState(false);
  const restore = useRef<{ width: string; height: string } | null>(null);
  const initial = useRef<{ width: string; height: string }>({ width: '', height: '' });
  useEffect(() => { const el = surface.current; if (el) initial.current = { width: el.style.width, height: el.style.height }; }, [surface]);
  const drag = useRef<{ x: number; y: number; width: number; height: number; scale: number } | null>(null);
  const scale = () => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
  const change = (width: number, height: number) => {
    const el = surface.current;
    if (!el) return;
    el.style.width = `${Math.max(280, width)}px`;
    el.style.height = `${Math.max(260, height)}px`;
  };
  const toggle = () => {
    const el = surface.current;
    if (!el) return;
    if (maximized) {
      el.style.width = restore.current?.width ?? '';
      el.style.height = restore.current?.height ?? '';
      setMaximized(false);
    } else {
      restore.current = { width: el.style.width, height: el.style.height };
      el.style.width = 'calc(96vw / var(--ui-scale, 1))';
      el.style.height = 'calc(94vh / var(--ui-scale, 1))';
      setMaximized(true);
    }
  };
  return <span className="work-surface-controls">
    <button type="button" onClick={toggle} aria-label={maximized ? 'Restore dialog size' : 'Maximize dialog'}>{maximized ? 'Restore' : 'Maximize'}</button>
    <button type="button" className="work-surface-resize" aria-label="Resize dialog" title="Drag or use arrow keys to resize; Home restores initial size" onPointerDown={e => {
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
      if (e.key === 'Home') { e.preventDefault(); el.style.width = initial.current.width; el.style.height = initial.current.height; setMaximized(false); return; }
      const step = e.shiftKey ? 80 : 20;
      const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!delta) return;
      e.preventDefault(); e.stopPropagation();
      const rect = el.getBoundingClientRect(), s = scale();
      change(rect.width / s + delta[0], rect.height / s + delta[1]);
      setMaximized(false);
    }}>Resize</button>
  </span>;
}
