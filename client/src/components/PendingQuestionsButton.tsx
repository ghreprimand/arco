import { formSurfaceSize, WorkSurfaceControls } from './workSurface/WorkSurfaceControls';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../stores/appStore';
import { OperatorQuestionNotice } from './OperatorQuestionNotice';
import { AskUserQuestionNotice, parseAskNotice } from './AskUserQuestionNotice';
import { GateApprovalNotice } from './GateApprovalNotice';
import type { ChatMessage } from '@arco/shared';

/** The questions and sub-agent batch approvals still waiting in one
 * conversation, as listed by PENDING QUESTIONS. With `all` (the mobile view's
 * question line and sheet) it also includes ordinary Claude Native questions
 * and parked review gates, so every decision the conversation waits on can be
 * answered there without finding its card in the transcript. */
export function usePendingQuestions(workflowId: string, all = false) {
  const messages = useAppStore((s) => s.jobs[workflowId]?.messages);
  const nativeIds = useAppStore((s) => s.jobs[workflowId]?.claudeNativePendingQuestionIds);
  return pendingDecisions(messages, nativeIds, all);
}

export function pendingDecisions(messages: ChatMessage[] | undefined, nativeIds: string[] | undefined, all = false) {
  const pending = messages?.filter((m) => m.operatorQuestion?.status === 'pending') ?? [];
  const asks = (messages ?? []).flatMap((message) => {
    const ask = parseAskNotice(message.content);
    return ask && nativeIds?.includes(ask.questionId) && (all || ask.batchModels) ? [{ message, ask }] : [];
  });
  const batches = asks.filter(({ ask }) => ask.batchModels);
  const gates = all ? pendingGates(messages) : [];
  return { pending, batches, asks: all ? asks : batches, gates, count: pending.length + (all ? asks.length : batches.length) + gates.length };
}

/** Review gates parked for the operator's approval (GateApprovalNotice cards). */
export function pendingGates(messages: ChatMessage[] | undefined): ChatMessage[] {
  return (messages ?? []).filter((m) => m.toolUse?.tool === 'Gate' && !['approve', 'reject'].includes(String((m.toolUse.input as Record<string, unknown> | undefined)?.status ?? 'pending')));
}

/** The waiting questions of one conversation, answerable in place. */
export function PendingQuestionsList({ workflowId, all = false }: { workflowId: string; all?: boolean }) {
  const { pending, asks, gates } = usePendingQuestions(workflowId, all);
  return <>
    {pending.map((m) => <OperatorQuestionNotice key={m.id} workflowId={workflowId} question={m.operatorQuestion!} error={m.operatorQuestionError} />)}
    {asks.map(({ message, ask }) => <AskUserQuestionNotice key={message.id} workflowId={workflowId} questionId={ask.questionId} question={ask.question} options={ask.options} batchModels={ask.batchModels} content={message.content} messageId={message.id} />)}
    {gates.map((m) => <GateApprovalNotice key={m.id} workflowId={workflowId} input={m.toolUse!.input as Record<string, unknown>} />)}
  </>;
}

export function PendingQuestionsButton({ workflowId }: { workflowId: string }) {
  const { count } = usePendingQuestions(workflowId);
  const [open, setOpen] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prior = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const close = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('keydown', close, true);
    return () => { window.removeEventListener('keydown', close, true); prior?.focus(); };
  }, [open]);
  useEffect(() => { if (!count) setOpen(false); }, [count]);
  if (!count) return null;
  return <>
    <button type="button" onClick={() => setOpen(true)} className="display-font" data-help="composer.questions" style={{ marginLeft: 8, padding: '2px 6px', fontSize: 10, border: '1px solid var(--color-accent-secondary)', borderRadius: 3, background: 'transparent', color: 'var(--color-accent-secondary)', cursor: 'pointer' }}>
      ? {count} {count === 1 ? 'QUESTION' : 'QUESTIONS'}
    </button>
    {open && createPortal(<div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 9500, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div ref={surface} role="dialog" aria-modal="true" aria-label="Pending agent questions" onClick={(e) => e.stopPropagation()} style={{ background: 'var(--color-bg-dialog)', border: '1px solid var(--color-border-hairline)', borderRadius: 6, padding: 20, ...formSurfaceSize(), overflowY: 'auto' }}>
        <WorkSurfaceControls surface={surface} storageKey="pending-questions" />
        <button type="button" ref={closeButton} onClick={() => setOpen(false)} style={{ float: 'right', background: 'transparent', border: 0, color: 'var(--color-fg-muted)', cursor: 'pointer' }}>CLOSE ×</button>
        <h2 className="display-font" style={{ fontSize: 13, color: 'var(--color-accent-secondary)', marginBottom: 16 }}>PENDING QUESTIONS</h2>
        <PendingQuestionsList workflowId={workflowId} />
      </div>
    </div>, document.body)}
  </>;
}
