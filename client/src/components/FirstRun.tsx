import { useEffect, useRef, useState } from 'react';
import { PRIMARY_PROVIDERS } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { useStartupStore } from '../stores/startupStore';
import { completeOnboarding } from '../utils/completeOnboarding';
import { ProjectLocationForm } from './ProjectLocationForm';
import { DirectoryBrowser } from './media/DirectoryPicker';
import { anyPrimaryProviderConnected, PROVIDER_LABELS } from '../utils/startupGate';
import { Connections } from './Connections/Connections';
import { parseProjects, rootsOf, type HomeProject, type HomeRoot } from '../utils/homeModel';
import { addFolder, removeFromList } from './Home/projectApi';

// Sequence the existing folder registration, Connections and creator surfaces.
export function FirstRun() {
  const [step, setStep] = useState<'welcome' | 'folder' | 'provider' | 'complete'>('welcome');
  const [path, setPath] = useState(''), [project, setProject] = useState('');
  const [roots, setRoots] = useState<HomeRoot[]>([]);
  const [projects, setProjects] = useState<HomeProject[]>([]);
  const [kind, setKind] = useState<'project' | 'root'>('root');
  const [locationKey, setLocationKey] = useState(0);
  const [loaded, setLoaded] = useState(false);
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
        setRoots(rootsOf(body) ?? []); setProjects((parseProjects(body) ?? []).filter(p => p.source === 'registered')); setLoaded(true);
        setScanCandidates(roots);
        setBrowserRoot(roots[0] ?? body.homeFolder ?? '');
      }
    }).catch(() => { if (alive) { setBrowserRoot(''); setNote('Folder shortcuts are unavailable. Enter a folder path or browse below.'); } });
    return () => { alive = false; };
  }, []);
  const browse = (folder: string) => { setBrowserRoot(folder); setBrowserKey(key => key + 1); };
  const saveRoots = async (next: Array<{ name: string; path: string }>) => {
    const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectRoots: next }) });
    if (!res.ok) throw new Error('Locations were not saved. Check the absolute folder path.');
    useAppStore.getState().setSettings(await res.json());
    const reply = await fetch('/api/projects');
    if (!reply.ok) throw new Error('Locations could not be refreshed. Retry.');
    setRoots(rootsOf(await reply.json()) ?? []);
  };
  const chooseFolder = async (folder: string) => {
    if (!folder.trim() || busy || !loaded) return;
    setBusy(true); setNote('');
    try {
      const reply = await addFolder(folder.trim());
      if (!reply.ok) throw new Error(reply.error);
      setProjects((parseProjects(reply.body) ?? []).filter(p => p.source === 'registered'));
      setProject(folder.trim());
      setPath(''); setNote('Added. Add another folder or continue when ready.');
    } catch (error) { setNote(error instanceof Error ? error.message : 'Folder was not added.'); }
    finally { setBusy(false); }
  };
  const removeChoice = async (folder: string, root: boolean) => {
    setBusy(true); setNote('');
    try {
      if (root) await saveRoots(roots.filter(r => r.path !== folder));
      else {
        const reply = await removeFromList(folder);
        if (!reply.ok) throw new Error(reply.error);
        setProjects((parseProjects(reply.body) ?? []).filter(p => p.source === 'registered'));
        if (project === folder) setProject('');
      }
    } catch (err) { setNote(err instanceof Error ? err.message : 'Choice was not removed.'); }
    finally { setBusy(false); }
  };
  const summary = <div aria-label="Setup folder choices"><h2>Folder choices</h2>
    <ul>{roots.map(root => <li key={`root-${root.path}`}><strong>{root.name}</strong> / Location: {root.path}{!root.exists ? ' (not reachable)' : ''}{step === 'folder' && <button type="button" disabled={busy} aria-label={`Remove setup location ${root.name}`} onClick={() => void removeChoice(root.path, true)}>Remove</button>}</li>)}
      {projects.map(folder => <li key={`project-${folder.path}`}>Project: {folder.name} / {folder.path}{step === 'folder' && <button type="button" disabled={busy} aria-label={`Remove setup project ${folder.name}`} onClick={() => void removeChoice(folder.path, false)}>Remove</button>}</li>)}
    </ul>{!roots.length && !projects.length && <p>No folders added yet.</p>}
    {step === 'folder' && <p>Existing folders and saved work stay in place.</p>}
  </div>;
  const finish = async (openChat = false) => {
    if (busy) return;
    setBusy(true); setNote('');
    try {
      await completeOnboarding();
      const startup = useStartupStore.getState();
      startup.setSetupDeferred(true); startup.setFirstRunOpen(false); startup.setSetupOpen(false);
      if (window.location.hash.startsWith('#connections')) window.history.replaceState(null, '', window.location.pathname + window.location.search);
      if (openChat) useAppStore.getState().openCreatorWith({ mode: project ? 'single' : 'chat', ...(project ? { workDir: project } : {}), provider });
      else useAppStore.getState().showHomeView();
    } catch (error) { setNote(error instanceof Error ? error.message : 'Setup could not be saved. Retry.'); }
    finally { setBusy(false); }
  };
  const complete = () => { setStep('complete'); setNote(''); };
  if (step === 'provider') return <Connections mode="gate" onSkip={complete} onContinue={complete} canContinue={providerConnected} />;
  return <div className="connections-backdrop">
    <div className={`connections-dialog first-run-dialog${step === 'folder' ? ' first-run-folder-step' : ''}`}  ref={dialog} role="dialog" aria-modal="true" aria-labelledby="first-run-title" onKeyDown={e => {
      if (e.key === 'Escape') { e.stopPropagation(); void finish(); }
      if (e.key !== 'Tab') return;
      const list = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]') ?? [])].filter(el => el.getClientRects().length > 0);
      const first = list[0], last = list.at(-1);
      if (e.shiftKey && (document.activeElement === first || document.activeElement === title.current)) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }}>
      <header className="connections-header"><div>
        <h1 id="first-run-title" ref={title} tabIndex={-1}>{step === 'welcome' ? 'Welcome to Arco' : step === 'folder' ? 'Add project locations' : 'Setup complete'}</h1>
        <p>{step === 'welcome' ? 'Arco is a workbench for AI coding tools, projects, and a voice operator. Add a folder, connect a provider, then start a conversation in the existing workspace.' : step === 'folder' ? 'Step 1 of 3: choose locations containing projects, such as Work or Personal. Add more than one, then Continue. In Docker, mount folders first.' : 'Your setup is ready. Go to Home or open a chat when you are ready.'}</p>
      </div>{step !== 'complete' && <button type="button" disabled={busy} onClick={() => step === 'welcome' ? setStep('folder') : step === 'folder' ? setStep('provider') : void finish()}>Skip this step</button>}</header>
      {step === 'welcome' && <div className="connections-actions"><button type="button" onClick={() => setStep('folder')}>Get started</button><button type="button" disabled={busy} onClick={() => void finish()}>Skip setup</button></div>}
      {step === 'folder' && <section className="connection-detail project-folders-ui">
        {summary}
        <div className="location-mode"><h2>{kind === 'root' ? 'Add project location' : 'Add a single project folder'}</h2>
          <button type="button" disabled={busy} onClick={() => { setKind(kind === 'root' ? 'project' : 'root'); setNote(''); }}>{kind === 'root' ? 'Add a single project folder' : 'Add project location'}</button>
        </div>
        {kind === 'root' ? <ProjectLocationForm autoFocus={false} key={locationKey} initialPath={browserRoot || ''} resetAfterSave onBusyChange={value => { setBusy(value); if (value) setNote(''); }} shortcuts={scanCandidates.map(path => ({ name: path.split(/[\\/]/).filter(Boolean).at(-1) || path, path }))} onSaved={saved => { setRoots(rootsOf(saved.list) ?? []); setProjects((parseProjects(saved.list) ?? []).filter(p => p.source === 'registered')); setNote(saved.message + ' Add another location or continue.'); }} /> : <>
          <form className="first-run-path" onSubmit={e => { e.preventDefault(); void chooseFolder(path); }}>
            <label htmlFor="first-run-folder">Project folder path</label>
            <input id="first-run-folder" value={path} onChange={e => setPath(e.target.value)} required placeholder="Absolute folder path" />
            <button type="submit" disabled={busy || !loaded || !path.trim()}>Add folder</button>
            <button type="button" disabled={busy || !loaded || !path.trim()} onClick={() => browse(path.trim())}>Browse path</button>
          </form>
          <div className="first-run-shortcuts" aria-label="Folder shortcuts">{scanCandidates.map(root => <button type="button" key={root} title={root} onClick={() => browse(root)}>{root.split(/[\\/]/).filter(Boolean).at(-1)}</button>)}</div>
          {browserRoot !== null && <DirectoryBrowser roots={roots} key={browserKey} initialPath={browserRoot} inline withFilename={false} title="Browse project folders" confirmLabel={busy ? 'Adding...' : 'Add this folder'} onDone={result => { if (result) void chooseFolder(result.dir); }} />}
          <p>A single folder is useful for a one-off project outside your usual locations.</p>
        </>}

      </section>}
      {step === 'folder' && <footer className="setup-folder-actions connections-actions"><button type="button" disabled={busy} onClick={() => { setPath(''); if (kind === 'root') { setLocationKey(key => key + 1); requestAnimationFrame(() => dialog.current?.querySelector<HTMLInputElement>('.location-editor input')?.focus()); } else document.getElementById('first-run-folder')?.focus(); }}>Add another</button><button type="button" disabled={busy} onClick={() => { setStep('provider'); setNote(''); }}>Continue</button></footer>}
      {step === 'complete' && <section className="connection-detail project-folders-ui">
        {summary}
        <label>Chat folder (optional)<select aria-label="Chat folder" value={project} onChange={e => setProject(e.target.value)}><option value="">No folder - start a chat</option>{projects.map(folder => <option key={folder.path} value={folder.path}>{folder.name}</option>)}</select></label>
        <p>Provider: {provider ? `${PROVIDER_LABELS[provider]} connected` : 'none yet, connect later in Connections'}</p>
        <div className="connections-actions" style={{ margin: 0 }}>
          <button type="button" disabled={busy} style={{ borderColor: 'var(--color-accent-primary)', color: 'var(--color-accent-primary)' }} onClick={() => void finish()}>Go to Home</button>
          <button type="button" disabled={busy} onClick={() => void finish(true)}>Start a chat</button>
        </div>
      </section>}
      <p className="connections-note" role="status">{note}</p>
    </div>
  </div>;
}
