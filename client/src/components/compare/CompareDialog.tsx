import { formSurfaceSize, WorkSurfaceControls } from '../workSurface/WorkSurfaceControls';
import { useMemo, useRef, useState } from 'react';
import type { WorkflowConfig, ProviderName, ModelName, EffortLevel, CompareLegConfig, ChatMessage } from '@arco/shared';
import { COMPARE_MIN_LEGS, COMPARE_MAX_LEGS } from '@arco/shared';
import { RunAsPicker, type RunAsSelection } from '../RunAsPicker';
import { readTally, sortedTally, resetTally, type Tally } from '../../utils/secondOpinionTally';
import { DEFAULT_TRANSCRIPT_INCLUDE, formatRow, turnBoundaries } from '../../utils/transcriptFormat';

// Compare primitive dialog - docs/ARCHITECTURE.md
//
// The operator types ONE prompt and picks N legs (each a {provider, model,
// effort} via the shared RUN AS picker — the same picker Review/Handoff/Spawn
// use). A "blind" flag hides leg identities in the grid until the operator
// votes. No new selection UI: each leg is just a RunAsPicker row.
//
// Fence: this is a BOUNDED job. The legs are read-only / no-tools by default
// (enforced server-side) so the race is cheap and side-effect-free — that's the
// whole point. There is deliberately NO cost / USD framing here (the operator
// is on a subscription; "cheap" means tool-free, not dollar-costed).

interface Props {
  parentConfig: WorkflowConfig;
  /** Chat messages of the tab, for the recent-turns switch. */
  messages: ChatMessage[];
  /** Text of the messages the operator selected, if the dialog was opened on a selection. */
  excerpt: string;
  onConfirm: (prompt: string, legs: CompareLegConfig[], blind: boolean, replyDraft: { context: string; fileAccess: boolean }) => void;
  onCancel: () => void;
}

// How much of the tab's recent conversation the switch carries.
const RECENT_TURNS = 3;
const RECENT_MAX_CHARS = 12_000;
const CONTEXT_MAX_CHARS = 24 * 1024;

export function recentTurnsText(messages: ChatMessage[], tabName: string): string {
  const bounds = turnBoundaries(messages);
  const start = bounds.length > RECENT_TURNS ? bounds[bounds.length - RECENT_TURNS] : 0;
  const rows = messages.slice(start).map((m) => formatRow(m, tabName, DEFAULT_TRANSCRIPT_INCLUDE)).filter((r): r is string => !!r);
  const text = rows.join('\n\n');
  return text.length > RECENT_MAX_CHARS ? text.slice(-RECENT_MAX_CHARS) : text;
}

export function opinionContext(excerpt: string, recent: string): { context: string; selected: string; turns: string } {
  const selection = excerpt.trim();
  const recentText = recent.trim();
  const selectedPart = selection ? `Selected from the worker's session:\n\n${selection}` : '';
  const turnsPart = recentText ? `Recent turns of the worker's session:\n\n${recentText}` : '';
  const separator = selectedPart && turnsPart ? '\n\n---\n\n' : '';
  const full = selectedPart + separator + turnsPart;
  const cutoff = Math.max(0, full.length - CONTEXT_MAX_CHARS);
  const status = (part: string, start: number) => {
    if (!part) return 'not included';
    if (cutoff >= start + part.length) return 'omitted (context limit)';
    return cutoff > start ? 'partly included (context limit)' : 'included';
  };
  return { context: full.slice(-CONTEXT_MAX_CHARS), selected: status(selectedPart, 0), turns: status(turnsPart, selectedPart.length + separator.length) };
}

export function CompareDialog({ parentConfig, messages, excerpt, onConfirm, onCancel }: Props) {
  const surface = useRef<HTMLDivElement>(null);
  const [prompt, setPrompt] = useState('');
  const [includeTurns, setIncludeTurns] = useState(() => !excerpt.trim());
  const [fileAccess, setFileAccess] = useState(false);
  const [tally, setTally] = useState<Tally>(() => readTally());
  const [blind, setBlind] = useState(true);

  const currentPrimary: RunAsSelection = useMemo(() => ({
    provider: (parentConfig.primaryProvider ?? 'claude') as ProviderName,
    model: parentConfig.primaryModel as ModelName,
    effort: parentConfig.primaryEffort as EffortLevel,
    providerAccountRef: parentConfig.providerAccountRef,
  }), [parentConfig.primaryProvider, parentConfig.primaryModel, parentConfig.primaryEffort, parentConfig.providerAccountRef]);

  // Seed two legs: the current primary, then a sensible "other" default so the
  // operator can race A-vs-B with one edit. Both are freely re-pickable.
  const [legs, setLegs] = useState<RunAsSelection[]>(() => [
    currentPrimary,
    currentPrimary.provider === 'claude'
      ? { provider: 'codex', model: 'gpt-5-codex', effort: 'medium' } as RunAsSelection
      : { provider: 'claude', model: 'opus', effort: 'high' } as RunAsSelection,
  ]);

  const setLeg = (i: number, next: RunAsSelection) => setLegs((ls) => ls.map((l, j) => (j === i ? next : l)));
  const addLeg = () => setLegs((ls) => (ls.length >= COMPARE_MAX_LEGS ? ls : [...ls, currentPrimary]));
  const removeLeg = (i: number) => setLegs((ls) => (ls.length <= COMPARE_MIN_LEGS ? ls : ls.filter((_, j) => j !== i)));

  const context = opinionContext(excerpt, includeTurns ? recentTurnsText(messages, parentConfig.name) : '');
  const canSend = (prompt.trim().length > 0 || excerpt.trim().length > 0) && legs.length >= COMPARE_MIN_LEGS;

  const send = () => {
    if (!canSend) return;
    onConfirm(
      prompt.trim(),
      legs.map((l) => ({ provider: l.provider, model: l.model, effort: l.effort, providerAccountRef: l.providerAccountRef })),
      blind,
      {
        context: context.context,
        fileAccess,
      },
    );
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onCancel}
    >
      <div
        ref={surface}
        data-help="composer.compare"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-bg-dialog)', border: '1px solid var(--color-accent-primary-dim)',
          borderRadius: '6px', padding: '18px 22px', ...formSurfaceSize(), overflowY: 'auto', fontFamily: 'var(--font-body)',
        }}
      >
        <WorkSurfaceControls surface={surface} storageKey="second-opinion-setup" />
        <div className="display-font" style={{ fontSize: '12px', letterSpacing: '3px', color: 'var(--color-accent-primary)', marginBottom: '6px' }}>
          SECOND OPINION
        </div>
        <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', lineHeight: 1.5, marginBottom: '12px' }}>
          Not sure how to answer the worker? Each model below drafts, independently, the reply you could send. Nothing is edited, no model sees another's draft, and nothing is sent: pick one (or synthesize) and USE THIS REPLY puts it in this tab's composer for you to edit.
        </div>

        {excerpt.trim() && (
          <>
            <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '4px' }}>
              SELECTED MESSAGES
            </div>
            <pre data-testid="second-opinion-excerpt" style={{ margin: '0 0 12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '140px', overflowY: 'auto', fontSize: '11px', background: 'var(--color-bg-sunken)', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', padding: '6px 8px' }}>{excerpt}</pre>
          </>
        )}

        <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '4px' }}>
          YOUR QUESTION{excerpt.trim() ? ' (OPTIONAL)' : ''}
        </div>
        <textarea
          data-help="composer.compare.prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={excerpt.trim() ? 'e.g. Say yes, but ask it to keep the change small' : 'e.g. The worker asks whether to refactor now or later. What should I tell it?'}
          rows={4}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '6px 8px',
            background: 'var(--color-bg-sunken)', border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px', color: 'var(--color-accent-primary)',
            fontFamily: 'var(--font-body)', fontSize: '11px', resize: 'vertical',
          }}
        />

        <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', margin: '14px 0 6px' }}>
          MODELS ({legs.length})
        </div>
        {legs.map((leg, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '8px' }}>
            <span className="display-font" style={{ fontSize: '11px', color: 'var(--color-fg-muted)', marginTop: '6px', minWidth: '14px' }}>
              {String.fromCharCode(65 + i)}
            </span>
            <div style={{ flex: 1 }}>
              <RunAsPicker current={currentPrimary} selection={leg} onChange={(next) => setLeg(i, next)} hint="This model drafts a reply on its own. Nothing is dispatched or opened in a new tab." />
            </div>
            {legs.length > COMPARE_MIN_LEGS && (
              <button
                onClick={() => removeLeg(i)}
                className="display-font"
                title="Remove this leg"
                style={{ marginTop: '4px', padding: '2px 7px', background: 'transparent', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-fg-muted)', cursor: 'pointer', fontSize: '11px' }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        {legs.length < COMPARE_MAX_LEGS && (
          <button
            onClick={addLeg}
            className="display-font"
            style={{ padding: '3px 10px', background: 'transparent', border: '1px dashed var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-accent-secondary-dim)', cursor: 'pointer', fontSize: '10px', letterSpacing: '1px' }}
          >
            + ADD MODEL
          </button>
        )}

        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '14px', fontSize: '11px', color: 'var(--color-fg-muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={includeTurns} onChange={(e) => setIncludeTurns(e.target.checked)} />
          Include this tab's last {RECENT_TURNS} turns (up to about {Math.round(RECENT_MAX_CHARS / 1000)} KB)
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px', fontSize: '11px', color: 'var(--color-fg-muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={fileAccess} onChange={(e) => setFileAccess(e.target.checked)} />
          Let the models read project files (read-only: no edits, no web, no extra tools). Off: they answer from the text above only.
        </label>

        <div data-testid="second-opinion-context-summary" style={{ marginTop: '10px', fontSize: '11px', lineHeight: 1.5, color: 'var(--color-fg-muted)' }}>
          Models see your question and the following context (about {context.context.length.toLocaleString()} characters):<br />
          Selected messages: {context.selected}. Recent turns: {context.turns}{includeTurns ? ' (up to the last 3 turns, at most 12,000 characters)' : ''}.<br />
          Project files: {fileAccess ? 'read-only access' : 'no access'}.
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px', fontSize: '11px', color: 'var(--color-fg-muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} />
          Blind: hide which model wrote which draft until I pick one
        </label>

        {sortedTally(tally).length > 0 && (
          <div data-testid="second-opinion-tally" style={{ marginTop: '12px', fontSize: '10px', color: 'var(--color-fg-muted)', lineHeight: 1.6 }}>
            <span className="display-font" style={{ letterSpacing: '1px' }}>YOUR PICKS SO FAR (THIS BROWSER): </span>
            {sortedTally(tally).map(([k, n]) => `${k} ${n}`).join(' · ')}{' '}
            <button type="button" className="display-font" onClick={() => { resetTally(); setTally({}); }} style={{ marginLeft: '6px', background: 'transparent', border: '1px solid var(--color-border-hairline)', color: 'var(--color-fg-muted)', fontSize: '9px', cursor: 'pointer', padding: '1px 6px' }}>RESET</button>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
          <Btn onClick={onCancel}>CANCEL</Btn>
          <Btn primary disabled={!canSend} onClick={send}>ASK THE MODELS</Btn>
        </div>
      </div>
    </div>
  );
}

function Btn({ onClick, children, primary, disabled }: { onClick: () => void; children: React.ReactNode; primary?: boolean; disabled?: boolean }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className="display-font"
      style={{
        padding: '6px 14px',
        background: primary && !disabled ? 'var(--color-accent-primary-a10)' : 'transparent',
        border: `1px solid ${primary && !disabled ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
        borderRadius: '3px', color: primary && !disabled ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
        fontSize: '11px', letterSpacing: '2px',
      }}
    >
      {children}
    </button>
  );
}
