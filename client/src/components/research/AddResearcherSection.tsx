import { useEffect, useState } from 'react';
import { RESEARCH_MAX_RESEARCHERS, type ClusterResearchSummary } from '@arco/shared';
import { researchMember } from '../WorkflowCreator/ResearchStartForm';
import { ResearcherRowFields, rowButton as small, rowHint as hint, useResearcherAvailability, type ResearcherRowValue as Row } from './researcherRow';

export type ResearcherAddRequest = { researcher: ReturnType<typeof researchMember>; catchUp: boolean };

// docs/RESEARCH.md - ADD RESEARCHER in a running research project: one row
// as in the start dialog, plus whether it answers the round 1 text now.
export function AddResearcherSection({ research, onAdd }: { research: ClusterResearchSummary; onAdd: (request: ResearcherAddRequest) => void }) {
  const [open, setOpen] = useState(false);
  const avail = useResearcherAvailability(open);
  const [row, setRow] = useState<Row>(() => avail.rowFor('claude'));
  const [catchUp, setCatchUp] = useState(true);
  // Start on the first usable provider once the availability checks are in.
  const [picked, setPicked] = useState(false);
  useEffect(() => {
    if (!open || picked || avail.usable(row.provider)) return;
    const first = avail.firstUsable();
    if (first) setRow(first);
  }, [open, picked, avail.checked, avail.authStatus]);
  const used = research.researchers.length;
  const full = used >= RESEARCH_MAX_RESEARCHERS;
  const nextLetter = String.fromCharCode(65 + used);
  const started = research.rounds.length > 0;
  const rowUsable = avail.rowUsable(row);

  if (!open) return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <button type="button" className="display-font" data-help="research.add-researcher" style={{ ...small, alignSelf: 'flex-start', opacity: full ? 0.5 : 1 }} disabled={full} onClick={() => { setPicked(false); setRow(avail.rowFor('claude')); setOpen(true); }}>+ ADD RESEARCHER</button>
      {full && <span style={hint}>{RESEARCH_MAX_RESEARCHERS} researchers is the most a project can have.</span>}
    </div>
  );
  return (
    <div data-help="research.add-researcher" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, border: '1px solid var(--color-border-hairline)' }}>
      <span className="display-font" style={{ fontSize: 10, letterSpacing: 1, color: 'var(--color-fg-muted)' }}>RESEARCHER {nextLetter}</span>
      <ResearcherRowFields row={row} avail={avail} onChange={(next) => { if (next.provider !== row.provider || next.researchClaudeTransport !== row.researchClaudeTransport) setPicked(true); setRow(next); }} />
      {started
        ? <label style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 44 }}><input style={{ width: 22, height: 22 }} type="checkbox" checked={catchUp} onChange={(e) => setCatchUp(e.target.checked)} /> Give it the original brief now</label>
        : <span style={hint}>It joins round 1.</span>}
      <span style={hint}>{started ? 'It is left out of a round in progress and joins from the next one. The original brief is the round 1 text; the report is released to the Research Director alone.' : ''}</span>
      {!rowUsable && <span role="status" style={{ ...hint, color: 'var(--color-warning)' }}>{avail.unavailableReason(row) ?? 'This researcher is unavailable. Check the sign-in and sandbox.'}</span>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" className="display-font" style={{ ...small, opacity: rowUsable && row.model ? 1 : 0.5 }} disabled={!rowUsable || !row.model}
          onClick={() => { onAdd({ researcher: researchMember(row), catchUp: started && catchUp }); setOpen(false); }}>ADD</button>
        <button type="button" className="display-font" style={small} onClick={() => setOpen(false)}>CANCEL</button>
      </div>
    </div>
  );
}
