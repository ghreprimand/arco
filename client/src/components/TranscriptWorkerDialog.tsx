import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { PRIMARY_PROVIDERS, TERMINAL_CODEX_ACCOUNT, type EffortLevel, type ProviderName, type TranscriptWorkerPreview } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { useCodexCatalogFor } from '../hooks/useCodexCatalog';
import { defaultModelForProvider, modelsForProvider, useModelCatalogs } from '../utils/modelCatalog';
import { capDefaultEffort } from '../utils/effortDefaults';
import { effortsForModel } from '../utils/format';
import { requestTranscriptWorker } from '../utils/transcriptWorkerRequest';
import { DialogShell } from './DialogShell';
import { DirectoryBrowser } from './media/DirectoryPicker';

const field: CSSProperties = { width: '100%', minWidth: 0, display: 'block' };
const button: CSSProperties = { padding: '5px 10px', cursor: 'pointer', fontSize: '11px', letterSpacing: '1px' };
const labels: Record<ProviderName, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', ollama: 'Ollama', llamacpp: 'llama.cpp', lmstudio: 'LM Studio', strata: 'Strata', deepseek: 'DeepSeek', 'antigravity-cli': 'Antigravity CLI' };

export function TranscriptWorkerDialog({ workflowId, onCancel, onMembers }: { workflowId: string; onCancel: () => void; onMembers?: () => void }) {
  const job = useAppStore(s => s.jobs[workflowId]);
  const connected = useAppStore(s => s.connected);
  const settings = useAppStore(s => s.settings);
  const auth = useAppStore(s => s.authStatus);
  const enabled = useAppStore(s => s.isProviderEnabled);
  const sourceProvider = job?.config.primaryProvider ?? 'claude';
  const [turns, setTurns] = useState(3);
  const [includePartial, setIncludePartial] = useState(false);
  const [preface, setPreface] = useState('');
  const [directory, setDirectory] = useState(job?.config.workingDirectory ?? '');
  const [browse, setBrowse] = useState(false);
  const [name, setName] = useState(`Worker from ${job?.config.name ?? 'conversation'}`);
  const [provider, setProvider] = useState<ProviderName>(sourceProvider);
  const [model, setModel] = useState(String(job?.config.primaryModel ?? ''));
  const [effort, setEffort] = useState<EffortLevel>(capDefaultEffort(job?.config.primaryEffort ?? 'medium'));
  const [account, setAccount] = useState(sourceProvider === 'codex' ? job?.config.providerAccountRef ?? '' : '');
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [preview, setPreview] = useState<TranscriptWorkerPreview | null>(null);
  const [previewInput, setPreviewInput] = useState('');
  const [phase, setPhase] = useState<'preview' | 'create' | null>(null);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const codexCatalog = useCodexCatalogFor(account || undefined);
  const catalogs = useModelCatalogs({ codex: codexCatalog });
  const models = modelsForProvider(provider, catalogs).map(String);
  if (provider === sourceProvider && job?.config.primaryModel && !models.includes(String(job.config.primaryModel))) models.unshift(String(job.config.primaryModel));
  const effortOptions = effortsForModel(provider, model, catalogs.claude, codexCatalog);
  const offeredEfforts = effortOptions.length ? effortOptions : ['none' as const];
  useEffect(() => {
    if (!offeredEfforts.includes(effort)) setEffort(offeredEfforts.includes('medium') ? 'medium' : offeredEfforts[0]);
  }, [provider, model, offeredEfforts.join('|'), effort]);
  const providers = PRIMARY_PROVIDERS.filter(value => value !== 'antigravity-cli' && enabled(value) && !!auth?.[value]?.loggedIn);
  const prefaceBytes = new TextEncoder().encode(preface).length;
  const inputKey = JSON.stringify([turns, includePartial, preface]);
  const invalidate = () => { setPreview(null); setError(''); };
  const readPreview = async () => {
    if (!connected || prefaceBytes > 4096 || phase) return;
    setPhase('preview'); setError('');
    try {
      const result = await requestTranscriptWorker({ type: 'transcript_worker_preview', workflowId, turns, includePartial, preface });
      if (alive.current) {
        if (!result.preview) throw new Error('The preview is unavailable. Try again.');
        setPreview(result.preview);
        setPreviewInput(inputKey);
      }
    } catch (reason) { if (alive.current) { setPreview(null); setError(reason instanceof Error ? reason.message : String(reason)); } }
    finally { if (alive.current) setPhase(null); }
  };
  const create = async () => {
    if (!preview || phase || previewInput !== inputKey) return;
    setPhase('create'); setError('');
    try {
      const result = await requestTranscriptWorker({ type: 'transcript_worker_create', token: preview.token,
        destination: { workingDirectory: directory, name, provider, model, effort, ...(provider === 'codex' && account ? { providerAccountRef: account } : {}), skipPermissions } });
      if (alive.current) {
        if (!result.newWorkflowId) throw new Error('The worker could not be created. Refresh the preview.');
        useAppStore.getState().setActiveJob(result.newWorkflowId);
        onCancel();
      }
    } catch (reason) { if (alive.current) { setPreview(null); setError(reason instanceof Error ? reason.message : String(reason)); } }
    finally { if (alive.current) setPhase(null); }
  };
  if (!job) return null;
  return <DialogShell title="Send turns to a new worker" dataHelp="composer.transcript-worker" onClose={onCancel} width={760}
    status={error ? <span role="alert">{error}</span> : phase ? <span role="status">{phase === 'preview' ? 'Reading stored turns...' : 'Creating the worker...'}</span> : undefined}
    actions={<>
      {onMembers && <button type="button" data-help="composer.transcript-worker" style={button} disabled={!!phase} onClick={onMembers}>EXISTING MEMBERS</button>}
      <button type="button" data-help="composer.transcript-worker" style={button} disabled={!!phase} onClick={onCancel}>CANCEL</button>
      <button type="button" data-help="composer.transcript-worker-preview" style={button} disabled={!!phase || !connected || prefaceBytes > 4096} onClick={() => void readPreview()}>PREVIEW</button>
      <button type="button" data-help="composer.transcript-worker-send" style={button} disabled={!!phase || !preview || previewInput !== inputKey || !connected || !directory.trim() || !model || !providers.includes(provider)} onClick={() => void create()}>SEND TO NEW WORKER</button>
    </>}>
    <p>Source: {job.config.name}. Copy exact operator and agent text. Tools and attachments become receipts; attachment files are not copied.</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'end' }}>
      <label>Last turns<input className="arco-field" data-help="composer.transcript-worker-preview" aria-label="Turns to copy" type="number" min={1} max={50} value={turns} disabled={!!phase} onChange={event => { setTurns(Math.max(1, Math.min(50, Number(event.target.value) || 1))); invalidate(); }} style={{ ...field, width: '80px' }} /></label>
      <label><input type="checkbox" data-help="composer.transcript-worker-preview" checked={includePartial} disabled={!!phase || !job.busy} onChange={event => { setIncludePartial(event.target.checked); invalidate(); }} /> Include the current partial turn</label>
    </div>
    <label>Preface, placed before the copied turns<textarea className="arco-field" data-help="composer.transcript-worker-preview" aria-label="New worker preface" rows={3} value={preface} disabled={!!phase} onChange={event => { setPreface(event.target.value); invalidate(); }} style={{ ...field, resize: 'vertical' }} /></label>
    <div style={{ color: prefaceBytes > 4096 ? 'var(--color-warning)' : 'var(--color-fg-muted)' }}>{prefaceBytes} / 4096 preface bytes; the whole seed must fit 32768 bytes. Content is never silently clipped.</div>
    <label>New worker name<input className="arco-field" data-help="composer.transcript-worker-target" aria-label="New worker name" value={name} maxLength={120} disabled={!!phase} onChange={event => setName(event.target.value)} style={field} /></label>
    <label>Working directory<input className="arco-field" data-help="composer.transcript-worker-target" aria-label="New worker working directory" value={directory} disabled={!!phase} onChange={event => setDirectory(event.target.value)} style={field} /></label>
    <button type="button" data-help="composer.transcript-worker-target" style={{ ...button, justifySelf: 'start' }} disabled={!!phase} onClick={() => setBrowse(value => !value)}>BROWSE</button>
    {browse && <DirectoryBrowser inline withFilename={false} initialPath={directory} roots={settings?.projectRoots} title="New worker folder" confirmLabel="Use this folder" onDone={result => { if (result) setDirectory(result.dir); setBrowse(false); }} />}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
      <label style={{ flex: '1 1 150px', minWidth: 0 }}>Provider<select className="arco-field" data-help="composer.transcript-worker-target" aria-label="New worker provider" value={provider} disabled={!!phase} onChange={event => {
        const next = event.target.value as ProviderName; setProvider(next); setModel(defaultModelForProvider(next, catalogs)); setAccount('');
      }} style={field}>{!providers.includes(provider) && <option value={provider} disabled>{labels[provider] ?? provider} (not ready)</option>}{providers.map(value => <option key={value} value={value}>{labels[value]}</option>)}</select></label>
      <label style={{ flex: '2 1 200px', minWidth: 0 }}>Model<select className="arco-field" data-help="composer.transcript-worker-target" aria-label="New worker model" value={model} disabled={!!phase} onChange={event => setModel(event.target.value)} style={field}>{models.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>Effort<select className="arco-field" data-help="composer.transcript-worker-target" aria-label="New worker effort" value={effort} disabled={!!phase} onChange={event => setEffort(event.target.value as EffortLevel)} style={field}>{offeredEfforts.map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}</select></label>
    </div>
    {!providers.includes(provider) && <p role="status">{providers.length ? `${labels[provider] ?? provider} is not ready. Choose a connected provider.` : 'No connected provider is enabled. Connect or enable one in Settings before sending.'}</p>}
    {!models.length && <p role="status">No models are available for this provider. Choose another provider or configure it in Settings.</p>}
    {provider === 'codex' && <label>Account<select className="arco-field" data-help="composer.transcript-worker-target" aria-label="New worker account" value={account} disabled={!!phase} onChange={event => setAccount(event.target.value)} style={field}>
      <option value="">Default account</option><option value={TERMINAL_CODEX_ACCOUNT}>Terminal Codex account</option>{(settings?.providerAccounts?.codex ?? []).map(value => <option key={value.id} value={value.id}>{value.label}</option>)}
    </select></label>}
    <label><input type="checkbox" data-help="composer.transcript-worker-target" checked={skipPermissions} disabled={!!phase} onChange={event => setSkipPermissions(event.target.checked)} /> Skip permission prompts in the new worker</label>
    <p>The new worker starts a fresh provider conversation in the chosen folder. It inherits no source pins or cluster membership. The destination's own project settings apply.</p>
    {preview ? <>
      <div role="status">{preview.selectedTurns} of {preview.availableTurns} available turns selected; {preview.bytes} / 32768 seed bytes{preview.partialIncluded ? '; includes a partial-turn snapshot' : ''}.</div>
      <textarea className="arco-field" aria-label="New worker seed preview" data-help="composer.transcript-worker-preview" readOnly value={preview.seed} rows={9} style={{ ...field, fontFamily: 'var(--font-code)', resize: 'vertical' }} />
    </> : <p>PREVIEW reads the stored conversation. Review the exact seed before sending. Editing turns or preface requires a new preview.</p>}
  </DialogShell>;
}
