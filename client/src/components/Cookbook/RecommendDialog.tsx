import { useMemo, useState } from 'react';
import type { ProviderName, ModelName, EffortLevel, CookbookTaskProfile, HardwareSimPreset } from '@arco/shared';
import { COOKBOOK_TASK_PROFILES, RESEARCH_DEFAULT_ROUNDS, RESEARCH_MAX_ROUNDS_CEILING } from '@arco/shared';
import { useAppStore } from '../../stores/appStore';
import { sendCookbookRecommend } from '../../stores/cookbookStore';
import { RunAsPicker, type RunAsSelection } from '../RunAsPicker';

// Workbench Expansion G3 — Cookbook agent-driven recommendation dialog.
//
// REUSES the B2 Deep-Research bounded turn: pick a task profile + an agent (RUN
// AS) + a round cap, click RECOMMEND, and the server grounds ONE bounded research
// turn on the G1 hardware profile + the G2 fit-filtered candidates. The result is
// a research artifact that lands in the active tab's RESEARCH tab (the lifecycle
// flows through the existing research_* events).
//
// Fence: the agent RECOMMENDS only — it returns a free-text research artifact,
// NOT a structured pick. So G4 does NOT auto-download "the winner" from the
// dialog (there is no machine-readable repo/quant to act on without a second-LLM
// parse, which the fences forbid). Instead, the operator reads the report, then
// downloads the recommended row from the catalog table (DownloadActions). The
// dialog's apply affordance closes back to the table — the download itself is an
// explicit per-row DOWNLOAD click. Nothing here auto-downloads or auto-applies.

const PROFILE_LABELS: Record<CookbookTaskProfile, string> = {
  coding: 'Coding assistant',
  'fast-autocomplete': 'Fast autocomplete',
  'long-context': 'Long-context analysis',
  vision: 'Vision (multimodal)',
  general: 'General-purpose',
};

interface Props {
  // The catalog search text + active sim preset, forwarded so the server scores
  // the SAME candidate set the operator is looking at.
  query?: string;
  sim?: HardwareSimPreset;
  onClose: () => void;
}

export function RecommendDialog({ query, sim, onClose }: Props) {
  const activeJobId = useAppStore((s) => s.activeJobId);
  const activeConfig = useAppStore((s) => (s.activeJobId ? s.jobs[s.activeJobId]?.config : undefined));

  const [taskProfile, setTaskProfile] = useState<CookbookTaskProfile>('coding');
  const [maxRounds, setMaxRounds] = useState(RESEARCH_DEFAULT_ROUNDS);
  const [dispatched, setDispatched] = useState(false);

  const currentPrimary: RunAsSelection = useMemo(() => ({
    provider: (activeConfig?.primaryProvider ?? 'claude') as ProviderName,
    model: activeConfig?.primaryModel as ModelName,
    effort: activeConfig?.primaryEffort as EffortLevel,
    providerAccountRef: activeConfig?.providerAccountRef,
  }), [activeConfig?.primaryProvider, activeConfig?.primaryModel, activeConfig?.primaryEffort, activeConfig?.providerAccountRef]);
  const [runAs, setRunAs] = useState<RunAsSelection>(currentPrimary);

  const clampedRounds = Math.max(1, Math.min(RESEARCH_MAX_ROUNDS_CEILING, Math.floor(maxRounds) || 1));
  // The recommendation always runs against the active workflow (its artifact
  // lands in that tab's RESEARCH tab). Without an active tab there's nowhere to
  // put it, so the button is disabled.
  const canSend = Boolean(activeJobId) && !dispatched;

  const send = () => {
    if (!activeJobId || dispatched) return;
    const ok = sendCookbookRecommend({
      workflowId: activeJobId,
      researcher: runAs,
      taskProfile,
      maxRounds: clampedRounds,
      query,
      sim,
    });
    if (ok) setDispatched(true);
  };

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9600, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-bg-panel)',
          border: '1px solid var(--color-accent-primary-dim)',
          borderRadius: '6px',
          padding: '18px 22px',
          width: 'min(560px, 94vw)',
          fontFamily: 'var(--font-body)',
        }}
      >
        <div className="display-font" style={{ fontSize: '12px', letterSpacing: '3px', color: 'var(--color-accent-primary)', marginBottom: '6px' }}>
          RECOMMEND A MODEL
        </div>
        <div style={{ fontSize: '11px', color: 'var(--color-fg-muted)', lineHeight: 1.5, marginBottom: '12px' }}>
          Runs one bounded research turn: the agent reasons over your detected hardware and the fit-scored candidate set, then recommends a specific model + quant + context with a rationale and a ready-to-apply config. The report lands in the active tab's RESEARCH tab. The agent recommends only — nothing is downloaded or configured.
        </div>

        {!activeJobId && (
          <div className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: 'var(--color-warning)', marginBottom: '10px' }}>
            OPEN A WORKFLOW FIRST — the recommendation runs against an active tab.
          </div>
        )}

        <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)', marginBottom: '4px' }}>
          TASK PROFILE
        </div>
        <select
          data-help="cookbook.recommend.profile"
          value={taskProfile}
          onChange={(e) => setTaskProfile(e.target.value as CookbookTaskProfile)}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '6px 8px', marginBottom: '4px',
            background: 'var(--color-bg-sunken)', border: '1px solid var(--color-border-hairline)',
            borderRadius: '3px', color: 'var(--color-accent-primary)',
            fontFamily: 'var(--font-display)', fontSize: '11px',
          }}
        >
          {COOKBOOK_TASK_PROFILES.map((p) => (
            <option key={p} value={p}>{PROFILE_LABELS[p]}</option>
          ))}
        </select>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px' }}>
          <div className="display-font" style={{ fontSize: '10px', letterSpacing: '2px', color: 'var(--color-accent-primary-dim)' }}>
            ROUND CAP
          </div>
          <input
            data-help="cookbook.recommend.rounds"
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
            max {RESEARCH_MAX_ROUNDS_CEILING} confirm-the-facts web rounds (hard stop)
          </span>
        </div>

        <div data-help="cookbook.recommend.runas" style={{ margin: '14px 0 4px' }}>
          <RunAsPicker current={currentPrimary} selection={runAs} onChange={setRunAs} />
        </div>

        {dispatched && (
          <div className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: 'var(--color-accent-primary)', margin: '10px 0' }}>
            RECOMMENDATION RUNNING — watch the RESEARCH tab for progress and the report.
          </div>
        )}

        {/* G4 — apply the winner. The rec is free text, so downloading is an
            explicit per-row DOWNLOAD in the catalog table (DownloadActions), not
            an auto-apply here. This affordance just routes the operator back. */}
        <div style={{ display: 'flex', gap: '8px', marginTop: '14px', paddingTop: '12px', borderTop: '1px solid var(--color-border-hairline)' }}>
          <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: 'var(--color-fg-muted)', alignSelf: 'center', maxWidth: '360px', whiteSpace: 'normal' }}>
            APPLY THE WINNER: read the report, then DOWNLOAD the recommended row from the catalog table — each download is an explicit per-row click.
          </span>
          <Btn data-help="cookbook.recommend.browse" onClick={onClose}>BROWSE CANDIDATES</Btn>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
          <Btn onClick={onClose}>CLOSE</Btn>
          <Btn primary disabled={!canSend} onClick={send}>RECOMMEND</Btn>
        </div>
      </div>
    </div>
  );
}

function Btn({ onClick, children, primary, disabled, title, ...rest }: { onClick?: () => void; children: React.ReactNode; primary?: boolean; disabled?: boolean; title?: string; 'data-help'?: string }) {
  return (
    <button
      {...rest}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
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
