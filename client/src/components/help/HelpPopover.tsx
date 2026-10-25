import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { HELP_CONTENT } from '../../help/helpContent';
import { openManualSection } from '../../help/openManualSection';

// Popover surfaced when the operator clicks a [data-help] target while help
// mode is active. Position is computed against the captured anchorRect so the
// popover doesn't drift if the underlying element moves between click and
// render.
export function HelpPopover() {
  const activeHelpPopover = useAppStore((s) => s.activeHelpPopover);
  const setActiveHelpPopover = useAppStore((s) => s.setActiveHelpPopover);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!popoverRef.current || !activeHelpPopover) return;
    const anchor = activeHelpPopover.anchorRect;
    const pw = popoverRef.current.offsetWidth;
    const ph = popoverRef.current.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 8;

    // Try below the anchor; flip above if it overflows; clamp to top
    // viewport edge as last resort. Horizontal: center on the anchor, then
    // clamp to viewport edges with a small margin.
    let top = anchor.bottom + gap;
    if (top + ph > vh - 20) top = anchor.top - ph - gap;
    if (top < 40) top = 40;

    let left = anchor.left + anchor.width / 2 - pw / 2;
    if (left < 10) left = 10;
    if (left + pw > vw - 10) left = vw - pw - 10;

    setPosition({ top, left });
  }, [activeHelpPopover]);

  // Close when the underlying anchor moves out of viewport (e.g. operator
  // scrolls a list while popover is up). Cheap re-clamp on resize.
  useEffect(() => {
    if (!activeHelpPopover) return;
    const close = () => setActiveHelpPopover(null);
    window.addEventListener('resize', close);
    return () => window.removeEventListener('resize', close);
  }, [activeHelpPopover, setActiveHelpPopover]);

  if (!activeHelpPopover) return null;

  const entry = HELP_CONTENT[activeHelpPopover.key];
  const fallback = !entry;

  return (
    <div
      ref={popoverRef}
      className="help-system-ui"
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        zIndex: 9460,
        maxWidth: '420px',
        minWidth: '280px',
        background: 'var(--color-bg-panel)',
        border: '1px solid var(--color-accent-primary)',
        borderRadius: '4px',
        boxShadow:
          '0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px var(--color-accent-primary-a10, rgba(74,240,102,0.1))',
        animation: 'archon-help-pop-in 0.15s ease-out',
        fontFamily: 'var(--font-body)',
        fontSize: '12px',
        lineHeight: 1.55,
        color: 'var(--color-fg)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: '1px solid var(--color-border-hairline)',
          background: 'var(--color-accent-primary-a05)',
        }}
      >
        <span
          className="display-font"
          style={{
            fontSize: '11px',
            letterSpacing: '2px',
            color: 'var(--color-accent-primary)',
          }}
        >
          {fallback ? 'NO HELP CONTENT' : entry.title.toUpperCase()}
        </span>
        <button
          onClick={() => setActiveHelpPopover(null)}
          className="display-font"
          style={{
            background: 'transparent',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px',
            color: 'var(--color-fg-muted)',
            cursor: 'pointer',
            fontSize: '10px',
            letterSpacing: '1px',
            padding: '2px 6px',
            lineHeight: 1,
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ padding: '10px 12px' }}>
        {fallback ? (
          <p style={{ margin: 0 }}>
            No contextual help written for this element yet (key:{' '}
            <code
              style={{
                fontFamily: 'var(--font-code, monospace)',
                fontSize: '11px',
                color: 'var(--color-accent-primary-dim)',
              }}
            >
              {activeHelpPopover.key}
            </code>
            ).
          </p>
        ) : (
          entry.body
        )}
      </div>
      {entry?.manualSection && (
        <div
          style={{
            padding: '6px 12px 8px',
            borderTop: '1px solid var(--color-border-hairline)',
            textAlign: 'right',
          }}
        >
          <button
            onClick={() => {
              setActiveHelpPopover(null);
              // §J3 — open+jump lives in openManualSection (shared with the
              // in-modal <ModalHelpButton>); no inline dispatch here anymore.
              openManualSection(entry.manualSection!);
            }}
            className="display-font"
            style={{
              background: 'transparent',
              border: '1px solid var(--color-accent-primary)',
              borderRadius: '3px',
              color: 'var(--color-accent-primary)',
              cursor: 'pointer',
              fontSize: '10px',
              letterSpacing: '1.5px',
              padding: '3px 8px',
            }}
          >
            READ MORE IN MANUAL →
          </button>
        </div>
      )}
    </div>
  );
}
