import { useEffect, useMemo, useState } from 'react';
import { isClusterDirector } from '@arco/shared';
import { useAppStore } from '../../stores/appStore';
import { touchButton } from './ResearchCloseDialog';
import { DialogShell } from '../DialogShell';
import { DirectoryBrowser } from '../media/DirectoryPicker';

export type { ResearchResultSelection as ResearchSelection } from '../../stores/appStore.types';
import type { ResearchResultSelection as ResearchSelection } from '../../stores/appStore.types';
type Attachment = { path: string; filename: string; isImage: boolean };
type CopyResult = { target?: string; written: string[]; error?: string; receiptError?: string };
type Result = { error?: string; folder?: CopyResult; plan?: CopyResult; composer?: { attachments: Attachment[]; token?: string; error?: string } };

export function SendResearchDialog({ clusterId, selection, onClose }: { clusterId: string; selection: ResearchSelection; onClose: () => void }) {
  const jobs = useAppStore(s => s.jobs), clusters = useAppStore(s => s.clusters);
  const choices = useMemo(() => Object.values(jobs).filter(job => {
    if (job.config.incognito) return false;
    const cluster = Object.values(clusters).find(c => c.members.some(m => m.workflowId === job.id));
    return !cluster || cluster.members.some(m => m.workflowId === job.id && isClusterDirector(m.role));
  }), [jobs, clusters]);
  const [destination, setDestination] = useState('');
  const [target, setTarget] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [copyFolder, setCopyFolder] = useState(true);
  const [attach, setAttach] = useState(false);
  const [planId, setPlanId] = useState('');
  const [plans, setPlans] = useState<Array<{ id: string; title: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');
  const [written, setWritten] = useState(false);
  useEffect(() => {
    let active = true;
    setPlanId(''); setPlans([]);
    if (destination) void fetch(`/api/plans?path=${encodeURIComponent(destination)}`).then(r => r.ok ? r.json() : { plans: [] }).then((data: { plans?: Array<{ id: string; title: string }> }) => { if (active) setPlans(data.plans ?? []); }).catch(() => undefined);
    return () => { active = false; };
  }, [destination]);
  const send = async () => {
    if (busy || written || (!copyFolder && !attach && !planId) || ((copyFolder || planId) && !destination) || (attach && !target)) return;
    setBusy(true); setResult('');
    try {
      const response = await fetch(`/api/research/${clusterId}/send-to-project`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selection, destination, folderCopy: copyFolder, ...(planId ? { planId } : {}), ...(attach ? { composerWorkflowId: target } : {}) }) });
      const data = await response.json() as Result;
      if (!response.ok) throw new Error(data.error || 'Could not send the research.');
      const notes: string[] = [];
      const count = data.folder?.written.length ?? 0;
      if (data.folder) notes.push(`${count} file${count === 1 ? '' : 's'} written${data.folder.target ? ` to ${data.folder.target}` : ''}.${data.folder.error ? ` Copy stopped: ${data.folder.error}` : ''}${data.folder.receiptError ? ` The export log could not be updated: ${data.folder.receiptError}` : ''}`);
      if (count) setWritten(true);
      if (data.plan) {
        const item = data.plan;
        notes.push(`${item.written.length} plan file${item.written.length === 1 ? '' : 's'} written${item.target ? ` to ${item.target}` : ''}.${item.error ? ` Copy stopped: ${item.error}` : ''}${item.receiptError ? ` The export log could not be updated: ${item.receiptError}` : ''}`);
        if (item.written.length) setWritten(true);
      }
      if (data.composer) {
        const files = data.composer.attachments;
        if (files.length && useAppStore.getState().jobs[target]) {
          for (const file of files) useAppStore.getState().addAttachment(target, file);
          const attached = files.filter(file => useAppStore.getState().attachments[target]?.some(item => item.path === file.path));
          if (attached.length) setWritten(true);
          if (attached.length === files.length && data.composer.token) {
            setWritten(true);
            const confirmed = await fetch(`/api/research/${clusterId}/confirm-composer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: data.composer.token }) }).catch(() => null);
            notes.push(`${attached.length} attachment${attached.length === 1 ? '' : 's'} staged in the draft; no message was sent.${!confirmed?.ok ? ' The export log could not be updated.' : ''}`);
          } else notes.push(`${attached.length} of ${files.length} attachments were staged before the destination changed; the export was not recorded.`);
        } else if (files.length) notes.push('The destination closed before attachments were staged.');
        if (data.composer.error) notes.push(`Attachment stopped: ${data.composer.error}`);
      }
      setResult(notes.join(' '));
    } catch (error) { setResult(error instanceof Error ? error.message : 'Could not send the research.'); }
    finally { setBusy(false); }
  };
  return <DialogShell title="Send to a project" onClose={onClose}>
    <p>Select a project folder or an open conversation. Copies use a new folder under research/. Attachments stay in the draft until the operator sends them.</p>
    {choosing ? <DirectoryBrowser inline fill withFilename={false} title="Choose project folder" confirmLabel="USE THIS FOLDER" onDone={choice => { if (choice) { setDestination(choice.dir); setTarget(''); setAttach(false); } setChoosing(false); }} /> : <>
      <label>Open conversation <select value={target} onChange={event => { const id = event.target.value; setTarget(id); if (id) setDestination(jobs[id]?.config.workingDirectory ?? ''); else setAttach(false); }}><option value="">Choose a conversation</option>{choices.map(job => <option key={job.id} value={job.id}>{job.config.name || job.id.slice(0, 8)}</option>)}</select></label>
      <p style={{ overflowWrap: 'anywhere' }}>{destination || 'No project folder selected.'}</p>
      <button type="button" className="display-font" style={touchButton} onClick={() => setChoosing(true)} disabled={busy}>CHOOSE FOLDER</button>
      <label><input type="checkbox" checked={copyFolder} onChange={e => setCopyFolder(e.target.checked)} /> Copy to research/</label>
      <label>Plan reference <select value={planId} onChange={e => setPlanId(e.target.value)} disabled={!plans.length}><option value="">{plans.length ? 'Do not add a reference' : 'No plan in this folder'}</option>{plans.map(plan => <option key={plan.id} value={plan.id}>{plan.title}</option>)}</select></label>
      <label><input type="checkbox" checked={attach} onChange={e => setAttach(e.target.checked)} disabled={!target} /> Attach to conversation draft</label>
      <button type="button" className="display-font" style={touchButton} onClick={() => void send()} disabled={busy || written || (!copyFolder && !attach && !planId) || ((copyFolder || planId) && !destination) || (attach && !target)}>{busy ? 'SENDING...' : 'SEND'}</button>
      {result && <p role="status" style={{ overflowWrap: 'anywhere' }}>{result}</p>}
    </>}
  </DialogShell>;
}
