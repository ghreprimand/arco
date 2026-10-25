import { useEffect, useState } from 'react';
import type { GhRepo } from './types';
import { Loading, ErrorBox, fmtDate, inputStyle, selectChip, repoRowStyle, badgeStyle } from './shared';

export function ReposView({ onOpen }: { onOpen: (owner: string, name: string) => void }) {
  const [repos, setRepos] = useState<GhRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [type, setType] = useState<'owner' | 'all' | 'member' | 'public' | 'private'>('owner');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const q = new URLSearchParams();
    if (search.trim()) q.set('search', search.trim());
    q.set('type', type);
    fetch(`/api/github/repos?${q.toString()}`)
      .then((r) => r.ok ? r.json() : r.json().then((j) => Promise.reject(j.error || r.statusText)))
      .then((d) => setRepos(d))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [search, type]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--color-border-hairline)', display: 'flex', gap: '10px', alignItems: 'center', flexShrink: 0 }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search your repos..."
          style={{ ...inputStyle, flex: 1 }}
        />
        <div style={{ display: 'flex', gap: '4px' }}>
          {(['owner', 'all', 'member', 'public', 'private'] as const).map((t) => (
            <button key={t} onClick={() => setType(t)} style={selectChip(type === t)}>{t.toUpperCase()}</button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px' }}>
        {loading && <Loading />}
        {error && <ErrorBox message={error} />}
        {repos && repos.length === 0 && !loading && (
          <div style={{ padding: '30px', textAlign: 'center', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)' }}>
            No repos match.
          </div>
        )}
        {repos?.map((r) => (
          <button
            key={r.id}
            onClick={() => onOpen(r.owner.login, r.name)}
            style={repoRowStyle}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
              <img src={r.owner.avatar_url} alt={r.owner.login} style={{ width: '20px', height: '20px', borderRadius: '3px' }} />
              <span style={{ color: 'var(--color-accent-secondary)', fontFamily: 'var(--font-display)', fontSize: '12px', letterSpacing: '1px' }}>{r.full_name}</span>
              {r.private && <span style={badgeStyle('amber')}>PRIVATE</span>}
              {r.fork && <span style={badgeStyle('dim')}>FORK</span>}
              {r.archived && <span style={badgeStyle('red')}>ARCHIVED</span>}
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>★ {r.stargazers_count}</span>
              <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>⚑ {r.open_issues_count}</span>
              {r.language && <span style={{ fontSize: '10px', color: 'var(--color-accent-primary-dim)' }}>{r.language}</span>}
            </div>
            {r.description && (
              <div style={{ fontSize: '12px', color: 'var(--color-accent-primary-dim)', lineHeight: 1.4 }}>{r.description}</div>
            )}
            <div style={{ marginTop: '4px', fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)' }}>
              Updated {fmtDate(r.updated_at)} · default: {r.default_branch}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
