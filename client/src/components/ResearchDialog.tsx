import { useMemo, useState } from 'react';
import type { WorkflowConfig, ProviderName, ModelName, EffortLevel } from '@archon/shared';
import { RESEARCH_DEFAULT_ROUNDS, RESEARCH_MAX_ROUNDS_CEILING } from '@archon/shared';
import { RunAsPicker, spawnConfigFromRunAs, type RunAsSelection } from './RunAsPicker';

// Deep Research one-off composer surface — WORKBENCH_EXPANSION_PLAN.md §B2.
// Sibling of DOCS / GIT: a topic brief + a hard round cap + the shared RUN AS
// picker. RUN AS == current primary ⇒ dispatch in-tab; otherwise spawn a fresh
// tab that issues its own research_request once created (TerminalInput wires
// the deferred dispatch via the research spawn-token registry).

interface Props {
  parentConfig: WorkflowConfig;
  // In-tab dispatch (RUN AS == current primary).
  onConfirm: (
    researcher: RunAsSelection,
    topic: string,
    maxRounds: number,
  ) => void;
  // New-tab dispatch — caller mints a spawn token, registers the pending
  // research, and creates the workflow with `spawnConfig`.
  onSpawn: (
    spawnConfig: WorkflowConfig,
    researcher: RunAsSelection,
    topic: string,
    maxRounds: number,
  ) => void;
  onCancel: () => void;
}

export function ResearchDialog({ parentConfig, onConfirm, onSpawn, onCancel }: Props) {
  const [topic, setTopic] = useState('');
  const [maxRounds, setMaxRounds] = useState(RESEARCH_DEFAULT_ROUNDS);
  const currentPrimary: RunAsSelection = useMemo(() => ({
    provider: (parentConfig.primaryProvider ?? 'claude') as ProviderName,
    model: parentConfig.primaryModel as ModelName,
    effort: parentConfig.primaryEffort as EffortLevel,
    providerAccountRef: parentConfig.providerAccountRef,
  }), [parentConfig.primaryProvider, parentConfig.primaryModel, parentConfig.primaryEffort, parentConfig.providerAccountRef]);
  const [runAs, setRunAs] = useState<RunAsSelection>(currentPrimary);
  const isCurrentPrimary = runAs.provider === currentPrimary.provider && runAs.model === currentPrimary.model && runAs.effort === currentPrimary.effort && runAs.providerAccountRef === currentPrimary.providerAccountRef;

  const clampedRounds = Math.max(1, Math.min(RESEARCH_MAX_ROUNDS_CEILING, Math.floor(maxRounds) || 1));
  const canSend = topic.trim().length > 0;

  const send = () => {
    if (!canSend) return;
    const trimmed = topic.trim();
    if (isCurrentPrimary) {
      onConfirm(runAs, trimmed, clampedRounds);
    } else {
      // spawnConfigFromRunAs forces outputStyle:'normal' for known one-off
      // suffixes; 'research' is treated the same way (reports are read
      // carefully — never caveman/lite). Match docs/git by extending the
      // suffix allowlist there; here we just pass 'research'.
      const spawnConfig = spawnConfigFromRunAs(parentConfig, runAs, 'research');
      onSpawn(spawnConfig, runAs, trimmed, clampedRounds);
    }
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 50, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-bg-panel)',
          border: '1px solid var(--color-accent-primary-dim)',
          borderRadius: '6px',
          padding: '18px 22px',
          width: 'min(540px, 94vw)',
          fontFamily: 'var(--font-body)',
        }}
      >
        <div className="display-font" style={{ fontSize: '12px', letterSpacing: '3px', color: 'var(--color-accent-primary)', marginBottom: '6px' }}>
          DEEP RESEARCH
        </div>
        <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', lineHeight: 1.5, marginBottom: '12px' }}>
          Runs one bounded research turn: the agent plans queries, searches the web, reads results, and writes a cited markdown report into the RESEARCH tab. The round cap is a hard ceiling on web-search rounds.
        </div>

        <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '4px' }}>
          TOPIC / BRIEF
        </div>
        <textarea
          data-help="composer.research.topic"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="e.g. Compare server-sent events vs. websockets for a chat backend — latency, reconnection, proxy support"
          rows={4}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '6px 8px',
            background: 'var(--color-bg-sunken)', border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px', color: 'var(--color-accent-primary)',
            fontFamily: 'var(--font-body)', fontSize: '11px', resize: 'vertical',
          }}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px' }}>
          <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)' }}>
            ROUND CAP
          </div>
          <input
            data-help="composer.research.rounds"
            type="number"
            min={1}
            max={RESEARCH_MAX_ROUNDS_CEILING}
            value={maxRounds}
            onChange={(e) => setMaxRounds(Number(e.target.value))}
            style={{
              width: '64px', padding: '4px 6px',
              background: 'var(--color-bg-sunken)', border: '1px solid var(--color-border-hairline)',
              borderRadius: '3px', color: 'var(--color-accent-primary)',
              fontFamily: 'var(--font-display)', fontSize: '11px',
            }}
          />
          <span style={{ fontSize: '9px', color: 'var(--color-fg-muted)' }}>
            max {RESEARCH_MAX_ROUNDS_CEILING} web-search rounds (hard stop)
          </span>
        </div>

        <div style={{ margin: '14px 0 4px' }}>
          <RunAsPicker current={currentPrimary} selection={runAs} onChange={setRunAs} />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
          <Btn onClick={onCancel}>CANCEL</Btn>
          <Btn primary disabled={!canSend} onClick={send}>{isCurrentPrimary ? 'RESEARCH' : 'RESEARCH (NEW TAB)'}</Btn>
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
        borderRadius: '3px',
        color: primary && !disabled ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        fontSize: '11px',
        letterSpacing: '2px',
      }}
    >
      {children}
    </button>
  );
}
