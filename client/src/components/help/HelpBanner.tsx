import { useAppStore } from '../../stores/appStore';

// Top banner shown while help mode is active. Tells the operator what's
// going on and how to exit. Sits above the regular header — body.help-mode
// adds 30px top padding to compensate.
export function HelpBanner() {
  const helpMode = useAppStore((s) => s.helpMode);
  const setHelpMode = useAppStore((s) => s.setHelpMode);

  if (!helpMode) return null;

  return (
    <div
      className="help-system-ui display-font"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: '30px',
        background: 'var(--color-accent-primary)',
        color: 'var(--color-bg-panel)',
        zIndex: 9450,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '12px',
        fontSize: '11px',
        letterSpacing: '2px',
        padding: '0 12px',
        boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
      }}
    >
      <span>HELP MODE — click any highlighted element for details</span>
      <button
        onClick={() => setHelpMode(false)}
        className="display-font"
        style={{
          background: 'transparent',
          border: '1px solid var(--color-bg-panel)',
          borderRadius: '3px',
          color: 'var(--color-bg-panel)',
          cursor: 'pointer',
          fontSize: '10px',
          letterSpacing: '1.5px',
          padding: '2px 8px',
        }}
      >
        EXIT (ESC)
      </button>
    </div>
  );
}
