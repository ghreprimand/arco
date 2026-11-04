import { useEffect, useState } from 'react';
import type { GhBranch } from './types';
import { Loading, ErrorBox, EmptyBox, rowStyle, badgeStyle } from './shared';

export function BranchesList({ owner, name, defaultBranch, onPick }: { owner: string; name: string; defaultBranch: string; onPick: (branch: string) => void }) {
  const [branches, setBranches] = useState<GhBranch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch(`/api/github/repos/${owner}/${name}/branches`)
      .then((r) => r.ok ? r.json() : r.json().then((j) => Promise.reject(j.error || r.statusText)))
      .then(setBranches)
      .catch((e) => setError(String(e)));
  }, [owner, name]);
  if (error) return <ErrorBox message={error} />;
  if (branches === null) return <Loading />;
  if (branches.length === 0) return <EmptyBox label="No branches." />;
  return (
    <div>
      {branches.map((b) => (
        <button key={b.name} onClick={() => onPick(b.name)} style={rowStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ color: 'var(--color-accent-secondary)', fontFamily: 'var(--font-display)', fontSize: '12px', letterSpacing: '1px' }}>
              {b.name === defaultBranch ? '★ ' : '  '}{b.name}
            </span>
            {b.protected && <span style={badgeStyle('amber')}>PROTECTED</span>}
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)' }}>
              {b.commit.sha.slice(0, 7)}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}
