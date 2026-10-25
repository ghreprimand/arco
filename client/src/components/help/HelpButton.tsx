import { useState } from 'react';
import { useAppStore } from '../../stores/appStore';

// Floating help-mode toggle. Two visual states:
//
//   1. Expanded (default) — large "?" circle in the bottom-right corner with
//      a small "×" corner-collapser. Click "?" to enter help mode; click "×"
//      to collapse to the dim chevron tab.
//   2. Collapsed — a small dim chevron-up tab in the very corner. Clicking it
//      restores the expanded "?" button.
//
// While help mode is active we force expanded — the operator needs the "?"
// visible to know how to exit (Esc also works, but the visual affordance
// matters). Collapse state is component-local; doesn't persist.
//
// Pattern lifted from GroundTruth's HelpButton — the operator asked for parity.
export function HelpButton() {
  const helpMode = useAppStore((s) => s.helpMode);
  const setHelpMode = useAppStore((s) => s.setHelpMode);
  const [collapsed, setCollapsed] = useState(false);

  const isCollapsed = collapsed && !helpMode;

  if (isCollapsed) {
    return (
      <button
        className="help-system-ui display-font"
        onClick={() => setCollapsed(false)}
        aria-label="Show help button"
        title="Show help button"
        style={{
          position: 'fixed',
          bottom: '8px',
          right: '8px',
          width: '24px',
          height: '24px',
          borderRadius: '50%',
          border: '1px solid var(--color-border-hairline)',
          background: 'var(--color-bg-panel)',
          color: 'var(--color-fg-muted)',
          cursor: 'pointer',
          zIndex: 9400,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          fontSize: '11px',
          lineHeight: 1,
          opacity: 0.55,
          transition: 'opacity 0.15s, color 0.15s',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.opacity = '1';
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-accent-primary)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.opacity = '0.55';
          (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-fg-muted)';
        }}
      >
        ⌃
      </button>
    );
  }

  return (
    <div
      className="help-system-ui"
      style={{
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        zIndex: 9400,
      }}
    >
      <button
        onClick={() => setHelpMode(!helpMode)}
        data-help="help.toggle"
        className="display-font"
        title={helpMode ? 'Exit help mode (Esc)' : 'Enable contextual help'}
        style={{
          width: '38px',
          height: '38px',
          borderRadius: '50%',
          background: helpMode ? 'var(--color-accent-primary)' : 'var(--color-bg-panel)',
          border: `1px solid ${helpMode ? 'var(--color-accent-primary)' : 'var(--color-accent-primary-dim)'}`,
          color: helpMode ? 'var(--color-bg-panel)' : 'var(--color-accent-primary)',
          cursor: 'pointer',
          fontSize: '18px',
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: helpMode
            ? '0 0 16px var(--color-accent-primary-glow, rgba(74,240,102,0.5))'
            : '0 2px 6px rgba(0,0,0,0.3)',
          transition: 'background-color 0.15s, box-shadow 0.15s, color 0.15s',
          animation: helpMode ? 'arco-help-pulse 2s ease-in-out infinite' : undefined,
          padding: 0,
          lineHeight: 1,
        }}
      >
        ?
      </button>

      {/* Corner collapser — only when help mode is off. Hiding it during help
          mode prevents the operator from accidentally collapsing the only
          visual affordance for "click ? to exit". */}
      {!helpMode && (
        <button
          onClick={() => setCollapsed(true)}
          aria-label="Hide help button"
          title="Collapse help button"
          className="display-font"
          style={{
            position: 'absolute',
            top: '-6px',
            right: '-6px',
            width: '18px',
            height: '18px',
            borderRadius: '50%',
            border: '1px solid var(--color-border-hairline)',
            background: 'var(--color-bg-panel)',
            color: 'var(--color-fg-muted)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            fontSize: '10px',
            lineHeight: 1,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}
