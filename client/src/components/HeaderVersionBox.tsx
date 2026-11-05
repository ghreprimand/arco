import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { useAppUpdateStore } from '../stores/appUpdateStore';
import { useStartupStore } from '../stores/startupStore';
import { UpdateAction } from './UpdateAction';
import { headerActionStyle } from './headerActionStyle';
import { useKeepInWindow } from '../layout/keepInWindow';

const RELEASES = 'https://github.com/ghreprimand/arco/releases';
const plain = (value: string) => `v${value.replace(/^v/, '')}`;

/** Always-present version status in the top bar. DISMISS on the large notice never hides it. */
export function HeaderVersionBox() {
  const status = useAppUpdateStore((s) => s.status);
  const notice = useAppUpdateStore((s) => s.notice);
  const updating = useAppUpdateStore((s) => s.updating);
  const refresh = useAppUpdateStore((s) => s.refresh);
  const settings = useAppStore((s) => s.settings);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const root = useRef<HTMLSpanElement>(null);
  const placeRef = useKeepInWindow();
  useEffect(() => { void refresh().catch(() => {}); }, [refresh]);
  useEffect(() => { if (notice?.latest) void refresh().catch(() => {}); }, [notice?.latest, refresh]);
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  const checks = status ? status.enabled && settings?.updateCheck !== false : settings?.updateCheck !== false;
  const current = status?.current ? plain(status.current) : '';
  const latest = checks ? (notice?.latest ?? (status?.updateAvailable ? status.latest : null)) : null;
  const url = notice?.url ?? status?.url ?? null;
  const available = Boolean(latest);
  const checked = status?.checkedAt ? new Date(status.checkedAt).toLocaleString() : 'not yet';
  const label = updating ? 'UPDATING' : available ? `\u2191 ${plain(latest as string)}` : current || 'version';
  const tip = updating ? 'Updating Arco. It will reconnect after the restart.'
    : available ? `Update available: ${plain(latest as string)}. Click to update.`
    : !checks ? 'Release checks are off. Showing the running version only.'
    : `Up to date (${current || 'version unknown'}). Last checked: ${checked}.`;
  const aria = updating ? 'Arco is updating' : available ? `Arco update available: ${plain(latest as string)}. Open update.` : `Arco version ${current || 'unknown'}. ${!checks ? 'Release checks are off.' : 'Up to date.'} Open version details.`;
  const check = async () => {
    setBusy(true); setError('');
    try { await refresh(true); } catch { setError('Release check unavailable'); } finally { setBusy(false); }
  };
  const versions = () => { setOpen(false); useStartupStore.getState().setSettingsSection('cli-versions'); useAppStore.getState().setShowSettings(true); };
  return <span ref={root} data-help="header.version" style={{ position: 'relative', display: 'inline-flex' }}>
    <button
      type="button"
      className="display-font"
      data-testid="header-version-box"
      data-state={updating ? 'updating' : available ? 'available' : !checks ? 'off' : 'current'}
      title={tip}
      aria-label={aria}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
      style={{
        ...headerActionStyle,
        fontSize: '10px',
        padding: '3px 8px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        whiteSpace: 'nowrap',
        color: available || updating ? 'var(--color-accent-primary)' : 'var(--color-fg-muted, var(--color-accent-primary-dim))',
        background: available || updating ? 'var(--color-accent-primary-a10)' : 'transparent',
        border: `1px solid ${available || updating ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
        opacity: available || updating ? 1 : 0.8,
      }}
    >
      {label}
      {available && !updating && <span aria-hidden="true" data-testid="header-version-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--color-accent-primary)', display: 'inline-block' }} />}
    </button>
    {(open || updating) && <div
      role="dialog"
      aria-label={available ? 'Arco update' : 'Arco version'}
      data-testid="header-version-popover"
      ref={placeRef}
      style={{ display: open ? 'block' : 'none', position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 9000, minWidth: 260, padding: 12, fontSize: 12, lineHeight: 1.6, background: 'var(--color-bg-panel)', border: '1px solid var(--color-border)', color: 'var(--color-fg)' }}
    >
      {available ? <>
        <div>Arco {plain(latest as string)} is available{current ? ` (running ${current})` : ''}.</div>
        <UpdateAction latest={latest} url={url} autoConfirm />
        {url && <div><a href={url} target="_blank" rel="noopener noreferrer">Release notes</a></div>}
      </> : <>
        <div>Running: {current || 'unknown'}</div>
        <div>{checks ? `Latest known release: ${status?.latest ? plain(status.latest) : 'none yet'}` : 'Release checks are off.'}</div>
        {checks && <div>Last checked: {checked}</div>}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 6 }}>
          <button type="button" disabled={busy || !checks} onClick={() => void check()}>CHECK NOW</button>
          <a href={status?.url ?? RELEASES} target="_blank" rel="noopener noreferrer">Release notes</a>
        </div>
        {error && <div role="alert">{error}</div>}
      </>}
      <div style={{ marginTop: 6 }}><button type="button" onClick={versions}>CLI and runtime versions in Settings</button></div>
    </div>}
  </span>;
}
