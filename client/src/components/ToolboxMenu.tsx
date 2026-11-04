import { useEffect, useMemo, useState } from 'react';
import type { ProviderName, ToolboxEntry, ToolboxResponse } from '@arco/shared';

interface Props {
  onPick: (entry: ToolboxEntry) => void;
  provider: ProviderName;
  workflowId: string;
  transport?: string;
  cwd?: string;
  providerAccountRef?: string;
}

// Native skills are offered only for runtimes that can execute the inserted
// invocation. Arco-managed skills remain in the parent menu for every agent.
export function ToolboxMenu({ onPick, provider, workflowId, transport, cwd, providerAccountRef }: Props) {
  const supported = provider === 'codex' || provider === 'claude';
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<ToolboxResponse | null>(null);
  const [catalogKey, setCatalogKey] = useState('');
  const runtimeKey = JSON.stringify([workflowId, provider, transport, cwd, providerAccountRef]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCatalog(null); setCatalogKey(''); setError(null); setQuery('');
    if (!supported) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ provider, workflowId, ...(cwd ? { cwd } : {}) });
    if (transport) params.set('transport', transport);
    if (providerAccountRef) params.set('account', providerAccountRef);
    setLoading(true);
    fetch(`/api/toolbox?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as ToolboxResponse & { error?: string };
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        setCatalog(body); setCatalogKey(runtimeKey);
      })
      .catch((err: unknown) => { if ((err as { name?: string }).name !== 'AbortError') setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [supported, provider, workflowId, transport, cwd, providerAccountRef, runtimeKey]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (catalog?.entries ?? []).filter((e) => !q || e.name.toLowerCase().includes(q)
      || (e.displayName ?? '').toLowerCase().includes(q) || e.description.toLowerCase().includes(q));
  }, [catalog, query]);
  if (!supported || catalogKey !== runtimeKey || !catalog?.supported) return null;

  return <section aria-label="Agent skills" style={{ borderTop: '1px solid var(--color-border-hairline)' }}>
    <div className="display-font" style={{ padding: '9px 10px 5px', fontSize: '9px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>
      {catalog.provider === 'codex' ? 'CODEX SKILLS - $NAME' : 'CLAUDE CODE SKILLS - /NAME'}
    </div>
    <div style={{ padding: '4px 10px 8px' }}><input aria-label="Search agent skills" placeholder="Search agent skills" value={query} onChange={(e) => setQuery(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter' && filtered[0]) { e.preventDefault(); onPick(filtered[0]); } }}
      style={{ width: '100%', padding: '5px 8px', background: 'var(--color-bg-sunken)', border: '1px solid var(--color-border-hairline)', color: 'var(--color-accent-primary)' }} /></div>
    {loading ? <div style={{ padding: '8px 10px' }}>Discovering skills...</div>
      : error ? <div style={{ padding: '8px 10px', color: 'var(--color-error)' }}>Skill discovery failed: {error}</div>
      : filtered.length === 0 ? <div style={{ padding: '8px 10px', color: 'var(--color-fg-muted)' }}>{query ? 'No matching skills.' : 'No agent skills found.'}</div>
      : filtered.map((entry) => <button key={`${entry.source}:${entry.name}`} type="button" onClick={() => onPick(entry)}
          style={{ display: 'block', width: '100%', padding: '8px 10px', textAlign: 'left', background: 'transparent', border: 'none', borderTop: '1px solid var(--color-border-hairline)', color: 'var(--color-accent-secondary)', cursor: 'pointer' }}>
          <span>{entry.invocation}</span><span style={{ float: 'right', fontSize: '9px' }}>{entry.source.toUpperCase()}</span>
          {entry.description && <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', whiteSpace: 'normal' }}>{entry.description}</div>}
        </button>)}
  </section>;
}
