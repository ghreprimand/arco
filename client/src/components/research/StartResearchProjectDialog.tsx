import { useEffect, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { DialogShell } from '../DialogShell';
import { DirectoryBrowser } from '../media/DirectoryPicker';
import { touchButton } from './ResearchCloseDialog';
import type { ResearchSelection } from './SendResearchDialog';

type Preview = { path: string; size: number; preview?: string };
type Prepared = { project?: string; target?: string; written?: string[]; token?: string; error?: string; receiptError?: string };

// docs/RESEARCH.md - choose the folder before opening the normal project creator.
export function StartResearchProjectDialog({ clusterId, selection, onClose }: { clusterId: string; selection: ResearchSelection; onClose: () => void }) {
  const [files, setFiles] = useState<Preview[] | null>(null);
  const [parent, setParent] = useState('');
  const [name, setName] = useState('');
  const [existing, setExisting] = useState(false);
  const [mode, setMode] = useState<'single' | 'cluster'>('single');
  const [draft, setDraft] = useState('Use the research below as the starting point for this project. Review the findings and sources before making changes.');
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [written, setWritten] = useState(false);
  useEffect(() => {
    let active = true;
    void fetch(`/api/research/${clusterId}/preview-start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selection }) })
      .then(async r => { const body = await r.json() as { files?: Preview[]; error?: string }; if (!r.ok) throw new Error(body.error || 'Could not preview research.'); if (active) setFiles(body.files ?? []); })
      .catch(error => { if (active) setResult(error instanceof Error ? error.message : 'Could not preview research.'); });
    return () => { active = false; };
  }, [clusterId, selection]);
  const prepare = async () => {
    if (busy || written || !parent || !name.trim() || !files?.length) return;
    setBusy(true); setResult('');
    try {
      const response = await fetch(`/api/research/${clusterId}/prepare-start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selection, parent, name, useExisting: existing }) });
      const body = await response.json() as Prepared;
      if (!response.ok) throw new Error(body.error || 'Could not prepare the project.');
      if (body.project) setWritten(true);
      if (body.error || body.receiptError || !body.project || !body.target || !body.token) {
        setResult(`Project folder: ${body.project ?? 'not created'}. Copy folder: ${body.target ?? 'not created'}. Files written: ${(body.written ?? []).join(', ') || 'none'}. ${body.error ?? body.receiptError ?? 'Could not finish the copy.'}`); return;
      }
      const relative = body.target.slice(body.project.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
      const references = (body.written ?? []).filter(path => /\.md$/i.test(path)).map(path => `- ${relative}/${path}`).join('\n');
      const seedPrompt = `${draft.trim()}\n\nResearch files:\n${references}\n\nReturned source files are in ${relative}/sources/.`;
      useAppStore.getState().openCreatorWith({ mode, workDir: body.project, researchStart: { clusterId, token: body.token, seedPrompt } });
      onClose();
    } catch (error) { setResult(error instanceof Error ? error.message : 'Could not prepare the project.'); }
    finally { setBusy(false); }
  };
  return <DialogShell title="Start a project from research" onClose={onClose}>
    <p>Choose a parent folder and project name. Research is copied into a new folder under research/. The next screen creates an Agent tab or cluster; the first message stays in the draft.</p>
    {choosing ? <DirectoryBrowser inline fill withFilename={false} title="Choose parent folder" confirmLabel="USE THIS FOLDER" onDone={choice => { if (choice) setParent(choice.dir); setChoosing(false); }} /> : <>
      <button type="button" className="display-font" style={touchButton} onClick={() => setChoosing(true)}>CHOOSE PARENT FOLDER</button>
      <p style={{ overflowWrap: 'anywhere' }}>{parent || 'No parent folder selected.'}</p>
      <label>Project folder name <input className="arco-field" value={name} onChange={e => setName(e.target.value)} /></label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 44 }}><input type="checkbox" checked={existing} onChange={e => setExisting(e.target.checked)} /> Use this folder if it already exists; do not overwrite files</label>
      <label>Open as <select className="arco-field" value={mode} onChange={e => setMode(e.target.value as 'single' | 'cluster')}><option value="single">Agent tab</option><option value="cluster">Cluster</option></select></label>
      <label>First draft message <textarea className="arco-field" value={draft} onChange={e => setDraft(e.target.value)} rows={3} /></label>
      <details><summary>Research to copy ({files?.length ?? 0} files)</summary>{files?.map(file => <div key={file.path}><code>{file.path}</code> ({file.size} bytes){file.preview && <pre style={{ whiteSpace: 'pre-wrap' }}>{file.preview}</pre>}</div>)}</details>
      <button type="button" className="display-font" style={touchButton} disabled={busy || written || !parent || !name.trim() || !files?.length} onClick={() => void prepare()}>{busy ? 'COPYING...' : 'CONTINUE'}</button>
      {result && <p role="status" style={{ overflowWrap: 'anywhere' }}>{result}</p>}
    </>}
  </DialogShell>;
}
