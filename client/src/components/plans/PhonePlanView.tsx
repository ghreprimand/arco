// docs/CLIENT.md "Mobile view" - the plan page on a phone: read the plan and
// tick its items. Editing the text and the plan actions are the page's
// actions, not part of this view.

import type { ReactNode } from 'react';
import { splitRefLinks } from './planRefs';
import { phonePlanChecklist } from './phonePlanChecklist';

interface Props {
  title?: string;
  body: string;
  onToggle: (lineIndex: number) => void;
  onOpenRef?: (slug: string) => void;
}

const sectionTitle = { fontSize: '13px', fontWeight: 700, letterSpacing: '1.5px', color: 'var(--color-fg)' } as const;

export function PhonePlanView({ title, body, onToggle, onOpenRef }: Props) {
  const plan = phonePlanChecklist(body);
  const withRefs = (text: string): ReactNode => !onOpenRef || !text.includes('ref:') ? text : splitRefLinks(text).map((part, k) => typeof part === 'string' ? part : (
    <button key={k} type="button" onClick={() => onOpenRef(part.slug)} title={`Open reference doc ref:${part.slug}`}
      style={{ display: 'inline', minHeight: 0, minWidth: 0, padding: '0 6px', margin: '0 2px', background: 'var(--color-accent-secondary-a10)', border: '1px solid var(--color-accent-secondary-dim)', borderRadius: '3px', color: 'var(--color-accent-secondary)', font: 'inherit', fontSize: '13px', cursor: 'pointer' }}>
      {part.label}
    </button>
  ));
  return (
    <div data-testid="phone-plan" data-help="plan.phone" style={{ display: 'flex', flexDirection: 'column', gap: '10px', color: 'var(--color-fg)', fontSize: '15px', lineHeight: 1.45 }}>
      <div>
        {title && <div className="display-font" style={{ ...sectionTitle, color: 'var(--color-accent-primary)', fontSize: '14px' }}>{title}</div>}
        <div data-testid="phone-plan-progress" style={{ fontSize: '13px', color: 'var(--color-fg-muted)' }}>{plan.total ? `${plan.done} of ${plan.total} done` : 'No checklist items yet.'}</div>
      </div>
      {plan.intro.some((line) => line.trim()) && (
        <details style={{ border: '1px solid var(--color-border-hairline)', padding: '0 10px' }}>
          <summary className="display-font" style={{ ...sectionTitle, minHeight: '44px', display: 'flex', alignItems: 'center', cursor: 'pointer' }}>ABOUT THIS PLAN</summary>
          <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '14px', paddingBottom: '10px' }}>{withRefs(plan.intro.join('\n').trim())}</div>
        </details>
      )}
      {plan.phases.map((phase, p) => {
        const finished = phase.items.length > 0 && phase.items.every((i) => i.checked);
        const count = phase.items.filter((i) => i.checked).length;
        return (
          <details key={p} open={!finished} data-testid="phone-plan-phase" style={{ border: '1px solid var(--color-border-hairline)' }}>
            <summary className="display-font" style={{ ...sectionTitle, minHeight: '48px', display: 'flex', alignItems: 'center', gap: '8px', padding: '0 10px', cursor: 'pointer' }}>
              <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{phase.heading || 'ITEMS'}</span>
              <span style={{ fontSize: '12px', color: finished ? 'var(--color-success, var(--color-accent-primary))' : 'var(--color-fg-muted)', whiteSpace: 'nowrap' }}>{count} of {phase.items.length}</span>
            </summary>
            {phase.notes.length > 0 && <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '13px', color: 'var(--color-fg-muted)', padding: '0 10px 6px' }}>{withRefs(phase.notes.join('\n'))}</div>}
            {phase.items.map((item) => (
              <div key={item.lineIndex} style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: `8px 10px 8px ${10 + item.depth * 16}px`, borderTop: '1px solid var(--color-border-hairline)' }}>
                <button type="button" data-testid="phone-plan-item" data-help="plan.checkbox" role="checkbox" aria-checked={item.checked}
                  aria-label={`${item.checked ? 'Mark as not done' : 'Mark as done'}: ${item.text}`} onClick={() => onToggle(item.lineIndex)}
                  style={{ flexShrink: 0, width: '44px', height: '44px', minWidth: '44px', minHeight: '44px', margin: '-8px 0 -8px -10px', padding: 0, background: 'transparent', border: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                  <span aria-hidden="true" style={{ width: '22px', height: '22px', border: '2px solid var(--color-accent-primary)', background: item.checked ? 'var(--color-accent-primary)' : 'transparent', color: 'var(--color-bg-panel)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', lineHeight: 1 }}>{item.checked ? '\u2713' : ''}</span>
                </button>
                <div style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere', paddingTop: '2px' }}>
                  <div style={{ textDecoration: item.checked ? 'line-through' : 'none', opacity: item.checked ? 0.65 : 1 }}>{withRefs(item.text)}</div>
                  {item.notes.length > 0 && <div style={{ fontSize: '13px', color: 'var(--color-fg-muted)', whiteSpace: 'pre-wrap' }}>{withRefs(item.notes.join('\n'))}</div>}
                </div>
              </div>
            ))}
          </details>
        );
      })}
    </div>
  );
}
