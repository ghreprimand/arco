import { useEffect, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { DialogShell } from '../DialogShell';
import { DirectoryBrowser } from '../media/DirectoryPicker';
import { touchButton } from './ResearchCloseDialog';
import type { ResearchSelection } from './SendResearchDialog';

type Preview = { path: string; size: number; preview?: string };
type Counts = { rounds: number; catchUps: number; reports: number; summaries: number; returnedFiles: number };

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const sizeText = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

// One line per folder and file, folders first, indented by depth.
export function copyTree(paths: string[]): Array<{ depth: number; name: string; folder: boolean }> {
  type Node = { folders: Map<string, Node>; files: string[] };
  const root: Node = { folders: new Map(), files: [] };
  for (const path of paths) {
    const parts = path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
      node = node.folders.get(part)!;
    }
    node.files.push(parts.at(-1)!);
  }
  const lines: Array<{ depth: number; name: string; folder: boolean }> = [];
  const walk = (node: Node, depth: number) => {
    for (const [name, child] of [...node.folders].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))) { lines.push({ depth, name: `${name}/`, folder: true }); walk(child, depth + 1); }
    for (const name of [...node.files].sort((a, b) => Number(b === 'README.md') - Number(a === 'README.md') || a.localeCompare(b, undefined, { numeric: true }))) lines.push({ depth, name, folder: false });
  };
  walk(root, 0);
  return lines;
}
type Prepared = { project?: string; target?: string; written?: string[]; token?: string; error?: string; receiptError?: string };

// docs/RESEARCH.md - choose the folder before opening the normal project creator.
export function StartResearchProjectDialog({ clusterId, selection, onClose }: { clusterId: string; selection: ResearchSelection; onClose: () => void }) {
  const [files, setFiles] = useState<Preview[] | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [startSummary, setStartSummary] = useState<string | undefined>();
  const [parent, setParent] = useState('');
  const [name, setName] = useState('');
  const [existing, setExisting] = useState(false);
  const [mode, setMode] = useState<'single' | 'cluster'>('single');
  const [draft, setDraft] = useState('Use the research copied into this project as the starting point. Review the findings and sources before making changes.');
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [written, setWritten] = useState(false);
  useEffect(() => {
    let active = true;
    void fetch(`/api/research/${clusterId}/preview-start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selection }) })
      .then(async r => {
        const body = await r.json() as { files?: Preview[]; counts?: Counts; startSummary?: string; error?: string };
        if (!r.ok) throw new Error(body.error || 'Could not preview research.');
        if (active) { setFiles(body.files ?? []); setCounts(body.counts ?? null); setStartSummary(body.startSummary); }
      })
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
      const report = selection.kind === 'report' ? (body.written ?? []).find(path => /\/researcher-[a-z]\.md$/.test(path)) : undefined;
      const start = startSummary && body.written?.includes(startSummary) ? `${relative}/${startSummary}` : report ? `${relative}/${report}` : '';
      const seedPrompt = `${draft.trim()}\n\nThe research is copied into ${relative}/. Start with ${relative}/README.md, which lists every copied file.${start ? ` This project starts from ${start}.` : ''} Each round's reports, summary and returned files are under ${relative}/rounds/.`;
      useAppStore.getState().openCreatorWith({ mode, workDir: body.project, researchStart: { clusterId, token: body.token, seedPrompt } });
      onClose();
    } catch (error) { setResult(error instanceof Error ? error.message : 'Could not prepare the project.'); }
    finally { setBusy(false); }
  };
  return <DialogShell title="Start a project from research" onClose={onClose}>
    <p>Choose a parent folder and project name. The research is copied into a new folder under research/ in the project. The next screen creates an Agent tab or cluster; the first message stays in the draft.</p>
    <section aria-label="What will be copied" data-help="research.start.copy">
      <p style={{ margin: '4px 0' }}><strong>What will be copied: </strong>{!files ? (result ? 'nothing; see the message below.' : 'reading...') : counts && selection.kind !== 'report'
        ? `the whole released project: ${[plural(counts.rounds, 'round'), ...(counts.catchUps ? [plural(counts.catchUps, 'catch-up')] : []), plural(counts.reports, 'report'), plural(counts.summaries, 'summary', 'summaries'), plural(counts.returnedFiles, 'returned file')].join(', ')}; ${plural(files.length, 'file')}, ${sizeText(files.reduce((sum, file) => sum + file.size, 0))} in all, with a README.md index.`
        : `this report${counts?.returnedFiles ? ` and ${plural(counts.returnedFiles, 'returned file')}` : ''}, the brief and a README.md index; ${plural(files.length, 'file')} in all.`}</p>
      {startSummary && <p style={{ margin: '4px 0' }}>The project starts from <code>summary.md</code>, {selection.kind === 'synthesis' ? `the summary of round ${selection.round}` : 'the latest summary'}.</p>}
      {!!files?.length && <details open={!choosing}><summary>Folder tree</summary>
        <div style={{ maxHeight: 220, overflow: 'auto', fontFamily: 'var(--font-mono, monospace)', fontSize: '0.9em' }}>
          <div>research/{'<'}name{'>'}/</div>
          {copyTree(files.map(file => file.path)).map((line, index) => <div key={index} style={{ paddingLeft: `${(line.depth + 1) * 1.2}em`, overflowWrap: 'anywhere' }}>{line.name}</div>)}
        </div>
      </details>}
    </section>
    {choosing ? <DirectoryBrowser inline fill withFilename={false} title="Choose parent folder" confirmLabel="USE THIS FOLDER" onDone={choice => { if (choice) setParent(choice.dir); setChoosing(false); }} /> : <>
      <button type="button" className="display-font" style={touchButton} onClick={() => setChoosing(true)}>CHOOSE PARENT FOLDER</button>
      <p style={{ overflowWrap: 'anywhere' }}>{parent || 'No parent folder selected.'}</p>
      <label>Project folder name <input className="arco-field" value={name} onChange={e => setName(e.target.value)} /></label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 44 }}><input type="checkbox" checked={existing} onChange={e => setExisting(e.target.checked)} /> Use this folder if it already exists; do not overwrite files</label>
      <label>Open as <select className="arco-field" value={mode} onChange={e => setMode(e.target.value as 'single' | 'cluster')}><option value="single">Agent tab</option><option value="cluster">Cluster</option></select></label>
      <label>First draft message <textarea className="arco-field" value={draft} onChange={e => setDraft(e.target.value)} rows={3} /></label>
      {files?.some(file => file.preview) && <details><summary>Read the starting summary</summary>{files.filter(file => file.preview).map(file => <pre key={file.path} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{file.preview}</pre>)}</details>}
      <button type="button" className="display-font" style={touchButton} disabled={busy || written || !parent || !name.trim() || !files?.length} onClick={() => void prepare()}>{busy ? 'COPYING...' : 'CONTINUE'}</button>
      {result && <p role="status" style={{ overflowWrap: 'anywhere' }}>{result}</p>}
    </>}
  </DialogShell>;
}
