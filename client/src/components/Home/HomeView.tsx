import { PRIMARY_PROVIDERS, type SessionInfo, type WorkflowConfig } from '@arco/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { useStartupStore } from '../../stores/startupStore';
import type { CreatorPrefill } from '../../stores/appStore.types';
import {
  groupProjects, openWork, organizationAvailable, parseProjects, projectLabels, scanFolderOf, rootsOf, searchProjects, workForProject,
  type HomeProject, type HomeRoot, type OpenWorkItem,
} from '../../utils/homeModel';
import { ProjectCard } from './ProjectCard';
import { LocationDialog } from './LocationDialog';
import { AddProject } from './AddProject';
import { HomeStatus } from './HomeStatus';
import { defaultModelForProvider, useModelCatalogs } from '../../utils/modelCatalog';
import { clampEffortForModel } from '../../utils/format';
import { KIND_LABEL, when } from './homeStyles';

// Open work shows at most this many rows of cards; every project group shows
// this many entries until Show all. Expanded lists scroll inside a bound.
const WORK_ROWS = 2;
const GROUP_LIMIT = 6;

// Project-centered Home: open work, projects (search, groups, per-project open
// and saved work) and explicit Start actions. Everything here only navigates
// opens the existing creator, or explicitly resumes a saved session. Rendering
// sends no prompt. Incognito tabs never appear (see utils/homeModel.ts).

export function HomeView({ onResume }: { onResume?: (config: WorkflowConfig) => void } = {}) {
  const catalogs = useModelCatalogs();
  const projectSettingsKey = useAppStore(s => JSON.stringify([s.settings?.projectRoots, s.settings?.projects, s.settings?.defaultWorkingDirectory]));
  const jobs = useAppStore((s) => s.jobs);
  const clusters = useAppStore((s) => s.clusters);
  const setActiveJob = useAppStore((s) => s.setActiveJob);
  const setActiveCluster = useAppStore((s) => s.setActiveCluster);
  const openCreatorWith = useAppStore((s) => s.openCreatorWith);
  const setShowSettings = useAppStore((s) => s.setShowSettings);

  const [locationOpen, setLocationOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [workExpanded, setWorkExpanded] = useState(false);
  const [workColumns, setWorkColumns] = useState(3);
  const workProbe = useRef<HTMLDivElement>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [browserRoot, setBrowserRoot] = useState('');
  const [activity, setActivity] = useState<Record<string, number>>({});
  const noteActivity = useCallback((path: string, at: number) => setActivity(old => old[path] === at ? old : { ...old, [path]: at }), []);
  const [projects, setProjects] = useState<HomeProject[] | null>(null);
  const [organization, setOrganization] = useState(false);
  const [roots, setRoots] = useState<HomeRoot[] | undefined>();
  const [scanFolder, setScanFolder] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [listStatus, setListStatus] = useState('');
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const listRequest = useRef(0);

  // Every list reply (load or change) replaces the whole list.
  const applyList = useCallback((body: unknown): boolean => {
    const parsed = parseProjects(body);
    if (!parsed) return false;
    listRequest.current++; setLoadError('');
    setProjects(parsed); setOrganization(organizationAvailable(body)); setScanFolder(scanFolderOf(body)); setRoots(rootsOf(body));
    const home = (body as { homeFolder?: unknown }).homeFolder;
    setBrowserRoot(scanFolderOf(body) ?? (typeof home === 'string' ? home : ''));
    return true;
  }, []);
  const load = useCallback(async () => {
    const attempt = ++listRequest.current;
    try {
      const res = await fetch('/api/projects', { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (attempt !== listRequest.current) return;
      if (!res.ok || !applyList(body)) throw Error(`The project list could not be loaded (${res.status}).`);
      setLoadError('');
    } catch (e) {
      if (attempt !== listRequest.current) return;
      setLoadError(e instanceof Error && e.message.startsWith('The project list') ? e.message : 'The project list could not be loaded. Check that the server is running, then try again.');
    }
  }, [applyList]);
  useEffect(() => { void load(); return () => { listRequest.current++; }; }, [load, projectSettingsKey]);
  useEffect(() => { heading.current?.focus(); }, []);

  // `/` focuses project search unless the operator is typing somewhere.
  useEffect(() => {
    if (addOpen || locationOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault();
      search.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addOpen, locationOpen]);

  const work = useMemo(() => openWork(jobs, clusters), [jobs, clusters]);
  const hasWork = work.length > 0;
  // Open work shows two rows of cards. An empty auto-fill probe with the same
  // track sizing reports how many columns fit, independent of interface scale.
  useEffect(() => {
    const probe = workProbe.current;
    if (!probe || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const tracks = getComputedStyle(probe).gridTemplateColumns.split(' ').filter(Boolean).length;
      setWorkColumns(Math.max(1, tracks || 1));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(probe);
    return () => observer.disconnect();
  }, [hasWork]);
  const workLimit = workColumns * WORK_ROWS;
  const workShown = workExpanded ? work : work.slice(0, workLimit);
  const shown = useMemo(() => {
    const all = projects ?? [], found = searchProjects(all, query);
    const q = query.trim().toLowerCase();
    if (!q) return found;
    const locations = new Set((roots ?? []).filter(root => root.name.toLowerCase().includes(q)).map(root => root.path));
    const matches = new Set(found.map(project => project.path));
    return all.filter(project => matches.has(project.path) || !!project.rootPath && locations.has(project.rootPath));
  }, [projects, query, roots]);
  const groups = useMemo(() => groupProjects([...shown].sort((a, b) => (activity[b.path] ?? 0) - (activity[a.path] ?? 0)), showArchived, roots).filter(group => !query.trim() || group.projects.length || group.discovered?.length || group.title.toLowerCase().includes(query.trim().toLowerCase())), [shown, showArchived, activity, roots, query]);
  const labels = useMemo(() => projectLabels(projects ?? []), [projects]);
  const availableCount = (projects ?? []).filter(p => p.exists && !p.archived).length;
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

  const startControls = <section aria-label="Start" data-help="home.start" className={availableCount > 0 ? 'home-start home-start-compact' : 'home-start'}>
        <button type="button" className="home-primary" onClick={() => start({ mode: 'chat' })}>Start a chat</button>
        {availableCount === 0 && <span className="home-start-copy">Ask a question or think through an idea. No project needed.</span>}
        <button type="button" onClick={() => start({ mode: 'single' })}>New session</button>
        <details className="home-more"><summary>More ways to start</summary><div>
          <button type="button" onClick={() => start({ mode: 'cluster' })}>New cluster</button>
          <button type="button" onClick={() => start({ mode: 'genesis' })}>New idea (Genesis)</button>
        </div></details>
      </section>;

  return <main aria-labelledby="home-title" className="home-page">
    <div className="home-content">
      <header className={availableCount > 0 ? 'home-header home-header-compact' : 'home-header'}>
        <h1 id="home-title" className="home-wordmark" ref={heading} tabIndex={-1}>ARCO</h1>
        {(availableCount === 0 || work.length > 0) && <p>{work.length ? 'Pick up where you left off.' : 'A place for projects, conversations, and your next idea.'}</p>}
        <HomeStatus />
        {availableCount > 0 && work.length === 0 && startControls}
      </header>

      {work.length > 0 && <section aria-labelledby="home-open" data-help="home.open-work">
        <div className="home-section-heading"><h2 id="home-open">Open work <span className="home-count">({work.length})</span></h2><span className="home-fine-print">Work keeps running while you are here.</span></div>
        <div ref={workProbe} className="home-work-probe" aria-hidden="true" />
        <div id="home-open-list" className={workExpanded && work.length > workLimit ? 'home-bounded expanded' : 'home-bounded'}>
        <ul className="home-work-grid" aria-labelledby="home-open">{workShown.map(item => {
          const detail = `${KIND_LABEL[item.kind]}${item.cwd ? ` / ${projectName(item)}` : ' / No project'}${item.lastActivity ? ` / ${when(item.lastActivity)}` : ''}`;
          return <li key={`${item.kind}:${item.id}`}>
            <div className="home-work-details"><strong title={item.name}>{item.name}</strong><small title={item.cwd ? `${detail}\n${item.cwd}` : detail}>{detail}</small></div>
            <button type="button" className="home-primary" onClick={() => openItem(item)} aria-label={`Open ${KIND_LABEL[item.kind].toLowerCase()} ${item.name}`}>Resume</button>
          </li>;
        })}</ul>
        </div>
        {work.length > workLimit && <button type="button" className="home-show-all" aria-expanded={workExpanded} aria-controls="home-open-list" onClick={() => setWorkExpanded(open => !open)}>{workExpanded ? 'Show fewer' : `Show all ${work.length}`}</button>}
      </section>}

      {(availableCount === 0 || work.length > 0) && startControls}

      <section aria-labelledby="home-projects" data-help="home.projects">
        <div className="home-project-tools"><h2 id="home-projects">Project locations</h2>
          <button type="button" className="home-primary" data-add-location onClick={() => setLocationOpen(true)}>Add project location</button>
          <button type="button" data-open-folder onClick={() => setAddOpen(true)}>Open another folder</button>
        </div>
        {projects && projects.length === 0 && !roots?.length && <p className="home-location-intro">Add a location containing your projects, such as Work or Personal, or open a single folder. In Docker, mount folders first.</p>}
        {projects?.length !== 0 && <div className="home-search"><label htmlFor="home-search">Search folders (press /)</label>
          <input id="home-search" ref={search} type="search" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setQuery(''); }} placeholder="Name or folder" />
          <button type="button" onClick={() => void load()}>Reload list</button>
          {archivedCount > 0 && <button type="button" aria-pressed={showArchived} onClick={() => setShowArchived(!showArchived)}>{showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}</button>}
          <button type="button" onClick={() => { useStartupStore.getState().setSettingsSection('projects'); setShowSettings(true); }}>Manage locations</button>
        </div>}
        {!addOpen && !locationOpen && <div role="status" aria-live="polite" className="home-feedback">{projects === null && !loadError ? 'Loading folders...' : query && projects ? `${shown.length} of ${projects.length} folders match.` : listStatus}</div>}
        {loadError && <p role="alert" className="home-feedback">{loadError}</p>}
        {projects && !organization && <p role="alert" className="home-feedback">Pinning, renaming, archiving and relocating are unavailable because the project record file could not be read or saved. Folders are still listed; nothing was changed.</p>}
        {projects && availableCount === 0 && projects.length > 0 && !query && <p className="home-feedback">No available folders. Reconnect a missing location or open another folder.</p>}
        {projects && projects.length > 0 && shown.length === 0 && <p className="home-feedback">No folder matches "{query}".</p>}
        <div className="home-location-groups">
        {groups.map(group => {
          const more = group.discovered ?? [];
          const showAll = !!query.trim() || expanded.has(group.path || group.key);
          const totalChoices = group.projects.length + more.length;
          const limit = showAll ? Infinity : GROUP_LIMIT;
          const cards = group.projects.slice(0, limit);
          const folderChoices = more.slice(0, Math.max(0, limit - cards.length));
          return <section key={group.key} className="home-project-group" aria-labelledby={`home-group-${group.key}`}>
            <div className="home-location-heading"><div>{group.path && <span className="home-location-kicker">PROJECT LOCATION</span>}<h3 id={`home-group-${group.key}`}>{group.path ? group.title : group.key === 'scanned' ? 'Available folders' : group.title}
              {' '}<span className="home-count">{group.path ? `${group.folderCount} ${group.folderCount === 1 ? 'folder' : 'folders'}` : `${group.projects.length}`}{!!group.unavailableCount && ` / ${group.unavailableCount} unavailable`}</span></h3>
              {group.path && <p className="home-location-path" title={group.path}>{group.path}</p>}</div>
              {group.path && <button type="button" onClick={() => { setBrowserRoot(group.path!); setAddOpen(true); }}>Browse {group.title}</button>}
            </div>
            {group.exists === false && <p className="home-group-description">Location not reachable. Reconnect the drive or edit it in Settings &gt; Projects.</p>}
            {!!group.pinnedCount && <p className="home-fine-print">Pinned folders from this location appear above.</p>}
            <div id={`home-group-list-${group.key}`} className={showAll && totalChoices > GROUP_LIMIT ? 'home-location-folders expanded' : 'home-location-folders'}>
            <ul className="home-project-grid">
              {cards.map((project, index) => <ProjectCard key={`${project.id ?? ''}|${project.path}`} project={project} label={labels.get(project.path) ?? project.name}
                work={workForProject(project, projects ?? [], work)} organization={organization} preview={project.source !== 'scanned' && group.key !== 'archived' && project.exists && index < 12}
                onActivity={noteActivity} onResume={session => resume(project, session)} onOpen={openItem} onStart={start} onList={body => { if (!applyList(body)) void load(); }} announce={setListStatus} />)}
            </ul>
            {!!more.length && <div className="home-folder-choices">
              <ul className="home-folder-list" aria-label={`Folders in ${group.title}`}>
                {folderChoices.map(project => <li key={project.path}><button type="button" disabled={!project.exists} aria-label={`Open ${labels.get(project.path) ?? project.name}`} title={project.path} onClick={() => start({ mode: 'single', workDir: project.path })}><strong>{labels.get(project.path) ?? project.name}</strong><span>{project.path}</span></button></li>)}
              </ul>
            </div>}
            </div>
            {totalChoices > GROUP_LIMIT && !query.trim() && <button type="button" className="home-show-all" aria-expanded={showAll} aria-controls={`home-group-list-${group.key}`} onClick={() => setExpanded(old => { const next = new Set(old); const key = group.path || group.key; if (next.has(key)) next.delete(key); else next.add(key); return next; })}>{showAll ? 'Show fewer' : `Show all ${totalChoices} folders`}</button>}
          </section>;
        })}
        </div>

      </section>
    </div>
    {locationOpen && <LocationDialog initialPath={browserRoot} onClose={() => setLocationOpen(false)} onSaved={saved => { applyList(saved.list); setListStatus(saved.message); setLocationOpen(false); }} />}
    {addOpen && <AddProject onChoose={path => { setAddOpen(false); start({ mode: 'single', workDir: path }); }} roots={roots} initialPath={browserRoot} scanFolder={scanFolder} onList={body => { if (!applyList(body)) void load(); }} onClose={() => setAddOpen(false)} announce={setListStatus} />}
  </main>;
}
