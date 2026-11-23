import { useEffect, useState } from 'react';
import type { ClusterResearchSummary } from '@arco/shared';
import { DialogShell } from '../DialogShell';

interface UnsentFile { letter: string; path: string; bytes: number }

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let n = bytes / 1024, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}

export const touchButton = { minHeight: 44, minWidth: 44, padding: '0 12px' } as const;

// docs/RESEARCH.md - closing a research tab is the one moment of cleanup.
// The researchers' tabs close first (which stops their turns), then the
// server writes one-page logs, moves unsent files on request and removes the
// researchers' folders. `onClosed` then closes the Research Director's tab
// and the cluster. Close stays disabled until the unsent-file list is known;
// a failed list offers RETRY, never a silent close without moving files.
export function ResearchCloseDialog({ clusterId, research, onCloseResearcher, onCancel, onClosed }: {
  clusterId: string;
  research: ClusterResearchSummary;
  onCloseResearcher: (workflowId: string) => void;
  onCancel: () => void;
  onClosed: () => void;
}) {
  const [unsent, setUnsent] = useState<UnsentFile[] | null>(null);
  const [listError, setListError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [move, setMove] = useState(true);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let live = true;
    setUnsent(null); setListError('');
    fetch(`/api/research/${clusterId}/close-preview`)
      .then(async (res) => { if (!res.ok) throw new Error(); return (await res.json()) as { unsent: UnsentFile[] }; })
      .then((body) => { if (live) setUnsent(body.unsent); })
      .catch(() => { if (live) setListError('Files the researchers saved but never sent could not be listed. Nothing has been removed. Try again, or cancel.'); });
    return () => { live = false; };
  }, [clusterId, attempt]);

  async function close() {
    setWorking(true); setError('');
    try {
      for (const r of research.researchers) if (!r.removedAt) onCloseResearcher(r.workflowId);
      const res = await fetch(`/api/research/${clusterId}/close`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ moveUnsent: move && !!unsent?.length }),
      });
      const body = await res.json().catch(() => ({})) as { error?: string; letters?: string[]; message?: string };
      if (!res.ok) {
        throw new Error(body.error === 'director_busy'
          ? 'The Research Director is still working. Stop the turn before closing.'
          : body.error === 'researcher_busy'
          ? `Researcher ${body.letters?.join(', ')} is still stopping. Try again in a moment.`
          : `Cleanup failed${body.message ? `: ${body.message}` : ''}. The project tab stays open; try again.`);
      }
      onClosed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cleanup failed. Try again.');
    } finally { setWorking(false); }
  }

  const shown = unsent?.slice(0, 10) ?? [];
  return (
    <DialogShell
      title="Close research project"
      size="confirm"
      dataHelp="research.close"
      onClose={() => { if (!working) onCancel(); }}
      status={error ? <span role="alert" style={{ color: 'var(--color-error)' }}>{error}</span> : listError ? <span role="alert">{listError}</span> : null}
      actions={<>
        {listError && <button type="button" style={touchButton} disabled={working} onClick={() => setAttempt((n) => n + 1)}>RETRY</button>}
        <button type="button" style={touchButton} disabled={working || !unsent} onClick={() => void close()}>CLOSE RESEARCH PROJECT</button>
        <button type="button" style={touchButton} disabled={working} onClick={onCancel}>CANCEL</button>
      </>}
    >
      <p style={{ marginTop: 0, overflowWrap: 'anywhere' }}><strong>{research.name}</strong></p>
      <p>{research.quick ? "Closing removes the researchers' workspaces and conversations. The Research Director's conversation is kept in Past Chats." : "Closing removes the researchers' workspaces and conversations after writing a one-page log for each into the latest round record. The research folder, the Research Director's conversation and a private record of who wrote each report are kept."}</p>
      {!unsent && !listError && <p>Looking for files the researchers saved but never sent...</p>}
      {unsent && unsent.length > 0 && <div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44 }}>
          <input type="checkbox" style={{ width: 24, height: 24 }} checked={move} onChange={(e) => setMove(e.target.checked)} />
          {research.quick ? 'Attach' : 'Move'} {unsent.length} unsent file{unsent.length === 1 ? '' : 's'} {research.quick ? 'to the saved Chat' : 'into sources/ first'}
        </label>
        <ul style={{ margin: '6px 0 0 16px', padding: 0, overflowWrap: 'anywhere' }}>
          {shown.map((f) => <li key={`${f.letter}/${f.path}`}>Researcher {f.letter}: {f.path} ({formatBytes(f.bytes)})</li>)}
          {unsent.length > shown.length && <li>and {unsent.length - shown.length} more</li>}
        </ul>
      </div>}
    </DialogShell>
  );
}
