// Narrow-range panels (client/src/layout/layoutRange.ts): the member list and
// the right panel fold away, and open over the chat from a rail or a strip.
// The panel itself is the same component as in the wider layouts; only its
// place changes. Escape, the close button or a click beside it closes it.

import { useEffect, type ReactNode } from 'react';

interface SlideOutProps {
  side: 'left' | 'right';
  width: string;
  label: string;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}

export function SlideOut({ side, width, label, onClose, children, testId }: SlideOutProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 40, display: 'flex', justifyContent: side === 'left' ? 'flex-start' : 'flex-end' }}>
      <div onClick={onClose} aria-hidden="true" style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)' }} />
      <div
        role="dialog"
        aria-label={label}
        data-testid={testId}
        style={{
          position: 'relative', width, maxWidth: '92%', height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0,
          background: 'var(--color-bg-dialog, var(--color-bg-panel))',
          [side === 'left' ? 'borderRight' : 'borderLeft']: '1px solid var(--color-border-hairline)',
          boxShadow: '0 0 24px rgba(0,0,0,0.45)',
        }}
      >
        <div className="display-font" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 8px', borderBottom: '1px solid var(--color-border-hairline)', fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>
          <span style={{ flex: 1 }}>{label}</span>
          <button type="button" data-help="layout.slide-out-close" onClick={onClose} title="Close (Esc)" aria-label={`Close ${label}`} className="display-font" style={{ padding: '1px 8px', fontSize: '10px', cursor: 'pointer' }}>CLOSE</button>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>{children}</div>
      </div>
    </div>
  );
}

interface StripProps {
  items: Array<{ id: string; label: string }>;
  active: string | null;
  onOpen: (id: string) => void;
}

// A 34 px strip of vertical buttons on the right edge (narrow range).
export function PanelStrip({ items, active, onOpen }: StripProps) {
  return (
    <div data-help="layout.right-strip" data-testid="layout-panel-strip" style={{ flex: '0 0 34px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px', padding: '8px 0', borderLeft: '1px solid var(--color-border-hairline)' }}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onOpen(item.id)}
          aria-pressed={active === item.id}
          title={`Open ${item.label}`}
          className="display-font"
          style={{
            writingMode: 'vertical-rl', fontSize: '10px', letterSpacing: '1px', padding: '6px 2px', cursor: 'pointer',
            background: active === item.id ? 'var(--color-accent-primary-a08)' : 'transparent',
            color: active === item.id ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
            border: `1px solid ${active === item.id ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
