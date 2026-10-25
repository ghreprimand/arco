import { useEffect, useMemo, useState } from 'react';
import type {
  BakeoffAttempt,
  BakeoffAttemptSpec,
  BakeoffState,
  EffortLevel,
  ModelName,
  ProviderName,
} from '@arco/shared';
import type { JobState } from '../../stores/appStore';
import { useAppStore } from '../../stores/appStore';
import { RunAsPicker, type RunAsSelection } from '../RunAsPicker';
import { DiffView } from '../diff/DiffView';
import { EmptyState } from './FilesTab';

interface Props {
  job: JobState;
  onList?: (workflowId: string) => void;
  onStart?: (workflowId: string, prompt: string, attempts: BakeoffAttemptSpec[], name?: string) => void;
  onPromote?: (workflowId: string, bakeoffId: string, attemptId: string) => void;
  onCleanup?: (workflowId: string, bakeoffId: string, attemptIds: string[]) => void;
}

interface SelectedDiff {
  bakeoffId: string;
  attemptId: string;
  patch: string;
  loading: boolean;
  error?: string;
}

const ATTEMPT_COUNTS = [2, 3, 4, 5] as const;

function primarySelection(job: JobState): RunAsSelection {
  return {
    provider: (job.config.primaryProvider ?? 'claude') as ProviderName,
    model: job.config.primaryModel as ModelName,
    effort: job.config.primaryEffort as EffortLevel,
    providerAccountRef: job.config.providerAccountRef,
  };
}

function statusColor(status: BakeoffAttempt['status']): string {
  if (status === 'done') return 'var(--color-accent-primary)';
  if (status === 'running' || status === 'creating') return 'var(--color-accent-secondary)';
  if (status === 'failed') return 'var(--color-warning)';
  return 'var(--color-fg-muted)';
}

function shortRef(ref: string): string {
  return ref.slice(0, 8);
}

export function BakeoffTab({ job, onList, onStart, onPromote, onCleanup }: Props) {
  const bakeoffs = useAppStore((state) => state.bakeoffsByWorkflow[job.id] ?? []);
  const setActiveJob = useAppStore((state) => state.setActiveJob);
  const current = useMemo(() => primarySelection(job), [job]);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [attempts, setAttempts] = useState<RunAsSelection[]>([current, current]);
  const [selectedDiff, setSelectedDiff] = useState<SelectedDiff | null>(null);

  useEffect(() => {
    onList?.(job.id);
  }, [job.id, onList]);

  const resizeAttempts = (count: number) => {
    setAttempts((prior) => {
      if (prior.length >= count) return prior.slice(0, count);
      return [...prior, ...Array.from({ length: count - prior.length }, () => ({ ...current }))];
    });
  };

  const start = () => {
    if (!prompt.trim() || job.busy || !onStart) return;
    onStart(
      job.id,
      prompt.trim(),
      attempts.map((attempt) => ({ ...attempt })),
      name.trim() || undefined,
    );
    setName('');
    setPrompt('');
  };

  const loadDiff = async (bakeoff: BakeoffState, attempt: BakeoffAttempt) => {
    setSelectedDiff({
      bakeoffId: bakeoff.id,
      attemptId: attempt.id,
      patch: '',
      loading: true,
    });
    try {
      const query = new URLSearchParams({
        wfid: job.id,
        bakeoffId: bakeoff.id,
        attemptId: attempt.id,
      });
      const response = await fetch(`/api/git/bakeoffs/diff?${query.toString()}`);
      const body = await response.json() as { patch?: string; error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setSelectedDiff({
        bakeoffId: bakeoff.id,
        attemptId: attempt.id,
        patch: body.patch ?? '',
        loading: false,
      });
    } catch (err) {
      setSelectedDiff({
        bakeoffId: bakeoff.id,
        attemptId: attempt.id,
        patch: '',
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const promote = (bakeoff: BakeoffState, attempt: BakeoffAttempt) => {
    if (!onPromote) return;
    const ok = window.confirm(
      `Promote ${attempt.label}?\n\nArco will commit its project changes and merge ${attempt.branch} into the original checkout. The original checkout must still be clean and at ${shortRef(bakeoff.baseRef)}.`,
    );
    if (ok) onPromote(job.id, bakeoff.id, attempt.id);
  };

  const cleanup = (bakeoff: BakeoffState, includeWinner: boolean) => {
    if (!onCleanup) return;
    const ids = bakeoff.attempts
      .filter((attempt) =>
        attempt.status !== 'cleaned'
        && (includeWinner || attempt.id !== bakeoff.winnerAttemptId))
      .map((attempt) => attempt.id);
    if (ids.length === 0) return;
    const ok = window.confirm(
      `Remove ${ids.length} ${includeWinner ? 'selected' : 'losing'} worktree${ids.length === 1 ? '' : 's'} and close their workflow tabs?\n\nTheir git branches will be preserved.`,
    );
    if (ok) onCleanup(job.id, bakeoff.id, ids);
  };

  return (
    <div style={{ padding: '10px', overflowY: 'auto', minHeight: 0 }}>
      <section style={panelStyle}>
        <div className="display-font" style={titleStyle}>NEW WORKTREE BAKE-OFF</div>
        <div style={copyStyle}>
          Run the same task in isolated branches, compare the resulting diffs, then choose the winner yourself.
          The source checkout must be clean.
        </div>

        <FieldLabel>NAME (OPTIONAL)</FieldLabel>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. activity-stream fix"
          style={inputStyle}
        />

        <FieldLabel>TASK PROMPT</FieldLabel>
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe the implementation and acceptance criteria each attempt should satisfy…"
          rows={5}
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'var(--font-body)' }}
        />

        <FieldLabel>ATTEMPTS</FieldLabel>
        <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
          {ATTEMPT_COUNTS.map((count) => (
            <button
              key={count}
              type="button"
              onClick={() => resizeAttempts(count)}
              style={pillStyle(attempts.length === count)}
            >
              {count}
            </button>
          ))}
        </div>

        {attempts.map((selection, index) => (
          <div key={index} style={attemptStyle}>
            <div className="display-font" style={{ ...titleStyle, fontSize: '9px', marginBottom: '5px' }}>
              ATTEMPT {index + 1}
            </div>
            <RunAsPicker
              current={current}
              selection={selection}
              hint="Runs as a new workflow tab in this attempt’s isolated worktree."
              onChange={(next) => setAttempts((prior) =>
                prior.map((item, itemIndex) => itemIndex === index ? next : item))}
            />
          </div>
        ))}

        {job.busy && (
          <div style={{ ...copyStyle, color: 'var(--color-warning)', marginTop: '8px' }}>
            Wait for this source tab’s current turn to finish.
          </div>
        )}
        <button
          type="button"
          onClick={start}
          disabled={!prompt.trim() || job.busy || !onStart}
          style={primaryButtonStyle(!prompt.trim() || job.busy || !onStart)}
        >
          START BAKE-OFF
        </button>
      </section>

      {bakeoffs.length === 0 ? (
        <EmptyState text="NO BAKE-OFFS YET" />
      ) : (
        bakeoffs.map((bakeoff) => (
          <BakeoffCard
            key={bakeoff.id}
            bakeoff={bakeoff}
            selectedDiff={selectedDiff}
            onOpen={(attempt) => attempt.workflowId && setActiveJob(attempt.workflowId)}
            onDiff={(attempt) => void loadDiff(bakeoff, attempt)}
            onPromote={(attempt) => promote(bakeoff, attempt)}
            onCleanupLosers={() => cleanup(bakeoff, false)}
            onCleanupAll={() => cleanup(bakeoff, true)}
          />
        ))
      )}
    </div>
  );
}

function BakeoffCard({
  bakeoff,
  selectedDiff,
  onOpen,
  onDiff,
  onPromote,
  onCleanupLosers,
  onCleanupAll,
}: {
  bakeoff: BakeoffState;
  selectedDiff: SelectedDiff | null;
  onOpen: (attempt: BakeoffAttempt) => void;
  onDiff: (attempt: BakeoffAttempt) => void;
  onPromote: (attempt: BakeoffAttempt) => void;
  onCleanupLosers: () => void;
  onCleanupAll: () => void;
}) {
  const activeCount = bakeoff.attempts.filter((attempt) => attempt.status !== 'cleaned').length;
  const loserCount = bakeoff.attempts.filter((attempt) =>
    attempt.status !== 'cleaned' && attempt.id !== bakeoff.winnerAttemptId).length;
  return (
    <section style={{ ...panelStyle, marginTop: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }}>
        <div className="display-font" style={{ ...titleStyle, marginBottom: 0 }}>{bakeoff.name}</div>
        <span style={{ ...copyStyle, color: statusColor(
          bakeoff.status === 'running' || bakeoff.status === 'creating' ? 'running' : 'done',
        ) }}>
          {bakeoff.status.toUpperCase()}
        </span>
      </div>
      <div style={{ ...copyStyle, marginTop: '5px' }}>
        Base {bakeoff.baseBranch ?? '(detached)'} @ {shortRef(bakeoff.baseRef)}
        {bakeoff.mergeCommit ? ` · merged ${shortRef(bakeoff.mergeCommit)}` : ''}
      </div>
      <details style={{ marginTop: '6px' }}>
        <summary className="display-font" style={summaryStyle}>ORIGINAL PROMPT</summary>
        <pre style={promptStyle}>{bakeoff.prompt}</pre>
      </details>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
        {bakeoff.attempts.map((attempt) => {
          const chosen = bakeoff.winnerAttemptId === attempt.id;
          const diffOpen = selectedDiff?.bakeoffId === bakeoff.id && selectedDiff.attemptId === attempt.id;
          const canPromote = !bakeoff.winnerAttemptId
            && attempt.status !== 'running'
            && attempt.status !== 'creating'
            && attempt.status !== 'cleaned';
          return (
            <div key={attempt.id} style={{
              border: `1px solid ${chosen ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)'}`,
              background: chosen ? 'var(--color-accent-primary-a08)' : 'var(--color-bg-sunken)',
              borderRadius: '4px',
              padding: '7px',
            }}>
              <div style={{ display: 'flex', gap: '7px', alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="display-font" style={{ fontSize: '9px', letterSpacing: '1px', color: 'var(--color-accent-primary)' }}>
                  {attempt.label.toUpperCase()}
                </span>
                <span style={{ fontSize: '10px', color: 'var(--color-fg-secondary)' }}>
                  {attempt.provider} · {attempt.model} · {attempt.effort}
                </span>
                <span className="display-font" style={{ marginLeft: 'auto', fontSize: '9px', color: statusColor(attempt.status) }}>
                  {chosen ? 'WINNER' : attempt.status.toUpperCase()}
                </span>
              </div>
              <div style={{ ...copyStyle, marginTop: '3px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {attempt.branch}
              </div>
              {attempt.error && <div style={{ ...copyStyle, color: 'var(--color-warning)', marginTop: '4px' }}>{attempt.error}</div>}
              <div style={{ display: 'flex', gap: '5px', marginTop: '6px', flexWrap: 'wrap' }}>
                {attempt.workflowId && attempt.status !== 'cleaned' && (
                  <SmallButton onClick={() => onOpen(attempt)}>OPEN TAB</SmallButton>
                )}
                {attempt.status !== 'cleaned' && (
                  <SmallButton onClick={() => onDiff(attempt)}>
                    {diffOpen ? 'REFRESH DIFF' : 'VIEW DIFF'}
                  </SmallButton>
                )}
                {canPromote && <SmallButton primary onClick={() => onPromote(attempt)}>PROMOTE</SmallButton>}
              </div>
              {diffOpen && (
                <div style={{ marginTop: '7px', borderTop: '1px solid var(--color-border-hairline)', paddingTop: '7px' }}>
                  {selectedDiff.loading ? (
                    <div style={copyStyle}>Loading candidate diff…</div>
                  ) : selectedDiff.error ? (
                    <div style={{ ...copyStyle, color: 'var(--color-warning)' }}>{selectedDiff.error}</div>
                  ) : (
                    <DiffView patch={selectedDiff.patch} emptyText="This attempt has no project changes." />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: '5px', marginTop: '8px', flexWrap: 'wrap' }}>
        {bakeoff.winnerAttemptId && loserCount > 0 && (
          <button type="button" onClick={onCleanupLosers} style={secondaryButtonStyle}>
            REMOVE LOSING WORKTREES
          </button>
        )}
        {activeCount > 0 && (
          <button type="button" onClick={onCleanupAll} style={secondaryButtonStyle}>
            REMOVE ALL WORKTREES
          </button>
        )}
      </div>
    </section>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className="display-font" style={{ ...titleStyle, fontSize: '9px', marginTop: '9px', marginBottom: '4px' }}>{children}</div>;
}

function SmallButton({ children, onClick, primary }: { children: React.ReactNode; onClick: () => void; primary?: boolean }) {
  return (
    <button type="button" onClick={onClick} style={primary ? smallPrimaryStyle : smallButtonStyle}>
      {children}
    </button>
  );
}

const panelStyle: React.CSSProperties = {
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '4px',
  background: 'var(--color-bg-panel)',
  padding: '9px',
};

const titleStyle: React.CSSProperties = {
  color: 'var(--color-accent-primary)',
  fontSize: '10px',
  letterSpacing: '1.6px',
  marginBottom: '5px',
};

const copyStyle: React.CSSProperties = {
  color: 'var(--color-fg-muted)',
  fontSize: '10px',
  lineHeight: 1.45,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '6px 7px',
  color: 'var(--color-accent-primary)',
  background: 'var(--color-bg-sunken)',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  fontSize: '10px',
  fontFamily: 'var(--font-display)',
};

const attemptStyle: React.CSSProperties = {
  borderTop: '1px solid var(--color-border-hairline)',
  marginTop: '8px',
  paddingTop: '8px',
};

const primaryButtonStyle = (disabled: boolean): React.CSSProperties => ({
  width: '100%',
  marginTop: '10px',
  padding: '7px',
  color: 'var(--color-accent-primary)',
  background: 'var(--color-accent-primary-a10)',
  border: '1px solid var(--color-accent-primary)',
  borderRadius: '3px',
  fontFamily: 'var(--font-display)',
  fontSize: '10px',
  letterSpacing: '1.5px',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.4 : 1,
});

const secondaryButtonStyle: React.CSSProperties = {
  padding: '5px 8px',
  color: 'var(--color-fg-muted)',
  background: 'transparent',
  border: '1px solid var(--color-border-hairline)',
  borderRadius: '3px',
  fontFamily: 'var(--font-display)',
  fontSize: '9px',
  letterSpacing: '1px',
  cursor: 'pointer',
};

const smallButtonStyle: React.CSSProperties = { ...secondaryButtonStyle, padding: '3px 6px', fontSize: '8px' };
const smallPrimaryStyle: React.CSSProperties = {
  ...smallButtonStyle,
  color: 'var(--color-accent-primary)',
  borderColor: 'var(--color-accent-primary)',
  background: 'var(--color-accent-primary-a08)',
};

const pillStyle = (active: boolean): React.CSSProperties => ({
  ...smallButtonStyle,
  minWidth: '28px',
  color: active ? 'var(--color-accent-primary)' : 'var(--color-fg-muted)',
  borderColor: active ? 'var(--color-accent-primary)' : 'var(--color-border-hairline)',
  background: active ? 'var(--color-accent-primary-a08)' : 'transparent',
});

const summaryStyle: React.CSSProperties = {
  cursor: 'pointer',
  color: 'var(--color-fg-muted)',
  fontSize: '8px',
  letterSpacing: '1px',
};

const promptStyle: React.CSSProperties = {
  margin: '5px 0 0',
  padding: '6px',
  whiteSpace: 'pre-wrap',
  color: 'var(--color-fg-secondary)',
  background: 'var(--color-bg-sunken)',
  borderRadius: '3px',
  fontFamily: 'var(--font-code)',
  fontSize: '9px',
  lineHeight: 1.4,
};
