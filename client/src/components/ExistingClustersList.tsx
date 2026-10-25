// Durable cluster recovery. Snapshots fork; this surface simply reopens the
// original cluster id that still exists under ~/.archon/clusters but isn't
// open as a tab anywhere (the open set is server-authoritative — see
// server/src/workspace.ts). Collapsed by default: it used to render every
// cluster dir ever created at ~75px a row, smoke-test leftovers included.
// Clusters whose project folder is gone can't be reopened usefully, so they
// sort last, dim, and get a bulk CLEAN UP.

import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../stores/appStore';

interface ExistingCluster {
  clusterId: string;
  name?: string;
  cwd: string;
  memberCount: number;
  createdAt: string;
  open?: boolean;
  cwdExists?: boolean;
}

interface Props {
  onReopen: (clusterId: string) => void;
}

const EXPANDED_KEY = 'archon.closedClustersExpanded';

const btn = (color: string): React.CSSProperties => ({
  padding: '1px 7px',
  border: `1px solid ${color}`,
  background: 'transparent',
  color,
  fontSize: '8px',
  letterSpacing: '1px',
  cursor: 'pointer',
  flexShrink: 0,
});

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function ExistingClustersList({ onReopen }: Props) {
  const openClusters = useAppStore((s) => s.clusters);
  const [rows, setRows] = useState<ExistingCluster[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(() => {
    try { return localStorage.getItem(EXPANDED_KEY) === '1'; } catch { return false; }
  });

  const refresh = useCallback(() => {
    let cancelled = false;
    void fetch('/api/clusters')
      .then(async (response) => {
        const body = await response.json() as { clusters?: ExistingCluster[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? 'cluster list failed');
        if (!cancelled) setRows(body.clusters ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => refresh(), [refresh]);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    try { localStorage.setItem(EXPANDED_KEY, next ? '1' : '0'); } catch { /* per-viewer convenience only */ }
  };

  const remove = async (ids: string[]) => {
    setBusy(true);
    setError(null);
    try {
      for (const id of ids) {
        const res = await fetch(`/api/clusters/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `delete failed (${res.status})`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const closed = rows
    .filter((row) => !row.open && !openClusters[row.clusterId])
    .sort((a, b) => Number(b.cwdExists !== false) - Number(a.cwdExists !== false));
  const missing = closed.filter((row) => row.cwdExists === false);
  if (closed.length === 0 && !error) return null;

  const label = (row: ExistingCluster) => row.name?.trim() || `${row.clusterId.slice(0, 8)} CLUSTER`;

  return (
    <div data-help="cluster.existing-live" style={{ marginTop: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: expanded ? '6px' : 0 }}>
        <button
          type="button"
          onClick={toggle}
          className="display-font"
          style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)' }}
          aria-expanded={expanded}
        >
          {expanded ? '▾' : '▸'} CLOSED CLUSTERS · {closed.length}
        </button>
        {missing.length > 0 && (
          <span className="display-font" style={{ fontSize: '9px', color: 'var(--color-fg-muted)', letterSpacing: '1px' }}>
            {missing.length} WITH MISSING FOLDER
          </span>
        )}
        {missing.length > 0 && (
          <button
            type="button"
            className="display-font"
            disabled={busy}
            style={{ ...btn('var(--color-fg-muted)'), marginLeft: 'auto' }}
            title={`Permanently delete ${missing.length} cluster record(s) whose project folder no longer exists`}
            onClick={() => {
              if (window.confirm(`Delete ${missing.length} cluster record(s) whose folder no longer exists?\n\n${missing.map((m) => `${label(m)} — ${m.cwd}`).join('\n')}`)) {
                void remove(missing.map((m) => m.clusterId));
              }
            }}
          >
            {busy ? 'CLEANING…' : `CLEAN UP ${missing.length}`}
          </button>
        )}
      </div>
      {error && (
        <div style={{ color: 'var(--color-danger)', fontSize: '10px', margin: '4px 0' }}>{error}</div>
      )}
      {expanded && (
        <div style={{ maxHeight: '204px', overflowY: 'auto', border: '1px solid var(--color-border-hairline)', borderRadius: '3px' }}>
          {closed.map((row, i) => {
            const gone = row.cwdExists === false;
            return (
              <div
                key={row.clusterId}
                title={`${label(row)}\n${row.memberCount} members · ${row.cwd}\ncreated ${new Date(row.createdAt).toLocaleString()}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '4px 8px',
                  borderTop: i === 0 ? 'none' : '1px solid var(--color-border-hairline)',
                  opacity: gone ? 0.55 : 1,
                  fontSize: '11px',
                }}
              >
                <span style={{ color: 'var(--color-fg-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flexShrink: 1 }}>
                  {label(row)}
                </span>
                <span className="display-font" style={{ fontSize: '9px', color: 'var(--color-fg-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, minWidth: 0 }}>
                  {row.memberCount}M · {gone ? 'FOLDER GONE' : basename(row.cwd)} · {new Date(row.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </span>
                {!gone && (
                  <button type="button" className="display-font" style={btn('var(--color-accent-primary)')} onClick={() => onReopen(row.clusterId)}>
                    REOPEN
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  title="Delete this cluster record (member transcripts are kept)"
                  onClick={() => {
                    if (window.confirm(`Delete cluster "${label(row)}"? Its member workflows' transcripts stay on disk.`)) void remove([row.clusterId]);
                  }}
                  style={{ background: 'transparent', border: 'none', color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: '12px', padding: '0 2px', flexShrink: 0 }}
                >×</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
