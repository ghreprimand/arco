import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { phosphorEmission } from './emission';

function knownNonChromiumBrowser(userAgent: string): boolean {
  const ua = userAgent.trim();
  // Browser branding does not identify the engine reliably on iOS.
  if (!ua || /iPad|iPhone|iPod/i.test(ua)) return false;
  if (/Chromium|Chrome|CriOS|Edg|OPR|SamsungBrowser/i.test(ua)) return false;
  return /Firefox\//i.test(ua) || /Version\/[^ ]+ Safari\//i.test(ua);
}

export function PhosphorControls() {
  const effects = useAppStore(s => s.settings?.phosphorEffects ?? true);
  const softness = useAppStore(s => s.settings?.phosphorSoftness ?? 50);
  const crisp = useAppStore(s => s.settings?.crispText ?? false);
  const showBrowserHint = effects && typeof navigator !== 'undefined' && knownNonChromiumBrowser(navigator.userAgent);
  const save = useAppStore(s => s.setPhosphorPreference);
  const [draft, setDraft] = useState(softness);
  const committed = useRef(softness);
  useEffect(() => { setDraft(softness); committed.current = softness; }, [softness]);
  const commit = () => {
    if (committed.current === draft) return;
    committed.current = draft;
    void save('phosphorSoftness', draft);
  };
  return <section aria-label="Phosphor effects" style={{ fontSize: '11px', color: 'var(--color-fg-muted)' }}>
    <label data-help="settings.phosphor-effects" style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
      <input type="checkbox" checked={effects} onChange={e => { void save('phosphorEffects', e.target.checked); }} /> PHOSPHOR EFFECTS
    </label>
    {showBrowserHint && <p role="note" data-browser-effects-note style={{ fontSize: '10px', lineHeight: 1.5, margin: '0 0 8px' }}>In some browsers, Phosphor effects may use more GPU power. If GPU use is high, turn effects off or try a Chromium-based browser to compare.</p>}
    <label data-help="settings.phosphor-softness" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
      GLOW SOFTNESS
      <input aria-label="Glow softness" type="range" min="0" max="100" step="5" value={draft} disabled={!effects || crisp}
        style={{ flex: 1, minWidth: '100px', accentColor: 'var(--color-accent-primary)' }}
        onChange={e => { const v = Number(e.target.value); setDraft(v); document.documentElement.style.setProperty('--phosphor-text', phosphorEmission(v)); }}
        onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
      <output>{draft}%</output>
    </label>
    <p style={{ fontSize: '10px', lineHeight: 1.5, margin: '8px 0 0' }}>0: no glow · 50: sharper default · 100: reference look. Crisp text overrides glow; effects off removes decoration. Font and text/background brightness remain independent. Reduced motion keeps static glow and glass.</p>
  </section>;
}
