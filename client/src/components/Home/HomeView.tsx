import { PRIMARY_PROVIDERS, TERMINAL_CODEX_ACCOUNT, type SessionInfo, type WorkflowConfig } from '@arco/shared';
import { TabStatusChip, useTabStatus } from '../TabStatusChip';
import { clusterHasIdleMail } from '../../utils/tabStatus';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { useStartupStore } from '../../stores/startupStore';
import type { CreatorPrefill } from '../../stores/appStore.types';
import {
  openWork, boundProjects, conversationStarted, organizationAvailable, parseProjects, projectLabels, scanFolderOf, rootsOf, searchProjects, workForProject,
  type HomeProject, type HomeRoot, type OpenWorkItem,
} from '../../utils/homeModel';
import { ProjectCard } from './ProjectCard';
import { LocationDialog } from './LocationDialog';
import { AddProject } from './AddProject';
import { HomeStatus } from './HomeStatus';
import { defaultModelForProvider, useModelCatalogs } from '../../utils/modelCatalog';
import { clampEffortForModel } from '../../utils/format';
import { KIND_LABEL, when } from './homeStyles';
import { hasWaitingQuestion } from '../../questions/waitingQuestion';
import { turnStep } from '../../utils/turnStep';
import { anyPrimaryProviderConnected } from '../../utils/startupGate';
import { useKeepInWindow } from '../../layout/keepInWindow';

function readHomeMarker(key: string): boolean {
  try { return localStorage.getItem(key) === '1'; } catch { return false; }
}

function writeHomeMarker(key: string): void {
  try { localStorage.setItem(key, '1'); } catch { /* Applies in this view until reload. */ }
}

const availableProjects = (projects: HomeProject[]) => projects.filter(p => p.exists && !p.archived).length;

// Open work shows at most this many rows of cards; every project group shows
// this many entries until Show all. Expanded lists scroll inside a bound.
const WORK_ROWS = 2;


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
  const [location, setLocation] = useState('');
  const [hasChatted, setHasChatted] = useState(() => readHomeMarker('arco-home-started-chat'));
  const [savedChats, setSavedChats] = useState(0);
  const [savedClusters, setSavedClusters] = useState(0);
  const [guideHidden, setGuideHidden] = useState(() => readHomeMarker('arco-home-guide-hidden'));
  useEffect(() => {
    let alive = true;
    void fetch('/api/chats').then(r => r.ok ? r.json() : null).then(body => {
      if (alive && Array.isArray(body?.chats)) {
        const n = body.chats.filter((chat: { config?: { voiceOperator?: boolean } }) => !chat.config?.voiceOperator).length;
        setSavedChats(n);
        if (n > 0) { writeHomeMarker('arco-home-started-chat'); setHasChatted(true); }
      }
    }).catch(() => {});
    void fetch('/api/clusters').then(r => r.ok ? r.json() : null).then(body => {
      if (alive && Array.isArray(body?.clusters)) setSavedClusters(body.clusters.length);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const settings = useAppStore(s => s.settings);
  const auth = useAppStore(s => s.authStatus);
  const [workExpanded, setWorkExpanded] = useState(false);
  const [workColumns, setWorkColumns] = useState(3);
  const workProbe = useRef<HTMLDivElement>(null);
  const projectProbe = useRef<HTMLDivElement>(null);
  const [projectColumns, setProjectColumns] = useState(3);
  const [projectsExpanded, setProjectsExpanded] = useState(false);
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
  const moreRef = useKeepInWindow();
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

  const membersFor = (item: OpenWorkItem) => item.kind === 'cluster' ? (clusters[item.id]?.members ?? []).map(m => jobs[m.workflowId]).filter(Boolean) : [jobs[item.id]].filter(Boolean);
  const waitingFor = (item: OpenWorkItem) => membersFor(item).some(hasWaitingQuestion);
  const work = useMemo(() => openWork(jobs, clusters).sort((a, b) => Number(waitingFor(b)) - Number(waitingFor(a))), [jobs, clusters]);
  const running = work.filter(item => membersFor(item).some(job => job.busy)).length;
  const waiting = work.filter(waitingFor).length;
  const providerReady = anyPrimaryProviderConnected(auth, p => settings?.enabledProviders?.[p] !== false, settings?.claude?.transport);
  const chatOpen = work.some(item => item.kind === 'chat');
  const savedSessions = Object.values(activity).filter(at => at > 0).length;
  const started = conversationStarted({ openWork: work.length, savedChats, savedClusters, savedSessions, remembered: hasChatted });
  useEffect(() => { if (chatOpen && !hasChatted) { writeHomeMarker('arco-home-started-chat'); setHasChatted(true); } }, [chatOpen, hasChatted]);
  const gettingStarted = projects !== null && !guideHidden && (!providerReady || availableProjects(projects) === 0 || !started);
  const operatorName = settings?.operatorName?.trim();
  const hour = new Date().getHours();
  const greeting = operatorName ? `Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}, ${operatorName}` : 'Welcome back';
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
  const filtered = useMemo(() => {
    const visible = shown.filter(p => (showArchived || !p.archived) && (!location || p.rootPath === location));
    const latest = new Map(visible.map(project => [project.path, Math.max(activity[project.path] ?? 0, ...workForProject(project, projects ?? [], work).map(item => item.lastActivity))]));
    return visible.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (latest.get(b.path) ?? 0) - (latest.get(a.path) ?? 0));
  }, [shown, showArchived, location, activity, projects, work]);
  const labels = useMemo(() => projectLabels(projects ?? []), [projects]);
  const availableCount = (projects ?? []).filter(p => p.exists && !p.archived).length;
  const archivedCount = (projects ?? []).filter((p) => p.archived).length;
  const showProjects = availableCount > 0 || !gettingStarted || !!loadError || archivedCount > 0;
  useEffect(() => {
    const probe = projectProbe.current;
    if (!probe || typeof ResizeObserver === 'undefined') return;
    const measure = () => setProjectColumns(Math.max(1, getComputedStyle(probe).gridTemplateColumns.split(' ').filter(Boolean).length || 1));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(probe);
    return () => observer.disconnect();
  }, [showProjects]);
  const bound = boundProjects(filtered, projectColumns, projectsExpanded, query.trim().length > 0);
  const start = (prefill: CreatorPrefill) => openCreatorWith(prefill);
  const openItem = (item: OpenWorkItem) => (item.kind === 'cluster' ? setActiveCluster(item.id) : setActiveJob(item.id));

  const projectName = (item: OpenWorkItem) => {
    const project = projects?.find(project => workForProject(project, projects, [item]).length > 0);
    return project ? labels.get(project.path) ?? project.name : item.cwd.split(/[\\/]/).filter(Boolean).at(-1) || item.cwd;
  };

  const resume = (project: HomeProject, session: SessionInfo, terminal = false) => {
    if (!onResume) { start({ mode: 'single', workDir: project.path, resumeSessionId: session.sessionId }); return; }
    if (!useAppStore.getState().connected) { setListStatus('Reconnect to resume a saved session.'); return; }
    if (!PRIMARY_PROVIDERS.includes(session.provider) || (session.arcoInternal && !session.arcoWorkflowId)) { setListStatus('This saved session cannot be resumed with the available provider.'); return; }
    const model = defaultModelForProvider(session.provider, catalogs);
    onResume({
      name: session.arcoName || session.name || project.name, workingDirectory: project.path,
      primaryProvider: session.provider, primaryModel: model,
      primaryEffort: clampEffortForModel('low', session.provider, model, catalogs.claude, catalogs.codex),
      skipPermissions: false, providerAccountRef: terminal && session.provider === 'codex' ? TERMINAL_CODEX_ACCOUNT : session.providerAccountRef,
      ...(terminal && session.provider === 'claude' ? { claudeTransport: 'cli' as const } : {}),
      ...(session.arcoInternal ? { resumeWorkflowId: session.arcoWorkflowId } : { resumeSessionId: session.sessionId }),
    });
  };

  const startControls = <section aria-label="Start" data-help="home.start" className="home-start">
        <button type="button" className="home-start-tile home-primary" aria-label="Start a chat" onClick={() => start({ mode: 'chat' })}><strong>Start a chat</strong><span>Ask a question or explore an idea.</span></button>
        <button type="button" className="home-start-tile" aria-label="New session" onClick={() => start({ mode: 'single' })}><strong>New session</strong><span>Work on a project with an agent.</span></button>
        <button type="button" className="home-start-tile" aria-label="New cluster" onClick={() => start({ mode: 'cluster' })}><strong>New cluster</strong><span>Coordinate a team of agents.</span></button>
        <details className="home-more"><summary>More ways to start</summary><div ref={moreRef}><button type="button" onClick={() => start({ mode: 'genesis' })}>New idea (Genesis)</button></div></details>
      </section>;

  return <main aria-labelledby="home-title" className="home-page">
    <div className="home-content">
      <header className="home-header">
        <h1 id="home-title" ref={heading} tabIndex={-1}>{greeting}</h1>
        <HomeStatus running={running} waiting={waiting} />
      </header>
      {startControls}
      {gettingStarted && <section className="home-getting-started" aria-label="Getting started" data-help="home.getting-started"><button type="button" className="home-guide-hide" aria-label="Hide the getting started guide" data-help="home.getting-started-hide" onClick={() => { writeHomeMarker('arco-home-guide-hidden'); setGuideHidden(true); }}>HIDE</button><h2>Getting started</h2><p>Three steps to your first conversation.</p><ol>
        <li><span>{providerReady ? '✓' : '1'}</span><a href="#connections">Connect a provider</a></li>
        <li><span>{availableCount ? '✓' : '2'}</span><button type="button" onClick={() => setLocationOpen(true)}>Add a project folder</button></li>
        <li><span>{started ? '✓' : '3'}</span><button type="button" onClick={() => start({ mode: 'chat' })}>Start a conversation</button></li>
      </ol>{availableCount === 0 && <button type="button" onClick={() => setAddOpen(true)}>Open another folder</button>}</section>}

      {work.length > 0 && <section aria-labelledby="home-open" data-help="home.open-work">
        <div className="home-section-heading"><h2 id="home-open">Continue <span className="home-count">({work.length})</span></h2><span className="home-fine-print">Work keeps running while you are here.</span></div>
        <div ref={workProbe} className="home-work-probe" aria-hidden="true" />
        <div id="home-open-list" className={workExpanded && work.length > workLimit ? 'home-bounded expanded' : 'home-bounded'}>
        <ul className="home-work-grid" aria-labelledby="home-open">{workShown.map(item => {
          const active = membersFor(item).find(job => job.busy);
          const step = active ? turnStep(active.activity ?? [], active.turnStartedAt, Date.now()) : null;
          const detail = `${waitingFor(item) ? '? Waiting on you / ' : step ? `${step.label} / ` : ''}${KIND_LABEL[item.kind]}${item.cwd ? ` / ${projectName(item)}` : ' / No project'}${item.lastActivity ? ` / ${when(item.lastActivity)}` : ''}`;
          return <li key={`${item.kind}:${item.id}`}>
            <div className="home-work-details"><strong title={item.name}>{item.name}</strong><HomeWorkStatus kind={item.kind === 'cluster' ? 'cluster' : 'job'} id={item.id} waiting={waitingFor(item) || (item.kind === 'cluster' && !!clusters[item.id] && clusterHasIdleMail(clusters[item.id], jobs))} busy={!!active} /><small title={item.cwd ? `${detail}\n${item.cwd}` : detail}>{detail}</small></div>
            <button type="button" className="home-primary" onClick={() => openItem(item)} aria-label={`Open ${KIND_LABEL[item.kind].toLowerCase()} ${item.name}`}>Resume</button>
          </li>;
        })}</ul>
        </div>
        {work.length > workLimit && <button type="button" className="home-show-all" aria-expanded={workExpanded} aria-controls="home-open-list" onClick={() => setWorkExpanded(open => !open)}>{workExpanded ? 'Show fewer' : `Show all ${work.length}`}</button>}
      </section>}


      {showProjects && <section aria-labelledby="home-projects" data-help="home.projects">
        <div className="home-project-tools"><h2 id="home-projects">Projects</h2>
          <label data-help="home.locations">Location <select aria-label="Location" value={location} onChange={e => { setLocation(e.target.value); setBrowserRoot(e.target.value || scanFolder || ''); }}><option value="">All locations</option>{roots?.map(root => <option key={root.path} value={root.path}>{root.name}{root.exists ? '' : ' (unavailable)'}</option>)}</select></label>
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
        <div ref={projectProbe} className="home-project-probe" aria-hidden="true" />
        <div id="home-project-list" className={bound.scrolls ? 'home-bounded expanded' : 'home-bounded'}>
        <ul className="home-project-grid">
          {bound.shown.map(project => <ProjectCard key={`${project.id ?? ''}|${project.path}`} project={project} label={labels.get(project.path) ?? project.name}
            locationName={(roots?.length ?? 0) > 1 ? roots?.find(root => root.path === project.rootPath)?.name : undefined}
            work={workForProject(project, projects ?? [], work)} organization={organization} preview={project.exists}
            onActivity={noteActivity} onResume={session => resume(project, session)} onResumeTerminal={session => resume(project, session, true)} onOpen={openItem} onStart={start} onList={body => { if (!applyList(body)) void load(); }} announce={setListStatus} />)}
        </ul>
        </div>
        {bound.toggle && <button type="button" className="home-show-all" aria-expanded={projectsExpanded} aria-controls="home-project-list" onClick={() => setProjectsExpanded(open => !open)}>{projectsExpanded ? 'Show fewer' : `Show all ${filtered.length}`}</button>}

      </section>}
    </div>
    {locationOpen && <LocationDialog initialPath={browserRoot} onClose={() => setLocationOpen(false)} onSaved={saved => { applyList(saved.list); setListStatus(saved.message); setLocationOpen(false); }} />}
    {addOpen && <AddProject onChoose={path => { setAddOpen(false); start({ mode: 'single', workDir: path }); }} roots={roots} initialPath={browserRoot} scanFolder={scanFolder} onList={body => { if (!applyList(body)) void load(); }} onClose={() => setAddOpen(false)} announce={setListStatus} />}
  </main>;
}

function HomeWorkStatus({ kind, id, waiting, busy }: { kind: 'job' | 'cluster'; id: string; waiting: boolean; busy: boolean }) {
  return <TabStatusChip status={useTabStatus(kind, id, waiting, busy)} />;
}
