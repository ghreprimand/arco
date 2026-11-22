import { useEffect, useRef, useState } from 'react';
import { CLUSTER_MEMBER_PROVIDERS, type ClusterMemberProvider, type ModelName, type ResearchReopenPreview } from '@arco/shared';
import { useAppStore } from '../../stores/appStore';
import { submitClusterCreation } from '../../utils/clusterCreation';
import { effortsForModel } from '../../utils/format';
import { modelsForProvider, useModelCatalogs } from '../../utils/modelCatalog';
import { claudeConnection } from '../../utils/claudeAuth';
import { DialogShell } from '../DialogShell';
import { MEMBER_PROVIDER_NAMES, memberProviderAvailable } from '../WorkflowCreator/memberProviders';
import { EFFORT_LABELS } from '../WorkflowCreator/modelOptions';
import { researchMember } from '../WorkflowCreator/ResearchStartForm';
import { ResearcherRowFields, rowButton as small, rowHint as hint, useResearcherAvailability, type ResearcherRowValue } from './researcherRow';

export type ResearchReopenPayload = {
  requestId?: string;
  cwd: string;
  members: Array<{ provider: ClusterMemberProvider; model: string; effort?: string }>;
  research: { name: string; brief: string; reopen: { projectId: string; resumeDirector: boolean } };
};

type Row = ResearcherRowValue & { key: number };
let seq = 0;

// The Research Director a reopen uses: the saved one when it can resume and
// the operator did not ask for a new one.
export function reopenPayload(preview: Pick<ResearchReopenPreview, 'projectId' | 'name' | 'director'>, resume: boolean, director: { provider: ClusterMemberProvider; model: string; effort?: string }, rows: ResearcherRowValue[]): ResearchReopenPayload {
  const saved = resume && preview.director.provider ? { provider: preview.director.provider, model: preview.director.model ?? '', ...(preview.director.effort ? { effort: preview.director.effort } : {}) }
    : { provider: director.provider, model: director.model, ...(director.effort ? { effort: director.effort } : {}) };
  return {
    cwd: '',
    members: [saved, ...rows.map(researchMember)],
    research: { name: preview.name, brief: '', reopen: { projectId: preview.projectId, resumeDirector: resume } },
  };
}

// docs/RESEARCH.md - REOPEN from the Research library on Home.
export function ResearchReopenDialog({ projectId, onClose, onReopen }: { projectId: string; onClose: () => void; onReopen: (payload: ResearchReopenPayload) => boolean | void }) {
  const authStatus = useAppStore((s) => s.authStatus);
  const isProviderEnabled = useAppStore((s) => s.isProviderEnabled);
  const pending = useAppStore((s) => s.clusterCreationPending);
  const connected = useAppStore((s) => s.connected);
  const catalogs = useModelCatalogs();
  const avail = useResearcherAvailability(true);
  const [preview, setPreview] = useState<ResearchReopenPreview | null>(null);
  const [error, setError] = useState('');
  const [newDirector, setNewDirector] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const seeded = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/research/library/${projectId}/reopen`, { signal: controller.signal, cache: 'no-store' })
      .then(async (r) => { if (!r.ok) throw new Error(); setPreview(await r.json() as ResearchReopenPreview); })
      .catch(() => { if (!controller.signal.aborted) setError('The project could not be read. Reload the list and try again.'); });
    return () => controller.abort();
  }, [projectId]);
  // Prefill the new researchers from the earlier panel once providers are known.
  useEffect(() => {
    if (seeded.current || !preview?.reopenable || !avail.checked || !authStatus) return;
    seeded.current = true;
    const earlier = preview.researchers.slice(0, preview.slots).map((r) => avail.rowFor(r.provider, r.claudeTransport === 'cli', { model: r.model, effort: r.effort }));
    const usable = earlier.filter(avail.rowUsable);
    const fallback = avail.firstUsable();
    setRows((usable.length ? usable : fallback ? [fallback] : []).map((r) => ({ ...r, key: seq++ })));
  }, [preview, avail.checked, authStatus]);

  const directorProviders = CLUSTER_MEMBER_PROVIDERS.filter((p) => p !== 'antigravity-cli' && memberProviderAvailable(p, authStatus, isProviderEnabled));
  const directorRow = (provider: ClusterMemberProvider, from?: { model?: string; effort?: string }) => {
    const offered = modelsForProvider(provider, catalogs).map(String);
    const model = from?.model && offered.includes(from.model) ? from.model : offered[0] ?? '';
    const efforts = effortsForModel(provider, model as ModelName, catalogs.claude, catalogs.codex);
    const effort = from?.effort && efforts.includes(from.effort as never) ? from.effort : efforts.includes('medium' as never) ? 'medium' : efforts[0] ?? '';
    return { provider, model, effort };
  };
  const [director, setDirector] = useState(() => directorRow('claude'));
  useEffect(() => {
    if (!preview) return;
    const saved = preview.director.provider;
    setDirector(saved && directorProviders.includes(saved) ? directorRow(saved, preview.director) : directorRow(directorProviders[0] ?? 'claude'));
  }, [preview]);

  const savedProvider = preview?.director.provider;
  const signedIn = !savedProvider || (savedProvider === 'claude'
    ? isProviderEnabled('claude') && (claudeConnection(authStatus?.claude, 'native').connected || claudeConnection(authStatus?.claude, 'cli').connected)
    : memberProviderAvailable(savedProvider, authStatus, isProviderEnabled));
  const resumable = !!preview?.director.resumable && signedIn;
  const resumeReason = preview?.director.reason ?? (!signedIn && savedProvider ? `${MEMBER_PROVIDER_NAMES[savedProvider]} is not signed in.` : undefined);
  const resume = resumable && !newDirector;
  const directorEfforts = effortsForModel(director.provider, director.model as ModelName, catalogs.claude, catalogs.codex);
  const first = preview ? preview.nextLetter.charCodeAt(0) : 65;
  const problems = !preview?.reopenable ? [] : [
    rows.length === 0 ? 'Add at least one researcher.' : '',
    preview && rows.length > preview.slots ? `At most ${preview.slots} new researchers.` : '',
    rows.some((r) => !avail.rowUsable(r)) ? 'A researcher is unavailable. Check the sign-in and sandbox.' : '',
    rows.some((r) => !r.model) || (!resume && !director.model) ? 'Choose a model for every row.' : '',
  ].filter(Boolean);
  const canReopen = !!preview?.reopenable && problems.length === 0 && !pending && connected;

  // The new tab replaces Home once the project is open again.
  const opened = useAppStore((s) => Object.values(s.clusters).some((c) => c.research?.projectId === projectId));
  useEffect(() => { if (opened) onClose(); }, [opened]);

  const reopen = () => {
    if (!preview || !canReopen) return;
    const payload = reopenPayload(preview, resume, director, rows.map(({ key: _key, ...row }) => row));
    submitClusterCreation((requestId) => onReopen({ ...payload, requestId }));
  };

  return (
    <DialogShell title={preview ? `Reopen ${preview.name}` : 'Reopen research project'} size="form" dataHelp="home.research-reopen" onClose={onClose}
      status={problems.length > 0 ? <span style={{ ...hint, color: 'var(--color-warning)' }}>{problems.join(' ')}</span> : undefined}
      actions={<>
        <button type="button" style={small} onClick={onClose}>CANCEL</button>
        <button type="button" className="display-font" style={{ ...small, opacity: canReopen ? 1 : 0.5 }} disabled={!canReopen} onClick={reopen}>{pending ? 'REOPENING...' : 'REOPEN'}</button>
      </>}>
      {!preview && !error && <p style={hint}>Reading the project...</p>}
      {error && <p role="alert" style={{ ...hint, color: 'var(--color-warning)' }}>{error}</p>}
      {preview && <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <p style={{ ...hint, margin: 0, overflowWrap: 'anywhere' }}>The project opens again in <code>{preview.folder}</code>. Its reports, rounds and summaries stay where they are.</p>
        {!preview.reopenable && <p role="alert" style={{ ...hint, color: 'var(--color-warning)', margin: 0 }}>{preview.reason}</p>}
        {preview.reopenable && <>
          <section aria-label="Research Director" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="display-font" style={{ fontSize: 10, letterSpacing: 1, color: 'var(--color-fg-muted)' }}>RESEARCH DIRECTOR</span>
            {resumable
              ? <p style={{ ...hint, margin: 0 }}>The saved Research Director continues its conversation ({MEMBER_PROVIDER_NAMES[savedProvider!]}, {preview.director.model}).</p>
              : <p role="status" style={{ ...hint, margin: 0 }}>The saved Research Director cannot continue. {resumeReason ?? 'Its conversation is not available.'} A new Research Director reads the project files first.</p>}
            {resumable && <label style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44 }}><input style={{ width: 22, height: 22 }} type="checkbox" checked={newDirector} onChange={(e) => setNewDirector(e.target.checked)} /> Start a new Research Director instead</label>}
            {!resume && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <select className="arco-field" aria-label="Research Director provider" style={{ minHeight: 44 }} value={director.provider} onChange={(e) => setDirector(directorRow(e.target.value as ClusterMemberProvider))}>
                {[...new Set([...directorProviders, director.provider])].map((p) => <option key={p} value={p} disabled={!directorProviders.includes(p)}>{MEMBER_PROVIDER_NAMES[p]}</option>)}
              </select>
              <select className="arco-field" aria-label="Research Director model" style={{ minHeight: 44, maxWidth: 220 }} value={director.model} onChange={(e) => setDirector({ ...director, model: e.target.value })}>
                {modelsForProvider(director.provider, catalogs).length === 0 && <option value="">No models</option>}
                {modelsForProvider(director.provider, catalogs).map((m) => <option key={String(m)} value={String(m)}>{String(m)}</option>)}
              </select>
              {directorEfforts.length > 0 && <select className="arco-field" aria-label="Research Director effort" style={{ minHeight: 44 }} value={director.effort} onChange={(e) => setDirector({ ...director, effort: e.target.value })}>
                {directorEfforts.map((e) => <option key={e} value={e}>{EFFORT_LABELS[e] ?? e.toUpperCase()}</option>)}
              </select>}
            </div>}
            <span style={hint}>Either way the Research Director sends no round until you ask for one.</span>
          </section>
          <section aria-label="New researchers" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className="display-font" style={{ fontSize: 10, letterSpacing: 1, color: 'var(--color-fg-muted)' }}>NEW RESEARCHERS ({rows.length})</span>
            <span style={hint}>The earlier researchers were closed with the project; their reports stay. New researchers continue the letters and join from the next round. The rows start from the earlier panel.</span>
            {rows.map((r, i) => {
              const label = `Researcher ${String.fromCharCode(first + i)}`;
              return <div key={r.key} style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingBottom: 6, borderBottom: '1px solid var(--color-border-hairline)' }}>
                <span className="display-font" style={{ fontSize: 10, letterSpacing: 1, color: 'var(--color-fg-muted)' }}>{label.toUpperCase()}</span>
                <ResearcherRowFields row={r} avail={avail} label={label} onChange={(next) => setRows((all) => all.map((x) => x.key === r.key ? { ...next, key: r.key } : x))}
                  extra={<button type="button" style={small} aria-label={`Remove ${label}`} onClick={() => setRows((all) => all.filter((x) => x.key !== r.key))}>REMOVE</button>} />
                {!avail.rowUsable(r) && <span role="status" style={{ ...hint, color: 'var(--color-warning)' }}>{avail.unavailableReason(r) ?? 'This researcher is unavailable. Check the sign-in and sandbox.'}</span>}
              </div>;
            })}
            <button type="button" style={{ ...small, alignSelf: 'flex-start' }} disabled={rows.length >= preview.slots || !avail.firstUsable()}
              onClick={() => setRows((all) => { const last = all.at(-1); const row = last ? { ...last } : avail.firstUsable(); return row ? [...all, { ...row, key: seq++ }] : all; })}>+ ADD RESEARCHER</button>
          </section>
        </>}
      </div>}
    </DialogShell>
  );
}
