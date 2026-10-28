import { useEffect, useRef, useState } from 'react';
import { DirectoryBrowser } from '../media/DirectoryPicker';
import { addFolder, createFolder } from './projectApi';

export function AddProject({ initialPath, scanFolder, roots, onList, onClose, announce }: {
  roots?: Array<{ name: string; path: string }>;
  initialPath: string; scanFolder: string | null;
  onList: (body: unknown) => void; onClose: () => void; announce: (message: string) => void;
}) {
  const [path, setPath] = useState(''), [name, setName] = useState('');
  const [root, setRoot] = useState(initialPath), [browseKey, setBrowseKey] = useState(0);
  const [adding, setAdding] = useState(false), [creating, setCreating] = useState(false);
  const [addStatus, setAddStatus] = useState(''), [createStatus, setCreateStatus] = useState('');
  const dialog = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key === 'Tab' && !dialog.current?.contains(document.activeElement)) { event.preventDefault(); input.current?.focus(); }
    };
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('keydown', key, true); if (previous?.isConnected) previous.focus(); else document.querySelector<HTMLButtonElement>('[data-add-project]')?.focus(); };
  }, []);
  async function add(folder: string) {
    if (!folder.trim() || adding || creating) return;
    setAdding(true); setAddStatus('');
    const reply = await addFolder(folder.trim()); setAdding(false);
    if (!reply.ok) { setAddStatus(`Not added: ${reply.error}.`); return; }
    onList(reply.body); setPath(''); setAddStatus(`Added ${folder.trim()}.`); announce(`Added ${folder.trim()}.`);
  }
  async function create() {
    if (!name.trim() || creating || adding) return;
    setCreating(true); setCreateStatus('');
    const reply = await createFolder(name.trim()); setCreating(false);
    if (!reply.ok) { setCreateStatus(`Not created: ${reply.error}.`); return; }
    onList(reply.body); setName(''); setCreateStatus(`Created and added ${name.trim()}.`); announce(`Created and added ${name.trim()}.`);
  }
  return <div className="home-add-backdrop" onClick={onClose}>
    <div className="home-add-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="home-add-title" onClick={e => e.stopPropagation()} onKeyDown={e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
      if (e.key !== 'Tab') return;
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),a[href]') ?? [])].filter(el => el.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }}>
      <header><div><span className="home-eyebrow">PROJECT FOLDERS</span><h2 id="home-add-title">Add project</h2><p>Choose any folder the server can read. Its files stay where they are.</p></div><button type="button" aria-label="Close Add project" onClick={onClose}>Done</button></header>
      <form onSubmit={e => { e.preventDefault(); void add(path); }} data-help="home.add-folder">
        <label htmlFor="home-add">Add a project folder</label>
        <div className="home-field-row"><input id="home-add" ref={input} value={path} onChange={e => setPath(e.target.value)} placeholder="Absolute folder path" aria-describedby="home-add-status" />
          <button type="submit" disabled={adding || creating || !path.trim()}>{adding ? 'Adding...' : 'Add'}</button>
          <button type="button" disabled={!path.trim()} onClick={() => { setRoot(path.trim()); setBrowseKey(key => key + 1); }}>Browse path</button></div>
        <div id="home-add-status" role="status">{addStatus}</div>
      </form>
      <DirectoryBrowser roots={roots} key={browseKey} initialPath={root} inline withFilename={false} title="Browse project folders" confirmLabel={adding ? 'Adding...' : 'Add this folder'} onDone={result => { if (result) void add(result.dir); }} />
      <details className="home-create"><summary>Create a new project folder</summary>
        <form onSubmit={e => { e.preventDefault(); void create(); }} data-help="home.create-folder">
          <label htmlFor="home-create">Create a new project folder</label>
          <div className="home-field-row"><input id="home-create" value={name} onChange={e => setName(e.target.value)} placeholder="Absolute new folder path, or name in the displayed parent" maxLength={1024} aria-describedby="home-create-help home-create-status" />
            <button type="submit" disabled={adding || creating || !name.trim()}>{creating ? 'Creating...' : 'Create'}</button></div>
          <p id="home-create-help">{scanFolder ? `Enter an absolute new folder path, or a name to create inside ${scanFolder}.` : 'Enter an absolute path to a new folder inside an existing parent.'}</p>
          <div id="home-create-status" role="status">{createStatus}</div>
        </form>
      </details>
      <p className="home-fine-print">In Docker, folders must be mounted first. Named discovery roots are configured in Settings &gt; Projects.</p>
    </div>
  </div>;
}
