import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../stores/appStore';
import { OperatorQuestionNotice } from './OperatorQuestionNotice';

export function PendingQuestionsButton({ workflowId }: { workflowId: string }) {
  const messages = useAppStore((s) => s.jobs[workflowId]?.messages);
  const pending = messages?.filter((m) => m.operatorQuestion?.status === 'pending') ?? [];
  const [open, setOpen] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const prior = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('keydown', close, true);
    return () => { window.removeEventListener('keydown', close, true); prior?.focus(); };
  }, [open]);
  useEffect(() => { if (!pending.length) setOpen(false); }, [pending.length]);
  if (!pending.length) return null;
  return <>
    <button type="button" onClick={() => setOpen(true)} className="display-font" data-help="composer.questions" style={{ marginLeft: 8, padding: '2px 6px', fontSize: 10, border: '1px solid var(--color-accent-secondary)', borderRadius: 3, background: 'transparent', color: 'var(--color-accent-secondary)', cursor: 'pointer' }}>
      ? {pending.length} {pending.length === 1 ? 'QUESTION' : 'QUESTIONS'}
    </button>
    {open && createPortal(<div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 9500, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div role="dialog" aria-modal="true" aria-label="Pending agent questions" onClick={(e) => e.stopPropagation()} style={{ background: 'var(--color-bg-panel)', border: '1px solid var(--color-border-hairline)', borderRadius: 6, padding: 20, width: 560, maxWidth: 'calc(90vw / var(--ui-scale, 1))', maxHeight: 'calc(80vh / var(--ui-scale, 1))', overflowY: 'auto' }}>
        <button type="button" ref={closeButton} onClick={() => setOpen(false)} style={{ float: 'right', background: 'transparent', border: 0, color: 'var(--color-fg-muted)', cursor: 'pointer' }}>CLOSE ×</button>
        <h2 className="display-font" style={{ fontSize: 13, color: 'var(--color-accent-secondary)', marginBottom: 16 }}>PENDING QUESTIONS</h2>
        {pending.map((m) => <OperatorQuestionNotice key={m.id} workflowId={workflowId} question={m.operatorQuestion!} error={m.operatorQuestionError} />)}
      </div>
    </div>, document.body)}
  </>;
}
