import { useEffect, useRef, useState } from 'react';
import { PRIMARY_PROVIDERS, type WorkflowConfig } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { useStartupStore } from '../stores/startupStore';
import { completeOnboarding } from '../utils/completeOnboarding';
import { DirectoryBrowser } from './media/DirectoryPicker';
import { anyPrimaryProviderConnected } from '../utils/startupGate';
import { Connections } from './Connections/Connections';
import { addFolder } from './Home/projectApi';
import { WorkflowCreator } from './WorkflowCreator';

// Sequence the existing folder registration, Connections and creator surfaces.
export function FirstRun({ onCreate }: { onCreate: (config: WorkflowConfig) => void }) {
  const [step, setStep] = useState<'welcome' | 'folder' | 'provider' | 'chat'>('welcome');
  const [path, setPath] = useState(''), [project, setProject] = useState('');
  const [scanCandidates, setScanCandidates] = useState<string[]>([]);
  const [browserKey, setBrowserKey] = useState(0);
  const [browserRoot, setBrowserRoot] = useState<string | null>(null);
  const [note, setNote] = useState(''), [busy, setBusy] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const auth = useAppStore(s => s.authStatus), settings = useAppStore(s => s.settings);
  const selectedProvider = useStartupStore(s => s.setupProvider);
  const enabled = (p: typeof PRIMARY_PROVIDERS[number]) => settings?.enabledProviders[p] !== false;
  const providerConnected = anyPrimaryProviderConnected(auth, enabled);
  const provider = PRIMARY_PROVIDERS.find(p => p === selectedProvider && enabled(p) && auth?.[p]?.loggedIn)
    ?? PRIMARY_PROVIDERS.find(p => enabled(p) && auth?.[p]?.loggedIn);
  useEffect(() => { title.current?.focus(); }, [step]);
  useEffect(() => {
    let alive = true;
    void fetch('/api/projects', { cache: 'no-store' }).then(async r => {
      if (!r.ok) throw new Error();
      const body = await r.json();
      if (alive) {
        const roots = Array.isArray(body.scanCandidates) ? body.scanCandidates.filter((p: unknown): p is string => typeof p === 'string').slice(0, 6) : [];
        setScanCandidates(roots);
        setBrowserRoot(roots[0] ?? body.homeFolder ?? '');
      }
    }).catch(() => { if (alive) { setBrowserRoot(''); setNote('Folder shortcuts are unavailable. Enter a folder path or browse below.'); } });
    return () => { alive = false; };
  }, []);
  const browse = (folder: string) => { setBrowserRoot(folder); setBrowserKey(key => key + 1); };
  const chooseFolder = async (folder: string) => {
    if (!folder.trim() || busy) return;
    setBusy(true); setNote('');
    const reply = await addFolder(folder.trim()); setBusy(false);
    if (!reply.ok) { setNote(reply.error); return; }
    setProject(folder.trim()); setStep('provider');
  };
  const finish = async (config?: WorkflowConfig) => {
    if (busy) return;
    setBusy(true); setNote('');
    try {
      await completeOnboarding();
      const startup = useStartupStore.getState();
      startup.setSetupDeferred(true); startup.setFirstRunOpen(false); startup.setSetupOpen(false);
      if (window.location.hash.startsWith('#connections')) window.history.replaceState(null, '', window.location.pathname + window.location.search);
      if (config) onCreate(config);
      else useAppStore.getState().showHomeView();
    } catch (error) { setNote(error instanceof Error ? error.message : 'Setup could not be saved. Retry.'); }
    finally { setBusy(false); }
  };
  const startChat = () => {
    useAppStore.getState().openCreatorWith({ mode: project ? 'single' : 'chat', ...(project ? { workDir: project } : {}) });
    setStep('chat'); setNote('');
  };
  if (step === 'provider') return <Connections mode="gate" onSkip={startChat} onContinue={startChat} canContinue={providerConnected} />;
  return <div className="connections-backdrop">
    <div className="connections-dialog first-run-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="first-run-title" onKeyDown={e => {
      if (e.key === 'Escape') { e.stopPropagation(); void finish(); }
      if (e.key !== 'Tab') return;
      const list = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]') ?? [])].filter(el => el.getClientRects().length > 0);
      const first = list[0], last = list.at(-1);
      if (e.shiftKey && (document.activeElement === first || document.activeElement === title.current)) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }}>
      <header className="connections-header"><div>
        <h1 id="first-run-title" ref={title} tabIndex={-1}>{step === 'welcome' ? 'Welcome to Arco' : step === 'folder' ? 'Add a project folder' : 'Start a chat'}</h1>
        <p>{step === 'welcome' ? 'Arco is a workbench for AI coding tools, projects, and a voice operator. Add a folder, connect a provider, then start a conversation in the existing workspace.' : step === 'folder' ? 'Step 1 of 3: choose an existing folder on the Arco server. In Docker, mount the folder first.' : 'Step 3 of 3: review the existing creator and launch when ready. No prompt is sent until a message is submitted.'}</p>
      </div><button type="button" disabled={busy} onClick={() => step === 'welcome' ? setStep('folder') : step === 'folder' ? setStep('provider') : void finish()}>Skip this step</button></header>
      {step === 'welcome' && <div className="connections-actions"><button type="button" onClick={() => setStep('folder')}>Get started</button><button type="button" disabled={busy} onClick={() => void finish()}>Skip setup</button></div>}
      {step === 'folder' && <section className="connection-detail">
        <form className="first-run-path" onSubmit={e => { e.preventDefault(); void chooseFolder(path); }}>
          <label htmlFor="first-run-folder">Project folder path</label>
          <input id="first-run-folder" value={path} onChange={e => setPath(e.target.value)} required placeholder="Absolute folder path" />
          <button type="submit" disabled={busy || !path.trim()}>Add folder and continue</button>
          <button type="button" disabled={busy || !path.trim()} onClick={() => browse(path.trim())}>Browse path</button>
        </form>
        <div className="first-run-shortcuts" aria-label="Folder shortcuts">
          {scanCandidates.map(root => <button type="button" key={root} title={root} onClick={() => browse(root)}>{root.split(/[\\/]/).filter(Boolean).at(-1)}</button>)}
        </div>
        {browserRoot !== null && <DirectoryBrowser key={browserKey} initialPath={browserRoot} inline withFilename={false} title="Browse project folders" confirmLabel={busy ? 'Adding...' : 'Use this folder'} onDone={result => { if (result) void chooseFolder(result.dir); }} />}
        <p>Browse any folder the server can read, or enter its absolute path. Configure optional folder scanning in Settings &gt; Projects.</p>
      </section>}
      {step === 'chat' && <div style={{ overflow: 'auto', minHeight: 240 }}>
        {!providerConnected && <p className="connections-scope">A provider is still needed to send messages. Skip to Home and connect one later, or return to Connections.</p>}
        <button type="button" onClick={() => setStep('provider')}>Back to Connections</button>
        <WorkflowCreator key={project} initialProvider={provider} onCreate={config => { void finish(config); }} />
      </div>}
      <p className="connections-note" role="status">{note}</p>
    </div>
  </div>;
}
