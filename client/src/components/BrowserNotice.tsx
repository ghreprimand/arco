import { useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { useStartupStore } from '../stores/startupStore';
import { BROWSER_NOTICE_KEY, isChromiumBrowser } from '../utils/browserFamily';

const dismissedHere = () => { try { return localStorage.getItem(BROWSER_NOTICE_KEY) === '1'; } catch { return false; } };

// One-time notice in a non-Chromium browser (Firefox, Safari). DISMISS is
// remembered by this browser; CHOOSE BROWSER opens Settings > Advanced > App
// window browser.
export function BrowserNotice() {
  const [hidden, setHidden] = useState(() => isChromiumBrowser(typeof navigator === 'undefined' ? undefined : navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string }> } }) || dismissedHere());
  if (hidden) return null;
  const dismiss = () => { try { localStorage.setItem(BROWSER_NOTICE_KEY, '1'); } catch { /* still hide for this page */ } setHidden(true); };
  const choose = () => { useStartupStore.getState().setSettingsSection('app-window-browser'); useAppStore.getState().setShowSettings(true); };
  const button = { padding: '3px 10px', fontSize: '10px', letterSpacing: '1.5px', cursor: 'pointer' } as const;
  return (
    <div
      role="status"
      data-help="browser-notice"
      data-browser-notice
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: '6px 12px',
        padding: '5px 12px', background: 'var(--color-bg-sunken)', borderBottom: '1px solid var(--color-border-hairline)',
        color: 'var(--color-fg)', fontSize: '12px', flexShrink: 0,
      }}
    >
      <span>
        Arco runs lighter in Chrome, Edge, Brave, Vivaldi or Chromium. Install one, then open Arco with the Arco shortcut or <code>arco open</code>.
      </span>
      <button type="button" className="display-font" data-help="browser-notice" onClick={choose} style={button}>CHOOSE BROWSER</button>
      <button type="button" className="display-font" data-help="browser-notice" onClick={dismiss} style={button}>DISMISS</button>
    </div>
  );
}
