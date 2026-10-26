import { useEffect, useRef, useState } from 'react';
import { PRIMARY_PROVIDERS, type WorkflowConfig } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { useStartupStore } from '../stores/startupStore';
import { completeOnboarding } from '../utils/completeOnboarding';
import { parseProjects, type HomeProject } from '../utils/homeModel';
import { anyPrimaryProviderConnected } from '../utils/startupGate';
import { Connections } from './Connections/Connections';
import { addFolder } from './Home/projectApi';
import { WorkflowCreator } from './WorkflowCreator';

// Sequence the existing folder registration, Connections and creator surfaces.
export function FirstRun({ onCreate }: { onCreate: (config: WorkflowConfig) => void }) {
  const [step, setStep] = useState<'welcome' | 'folder' | 'provider' | 'chat'>('welcome');
  const [path, setPath] = useState(''), [project, setProject] = useState('');
  const [projects, setProjects] = useState<HomeProject[]>([]);
  const [note, setNote] = useState(''), [busy, setBusy] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const auth = useAppStore(s => s.authStatus), settings = useAppStore(s => s.settings);
  const selectedProvider = useStartupStore(s => s.setupProvider);
  const [scanRoot, setScanRoot] = useState(settings?.defaultWorkingDirectory ?? '');
  const enabled = (p: typeof PRIMARY_PROVIDERS[number]) => settings?.enabledProviders[p] !== false;
  const providerConnected = anyPrimaryProviderConnected(auth, enabled);
  const provider = PRIMARY_PROVIDERS.find(p => p === selectedProvider && enabled(p) && auth?.[p]?.loggedIn)
    ?? PRIMARY_PROVIDERS.find(p => enabled(p) && auth?.[p]?.loggedIn);
  useEffect(() => { title.current?.focus(); }, [step]);
  useEffect(() => {
    let alive = true;
    void fetch('/api/projects', { cache: 'no-store' }).then(async r => {
      if (!r.ok) throw new Error();
      const list = parseProjects(await r.json());
      if (!list) throw new Error();
      if (alive) setProjects(list.filter(p => p.exists && !p.archived));
    }).catch(() => { if (alive) setNote('Project discovery is unavailable. Enter a folder path or skip this step.'); });
    return () => { alive = false; };
  }, []);
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
    <div className="connections-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="first-run-title" onKeyDown={e => {
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
        <form onSubmit={async e => {
          e.preventDefault(); if (!path.trim() || busy) return;
          setBusy(true); setNote('');
          const reply = await addFolder(path.trim()); setBusy(false);
          if (!reply.ok) { setNote(reply.error); return; }
          setProject(path.trim()); setStep('provider');
        }}>
          <label htmlFor="first-run-folder">Project folder path</label>
          <input id="first-run-folder" value={path} onChange={e => setPath(e.target.value)} required />
          <button type="submit" disabled={busy || !path.trim()}>Add folder and continue</button>
        </form>
        <p>Existing folders from Home discovery:</p>
        <form onSubmit={async e => {
          e.preventDefault(); if (busy) return;
          setBusy(true); setNote('');
          try {
            const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defaultWorkingDirectory: scanRoot.trim() }) });
            if (!res.ok) throw new Error('The scan folder could not be saved.');
            useAppStore.getState().setSettings(await res.json());
            const listed = await fetch('/api/projects', { cache: 'no-store' });
            const list = listed.ok ? parseProjects(await listed.json()) : null;
            if (!list) throw new Error('Project discovery is unavailable. Enter a project path directly.');
            setProjects(list.filter(p => p.exists && !p.archived));
            setNote(list.length ? 'Choose a discovered folder below.' : 'No project folders found. Enter a path directly or choose another scan folder.');
          } catch (error) { setNote(error instanceof Error ? error.message : 'Discovery failed. Retry.'); }
          finally { setBusy(false); }
        }}>
          <label htmlFor="first-run-scan">Folder to scan</label>
          <input id="first-run-scan" value={scanRoot} onChange={e => setScanRoot(e.target.value)} />
          <button type="submit" disabled={busy}>Scan folder</button>
        </form>
        {projects.map(p => <button type="button" key={p.path} onClick={() => setPath(p.path)}>{p.name}: {p.path}</button>)}
        <p>Folder discovery uses the Projects scan folder in Settings. Any readable absolute folder can be added directly.</p>
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
