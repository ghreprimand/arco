import { useEffect, useState } from 'react';
import { useAppStore } from '../../stores/appStore';
import { DialogShell } from '../DialogShell';
import { DirectoryBrowser } from '../media/DirectoryPicker';
import { usePhoneStore } from '../../stores/phoneStore';

export function unavailableQuickStatus(previous: { phase: string; message?: string } | null, httpStatus?: number) {
  if (httpStatus === 404) return null;
  return previous && { ...previous, message: 'Could not refresh the project status.' };
}

// This control appears only on a saved Chat that owns Quick research.
export function SavedQuickKeep({ chatId }: { chatId: string }) {
  const folder = useAppStore(state => state.settings?.researchFolder);
  const roots = useAppStore(state => state.settings?.projectRoots);
  const [status, setStatus] = useState<{ phase: string; message?: string } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const url = `/api/research/saved-quick/${chatId}/keep-as-project`;
  const refresh = async () => {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) setStatus(await response.json());
      else setStatus(previous => unavailableQuickStatus(previous, response.status));
    } catch { setStatus(previous => unavailableQuickStatus(previous)); }
  };
  useEffect(() => {
    if (!choosing) return;
    const close = () => setChoosing(false);
    usePhoneStore.getState().setLocalDialog(close);
    return () => { if (usePhoneStore.getState().localDialog === close) usePhoneStore.getState().setLocalDialog(null); };
  }, [choosing]);
  useEffect(() => { setStatus(null); void refresh(); }, [chatId]);
  useEffect(() => {
    if (!status || !['waiting', 'copying', 'switching'].includes(status.phase)) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [chatId, status?.phase]);
  const keep = async (folderRoot?: string) => {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(folderRoot ? { folderRoot } : {}) });
      const body = await response.json() as { phase?: string; message?: string; error?: string; code?: string };
      if (!response.ok) {
        if (body.code === 'research_folder_missing') setChoosing(true);
        throw new Error(body.error || 'Could not keep the project.');
      }
      setStatus({ phase: body.phase ?? 'waiting', message: body.message }); setChoosing(false);
    } catch (error) { setStatus({ phase: 'error', message: error instanceof Error ? error.message : 'Could not keep the project.' }); }
  };
  if (!status) return null;
  return <div data-help="research.quick" style={{ marginTop: 8 }}>
    {status.phase !== 'done' && <button type="button" disabled={['waiting', 'copying', 'switching'].includes(status.phase)} onClick={() => folder ? void keep() : setChoosing(true)} style={{ minHeight: 44 }}>KEEP AS PROJECT</button>}
    {status.phase === 'waiting' && <div role="status">WAITING — the Chat stays usable until the copy starts.</div>}
    {['copying', 'switching'].includes(status.phase) && <div role="status">COPYING — the project is being kept.</div>}
    {status.message && (!choosing || status.phase !== 'error') && <div role="status">{status.message}</div>}
    {status.message === 'Could not refresh the project status.' && <button type="button" onClick={() => void refresh()} style={{ minHeight: 44 }}>RETRY STATUS</button>}
    {choosing && <DialogShell title="Choose the research folder" onClose={() => setChoosing(false)}>
      {status.phase === 'error' && status.message && <p role="alert">{status.message}</p>}
      <p>A project folder will be created here and this location saved for future research projects.</p>
      <DirectoryBrowser inline withFilename={false} roots={roots} title="Choose research folder" confirmLabel="KEEP HERE" onDone={choice => { if (choice) void keep(choice.dir); else setChoosing(false); }} />
    </DialogShell>}
  </div>;
}
