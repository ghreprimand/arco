import { useEffect, useState } from 'react';
import { createTwoFilesPatch } from 'diff';
import { DialogShell } from './DialogShell';
import { DirectoryBrowser } from './media/DirectoryPicker';
import { SkillEditorDialog, type SkillEditorTarget } from './SkillEditorDialog';

// Settings > SKILLS (P8.6): list, create, edit and delete skills, plus IMPORT
// (GitHub link, folder, zip), UPDATE with a per-file diff, ON/OFF, MOVE between
// project and global, DUPLICATE, the files and missing skill references of a
// skill, and SHARE WITH REPOSITORY for a project skill.

type Scope = 'project' | 'global';
export interface SkillSummary {
  slug: string; name: string; description: string; scope: Scope; path: string;
  useCount?: number; lastUsed?: number; operatorOnly?: boolean; off?: boolean;
  source?: { kind: 'github'; url: string; commit?: string } | { kind: 'folder'; path: string } | { kind: 'zip'; name: string };
}
interface Details { scope: Scope; slug: string; files: Array<{ path: string; bytes: number }>; missing: string[] }
interface Finding { severity: string; kind: string; detail: string }

const small: React.CSSProperties = { padding: '3px 8px', background: 'transparent', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-accent-primary-dim)', cursor: 'pointer', fontSize: '9px', letterSpacing: '1px' };
const muted: React.CSSProperties = { fontSize: '10px', color: 'var(--color-fg-muted)', fontFamily: 'var(--font-body)' };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}
const post = <T,>(url: string, body: unknown) => api<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const q = (cwd: string) => (cwd ? `?cwd=${encodeURIComponent(cwd)}` : '');
const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`);

function formatSkillUsage(skill: SkillSummary): string {
  const count = skill.useCount ?? 0;
  if (count <= 0) return 'unused';
  const times = `used ${count}×`;
  if (!skill.lastUsed) return times;
  const mins = Math.floor((Date.now() - skill.lastUsed) / 60000);
  if (mins < 1) return `${times} · just now`;
  if (mins < 60) return `${times} · ${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return hrs < 24 ? `${times} · ${hrs}h ago` : `${times} · ${Math.floor(hrs / 24)}d ago`;
}

function sourceLabel(s: SkillSummary['source']): string {
  if (!s) return '';
  if (s.kind === 'github') return `GitHub${s.commit ? ` @ ${s.commit.slice(0, 7)}` : ''}`;
  return s.kind === 'folder' ? 'imported from a folder' : `imported from ${s.name}`;
}

function Findings({ findings }: { findings: Finding[] }) {
  if (!findings.length) return null;
  return <ul style={{ margin: '2px 0 0 16px', color: 'var(--color-warning)' }}>{findings.map((f, i) => <li key={i}>{f.kind}: {f.detail}</li>)}</ul>;
}

export function SkillsSettings({ cwd }: { cwd: string }) {
  const [skills, setSkills] = useState<{ project: SkillSummary[]; global: SkillSummary[] } | null>(null);
  const [details, setDetails] = useState<Record<string, Details>>({});
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [editor, setEditor] = useState<SkillEditorTarget | null>(null);
  const [importing, setImporting] = useState(false);
  const [updating, setUpdating] = useState<SkillSummary | null>(null);
  const [sharing, setSharing] = useState<SkillSummary | null>(null);

  const refresh = async () => {
    setError(null);
    try {
      setSkills(await api<{ project: SkillSummary[]; global: SkillSummary[] }>(`/api/skills${q(cwd)}`));
      const d = await api<{ skills: Details[] }>(`/api/skills/details${q(cwd)}`).catch(() => ({ skills: [] as Details[] }));
      setDetails(Object.fromEntries(d.skills.map((x) => [`${x.scope}:${x.slug}`, x])));
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  useEffect(() => { void refresh(); }, [cwd]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setError(null); setNote('');
    try { await fn(); setNote(done); await refresh(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  const remove = (s: SkillSummary) => act(async () => {
    const params = new URLSearchParams({ scope: s.scope, slug: s.slug });
    if (s.scope === 'project') params.set('cwd', cwd);
    await api(`/api/skills?${params.toString()}`, { method: 'DELETE' });
  }, `Deleted ${s.name}.`);
  const toggle = (s: SkillSummary) => act(() => post(`/api/skills/state${q(cwd)}`, { scope: s.scope, slug: s.slug, off: !s.off }), s.off ? `${s.name} is on.` : `${s.name} is off: the agent and the SKILLS menu leave it out.`);
  const move = (s: SkillSummary) => {
    const to: Scope = s.scope === 'project' ? 'global' : 'project';
    if (!window.confirm(`Move "${s.name}" to ${to === 'global' ? 'your global skills (every project)' : 'this project\'s skills'}? Tabs that pinned it lose the pin.`)) return;
    void act(() => post(`/api/skills/move${q(cwd)}`, { scope: s.scope, slug: s.slug, to }), `Moved ${s.name} to ${to} skills.`);
  };
  const duplicate = (s: SkillSummary) => {
    const name = window.prompt('Name for the duplicate', `${s.name} (copy)`);
    if (!name?.trim()) return;
    void act(() => post(`/api/skills/duplicate${q(cwd)}`, { scope: s.scope, slug: s.slug, name }), `Duplicated ${s.name} as ${name.trim()}.`);
  };

  const row = (s: SkillSummary) => {
    const d = details[`${s.scope}:${s.slug}`];
    return (
      <div key={`${s.scope}:${s.slug}`} data-testid="skill-row" data-skill={s.slug} style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '6px 10px', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', background: 'var(--color-bg-sunken)', opacity: s.off ? 0.55 : 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
          <span className="display-font" style={{ flex: 1, fontSize: '11px', letterSpacing: '1.5px', color: 'var(--color-accent-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {s.name}
            {s.operatorOnly && <span className="display-font" title="Operator-only: withheld from the model manifest; inline it by picking from the composer" style={{ marginLeft: '8px', fontSize: '8px', letterSpacing: '1px', color: 'var(--color-warning)', border: '1px solid var(--color-warning)', borderRadius: '2px', padding: '1px 4px' }}>OPERATOR</span>}
            {s.off && <span className="display-font" style={{ marginLeft: '8px', fontSize: '8px', letterSpacing: '1px', color: 'var(--color-fg-muted)', border: '1px solid var(--color-fg-muted)', borderRadius: '2px', padding: '1px 4px' }}>OFF</span>}
            <span className="display-font" title="Counted when the agent Reads this skill's SKILL.md" style={{ marginLeft: '8px', fontSize: '9px', letterSpacing: '0.5px', color: 'var(--color-fg-muted)', opacity: (s.useCount ?? 0) > 0 ? 0.8 : 0.5 }}>{formatSkillUsage(s)}</span>
          </span>
        </div>
        <span style={{ ...muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.description}>{s.description || <em style={{ opacity: 0.6 }}>(no description)</em>}</span>
        {(d?.files.length || s.source || d?.missing.length) ? (
          <span style={muted} data-testid="skill-contents">
            {d?.files.length ? `Also ${d.files.length} file${d.files.length === 1 ? '' : 's'}: ${d.files.map((f) => f.path).join(', ')}. ` : ''}
            {s.source ? `${sourceLabel(s.source)}. ` : ''}
            {d?.missing.length ? <span style={{ color: 'var(--color-warning)' }}>Refers to {d.missing.join(', ')}, not installed.</span> : null}
          </span>
        ) : null}
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          <button type="button" style={small} onClick={() => setEditor({ scope: s.scope, slug: s.slug })}>EDIT</button>
          <button type="button" style={small} data-help="settings.skills.toggle" onClick={() => void toggle(s)}>{s.off ? 'TURN ON' : 'TURN OFF'}</button>
          {(s.scope === 'global' || cwd) && <button type="button" style={small} data-help="settings.skills.move" disabled={s.scope === 'global' && !cwd} onClick={() => move(s)}>{s.scope === 'project' ? 'MOVE TO GLOBAL' : 'MOVE TO PROJECT'}</button>}
          <button type="button" style={small} data-help="settings.skills.duplicate" onClick={() => duplicate(s)}>DUPLICATE</button>
          {(s.source?.kind === 'github' || s.source?.kind === 'folder') && <button type="button" style={small} data-help="settings.skills.update" onClick={() => setUpdating(s)}>UPDATE</button>}
          {s.scope === 'project' && <button type="button" style={small} data-help="settings.skills.share" onClick={() => setSharing(s)}>SHARE WITH REPOSITORY</button>}
          <button type="button" title="Delete skill" onClick={() => void remove(s)} style={{ ...small, border: '1px solid var(--color-warning-dim)', color: 'var(--color-warning-dim)', fontSize: '10px' }}>×</button>
        </div>
      </div>
    );
  };

  return (
    <div data-help="settings.skills">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', gap: '6px' }}>
        <span className="display-font" style={{ fontSize: '11px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)' }}>SKILLS</span>
        <span style={{ display: 'flex', gap: '6px' }}>
          <button type="button" data-help="settings.skills.import" onClick={() => setImporting(true)} className="display-font" style={{ padding: '4px 10px', background: 'transparent', border: '1px solid var(--color-accent-secondary-dim)', borderRadius: '3px', color: 'var(--color-accent-secondary)', cursor: 'pointer', fontSize: '10px', letterSpacing: '1.5px' }}>IMPORT</button>
          <button type="button" onClick={() => setEditor({ scope: cwd ? 'project' : 'global' })} className="display-font" style={{ padding: '4px 10px', background: 'var(--color-accent-secondary-a08)', border: '1px solid var(--color-accent-secondary-dim)', borderRadius: '3px', color: 'var(--color-accent-secondary)', cursor: 'pointer', fontSize: '10px', letterSpacing: '1.5px' }}>+ NEW</button>
        </span>
      </div>
      <div style={{ ...muted, lineHeight: '1.6', marginBottom: '8px' }}>
        Project skills live in this project's <code>.arco/skills/</code> folder, which Git ignores like the rest of <code>.arco</code>; SHARE WITH REPOSITORY makes one skill trackable. Global skills live in <code>~/.arco/skills/</code> and apply to every project. Each is a folder with a SKILL.md (name and description at the top) and any files it needs. Changes take effect on the next turn.
      </div>
      {error && <div role="alert" style={{ ...muted, color: 'var(--color-warning)', marginBottom: '6px' }}>{error}</div>}
      {note && <div role="status" style={{ ...muted, marginBottom: '6px' }}>{note}</div>}
      {skills && skills.project.length === 0 && skills.global.length === 0 && <div style={{ ...muted, marginBottom: '6px', fontStyle: 'italic' }}>No skills yet. Select + NEW to write one or IMPORT to add one.</div>}
      {skills && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px' }}>
          {skills.project.map(row)}
          {skills.global.length > 0 && <div className="display-font" style={{ fontSize: '9px', letterSpacing: '1.5px', color: 'var(--color-fg-muted)', marginTop: '6px', marginBottom: '2px' }}>(GLOBAL)</div>}
          {skills.global.map(row)}
        </div>
      )}
      {editor && <SkillEditorDialog cwd={cwd} target={editor} onClose={() => setEditor(null)} onSaved={() => { void refresh(); }} />}
      {importing && <SkillImportDialog cwd={cwd} onClose={() => setImporting(false)} onImported={(name) => { setImporting(false); setNote(`Imported ${name}.`); void refresh(); }} />}
      {updating && <SkillUpdateDialog cwd={cwd} skill={updating} onClose={() => setUpdating(null)} onUpdated={() => { setNote(`Updated ${updating.name}.`); setUpdating(null); void refresh(); }} />}
      {sharing && <SkillShareDialog cwd={cwd} skill={sharing} onClose={() => setSharing(null)} onShared={() => { setNote(`${sharing.name} can now be committed with the project.`); setSharing(null); void refresh(); }} />}
    </div>
  );
}

interface ImportPreview { token: string; name: string; description: string; operatorOnly: boolean; files: Array<{ path: string; bytes: number; text: boolean; findings: Finding[] }>; skipped: string[]; findingCount: number }

export function SkillImportDialog({ cwd, onClose, onImported }: { cwd: string; onClose: () => void; onImported: (name: string) => void }) {
  const [kind, setKind] = useState<'github' | 'folder' | 'zip'>('github');
  const [url, setUrl] = useState('');
  const [folder, setFolder] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [zip, setZip] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [scope, setScope] = useState<Scope>(cwd ? 'project' : 'global');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const review = async () => {
    setBusy(true); setError(''); setPreview(null);
    try {
      let source: unknown;
      if (kind === 'github') source = { kind, url };
      else if (kind === 'folder') source = { kind, path: folder };
      else {
        if (!zip) throw new Error('Choose a zip file.');
        const bytes = new Uint8Array(await zip.arrayBuffer());
        let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        source = { kind, name: zip.name, data: btoa(bin) };
      }
      setPreview(await post<ImportPreview>(`/api/skills/import/preview${q(cwd)}`, { source }));
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!preview) return;
    setBusy(true); setError('');
    try { await post(`/api/skills/import/confirm${q(cwd)}`, { token: preview.token, scope }); onImported(preview.name); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  return (
    <DialogShell title="IMPORT SKILL" ariaLabel="Import skill" dataHelp="settings.skills.import" onClose={onClose} width={720}
      status={error ? <span role="alert" style={{ color: 'var(--color-error)' }}>{error}</span> : null}
      actions={<>
        <button type="button" disabled={busy} onClick={() => void review()}>REVIEW</button>
        <button type="button" disabled={busy || !preview} onClick={() => void confirm()}>IMPORT</button>
      </>}>
      <p style={{ marginTop: 0 }}>Nothing is fetched or saved until you select REVIEW and then IMPORT. Read every file before importing: a skill is instructions your agent will follow.</p>
      <div role="radiogroup" aria-label="Import from" style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
        {(['github', 'folder', 'zip'] as const).map((k) => <label key={k}><input type="radio" name="skill-import-kind" checked={kind === k} onChange={() => { setKind(k); setPreview(null); }} /> {k === 'github' ? 'GitHub link' : k === 'folder' ? 'Folder' : 'Zip file'}</label>)}
      </div>
      {kind === 'github' && <label style={{ display: 'block' }}>Link to a skill folder or its SKILL.md (public repositories)
        <input className="arco-field" aria-label="GitHub link" value={url} onChange={(e) => { setUrl(e.target.value); setPreview(null); }} placeholder="https://github.com/owner/repo/tree/main/skill-name" style={{ width: '100%', boxSizing: 'border-box' }} /></label>}
      {kind === 'folder' && <div>
        <label style={{ display: 'block' }}>Folder that holds SKILL.md
          <input className="arco-field" aria-label="Skill folder" value={folder} onChange={(e) => { setFolder(e.target.value); setPreview(null); }} style={{ width: '100%', boxSizing: 'border-box' }} /></label>
        <button type="button" onClick={() => setBrowsing((b) => !b)}>BROWSE</button>
        {browsing && <DirectoryBrowser inline initialPath={folder || cwd} withFilename={false} title="Choose the skill folder" confirmLabel="USE THIS FOLDER" onDone={(r) => { setBrowsing(false); if (r) { setFolder(r.dir); setPreview(null); } }} />}
      </div>}
      {kind === 'zip' && <label style={{ display: 'block' }}>Zip file with one skill folder
        <input type="file" accept=".zip,application/zip" aria-label="Zip file" onChange={(e) => { setZip(e.target.files?.[0] ?? null); setPreview(null); }} /></label>}
      {preview && <section data-testid="skill-import-preview" style={{ marginTop: 10 }}>
        <p><strong>{preview.name}</strong>{preview.operatorOnly ? ' (operator-only)' : ''}: {preview.description || '(no description)'}</p>
        <p>{preview.files.length} file{preview.files.length === 1 ? '' : 's'}, {kb(preview.files.reduce((n, f) => n + f.bytes, 0))}. Security check: {preview.findingCount ? `${preview.findingCount} finding${preview.findingCount === 1 ? '' : 's'}; read them before importing.` : 'no findings in the text files.'}</p>
        <ul style={{ margin: '0 0 0 16px' }}>{preview.files.map((f) => <li key={f.path}>{f.path} ({kb(f.bytes)}){f.text ? '' : ' - not text, not checked'}<Findings findings={f.findings} /></li>)}</ul>
        {preview.skipped.length > 0 && <p style={muted}>Left out (hidden or outside the skill folder): {preview.skipped.join(', ')}</p>}
        <div role="radiogroup" aria-label="Save to" style={{ display: 'flex', gap: 12 }}>
          <label><input type="radio" name="skill-import-scope" checked={scope === 'project'} disabled={!cwd} onChange={() => setScope('project')} /> This project</label>
          <label><input type="radio" name="skill-import-scope" checked={scope === 'global'} onChange={() => setScope('global')} /> Global (every project)</label>
        </div>
      </section>}
    </DialogShell>
  );
}

interface UpdatePreview { token: string; name: string; changed: boolean; findingCount: number; files: Array<{ path: string; status: 'added' | 'removed' | 'changed' | 'unchanged'; text: boolean; before?: string; after?: string; findings: Finding[] }> }

function SkillUpdateDialog({ cwd, skill, onClose, onUpdated }: { cwd: string; skill: SkillSummary; onClose: () => void; onUpdated: () => void }) {
  const [preview, setPreview] = useState<UpdatePreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    post<UpdatePreview>(`/api/skills/update/preview${q(cwd)}`, { scope: skill.scope, slug: skill.slug }).then(setPreview).catch((e) => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
  }, [cwd, skill.scope, skill.slug]);
  const apply = async () => {
    if (!preview) return;
    setBusy(true); setError('');
    try { await post(`/api/skills/update/confirm${q(cwd)}`, { token: preview.token }); onUpdated(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); setBusy(false); }
  };
  return (
    <DialogShell title={`UPDATE ${skill.name.toUpperCase()}`} ariaLabel="Update skill" dataHelp="settings.skills.update" onClose={onClose} width={820}
      status={error ? <span role="alert" style={{ color: 'var(--color-error)' }}>{error}</span> : null}
      actions={<button type="button" disabled={busy || !preview?.changed} onClick={() => void apply()}>APPLY UPDATE</button>}>
      <p style={{ marginTop: 0 }}>Fetched again from {sourceLabel(skill.source)}. Nothing changes until you select APPLY UPDATE; the skill stays on or off as it is.</p>
      {busy && !preview && !error && <p>Fetching...</p>}
      {preview && !preview.changed && <p>Already up to date.</p>}
      {preview?.files.filter((f) => f.status !== 'unchanged').map((f) => (
        <section key={f.path} data-testid="skill-update-file" style={{ borderTop: '1px solid var(--color-border-hairline)', padding: '6px 0' }}>
          <strong>{f.path}</strong> <span style={muted}>{f.status}</span>
          <Findings findings={f.findings} />
          {f.text ? <pre style={{ fontSize: 11, maxHeight: 260, overflow: 'auto', background: 'var(--color-bg-sunken)', padding: 6 }}>{createTwoFilesPatch(f.path, f.path, f.before ?? '', f.after ?? '', 'installed', 'source')}</pre> : <p style={muted}>Not text; no diff shown.</p>}
        </section>
      ))}
    </DialogShell>
  );
}

interface SharePreview { files: string[]; alreadyTrackable: boolean; publicRepository: boolean; lines: string[] }

function SkillShareDialog({ cwd, skill, onClose, onShared }: { cwd: string; skill: SkillSummary; onClose: () => void; onShared: () => void }) {
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const markedPublic = (() => { try { return localStorage.getItem(`arco.publicProject.${cwd}`) === '1'; } catch { return false; } })();
  useEffect(() => {
    post<SharePreview>(`/api/skills/share/preview${q(cwd)}`, { slug: skill.slug }).then(setPreview).catch((e) => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
  }, [cwd, skill.slug]);
  const share = async () => {
    setBusy(true); setError('');
    try { await post(`/api/skills/share${q(cwd)}`, { slug: skill.slug, confirm: true }); onShared(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); setBusy(false); }
  };
  const isPublic = preview?.publicRepository || markedPublic;
  return (
    <DialogShell title="SHARE WITH REPOSITORY" ariaLabel="Share skill with repository" dataHelp="settings.skills.share" onClose={onClose}
      status={error ? <span role="alert" style={{ color: 'var(--color-error)' }}>{error}</span> : null}
      actions={<button type="button" disabled={busy || !preview || preview.alreadyTrackable} onClick={() => void share()}>{isPublic ? 'SHARE IN PUBLIC REPOSITORY' : 'SHARE'}</button>}>
      {preview?.alreadyTrackable ? <p>Git does not ignore these files; they can already be committed.</p> : <p>Git ignores <code>.arco</code> in this project. SHARE adds an exception for this skill to <code>.arco/.gitignore</code>, so these files show up in Git and can be committed. Arco does not stage or commit them.</p>}
      {preview && <ul style={{ margin: '0 0 0 16px' }} data-testid="skill-share-files">{preview.files.map((f) => <li key={f}><code>{f}</code></li>)}</ul>}
      {preview && preview.lines.length > 0 && !preview.alreadyTrackable && <p style={muted}>Lines added: {preview.lines.map((l) => <code key={l} style={{ marginRight: 6 }}>{l}</code>)}</p>}
      {isPublic && <p role="note" style={{ color: 'var(--color-warning)' }}>This project is public. Once committed and pushed, anyone can read this skill; check it holds no private names, paths or notes.</p>}
    </DialogShell>
  );
}
