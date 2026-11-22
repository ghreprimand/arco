import { useEffect, useState } from 'react';
import { RESEARCHER_PROVIDERS, RESEARCH_MAX_RESEARCHERS, type ClusterMemberProvider, type ClusterResearchSummary, type ModelName } from '@arco/shared';
import { useAppStore } from '../../stores/appStore';
import { effortsForModel } from '../../utils/format';
import { modelsForProvider, useModelCatalogs } from '../../utils/modelCatalog';
import { claudeConnection } from '../../utils/claudeAuth';
import { MEMBER_PROVIDER_NAMES, memberProviderAvailable } from '../WorkflowCreator/memberProviders';
import { EFFORT_LABELS } from '../WorkflowCreator/modelOptions';
import { researchMember, type ResearchRow } from '../WorkflowCreator/ResearchStartForm';

type Row = Omit<ResearchRow, 'key' | 'advanced'>;
export type ResearcherAddRequest = { researcher: ReturnType<typeof researchMember>; catchUp: boolean };

// docs/RESEARCH.md - ADD RESEARCHER in a running research project: one row
// as in the start dialog, plus whether it answers the round 1 text now.
export function AddResearcherSection({ research, onAdd }: { research: ClusterResearchSummary; onAdd: (request: ResearcherAddRequest) => void }) {
  const authStatus = useAppStore((s) => s.authStatus);
  const isProviderEnabled = useAppStore((s) => s.isProviderEnabled);
  const catalogs = useModelCatalogs();
  const [open, setOpen] = useState(false);
  const [sandbox, setSandbox] = useState<{ claudeCli?: boolean; codex?: boolean; cursor?: boolean; codexVersionReason?: string; cursorVersionReason?: string }>({});
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void fetch('/api/diagnostics/research-sandbox', { signal: controller.signal }).then((r) => r.ok ? r.json() : {}).then(setSandbox).catch(() => {});
    return () => controller.abort();
  }, [open]);
  const usable = (p: ClusterMemberProvider) => p === 'claude'
    ? isProviderEnabled('claude') && claudeConnection(authStatus?.claude, 'native').connected
    : memberProviderAvailable(p, authStatus, isProviderEnabled) && (p === 'codex' ? !!sandbox.codex : p === 'cursor' ? !!sandbox.cursor : true);
  const cliUsable = !!sandbox.claudeCli && isProviderEnabled('claude') && claudeConnection(authStatus?.claude, 'cli').connected;
  const models = (p: ClusterMemberProvider) => modelsForProvider(p, catalogs).map(String);
  const efforts = (r: Row) => effortsForModel(r.provider, r.model as ModelName, catalogs.claude, catalogs.codex);
  const rowFor = (provider: ClusterMemberProvider, cli = false): Row => {
    const model = models(provider)[0] ?? '';
    const list = effortsForModel(provider, model as ModelName, catalogs.claude, catalogs.codex);
    return { provider, model, effort: list.includes('medium' as never) ? 'medium' : list[0] ?? '', webAccess: true, ...(cli ? { researchClaudeTransport: 'cli' as const } : {}) };
  };
  const [row, setRow] = useState<Row>(() => rowFor('claude'));
  const [advanced, setAdvanced] = useState(false);
  const [catchUp, setCatchUp] = useState(true);
  // Start on the first usable provider once the availability checks are in.
  const [picked, setPicked] = useState(false);
  useEffect(() => {
    if (!open || picked || usable(row.provider)) return;
    const first = RESEARCHER_PROVIDERS.find(usable);
    if (first) setRow(rowFor(first)); else if (cliUsable) setRow(rowFor('claude', true));
  }, [open, picked, sandbox, authStatus]);
  const used = research.researchers.length;
  const full = used >= RESEARCH_MAX_RESEARCHERS;
  const nextLetter = String.fromCharCode(65 + used);
  const started = research.rounds.length > 0;
  const rowUsable = row.researchClaudeTransport === 'cli' ? cliUsable : usable(row.provider);
  const small: React.CSSProperties = { minHeight: 44, minWidth: 44, padding: '4px 10px', fontSize: '10px', letterSpacing: '1px', background: 'transparent', border: '1px solid var(--color-border-hairline)', color: 'var(--color-fg)', cursor: 'pointer' };
  const hint: React.CSSProperties = { color: 'var(--color-fg-muted)', fontSize: 11, lineHeight: 1.4 };
  const unavailableReason = row.provider === 'codex' ? sandbox.codexVersionReason : row.provider === 'cursor' ? sandbox.cursorVersionReason : undefined;

  if (!open) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <button type="button" className="display-font" data-help="research.add-researcher" style={{ ...small, alignSelf: 'flex-start', opacity: full ? 0.5 : 1 }} disabled={full} onClick={() => { setPicked(false); setRow(rowFor('claude')); setOpen(true); }}>+ ADD RESEARCHER</button>
      {full && <span style={hint}>{RESEARCH_MAX_RESEARCHERS} researchers is the most a project can have.</span>}
    </div>
  );
  return (
    <div data-help="research.add-researcher" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, border: '1px solid var(--color-border-hairline)' }}>
      <span className="display-font" style={{ fontSize: 10, letterSpacing: 1, color: 'var(--color-fg-muted)' }}>RESEARCHER {nextLetter}</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <select className="arco-field" aria-label="Provider" style={{ minHeight: 44 }} value={row.researchClaudeTransport === 'cli' ? 'claude-cli' : row.provider}
          onChange={(e) => { setPicked(true); setAdvanced(false); setRow({ ...(e.target.value === 'claude-cli' ? rowFor('claude', true) : rowFor(e.target.value as ClusterMemberProvider)), webAccess: row.webAccess }); }}>
          {RESEARCHER_PROVIDERS.map((p) => <option key={p} value={p} disabled={!usable(p)}>{p === 'claude' ? 'Claude Native' : MEMBER_PROVIDER_NAMES[p]}{usable(p) ? '' : ' (unavailable)'}</option>)}
          <option value="claude-cli" disabled={!cliUsable}>Claude CLI{cliUsable ? '' : ' (unavailable)'}</option>
        </select>
        <select className="arco-field" aria-label="Model" style={{ minHeight: 44, maxWidth: 220 }} value={row.model} onChange={(e) => setRow({ ...row, model: e.target.value })}>
          {models(row.provider).length === 0 && <option value="">No models</option>}
          {models(row.provider).map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        {efforts(row).length > 0 && <select className="arco-field" aria-label="Effort" style={{ minHeight: 44 }} value={row.effort} onChange={(e) => setRow({ ...row, effort: e.target.value })}>
          {efforts(row).map((e) => <option key={e} value={e}>{EFFORT_LABELS[e] ?? e.toUpperCase()}</option>)}
        </select>}
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 44 }}><input style={{ width: 22, height: 22 }} type="checkbox" checked={row.webAccess !== false} onChange={(e) => setRow({ ...row, webAccess: e.target.checked })} /> Web access</label>
        {((row.provider === 'claude' && row.researchClaudeTransport !== 'cli') || row.provider === 'ollama') && <button type="button" style={small} aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>ADVANCED</button>}
      </div>
      {advanced && row.provider === 'claude' && row.researchClaudeTransport !== 'cli' && <label style={{ ...hint, display: 'flex', gap: 6, alignItems: 'center' }}>Web searches per turn
        <input className="arco-field" type="number" min={1} max={50} value={row.webSearchMaxUses ?? ''} placeholder="15" onChange={(e) => setRow({ ...row, webSearchMaxUses: e.target.value ? Math.max(1, Math.min(50, Number(e.target.value))) : undefined })} style={{ width: 70 }} /></label>}
      {advanced && row.provider === 'ollama' && <label style={{ ...hint, display: 'flex', gap: 6, alignItems: 'center' }}>Context size (tokens)
        <input className="arco-field" type="number" min={2048} step={1024} value={row.contextSize ?? ''} placeholder="Model default" onChange={(e) => setRow({ ...row, contextSize: e.target.value ? Math.max(2048, Number(e.target.value)) : undefined })} style={{ width: 110 }} /></label>}
      {started
        ? <label style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44 }}><input style={{ width: 22, height: 22 }} type="checkbox" checked={catchUp} onChange={(e) => setCatchUp(e.target.checked)} /> Give it the original brief now</label>
        : <span style={hint}>It joins round 1.</span>}
      <span style={hint}>{started ? 'It is left out of a round in progress and joins from the next one. The original brief is the round 1 text; the report is released to the Research Director alone.' : ''}</span>
      {!rowUsable && <span role="status" style={{ ...hint, color: 'var(--color-warning)' }}>{unavailableReason ?? 'This researcher is unavailable. Check the sign-in and sandbox.'}</span>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" className="display-font" style={{ ...small, opacity: rowUsable && row.model ? 1 : 0.5 }} disabled={!rowUsable || !row.model}
          onClick={() => { onAdd({ researcher: researchMember(row), catchUp: started && catchUp }); setOpen(false); }}>ADD</button>
        <button type="button" className="display-font" style={small} onClick={() => setOpen(false)}>CANCEL</button>
      </div>
    </div>
  );
}
