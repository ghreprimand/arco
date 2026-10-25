import { useEffect, useRef, useState } from 'react';

// I1-followup — generic header action menu. The header used to carry seven
// equally-weighted action buttons in a single row (Recall / Cookbook / Media /
// GitHub / Terminal + Settings / Manual); the operator read it as clutter. The
// five feature actions now fold into two labeled dropdowns (KNOWLEDGE / TOOLS)
// that mirror the prior visual grouping but cost one click to open. Settings +
// Manual stay outside as the "frame" controls. Same click-outside + popover
// chrome as ProvidersPopover so the header's progressive-disclosure surfaces
// look identical.

export interface HeaderMenuItem {
  key: string;
  label: string;
  icon: string;
  onClick: () => void;
  disabled?: boolean;
  // Item is in an "on" state (e.g. GitHub browser open) — renders an accent
  // dot + accent label so the open surface is legible without opening the menu.
  active?: boolean;
  title?: string;
  dataHelp?: string;
  // Override the resting label color (e.g. GitHub dims to muted when gh isn't
  // authed). Ignored when the item is active (active styling wins).
  color?: string;
}

interface Props {
  label: string;
  icon: string;
  items: HeaderMenuItem[];
  dataHelp?: string;
  title?: string;
}

const triggerBtn: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  background: 'transparent',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-accent-primary-dim)',
  cursor: 'pointer',
  fontSize: '10px',
  letterSpacing: '1px',
  padding: '3px 8px',
};

export function HeaderDropdown({ label, icon, items, dataHelp, title }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Any open surface inside the menu surfaces an accent dot on the trigger so
  // the operator sees "something in here is active" without opening it.
  const anyActive = items.some((i) => i.active);

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        data-help={dataHelp}
        className="display-font"
        title={title}
        style={{
          ...triggerBtn,
          background: open ? 'var(--color-accent-primary-a10)' : 'transparent',
          border: `1px solid ${anyActive ? 'var(--color-accent-secondary)' : 'var(--color-border-hairline)'}`,
        }}
      >
        {anyActive && (
          <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--color-accent-secondary)', flexShrink: 0 }} />
        )}
        <span style={{ opacity: 0.85 }}>{icon}</span>
        {label}
        <span style={{ fontSize: '8px', opacity: 0.7 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div
          role="menu"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: '180px',
            padding: '6px',
            // Elevated (not panel) so floating menus share one frosted opacity
            // level with the reader modals — the slider moves them together.
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '4px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
            zIndex: 20,
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
          }}
        >
          {items.map((item) => {
            const labelColor = item.active
              ? 'var(--color-accent-secondary)'
              : item.color ?? 'var(--color-accent-primary-dim)';
            return (
              <button
                key={item.key}
                role="menuitem"
                onClick={() => {
                  if (item.disabled) return;
                  item.onClick();
                  setOpen(false);
                }}
                disabled={item.disabled}
                data-help={item.dataHelp}
                className="display-font"
                title={item.title}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  background: item.active ? 'var(--color-accent-secondary-a10)' : 'transparent',
                  border: '1px solid transparent',
                  borderRadius: '3px',
                  color: item.disabled ? 'var(--color-fg-muted)' : labelColor,
                  cursor: item.disabled ? 'not-allowed' : 'pointer',
                  fontSize: '10px',
                  letterSpacing: '1px',
                  padding: '5px 8px',
                  textAlign: 'left',
                  width: '100%',
                  opacity: item.disabled ? 0.55 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!item.disabled && !item.active) e.currentTarget.style.background = 'var(--color-accent-primary-a08)';
                }}
                onMouseLeave={(e) => {
                  if (!item.active) e.currentTarget.style.background = 'transparent';
                }}
              >
                <span style={{ width: '14px', textAlign: 'center', opacity: 0.85, flexShrink: 0 }}>{item.icon}</span>
                <span style={{ flex: 1 }}>{item.label}</span>
                {item.active && (
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--color-accent-secondary)', flexShrink: 0 }} />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
