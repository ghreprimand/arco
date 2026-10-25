import { useMemo, useState } from 'react';
import type { WorkflowConfig, ProviderName, ModelName, EffortLevel, CompareLegConfig } from '@arco/shared';
import { COMPARE_MIN_LEGS, COMPARE_MAX_LEGS } from '@arco/shared';
import { RunAsPicker, type RunAsSelection } from '../RunAsPicker';

// Compare primitive dialog — WORKBENCH_EXPANSION_PLAN.md §B1.
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
  onConfirm: (prompt: string, legs: CompareLegConfig[], blind: boolean) => void;
  onCancel: () => void;
}

export function CompareDialog({ parentConfig, onConfirm, onCancel }: Props) {
  const [prompt, setPrompt] = useState('');
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

  const canSend = prompt.trim().length > 0 && legs.length >= COMPARE_MIN_LEGS;

  const send = () => {
    if (!canSend) return;
    onConfirm(
      prompt.trim(),
      legs.map((l) => ({ provider: l.provider, model: l.model, effort: l.effort, providerAccountRef: l.providerAccountRef })),
      blind,
    );
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-bg-panel)', border: '1px solid var(--color-accent-primary-dim)',
          borderRadius: '6px', padding: '18px 22px', width: 'min(620px, 94vw)',
          maxHeight: '88vh', overflowY: 'auto', fontFamily: 'var(--font-body)',
        }}
      >
        <div className="display-font" style={{ fontSize: '12px', letterSpacing: '3px', color: 'var(--color-accent-primary)', marginBottom: '6px' }}>
          COMPARE
        </div>
        <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', lineHeight: 1.5, marginBottom: '12px' }}>
          Send ONE prompt to every leg at once and stream the answers side-by-side. Each leg is a fresh, read-only, no-tools run — no shared session, no edits. Optionally blind the labels until you vote a winner.
        </div>

        <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '4px' }}>
          PROMPT
        </div>
        <textarea
          data-help="composer.compare.prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. Write a TypeScript debounce that cancels on unmount. Explain the tradeoffs."
          rows={4}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '6px 8px',
            background: 'var(--color-bg-sunken)', border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px', color: 'var(--color-accent-primary)',
            fontFamily: 'var(--font-body)', fontSize: '11px', resize: 'vertical',
          }}
        />

        <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', margin: '14px 0 6px' }}>
          LEGS ({legs.length})
        </div>
        {legs.map((leg, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '8px' }}>
            <span className="display-font" style={{ fontSize: '11px', color: 'var(--color-fg-muted)', marginTop: '6px', minWidth: '14px' }}>
              {String.fromCharCode(65 + i)}
            </span>
            <div style={{ flex: 1 }}>
              <RunAsPicker current={currentPrimary} selection={leg} onChange={(next) => setLeg(i, next)} />
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
            + ADD LEG
          </button>
        )}

        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '14px', fontSize: '11px', color: 'var(--color-fg-muted)', cursor: 'pointer' }}>
          <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} />
          Blind — hide which leg is which until I vote
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
          <Btn onClick={onCancel}>CANCEL</Btn>
          <Btn primary disabled={!canSend} onClick={send}>RACE</Btn>
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
