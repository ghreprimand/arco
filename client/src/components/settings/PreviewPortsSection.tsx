import { useEffect, useState } from 'react';
import { useAppStore } from '../../stores/appStore';

const label = { fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', fontFamily: 'var(--font-body)' } as const;
const note = { fontSize: '11px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.6, marginTop: '8px' } as const;

export function PreviewPortsSection() {
  const settings = useAppStore(s => s.settings);
  const setSettings = useAppStore(s => s.setSettings);
  const [range, setRange] = useState(settings?.previewPorts ?? '4300-4309');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setRange(settings?.previewPorts ?? '4300-4309'), [settings?.previewPorts]);
  const save = async () => {
    setBusy(true); setNotice('');
    try {
      const response = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ previewPorts: range.trim() }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Could not save PREVIEW PORTS.');
      setSettings(result); setNotice('Saved for new previews.');
    } catch (error) { setNotice((error as Error).message); } finally { setBusy(false); }
  };
  return <div data-help="settings.preview-ports" style={{ marginBottom: '16px' }}>
    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
      <label className="arco-field-label" style={label}>PREVIEW PORTS <input className="arco-field" aria-label="PREVIEW PORTS" disabled={busy} value={range} onChange={e => setRange(e.target.value)} placeholder="4300-4309" /></label>
      <button type="button" disabled={busy} onClick={() => void save()}>SAVE</button>
    </div>
    <p className="arco-field-help" style={note}>Remote access: allow this TCP range through the firewall and forward it with Arco. Each open preview uses one port. ARCO_PREVIEW_PORTS overrides this setting. Changes affect new previews.</p>
    {notice && <p role="status" className="arco-field-help" style={note}>{notice}</p>}
  </div>;
}
