import { useState } from 'react';
import type { CompareLegConfig } from '@arco/shared';

// Compare vote / synthesize footer — WORKBENCH_EXPANSION_PLAN.md §B1.
//
// Shown once a winner is voted. Displays the (now-revealed) winner and offers
// the OPTIONAL "synthesize from winner, graft from others" follow-up: the
// operator picks which leg's agent does the synthesis and dispatches one more
// bounded read-only leg. This is an operator-chosen action — never an automatic
// verdict, never an LLM judging the winner.

interface Props {
  legs: CompareLegConfig[];
  winnerLegIndex: number;
  blind: boolean;
  synthesizing: boolean;
  onSynthesize: (synthesizerLegIndex: number) => void;
}

function label(leg: CompareLegConfig, i: number, blind: boolean): string {
  // After a vote, identities are always revealed; blind only matters pre-vote.
  void blind;
  return `${String.fromCharCode(65 + i)} · ${leg.provider}/${leg.model}@${leg.effort}`;
}

export function CompareVote({ legs, winnerLegIndex, blind, synthesizing, onSynthesize }: Props) {
  const winner = legs[winnerLegIndex];
  const [synthLeg, setSynthLeg] = useState(winnerLegIndex);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 4px 2px', flexWrap: 'wrap' }}>
      <span className="display-font" style={{ fontSize: '11px', letterSpacing: '1px', color: 'var(--color-accent-primary)' }}>
        WINNER: {winner ? label(winner, winnerLegIndex, blind) : `LEG ${winnerLegIndex}`}
      </span>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span className="display-font" style={{ fontSize: '10px', letterSpacing: '1px', color: 'var(--color-fg-muted)' }}>
          SYNTHESIZE VIA
        </span>
        <select
          value={synthLeg}
          onChange={(e) => setSynthLeg(Number(e.target.value))}
          disabled={synthesizing}
          style={{ background: 'var(--color-bg-sunken)', border: '1px solid var(--color-border-hairline)', borderRadius: '3px', color: 'var(--color-fg)', fontSize: '11px', padding: '3px 6px' }}
        >
          {legs.map((leg, i) => (
            <option key={i} value={i}>{label(leg, i, blind)}</option>
          ))}
        </select>
        <button
          onClick={() => onSynthesize(synthLeg)}
          disabled={synthesizing}
          className="display-font"
          title="Run one more read-only leg that merges the best of every answer"
          style={{ padding: '5px 12px', background: synthesizing ? 'transparent' : 'var(--color-accent-secondary-a10, var(--color-accent-primary-a10))', border: '1px solid var(--color-accent-secondary-dim)', borderRadius: '3px', color: 'var(--color-accent-secondary)', cursor: synthesizing ? 'default' : 'pointer', opacity: synthesizing ? 0.5 : 1, fontSize: '10px', letterSpacing: '2px' }}
        >
          {synthesizing ? 'SYNTHESIZING…' : 'SYNTHESIZE'}
        </button>
      </div>
    </div>
  );
}
