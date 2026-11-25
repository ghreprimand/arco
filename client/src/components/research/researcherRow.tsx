import { useEffect, useState } from 'react';
import { RESEARCHER_PROVIDERS, type ClusterMemberProvider, type ModelName } from '@arco/shared';
import { useAppStore } from '../../stores/appStore';
import { effortsForModel } from '../../utils/format';
import { modelsForProvider, useModelCatalogs } from '../../utils/modelCatalog';
import { claudeConnection } from '../../utils/claudeAuth';
import { MEMBER_PROVIDER_NAMES, memberProviderAvailable } from '../WorkflowCreator/memberProviders';
import { EFFORT_LABELS } from '../WorkflowCreator/modelOptions';
import type { ResearchRow } from '../WorkflowCreator/ResearchStartForm';

// docs/RESEARCH.md - one researcher row outside the start dialog: ADD
// RESEARCHER in a running project and the new researchers of REOPEN.

export type ResearcherRowValue = Omit<ResearchRow, 'key' | 'advanced'>;

type Sandbox = { claudeCli?: boolean; codex?: boolean; cursor?: boolean; gemini?: boolean; geminiSignIn?: 'missing' | 'ready' | 'expired'; codexVersionReason?: string; cursorVersionReason?: string };

/** Why a Gemini researcher cannot run now, or undefined when it can. */
export function geminiResearchReason(sandbox: Sandbox): string | undefined {
  if (!sandbox.gemini) return 'Gemini researchers need the Linux worker sandbox.';
  if (sandbox.geminiSignIn !== 'ready') return sandbox.geminiSignIn === 'expired' ? 'GEMINI FOR RESEARCH needs signing in again in Settings, Providers and models.' : 'Sign in to GEMINI FOR RESEARCH in Settings, Providers and models.';
  return undefined;
}

export const rowButton: React.CSSProperties = { minHeight: 44, minWidth: 44, padding: '4px 10px', fontSize: '10px', letterSpacing: '1px', background: 'transparent', border: '1px solid var(--color-border-hairline)', color: 'var(--color-fg)', cursor: 'pointer' };
export const rowHint: React.CSSProperties = { color: 'var(--color-fg-muted)', fontSize: 11, lineHeight: 1.4 };

// Which researcher providers can run now: signed in, and for the sandboxed
// ones the sandbox is available. `active` starts the sandbox check.
export function useResearcherAvailability(active: boolean) {
  const authStatus = useAppStore((s) => s.authStatus);
  const isProviderEnabled = useAppStore((s) => s.isProviderEnabled);
  const catalogs = useModelCatalogs();
  const [sandbox, setSandbox] = useState<Sandbox>({});
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void fetch('/api/diagnostics/research-sandbox', { signal: controller.signal }).then((r) => r.ok ? r.json() : {})
      .then((body: Sandbox) => { setSandbox(body); setChecked(true); }).catch(() => { if (!controller.signal.aborted) setChecked(true); });
    return () => controller.abort();
  }, [active]);
  const usable = (p: ClusterMemberProvider) => p === 'claude'
    ? isProviderEnabled('claude') && claudeConnection(authStatus?.claude, 'native').connected
    : p === 'antigravity-cli' ? isProviderEnabled('antigravity-cli') && !geminiResearchReason(sandbox)
    : memberProviderAvailable(p, authStatus, isProviderEnabled) && (p === 'codex' ? !!sandbox.codex : p === 'cursor' ? !!sandbox.cursor : true);
  const cliUsable = !!sandbox.claudeCli && isProviderEnabled('claude') && claudeConnection(authStatus?.claude, 'cli').connected;
  const models = (p: ClusterMemberProvider) => modelsForProvider(p, catalogs).map(String);
  const efforts = (r: Pick<ResearcherRowValue, 'provider' | 'model'>) => effortsForModel(r.provider, r.model as ModelName, catalogs.claude, catalogs.codex);
  // A prefilled model or effort that is no longer offered falls back to the
  // provider's first model and its default effort.
  const rowFor = (provider: ClusterMemberProvider, cli = false, from?: Partial<ResearcherRowValue>): ResearcherRowValue => {
    const offered = models(provider);
    const model = from?.model && offered.includes(from.model) ? from.model : offered[0] ?? '';
    const list = effortsForModel(provider, model as ModelName, catalogs.claude, catalogs.codex);
    const effort = from?.effort && list.includes(from.effort as never) ? from.effort : list.includes('medium' as never) ? 'medium' : list[0] ?? '';
    return { provider, model, effort, webAccess: from?.webAccess !== false, ...(cli ? { researchClaudeTransport: 'cli' as const } : {}) };
  };
  const rowUsable = (r: ResearcherRowValue) => r.researchClaudeTransport === 'cli' ? cliUsable : usable(r.provider);
  const unavailableReason = (r: ResearcherRowValue) => r.provider === 'codex' ? sandbox.codexVersionReason : r.provider === 'cursor' ? sandbox.cursorVersionReason : r.provider === 'antigravity-cli' ? geminiResearchReason(sandbox) : undefined;
  const firstUsable = (): ResearcherRowValue | null => {
    const first = RESEARCHER_PROVIDERS.find(usable);
    return first ? rowFor(first) : cliUsable ? rowFor('claude', true) : null;
  };
  return { checked, authStatus, usable, cliUsable, models, efforts, rowFor, rowUsable, unavailableReason, firstUsable };
}

export type ResearcherAvailability = ReturnType<typeof useResearcherAvailability>;

// Provider, model, effort, web access and the Advanced fold of one row.
export function ResearcherRowFields({ row, onChange, avail, label, extra }: {
  row: ResearcherRowValue;
  onChange: (next: ResearcherRowValue) => void;
  avail: ResearcherAvailability;
  label?: string;
  extra?: React.ReactNode;
}) {
  const [advanced, setAdvanced] = useState(false);
  const prefix = label ? `${label} ` : '';
  return <>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      <select className="arco-field" aria-label={`${prefix}Provider`} style={{ minHeight: 44 }} value={row.researchClaudeTransport === 'cli' ? 'claude-cli' : row.provider}
        onChange={(e) => { setAdvanced(false); onChange({ ...(e.target.value === 'claude-cli' ? avail.rowFor('claude', true) : avail.rowFor(e.target.value as ClusterMemberProvider)), webAccess: row.webAccess }); }}>
        {RESEARCHER_PROVIDERS.map((p) => <option key={p} value={p} disabled={!avail.usable(p)}>{p === 'claude' ? 'Claude Native' : MEMBER_PROVIDER_NAMES[p]}{avail.usable(p) ? '' : ' (unavailable)'}</option>)}
        <option value="claude-cli" disabled={!avail.cliUsable}>Claude CLI{avail.cliUsable ? '' : ' (unavailable)'}</option>
      </select>
      <select className="arco-field" aria-label={`${prefix}Model`} style={{ minHeight: 44, maxWidth: 220 }} value={row.model} onChange={(e) => onChange({ ...row, model: e.target.value })}>
        {avail.models(row.provider).length === 0 && <option value="">No models</option>}
        {row.model && !avail.models(row.provider).includes(row.model) && <option value={row.model}>{row.model} (not in catalog)</option>}
        {avail.models(row.provider).map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
      {avail.efforts(row).length > 0 && <select className="arco-field" aria-label={`${prefix}Effort`} style={{ minHeight: 44 }} value={row.effort} onChange={(e) => onChange({ ...row, effort: e.target.value })}>
        {avail.efforts(row).map((e) => <option key={e} value={e}>{EFFORT_LABELS[e] ?? e.toUpperCase()}</option>)}
      </select>}
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 44 }}><input style={{ width: 22, height: 22 }} type="checkbox" checked={row.webAccess !== false} onChange={(e) => onChange({ ...row, webAccess: e.target.checked })} /> Web access</label>
      {((row.provider === 'claude' && row.researchClaudeTransport !== 'cli') || row.provider === 'ollama') && <button type="button" style={rowButton} aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>ADVANCED</button>}
      {extra}
    </div>
    {advanced && row.provider === 'claude' && row.researchClaudeTransport !== 'cli' && <label style={{ ...rowHint, display: 'flex', gap: 6, alignItems: 'center' }}>Web searches per turn
      <input className="arco-field" type="number" min={1} max={50} value={row.webSearchMaxUses ?? ''} placeholder="15" onChange={(e) => onChange({ ...row, webSearchMaxUses: e.target.value ? Math.max(1, Math.min(50, Number(e.target.value))) : undefined })} style={{ width: 70 }} /></label>}
    {advanced && row.provider === 'ollama' && <label style={{ ...rowHint, display: 'flex', gap: 6, alignItems: 'center' }}>Context size (tokens)
      <input className="arco-field" type="number" min={2048} step={1024} value={row.contextSize ?? ''} placeholder="Model default" onChange={(e) => onChange({ ...row, contextSize: e.target.value ? Math.max(2048, Number(e.target.value)) : undefined })} style={{ width: 110 }} /></label>}
  </>;
}
