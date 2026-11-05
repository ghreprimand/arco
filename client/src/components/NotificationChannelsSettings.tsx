import { useEffect, useState } from 'react';
import { ATTENTION_KINDS, isValidNtfyTopic, normalizeNtfyServer, type AttentionKind, type NotificationChannels } from '@arco/shared';
import { useNotificationChannelsStore } from '../stores/notificationChannelsStore';
import { runDesktopTest, type DesktopTestOutcome, type NotificationApi } from '../alerts/desktopTest';

// Settings > Notifications: which events raise a desktop notification (this
// computer) and phone messages. BELL visibility is controlled in the top bar.

const LABEL: Record<AttentionKind, { name: string; hint: string }> = {
  finished: { name: 'A turn finished', hint: 'After a turn that ran at least 15 seconds. In a cluster, only the director by default.' },
  failed: { name: 'A turn failed', hint: 'A provider error or refusal.' },
  waiting: { name: 'Waiting for you', hint: 'A question or an approval is open.' },
};

function randomTopic(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `arco-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function NotificationChannelsSettings() {
  const view = useNotificationChannelsStore((s) => s.view);
  const error = useNotificationChannelsStore((s) => s.error);
  const load = useNotificationChannelsStore((s) => s.load);
  const save = useNotificationChannelsStore((s) => s.save);
  const [server, setServer] = useState('');
  const [topic, setTopic] = useState('');
  const [token, setToken] = useState('');
  const [note, setNote] = useState('');
  const [testing, setTesting] = useState(false);
  const [desktopTest, setDesktopTest] = useState<DesktopTestOutcome | null>(null);
  const [desktopTesting, setDesktopTesting] = useState(false);
  const [permission, setPermission] = useState<string>(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const update = () => setPermission(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
    window.addEventListener('focus', update); document.addEventListener('visibilitychange', update);
    return () => { window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, []);
  useEffect(() => { if (view) { setServer(view.ntfy.server); setTopic(view.ntfy.topic); } }, [view?.ntfy.server, view?.ntfy.topic]);

  if (!view) return <p>{error || 'Loading notification settings...'}</p>;

  const base = (): Omit<NotificationChannels, 'ntfy'> & { ntfy: { server: string; topic: string; token?: string | null } } => ({
    desktop: view.desktop, phone: view.phone, phoneText: view.phoneText, clusterFinished: view.clusterFinished,
    ntfy: { server: view.ntfy.server, topic: view.ntfy.topic },
  });

  const toggleDesktop = async (kind: AttentionKind, on: boolean) => {
    if (on && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      setPermission(await Notification.requestPermission());
    }
    await save({ ...base(), desktop: { ...view.desktop, [kind]: on } });
  };
  const testDesktop = async () => {
    setDesktopTesting(true); setDesktopTest(null);
    try {
      const api = typeof Notification === 'undefined' ? undefined : Notification as unknown as NotificationApi;
      setDesktopTest(await runDesktopTest(api));
    } finally {
      setPermission(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
      setDesktopTesting(false);
    }
  };
  const togglePhone = (kind: AttentionKind, on: boolean) => save({ ...base(), phone: { ...view.phone, [kind]: on } });

  const addressProblem = (): string => {
    if (!normalizeNtfyServer(server)) return 'Enter the server address, for example https://ntfy.sh.';
    if (!isValidNtfyTopic(topic.trim())) return 'The topic uses letters, digits, - and _ (up to 64). GENERATE makes one.';
    return '';
  };
  const saveAddress = async (clearToken = false) => {
    const problem = addressProblem();
    if (problem) { setNote(problem); return; }
    const ok = await save({ ...base(), ntfy: { server: server.trim(), topic: topic.trim(), ...(clearToken ? { token: null } : token ? { token } : {}) } });
    setToken('');
    setNote(ok ? (clearToken ? 'Saved. The access token was removed.' : 'Saved.') : 'Could not save.');
  };
  const test = async () => {
    const problem = addressProblem();
    if (problem) { setNote(problem); return; }
    setTesting(true); setNote('Sending a test message...');
    try {
      const r = await fetch('/api/notification-channels/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ntfy: { server: server.trim(), topic: topic.trim(), ...(token ? { token } : {}) } }) });
      const body = (await r.json()) as { ok?: boolean; error?: string };
      setNote(body.ok ? 'Sent. Check your phone; if nothing arrives, subscribe to the topic in the ntfy app.' : `The test failed: ${body.error ?? 'unknown error'}`);
    } catch { setNote('The test could not be sent.'); }
    finally { setTesting(false); }
  };

  const cell: React.CSSProperties = { padding: '4px 10px', textAlign: 'center' };
  return (
    <div data-help="settings.notification-channels" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <span className="display-font" style={{ fontSize: 11, letterSpacing: 2, color: 'var(--color-accent-primary-dim)' }}>NOTIFICATIONS</span>
      <p style={{ margin: 0 }}>Choose which events notify you and where. Desktop and phone alerts are off until you tick them. Desktop notifications appear only while Arco is not the window you are looking at; one is shown per event, and clicking it opens that tab.</p>
      <p style={{ margin: 0 }}>Browser permission: {permission === 'default' ? 'not asked' : permission}.</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="display-font" disabled={permission === 'unsupported' || permission === 'granted' || permission === 'denied'} onClick={async () => setPermission(await Notification.requestPermission())}>REQUEST PERMISSION</button>
        <button type="button" className="display-font" disabled={desktopTesting} onClick={() => void testDesktop()}>TEST DESKTOP</button>
        <span data-testid="desktop-test-result" data-result={desktopTest?.result ?? ''} style={{ alignSelf: 'center', color: desktopTest?.result === 'sent' ? 'var(--color-success)' : 'var(--color-warning)' }}>{desktopTesting ? 'Testing...' : desktopTest?.label ?? ''}</span>
      </div>
      <p style={{ margin: 0 }}>Normal desktop alerts need browser permission and an unfocused Arco window. Finished turns must run at least 15 seconds.</p>
      <div aria-live="polite">{desktopTest?.detail ?? ''}</div>
      <p style={{ margin: 0 }}>Use SHOW IN BELL in the top bar to choose which in-app notices appear.</p>
      <table style={{ borderCollapse: 'collapse' }}>
        <thead><tr><th style={{ textAlign: 'left', padding: '4px 10px' }}>Event</th><th style={cell}>This computer</th><th style={cell}>Phone</th></tr></thead>
        <tbody>
          {ATTENTION_KINDS.map((kind) => (
            <tr key={kind}>
              <td style={{ padding: '4px 10px' }} title={LABEL[kind].hint}>{LABEL[kind].name}<div style={{ fontSize: 10, color: 'var(--color-fg-muted)' }}>{LABEL[kind].hint}</div></td>
              <td style={cell}><input type="checkbox" aria-label={`${LABEL[kind].name}: this computer`} checked={view.desktop[kind]} onChange={(e) => void toggleDesktop(kind, e.target.checked)} /></td>
              <td style={cell}><input type="checkbox" aria-label={`${LABEL[kind].name}: phone`} checked={view.phone[kind]} onChange={(e) => void togglePhone(kind, e.target.checked)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {permission === 'unsupported' && <p style={{ margin: 0, color: 'var(--color-fg-muted)' }}>This browser does not support desktop notifications.</p>}
      {permission === 'denied' && <p style={{ margin: 0, color: 'var(--color-warning)' }}>This browser is blocking notifications from Arco. Allow them in the browser's site settings.</p>}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        In a cluster, "a turn finished" comes from
        <select className="arco-field" aria-label="Cluster finished source" value={view.clusterFinished} onChange={(e) => void save({ ...base(), clusterFinished: e.target.value === 'all' ? 'all' : 'director' })}>
          <option value="director">the director only</option>
          <option value="all">every member</option>
        </select>
      </label>

      <span className="display-font" style={{ fontSize: 11, letterSpacing: 2, color: 'var(--color-accent-primary-dim)', marginTop: 6 }}>PHONE (NTFY)</span>
      <p style={{ margin: 0 }}>Phone messages go through an ntfy server and need no hub. Install the ntfy app, subscribe to your topic, then TEST. Anyone who knows the topic can read what is sent to it, so keep it private, or use an access token with a protected topic.{view.ntfyFromEnvironment ? ' An address from ARCO_NTFY_URL is in use until you save one here.' : ''}</p>
      <label>Server <input className="arco-field" aria-label="ntfy server" value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://ntfy.sh" style={{ width: 280 }} /></label>
      <label>Topic <input className="arco-field" aria-label="ntfy topic" value={topic} onChange={(e) => setTopic(e.target.value)} style={{ width: 280 }} />
        <button type="button" className="display-font" onClick={() => setTopic(randomTopic())}>GENERATE</button></label>
      <label>Access token (optional) <input className="arco-field" type="password" aria-label="ntfy access token" value={token} onChange={(e) => setToken(e.target.value)} placeholder={view.ntfy.tokenSet ? 'A token is saved; type to replace it' : ''} autoComplete="off" style={{ width: 280 }} />
        {view.ntfy.tokenSet && <button type="button" className="display-font" onClick={() => void saveAddress(true)}>REMOVE TOKEN</button>}</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="display-font" onClick={() => void saveAddress()}>SAVE ADDRESS</button>
        <button type="button" className="display-font" disabled={testing} onClick={() => void test()}>TEST</button>
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={view.phoneText} onChange={(e) => void save({ ...base(), phoneText: e.target.checked })} />
        Include message text (the question, the error, or the start of the reply). Off: phone messages carry only the tab name and what happened.
      </label>
      <div role="status" style={{ minHeight: 16 }}>{note || error}</div>
    </div>
  );
}
