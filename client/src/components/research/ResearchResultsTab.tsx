import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { ClusterResearchSummary } from '@arco/shared';
import { SendResearchDialog, type ResearchSelection } from './SendResearchDialog';
import { RerunResearchDialog } from './RerunResearchDialog';
import { ExportResearchDialog } from './ExportResearchDialog';
import { useAppStore } from '../../stores/appStore';
import { StartResearchProjectDialog } from './StartResearchProjectDialog';
import { FileViewerModal } from '../FileViewerModal';
import { touchButton } from './ResearchCloseDialog';
import { ENTRY_WORDS, roundsAndCatchUps } from './researchView';
import { ResearchFileLink, reportPath, researchPath, researcherLabel, roundFolder } from './researchLinks';

import './ResearchResultsTab.css';

type ResultAction = { label: string; run: () => void };

function ResultRow({ children, name, actions }: { children: ReactNode; name: string; actions?: ResultAction[] }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    trigger.current?.focus();
    setExpanded(false);
  };
  return <div className="research-result-row" onKeyDown={event => {
    if (event.key === 'Escape' && expanded) {
      event.stopPropagation();
      close();
    }
  }}>
    <div className="research-result-label">{children}</div>
    {actions && <>
      <button type="button" ref={trigger} className="research-action" aria-label={`Actions for ${name}`}
        aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>Actions</button>
      <div id={id} hidden={!expanded} role="group" aria-label={`Actions for ${name}`} className="research-result-choices">
        {expanded && actions.map(action => <button key={action.label} type="button" className="research-action"
          onClick={() => { close(); action.run(); }}>{action.label}</button>)}
      </div>
    </>}
  </div>;
}

// docs/RESEARCH.md - RESULTS in a research project's right panel: the brief,
// the summary, each released round's reports and the sources folder.
export function ResearchResultsTab({ clusterId, research }: { clusterId: string; research: ClusterResearchSummary }) {
  const [open, setOpen] = useState<string | null>(null);
  const [rerun, setRerun] = useState(false);
  const [exporting, setExporting] = useState<ResearchSelection | null>(null);
  const continueChat = (selection: ResearchSelection) => useAppStore.getState().openCreatorWith({ mode: 'chat', researchContinue: { clusterId, selection } });
  const [start, setStart] = useState<ResearchSelection | null>(null);
  const [send, setSend] = useState<ResearchSelection | null>(null);
  const [summaries, setSummaries] = useState<{ latest: boolean; rounds: number[]; proposal?: (ResearchSelection & { action?: 'send' | 'start' | 'chat' | 'export' | 'rerun' }) | null } | null>(null);
  const releasedKey = roundsAndCatchUps(research).map((r) => `${r.n}:${r.releasedAt ?? ''}`).join('|');
  useEffect(() => {
    let live = true;
    const load = () => fetch(`/api/research/${clusterId}/summaries`)
      .then(async (res) => (res.ok ? await res.json() as { latest: boolean; rounds: number[]; proposal?: (ResearchSelection & { action?: 'send' | 'start' | 'chat' | 'export' | 'rerun' }) | null } : null))
      .then((body) => { if (live && body) setSummaries(body); }).catch(() => undefined);
    void load();
    const timer = setInterval(load, 5_000);
    return () => { live = false; clearInterval(timer); };
  }, [clusterId, releasedKey]);
  const lastRound = research.rounds.at(-1)?.n;
  const lastReleased = research.rounds.filter(round => !!round.releasedAt).at(-1)?.n;
  const projectReady = research.rounds.length > 0 && research.rounds.every(round => !!round.releasedAt);
  const latestSummary: ResearchSelection | null = summaries?.latest && lastReleased ? { kind: 'synthesis', round: lastReleased } : null;
  const actionsFor = (selection: ResearchSelection): ResultAction[] => {
    const summary = selection.kind === 'synthesis';
    return [
      { label: summary ? 'Send summary' : 'Send report', run: () => setSend(selection) },
      { label: summary ? 'Start from summary' : 'Start from report', run: () => setStart(selection) },
      ...(summary ? [{ label: 'Continue in Chat', run: () => continueChat(selection) }] : []),
      { label: summary ? 'Export summary' : 'Export report', run: () => setExporting(selection) },
    ];
  };
  const roundSummary = (n: number): string | null => summaries?.rounds.includes(n) ? join('syntheses', `round-${n}.md`) : n === lastRound && summaries?.latest ? join('synthesis.md') : null;
  const join = (...parts: string[]) => researchPath(research, ...parts);
  const link = (label: string, path: string) => <ResearchFileLink label={label} path={path} onOpen={setOpen} />;
  return (
    <div className="research-results" data-help="research.results" style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12, color: 'var(--color-fg)' }}>
      {summaries?.proposal && <div role="status">The Research Director proposed {summaries.proposal.action === 'start' ? 'starting a project from' : summaries.proposal.action === 'chat' ? 'continuing in Chat with' : summaries.proposal.action === 'export' ? 'exporting' : summaries.proposal.action === 'rerun' ? 'rerunning' : 'sending'} {summaries.proposal.kind}. <button type="button" className="display-font" style={touchButton} onClick={() => {
        if (summaries.proposal!.action === 'start') setStart(summaries.proposal!); else if (summaries.proposal!.action === 'chat') continueChat(summaries.proposal!); else if (summaries.proposal!.action === 'export') setExporting(summaries.proposal!); else if (summaries.proposal!.action === 'rerun') setRerun(true); else setSend(summaries.proposal!);
        setSummaries({ ...summaries, proposal: null });
        void fetch(`/api/research/${clusterId}/dismiss-send-proposal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      }}>{summaries.proposal.action === 'start' ? 'REVIEW START' : summaries.proposal.action === 'chat' ? 'REVIEW CHAT' : summaries.proposal.action === 'export' ? 'REVIEW EXPORT' : summaries.proposal.action === 'rerun' ? 'REVIEW RERUN' : 'REVIEW SEND'}</button></div>}
      <div role="group" aria-label="Research files" className="research-file-links">
        {link('Brief', join('brief.md'))}
        {summaries?.latest ? link('Summary', join('synthesis.md')) : <span>Awaiting summary</span>}
        {link('Director log', join('director-log.md'))}
        {link('Exports', join('exports.md'))}
      </div>
      {research.rounds.length > 0 ? <div role="group" aria-label="Project actions" className="research-project-actions">
        {projectReady && <button type="button" className="research-action" onClick={() => setSend({ kind: 'project' })}>Send project</button>}
        {(latestSummary || projectReady) && <button type="button" className="research-action" onClick={() => setStart(latestSummary ?? { kind: 'project' })}>Start project</button>}
        {latestSummary && <button type="button" className="research-action" aria-label="Continue in Chat" title="Continue in Chat" onClick={() => continueChat(latestSummary)}>Chat</button>}
        {projectReady && <button type="button" className="research-action" onClick={() => setExporting({ kind: 'project' })}>Export</button>}
        <button type="button" className="research-action" onClick={() => setRerun(true)}>Rerun</button>
      </div> : <div>No round yet. Released reports and project actions will appear here.</div>}
      {roundsAndCatchUps(research).reverse().map((round) => {
        // A catch-up is the round 1 text answered by one late researcher.
        const dir = roundFolder(round);
        return (
        <div key={round.catchUp ? `catch-up-${round.catchUp}` : `round-${round.n}`}>
          <ResultRow name={`round ${round.n} summary`} actions={
            !round.catchUp && round.releasedAt && roundSummary(round.n)
              ? actionsFor({ kind: 'synthesis', round: round.n }) : undefined
          }>
            <strong>{round.catchUp ? `Catch-up ${round.catchUp}` : `Round ${round.n}`}</strong>
            {link('Round record', join('rounds', dir, 'round.md'))}
            {!round.catchUp && roundSummary(round.n) && link('Summary', roundSummary(round.n)!)}
          </ResultRow>
          {round.contaminated && <div role="alert" style={{ color: 'var(--color-warning)' }}>Independence check failed: this round contains another researcher's marker. Treat its reports as contaminated.</div>}
          {round.boundaryWarning && <div role="alert" style={{ color: 'var(--color-warning)' }}>A researcher attempted to use a path or local address outside its sandbox. Check its activity.</div>}
          {!round.releasedAt && <div style={{ color: 'var(--color-fg)' }}>Still collecting replies; reports appear here when the round is released.</div>}
          {round.releasedAt && <ul style={{ margin: 0, paddingLeft: 16 }}>
            {[...research.researchers].sort((x, y) => x.letter.localeCompare(y.letter)).filter((r) => round.entries[r.letter]).map((r) => {
              const e = round.entries[r.letter];
              const who = researcherLabel(research, r.letter);
              const selection: ResearchSelection = round.catchUp ? { kind: 'report', catchUp: round.catchUp } : { kind: 'report', round: round.n, letter: r.letter };
              return <li key={r.letter}>{e.state === 'replied' ? <>
                <ResultRow name={`${who} report, ${round.catchUp ? 'catch-up' : 'round ' + round.n}`} actions={actionsFor(selection)}>
                  {link(`${who} report`, reportPath(research, round, r.letter))}{e.late && <span>(late)</span>}
                </ResultRow>
                {e.sources?.length ? <ul aria-label={`${who} returned files`} style={{ margin: 0, paddingLeft: 16 }}>{e.sources.map((s) => <li key={s.path}>{link(s.name, join(s.path))}</li>)}</ul> : null}</> : `${who}: ${ENTRY_WORDS[e.state]}`}</li>;
            })}
          </ul>}
        </div>
        );
      })}
      <div style={{ color: 'var(--color-fg)' }}>Returned files are listed under each report and kept in <code>sources/</code>.</div>
      {rerun && <RerunResearchDialog clusterId={clusterId} onClose={() => setRerun(false)} />}
      {exporting && <ExportResearchDialog clusterId={clusterId} selection={exporting} onClose={() => setExporting(null)} />}
      {start && <StartResearchProjectDialog clusterId={clusterId} selection={start} onClose={() => setStart(null)} />}
      {send && <SendResearchDialog clusterId={clusterId} selection={send} defaultDestination={research.sourceProject} onClose={() => setSend(null)} />}
      {open && <FileViewerModal path={open} onClose={() => setOpen(null)} fallback={{ cwd: research.folder, workflowId: research.directorWorkflowId }} />}
    </div>
  );
}
