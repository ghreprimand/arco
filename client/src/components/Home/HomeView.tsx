import { PRIMARY_PROVIDERS, type SessionInfo, type WorkflowConfig } from '@arco/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { useStartupStore } from '../../stores/startupStore';
import type { CreatorPrefill } from '../../stores/appStore.types';
import {
  groupProjects, openWork, organizationAvailable, parseProjects, projectLabels, scanFolderOf, searchProjects, workForProject,
  type HomeProject, type OpenWorkItem,
} from '../../utils/homeModel';
import { ProjectCard } from './ProjectCard';
import { AddProject } from './AddProject';
import { HomeStatus } from './HomeStatus';
import { defaultModelForProvider, useModelCatalogs } from '../../utils/modelCatalog';
import { clampEffortForModel } from '../../utils/format';
import { KIND_LABEL, when } from './homeStyles';

// Project-centered Home: open work, projects (search, groups, per-project open
// and saved work) and explicit Start actions. Everything here only navigates
// opens the existing creator, or explicitly resumes a saved session. Rendering
// sends no prompt. Incognito tabs never appear (see utils/homeModel.ts).

export function HomeView({ onResume }: { onResume?: (config: WorkflowConfig) => void } = {}) {
  const catalogs = useModelCatalogs();
  const jobs = useAppStore((s) => s.jobs);
  const clusters = useAppStore((s) => s.clusters);
  const setActiveJob = useAppStore((s) => s.setActiveJob);
  const setActiveCluster = useAppStore((s) => s.setActiveCluster);
  const openCreatorWith = useAppStore((s) => s.openCreatorWith);
  const setShowSettings = useAppStore((s) => s.setShowSettings);

  const [addOpen, setAddOpen] = useState(false);
  const [browserRoot, setBrowserRoot] = useState('');
  const [activity, setActivity] = useState<Record<string, number>>({});
  const noteActivity = useCallback((path: string, at: number) => setActivity(old => old[path] === at ? old : { ...old, [path]: at }), []);
  const [projects, setProjects] = useState<HomeProject[] | null>(null);
  const [organization, setOrganization] = useState(false);
  const [scanFolder, setScanFolder] = useState<string | null>(null);
  const [showScanned, setShowScanned] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [listStatus, setListStatus] = useState('');
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  // Every list reply (load or change) replaces the whole list.
  const applyList = useCallback((body: unknown): boolean => {
    const parsed = parseProjects(body);
    if (!parsed) return false;
    setProjects(parsed); setOrganization(organizationAvailable(body)); setScanFolder(scanFolderOf(body));
    const home = (body as { homeFolder?: unknown }).homeFolder;
    setBrowserRoot(scanFolderOf(body) ?? (typeof home === 'string' ? home : ''));
    return true;
  }, []);
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/projects', { cache: 'no-store' });
      if (!res.ok || !applyList(await res.json().catch(() => null))) throw Error(`The project list could not be loaded (${res.status}).`);
      setLoadError('');
    } catch (e) {
      setLoadError(e instanceof Error && e.message.startsWith('The project list') ? e.message : 'The project list could not be loaded. Check that the server is running, then try again.');
    }
  }, [applyList]);
  useEffect(() => { void load(); heading.current?.focus(); }, [load]);

  // `/` focuses project search unless the operator is typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault();
      search.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const work = useMemo(() => openWork(jobs, clusters), [jobs, clusters]);
  const shown = useMemo(() => searchProjects(projects ?? [], query), [projects, query]);
  const groups = useMemo(() => groupProjects([...shown].sort((a, b) => (activity[b.path] ?? 0) - (activity[a.path] ?? 0)), showArchived), [shown, showArchived, activity]);
  const labels = useMemo(() => projectLabels(projects ?? []), [projects]);
  const archivedCount = (projects ?? []).filter((p) => p.archived).length;
  const start = (prefill: CreatorPrefill) => openCreatorWith(prefill);
  const openItem = (item: OpenWorkItem) => (item.kind === 'cluster' ? setActiveCluster(item.id) : setActiveJob(item.id));

  const projectName = (item: OpenWorkItem) => {
    const project = projects?.find(project => workForProject(project, projects, [item]).length > 0);
    return project ? labels.get(project.path) ?? project.name : item.cwd.split(/[\\/]/).filter(Boolean).at(-1) || item.cwd;
  };

  const resume = (project: HomeProject, session: SessionInfo) => {
    if (!onResume) { start({ mode: 'single', workDir: project.path, resumeSessionId: session.sessionId }); return; }
    if (!useAppStore.getState().connected) { setListStatus('Reconnect to resume a saved session.'); return; }
    if (!PRIMARY_PROVIDERS.includes(session.provider) || (session.arcoInternal && !session.arcoWorkflowId)) { setListStatus('This saved session cannot be resumed with the available provider.'); return; }
    const model = defaultModelForProvider(session.provider, catalogs);
    onResume({
      name: session.arcoName || session.name || project.name, workingDirectory: project.path,
      primaryProvider: session.provider, primaryModel: model,
      primaryEffort: clampEffortForModel('low', session.provider, model, catalogs.claude, catalogs.codex),
      skipPermissions: false, providerAccountRef: session.providerAccountRef,
      ...(session.arcoInternal ? { resumeWorkflowId: session.arcoWorkflowId } : { resumeSessionId: session.sessionId }),
    });
  };

  return <main aria-labelledby="home-title" className="home-page">
    <div className="home-content">
      <header className="home-header">
        <div><span className="home-eyebrow">YOUR WORKSPACE</span><h1 id="home-title" ref={heading} tabIndex={-1}>HOME</h1>
          <p>{work.length ? 'Pick up where you left off.' : 'A place for projects, conversations, and your next idea.'}</p></div>
        <HomeStatus />
      </header>

      {work.length > 0 && <section aria-labelledby="home-open" data-help="home.open-work">
        <div className="home-section-heading"><h2 id="home-open">Open work <span className="home-count">({work.length})</span></h2><span className="home-fine-print">Work keeps running while you are here.</span></div>
        <ul className="home-work-grid">{work.map(item => <li key={`${item.kind}:${item.id}`}>
          <div className="home-work-details"><strong>{item.name}</strong><small>{KIND_LABEL[item.kind]}{item.cwd ? ` / ${projectName(item)}` : ' / No project'}{item.lastActivity ? ` / ${when(item.lastActivity)}` : ''}</small></div>
          <button type="button" className="home-primary" onClick={() => openItem(item)} aria-label={`Open ${KIND_LABEL[item.kind].toLowerCase()} ${item.name}`}>Resume</button>
        </li>)}</ul>
      </section>}

      <section aria-label="Start" data-help="home.start" className="home-start">
        <button type="button" className="home-primary" onClick={() => start({ mode: 'chat' })}>Start a chat</button>
        <span className="home-start-copy">Ask a question or think through an idea. No project needed.</span>
        <button type="button" onClick={() => start({ mode: 'single' })}>New session</button>
        <details className="home-more"><summary>More ways to start</summary><div>
          <button type="button" onClick={() => start({ mode: 'cluster' })}>New cluster</button>
          <button type="button" onClick={() => start({ mode: 'genesis' })}>New idea (Genesis)</button>
        </div></details>
      </section>

      <section aria-labelledby="home-projects" data-help="home.projects">
        <div className="home-project-tools"><h2 id="home-projects">Projects{projects && projects.length > 0 ? <span className="home-count">{projects.length}</span> : null}</h2>
          {projects?.length !== 0 && <button type="button" className="home-primary" data-add-project onClick={() => setAddOpen(true)}>Add project</button>}
        </div>
        {projects?.length !== 0 && <div className="home-search"><label htmlFor="home-search">Search projects (press /)</label>
          <input id="home-search" ref={search} type="search" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setQuery(''); }} placeholder="Name or folder" />
          <button type="button" onClick={() => void load()}>Reload list</button>
          {archivedCount > 0 && <button type="button" aria-pressed={showArchived} onClick={() => setShowArchived(!showArchived)}>{showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}</button>}
          <button type="button" onClick={() => { useStartupStore.getState().setSettingsSection('projects'); setShowSettings(true); }}>Manage projects in Settings</button>
        </div>}
        {!addOpen && <div role="status" aria-live="polite" className="home-feedback">{projects === null && !loadError ? 'Loading projects...' : query && projects ? `${shown.length} of ${projects.length} projects match.` : listStatus}</div>}
        {loadError && <p role="alert" className="home-feedback">{loadError}</p>}
        {projects && !organization && <p role="alert" className="home-feedback">Pinning, renaming, archiving and relocating are unavailable because the project record file could not be read or saved. Projects are still listed; nothing was changed.</p>}
        {projects && projects.length === 0 && <div className="home-empty"><div className="home-empty-symbol" aria-hidden="true">[ + ]</div>
          <h3>No projects yet</h3><p>Add a folder to keep its sessions close at hand. Projects can live anywhere the server can read, or start a chat without one. In Docker, only mounted folders are visible.</p>
          <button type="button" className="home-primary" data-add-project onClick={() => setAddOpen(true)}>Add project</button><p className="home-fine-print" style={{ marginTop: 12 }}>Browse, type a path, or create a folder.</p>
        </div>}
        {projects && projects.length > 0 && shown.length === 0 && <p className="home-feedback">No project matches "{query}".</p>}
        {groups.map(group => {
          const collapsed = group.key === 'scanned' && !query.trim() && !showScanned;
          return <section key={group.key} className="home-project-group" aria-labelledby={`home-group-${group.key}`}>
            <h3 id={`home-group-${group.key}`}>{group.key === 'scanned' ? `Found in ${scanFolder}` : group.title} ({group.projects.length}){group.key === 'scanned' && !query.trim() && <button type="button" aria-expanded={showScanned} onClick={() => setShowScanned(!showScanned)}>{showScanned ? 'Hide' : 'Show'}</button>}</h3>
            <p className="home-group-description">{group.key === 'registered' ? 'Recent conversations, ready to continue.' : group.description}</p>
            <ul hidden={collapsed} className="home-project-grid" style={collapsed ? { display: 'none' } : undefined}>
              {(!collapsed ? group.projects : []).map((project, index) => <ProjectCard key={`${project.id ?? ''}|${project.path}`} project={project} label={labels.get(project.path) ?? project.name}
                work={workForProject(project, projects ?? [], work)} organization={organization} preview={group.key !== 'scanned' && group.key !== 'archived' && project.exists && index < 12}
                onActivity={noteActivity} onResume={session => resume(project, session)} onOpen={openItem} onStart={start} onList={body => { if (!applyList(body)) void load(); }} announce={setListStatus} />)}
            </ul>
          </section>;
        })}
        {projects && !scanFolder && projects.length > 0 && <p className="home-fine-print">Optional folder discovery is available in Settings &gt; Projects. Folders are added only when chosen.</p>}
      </section>
    </div>
    {addOpen && <AddProject initialPath={browserRoot} scanFolder={scanFolder} onList={body => { if (!applyList(body)) void load(); }} onClose={() => setAddOpen(false)} announce={setListStatus} />}
  </main>;
}
