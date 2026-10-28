import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { useStartupStore } from '../../stores/startupStore';
import type { CreatorPrefill } from '../../stores/appStore.types';
import {
  groupProjects, openWork, organizationAvailable, parseProjects, projectLabels, scanFolderOf, searchProjects, workForProject,
  type HomeProject, type OpenWorkItem,
} from '../../utils/homeModel';
import { ProjectCard } from './ProjectCard';
import { addFolder, createFolder } from './projectApi';
import { KIND_LABEL, action, box, field, muted, primary, when } from './homeStyles';

// Project-centered Home: open work, projects (search, groups, per-project open
// and saved work) and explicit Start actions. Everything here only navigates
// or opens the existing creator pre-filled; nothing starts a provider, model
// or agent. Incognito tabs never appear (see utils/homeModel.ts).

export function HomeView() {
  const jobs = useAppStore((s) => s.jobs);
  const clusters = useAppStore((s) => s.clusters);
  const setActiveJob = useAppStore((s) => s.setActiveJob);
  const setActiveCluster = useAppStore((s) => s.setActiveCluster);
  const openCreatorWith = useAppStore((s) => s.openCreatorWith);
  const setShowSettings = useAppStore((s) => s.setShowSettings);

  const [projects, setProjects] = useState<HomeProject[] | null>(null);
  const [organization, setOrganization] = useState(false);
  const [scanFolder, setScanFolder] = useState<string | null>(null);
  const [showScanned, setShowScanned] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [listStatus, setListStatus] = useState('');
  const [newName, setNewName] = useState('');
  const [createStatus, setCreateStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [addPath, setAddPath] = useState('');
  const [addStatus, setAddStatus] = useState('');
  const [adding, setAdding] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  // Every list reply (load or change) replaces the whole list.
  const applyList = useCallback((body: unknown): boolean => {
    const parsed = parseProjects(body);
    if (!parsed) return false;
    setProjects(parsed); setOrganization(organizationAvailable(body)); setScanFolder(scanFolderOf(body));
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
  const groups = useMemo(() => groupProjects(shown, showArchived), [shown, showArchived]);
  const labels = useMemo(() => projectLabels(projects ?? []), [projects]);
  const archivedCount = (projects ?? []).filter((p) => p.archived).length;
  const start = (prefill: CreatorPrefill) => openCreatorWith(prefill);
  const openItem = (item: OpenWorkItem) => (item.kind === 'cluster' ? setActiveCluster(item.id) : setActiveJob(item.id));

  async function addProject(e: React.FormEvent) {
    e.preventDefault();
    const path = addPath.trim();
    if (!path || adding) return;
    setAdding(true); setAddStatus('');
    // Same guarded registration as Settings -> PROJECTS (absolute, existing, inside allowed roots).
    const reply = await addFolder(path);
    setAdding(false);
    if (!reply.ok) { setAddStatus(`Not added: ${reply.error}.`); return; }
    if (!applyList(reply.body)) void load();
    setAddPath(''); setAddStatus(`Added ${path}.`);
  }

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true); setCreateStatus('');
    const reply = await createFolder(name);
    setCreating(false);
    if (!reply.ok) { setCreateStatus(`Not created: ${reply.error}.`); return; }
    if (!applyList(reply.body)) void load();
    setNewName(''); setCreateStatus(`Created and added ${name}.`);
  }

  return (
    <main aria-labelledby="home-title" style={{ flex: 1, overflowY: 'auto', padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: 18, fontFamily: 'var(--font-body)', color: 'var(--color-fg)' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h1 id="home-title" ref={heading} tabIndex={-1} className="display-font" style={{ margin: 0, fontSize: '18px', letterSpacing: '2px', color: 'var(--color-accent-primary)' }}>HOME</h1>
        <span style={muted}>Pick up open work, find a project, or start something new. Nothing starts until you launch it.</span>
      </header>

      <section aria-labelledby="home-start" data-help="home.start" style={{ ...box, padding: '10px 14px' }}>
        <h2 id="home-start" style={{ margin: '0 0 8px', fontSize: '14px' }}>Start</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" style={primary} onClick={() => start({ mode: 'single' })}>New session</button>
          <button type="button" style={action} onClick={() => start({ mode: 'chat' })}>New chat (no project)</button>
          <button type="button" style={action} onClick={() => start({ mode: 'cluster' })}>New cluster</button>
          <button type="button" style={action} onClick={() => start({ mode: 'genesis' })}>New idea (Genesis)</button>
        </div>
        <p style={{ ...muted, margin: '8px 0 0' }}>Each opens the creator with every option available; choose a project below to pre-fill its folder.</p>
      </section>

      <section aria-labelledby="home-open" data-help="home.open-work" style={{ ...box, padding: '10px 14px' }}>
        <h2 id="home-open" style={{ margin: '0 0 8px', fontSize: '14px' }}>Open work ({work.length})</h2>
        {work.length === 0 ? (
          <p style={{ ...muted, margin: 0 }}>No open tabs. Saved sessions are listed under each project.</p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {work.map((item) => (
              <li key={`${item.kind}:${item.id}`} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button type="button" style={action} onClick={() => openItem(item)} aria-label={`Open ${KIND_LABEL[item.kind].toLowerCase()} ${item.name}`}>Open</button>
                <span>{item.name}</span>
                <span style={muted}>{KIND_LABEL[item.kind]}{item.cwd ? `  /  ${item.cwd}` : ''}{item.lastActivity ? `  /  ${when(item.lastActivity)}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="home-projects" data-help="home.projects" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h2 id="home-projects" style={{ margin: 0, fontSize: '14px' }}>Projects{projects ? ` (${projects.length})` : ''}</h2>
          <label htmlFor="home-search" style={muted}>Search projects (press /)</label>
          <input
            id="home-search" ref={search} type="search" value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); } }}
            placeholder="Name or folder"
            style={{ flex: '1 1 220px', minWidth: 0, padding: '6px 10px', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-hairline)', borderRadius: 3, color: 'var(--color-fg)', fontSize: '12px' }}
          />
          <button type="button" style={action} onClick={() => void load()}>Reload list</button>
          {archivedCount > 0 && (
            <button type="button" style={action} aria-pressed={showArchived} onClick={() => setShowArchived(!showArchived)}>
              {showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}
            </button>
          )}
          <button type="button" style={action} onClick={() => { useStartupStore.getState().setSettingsSection('projects'); setShowSettings(true); }}>Manage projects in Settings</button>
        </div>
        <div role="status" aria-live="polite" style={muted}>
          {projects === null && !loadError ? 'Loading projects...' : query && projects ? `${shown.length} of ${projects.length} projects match.` : listStatus}
        </div>
        {loadError && <div role="alert" style={{ color: 'var(--color-warning)', fontSize: '12px' }}>{loadError}</div>}
        {projects && !organization && (
          <div role="alert" style={{ color: 'var(--color-warning)', fontSize: '12px' }}>
            Pinning, renaming, archiving and relocating are unavailable because the project record file could not be read or saved. Projects are still listed; nothing was changed.
          </div>
        )}

        {projects && !scanFolder && <p style={muted}>Choose a scan folder in Settings &gt; Projects to discover folders.</p>}
        {projects && projects.length === 0 && (
          <div style={{ ...box, padding: '10px 14px' }}>
            <h3 style={{ margin: '0 0 6px', fontSize: '13px' }}>No projects yet</h3>
            <p style={{ ...muted, margin: 0 }}>Add a folder Arco can see below, or set a scan folder in Settings. When Arco runs in Docker, only mounted folders are visible.</p>
          </div>
        )}
        {projects && projects.length > 0 && shown.length === 0 && (
          <p style={{ ...muted, margin: 0 }}>No project matches "{query}".</p>
        )}

        {groups.map((group) => (
          <section key={group.key} aria-labelledby={`home-group-${group.key}`}>
            <h3 id={`home-group-${group.key}`} style={{ margin: '0 0 2px', fontSize: '13px' }}>{group.key === 'scanned' ? `Found in ${scanFolder}` : group.title} ({group.projects.length}){group.key === 'scanned' && group.projects.length > 12 && !query.trim() && <button type="button" style={action} aria-expanded={showScanned} onClick={() => setShowScanned(!showScanned)}>{showScanned ? 'Hide' : 'Show'}</button>}</h3>
            <p style={{ ...muted, margin: '0 0 6px' }}>{group.description}</p>
            <ul hidden={group.key === 'scanned' && group.projects.length > 12 && !query.trim() && !showScanned} style={{ listStyle: 'none', margin: 0, padding: 0, display: group.key === 'scanned' && group.projects.length > 12 && !query.trim() && !showScanned ? 'none' : 'flex', flexDirection: 'column', gap: 6 }}>
              {group.projects.map((project) => (
                <ProjectCard
                  key={`${project.id ?? ''}|${project.path}`}
                  project={project}
                  label={labels.get(project.path) ?? project.name}
                  work={workForProject(project, projects ?? [], work)}
                  organization={organization}
                  onOpen={openItem}
                  onStart={start}
                  onList={(body) => { if (!applyList(body)) void load(); }}
                  announce={setListStatus}
                />
              ))}
            </ul>
          </section>
        ))}

        <form onSubmit={(e) => void addProject(e)} data-help="home.add-folder" style={{ ...box, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label htmlFor="home-add" style={{ fontSize: '12px' }}>Add a project folder</label>
          <input
            id="home-add" value={addPath} onChange={(e) => setAddPath(e.target.value)} placeholder="Absolute path, e.g. /projects/example-app"
            aria-describedby="home-add-status"
            style={{ flex: '1 1 260px', minWidth: 0, padding: '6px 10px', background: 'var(--color-bg-elevated)', border: '1px solid var(--color-border-hairline)', borderRadius: 3, color: 'var(--color-fg)', fontSize: '12px', fontFamily: 'var(--font-code)' }}
          />
          <button type="submit" style={action} disabled={adding || !addPath.trim()}>{adding ? 'Adding...' : 'Add'}</button>
          <span id="home-add-status" role="status" aria-live="polite" style={muted}>{addStatus}</span>
        </form>

        <form onSubmit={(e) => void createProject(e)} data-help="home.create-folder" style={{ ...box, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label htmlFor="home-create" style={{ fontSize: '12px' }}>Create a new project folder</label>
          <input
            id="home-create" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Absolute new folder path, or name in the scan folder" maxLength={1024}
            aria-describedby="home-create-help home-create-status"
            style={{ ...field, fontFamily: 'var(--font-code)' }}
          />
          <button type="submit" style={action} disabled={creating || !newName.trim()}>{creating ? 'Creating...' : 'Create'}</button>
          <span id="home-create-help" style={muted}>
            {scanFolder ? `Enter an absolute new folder path, or a name to create inside ${scanFolder}.` : 'Enter an absolute path to a new folder inside an existing parent.'}
          </span>
          <span id="home-create-status" role="status" aria-live="polite" style={muted}>{createStatus}</span>
        </form>
      </section>
    </main>
  );
}
