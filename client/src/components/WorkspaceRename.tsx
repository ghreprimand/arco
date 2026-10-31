import { useEffect, useRef, useState } from 'react';

type Props = { workflowId: string; name: string; onRename: (id: string, name: string, requestId: string) => boolean };

export function WorkspaceRename({ workflowId, name, onRename }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const receive = (event: Event) => {
      const result = (event as CustomEvent<{ workflowId: string; requestId: string; error?: string }>).detail;
      if (result.workflowId !== workflowId || result.requestId !== request.current) return;
      if (timer.current) clearTimeout(timer.current);
      request.current = null; setPending(false);
      if (result.error) setError(result.error); else { setOpen(false); trigger.current?.focus(); }
    };
    window.addEventListener('arco:workflow-rename-result', receive);
    return () => { window.removeEventListener('arco:workflow-rename-result', receive); if (timer.current) clearTimeout(timer.current); };
  }, [workflowId]);
  const cancel = () => { if (pending) return; if (timer.current) clearTimeout(timer.current); request.current = null; setPending(false); setOpen(false); trigger.current?.focus(); };
  const submit = () => {
    if (pending) return;
    const trimmed = draft.trim();
    if (trimmed.length > 64) { setError('Name must be at most 64 characters.'); return; }
    const id = crypto.randomUUID(); request.current = id; setError(''); setPending(true);
    if (!onRename(workflowId, trimmed, id)) { request.current = null; setPending(false); setError('Not connected. Reconnect and try again.'); return; }
    timer.current = setTimeout(() => { request.current = null; setPending(false); setError('No response received. Check the workspace name before trying again.'); }, 15000);
  };
  return <>
    <div aria-label="Workspace name row" style={{ display:'flex', alignItems:'center', gap:6, margin:'12px 12px 6px', padding:'6px 8px', border:'1px solid var(--color-border-hairline)', background:'var(--color-bg)', fontSize:11 }}>
      <span className="display-font" style={{ color:'var(--color-fg-muted)', fontSize:10, letterSpacing:'1px' }}>NAME</span>
      <span style={{ color:'var(--color-fg)', flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{name || workflowId.slice(0, 8)}</span>
    <button ref={trigger} type="button" aria-label={`Rename workspace ${name || workflowId.slice(0, 8)}`} title="Rename workspace" onPointerDown={e => e.stopPropagation()} onClick={() => { setDraft(name); setError(''); setOpen(true); }} className="display-font" style={{ padding:'4px 10px', background:'transparent', border:'1px solid var(--color-border-hairline)', color:'var(--color-fg-muted)', cursor:'pointer', fontSize:10, letterSpacing:'1px' }}>RENAME</button>
    </div>
    {open && <div role="dialog" aria-modal="true" aria-label="Rename workspace" style={{position:'fixed',inset:0,zIndex:1000,background:'rgba(0,0,0,.65)',display:'grid',placeItems:'center'}} onPointerDown={e => e.stopPropagation()}>
      <form onSubmit={e => { e.preventDefault(); submit(); }} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } }} style={{background:'var(--color-bg-panel)',border:'1px solid var(--color-border-hairline)',padding:20,display:'grid',gap:10,minWidth:280}}>
        <label className="arco-field-label">Workspace name <input className="arco-field" autoFocus value={draft} onChange={e => setDraft(e.target.value)} aria-label="Workspace name" /></label>
        <span>Up to 64 characters. Leave blank to reset the name.</span>
        {error && <span role="alert">{error}</span>}
        <div><button type="submit" disabled={pending}>{pending ? 'SAVING...' : 'SAVE'}</button> <button type="button" disabled={pending} onClick={cancel}>CANCEL</button></div>
      </form>
    </div>}
  </>;
}
