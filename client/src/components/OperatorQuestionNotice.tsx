import { useEffect, useState } from 'react';
import type { OperatorQuestionState } from '@arco/shared';
import { useAppStore } from '../stores/appStore';

export function OperatorQuestionNotice({ workflowId, question, error }: { workflowId: string; question: OperatorQuestionState; error?: string }) {
  const connected = useAppStore((s) => s.connected && s.jobs[workflowId]?.snapshotReceived);
  const send = useAppStore((s) => s.wsSendRaw);
  const updateMessage = useAppStore((s) => s.updateMessage);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  useEffect(() => { if (error || !connected || question.status !== 'pending') setSending(false); }, [error, question.status, connected]);
  useEffect(() => { if (question.status !== 'pending') setAnswers({}); }, [question.status]);
  const pending = question.status === 'pending';
  const ready = question.questions.every((q) => answers[q.id]?.trim());
  const disabled = !pending || !connected || !send || sending;
  const submit = () => {
    if (disabled || !ready) return;
    updateMessage(workflowId, `operator-question-${question.requestId}`, { operatorQuestionError: undefined });
    setSending(true);
    send!({ type: 'operator_question_reply', workflowId, requestId: question.requestId,
      answers: Object.fromEntries(question.questions.map((q) => [q.id, [answers[q.id]]])) });
  };
  return <div id={`operator-question-${question.requestId}`} style={{ borderLeft: '2px solid var(--color-accent-secondary)', padding: '10px 12px', background: 'var(--color-bg-sunken)', marginBottom: 12 }}>
    <div className="display-font" style={{ color: 'var(--color-accent-secondary)', fontSize: 11, letterSpacing: 1, marginBottom: 8 }}>
      {question.provider.toUpperCase()} · {pending ? question.mode === 'blocking' ? 'WAITING FOR YOUR ANSWER' : 'QUESTION · AGENT CAN CONTINUE' : question.status.toUpperCase()}
    </div>
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {question.questions.map((q, i) => <fieldset key={q.id} disabled={disabled} style={{ border: 0, padding: 0, margin: '0 0 12px', minWidth: 0 }}>
        <legend style={{ color: 'var(--color-text-primary)', fontSize: 13, whiteSpace: 'pre-wrap', marginBottom: 6 }}>{q.header && <strong>{q.header} · </strong>}{q.question}</legend>
        {pending ? <>
          {q.options?.length ? <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 6 }}>
            {q.options.map((o, index) => <button key={index} type="button" onClick={() => setAnswers((a) => ({ ...a, [q.id]: o.label }))}
              aria-pressed={answers[q.id] === o.label} style={{ padding: '6px 10px', textAlign: 'left', background: answers[q.id] === o.label ? 'var(--color-accent-secondary-a10)' : 'transparent', border: `1px solid ${answers[q.id] === o.label ? 'var(--color-accent-secondary)' : 'var(--color-border-hairline)'}`, borderRadius: 3, color: 'var(--color-text-primary)', cursor: disabled ? 'default' : 'pointer' }}>
              <span>{o.label}</span>{o.description && <span style={{ display: 'block', color: 'var(--color-fg-muted)', fontSize: 11, marginTop: 3 }}>{o.description}</span>}
            </button>)}
          </div> : null}
          {(!q.options?.length || q.allowOther) && <input aria-label={`Answer ${i + 1}: ${q.header || q.question}`} type={q.secret ? 'password' : 'text'} autoComplete="off"
            placeholder={q.options?.length ? 'Or type your own answer…' : 'Type your answer…'} value={answers[q.id] ?? ''} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
            style={{ boxSizing: 'border-box', width: '100%', padding: '6px 8px', fontSize: 12, color: 'var(--color-text-primary)', background: 'var(--color-bg-sunken)', border: '1px solid var(--color-border-hairline)', borderRadius: 3 }} />}
        </> : question.status === 'answered' && <div style={{ color: 'var(--color-fg-muted)', fontSize: 12 }}>{q.secret ? 'Answer sent (hidden)' : question.answers?.[q.id]?.join(', ')}</div>}
      </fieldset>)}
      {pending && <button type="submit" disabled={disabled || !ready} className="display-font" style={{ padding: '5px 10px', border: '1px solid var(--color-accent-secondary)', borderRadius: 3, background: 'transparent', color: 'var(--color-accent-secondary)', opacity: disabled || !ready ? 0.5 : 1 }}>{sending ? 'SENDING…' : 'SEND ANSWERS'}</button>}
      {pending && !connected && <span style={{ color: 'var(--color-fg-muted)', fontSize: 12 }}> Reconnecting before you can answer…</span>}
      {error && <div role="alert" style={{ color: 'var(--color-danger)', fontSize: 12, marginTop: 6 }}>{error}</div>}
      {question.reason && <div style={{ color: 'var(--color-fg-muted)', fontSize: 12 }}>{question.reason}</div>}
    </form>
  </div>;
}
