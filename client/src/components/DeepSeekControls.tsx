import { useEffect, useState } from 'react';
import { ModalHelpButton } from './help/ModalHelpButton';

interface Snapshot {
  managed: boolean; baseUrl: string;
  profiles: Array<{ id: string; label: string; model: string; serviceState: string; loaded: boolean; capabilities?: { vision?: boolean } }>;
  live: { model?: string; loaded?: boolean; activity?: { in_flight?: number } } | null;
}
export function DeepSeekControls() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<AbortController | null>(null);
  const [action, setAction] = useState('');
  const refresh = async () => {
    try {
      const res = await fetch('/api/deepseek'); const data = await res.json();
      if (!res.ok) throw Error(data.error || 'DeepSeek status unavailable.');
      setSnapshot(data);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 5000); return () => clearInterval(timer); }, []);
  const control = async (action: 'load' | 'unload', profile?: string) => {
    const abort = new AbortController(); setPending(abort); setAction(action === 'load' ? `Loading ${profile}…` : 'Unloading…'); setError('');
    try {
      const res = await fetch('/api/deepseek', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, profile }), signal: abort.signal });
      const data = await res.json(); if (!res.ok) throw Error(data.error || 'DeepSeek operation failed.');
      setSnapshot(data);
    } catch (e) { setError(abort.signal.aborted ? 'Load cancelled; the server is cleaning up or restoring the previous profile. Check status before retrying.' : e instanceof Error ? e.message : String(e)); }
    finally { setPending(null); setAction(''); void refresh(); }
  };
  const button = { padding: '5px 10px', cursor: 'pointer', color: 'var(--color-fg)', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-hairline)', borderRadius: 3 };
  return <div data-help="settings.deepseek" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 14px', border: '1px solid var(--color-border-hairline)', borderRadius: 4 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}><strong>XOLOTL · DEEPSEEK</strong><ModalHelpButton section="deepseek" title="DeepSeek Exact and Light" /></div>
    <div>Endpoint: {snapshot?.baseUrl ?? 'http://127.0.0.1:8150/v1'}</div>
    <div style={{ color: 'var(--color-fg-muted)' }}>{snapshot?.profiles.length ? snapshot.profiles.every((p) => p.capabilities?.vision) ? 'Text + images' : 'Image support depends on the prepared profile' : 'Prepared profiles'} · 262,144 tokens shared by input, history, thinking and output. Medium thinking uses an 8K budget; total output allowance is 16K.</div>
    {snapshot?.profiles.map((p) => <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
      <div><div>{p.label}</div><small>{p.loaded ? 'LOADED' : p.serviceState === 'active' ? 'UNLOADED · service active' : p.serviceState.toUpperCase()} · {p.capabilities?.vision ? 'VISION' : 'TEXT ONLY'} · {p.id === 'exact' ? 'Preserves expert routing' : 'Biases 0.25 / 0.15 change expert selection'}</small></div>
      <button style={button} disabled={!!pending || p.loaded} onClick={() => void control('load', p.id)}>LOAD {p.id.toUpperCase()}</button>
    </div>)}
    {snapshot && !snapshot.managed && <div>No prepared registry matches this endpoint. See the DeepSeek help and docs/DEEPSEEK.md.</div>}
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <button style={button} disabled={!!pending || !snapshot?.profiles.some((p) => p.serviceState === 'active')} onClick={() => void control('unload')}>UNLOAD · STOP SERVICE</button>
      <button style={button} onClick={() => void refresh()}>REFRESH</button>
      {pending && action.startsWith('Loading') && <button style={button} onClick={() => pending.abort()}>CANCEL LOAD</button>}
      {action && <span role="status">{action}</span>}
    </div>
    <small>Only one profile can run. Loading uses the guarded launcher and refuses mining or competing loaded models. Arco never stops your miner. FREE VRAM also stops DeepSeek.</small>
    {error && <div role="alert" style={{ color: 'var(--color-danger)' }}>{error}</div>}
  </div>;
}
