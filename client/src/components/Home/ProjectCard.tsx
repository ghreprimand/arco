import { addFolder as keepFolder } from './projectApi';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionInfo } from '@arco/shared';
import { useAppStore } from '../../stores/appStore';
import type { CreatorPrefill } from '../../stores/appStore.types';
import { parseSavedSessions, savedSessionRows, type HomeProject, type OpenWorkItem, type SavedSessionRow } from '../../utils/homeModel';
import { organize, relocate, removeFromList, type ProjectReply } from './projectApi';
import { KIND_LABEL, action, box, field, muted, primary, when } from './homeStyles';

// One project on Home: open tabs, saved sessions, start actions and, when the
// server can store it, organization (pin, rename, archive), removal from the
// list and relocation of a missing folder. Nothing here deletes or moves files.

async function loadSessions(path: string, signal: AbortSignal): Promise<{ sessions: SessionInfo[] } | { error: string }> {
  try {
    const res = await fetch(`/api/sessions?path=${encodeURIComponent(path)}`, { cache: 'no-store', signal });
    return parseSavedSessions(res.status, await res.json().catch(() => null));
  } catch {
    return { error: 'Saved sessions could not be loaded (the server could not be reached).' };
  }
}

type Earlier = { path: string; rows: SavedSessionRow[] } | { path: string; error: string };

export function ProjectCard({ project, label, work, organization, onOpen, onStart, onList, announce, preview = false, onResume, onActivity }: {
  preview?: boolean; onResume?: (session: SessionInfo) => void; onActivity?: (path: string, at: number) => void;
  project: HomeProject;
  label: string;
  work: OpenWorkItem[];
  organization: boolean;
  onOpen: (item: OpenWorkItem) => void;
  onStart: (prefill: CreatorPrefill) => void;
  onList: (body: unknown) => void;
  announce: (message: string) => void;
}) {
  const jobs = useAppStore((s) => s.jobs);
  const setActiveJob = useAppStore((s) => s.setActiveJob);
  const [expanded, setExpanded] = useState(false);
  const [saved, setSaved] = useState<SavedSessionRow[] | null>(null);
  const [savedError, setSavedError] = useState('');
  const [earlier, setEarlier] = useState<Earlier[]>([]);
  const [manage, setManage] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rename, setRename] = useState(project.displayName ?? '');
  const [moveTo, setMoveTo] = useState('');
  const raw = useRef<SessionInfo[]>([]);
  const sessionsRequest = useRef<AbortController | null>(null);
  // Home keys cards by identity AND folder. Relocation drops all path-scoped
  // rows and cancels the old folder's request instead of rebinding its Resume.
  useEffect(() => () => sessionsRequest.current?.abort(), []);
  const slug = (project.id ?? project.path).replace(/[^A-Za-z0-9]/g, '-');
  const listId = `home-saved-${slug}`;
  const manageId = `home-manage-${slug}`;
  const missing = !project.exists;
  const canOrganize = organization && !!project.id;

  useEffect(() => { setRename(project.displayName ?? ''); }, [project.displayName]);

  const loadSaved = useCallback(async () => {
    sessionsRequest.current?.abort();
    const request = new AbortController();
    sessionsRequest.current = request;
    setSavedError('');
    const [current, ...previous] = await Promise.all([project.path, ...(project.previousPaths ?? [])].map((path) => loadSessions(path, request.signal)));
    if (request.signal.aborted) return;
    if ('error' in current) { setSaved(null); setSavedError(current.error); } else {
      raw.current = current.sessions;
      const rows = savedSessionRows(raw.current, useAppStore.getState().jobs);
      setSaved(rows); onActivity?.(project.path, rows[0]?.startedAt ?? 0);
    }
    setEarlier(previous.map((r, i) => {
      const path = project.previousPaths![i];
      return 'error' in r ? { path, error: r.error } : { path, rows: savedSessionRows(r.sessions, useAppStore.getState().jobs) };
    }));
  }, [project.path, project.previousPaths, onActivity]);
  useEffect(() => { if (preview) void loadSaved(); }, [preview, loadSaved]);
  // Keep the Open/Resume marking current when tabs open or close.
  useEffect(() => { if (saved) setSaved(savedSessionRows(raw.current, jobs)); }, [jobs]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && saved === null) void loadSaved();
  };

  async function change(request: Promise<ProjectReply>, done: string) {
    if (busy) return;
    setBusy(true); setError('');
    const reply = await request;
    setBusy(false);
    if (!reply.ok) { setError(`Not changed: ${reply.error}.`); return; }
    onList(reply.body);
    announce(done);
  }

  const savedRow = (row: SavedSessionRow, resumable: boolean) => (
    <li key={row.sessionId} className="home-session-row">
      {row.openWorkflowId ? (
        <button type="button" style={action} onClick={() => setActiveJob(row.openWorkflowId!)} aria-label={`Open ${row.title}`}>Open</button>
      ) : resumable ? (
        <button type="button" style={action} onClick={() => { const session = raw.current.find(s => s.sessionId === row.sessionId); if (session && onResume) onResume(session); else onStart({ mode: 'single', workDir: project.path, resumeSessionId: row.sessionId }); }} aria-label={`Resume ${row.title}`}>Resume</button>
      ) : null}
      <span>{row.title}{row.workspaceName && row.workspaceName !== row.title && <small style={muted}> / Workspace: {row.workspaceName}</small>}</span>
      <span style={muted}>{row.provider}{row.account ? `  /  ${row.account}` : ''}{row.startedAt ? `  /  ${when(row.startedAt)}` : ''}</span>
    </li>
  );

  return (
    <li className="home-project-card" style={{ ...box, padding: '16px', opacity: missing ? 0.85 : 1 }} aria-label={`Project ${label}`}>
      <div className="home-card-header">
        <div className="home-card-summary" style={{ minWidth: 0 }}>
          <h4 style={{ margin: 0, fontSize: '13px' }}>
            {label}
            {project.pinned && <span style={{ ...muted, marginLeft: 8 }}>Pinned</span>}
            {project.archived && <span style={{ ...muted, marginLeft: 8 }}>Archived</span>}
          </h4>
          <div style={{ ...muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={project.path}>{project.path}</div>
          {project.displayName && project.derivedName && project.derivedName !== project.displayName && (
            <div style={muted}>Folder name: {project.derivedName}</div>
          )}
          {project.previousPaths?.length ? <div style={muted}>Moved from {project.previousPaths[0]}</div> : null}
          <div style={muted}>
            {missing
              ? `Folder not found. Its saved sessions stay on disk.${canOrganize ? ' If it moved, use Relocate...; otherwise archive it or remove its bookmark.' : ' Remove or add its bookmark in Settings.'}`
              : work.length ? `${work.length} open ${work.length === 1 ? 'tab' : 'tabs'}` : 'Project folder'}
          </div>
        </div>
        <div className="home-card-actions">
          <button type="button" style={primary} disabled={missing} onClick={() => onStart({ mode: 'single', workDir: project.path })} aria-label={`New session in ${label}`}>New session</button>
          <button type="button" style={action} disabled={missing} onClick={() => onStart({ mode: 'cluster', workDir: project.path })} aria-label={`New cluster in ${label}`}>New cluster</button>
          <button type="button" style={action} disabled={missing} aria-expanded={expanded} aria-controls={listId} onClick={toggle} aria-label={`${expanded ? 'Hide' : 'Show'} saved sessions for ${label}`}>
            {expanded ? 'Hide saved' : 'Saved sessions'}
          </button>
          {organization && !project.id && <button type="button" style={action} disabled={busy || missing} onClick={() => void change(keepFolder(project.path), `Bookmarked ${label}.`)}>Bookmark folder</button>}
          {canOrganize && (
            <button type="button" style={action} disabled={busy} aria-pressed={!!project.pinned}
              onClick={() => void change(organize(project.id!, { pinned: !project.pinned }), `${project.pinned ? 'Unpinned' : 'Pinned'} ${label}.`)}
              aria-label={`${project.pinned ? 'Unpin' : 'Pin'} ${label}`}>{project.pinned ? 'Unpin' : 'Pin'}</button>
          )}
          {canOrganize && (
            <button type="button" style={missing ? primary : action} aria-expanded={manage} aria-controls={manageId} onClick={() => { setManage(!manage); setConfirmRemove(false); setError(''); }}
              aria-label={`${missing ? 'Relocate or manage' : 'Manage'} ${label}`}>{missing ? 'Relocate...' : 'Manage...'}</button>
          )}
        </div>
      </div>

      {manage && canOrganize && (
        <div id={manageId} data-help="home.manage-project" style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--color-border-hairline)', paddingTop: 8 }}>
          {missing && (
            <form onSubmit={(e) => { e.preventDefault(); if (moveTo.trim()) void change(relocate(project.id!, moveTo.trim()), `Relocated ${label} to ${moveTo.trim()}.`); }}
              style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <label htmlFor={`${manageId}-move`} style={{ fontSize: '12px' }}>New folder location</label>
              <input id={`${manageId}-move`} value={moveTo} onChange={(e) => setMoveTo(e.target.value)} placeholder="Absolute path, e.g. /projects/example-app" style={{ ...field, fontFamily: 'var(--font-code)' }} />
              <button type="submit" style={primary} disabled={busy || !moveTo.trim()}>Relocate</button>
              <span style={muted}>Points this project at the folder&apos;s new location. Nothing is moved; the old location stays listed under it.</span>
            </form>
          )}
          <form onSubmit={(e) => { e.preventDefault(); void change(organize(project.id!, { displayName: rename.trim() }), rename.trim() ? `Renamed to ${rename.trim()}.` : `${project.derivedName ?? 'Project'} uses its folder name again.`); }}
            style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <label htmlFor={`${manageId}-name`} style={{ fontSize: '12px' }}>Display name</label>
            <input id={`${manageId}-name`} value={rename} maxLength={80} onChange={(e) => setRename(e.target.value)} placeholder={project.derivedName ?? project.name} style={field} />
            <button type="submit" style={action} disabled={busy}>Save name</button>
            <span style={muted}>Leave empty to use the folder name. Only Arco&apos;s list changes.</span>
          </form>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" style={action} disabled={busy}
              onClick={() => void change(organize(project.id!, { archived: !project.archived }), `${project.archived ? 'Restored' : 'Archived'} ${label}.`)}>
              {project.archived ? 'Unarchive' : 'Archive'}
            </button>
            <span style={muted}>{project.archived ? 'Show it in the main lists again.' : 'Keep it out of the main lists; its folder and saved sessions are unchanged.'}</span>
          </div>
          {project.source === 'registered' ? (
            confirmRemove ? (
              <div role="group" aria-label={`Confirm removing ${label}`} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: '12px' }}>Remove the bookmark for {label}? Files and saved chats are not touched.</span>
                <button type="button" style={action} disabled={busy}
                  onClick={() => void change(removeFromList(project.path), `Removed bookmark for ${label}. Its files and saved chats were not touched.`)}>Remove bookmark</button>
                <button type="button" style={action} onClick={() => setConfirmRemove(false)}>Cancel</button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" style={action} disabled={busy} onClick={() => setConfirmRemove(true)}>Remove bookmark...</button>
                <span style={muted}>Removes this bookmark only. Files and saved chats are not touched.</span>
              </div>
            )
          ) : (
            <p style={{ ...muted, margin: 0 }}>
              {project.source === 'scanned' ? 'Found in the projects folder, so it cannot be removed from the list; archive it instead.' : 'Listed because a session ran here; archive it to keep it out of the main lists.'}
            </p>
          )}
          {error && <div role="alert" style={{ color: 'var(--color-warning)', fontSize: '12px' }}>{error}</div>}
        </div>
      )}

      {work.length > 0 && (!preview || expanded) && (
        <ul aria-label={`Open tabs in ${label}`} style={{ listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {work.map((item) => (
            <li key={`${item.kind}:${item.id}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button type="button" style={action} onClick={() => onOpen(item)} aria-label={`Open ${KIND_LABEL[item.kind].toLowerCase()} ${item.name}`}>Open</button>
              <span>{item.name}</span><span style={muted}>{KIND_LABEL[item.kind]}</span>
            </li>
          ))}
        </ul>
      )}
      {(expanded || preview) && (
        <div id={listId} style={{ marginTop: 6 }}>
          <div role="status" aria-live="polite" style={muted}>
            {saved === null && !savedError ? 'Loading saved sessions...' : saved && saved.length === 0 ? 'No saved sessions in this folder.' : ''}
          </div>
          {savedError && <div role="alert" style={{ color: 'var(--color-warning)', fontSize: '12px' }}>{savedError} <button type="button" style={action} onClick={() => void loadSaved()}>Retry</button></div>}
          {saved && saved.length > 0 && (
            <ul aria-label={`Saved sessions in ${label}`} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {(expanded ? saved : saved.slice(0, 1)).map((row) => savedRow(row, !missing))}
            </ul>
          )}
          {expanded && earlier.map((group) => (
            <div key={group.path} style={{ marginTop: 6 }}>
              <div style={muted}>Saved under the previous location {group.path}. They stay listed here; resuming them from the new folder is not available.</div>
              {'error' in group
                ? <div role="alert" style={{ color: 'var(--color-warning)', fontSize: '12px' }}>{group.error}</div>
                : group.rows.length === 0
                  ? <div style={muted}>None.</div>
                  : <ul aria-label={`Saved sessions from ${group.path}`} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>{group.rows.map((row) => savedRow(row, false))}</ul>}
            </div>
          ))}
        </div>
      )}
    </li>
  );
}
