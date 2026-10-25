import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

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
}

interface DirEntry { name: string; path: string; }

function DirectoryPickerModal({ initialPath, defaultName, withFilename = true, title = 'Save output to…', onDone }: PickOptions & { onDone: (r: PickResult | null) => void }) {
  const [cwd, setCwd] = useState(initialPath || '');
  const [dirs, setDirs] = useState<DirEntry[]>([]);
  const [name, setName] = useState(defaultName || '');
  const [newFolder, setNewFolder] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async (path: string) => {
    setLoading(true);
    setErr('');
    try {
      const res = await fetch(`/api/list-dirs?path=${encodeURIComponent(path)}`);
      const data = await res.json() as { parent?: string; dirs?: DirEntry[] };
      setCwd(data.parent || path);
      setDirs(Array.isArray(data.dirs) ? data.dirs : []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(initialPath || ''); }, [load, initialPath]);

  // Escape cancels (capture so it doesn't also close the host modal under us).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onDone(null); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onDone]);

  const goUp = () => {
    const parent = cwd.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/';
    void load(parent);
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

  return createPortal(
    <div
      onClick={() => onDone(null)}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9700, padding: '40px' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glow-border"
        style={{ width: '100%', maxWidth: '560px', maxHeight: '80vh', display: 'flex', flexDirection: 'column', background: 'var(--color-bg)', border: '1px solid var(--color-border-bright)', borderRadius: '6px', overflow: 'hidden' }}
      >
        {/* Header */}
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--color-border-hairline)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
          <span className="display-font glow-text-cyan" style={{ fontSize: '12px', letterSpacing: '1.5px' }}>{title.toUpperCase()}</span>
          <button onClick={() => onDone(null)} className="display-font" title="Cancel (Esc)" style={{ ...btn, width: '26px' }}>×</button>
        </div>

        {/* Path bar */}
        <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--color-border-hairline)', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <button onClick={goUp} className="display-font" title="Up one folder" style={btn} disabled={loading}>↑ UP</button>
          <span style={{ fontSize: '11px', fontFamily: 'var(--font-code, monospace)', color: 'var(--color-fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left', flex: 1 }} title={cwd}>
            {cwd || '…'}
          </span>
        </div>

        {/* Folder list */}
        <div style={{ flex: 1, minHeight: '160px', overflowY: 'auto' }}>
          {loading ? (
            <div style={{ padding: '16px', fontSize: '11px', color: 'var(--color-fg-muted)' }}>loading…</div>
          ) : dirs.length === 0 ? (
            <div style={{ padding: '16px', fontSize: '11px', color: 'var(--color-fg-muted)' }}>no sub-folders here — “SAVE HERE” drops the file in this folder</div>
          ) : (
            dirs.map((d) => (
              <button
                key={d.path}
                onClick={() => void load(d.path)}
                className="display-font"
                style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', borderBottom: '1px solid var(--color-border-hairline)', color: 'var(--color-fg)', cursor: 'pointer', fontSize: '12px', letterSpacing: '0.5px', padding: '8px 14px' }}
              >
                📁 {d.name}
              </button>
            ))
          )}
        </div>

        {/* New folder */}
        <div style={{ padding: '8px 14px', borderTop: '1px solid var(--color-border-hairline)', display: 'flex', gap: '8px' }}>
          <input
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void makeFolder(); }}
            placeholder="new folder name…"
            spellCheck={false}
            style={{ ...input, flex: 1 }}
          />
          <button onClick={() => void makeFolder()} className="display-font" style={btn} disabled={!newFolder.trim()}>+ FOLDER</button>
        </div>

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
          <button onClick={() => onDone(null)} className="display-font" style={btn}>CANCEL</button>
          <button onClick={confirm} className="display-font" style={{ ...btn, borderColor: 'var(--color-accent-primary)', color: 'var(--color-accent-primary)' }} disabled={!cwd}>SAVE HERE ↵</button>
        </div>
      </div>
    </div>,
    document.body,
  );
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
    ? <DirectoryPickerModal {...req.opts} onDone={(r) => { req.resolve(r); setReq(null); }} />
    : null;
  return { pick, pickerElement };
}

const btn: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-accent-primary-dim)',
  cursor: 'pointer',
  fontSize: '11px',
  letterSpacing: '1px',
  padding: '4px 10px',
};

const input: React.CSSProperties = {
  background: 'var(--color-bg-input)',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  color: 'var(--color-fg)',
  fontSize: '11px',
  fontFamily: 'var(--font-code, monospace)',
  padding: '5px 8px',
};
