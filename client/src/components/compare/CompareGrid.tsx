import type { CompareLegConfig } from '@arco/shared';
import type { ComparePane } from '../../stores/compareStore';

// Compare grid — WORKBENCH_EXPANSION_PLAN.md §B1.
//
// Side-by-side answer panes. Clones MemberPane's pane structure (status-dot +
// label header, flexed body) rather than building a fresh grid. One pane per
// leg; the optional synthesis pane lands after the originals at index ==
// legs.length and is labeled "SYNTHESIS".
//
// Blind: until the operator votes (winnerLegIndex >= 0), the leg identities are
// masked to "Leg A / Leg B / …" so the choice isn't anchored on the brand.

interface Props {
  legs: CompareLegConfig[];
  panes: ComparePane[];
  blind: boolean;
  revealed: boolean;       // becomes true once a vote is cast
  winnerLegIndex: number;  // -1 until voted
  onVote: (legIndex: number) => void;
  canVote: boolean;        // race done + not yet voted
}

function legLabel(leg: CompareLegConfig | undefined, index: number, legCount: number, blind: boolean, revealed: boolean): string {
  if (index >= legCount) return 'SYNTHESIS';
  if (blind && !revealed) return `LEG ${String.fromCharCode(65 + index)}`;
  if (!leg) return `LEG ${String.fromCharCode(65 + index)}`;
  return `${leg.provider.toUpperCase()} · ${leg.model} @ ${leg.effort}`;
}

export function CompareGrid({ legs, panes, blind, revealed, winnerLegIndex, onVote, canVote }: Props) {
  return (
    <div style={{ display: 'flex', gap: '10px', flex: 1, minHeight: 0, overflowX: 'auto' }}>
      {panes.map((pane, i) => {
        const isSynth = i >= legs.length;
        const isWinner = winnerLegIndex === i;
        const running = !pane.done;
        return (
          <div
            key={i}
            style={{
              flex: '1 1 0', minWidth: '300px', display: 'flex', flexDirection: 'column',
              border: isWinner ? '1px solid var(--color-accent-primary)' : '1px solid var(--color-border-hairline)',
              background: 'var(--color-bg)', borderRadius: '4px', overflow: 'hidden',
            }}
          >
            <div
              className="display-font"
              style={{
                padding: '8px 12px', borderBottom: '1px solid var(--color-border-hairline)',
                display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', letterSpacing: '1px',
                background: isWinner ? 'var(--color-accent-primary-a06)' : 'transparent',
              }}
            >
              {running && (
                <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--color-accent-primary)', animation: 'pulse-glow 1.5s ease-in-out infinite' }} />
              )}
              <span style={{ color: isWinner ? 'var(--color-accent-primary)' : isSynth ? 'var(--color-accent-secondary)' : 'var(--color-fg)', fontWeight: isWinner ? 600 : 400 }}>
                {legLabel(legs[i], i, legs.length, blind, revealed)}
              </span>
              <span style={{ marginLeft: 'auto', color: pane.error ? 'var(--color-warning)' : 'var(--color-fg-muted)', fontSize: '10px' }}>
                {pane.error ? 'ERROR' : running ? 'RUNNING' : `${pane.durationMs != null ? `${Math.round(pane.durationMs / 100) / 10}s` : 'DONE'}`}
              </span>
            </div>

            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 12px', fontFamily: 'var(--font-body)', fontSize: '12px', lineHeight: 1.5, color: pane.error ? 'var(--color-warning)' : 'var(--color-fg)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {pane.error ? pane.error : (pane.text || (running ? '…' : '(no output)'))}
            </div>

            {/* Vote affordance — only the original legs are votable, only once
                the race is done, and only before a vote is cast. Operator-only;
                nothing auto-selects. */}
            {!isSynth && canVote && (
              <button
                onClick={() => onVote(i)}
                className="display-font"
                style={{ padding: '7px', border: 'none', borderTop: '1px solid var(--color-border-hairline)', background: 'var(--color-accent-primary-a06)', color: 'var(--color-accent-primary)', cursor: 'pointer', fontSize: '10px', letterSpacing: '2px' }}
              >
                PICK THIS WINNER
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
