// Local/file/cloud cluster snapshots. Cloud blobs are encrypted by the local
// server before they leave the workstation; hub-host never receives the key.

import { useEffect, useRef, useState } from 'react';
import {
  useClusterSnapshotsStore,
  requestClusterSnapshotList,
  requestClusterSnapshotRestore,
  requestClusterSnapshotDelete,
  uploadClusterSnapshotToCloud,
} from '../stores/clusterSnapshotsStore';

const DEFAULT_RESTORE_TURNS = 25;

interface Props {
  targetCwd?: string;
  heading?: string;
}

interface CloudSnapshot {
  id: string;
  name: string;
  createdAt: string;
  uploadedAt: string;
  memberCount: number;
  sourceDevice: string;
  sourcePlatform: string;
  bytes: number;
}

export function SavedClustersList({ targetCwd, heading = 'SAVED CLUSTERS' }: Props) {
  const snapshots = useClusterSnapshotsStore((s) => s.snapshots);
  const restoringId = useClusterSnapshotsStore((s) => s.restoringId);
  const storeError = useClusterSnapshotsStore((s) => s.error);
  const [source, setSource] = useState<'local' | 'cloud'>('local');
  const [cloud, setCloud] = useState<CloudSnapshot[]>([]);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [turnsText, setTurnsText] = useState(String(DEFAULT_RESTORE_TURNS));
  const [restoreAll, setRestoreAll] = useState(false);
  const [filter, setFilter] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const openConfirm = (id: string) => {
    setConfirmId(id);
    setTurnsText(String(DEFAULT_RESTORE_TURNS));
    setRestoreAll(false);
  };

  const restoreTurns = () => {
    const parsed = parseInt(turnsText, 10);
    return restoreAll ? undefined : (Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RESTORE_TURNS);
  };

  const refreshCloud = async () => {
    setCloudLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/cluster-snapshots/cloud');
      const body = await response.json() as { snapshots?: CloudSnapshot[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? `cloud list failed (${response.status})`);
      setCloud(body.snapshots ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCloudLoading(false);
    }
  };

  useEffect(() => { requestClusterSnapshotList(); }, []);
  useEffect(() => { if (source === 'cloud') void refreshCloud(); }, [source]);

  const restoreLocal = (id: string) => {
    setConfirmId(null);
    requestClusterSnapshotRestore(id, targetCwd, restoreTurns());
  };

  const restoreCloud = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      const response = await fetch(`/api/cluster-snapshots/cloud/${encodeURIComponent(id)}`, { method: 'POST' });
      const body = await response.json() as { snapshot?: { id: string }; error?: string };
      if (!response.ok || !body.snapshot) throw new Error(body.error ?? 'cloud restore download failed');
      requestClusterSnapshotList();
      setConfirmId(null);
      requestClusterSnapshotRestore(body.snapshot.id, targetCwd, restoreTurns());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const uploadCloud = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      const uploaded = await uploadClusterSnapshotToCloud(id);
      if (uploaded) await refreshCloud();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const importFile = async (file: File) => {
    setBusyId('import');
    setError(null);
    try {
      const response = await fetch('/api/cluster-snapshots/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/vnd.archon.cluster+gzip' },
        body: file,
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'snapshot import failed');
      requestClusterSnapshotList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const copyVaultKey = async () => {
    try {
      const response = await fetch('/api/cluster-snapshots/vault/key');
      const body = await response.json() as { key?: string; error?: string };
      if (!response.ok || !body.key) throw new Error(body.error ?? 'could not read vault key');
      await navigator.clipboard.writeText(body.key);
      setError('Vault key copied. Set this same key on the other computer.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const setVaultKey = async () => {
    const key = window.prompt('Paste the cluster vault key from your other Arco computer:');
    if (!key) return;
    if (!window.confirm('Replace this computer’s cluster vault key? Existing cloud snapshots require the matching key.')) return;
    try {
      const response = await fetch('/api/cluster-snapshots/vault/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'vault key rejected');
      setError('Vault key installed.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteCloud = async (row: CloudSnapshot) => {
    if (!window.confirm(`Delete cloud snapshot "${row.name}"? Local copies and live clusters are unaffected.`)) return;
    setBusyId(row.id);
    try {
      const response = await fetch(`/api/cluster-snapshots/cloud/${encodeURIComponent(row.id)}`, { method: 'DELETE' });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'cloud delete failed');
      await refreshCloud();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const rows = source === 'local' ? snapshots : cloud;
  const needle = filter.trim().toLowerCase();
  const visibleRows = needle ? rows.filter((r) => r.name.toLowerCase().includes(needle)) : rows;
  const compact: React.CSSProperties = { padding: '1px 6px', fontSize: '8px' };
  const displayError = error ?? storeError;
  const pill = (active: boolean): React.CSSProperties => ({
    padding: '3px 8px',
    border: `1px solid ${active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
    background: active ? 'var(--color-accent-primary-a15, transparent)' : 'transparent',
    color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
    fontSize: '9px',
    letterSpacing: '1px',
    cursor: 'pointer',
  });

  return (
    <div data-help="cluster.saved-snapshots">
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '7px', flexWrap: 'wrap' }}>
        <label className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginRight: 'auto' }}>
          {heading}
        </label>
        <button className="display-font" style={pill(source === 'local')} onClick={() => setSource('local')}>LOCAL</button>
        <button className="display-font" style={pill(source === 'cloud')} onClick={() => setSource('cloud')} data-help="cluster.snapshot-cloud">CLOUD</button>
        {source === 'local' && (
          <>
            <button className="display-font" style={pill(false)} onClick={() => fileRef.current?.click()} disabled={busyId === 'import'} data-help="cluster.snapshot-file">
              {busyId === 'import' ? 'IMPORTING…' : 'IMPORT FILE'}
            </button>
            <input ref={fileRef} type="file" accept=".archoncluster,application/vnd.archon.cluster+gzip" hidden onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importFile(file);
            }} />
          </>
        )}
      </div>

      {source === 'cloud' && (
        <div style={{ display: 'flex', gap: '6px', marginBottom: '7px', flexWrap: 'wrap' }}>
          <button className="display-font" style={pill(false)} onClick={() => void copyVaultKey()}>COPY VAULT KEY</button>
          <button className="display-font" style={pill(false)} onClick={() => void setVaultKey()}>SET VAULT KEY</button>
          <span style={{ fontSize: '9px', color: 'var(--color-fg-muted)', alignSelf: 'center' }}>same key required on every computer</span>
        </div>
      )}

      {displayError && (
        <div className="display-font" style={{ fontSize: '10px', color: displayError.includes('installed') || displayError.includes('copied') ? 'var(--color-success)' : 'var(--color-danger)', marginBottom: '6px' }}>
          {displayError}
        </div>
      )}

      {cloudLoading ? (
        <div className="display-font" style={{ fontSize: '10px', color: 'var(--color-fg-muted)' }}>LOADING CLOUD…</div>
      ) : rows.length === 0 ? (
        <div className="display-font" style={{ fontSize: '10px', color: 'var(--color-fg-muted)', letterSpacing: '0.5px', opacity: 0.7 }}>
          {source === 'local'
            ? 'No local snapshots yet. Use SAVE STATE on a live cluster.'
            : 'No cloud snapshots yet. Save a local snapshot to CLOUD first.'}
        </div>
      ) : (
        <>
          {rows.length > 6 && (
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`FILTER ${rows.length} SAVED…`}
              className="display-font"
              style={{ width: '100%', boxSizing: 'border-box', marginBottom: '5px', padding: '3px 7px', fontSize: '9px', letterSpacing: '1px', background: 'var(--color-bg)', border: '1px solid var(--color-border-hairline)', color: 'var(--color-fg)' }}
            />
          )}
        {/* Bounded + scrollable: a long snapshot history used to push the
            rest of the creator off-screen at ~90px per card. */}
        <div style={{ display: 'flex', flexDirection: 'column', maxHeight: '204px', overflowY: 'auto', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', background: 'var(--color-bg)' }}>
          {visibleRows.map((row, i) => {
            const local = source === 'local';
            const created = new Date(row.createdAt);
            const when = created.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(created.getFullYear() !== new Date().getFullYear() ? { year: '2-digit' } : {}) });
            const confirming = confirmId === row.id;
            const busy = busyId === row.id || (local && restoringId === row.id);
            const cloudRow = row as CloudSnapshot;
            return (
              <div key={row.id} style={{ padding: '4px 8px', borderTop: i === 0 ? 'none' : '1px solid var(--color-border-hairline)', fontSize: '11px', background: confirming ? 'var(--color-accent-primary-a15, transparent)' : 'transparent' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: '8px', overflow: 'hidden' }} title={`${row.name} — ${row.memberCount} members · ${created.toLocaleString()}`}>
                    <span style={{ color: 'var(--color-fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1, minWidth: 0 }}>{row.name}</span>
                    <span className="display-font" style={{ fontSize: '9px', color: 'var(--color-fg-muted)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                      {row.memberCount}M · {when}
                      {!local ? ` · ${cloudRow.sourceDevice} · ${(cloudRow.bytes / 1048576).toFixed(1)}MB` : ''}
                    </span>
                  </div>
                  {local && (
                    <>
                      <a className="display-font" href={`/api/cluster-snapshots/${encodeURIComponent(row.id)}/export`} download style={{ ...pill(false), ...compact, textDecoration: 'none' }} data-help="cluster.snapshot-file" title="Download as .archoncluster file">FILE</a>
                      <button className="display-font" style={{ ...pill(false), ...compact }} disabled={busy} onClick={() => void uploadCloud(row.id)} data-help="cluster.snapshot-cloud" title="Upload to cloud vault">
                        {busyId === row.id ? '…' : 'CLOUD'}
                      </button>
                    </>
                  )}
                  <button className="display-font" style={{ ...pill(confirming), ...compact }} disabled={busy} onClick={() => confirming ? setConfirmId(null) : openConfirm(row.id)}>
                    {busy ? '…' : confirming ? 'CANCEL' : 'RESTORE'}
                  </button>
                  <button
                    onClick={() => local
                      ? window.confirm(`Delete saved cluster "${row.name}"?`) && requestClusterSnapshotDelete(row.id)
                      : void deleteCloud(cloudRow)}
                    title={`Delete ${source} snapshot`}
                    style={{ background: 'transparent', border: 'none', color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: '12px', padding: '0 2px' }}
                  >×</button>
                </div>
                {confirming && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingTop: '7px', marginTop: '7px', borderTop: '1px solid var(--color-border-hairline)', flexWrap: 'wrap' }}>
                    <label className="display-font" style={{ fontSize: '9px', color: 'var(--color-fg-muted)' }}>TURNS / WORKER</label>
                    <input type="number" min={1} value={turnsText} disabled={restoreAll} onChange={(e) => setTurnsText(e.target.value)}
                      style={{ width: '56px', padding: '3px 6px', background: 'var(--color-bg)', border: '1px solid var(--color-border-hairline)', color: 'var(--color-fg)' }} />
                    <label className="display-font" style={{ fontSize: '9px', color: 'var(--color-fg-muted)', display: 'flex', gap: '4px' }}>
                      <input type="checkbox" checked={restoreAll} onChange={(e) => setRestoreAll(e.target.checked)} /> ALL
                    </label>
                    <button className="display-font" style={{ ...pill(true), marginLeft: 'auto' }} onClick={() => local ? restoreLocal(row.id) : void restoreCloud(row.id)}>
                      RESTORE
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {visibleRows.length === 0 && (
            <div className="display-font" style={{ padding: '6px 8px', fontSize: '9px', color: 'var(--color-fg-muted)' }}>NO MATCH</div>
          )}
        </div>
        </>
      )}
    </div>
  );
}
