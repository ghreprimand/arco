import { useEffect, useRef, useState, type ReactNode } from 'react';

// WORKBENCH_EXPANSION §K1 — reusable floating window shell.
//
// A draggable, resizable overlay that stays on top and is NON-BLOCKING: it's
// `position: fixed` and does NOT participate in the two-column layout (not a
// tab / drawer / modal — no backdrop, no layout reflow). Drag by the title
// bar; resize from the bottom-right handle. Focusing (mousedown anywhere)
// raises z-order via a module-level counter so tiling several works.

let zTop = 1000;
function nextZ(): number {
  zTop += 1;
  return zTop;
}

interface Props {
  title: string;
  onClose: () => void;
  // Right-aligned controls in the title bar (e.g. a Kill button).
  headerActions?: ReactNode;
  children: ReactNode;
  initial?: { x: number; y: number; width: number; height: number };
}

const MIN_W = 360;
const MIN_H = 200;

export function FloatingWindow({ title, onClose, headerActions, children, initial }: Props) {
  const [pos, setPos] = useState(() => ({
    x: initial?.x ?? Math.max(40, window.innerWidth - 760),
    y: initial?.y ?? 90,
    width: initial?.width ?? 700,
    height: initial?.height ?? 420,
  }));
  const [z, setZ] = useState(() => nextZ());

  // Drag / resize state lives in refs so the move handler doesn't re-bind.
  const dragRef = useRef<{ mode: 'move' | 'resize' | null; startX: number; startY: number; orig: typeof pos }>({
    mode: null,
    startX: 0,
    startY: 0,
    orig: pos,
  });

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const d = dragRef.current;
      if (!d.mode) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (d.mode === 'move') {
        setPos((p) => ({ ...p, x: d.orig.x + dx, y: Math.max(0, d.orig.y + dy) }));
      } else {
        setPos((p) => ({
          ...p,
          width: Math.max(MIN_W, d.orig.width + dx),
          height: Math.max(MIN_H, d.orig.height + dy),
        }));
      }
    }
    function onUp() {
      if (dragRef.current.mode) {
        dragRef.current.mode = null;
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      }
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
      onUp();
    };
  }, []);

  const startDrag = (mode: 'move' | 'resize') => (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { mode, startX: e.clientX, startY: e.clientY, orig: pos };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = mode === 'move' ? 'grabbing' : 'nwse-resize';
    setZ(nextZ());
  };

  return (
    <div
      onMouseDown={() => setZ(nextZ())}
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: pos.width,
        height: pos.height,
        zIndex: z,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--color-bg-panel)',
        border: '1px solid var(--color-accent-primary-dim)',
        borderRadius: '6px',
        boxShadow: '0 12px 40px rgba(0,0,0,0.55)',
        overflow: 'hidden',
      }}
    >
      {/* Title bar — drag handle */}
      <div
        onMouseDown={startDrag('move')}
        className="display-font"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          padding: '6px 10px',
          background: 'var(--color-bg-secondary)',
          borderBottom: '1px solid var(--color-border-hairline)',
          cursor: 'grab',
          userSelect: 'none',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-accent-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }} onMouseDown={(e) => e.stopPropagation()}>
          {headerActions}
          <button
            onClick={onClose}
            title="Close window (the shell keeps running — reopen to re-attach)"
            className="display-font"
            style={{
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: 'var(--color-fg-muted)',
              cursor: 'pointer',
              fontSize: '12px',
              width: '20px',
              height: '20px',
              padding: 0,
            }}
          >
            ×
          </button>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>

      {/* Resize handle (bottom-right) */}
      <div
        onMouseDown={startDrag('resize')}
        title="Drag to resize"
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          width: '16px',
          height: '16px',
          cursor: 'nwse-resize',
          // Subtle corner grip.
          background: 'linear-gradient(135deg, transparent 50%, var(--color-accent-primary-dim) 50%)',
        }}
      />
    </div>
  );
}
