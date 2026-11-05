import { useEffect, useState } from 'react';
import { KeepButton, UnkeepButton } from '../components/KeepButton';
import { formatRelativeTime } from '../components/RightPanel/format';

// STORAGE lens (docs/STORAGE_PLAN.md, P7.5) - where the disk space goes, for
// every project Arco knows about plus Arco's own folder, largest first. Reads
// the bounded, read-only storage report; every action (COMPRESS OLD LOGS,
// ARCHIVE, RESTORE, DELETE, EMPTY SCRATCH) is an operator click with a
// confirmation and goes through /api/storage/*. Worktrees and caches are
// shown but have no clean-up action. Plans are never touched.

type Buckets = Partial<Record<string, number>>;
interface Biggest { path: string; bytes: number }
interface ProjectRow {
  path: string; kind: 'project' | 'chat'; stateBytes: number; buckets: Buckets; biggest: Biggest | null;
  conversations: number; openConversations: number; archives: Archive[]; errors: number;
}
interface Overview {
  measuredAt: number; totalBytes: number;
  home: { stateBytes: number; buckets: Buckets; biggest: Biggest | null };
  projects: ProjectRow[];
  budget: { enabled: boolean; limitBytes: number; over: boolean };
}
interface Archive { workflowId: string; bytes: number; archivedAt: number }
interface Conversation {
  id: string; name?: string; open: boolean; busy?: boolean; lastActive: number;
  eventBytes: number; artifactBytes: number; handoffBytes: number; checkpointBytes: number; scratchBytes?: number; otherBytes?: number;
  keep?: { readable: boolean; whole: boolean; items: number };
}
interface ProjectReport { measuredAt: number; workflows: Conversation[]; archives?: Archive[] }
interface Policy { autoArchiveClosedDays: number | null; budgetGiB: number; budgetNotice: boolean }

// One label per server bucket (same as MEMORY > USAGE > MEASURE STORAGE).
const LABELS: Record<string, string> = {
  events: 'Conversation logs', artifacts: 'Artifacts', handoffs: 'Handoffs', checkpoints: 'Checkpoints',
  scratch: 'Scratch files', conversationFiles: 'Other conversation files', plans: 'Plans', boards: 'Task boards',
  worktrees: 'Worktrees and isolated copies', savedClusters: 'Saved clusters', voiceAndModels: 'Voice and media models',
  caches: 'Caches and browser profiles', providerData: 'Provider account data', logs: 'Server logs',
  archives: 'Archived conversations', other: 'Other',
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB']; let value = n / 1024; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(1)} ${units[unit]}`;
}
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

async function post(action: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch(`/api/storage/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, confirm: true }) });
  const data = await r.json().catch(() => ({})) as Record<string, unknown>;
  if (!r.ok) throw new Error(typeof data.message === 'string' ? data.message : `Request failed (${r.status})`);
  return data;
}

export function StorageLens({ focusTick }: { focusTick: number }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  async function measure(refresh: boolean) {
    setLoading(true); setError('');
    try {
      const r = await fetch(`/api/storage-report?scope=all${refresh ? '&refresh=1' : ''}`);
      if (!r.ok) throw new Error('The storage report could not be read.');
      setOverview(await r.json() as Overview);
      setStale(false);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }
  // The first measurement can take a while on large folders; it is only
  // started from here or by the daily run, never in the background of the lens.
  useEffect(() => { void measure(false); }, []);
  void focusTick;

  const rows: Array<{ key: string; label: string; path?: string; kind: 'home' | 'project' | 'chat'; bytes: number; buckets: Buckets; biggest: Biggest | null; row?: ProjectRow }> = overview
    ? [
        { key: '\0home', label: "Arco's folder", kind: 'home' as const, bytes: overview.home.stateBytes, buckets: overview.home.buckets, biggest: overview.home.biggest },
        ...overview.projects.map((p) => ({ key: p.path, label: p.kind === 'chat' ? `Chat ${baseName(p.path).slice(0, 8)}` : baseName(p.path), path: p.path, kind: p.kind, bytes: p.stateBytes, buckets: p.buckets, biggest: p.biggest, row: p })),
      ].sort((a, b) => b.bytes - a.bytes)
    : [];

  const done = (message: string) => { setNotice(message); setStale(true); };

  return (
    <div data-help="storage.lens" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <strong className="display-font" style={{ letterSpacing: '2px' }}>STORAGE</strong>
        <button className="display-font" data-help="storage.measure" disabled={loading} onClick={() => void measure(true)} style={btn}>{loading ? 'MEASURING...' : 'MEASURE AGAIN'}</button>
        {overview && <span style={muted}>Total {formatBytes(overview.totalBytes)}, measured {formatRelativeTime(overview.measuredAt)}.{stale ? ' Sizes changed since; MEASURE AGAIN updates them.' : ''}</span>}
      </div>
      <p style={muted}>Read-only sizes. Nothing is changed or deleted without your click. Plans are never touched.</p>
      {error && <div role="alert" style={alert}>{error}</div>}
      {notice && <div role="status" style={{ ...muted, color: 'var(--color-accent-primary)' }}>{notice}</div>}
      {overview?.budget.over && (
        <div role="alert" data-help="storage.budget-notice" style={alert}>
          Arco's storage ({formatBytes(overview.totalBytes)}) is over the disk budget of {formatBytes(overview.budget.limitBytes)}. Archive or delete closed conversations below, or raise the budget.
        </div>
      )}
      <PolicyControls />
      {!overview && loading && <p style={muted}>Measuring every project; large folders take a while.</p>}
      <div>
        {rows.map((r) => {
          const open = expanded === r.key;
          const expandable = r.kind === 'project';
          return (
            <section key={r.key} style={{ borderTop: '1px solid var(--color-border-hairline)', padding: '8px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                {expandable ? (
                  <button className="display-font" data-help="storage.project" aria-expanded={open} title={r.path} onClick={() => setExpanded(open ? null : r.key)} style={chip(open)}>
                    {open ? '▾' : '▸'} {r.label} - {formatBytes(r.bytes)}
                  </button>
                ) : r.kind === 'home' ? (
                  <span className="display-font" data-help="storage.home" style={{ ...chip(false), cursor: 'default' }}>{r.label} - {formatBytes(r.bytes)}</span>
                ) : (
                  <span className="display-font" data-help="storage.project" title={r.path} style={{ ...chip(false), cursor: 'default' }}>{r.label} - {formatBytes(r.bytes)}</span>
                )}
                {r.row && <span style={muted}>{r.row.conversations} conversations{r.row.openConversations ? `, ${r.row.openConversations} open` : ''}{r.row.archives.length ? `, ${r.row.archives.length} archived` : ''}</span>}
                {r.kind === 'project' && r.path && <CompressButton path={r.path} onDone={done} onError={setError} />}
              </div>
              <ul style={{ ...muted, margin: '4px 0 0 18px', padding: 0 }}>
                {Object.entries(r.buckets).filter(([, b]) => (b ?? 0) > 0).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)).map(([name, b]) => (
                  <li key={name}>{LABELS[name] ?? name}: {formatBytes(b ?? 0)}</li>
                ))}
                {r.biggest && <li>Biggest item: {baseName(r.biggest.path)} ({formatBytes(r.biggest.bytes)})</li>}
              </ul>
              {open && r.path && <Conversations path={r.path} onDone={done} onError={setError} />}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function CompressButton({ path, onDone, onError }: { path: string; onDone: (m: string) => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  return <button className="display-font" data-help="storage.compress-logs" aria-label={`COMPRESS OLD LOGS in ${baseName(path)}`} disabled={busy} style={btn} onClick={async () => {
    if (!window.confirm(`Compress the logs of closed conversations in ${baseName(path)}? Nothing is deleted; open conversations are skipped.`)) return;
    setBusy(true);
    try {
      const r = await post('compress-logs', { path }) as { sealed?: number; skippedOpen?: string[]; deferred?: number; beforeBytes?: number; afterBytes?: number };
      onDone(`Compressed ${r.sealed ?? 0} logs in ${baseName(path)}: ${formatBytes(r.beforeBytes ?? 0)} to ${formatBytes(r.afterBytes ?? 0)}${r.skippedOpen?.length ? `; ${r.skippedOpen.length} open conversations skipped` : ''}${r.deferred ? `; ${r.deferred} logs were in use by another program and finish on the next COMPRESS OLD LOGS` : ''}.`);
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }}>{busy ? 'COMPRESSING...' : 'COMPRESS OLD LOGS'}</button>;
}

function Conversations({ path, onDone, onError }: { path: string; onDone: (m: string) => void; onError: (m: string) => void }) {
  const [report, setReport] = useState<ProjectReport | null>(null);
  const [busy, setBusy] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/storage-report?path=${encodeURIComponent(path)}${tick ? '&refresh=1' : ''}`)
      .then((r) => { if (!r.ok) throw new Error('This project could not be measured.'); return r.json() as Promise<ProjectReport>; })
      .then((d) => { if (!cancelled) setReport(d); })
      .catch((e) => { if (!cancelled) onError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [path, tick]);
  async function act(action: string, id: string, question: string, done: (r: Record<string, unknown>) => string) {
    if (!window.confirm(question)) return;
    setBusy(`${action}:${id}`);
    try { onDone(done(await post(action, { path, workflowId: id }))); setTick((t) => t + 1); }
    catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  }
  if (!report) return <p style={muted}>Reading conversations...</p>;
  const size = (c: Conversation) => c.eventBytes + c.artifactBytes + c.handoffBytes + c.checkpointBytes + (c.scratchBytes ?? 0) + (c.otherBytes ?? 0);
  const live = report.workflows.filter((c) => size(c) > 0);
  return (
    <div style={{ margin: '6px 0 4px 18px' }}>
      {live.length === 0 && !(report.archives ?? []).length && <p style={muted}>No conversations.</p>}
      {live.map((c) => {
        const title = c.name || c.id.slice(0, 8);
        const working = c.open || c.busy;
        const keepText = !c.keep ? '' : !c.keep.readable ? 'KEEP list unreadable' : c.keep.whole ? 'Kept' : c.keep.items ? `${c.keep.items} kept ${c.keep.items === 1 ? 'item' : 'items'}` : '';
        return (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '3px 0' }}>
            <span style={{ minWidth: '180px' }} title={c.id}>{title}</span>
            <span style={muted}>{formatBytes(size(c))} - {working ? 'Open' : 'Closed'}{c.lastActive ? ` - ${formatRelativeTime(c.lastActive)}` : ''}</span>
            {keepText && <span data-help="storage.keep" style={{ ...muted, color: 'var(--color-accent-primary)' }}>{keepText}</span>}
            <KeepButton cwd={path} workflowId={c.id} itemPath="." help="storage.keep" className="display-font" style={btn}
              disabled={!!busy || !c.keep?.readable || c.keep.whole}
              confirmMessage={`Keep all of "${title}"? Archive and delete will leave it in place.`}
              onError={onError} onKept={() => { onDone(`Kept "${title}".`); setTick((t) => t + 1); }} />
            {c.keep?.readable && (c.keep.whole || c.keep.items > 0) && (
              <UnkeepButton cwd={path} workflowId={c.id} all className="display-font" style={btn} label={`UNKEEP ${title}`}
                disabled={!!busy}
                confirmMessage={`Stop keeping "${title}"? This removes ${c.keep.items === 1 ? 'its KEEP mark' : `all ${c.keep.items} KEEP marks`}${c.keep.whole ? ', including the one on the whole conversation' : ''}. Archive, delete, EMPTY SCRATCH and size warnings will include those items again. No file is changed.`}
                onError={onError} onDone={() => { onDone(`"${title}" is no longer kept.`); setTick((t) => t + 1); }} />
            )}
            <button className="display-font" data-help="storage.archive" aria-label={`ARCHIVE ${title}`} style={btn} disabled={!!busy || working || c.keep?.whole}
              title={working ? 'Close the conversation first' : c.keep?.whole ? 'The whole conversation is kept' : undefined}
              onClick={() => void act('archive', c.id, `Archive "${title}"? Its files are packed into one compressed file and can be restored. Kept items stay in place.`,
                (r) => `Archived "${title}": ${formatBytes(Number(r.originalBytes) || 0)} into ${formatBytes(Number(r.archiveBytes) || 0)}.`)}>ARCHIVE</button>
            <button className="display-font" data-help="storage.delete" aria-label={`DELETE ${title}`} style={btn} disabled={!!busy || working || c.keep?.whole}
              title={working ? 'Close the conversation first' : c.keep?.whole ? 'The whole conversation is kept' : undefined}
              onClick={() => void act('delete', c.id, `Delete "${title}" permanently? Its log, artifacts, checkpoints and search entry are removed. Kept items stay. This cannot be undone.`,
                (r) => `Deleted "${title}" (${formatBytes(Number(r.removedBytes) || 0)}).`)}>DELETE</button>
            {(c.scratchBytes ?? 0) > 0 && <button className="display-font" data-help="storage.empty-scratch" aria-label={`EMPTY SCRATCH of ${title}`} style={btn} disabled={!!busy || !!c.busy}
              onClick={() => void act('empty-scratch', c.id, `Empty the scratch folder of "${title}" (${formatBytes(c.scratchBytes ?? 0)})? Kept items stay.`,
                (r) => `Emptied scratch of "${title}" (${formatBytes(Number(r.removedBytes) || 0)}).`)}>EMPTY SCRATCH</button>}
          </div>
        );
      })}
      {(report.archives ?? []).map((a) => (
        <div key={`a:${a.workflowId}`} style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '3px 0' }}>
          <span style={{ minWidth: '180px' }} title={a.workflowId}>{a.workflowId.slice(0, 8)}</span>
          <span style={muted}>Archived {formatRelativeTime(a.archivedAt)} - {formatBytes(a.bytes)}</span>
          <button className="display-font" data-help="storage.restore" aria-label={`RESTORE ${a.workflowId.slice(0, 8)}`} style={btn} disabled={!!busy}
            onClick={() => void act('restore', a.workflowId, 'Restore this archived conversation? Nothing that already exists is overwritten.',
              (r) => `Restored ${Number(r.files) || 0} files.`)}>RESTORE</button>
          <button className="display-font" data-help="storage.delete" aria-label={`DELETE archive ${a.workflowId.slice(0, 8)}`} style={btn} disabled={!!busy}
            onClick={() => void act('delete', a.workflowId, 'Delete this archived conversation permanently? The archive and its search entry are removed. This cannot be undone.',
              (r) => `Deleted the archive (${formatBytes(Number(r.removedBytes) || 0)}).`)}>DELETE</button>
        </div>
      ))}
    </div>
  );
}

function PolicyControls() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [days, setDays] = useState('30');
  const [budget, setBudget] = useState('100');
  const [error, setError] = useState('');
  useEffect(() => {
    fetch('/api/storage/policy').then((r) => r.json() as Promise<Policy>).then((p) => {
      setPolicy(p); setBudget(String(p.budgetGiB)); if (p.autoArchiveClosedDays) setDays(String(p.autoArchiveClosedDays));
    }).catch(() => setError('The storage settings could not be read.'));
  }, []);
  async function save(patch: Partial<Policy>) {
    try {
      const r = await fetch('/api/storage/policy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const next = await r.json() as Policy; setPolicy(next); setBudget(String(next.budgetGiB)); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  if (!policy) return error ? <div role="alert" style={alert}>{error}</div> : null;
  const on = policy.autoArchiveClosedDays !== null;
  return (
    <details style={{ margin: '6px 0 10px' }}>
      <summary className="display-font" style={{ cursor: 'pointer', letterSpacing: '1px' }}>STORAGE SETTINGS</summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '6px 0 0 12px' }}>
        <label data-help="storage.auto-archive" style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <input type="checkbox" checked={on} onChange={(e) => void save({ autoArchiveClosedDays: e.target.checked ? Math.max(1, Number(days) || 30) : null })} />
          Archive conversations closed for more than
          <input type="number" min={1} max={3650} value={days} aria-label="Days closed before archiving" style={{ width: '64px' }}
            onChange={(e) => setDays(e.target.value)} onBlur={() => { if (on) void save({ autoArchiveClosedDays: Math.max(1, Number(days) || 30) }); }} />
          days (off by default; never deletes)
        </label>
        <label data-help="storage.budget" style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <input type="checkbox" checked={policy.budgetNotice} onChange={(e) => void save({ budgetNotice: e.target.checked })} />
          Show a notice when Arco's storage passes
          <input type="number" min={1} value={budget} aria-label="Disk budget in GiB" style={{ width: '72px' }}
            onChange={(e) => setBudget(e.target.value)} onBlur={() => void save({ budgetGiB: Number(budget) })} />
          GiB
        </label>
        {error && <div role="alert" style={alert}>{error}</div>}
      </div>
    </details>
  );
}

const muted: React.CSSProperties = { fontSize: '11px', color: 'var(--color-fg-muted)' };
const alert: React.CSSProperties = { fontSize: '12px', color: 'var(--color-warning, var(--color-accent-primary))', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', padding: '6px 9px', margin: '6px 0' };
const chip = (on: boolean): React.CSSProperties => ({
  background: on ? 'var(--color-accent-primary-a10)' : 'transparent',
  border: `1px solid ${on ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
  borderRadius: '3px', color: on ? 'var(--color-accent-primary)' : 'var(--color-accent-primary-dim)',
  cursor: 'pointer', fontSize: '12px', letterSpacing: '1px', padding: '4px 9px',
});
const btn: React.CSSProperties = {
  background: 'transparent', border: '1px solid var(--color-accent-primary-dim)', borderRadius: '3px',
  color: 'var(--color-accent-primary)', cursor: 'pointer', fontSize: '11px', letterSpacing: '1.5px', padding: '4px 9px',
};
