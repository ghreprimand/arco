// Mobile view: a waiting question, approval or review gate shows as one bar
// above the message box, in thumb reach. ANSWER opens the questions sheet
// (MobileShell), where it is answered in place.

import { usePendingQuestions } from './PendingQuestionsButton';
import { usePhoneStore } from '../stores/phoneStore';

/** The first words of what waits: a question, an ask, or the tool a gate holds. */
export function firstQuestionText(questions: ReturnType<typeof usePendingQuestions>): string {
  const q = questions.pending[0]?.operatorQuestion?.questions[0];
  if (q) return q.question || q.header;
  if (questions.asks[0]) return questions.asks[0].ask.question;
  const gate = questions.gates[0]?.toolUse?.input as Record<string, unknown> | undefined;
  return gate ? `Approve ${String(gate.toolName ?? 'a tool call')}?` : '';
}

export function MobileQuestionBar({ workflowId }: { workflowId: string }) {
  const questions = usePendingQuestions(workflowId, true);
  const openSheet = usePhoneStore((s) => s.openSheet);
  if (questions.count === 0) return null;
  const first = firstQuestionText(questions);
  const label = questions.count > 1 ? `${questions.count} WAITING` : questions.gates.length ? 'APPROVAL' : 'QUESTION';
  return (
    <button type="button" data-testid="mobile-question" data-help="mobile.question" onClick={() => openSheet('questions', workflowId)}
      aria-label={`${questions.count === 1 ? 'A decision is' : `${questions.count} decisions are`} waiting: ${first}. Answer.`}
      style={{
        display: 'flex', alignItems: 'center', gap: '8px', width: '100%', minHeight: '48px', marginBottom: '6px', padding: '0 0 0 10px', textAlign: 'left',
        background: 'transparent', border: '2px solid var(--color-warning)', borderRadius: 0, color: 'var(--color-fg)', cursor: 'pointer', overflow: 'hidden',
      }}>
      <span className="display-font" style={{ flexShrink: 0, fontSize: '12px', fontWeight: 700, letterSpacing: '1px' }}><span aria-hidden="true" style={{ color: 'var(--color-warning)' }}>{'\u25B2'}</span> {label}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-body)', fontSize: '14px' }}>{first}</span>
      <span className="display-font" aria-hidden="true" style={{ flexShrink: 0, alignSelf: 'stretch', display: 'flex', alignItems: 'center', padding: '0 12px', borderLeft: '2px solid var(--color-warning)', color: 'var(--color-warning)', fontSize: '13px', fontWeight: 700, letterSpacing: '1px' }}>ANSWER</span>
    </button>
  );
}
