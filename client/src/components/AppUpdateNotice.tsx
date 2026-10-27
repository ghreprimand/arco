import { useEffect, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { useAppUpdateStore } from '../stores/appUpdateStore';

export function AppUpdateNotice() {
  const notice = useAppUpdateStore((s) => s.notice);
  const refresh = useAppUpdateStore((s) => s.refresh);
  const settings = useAppStore((s) => s.settings);
  const [saving, setSaving] = useState(false);
  useEffect(() => { void refresh().catch(() => {}); }, [refresh]);
  if (!notice || !settings || settings.updateCheck === false || settings.updateCheckDismissed === notice.latest) return null;
  const dismiss = async () => {
    setSaving(true);
    try {
      const response = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updateCheckDismissed: notice.latest }) });
      if (!response.ok) throw new Error('dismiss failed');
      useAppStore.getState().setSettings(await response.json());
      useAppUpdateStore.getState().clear();
    } catch {
      useAppStore.getState().pushNotification('error', 'Could not save the release dismissal. Try again.');
    } finally { setSaving(false); }
  };
  return <div role="status" data-testid="app-update-notice" style={{ pointerEvents: 'auto', padding: '12px', background: 'var(--color-bg-panel)', border: '1px solid var(--color-accent-primary)', color: 'var(--color-fg)', fontSize: '12px' }}>
    <div>Arco {notice.latest} is available</div>
    <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
      <a href={notice.url} target="_blank" rel="noopener noreferrer">OPEN RELEASE</a>
      <button type="button" disabled={saving} onClick={() => void dismiss()}>DISMISS</button>
    </div>
  </div>;
}
