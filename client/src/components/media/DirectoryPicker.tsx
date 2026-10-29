import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { WorkSurfaceControls } from '../workSurface/WorkSurfaceControls';

// A reusable click-through folder picker — the "Save As" surface for the media
// studio's server-side ops (no native OS dialog exists for a server file, and
// typing an absolute path is the thing operators don't want to do). Navigates
// real directories via /api/list-dirs, can make a folder (/api/mkdir), and
// returns the chosen { dir, basename }. Promise-driven via useDirectoryPicker so
// a caller can `const dest = await pick({...})` inline.

export interface PickResult {
  // Absolute destination directory the operator navigated to.
  dir: string;
  // Optional output filename (blank ⇒ the op auto-derives a non-clobbering name;
  // the op always forces its own extension regardless).
  basename: string;
}

export interface PickOptions {
  // Where to start browsing (defaults to ~/Projects server-side when blank).
  initialPath?: string;
  // Prefill the filename field (the source stem, usually).
  defaultName?: string;
  // Show a filename input (a Save-As). Omit for a pure folder choice.
  withFilename?: boolean;
  title?: string;
  // Embed the same browser in setup instead of opening a second dialog.
  inline?: boolean;
  confirmLabel?: string;
  roots?: Array<{ name: string; path: string }>;
  compactCreate?: boolean;
}

interface DirEntry { name: string; path: string; }

export function DirectoryBrowser({ initialPath, defaultName, withFilename = true, title = 'Save output to…', inline = false, confirmLabel = 'SAVE HERE ↵', roots = [], compactCreate = false, onDone }: PickOptions & { onDone: (r: PickResult | null) => void }) {
  const surface = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const pathEdits = useRef(0);
  const pathId = useId();
  const [pathDraft, setPathDraft] = useState(initialPath || '');
  const [cwd, setCwd] = useState(initialPath || '');
  const [dirs, setDirs] = useState<DirEntry[]>([]);
  const [name, setName] = useState(defaultName || '');
  const [newFolder, setNewFolder] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async (path: string) => {
    const attempt = ++request.current;
    const editsAtStart = pathEdits.current;
    setPathDraft(path);
    setLoading(true);
    setErr('');
    try {
      const res = await fetch(`/api/list-dirs?path=${encodeURIComponent(path)}`);
      const data = await res.json() as { parent?: string; dirs?: DirEntry[]; unavailable?: boolean };
      if (attempt !== request.current) return;
      if (!res.ok) throw new Error('Folder listing is unavailable.');
      setCwd(data.parent || path);
      if (pathEdits.current === editsAtStart) setPathDraft(data.parent || path);
      setDirs(Array.isArray(data.dirs) ? data.dirs : []);
      if (data.unavailable) setErr('The requested folder is not reachable. Showing the home folder; navigate to an available folder before choosing.');
    } catch (e) {
      if (attempt === request.current) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (attempt === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(initialPath || ''); }, [load, initialPath]);

  // Escape cancels (capture so it doesn't also close the host modal under us).
  useEffect(() => {
    if (inline) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onDone(null); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onDone, inline]);

  const goUp = () => {
    const separator = cwd.includes('\\') ? '\\' : '/';
    const parent = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).slice(0, -1).join(separator) || separator;
    const target = /^[A-Za-z]:$/.test(parent) ? parent + separator : parent;
    void load(target);
  };

  const makeFolder = async () => {
    const n = newFolder.trim();
    if (!n || !cwd) return;
    try {
      const res = await fetch('/api/mkdir', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parent: cwd, name: n }) });
      const data = await res.json() as { error?: string; path?: string };
      if (!res.ok) { setErr(data.error || 'could not create folder'); return; }
      setNewFolder('');
      await load(cwd);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const confirm = () => onDone({ dir: cwd, basename: name.trim() });

  const content = <div
      className={inline ? 'directory-browser-host' : undefined}
      onClick={() => onDone(null)}
      style={inline ? {} : { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9700, padding: '40px' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        ref={surface}
        className={inline ? 'first-run-browser' : 'glow-border'}
        style={{ width: inline ? '100%' : 'min(1200px, calc(90vw / var(--ui-scale, 1)))', maxWidth: inline ? undefined : 'calc(94vw / var(--ui-scale, 1))', height: inline ? '340px' : 'calc(80vh / var(--ui-scale, 1))', maxHeight: inline ? undefined : 'calc(90vh / var(--ui-scale, 1))', display: 'flex', flexDirection: 'column', background: 'var(--color-bg)', border: '1px solid var(--color-border-bright)', borderRadius: '6px', overflow: 'hidden' }}
      >
        {/* Header */}
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--color-border-hairline)', display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
          <span className="display-font glow-text-cyan" style={{ fontSize: '12px', letterSpacing: '1.5px' }}>{title.toUpperCase()}</span>
          {!inline && <WorkSurfaceControls surface={surface} />}
          {!inline && <button onClick={() => onDone(null)} className="display-font" title="Cancel (Esc)" style={{ ...btn, width: '26px' }}>×</button>}
        </div>

        {/* Path bar */}
        <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--color-border-hairline)', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button onClick={goUp} className="display-font" title="Up one folder" style={btn} disabled={loading}>↑ UP</button>
          <label htmlFor={pathId} style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden' }}>Browse folder path</label>
          <input id={pathId} value={pathDraft} onChange={e => { pathEdits.current++; setPathDraft(e.target.value); }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void load(pathDraft); } }} style={{ ...input, flex: 1, minWidth: 0 }} />
          <button type="button" style={btn} onClick={() => void load(pathDraft)} disabled={loading}>Go</button>
        </div>
        {roots.length > 0 && <div aria-label="Location shortcuts" style={{ padding: '4px 14px', display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 64, overflowY: 'auto' }}>{roots.map(root => <button type="button" key={root.path} style={btn} title={root.path} onClick={() => void load(root.path)}>{root.name}</button>)}</div>}

        {/* Folder list */}
        <div role={inline ? 'region' : undefined} aria-label={inline ? 'Project folders' : undefined} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {loading ? (
            <div style={{ padding: '16px', fontSize: '11px', color: 'var(--color-fg-muted)' }}>loading…</div>
          ) : dirs.length === 0 ? (
            <div style={{ padding: '16px', fontSize: '11px', color: 'var(--color-fg-muted)' }}>{inline ? 'No subfolders here. Choose this folder or go up.' : 'no sub-folders here — “SAVE HERE” drops the file in this folder'}</div>
          ) : (
            dirs.map((d) => (
              <button
                key={d.path}
                onClick={() => void load(d.path)}
                className="display-font"
                style={{ display: 'block', width: '100%', margin: 0, borderRadius: 0, textAlign: 'left', background: 'transparent', border: 'none', borderBottom: '1px solid var(--color-border-hairline)', color: 'var(--color-fg)', cursor: 'pointer', fontSize: '12px', letterSpacing: '0.5px', padding: '8px 14px' }}
              >
                {inline ? `${d.name}/` : `📁 ${d.name}`}
              </button>
            ))
          )}
        </div>

        {compactCreate && <button type="button" style={{ ...btn, margin: '4px 14px', textAlign: 'left' }} aria-expanded={creatingFolder} onClick={() => setCreatingFolder(value => !value)}>{creatingFolder ? 'Hide create folder' : 'Create folder'}</button>}
        {(!compactCreate || creatingFolder) && <><small style={{ padding: '4px 14px', overflowWrap: 'anywhere' }}>Create folder inside: {cwd || 'choose a parent first'}</small>
        {/* New folder */}
        <div style={{ padding: '8px 14px', borderTop: '1px solid var(--color-border-hairline)', display: 'flex', gap: '8px' }}>
          <input
            aria-label={inline ? 'New folder name' : undefined}
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void makeFolder(); }}
            placeholder="New folder name"
            spellCheck={false}
            style={{ ...input, flex: 1 }}
          />
          <button onClick={() => void makeFolder()} className="display-font" style={btn} disabled={!newFolder.trim()}>+ FOLDER</button>
        </div>

        </>}
        {/* Filename + confirm */}
        {withFilename && (
          <div style={{ padding: '8px 14px', borderTop: '1px solid var(--color-border-hairline)' }}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirm(); }}
              placeholder="filename (blank = auto; the op sets the extension)"
              spellCheck={false}
              style={{ ...input, width: '100%', boxSizing: 'border-box' }}
            />
          </div>
        )}
        {err && <div style={{ padding: '0 14px 8px', fontSize: '10px', color: 'var(--color-danger)' }}>{err}</div>}
        <div style={{ padding: '10px 14px', borderTop: '1px solid var(--color-border-hairline)', display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          {!inline && <button onClick={() => onDone(null)} className="display-font" style={btn}>CANCEL</button>}
          <button onClick={confirm} className="display-font" style={{ ...btn, borderColor: 'var(--color-accent-primary)', color: 'var(--color-accent-primary)' }} disabled={!cwd || loading || !!err || pathDraft !== cwd}>{confirmLabel}</button>
        </div>
      </div>
    </div>;
  return inline ? content : createPortal(content, document.body);
}

// Promise-driven picker. `pick(opts)` resolves with the chosen { dir, basename }
// or null if cancelled. Render `pickerElement` somewhere in the tree.
export function useDirectoryPicker() {
  const [req, setReq] = useState<{ opts: PickOptions; resolve: (r: PickResult | null) => void } | null>(null);
  const pick = useCallback(
    (opts: PickOptions = {}) => new Promise<PickResult | null>((resolve) => setReq({ opts, resolve })),
    [],
  );
  const pickerElement = req
    ? <DirectoryBrowser {...req.opts} onDone={(r) => { req.resolve(r); setReq(null); }} />
    : null;
  return { pick, pickerElement };
}

const btn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-accent-primary-dim)',
  cursor: 'pointer',
  fontSize: '13px',
  letterSpacing: '1px',
  padding: '4px 10px',
};

const input: React.CSSProperties = {
  background: 'var(--color-bg-input)',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-fg)',
  fontSize: '13px',
  fontFamily: 'var(--font-code, monospace)',
  padding: '5px 8px',
};
