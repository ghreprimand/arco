import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// One layout for operator dialogs opened from the composer and the top bar:
// rendered into document.body (so no ancestor transform, filter or stacking
// context can clip or cover it), an opaque dialog surface, a header with the
// title and a close button, a scrolling body, and actions at the bottom right.
// The header and footer never scroll away, so the result line and the actions
// stay visible at small window heights.

export const dialogTitleStyle: CSSProperties = {
  fontSize: '12px', letterSpacing: '3px', color: 'var(--color-accent-primary)', margin: 0, fontWeight: 'normal',
};
export const dialogBodyStyle: CSSProperties = { fontSize: '12px', lineHeight: 1.5 };

// Portals composer dialogs out of the composer. Static server rendering (unit
// tests) has no document, so children render in place there.
export function DialogPortal({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return <>{children}</>;
  return createPortal(children, document.body);
}

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  // Buttons for the bottom-right action row.
  actions?: ReactNode;
  // Result or error line kept between the scrolling body and the actions.
  status?: ReactNode;
  width?: number;
  ariaLabel?: string;
  testId?: string;
  dataHelp?: string;
  zIndex?: number;
  // Backdrop clicks close only when the dialog holds no work to lose.
  closeOnBackdrop?: boolean;
  closeLabel?: string;
  closeTestId?: string;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href]';

export function DialogShell({ title, onClose, children, actions, status, width = 680, ariaLabel, testId, dataHelp, zIndex = 2000, closeOnBackdrop = false, closeLabel = 'Close', closeTestId, onKeyDown }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    box.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); return; }
      if (event.key !== 'Tab' || !box.current) return;
      const controls = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!controls.length) { event.preventDefault(); box.current.focus(); return; }
      const index = controls.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); controls[controls.length - 1]?.focus(); }
      else if (!event.shiftKey && (index < 0 || index === controls.length - 1)) { event.preventDefault(); controls[0]?.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); previous?.focus(); };
  }, []);
  return (
    <DialogPortal>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? title}
        data-testid={testId}
        data-help={dataHelp}
        data-dialog-shell=""
        onClick={(e) => { e.stopPropagation(); if (closeOnBackdrop && e.target === e.currentTarget) onClose(); }}
        onKeyDown={(e) => { if (e.key !== 'Escape') e.stopPropagation(); onKeyDown?.(e); }}
        style={{ position: 'fixed', inset: 0, zIndex, background: 'rgba(0,0,0,.65)', display: 'grid', placeItems: 'center', padding: '12px' }}
      >
        <div
          ref={box}
          tabIndex={-1}
          style={{
            width: `min(${width}px, 100%)`, maxHeight: 'calc(85vh / var(--ui-scale, 1))', minHeight: 0,
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
            background: 'var(--color-bg-dialog)', border: '1px solid var(--color-border-hairline)', borderRadius: '6px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)', fontFamily: 'var(--font-body)', outline: 'none',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', borderBottom: '1px solid var(--color-border-hairline)', flexShrink: 0 }}>
            <h2 className="display-font" style={dialogTitleStyle}>{title.toUpperCase()}</h2>
            <button
              type="button"
              aria-label={closeLabel}
              data-testid={closeTestId}
              title={closeLabel}
              onClick={onClose}
              className="display-font"
              style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid var(--color-border-hairline)', color: 'var(--color-fg-muted)', padding: '2px 8px', cursor: 'pointer', fontSize: '12px', lineHeight: 1.2 }}
            >{'\u00D7'}</button>
          </div>
          <div style={{ ...dialogBodyStyle, flex: '1 1 auto', minHeight: 0, overflow: 'auto', overflowWrap: 'anywhere', padding: '12px 14px', display: 'grid', gap: '10px', alignContent: 'start' }}>
            {children}
          </div>
          {status && <div style={{ ...dialogBodyStyle, padding: '8px 14px', borderTop: '1px solid var(--color-border-hairline)', flexShrink: 0, overflowWrap: 'anywhere', maxHeight: '30%', overflow: 'auto' }}>{status}</div>}
          {actions && (
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '8px', padding: '10px 14px', borderTop: '1px solid var(--color-border-hairline)', flexShrink: 0 }}>
              {actions}
            </div>
          )}
        </div>
      </div>
    </DialogPortal>
  );
}
