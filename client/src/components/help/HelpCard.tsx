import { useMemo, useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../../stores/appStore';
import { HELP_CONTENT } from '../../help/helpContent';
import { openManualSection } from '../../help/openManualSection';

// Movable, filterable help card for full-tool modals. The "? HELP" button on
// the Media studio / Cookbook / … modals used to call openManualSection(),
// which opened the whole User Manual *behind* the modal — greyed out and
// unreadable. This replaces that: a draggable panel floating ABOVE the modal
// that lists JUST the snippets whose manualSection matches the tool, with a
// filter box and an "open full manual" escape hatch. Mounted once in App.tsx,
// driven by appStore.activeHelpCard (mirrors the activeHelpPopover pattern).

const CARD_W = 380;

// Above the full-tool modals it floats over (MediaModalHost backdrop 9400,
// CookbookModal backdrop 9500) but below the always-on-top overlays (tooltips
// 9600, drag/notifications 9999, shutdown 10000). The card is also PORTALLED to
// document.body so no App-root stacking context can trap it beneath the modal
// portals — the original z-index:2000-in-the-app-tree was rendering it *behind*
// the modal and getting darkened by the backdrop.
const CARD_Z = 9550;

export function HelpCard() {
  const activeHelpCard = useAppStore((s) => s.activeHelpCard);
  const setActiveHelpCard = useAppStore((s) => s.setActiveHelpCard);

  // Free-drag position. Seeded to the top-right so the card doesn't cover the
  // modal's center; the operator drags it wherever. Null until first open so
  // the seed re-applies each time the card is opened fresh.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [filter, setFilter] = useState('');
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const section = activeHelpCard?.section ?? null;

  // Seed position on open; reset the filter so each open starts clean.
  useEffect(() => {
    if (activeHelpCard) {
      setPos({ x: Math.max(16, window.innerWidth - CARD_W - 32), y: 80 });
      setFilter('');
    }
  }, [activeHelpCard]);

  // Escape closes the card.
  useEffect(() => {
    if (!activeHelpCard) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setActiveHelpCard(null); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [activeHelpCard, setActiveHelpCard]);

  const entries = useMemo(() => {
    if (!section) return [];
    const q = filter.trim().toLowerCase();
    return Object.entries(HELP_CONTENT)
      .filter(([, e]) => e.manualSection === section)
      .filter(([key, e]) => !q || e.title.toLowerCase().includes(q) || key.toLowerCase().includes(q))
      .map(([key, e]) => ({ key, title: e.title, body: e.body }));
  }, [section, filter]);

  if (!activeHelpCard || !pos) return null;

  const onHeaderPointerDown = (e: React.PointerEvent) => {
    // Don't start a drag from the close button / filter input.
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return;
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onHeaderPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const x = Math.min(Math.max(0, e.clientX - dragRef.current.dx), window.innerWidth - CARD_W);
    const y = Math.min(Math.max(0, e.clientY - dragRef.current.dy), window.innerHeight - 60);
    setPos({ x, y });
  };
  const onHeaderPointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
  };

  return createPortal(
    <div
      className="help-system-ui"
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        width: CARD_W,
        maxHeight: '76vh',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--color-bg-panel)',
        border: '1px solid var(--color-accent-primary-dim)',
        borderRadius: '6px',
        boxShadow: '0 12px 40px rgba(0, 0, 0, 0.55)',
        zIndex: CARD_Z,
        fontFamily: 'var(--font-content)',
      }}
    >
      {/* Drag handle / header */}
      <div
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          padding: '9px 10px 9px 12px',
          borderBottom: '1px solid var(--color-border-hairline)',
          cursor: 'move',
          userSelect: 'none',
        }}
      >
        <span className="display-font" style={{ fontSize: '11px', letterSpacing: '1.5px', color: 'var(--color-accent-primary)' }}>
          ⌂ {activeHelpCard.title.toUpperCase()} · HELP
        </span>
        <button
          data-no-drag
          onClick={() => setActiveHelpCard(null)}
          className="display-font"
          title="Close (Esc)"
          style={{
            background: 'transparent',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px',
            color: 'var(--color-accent-primary-dim)',
            cursor: 'pointer',
            fontSize: '11px',
            lineHeight: 1,
            padding: '3px 7px',
          }}
        >
          ✕
        </button>
      </div>

      {/* Filter */}
      <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--color-border-hairline)' }}>
        <input
          data-no-drag
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter help…"
          className="display-font"
          style={{
            width: '100%',
            background: 'var(--color-bg-sunken)',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px',
            color: 'var(--color-fg-default)',
            fontSize: '11px',
            letterSpacing: '0.5px',
            padding: '5px 8px',
            outline: 'none',
          }}
        />
      </div>

      {/* Snippets */}
      <div style={{ overflowY: 'auto', padding: '4px 0' }}>
        {entries.length === 0 ? (
          <div style={{ padding: '14px', fontSize: '12px', color: 'var(--color-fg-muted)' }}>
            No help topics match “{filter}”.
          </div>
        ) : (
          entries.map((e) => (
            <div key={e.key} style={{ padding: '9px 12px', borderBottom: '1px solid var(--color-border-hairline)' }}>
              <div className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: 'var(--color-accent-primary)', marginBottom: '4px' }}>
                {e.title}
              </div>
              <div style={{ fontSize: '12px', lineHeight: 1.5, color: 'var(--color-fg-default)' }}>
                {e.body}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Footer escape hatch — still allow jumping to the full long-form guide. */}
      <div style={{ padding: '8px 12px', borderTop: '1px solid var(--color-border-hairline)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>{entries.length} topic{entries.length === 1 ? '' : 's'}</span>
        <button
          onClick={() => { setActiveHelpCard(null); openManualSection(activeHelpCard.section); }}
          className="display-font"
          style={{
            background: 'transparent',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px',
            color: 'var(--color-accent-secondary)',
            cursor: 'pointer',
            fontSize: '10px',
            letterSpacing: '1px',
            padding: '4px 8px',
          }}
        >
          OPEN FULL MANUAL ↗
        </button>
      </div>
    </div>,
    document.body,
  );
}
