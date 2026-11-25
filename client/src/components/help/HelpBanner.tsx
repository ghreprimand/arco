import { useAppStore } from '../../stores/appStore';
import { usePhoneLayout } from '../../layout/layoutRange';

// Top banner shown while help mode is active. Tells the operator what's
// going on and how to exit. Sits above the regular header — body.help-mode
// adds 30px top padding to compensate.
export function HelpBanner() {
  const helpMode = useAppStore((s) => s.helpMode);
  const setHelpMode = useAppStore((s) => s.setHelpMode);
  // Mobile view: a taller bar with a 44 px EXIT (body.help-mode.help-phone
  // pads for it via .help-banner-phone), and touch wording.
  const phone = usePhoneLayout();

  if (!helpMode) return null;

  return (
    <div
      className={`help-system-ui display-font${phone ? ' help-banner-phone' : ''}`}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: phone ? '48px' : '30px',
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
      <span>{phone ? 'HELP: TAP A CONTROL' : 'HELP MODE: click any highlighted element for details'}</span>
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
          padding: phone ? '0 14px' : '2px 8px',
          minHeight: phone ? '44px' : undefined,
        }}
      >
        {phone ? 'EXIT' : 'EXIT (ESC)'}
      </button>
    </div>
  );
}
