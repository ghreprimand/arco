import { useEffect, useState } from 'react';
import type { ClusterResearchSummary } from '@arco/shared';
import { useAppStore } from '../../stores/appStore';
import { DialogShell } from '../DialogShell';
import { touchButton } from './ResearchCloseDialog';
import { ENTRY_WORDS, elapsedLabel, roundSummaryLine, roundsAndCatchUps } from './researchView';
import { AuthReloginNotice } from '../AuthReloginNotice';

// docs/RESEARCH.md - the rounds strip above a research project's member
// cards: one row per round with each researcher's state, time, failures,
// and the project's Reveal control.
export function ResearchRoundsStrip({ clusterId, research, onOpenFolder }: { clusterId: string; research: ClusterResearchSummary; onOpenFolder: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  const [openRound, setOpenRound] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmReveal, setConfirmReveal] = useState(false);
  const [questionOpen, setQuestionOpen] = useState(false);
  const listed = roundsAndCatchUps(research);
  const collecting = listed.some((r) => !r.releasedAt);
  useEffect(() => {
    if (!collecting) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [collecting]);
  const letters = research.researchers.map((r) => r.letter);
  const rounds = all ? listed : listed.slice(-3);
  const blind = research.blind && !research.revealedAt;
  const reveal = async () => {
    setConfirmReveal(false);
    setBusy(true);
    try {
      const res = await fetch(`/api/research/${clusterId}/reveal`, { method: 'POST' });
      if (!res.ok) throw new Error();
    } catch { useAppStore.getState().pushNotification('error', 'Reveal failed. Try again.'); }
    finally { setBusy(false); }
  };
  return (
    <div data-help="research.rounds" style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '5px 8px', borderBottom: '1px solid var(--color-border-hairline)', fontSize: 11, color: 'var(--color-fg)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <span className="display-font" style={{ letterSpacing: 1, color: 'var(--color-accent-primary)' }}>RESEARCH</span>
        <span style={{ flex: '1 1 120px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-fg)' }}>{research.name}</span>
        <button type="button" data-help="research.brief" aria-expanded={questionOpen} onClick={() => setQuestionOpen(!questionOpen)} style={touchButton}>{questionOpen ? 'HIDE BRIEF' : 'BRIEF'}</button>
        <span>{blind ? 'Blind' : research.revealedAt ? 'Revealed' : 'Not blind'}</span>
        {blind && <button type="button" data-help="research.reveal" style={touchButton} disabled={busy} onClick={() => setConfirmReveal(true)}>REVEAL</button>}
      </div>
      {research.quick ? <div>Quick research is kept in Arco until you keep it as a project.</div> : <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <span style={{ overflowWrap: 'anywhere' }}>Saved in <code>{research.folder}</code></span>
        <button type="button" style={touchButton} onClick={onOpenFolder}>OPEN FOLDER</button>
        <span>Default location: Settings &gt; Projects &gt; Research folder.</span>
      </div>}
      {questionOpen && <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 240, overflowY: 'auto', border: '1px solid var(--color-border-hairline)', padding: 6 }}>{research.brief}</div>}
      {research.researchers.filter(r => r.signInNeeded).map(r => <div key={r.workflowId} data-help="research.signin"><AuthReloginNotice provider={r.signInNeeded!} workflowId={r.workflowId} {...(r.signInNeeded === 'claude' ? { authRecovery: { transport: 'cli' as const } } : {})} autoContinue body={`${r.signInNeeded === 'claude' ? 'Claude' : 'Codex'} sign-in needs renewing. Researcher ${r.letter} continues after sign-in.`} /></div>)}
      {research.preRoundContaminated && <div role="alert" style={{ color: 'var(--color-warning)' }}>INDEPENDENCE CHECK FAILED BEFORE THE FIRST ROUND</div>}
      {research.preRoundBoundaryWarning && <div role="alert" style={{ color: 'var(--color-warning)' }}>SANDBOX ACCESS WARNING BEFORE THE FIRST ROUND</div>}
      {research.rounds.length === 0 && <div>No round yet. The Research Director starts on the brief when the project opens; a Gemini Research Director starts when you press NUDGE.</div>}
      {rounds.map((round) => {
        const expanded = openRound === round.n;
        return (
          <div key={round.n}>
            <button type="button" data-help="research.round" aria-expanded={expanded} onClick={() => setOpenRound(expanded ? null : round.n)}
              style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', width: '100%', minHeight: 44, background: 'none', border: 'none', padding: 0, color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer' }}>
              <span className="display-font" style={{ letterSpacing: 1, color: 'var(--color-fg)' }}>{round.catchUp ? `CATCH-UP ${round.catchUp}` : `ROUND ${round.n}`}</span>
              {letters.filter((l) => round.entries[l]).map((l) => {
                const state = round.entries[l].state;
                const color = state === 'replied' ? 'var(--color-accent-primary)' : state === 'waiting' ? 'var(--color-fg)' : 'var(--color-warning)';
                return <span key={l} title={`Researcher ${l}: ${ENTRY_WORDS[state]}`} style={{ border: `1px solid ${color}`, color, padding: '0 4px', fontSize: 10 }}>{l} {ENTRY_WORDS[state]}</span>;
              })}
              <span>{roundSummaryLine(round)} · {elapsedLabel(round.startedAt, round.releasedAt, now)}</span>
              {round.contaminated && <span role="alert" style={{ color: 'var(--color-warning)' }}>INDEPENDENCE CHECK FAILED</span>}
              {round.boundaryWarning && <span role="alert" style={{ color: 'var(--color-warning)' }}>SANDBOX ACCESS WARNING</span>}
            </button>
            {expanded && <ul style={{ margin: '4px 0 2px 16px', padding: 0 }}>
              {letters.filter((l) => round.entries[l]).map((l) => {
                const e = round.entries[l];
                return <li key={l}>Researcher {l}: {ENTRY_WORDS[e.state]}{e.source === 'final_reply' ? ' (taken from final reply)' : ''}{e.reason ? `: ${e.reason}` : ''}{e.at ? ` at ${new Date(e.at).toLocaleTimeString()}` : ''}</li>;
              })}
              <li>Deadline {new Date(round.deadline).toLocaleTimeString()}{round.targeted ? ` · ${round.targeted} targeted message${round.targeted === 1 ? '' : 's'} recorded` : ''}</li>
            </ul>}
          </div>
        );
      })}
      {confirmReveal && <DialogShell title="Reveal authors" size="confirm" dataHelp="research.reveal" onClose={() => setConfirmReveal(false)}
        actions={<><button type="button" style={touchButton} onClick={() => setConfirmReveal(false)}>CANCEL</button><button type="button" style={touchButton} onClick={() => void reveal()}>REVEAL</button></>}>
        <p style={{ marginTop: 0 }}>Reveal which provider and model wrote each report?</p>
        <p>You see them on the cards already. Reveal also writes them into research.json and every round record, and shows them to the Research Director from now on. This cannot be undone.</p>
      </DialogShell>}
      {listed.length > 3 && <button type="button" onClick={() => setAll(!all)} style={{ ...touchButton, alignSelf: 'flex-start' }}>{all ? 'LATEST ROUNDS' : `ALL ${listed.length} ROUNDS`}</button>}
    </div>
  );
}
