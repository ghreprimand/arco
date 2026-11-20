import { useEffect, useState, type CSSProperties } from 'react';
import { useAppStore } from '../stores/appStore';

// Recognize `[ASK:claude-native:<questionId>] <body>` system_notice sentinels
// emitted by the Claude Native worker's AskUserQuestion tool. Optional
// `[ASK_OPTIONS:opt1 | opt2 | …]` line on the second line renders option chips.
// Submitting POSTs an `ask_user_question_reply` WS message; the worker resolves
// the awaiting tool-result promise and the agent loop continues.
const ASK_NOTICE_RE = /^\[ASK:claude-native:([a-zA-Z0-9_-]+)\]\s+([\s\S]*)$/;
const ASK_OPTIONS_RE = /^\[ASK_OPTIONS:([\s\S]*)\]$/;
const ASK_ANSWERED_RE = /^\[ASK_ANSWERED:([\s\S]*)\]$/;
const batchControl: CSSProperties = { minHeight: 44, maxWidth: '100%', padding: '6px 10px', background: 'var(--color-bg-panel)', color: 'var(--color-control-fg)', border: '1px solid var(--color-border-hairline)', borderRadius: 3, whiteSpace: 'normal', overflowWrap: 'anywhere' };

export interface ParsedAskNotice {
  workflowId?: string; // filled by caller from the message's workflowId
  questionId: string;
  question: string;
  options?: string[];
  answered?: string;
}

export function parseAskNotice(content: string): { questionId: string; question: string; options?: string[]; answered?: string; batchModels?: string[] } | null {
  const m = content.match(ASK_NOTICE_RE);
  if (!m) return null;
  const questionId = m[1];
  let body = m[2];
  let options: string[] | undefined;
  let answered: string | undefined;
  // Options sit on the last line of body when present.
  const lines = body.split('\n');
  let last = lines[lines.length - 1];
  const answeredMatch = last.match(ASK_ANSWERED_RE);
  if (answeredMatch) {
    try {
      answered = decodeURIComponent(answeredMatch[1]);
    } catch {
      answered = answeredMatch[1];
    }
    lines.pop();
    last = lines[lines.length - 1] ?? '';
  }
  const optMatch = last.match(ASK_OPTIONS_RE);
  if (optMatch) {
    options = optMatch[1].split(/(?<!\\)\|/).map((s) => s.trim().replace(/\\\|/g, '|')).filter(Boolean);
    body = lines.slice(0, -1).join('\n').trimEnd();
  } else {
    body = lines.join('\n').trimEnd();
  }
  let batchModels: string[] | undefined;
  const batch = body.match(/^\[BATCH_APPROVAL:([A-Za-z0-9_-]+)\]\n/);
  if (batch) {
    try {
      const bytes = Uint8Array.from(atob(batch[1].replace(/-/g, '+').replace(/_/g, '/')), (character) => character.charCodeAt(0));
      const decoded = JSON.parse(new TextDecoder().decode(bytes));
      if (Array.isArray(decoded.models) && decoded.models.every((m: unknown) => typeof m === 'string')) batchModels = decoded.models;
    } catch { /* invalid batch notices remain ordinary text */ }
    if (batchModels) body = body.slice(batch[0].length);
  }
  return { questionId, question: body, options, answered, ...(batchModels ? { batchModels } : {}) };
}

export function markAskNoticeAnswered(content: string, reply: string): string {
  const lines = content.split('\n');
  if (ASK_ANSWERED_RE.test(lines[lines.length - 1] ?? '')) return content;
  return `${content}\n[ASK_ANSWERED:${encodeURIComponent(reply)}]`;
}

interface Props {
  workflowId: string;
  questionId: string;
  question: string;
  options?: string[];
  answered?: string;
  messageId?: string;
  content: string;
  batchModels?: string[];
}

export function AskUserQuestionNotice({ workflowId, questionId, question, options, answered, messageId, content, batchModels }: Props) {
  const [state, setState] = useState<'idle' | 'sent'>(answered ? 'sent' : 'idle');
  const [submittedAnswer, setSubmittedAnswer] = useState(answered ?? '');
  const [value, setValue] = useState('');
  const [model, setModel] = useState(batchModels?.[0] ?? '');
  useEffect(() => {
    if (answered) { setSubmittedAnswer(answered); setState('sent'); }
    else if (batchModels && submittedAnswer === 'closed') { setSubmittedAnswer(''); setState('idle'); }
  }, [answered, batchModels, submittedAnswer]);
  const sendRaw = useAppStore((s) => s.wsSendRaw);
  const updateMessage = useAppStore((s) => s.updateMessage);

  const submit = (reply: string) => {
    if (state !== 'idle') return;
    const trimmed = reply.trim();
    if (!trimmed || !sendRaw) return;
    if (sendRaw({ type: 'ask_user_question_reply', workflowId, questionId, reply: trimmed }) === false) return;
    setSubmittedAnswer(batchModels ? 'sending' : trimmed);
    setState('sent');
    if (messageId && !batchModels) {
      updateMessage(workflowId, messageId, {
        content: markAskNoticeAnswered(content, trimmed),
      });
    }
  };

  if (state === 'sent') {
    const answerLabel = batchModels
      ? submittedAnswer === 'allow' ? 'Allowed' : submittedAnswer === 'deny' ? 'Denied' : submittedAnswer.startsWith('model:') ? `Allowed on ${submittedAnswer.slice(6)}` : submittedAnswer === 'sending' ? 'Sending...' : 'Closed'
      : `Answered: ${submittedAnswer}`;
    return (
      <div style={{ marginBottom: '10px', maxWidth: '100%' }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            padding: '4px 8px',
            borderLeft: '2px solid var(--color-accent-secondary)',
            background: 'var(--color-bg-sunken)',
            color: 'var(--color-fg-muted)',
            fontSize: '11px',
            fontFamily: 'var(--font-body)',
          }}
        >
          <span className="display-font" style={{ color: 'var(--color-accent-secondary)', letterSpacing: '1px' }}>[ASK:CLAUDE]</span>
          <span>{answerLabel}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      data-help="chat.ask-question"
      style={{
        animation: 'fade-in-up 0.3s ease-out',
        marginBottom: '16px',
        maxWidth: '100%',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '4px',
          fontSize: '11px',
          fontFamily: 'var(--font-display)',
          letterSpacing: '1px',
          color: 'var(--color-accent-secondary)',
        }}
      >
        <span>[ASK:CLAUDE]</span>
      </div>
      <div
        style={{
          padding: '10px 12px',
          borderLeft: '2px solid var(--color-accent-secondary)',
          marginLeft: '4px',
          background: 'var(--color-bg-sunken)',
        }}
      >
        <div style={{ color: 'var(--color-text-primary)', fontSize: '13px', fontFamily: 'var(--font-body)', lineHeight: '1.5', marginBottom: '8px', whiteSpace: 'pre-wrap' }}>{question}</div>
        {batchModels ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', minWidth: 0 }}>
            <button type="button" className="display-font" style={batchControl} onClick={() => submit('allow')}>ALLOW</button>
            <label style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, maxWidth: '100%', minWidth: 0 }}>Another model <select style={{ ...batchControl, maxWidth: '100%', minWidth: 0 }} value={model} onChange={(event) => setModel(event.target.value)}>{batchModels.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
            <button type="button" className="display-font" style={batchControl} disabled={!model} onClick={() => submit(`model:${model}`)}>ALLOW ON ANOTHER MODEL</button>
            <button type="button" className="display-font" style={batchControl} onClick={() => submit('deny')}>DENY</button>
          </div>
        ) : options && options.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
            {options.map((opt, i) => (
              <button
                key={i}
                onClick={() => submit(opt)}
                disabled={state !== 'idle'}
                className="display-font"
                style={{
                  padding: '4px 10px',
                  fontSize: '11px',
                  letterSpacing: '1px',
                  background: state === 'idle' ? 'var(--color-accent-secondary-a10)' : 'transparent',
                  border: '1px solid var(--color-accent-secondary)',
                  color: 'var(--color-accent-secondary)',
                  borderRadius: '3px',
                  cursor: state === 'idle' ? 'pointer' : 'default',
                  opacity: state === 'idle' ? 1 : 0.5,
                }}
              >
                {opt}
              </button>
            ))}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '6px' }}>
            <input
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(value); } }}
              placeholder="Type your reply…"
              disabled={state !== 'idle'}
              autoFocus
              style={{ flex: 1, padding: '4px 6px', fontSize: '12px', fontFamily: 'var(--font-body)', background: 'var(--color-bg-sunken)', border: '1px solid var(--color-border-hairline)', color: 'var(--color-text-primary)', borderRadius: '3px', outline: 'none' }}
            />
            <button
              onClick={() => submit(value)}
              disabled={!value.trim() || state !== 'idle'}
              className="display-font glow-border"
              style={{
                padding: '4px 12px',
                fontSize: '10px',
                letterSpacing: '2px',
                background: state === 'idle' && value.trim() ? 'var(--color-accent-secondary-a10)' : 'transparent',
                border: '1px solid var(--color-accent-secondary)',
                color: 'var(--color-accent-secondary)',
                borderRadius: '3px',
                cursor: state === 'idle' && value.trim() ? 'pointer' : 'default',
              }}
            >
              {state === 'idle' ? 'SUBMIT' : 'SENT'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
