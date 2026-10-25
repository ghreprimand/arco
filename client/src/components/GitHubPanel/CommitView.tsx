import { useEffect, useState } from 'react';
import type { View, GhPullFile } from './types';
import { Loading, ErrorBox, fmtDate } from './shared';
import { GhFilesDiff } from './GhFilesDiff';

// Workbench Expansion I4 — commit detail with file diffs. Reached by clicking a
// row in RepoView's CommitsList. Header metadata rides the view state (carried
// from the list row); the changed files come from the new commit-detail
// endpoint and render through the SAME GhFilesDiff / A3 DiffView path as PR
// files.
export function CommitView({ view, onBack }: { view: Extract<View, { kind: 'commit' }>; onBack: () => void }) {
  const [files, setFiles] = useState<GhPullFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFiles(null);
    setError(null);
    fetch(`/api/github/repos/${view.owner}/${view.name}/commits/${view.sha}`)
      .then((r) => (r.ok ? r.json() : r.json().then((j) => Promise.reject(j.error || r.statusText))))
      .then(setFiles)
      .catch((e) => setError(String(e)));
  }, [view.owner, view.name, view.sha]);

  const [subject, ...rest] = view.message.split('\n');
  const bodyText = rest.join('\n').trim();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }} data-help="github.commit-detail">
      <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--color-border-hairline)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px', flexWrap: 'wrap' }}>
          <button onClick={onBack} style={{ background: 'none', border: '1px solid var(--color-border-hairline)', color: 'var(--color-fg-muted)', cursor: 'pointer', fontFamily: 'var(--font-display)', fontSize: '10px', letterSpacing: '1px', padding: '3px 8px', borderRadius: '3px' }}>← COMMITS</button>
          <span style={{ flex: 1, color: 'var(--color-accent-primary)', fontSize: '15px', fontFamily: 'var(--font-body)' }}>{subject}</span>
          <span style={{ fontSize: '10px', color: 'var(--color-accent-secondary-dim)', fontFamily: 'var(--font-display)', letterSpacing: '1px' }}>{view.sha.slice(0, 7)}</span>
          <a href={view.htmlUrl} target="_blank" rel="noreferrer" style={{ fontSize: '10px', color: 'var(--color-accent-secondary)', fontFamily: 'var(--font-display)', letterSpacing: '1px', textDecoration: 'none', padding: '3px 8px', border: '1px solid var(--color-accent-secondary-dim)', borderRadius: '3px' }}>OPEN ON GH ↗</a>
        </div>
        <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-display)' }}>
          {view.authorName} · {fmtDate(view.date)}
        </div>
        {bodyText && (
          <pre style={{ marginTop: '8px', fontFamily: 'var(--font-body)', fontSize: '11px', color: 'var(--color-accent-primary-dim)', whiteSpace: 'pre-wrap', margin: '8px 0 0' }}>{bodyText}</pre>
        )}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', minHeight: 0 }}>
        {error ? <ErrorBox message={error} /> : files === null ? <Loading /> : <GhFilesDiff files={files} />}
      </div>
    </div>
  );
}
