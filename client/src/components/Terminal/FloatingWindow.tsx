import { interfaceScale, layoutPoint } from '../../utils/pointer';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePhoneLayout } from '../../layout/layoutRange';
import { usePhoneOverlay } from '../../layout/phoneOverlay';
import { usePhoneStore } from '../../stores/phoneStore';

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
    x: initial?.x ?? Math.max(40, window.innerWidth / interfaceScale() - 760),
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
      const point = layoutPoint(e);
      const dx = point.x - d.startX;
      const dy = point.y - d.startY;
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
    const point = layoutPoint(e);
    dragRef.current = { mode, startX: point.x, startY: point.y, orig: pos };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = mode === 'move' ? 'grabbing' : 'nwse-resize';
    setZ(nextZ());
  };

  // Mobile view (docs/CLIENT.md "Mobile view"): the window fills the screen
  // below the phone header instead of floating, and does not drag or resize.
  // It is the one overlay over the chat there: a sheet or side panel closes,
  // and the chat underneath cannot take focus while it is open.
  const phone = usePhoneLayout();
  const windowRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (phone) usePhoneStore.getState().claim('terminal'); }, [phone]);
  usePhoneOverlay(windowRef, phone);
  return (
    <div
      ref={windowRef}
      onMouseDown={() => setZ(nextZ())}
      data-testid="floating-window"
      data-phone-terminal={phone ? '' : undefined}
      style={{
        position: 'fixed',
        ...(phone ? {
          left: 0,
          top: 'calc(var(--phone-vt, 0px) / var(--ui-scale, 1) + var(--phone-header-h, 0px))',
          width: '100%',
          height: 'calc(var(--phone-vh, 100dvh) / var(--ui-scale, 1) - var(--phone-header-h, 0px))',
          borderRadius: 0,
        } : { left: pos.x, top: pos.y, width: pos.width, height: pos.height }),
        zIndex: z,
        display: 'flex',
        flexDirection: 'column',
        // The phone view paints the opaque dialog surface: a glass panel
        // would show the conversation through the window.
        background: phone ? 'var(--color-bg-dialog, var(--color-bg-panel))' : 'var(--color-bg-panel)',
        border: '1px solid var(--color-accent-primary-dim)',
        borderRadius: '6px',
        boxShadow: '0 12px 40px rgba(0,0,0,0.55)',
        overflow: 'hidden',
      }}
    >
      {/* Title bar — drag handle */}
      <div
        onMouseDown={phone ? undefined : startDrag('move')}
        className="display-font"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          padding: '6px 10px',
          background: phone ? 'var(--color-bg-dialog, var(--color-bg-secondary))' : 'var(--color-bg-secondary)',
          borderBottom: '1px solid var(--color-border-hairline)',
          cursor: phone ? 'default' : 'grab',
          userSelect: 'none',
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-accent-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {title}
        </span>
        {/* On a phone the actions wrap onto a second row rather than push the
            close button off the screen. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', ...(phone ? { flexWrap: 'wrap' as const, justifyContent: 'flex-end', flexShrink: 1, minWidth: 0 } : { flexShrink: 0 }) }} onMouseDown={(e) => e.stopPropagation()}>
          {headerActions}
          <button
            onClick={onClose}
            aria-label="Close window"
            title="Close window (the shell keeps running: reopen to re-attach)"
            className="display-font"
            style={{
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: 'var(--color-fg-muted)',
              cursor: 'pointer',
              fontSize: phone ? '16px' : '12px',
              width: phone ? '40px' : '20px',
              height: phone ? '36px' : '20px',
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
      {!phone && <div
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
      />}
    </div>
  );
}
