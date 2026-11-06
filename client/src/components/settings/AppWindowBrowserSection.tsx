import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { toReport, type Report } from './appWindowBrowserReport';

// Settings > Advanced > App window browser. The list comes from the computer
// that runs Arco (GET /api/app-browsers); the choice is saved globally and read
// by `arco open`, the Arco shortcut and the explorer window.

const OTHER = '__other__';

const label = { fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '8px' } as const;
const note = { fontSize: '11px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.6 } as const;

export function AppWindowBrowserSection() {
  const setSettings = useAppStore((s) => s.setSettings);
  const [report, setReport] = useState<Report | null>(null);
  const [selected, setSelected] = useState('');
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/app-browsers', { cache: 'no-store' });
      if (!res.ok) throw new Error('unavailable');
      const next = toReport(await res.json());
      if (!next) throw new Error('unexpected reply');
      setReport(next);
      const known = next.choice && next.browsers.some((b) => b.id === next.choice);
      setSelected(!next.choice ? '' : known ? next.choice : OTHER);
      setOther(next.choice && !known ? next.choice : '');
      setError('');
    } catch { setError('Browser list unavailable.'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async (value: string) => {
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appWindowBrowser: value }) });
      if (!res.ok) throw new Error('save failed');
      setSettings(await res.json());
      await load();
    } catch { setError('Could not save the browser choice.'); } finally { setBusy(false); }
  };

  const choose = (value: string) => {
    setSelected(value);
    if (value !== OTHER) void save(value);
  };

  return (
    <div data-help="settings.app-window-browser" style={{ marginBottom: '16px' }}>
      <div className="display-font" style={label}>APP WINDOW BROWSER</div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
        <select aria-label="App window browser" value={selected} disabled={busy || !report} onChange={(e) => choose(e.target.value)} style={{ minWidth: '16rem', maxWidth: '100%' }}>
          <option value="">Automatic</option>
          {report?.browsers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          <option value={OTHER}>Another program</option>
        </select>
        {selected === OTHER && <>
          <input
            type="text"
            aria-label="Browser program name or path"
            value={other}
            onChange={(e) => setOther(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && other.trim()) { e.preventDefault(); void save(other); } }}
            placeholder={report?.platform === 'win32' ? 'C:\\Path\\to\\browser.exe' : '/path/to/browser'}
            spellCheck={false}
            style={{ flex: '1 1 16rem', minWidth: 0 }}
          />
          <button type="button" disabled={busy || !other.trim()} onClick={() => void save(other)}>SAVE</button>
        </>}
      </div>
      <div style={{ ...note, marginTop: '8px' }} role="status">
        {report && (report.using
          ? <>Opens in: <strong>{report.using.name}</strong> <span style={{ wordBreak: 'break-all' }}>({report.using.path})</span></>
          : <>No Chromium browser found. <code>arco open</code> opens a normal browser tab.</>)}
        {report?.missing && <div role="alert">The chosen browser &quot;{report.choice}&quot; {report.unsupported ? 'has no app window (not a Chromium-family browser)' : 'was not found'}, so Automatic is used.</div>}
      </div>
      <div style={{ ...note, marginTop: '4px' }}>
        Used by <code>arco open</code>, the Arco shortcut and the explorer window. Automatic uses the first browser in the list. <code>arco open --browser &lt;name-or-path&gt;</code> overrides the choice once.
      </div>
      {error && <div role="alert" style={{ ...note, color: 'var(--color-warning)' }}>{error}</div>}
    </div>
  );
}
