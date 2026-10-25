import { useEffect, useState } from 'react';
import type { AuthStatusByProvider } from '@arco/shared';
import { useAppStore } from '../../stores/appStore';

export function ZaiApiKeySection() {
  const setAuthStatus = useAppStore((s) => s.setAuthStatus);
  const authStatus = useAppStore((s) => s.authStatus);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [status, setStatus] = useState<{ configured: boolean; source: 'env' | 'file' | 'command' | 'env-ref' | 'none' } | null>(null);

  const refreshKeyStatus = async () => {
    const res = await fetch('/api/zai-key');
    if (!res.ok) return;
    setStatus(await res.json() as { configured: boolean; source: 'env' | 'file' | 'command' | 'env-ref' | 'none' });
  };

  useEffect(() => { void refreshKeyStatus(); }, [authStatus?.zai?.loggedIn]);

  const refreshAuth = async () => {
    const authRes = await fetch('/api/auth-status');
    if (authRes.ok) setAuthStatus(await authRes.json() as AuthStatusByProvider);
  };

  const save = async () => {
    const cleaned = apiKey.trim();
    if (!cleaned) {
      setMessage('Paste a Z.ai API key first.');
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/zai-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: cleaned }),
      });
      const data = await res.json().catch(() => ({})) as { configured?: boolean; source?: 'env' | 'file' | 'command' | 'env-ref' | 'none'; error?: string };
      if (!res.ok || data.error) throw new Error(data.error || res.statusText);
      setApiKey('');
      setStatus({ configured: data.configured === true, source: data.source ?? 'file' });
      setMessage('Saved. Z.ai will use the Coding Plan endpoint.');
      await refreshAuth();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    setClearing(true);
    setMessage(null);
    try {
      const res = await fetch('/api/zai-key', { method: 'DELETE' });
      const data = await res.json().catch(() => ({})) as { configured?: boolean; source?: 'env' | 'file' | 'command' | 'env-ref' | 'none'; error?: string };
      if (!res.ok || data.error) throw new Error(data.error || res.statusText);
      setStatus({ configured: data.configured === true, source: data.source ?? 'none' });
      setMessage(data.source === 'env' ? 'File key cleared; env key is still active.' : 'Z.ai key cleared.');
      await refreshAuth();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setClearing(false);
    }
  };

  const configured = status?.configured ?? authStatus?.zai?.loggedIn === true;
  const source = status?.source ?? (authStatus?.zai?.loggedIn ? 'file' : 'none');
  const envManaged = source === 'env';

  return (
    <div data-help="settings.zai-api-key" style={{ padding: '10px 14px', border: '1px solid var(--color-border-hairline)', borderRadius: '4px', background: 'var(--color-bg-sunken)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' }}>
        <div className="display-font" style={{ fontSize: '10px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)' }}>
          Z.AI API KEY
        </div>
        <div className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: configured ? 'var(--color-accent-primary)' : 'var(--color-warning)' }}>
          {configured ? `CONFIGURED - ${source.toUpperCase()}` : 'NOT CONFIGURED'}
        </div>
      </div>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          aria-label="Z.ai API key or reference"
          type="password"
          autoComplete="off"
          placeholder={envManaged ? 'ZAI_API_KEY is set in the service environment' : 'Paste Z.ai API key'}
          disabled={envManaged}
          style={{
            flex: '1 1 260px',
            minWidth: 0,
            padding: '7px 10px',
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px',
            color: 'var(--color-fg)',
            fontSize: '11px',
            fontFamily: 'var(--font-code)',
          }}
        />
        <button
          onClick={save}
          disabled={saving || envManaged}
          className="display-font"
          style={{
            padding: '6px 12px',
            background: saving || envManaged ? 'transparent' : 'var(--color-accent-primary-a10)',
            border: '1px solid var(--color-accent-primary)',
            borderRadius: '3px',
            color: saving || envManaged ? 'var(--color-fg-muted)' : 'var(--color-accent-primary)',
            cursor: saving || envManaged ? 'default' : 'pointer',
            fontSize: '10px',
            letterSpacing: '1px',
          }}
        >
          {saving ? 'SAVING...' : 'SAVE'}
        </button>
        <button
          onClick={clear}
          disabled={clearing || (!configured && source !== 'file')}
          className="display-font"
          style={{
            padding: '6px 12px',
            background: 'transparent',
            border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px',
            color: 'var(--color-fg-muted)',
            cursor: clearing ? 'default' : 'pointer',
            fontSize: '10px',
            letterSpacing: '1px',
          }}
        >
          {clearing ? 'CLEARING...' : 'CLEAR'}
        </button>
      </div>
      <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)', lineHeight: 1.45 }}>
        Stored server-side only. Arco always uses the Z.ai Coding Plan endpoint, not the general paid API endpoint.
      </div>
      {message && (
        <div style={{ fontSize: '10px', color: message.toLowerCase().includes('saved') ? 'var(--color-accent-primary)' : 'var(--color-warning)', fontFamily: 'var(--font-body)' }}>
          {message}
        </div>
      )}
    </div>
  );
}
