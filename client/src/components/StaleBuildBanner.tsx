import { useBuildStore } from '../buildCheck';

// Shown when buildCheck.ts finds the served bundle differs from the one this
// tab runs. One click reloads; the button has a label so Computer can click
// it by voice ("reload the page").
export function StaleBuildBanner() {
  const stale = useBuildStore((s) => s.stale);
  if (!stale) return null;
  return (
    <div
      role="alert"
      className="display-font"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '14px',
        padding: '5px 12px', background: 'var(--color-warning)', color: '#111',
        fontSize: '10px', letterSpacing: '1.5px', flexShrink: 0,
      }}
    >
      ARCO WAS REBUILT — THIS TAB IS RUNNING AN OLDER BUILD
      <button
        type="button"
        aria-label="Reload Arco"
        onClick={() => window.location.reload()}
        className="display-font"
        style={{ padding: '3px 10px', background: '#111', color: 'var(--color-warning)', border: 'none', cursor: 'pointer', fontSize: '10px', letterSpacing: '1.5px' }}
      >
        RELOAD
      </button>
    </div>
  );
}
