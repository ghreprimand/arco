import { useEffect, useMemo } from 'react';
import { Panel } from './primitives/Panel';
import { SHORTCUTS } from '../help/shortcuts';

// Workbench Expansion §J4 — keyboard-shortcut cheat sheet (Cmd/Ctrl+?).
//
// A read-only overlay rendering the SHORTCUTS registry grouped by area. The
// hotkey is wired in App.tsx (mirrors the Ctrl+P palette toggle); this
// component only renders once the open flag is set. Styling matches the
// UserManual / CommandPalette house look (Panel, dark overlay, display-font
// header, Escape-to-close). Combos render as <kbd>-style chips.

interface Props {
  onClose: () => void;
}

export function ShortcutCheatSheet({ onClose }: Props) {
  // Close on Escape — matches the UserManual / SettingsPanel convention.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Group preserving first-seen order from the registry.
  const groups = useMemo(() => {
    const order: string[] = [];
    const byGroup = new Map<string, typeof SHORTCUTS>();
    for (const s of SHORTCUTS) {
      if (!byGroup.has(s.group)) {
        byGroup.set(s.group, []);
        order.push(s.group);
      }
      byGroup.get(s.group)!.push(s);
    }
    return order.map((g) => ({ group: g, items: byGroup.get(g)! }));
  }, []);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.78)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9300,
        padding: '20px',
      }}
    >
      <Panel
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: '640px',
          maxHeight: 'calc(100vh - 80px)',
          background: 'var(--color-bg-panel)',
          border: '1px solid var(--color-border-hairline)',
          borderRadius: '6px',
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '16px 22px',
            borderBottom: '1px solid var(--color-border-hairline)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '14px' }}>
            <h2
              className="display-font glow-text-bright"
              style={{ fontSize: '14px', letterSpacing: '4px', margin: 0 }}
            >
              KEYBOARD SHORTCUTS
            </h2>
            <span
              style={{
                fontSize: '10px',
                color: 'var(--color-fg-muted)',
                fontFamily: 'var(--font-body)',
              }}
            >
              every key that does something
            </span>
          </div>
          <button
            data-help="shortcuts.cheatsheet.close"
            onClick={onClose}
            className="display-font"
            style={{
              background: 'transparent',
              border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px',
              color: 'var(--color-fg-muted)',
              cursor: 'pointer',
              fontSize: '10px',
              letterSpacing: '1px',
              padding: '4px 10px',
            }}
          >
            CLOSE ✕
          </button>
        </div>

        <div
          style={{
            overflowY: 'auto',
            padding: '18px 24px 26px',
            fontFamily: 'var(--font-body)',
            fontSize: '13px',
            lineHeight: 1.6,
            color: 'var(--color-fg)',
          }}
        >
          {groups.map(({ group, items }) => (
            <div key={group} style={{ marginBottom: '22px' }}>
              <div
                className="display-font"
                style={{
                  fontSize: '10px',
                  letterSpacing: '2px',
                  color: 'var(--color-accent-primary)',
                  textTransform: 'uppercase',
                  marginBottom: '10px',
                  paddingBottom: '5px',
                  borderBottom: '1px solid var(--color-border-hairline)',
                }}
              >
                {group}
              </div>
              {items.map((s) => (
                <div
                  key={`${group}:${s.combo}:${s.label}`}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: '14px',
                    padding: '4px 0',
                  }}
                >
                  <kbd
                    style={{
                      flexShrink: 0,
                      display: 'inline-block',
                      minWidth: '96px',
                      textAlign: 'center',
                      background: 'var(--color-bg-sunken)',
                      border: '1px solid var(--color-border-hairline)',
                      borderRadius: '3px',
                      padding: '2px 8px',
                      fontFamily: 'var(--font-code, monospace)',
                      fontSize: '11px',
                      color: 'var(--color-fg)',
                    }}
                  >
                    {s.combo}
                  </kbd>
                  <span style={{ color: 'var(--color-fg-muted)' }}>{s.label}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
