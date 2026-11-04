import type { View } from './types';

export function Breadcrumbs({ view, onNavigate }: { view: View; onNavigate: (v: View) => void }) {
  const crumbs: Array<{ label: string; onClick?: () => void }> = [{ label: 'REPOS', onClick: () => onNavigate({ kind: 'repos' }) }];
  if (view.kind === 'repo' || view.kind === 'pull' || view.kind === 'issue' || view.kind === 'run' || view.kind === 'commit') {
    crumbs.push({ label: `${view.owner}/${view.name}`, onClick: () => onNavigate({ kind: 'repo', owner: view.owner, name: view.name }) });
  }
  if (view.kind === 'pull') crumbs.push({ label: `PR #${view.number}` });
  if (view.kind === 'issue') crumbs.push({ label: `ISSUE #${view.number}` });
  if (view.kind === 'run') crumbs.push({ label: `RUN #${view.id}` });
  if (view.kind === 'commit') crumbs.push({ label: view.sha.slice(0, 7) });
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontFamily: 'var(--font-display)', fontSize: '11px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>
      {crumbs.map((c, i) => (
        <span key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {i > 0 && <span style={{ opacity: 0.5 }}>/</span>}
          {c.onClick ? (
            <button onClick={c.onClick} style={{ background: 'none', border: 'none', color: 'var(--color-accent-primary-dim)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit', letterSpacing: 'inherit', padding: 0 }}>{c.label}</button>
          ) : (
            <span style={{ color: 'var(--color-accent-primary)' }}>{c.label}</span>
          )}
        </span>
      ))}
    </div>
  );
}
