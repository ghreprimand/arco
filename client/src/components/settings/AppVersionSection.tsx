import { useEffect, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { useAppUpdateStore } from '../../stores/appUpdateStore';

export function AppVersionSection() {
  const status = useAppUpdateStore((s) => s.status);
  const refresh = useAppUpdateStore((s) => s.refresh);
  const settings = useAppStore((s) => s.settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { void refresh().catch(() => setError('Release check unavailable')); }, [refresh]);
  const check = async () => {
    setBusy(true); setError('');
    try { await refresh(true); } catch { setError('Release check unavailable'); } finally { setBusy(false); }
  };
  const toggle = async (enabled: boolean) => {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updateCheck: enabled }) });
      if (!response.ok) throw new Error('save failed');
      useAppStore.getState().setSettings(await response.json());
      await refresh();
    } catch { setError('Could not save release-check preference'); } finally { setBusy(false); }
  };
  return <div data-help="settings.app-updates" style={{ fontSize: '12px', lineHeight: 1.7, marginBottom: '16px' }}>
    <strong>Arco</strong>: {status ? `v${status.current.replace(/^v/, '')}` : 'version unavailable'}
    <div>{status?.latest ? `Latest release: ${status.latest}${status.publishedAt ? ` (${status.publishedAt.slice(0, 10)})` : ''}` : 'No release information yet'}</div>
    <button type="button" disabled={busy || !status?.enabled} onClick={() => void check()}>CHECK NOW</button>
    <label style={{ display: 'block' }}><input type="checkbox" checked={settings?.updateCheck !== false} disabled={busy || !settings} onChange={(e) => void toggle(e.target.checked)} /> Check for new releases</label>
    {status?.enabled === false && settings?.updateCheck !== false && <div>Release checks are disabled by ARCO_UPDATE_CHECK=0.</div>}
    <a href="https://github.com/ghreprimand/arco/blob/main/docs/OPERATIONS.md#updating-arco" target="_blank" rel="noopener noreferrer">Updating Arco</a>
    {error && <div role="alert">{error}</div>}
  </div>;
}
