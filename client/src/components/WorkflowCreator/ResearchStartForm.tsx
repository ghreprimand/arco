import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CLUSTER_MEMBER_PROVIDERS,
  RESEARCHER_PROVIDERS,
  RESEARCH_CONFIRM_ABOVE,
  RESEARCH_MAX_RESEARCHERS,
  type ClusterMemberProvider,
  type ClusterPreset,
  type ModelName,
} from '@arco/shared';
import { useAppStore } from '../../stores/appStore';
import { useStartupStore } from '../../stores/startupStore';
import { useClusterPresets } from '../../hooks/useClusterPresets';
import { effortsForModel } from '../../utils/format';
import { DirectoryBrowser } from '../media/DirectoryPicker';
import { DialogShell } from '../DialogShell';
import { MEMBER_PROVIDER_NAMES, memberProviderAvailable } from './memberProviders';
import { EFFORT_LABELS } from './modelOptions';
import { claudeConnection } from '../../utils/claudeAuth';
import type { ClusterCreatePayload, ClusterMembersSectionProps } from './types';

// docs/RESEARCH.md - the research start dialog. Researcher rows carry only
// Provider, Model and Effort, with an Advanced fold for settings that change
// research results. It creates the project on cluster_create_from_scratch.

type ModelOption = { value: ModelName; label: string; subline?: string };
export interface ResearchRow {
  key: string;
  provider: ClusterMemberProvider;
  model: string;
  effort: string;
  advanced: boolean;
  webSearchMaxUses?: number;
  contextSize?: number;
  researchClaudeTransport?: 'native' | 'cli';
  webAccess?: boolean;
}
/** Switching provider replaces provider-specific options instead of retaining the old row's values. */
export function replaceResearchProvider(current: ResearchRow, next: ResearchRow): ResearchRow {
  return { ...current, ...next, key: current.key, advanced: current.advanced, webAccess: current.webAccess,
    researchClaudeTransport: next.researchClaudeTransport, webSearchMaxUses: next.webSearchMaxUses, contextSize: next.contextSize };
}
type Pickers = Pick<ClusterMembersSectionProps, 'claudeModelsForPicker' | 'codexModelsForPicker' | 'ollamaModelsForPicker' | 'llamacppModelsForPicker' | 'cursorModelsForPicker' | 'claudeNativeCatalog' | 'codexCatalog' | 'selectStyle' | 'labelStyle' | 'inputStyle' | 'hintStyle'>;

const LAST_PANEL_KEY = 'arco.research.lastPanel';
// Same limits as server/src/research/researchCreate.ts.
const RESEARCH_NAME_MAX = 60;
const RESEARCH_BRIEF_MAX = 20_000;
let rowSeq = 0;
const newKey = (): string => `r${Date.now().toString(36)}${(rowSeq++).toString(36)}`;

// A saved panel is a cluster preset whose members after the first are researchers.
export function isResearchPanel(preset: Pick<ClusterPreset, 'members'>): boolean {
  return preset.members.length >= 2 && preset.members.slice(1).every((m) => m.accessMode === 'researcher');
}

// One row as the server takes it, at project start and in ADD RESEARCHER.
export function researchMember(r: Omit<ResearchRow, 'key' | 'advanced'>) {
  return {
    provider: r.provider, model: r.model, ...(r.effort ? { effort: r.effort } : {}),
    ...(r.provider === 'claude' && r.researchClaudeTransport !== 'cli' && r.webSearchMaxUses ? { webSearchMaxUses: r.webSearchMaxUses } : {}),
    ...(r.provider === 'ollama' && r.contextSize ? { contextSize: r.contextSize } : {}),
    ...(r.provider === 'claude' && r.researchClaudeTransport === 'cli' ? { researchClaudeTransport: 'cli' as const } : {}),
    ...(r.webAccess === false ? { webAccess: false } : {}),
  };
}

export function researchCreatePayload(input: {
  requestId?: string; name: string; brief: string; blind: boolean; folderRoot?: string;
  director: ResearchRow; rows: ResearchRow[];
}): ClusterCreatePayload & { research: NonNullable<import('@arco/shared').ClusterCreateFromScratchMessage['research']> } {
  const member = researchMember;
  return {
    ...(input.requestId ? { requestId: input.requestId } : {}),
    cwd: '',
    members: [member(input.director), ...input.rows.map(member)],
    research: {
      name: input.name.trim(),
      brief: input.brief.trim(),
      blind: input.blind,
      ...(input.folderRoot?.trim() ? { folderRoot: input.folderRoot.trim() } : {}),
    },
  };
}

export function ResearchStartForm(props: Pickers & {
  onCreate: (payload: ReturnType<typeof researchCreatePayload>) => boolean | void;
  submitting: boolean;
  // The creator's current provider, model and effort: the Director's default.
  directorDefault?: { provider: string; model: string; effort?: string };
}) {
  const { selectStyle, labelStyle, inputStyle, hintStyle } = props;
  const settings = useAppStore((s) => s.settings);
  const authStatus = useAppStore((s) => s.authStatus);
  const isProviderEnabled = useAppStore((s) => s.isProviderEnabled);
  const presets = useClusterPresets();
  const [sandboxStatus, setSandboxStatus] = useState<'checking' | 'ready' | 'unavailable'>('checking');
  const [codexSandboxAvailable, setCodexSandboxAvailable] = useState(false);
  const [codexVersionReason, setCodexVersionReason] = useState<string>();
  const [cursorSandboxAvailable, setCursorSandboxAvailable] = useState(false);
  const [cursorVersionReason, setCursorVersionReason] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/diagnostics/research-sandbox', { signal: controller.signal })
      .then(async response => response.ok ? await response.json() as { claudeCli?: boolean; codex?: boolean; cursor?: boolean; codexVersionReason?: string; cursorVersionReason?: string } : null)
      .then(result => {
        setSandboxStatus(result?.claudeCli ? 'ready' : 'unavailable'); setCodexSandboxAvailable(result?.codex === true); setCodexVersionReason(result?.codexVersionReason);
        setCursorSandboxAvailable(result?.cursor === true); setCursorVersionReason(result?.cursorVersionReason);
      })
      .catch(() => { if (!controller.signal.aborted) setSandboxStatus('unavailable'); });
    return () => controller.abort();
  }, []);
  const available = (p: ClusterMemberProvider) => memberProviderAvailable(p, authStatus, isProviderEnabled);
  const modelsFor = (p: ClusterMemberProvider): ModelOption[] =>
    p === 'codex' ? props.codexModelsForPicker : p === 'ollama' ? props.ollamaModelsForPicker
      : p === 'llamacpp' ? props.llamacppModelsForPicker : p === 'cursor' ? props.cursorModelsForPicker : props.claudeModelsForPicker;
  const effortsFor = (r: ResearchRow) => effortsForModel(r.provider, r.model as ModelName, props.claudeNativeCatalog, props.codexCatalog);
  const researcherProviders = RESEARCHER_PROVIDERS.filter(p => p === 'claude'
    ? isProviderEnabled('claude') && claudeConnection(authStatus?.claude, 'native').connected : p === 'codex' ? codexSandboxAvailable && available(p)
      : p === 'cursor' ? cursorSandboxAvailable && available(p) : available(p));
  const sandboxedUnavailable = (p: ClusterMemberProvider) => (p === 'codex' && (!codexSandboxAvailable || !available('codex'))) || (p === 'cursor' && (!cursorSandboxAvailable || !available('cursor')));
  const cliAvailable = sandboxStatus === 'ready' && isProviderEnabled('claude') && claudeConnection(authStatus?.claude, 'cli').connected;
  const anyResearcherAvailable = researcherProviders.length > 0 || cliAvailable;
  const directorProviders = CLUSTER_MEMBER_PROVIDERS.filter(available);
  const rowFor = (provider: ClusterMemberProvider, from?: Partial<ResearchRow>): ResearchRow => {
    // A restored model or effort that is no longer offered falls back to the
    // provider's first model and its default effort, so Start never sends it.
    const offered = modelsFor(provider).map((m) => String(m.value));
    const model = from?.model && offered.includes(from.model) ? from.model : offered[0] ?? '';
    const efforts = effortsForModel(provider, model as ModelName, props.claudeNativeCatalog, props.codexCatalog);
    const effort = from?.effort && efforts.includes(from.effort as never) ? from.effort : efforts.includes('medium' as never) ? 'medium' : efforts[0] ?? '';
    return { key: newKey(), provider, model, effort, advanced: false, webAccess: from?.webAccess !== false,
      ...(from?.webSearchMaxUses ? { webSearchMaxUses: from.webSearchMaxUses } : {}), ...(from?.contextSize ? { contextSize: from.contextSize } : {}),
      ...(provider === 'claude' && from?.researchClaudeTransport === 'cli' ? { researchClaudeTransport: 'cli' as const } : {}) };
  };
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [blind, setBlind] = useState(true);
  const [folderRoot, setFolderRoot] = useState('');
  const [browser, setBrowser] = useState(false);
  const [rows, setRows] = useState<ResearchRow[]>(() => researcherProviders.length ? [rowFor(researcherProviders[0]), rowFor(researcherProviders[0])] : []);
  const seededRows = useRef(false);
  useEffect(() => {
    if (seededRows.current || !authStatus || sandboxStatus === 'checking' || !anyResearcherAvailable) return;
    seededRows.current = true;
    setRows(all => all.length ? all : researcherProviders.length
      ? [rowFor(researcherProviders[0]), rowFor(researcherProviders[0])]
      : [rowFor('claude', { researchClaudeTransport: 'cli' }), rowFor('claude', { researchClaudeTransport: 'cli' })]);
  }, [authStatus, sandboxStatus, codexSandboxAvailable, cursorSandboxAvailable]);
  const [director, setDirector] = useState<ResearchRow>(() => {
    const preferred = props.directorDefault && (directorProviders as readonly string[]).includes(props.directorDefault.provider) ? props.directorDefault : undefined;
    return preferred
      ? rowFor(preferred.provider as ClusterMemberProvider, { model: preferred.model, effort: preferred.effort })
      : rowFor(directorProviders.includes('claude') ? 'claude' : directorProviders[0] ?? 'claude');
  });
  const [confirmMany, setConfirmMany] = useState(false);
  const [panelName, setPanelName] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelError, setPanelError] = useState('');
  const savedPanels = useMemo(() => presets.presets.filter(isResearchPanel), [presets.presets]);

  const update = (key: string, patch: Partial<ResearchRow>) => setRows((all) => all.map((r) => r.key === key ? { ...r, ...patch } : r));
  const changeProvider = (r: ResearchRow, provider: ClusterMemberProvider): ResearchRow => replaceResearchProvider(r, rowFor(provider));
  const fromSaved = (members: Array<{ provider: ClusterMemberProvider; model: string; effort?: string; webSearchMaxUses?: number; contextSize?: number; researchClaudeTransport?: 'native' | 'cli'; webAccess?: boolean }>) =>
    members.filter((m) => (RESEARCHER_PROVIDERS as readonly string[]).includes(m.provider) && (available(m.provider) || m.provider === 'codex' || m.provider === 'cursor' || (m.provider === 'claude' && m.researchClaudeTransport === 'cli')))
      .map((m) => rowFor(m.provider, { model: m.model, effort: m.effort, webSearchMaxUses: m.webSearchMaxUses, contextSize: m.contextSize, researchClaudeTransport: m.researchClaudeTransport, webAccess: m.webAccess }));
  const lastPanel = (): ResearchRow[] | null => {
    try { const saved = JSON.parse(localStorage.getItem(LAST_PANEL_KEY) ?? 'null'); return Array.isArray(saved) && saved.length ? fromSaved(saved) : null; } catch { return null; }
  };
  const folderSet = !!settings?.researchFolder;
  const problems = [
    !name.trim() ? 'Give the project a short name.' : '',
    !brief.trim() ? 'Write the brief.' : '',
    rows.length === 0 ? 'Add at least one researcher.' : '',
    rows.length > RESEARCH_MAX_RESEARCHERS ? `At most ${RESEARCH_MAX_RESEARCHERS} researchers.` : '',
    rows.some((r) => !r.model) || !director.model ? 'Choose a model for every row.' : '',
    rows.some(r => r.researchClaudeTransport === 'cli' && !cliAvailable) ? 'Claude CLI researcher is unavailable. Check the sign-in and sandbox.' : '',
    rows.some(r => r.provider === 'codex' && (!codexSandboxAvailable || !available('codex'))) ? codexVersionReason ?? 'Codex researcher is unavailable. Check the sign-in and sandbox.' : '',
    rows.some(r => r.provider === 'cursor' && (!cursorSandboxAvailable || !available('cursor'))) ? cursorVersionReason ?? 'Cursor researcher is unavailable. Check the sign-in and sandbox.' : '',
    !folderSet && !folderRoot.trim() ? 'Choose the research folder.' : '',
  ].filter(Boolean);

  const start = () => {
    if (problems.length || props.submitting) return;
    if (rows.length > RESEARCH_CONFIRM_ABOVE && !confirmMany) { setConfirmMany(true); return; }
    setConfirmMany(false);
    try { localStorage.setItem(LAST_PANEL_KEY, JSON.stringify(rows.map(({ provider, model, effort, webSearchMaxUses, contextSize, researchClaudeTransport, webAccess }) => ({ provider, model, effort, webSearchMaxUses, contextSize, researchClaudeTransport, webAccess })))); } catch { /* best effort */ }
    props.onCreate(researchCreatePayload({ name, brief, blind, folderRoot: folderSet ? undefined : folderRoot, director, rows }));
  };
  const savePanel = async () => {
    setPanelError('');
    try {
      await presets.save({ name: panelName.trim(), members: [
        { provider: director.provider, model: director.model, effort: director.effort, role: 'Research Director' },
        ...rows.map((r) => ({ provider: r.provider, model: r.model, effort: r.effort, accessMode: 'researcher' as const,
          ...(r.webAccess === false ? { webAccess: false } : {}),
          ...(r.researchClaudeTransport === 'cli' ? { researchClaudeTransport: 'cli' as const } : {}),
          ...(r.researchClaudeTransport !== 'cli' && r.webSearchMaxUses ? { webSearchMaxUses: r.webSearchMaxUses } : {}), ...(r.contextSize ? { contextSize: r.contextSize } : {}) })),
      ] });
      setPanelOpen(false); setPanelName('');
    } catch (err) { setPanelError(err instanceof Error ? err.message : 'The panel was not saved.'); }
  };

  const small: React.CSSProperties = { ...selectStyle(false), minHeight: 44, minWidth: 44, padding: '4px 10px', fontSize: '10px', letterSpacing: '1px' };
  const rowEditor = (r: ResearchRow, providers: readonly ClusterMemberProvider[], onChange: (next: ResearchRow) => void, label: string, { help, extra, researcher = false }: { help: string; extra?: React.ReactNode; researcher?: boolean }) => (
    <div key={r.key} data-help={help} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
      <span className="display-font" style={{ minWidth: 92, fontSize: 10, letterSpacing: 1, color: 'var(--color-fg-muted)' }}>{label}</span>
      <select className="arco-field" aria-label={`${label} provider`} value={researcher && r.provider === 'claude' && r.researchClaudeTransport === 'cli' ? 'claude-cli' : r.provider} onChange={(e) => onChange(e.target.value === 'claude-cli' ? replaceResearchProvider(r, rowFor('claude', { researchClaudeTransport: 'cli' })) : changeProvider(r, e.target.value as ClusterMemberProvider))}>
        {[...new Set([...providers, ...(r.researchClaudeTransport === 'cli' ? [] : [r.provider])])].map((p) => <option key={p} value={p} disabled={researcher && sandboxedUnavailable(p)}>{p === 'claude' && researcher ? 'Claude Native' : researcher && sandboxedUnavailable(p) ? `${MEMBER_PROVIDER_NAMES[p]} (unavailable)` : MEMBER_PROVIDER_NAMES[p]}</option>)}
        {researcher && (cliAvailable || r.researchClaudeTransport === 'cli') && <option value="claude-cli" disabled={!cliAvailable}>Claude CLI{cliAvailable ? '' : ' (unavailable)'}</option>}
      </select>
      <select className="arco-field" aria-label={`${label} model`} value={r.model} onChange={(e) => onChange({ ...r, model: e.target.value })} style={{ maxWidth: 220 }}>
        {modelsFor(r.provider).length === 0 && <option value="">No models</option>}
        {modelsFor(r.provider).map((m) => <option key={String(m.value)} value={String(m.value)}>{m.label}</option>)}
      </select>
      {effortsFor(r).length > 0 && <select className="arco-field" aria-label={`${label} effort`} value={r.effort} onChange={(e) => onChange({ ...r, effort: e.target.value })}>
        {effortsFor(r).map((e) => <option key={e} value={e}>{EFFORT_LABELS[e] ?? e.toUpperCase()}</option>)}
      </select>}
      {extra}
    </div>
  );

  return (
    <div data-help="creator.research-mode" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <label className="display-font" style={labelStyle} htmlFor="research-name">NAME</label>
        <input id="research-name" data-help="creator.research-name" className="arco-field" value={name} onChange={(e) => setName(e.target.value)} maxLength={RESEARCH_NAME_MAX} placeholder="65-inch TV and sound" style={{ ...inputStyle, width: '100%', minHeight: 44 }} />
        <label className="display-font" style={{ ...labelStyle, marginTop: 8 }} htmlFor="research-brief">BRIEF</label>
        <textarea id="research-brief" data-help="creator.research-brief" className="arco-field" value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={RESEARCH_BRIEF_MAX} rows={8} placeholder="What should the researchers find out? Include budget, region, must-haves and sources to avoid." style={{ ...inputStyle, width: '100%', resize: 'vertical' }} />
        <div style={hintStyle}>The Research Director starts on this brief as soon as the project opens. {brief.length > RESEARCH_BRIEF_MAX * 0.9 ? `${brief.length} of ${RESEARCH_BRIEF_MAX} characters.` : ''}</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', justifyContent: 'space-between' }}>
          <label className="display-font" style={{ ...labelStyle, marginBottom: 0 }}>RESEARCHERS ({rows.length})</label>
          <div data-help="creator.research-shortcuts" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <button type="button" style={small} disabled={!anyResearcherAvailable} onClick={() => setRows([...researcherProviders.map((p) => rowFor(p)), ...(cliAvailable && !researcherProviders.includes('claude') ? [rowFor('claude', { researchClaudeTransport: 'cli' })] : [])])}>ONE OF EACH PROVIDER</button>
            <button type="button" style={small} disabled={!lastPanel()} onClick={() => { const last = lastPanel(); if (last) setRows(last); }}>SAME AS LAST TIME</button>
            {savedPanels.map((p) => <button type="button" key={p.id} style={small} title={`${p.members.length - 1} researchers`} onClick={() => { const saved = fromSaved(p.members.slice(1)); if (saved.length) setRows(saved); const d = p.members[0]; if (d && directorProviders.includes(d.provider)) setDirector(rowFor(d.provider, { model: d.model, effort: d.effort })); }}>{p.name.toUpperCase()}</button>)}
            <button type="button" style={small} disabled={!anyResearcherAvailable} onClick={() => setRows((all) => [...all, all.length ? { ...all[all.length - 1], key: newKey(), advanced: false } : researcherProviders.length ? rowFor(researcherProviders[0]) : rowFor('claude', { researchClaudeTransport: 'cli' })])}>+ ADD RESEARCHER</button>
          </div>
        </div>
        {codexVersionReason && isProviderEnabled('codex') && <div role="status" style={{ ...hintStyle, color: 'var(--color-warning)' }}>{codexVersionReason}</div>}
        {cursorVersionReason && isProviderEnabled('cursor') && <div role="status" style={{ ...hintStyle, color: 'var(--color-warning)' }}>{cursorVersionReason}</div>}
        {!anyResearcherAvailable && <div role="status" style={{ ...hintStyle, color: 'var(--color-warning)' }}>
          No supported researcher is available. Check connections and the sandbox. <button type="button" onClick={() => useStartupStore.getState().openConnections()}>Open Connections</button>
        </div>}
        {rows.map((r, i) => (
          <div key={r.key} style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingBottom: 6, borderBottom: '1px solid var(--color-border-hairline)' }}>
            {rowEditor(r, researcherProviders, (next) => update(r.key, next), `Researcher ${i + 1}`, { help: 'creator.research-researcher', researcher: true, extra: <>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 44 }}><input style={{ width: 22, height: 22 }} type="checkbox" checked={r.webAccess !== false} onChange={e => update(r.key, { webAccess: e.target.checked })} /> Web access</label>
              <button type="button" style={small} aria-label={`Duplicate researcher ${i + 1}`} onClick={() => setRows((all) => [...all.slice(0, i + 1), { ...r, key: newKey(), advanced: false }, ...all.slice(i + 1)])}>DUPLICATE</button>
              <button type="button" style={small} aria-label={`Remove researcher ${i + 1}`} onClick={() => setRows((all) => all.filter((x) => x.key !== r.key))}>REMOVE</button>
              {((r.provider === 'claude' && r.researchClaudeTransport !== 'cli') || r.provider === 'ollama') && <button type="button" style={small} aria-expanded={r.advanced} onClick={() => update(r.key, { advanced: !r.advanced })}>ADVANCED</button>}
            </> })}
            {r.advanced && r.provider === 'claude' && r.researchClaudeTransport !== 'cli' && <label data-help="creator.research-advanced" style={{ ...hintStyle, display: 'flex', gap: 6, alignItems: 'center' }}>Web searches per turn
              <input className="arco-field" type="number" min={1} max={50} value={r.webSearchMaxUses ?? ''} placeholder="15" onChange={(e) => update(r.key, { webSearchMaxUses: e.target.value ? Math.max(1, Math.min(50, Number(e.target.value))) : undefined })} style={{ width: 70 }} /></label>}
            {r.advanced && r.provider === 'ollama' && <label data-help="creator.research-advanced" style={{ ...hintStyle, display: 'flex', gap: 6, alignItems: 'center' }}>Context size (tokens)
              <input className="arco-field" type="number" min={2048} step={1024} value={r.contextSize ?? ''} placeholder="Model default" onChange={(e) => update(r.key, { contextSize: e.target.value ? Math.max(2048, Number(e.target.value)) : undefined })} style={{ width: 110 }} /></label>}
          </div>
        ))}
        <div style={hintStyle}>Every researcher works alone in a private workspace with web research. Claude CLI, Codex and Cursor can use a sandboxed shell. Local models run one at a time because they share the GPU.</div>
        <div data-help="creator.research-panels" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {!panelOpen && <button type="button" style={small} disabled={rows.length === 0} onClick={() => setPanelOpen(true)}>+ SAVE PANEL</button>}
          {panelOpen && <form onSubmit={(e) => { e.preventDefault(); void savePanel(); }} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <input className="arco-field" aria-label="Panel name" value={panelName} onChange={(e) => setPanelName(e.target.value)} placeholder="Panel name" maxLength={64} />
            <button type="submit" style={small} disabled={!panelName.trim()}>SAVE</button>
            <button type="button" style={small} onClick={() => { setPanelOpen(false); setPanelError(''); }}>CANCEL</button>
          </form>}
          {panelError && <span role="alert" style={{ ...hintStyle, color: 'var(--color-warning)' }}>{panelError}</span>}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label className="display-font" style={{ ...labelStyle, marginBottom: 0 }}>RESEARCH DIRECTOR</label>
        {rowEditor(director, directorProviders, setDirector, 'Research Director', { help: 'creator.research-director' })}
        <div style={hintStyle}>The Research Director sends the rounds, reads the reports, writes the summary and answers your follow-up questions.</div>
      </div>

      <div data-help="creator.research-folder">
        <label className="display-font" style={labelStyle}>RESEARCH FOLDER</label>
        {folderSet
          ? <div style={hintStyle}>A new subfolder is made in <code>{settings?.researchFolder}</code>. Change it in Settings, Projects.</div>
          : <>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <input className="arco-field" aria-label="Research folder path" value={folderRoot} onChange={(e) => setFolderRoot(e.target.value)} placeholder="Folder for all research projects" style={{ ...inputStyle, flex: 1 }} />
              <button type="button" style={small} onClick={() => setBrowser(!browser)}>BROWSE</button>
            </div>
            <div style={hintStyle}>Asked once and saved to Settings. Every research project gets its own subfolder here.</div>
            {browser && <DirectoryBrowser inline withFilename={false} initialPath={folderRoot} roots={settings?.projectRoots} title="Choose research folder" confirmLabel="Choose research folder" onDone={(r) => { if (r) { setFolderRoot(r.dir); setBrowser(false); } }} />}
          </>}
      </div>

      <label data-help="creator.research-blind" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
        <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} />
        <span><span className="display-font" style={{ fontSize: 11, letterSpacing: 1 }}>BLIND REPORTS</span><br /><span style={hintStyle}>The Research Director sees reports as A, B, C without provider or model until you reveal them. Researchers never see each other either way.</span></span>
      </label>

      {problems.length > 0 && <div className="display-font" style={{ ...hintStyle, color: 'var(--color-warning)' }}>{problems.join(' ')}</div>}
      <button type="button" data-help="creator.research-start" disabled={problems.length > 0 || props.submitting} onClick={start} style={{ ...selectStyle(true), padding: '10px', opacity: problems.length > 0 || props.submitting ? 0.5 : 1 }}>
        {props.submitting ? 'STARTING...' : 'START RESEARCH PROJECT'}
      </button>
      {confirmMany && <DialogShell title="Start many researchers" size="confirm" dataHelp="creator.research-start" onClose={() => setConfirmMany(false)}
        actions={<><button type="button" style={small} onClick={() => setConfirmMany(false)}>CANCEL</button><button type="button" style={small} onClick={start}>START {rows.length} RESEARCHERS</button></>}>
        <p style={{ marginTop: 0 }}>Start {rows.length} researchers at once? Each one runs its own turns and uses its own quota.</p>
      </DialogShell>}
    </div>
  );
}
