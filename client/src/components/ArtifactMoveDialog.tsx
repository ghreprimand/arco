import { useState } from 'react';
import { DirectoryBrowser } from './media/DirectoryPicker';
import { KeepButton } from './KeepButton';
import { effectivePublic } from '../utils/publicProject';

interface Finding { line: number; rule: string }
interface Review { target: string; bytes: number; ignored: boolean; publicRepository: boolean; token: string; files: Array<{ rel: string; media: boolean; unscanned: boolean; findings: Finding[] }> }
export function artifactRelative(file: string, workflowId: string): string | null {
  const normalized = file.replace(/\\/g, '/');
  const marker = `/.arco/workflows/${workflowId}/artifacts/`;
  const index = normalized.indexOf(marker);
  return index < 0 ? null : `artifacts/${normalized.slice(index + marker.length)}`;
}
export function ArtifactMoveDialog({ cwd, workflowId, itemPath, onClose }: { cwd: string; workflowId: string; itemPath: string; onClose: () => void }) {
  const [stage, setStage] = useState<'choice' | 'folder' | 'review'>('choice');
  const [folder, setFolder] = useState(cwd);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  async function call(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/storage/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: cwd, workflowId, itemPath, destinationFolder: folder, publicProject: effectivePublic(cwd), confirm: true, ...extra }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || result.error || 'The request failed.');
      return result;
    } catch (err) { setError(err instanceof Error ? err.message : 'The request failed.'); return null; } finally { setBusy(false); }
  }
  async function inspect(dir = folder) {
    setFolder(dir);
    const result = await call('copy-review', { destinationFolder: dir });
    if (result) { setReview(result as Review); setStage('review'); }
  }
  async function copy() {
    if (!review) return;
    const unscanned = review.files.filter(file => file.unscanned).map(file => file.rel);
    const needsConfirmation = !review.ignored && review.publicRepository && unscanned.length > 0;
    if (needsConfirmation && !window.confirm(`These files were not fully scanned:\n${unscanned.join('\n')}\n\nCopy them into the public repository?`)) return;
    if (await call('copy-confirm', { token: review.token, confirmUnscanned: needsConfirmation })) setDone('Copied into the project. The original remains in Arco.');
  }
  async function ignore() { if (review && await call('copy-ignore', { token: review.token })) await inspect(); }
  return <div style={{ position: 'fixed', inset: 0, zIndex: 9800, background: '#000a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    <div role="dialog" aria-modal="true" aria-label="Move artifact to project" style={{ width: 'min(680px,100%)', maxHeight: 'calc(90vh / var(--ui-scale, 1))', overflowY: 'auto', padding: 16, background: 'var(--color-bg-dialog)', border: '1px solid var(--color-border-hairline)' }}>
      <h2>MOVE TO PROJECT</h2><p>{itemPath}</p>
      {done ? <p role="status">{done}</p> : <>
        {stage === 'choice' && <><p>Keep this artifact private, or add a copy to the project's files.</p><KeepButton cwd={cwd} workflowId={workflowId} itemPath={itemPath} disabled={busy} onError={setError} onKept={() => setDone('Kept in Arco.')}>KEEP IT PRIVATE</KeepButton>{' '}<button data-help="storage.move-project" disabled={busy} onClick={() => setStage('folder')}>ADD TO PROJECT FILES</button></>}
        {stage === 'folder' && <DirectoryBrowser inline initialPath={cwd} withFilename={false} title="Choose a project folder" confirmLabel="REVIEW DESTINATION" onDone={r => { if (r) void inspect(r.dir); else setStage('choice'); }} />}
        {stage === 'review' && review && <><p>Destination: {review.target}</p><p>{review.ignored ? 'Git ignores this destination.' : 'Files here are included in your repository unless you exclude them.'}</p><p>{review.publicRepository ? 'This repository is public or marked public.' : 'The repository is not confirmed public; visibility can be unknown.'}</p><p>Size: {(review.bytes / 1000 ** 2).toFixed(1)} MB. {review.bytes > 50 * 1000 ** 2 ? 'Large copy.' : ''} {!review.ignored && review.bytes > 100 * 1000 ** 2 ? 'Over 100 MB cannot be copied into a folder included in Git.' : ''}</p>
          <p>Images, recordings and other binary files can contain private content that text scanning cannot inspect.</p>
          {review.files.some(f => f.unscanned) && <><p>Not scanned or not fully scanned:</p><ul>{review.files.filter(f => f.unscanned).map(f => <li key={f.rel}>{f.rel}</li>)}</ul></>}
          <p>Text scan: {review.files.reduce((count, file) => count + file.findings.length, 0)} findings.</p>
          <ul>{review.files.flatMap(f => f.findings.map((finding, i) => <li key={`${f.rel}:${finding.line}:${i}`}>{f.rel}:{finding.line} - {finding.rule}</li>))}</ul>
          <button data-help="storage.choose-folder" disabled={busy} onClick={() => { setReview(null); setStage('folder'); }}>CHOOSE ANOTHER FOLDER</button>{' '}
          {!review.ignored && <button data-help="storage.ignore-copy" disabled={busy} onClick={() => void ignore()}>ADD TO .GITIGNORE</button>}{' '}
          <KeepButton cwd={cwd} workflowId={workflowId} itemPath={itemPath} disabled={busy} onError={setError} onKept={() => setDone('Kept in Arco.')}>KEEP INSTEAD</KeepButton>{' '}
          <button data-help="storage.copy-confirm" disabled={busy || (!review.ignored && review.bytes > 100 * 1000 ** 2)} onClick={() => void copy()}>{review.publicRepository ? 'COPY INTO PUBLIC REPOSITORY' : 'COPY INTO PROJECT'}</button>
        </>}
      </>}
      {error && <p role="alert">{error}</p>}
      <p>The original stays in Arco. Arco does not stage or commit the copy. A failed copy can leave partial files at the destination.</p><button disabled={busy} onClick={onClose}>CLOSE</button>
    </div>
  </div>;
}
