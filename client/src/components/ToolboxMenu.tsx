import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProviderName, ToolboxEntry, ToolboxResponse } from '@archon/shared';

interface Props {
  onPick: (entry: ToolboxEntry) => void;
  provider: ProviderName;
  transport?: string;
  cwd?: string;
  providerAccountRef?: string;
}

// Compact popover that lists discovered slash commands / skills and lets the
// operator insert a chosen entry into the active workflow's terminal input.
// Keyboard: `/` focuses search if the menu's open, Enter inserts the top hit,
// Esc closes.
export function ToolboxMenu({ onPick, provider, transport, cwd, providerAccountRef }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<ToolboxResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCatalog(null);
    setError(null);
    setQuery('');
  }, [provider, transport, cwd, providerAccountRef]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ provider, ...(cwd ? { cwd } : {}) });
    if (transport) params.set('transport', transport);
    if (providerAccountRef) params.set('account', providerAccountRef);
    setLoading(true);
    setError(null);
    fetch(`/api/toolbox?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as ToolboxResponse & { error?: string };
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        setCatalog(body);
      })
      .catch((err: unknown) => {
        if ((err as { name?: string }).name !== 'AbortError') {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [open, provider, transport, cwd, providerAccountRef]);

  const toolbox = catalog?.entries ?? [];

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    // Focus search on open
    setTimeout(() => searchRef.current?.focus(), 0);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return toolbox;
    return toolbox.filter(
      (e) => e.name.toLowerCase().includes(q)
        || (e.displayName ?? '').toLowerCase().includes(q)
        || e.description.toLowerCase().includes(q),
    );
  }, [toolbox, query]);

  const pick = (entry: ToolboxEntry) => {
    onPick(entry);
    setQuery('');
    setOpen(false);
  };

  const sourceBadge = (source: ToolboxEntry['source']) => {
    const color = source === 'plugin' || source === 'project'
      ? 'var(--color-accent-secondary)'
      : source === 'user'
        ? 'var(--color-accent-primary)'
        : 'var(--color-warning)';
    const label = source === 'builtin' ? 'BUNDLED' : source.toUpperCase();
    return (
      <span style={{ fontSize: '8px', color, border: `1px solid ${color}`, borderRadius: '2px', padding: '1px 4px', letterSpacing: '1px', fontFamily: 'var(--font-display)', opacity: 0.8 }}>
        {label}
      </span>
    );
  };

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        data-help="composer.toolbox"
        title={`Provider-native skills — ${provider === 'codex' ? 'insert a $skill mention' : provider === 'claude' && transport === 'cli' ? 'insert a /skill command' : 'check native skill availability'}. Arco attachments are under +SKILL.`}
        className="display-font"
        style={{
          padding: '3px 10px',
          background: open ? 'var(--color-accent-secondary-a12)' : 'transparent',
          border: `1px solid ${open ? 'var(--color-accent-secondary)' : 'var(--color-border-hairline)'}`,
          borderRadius: '3px',
          color: open ? 'var(--color-accent-secondary)' : 'var(--color-accent-secondary-dim)',
          cursor: 'pointer',
          fontSize: '10px',
          letterSpacing: '1px',
          whiteSpace: 'nowrap',
        }}
      >
        /SKILLS {catalog && toolbox.length > 0 && <span style={{ opacity: 0.6 }}>[{toolbox.length}]</span>}
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            right: 0,
            width: '340px',
            maxHeight: '340px',
            // Frosted token so frosted mode + the opacity slider reach this menu.
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-accent-secondary)',
            borderRadius: '4px',
            boxShadow: '0 0 18px var(--color-accent-secondary-a25)',
            display: 'flex',
            flexDirection: 'column',
            zIndex: 20,
          }}
        >
          <div style={{ padding: '7px 8px 5px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)', fontSize: '9px', letterSpacing: '1px', borderBottom: '1px solid var(--color-border-hairline)' }}>
            {provider === 'codex' ? 'CODEX NATIVE SKILLS · $NAME' : transport === 'cli' ? 'CLAUDE CODE SKILLS · /NAME' : 'NATIVE SKILL AVAILABILITY'}
          </div>
          <div style={{ padding: '8px', borderBottom: '1px solid var(--color-border-hairline)' }}>
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && filtered.length > 0) {
                  e.preventDefault();
                  pick(filtered[0]);
                }
              }}
              placeholder="Search skills..."
              style={{
                width: '100%',
                padding: '5px 8px',
                background: 'var(--color-bg-sunken)',
                border: '1px solid var(--color-border-hairline)',
                borderRadius: '3px',
                color: 'var(--color-accent-primary)',
                fontFamily: 'var(--font-body)',
                fontSize: '12px',
                outline: 'none',
              }}
            />
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loading ? (
              <div style={{ padding: '14px', textAlign: 'center', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)', fontSize: '11px', letterSpacing: '1px' }}>
                DISCOVERING NATIVE SKILLS…
              </div>
            ) : error ? (
              <div style={{ padding: '12px', color: 'var(--color-error)', fontSize: '10px', lineHeight: 1.5 }}>
                SKILL DISCOVERY FAILED<br />{error}
              </div>
            ) : catalog && !catalog.supported ? (
              <div style={{ padding: '12px', color: 'var(--color-fg-muted)', fontSize: '10px', lineHeight: 1.5 }}>
                {catalog.reason}
              </div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: '14px', textAlign: 'center', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)', fontSize: '11px', letterSpacing: '1px' }}>
                {toolbox.length === 0 ? 'NO SKILLS DISCOVERED' : 'NO MATCHES'}
              </div>
            ) : (
              filtered.map((entry) => (
                <button
                  key={`${entry.source}:${entry.name}`}
                  onClick={() => pick(entry)}
                  style={{
                    display: 'block',
                    width: '100%',
                    padding: '8px 10px',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: '1px solid var(--color-accent-secondary-a08)',
                    color: 'var(--color-accent-primary)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: 'var(--font-body)',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-accent-secondary-a06)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px', marginBottom: '3px' }}>
                    <span style={{ fontSize: '12px', color: 'var(--color-accent-secondary)', fontFamily: 'var(--font-display)', letterSpacing: '1px' }}>
                      {entry.invocation}
                    </span>
                    {sourceBadge(entry.source)}
                  </div>
                  {entry.description && (
                    <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', lineHeight: 1.4, whiteSpace: 'normal' }}>
                      {entry.description.length > 160 ? `${entry.description.slice(0, 160)}…` : entry.description}
                    </div>
                  )}
                  {!entry.description && entry.displayName && entry.displayName !== entry.name && (
                    <div style={{ fontSize: '10px', color: 'var(--color-fg-muted)', lineHeight: 1.4, whiteSpace: 'normal' }}>
                      {entry.displayName}
                    </div>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
