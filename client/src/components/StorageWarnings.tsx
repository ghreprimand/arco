import { useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { useStorageWarningStore } from '../stores/storageWarningStore';
import { KeepButton } from './KeepButton';

export function StorageWarnings() {
  const warnings = useStorageWarningStore(s => s.warnings);
  const remove = useStorageWarningStore(s => s.removeItem);
  const jobs = useAppStore(s => s.jobs);
  const [error, setError] = useState('');
  if (!warnings.length) return null;
  return <aside role="status" data-help="storage.warning" style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 9998, maxWidth: 440, padding: 12, background: 'var(--color-bg-dialog)', border: '1px solid var(--color-warning)' }}>
    <strong>Large artifacts</strong><p>These files use considerable storage. KEEP protects them from cleanup and archive.</p>
    {error && <p role="alert">{error}</p>}
    {warnings.flatMap(w => w.items.map(i => <div key={`${w.workflowId}:${i.path}`} style={{ marginTop: 8 }}>
      <span>{jobs[w.workflowId]?.config.name || w.workflowId.slice(0, 8)}: {i.path} ({(i.bytes / 1024 ** 2).toFixed(1)} MiB)</span>{' '}
      <KeepButton cwd={jobs[w.workflowId]?.config.workingDirectory} workflowId={w.workflowId} itemPath={i.path} reason="size-warning" help="storage.warning-keep" onError={setError} onKept={() => remove(w.workflowId, i.path)} />{' '}
      <button data-help="storage.warning-dismiss" onClick={() => remove(w.workflowId, i.path)}>DISMISS</button>
    </div>))}
  </aside>;
}
