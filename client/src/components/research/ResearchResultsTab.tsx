import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { ClusterResearchSummary } from '@arco/shared';
import { SendResearchDialog, type ResearchSelection } from './SendResearchDialog';
import { RerunResearchDialog } from './RerunResearchDialog';
import { ExportResearchDialog } from './ExportResearchDialog';
import { useAppStore } from '../../stores/appStore';
import { StartResearchProjectDialog } from './StartResearchProjectDialog';
import { FileViewerModal } from '../FileViewerModal';
import { touchButton } from './ResearchCloseDialog';
import { ENTRY_WORDS, roundsAndCatchUps } from './researchView';
import { reportPath, researchPath, researcherLabel, roundFolder } from './researchLinks';
import { memberColour } from '../ClusterActivityTab';
import { formatActivityTime } from '../activityTime';

import './ResearchResultsTab.css';

type ResultAction = { label: string; run: () => void };

// A control drawn as a small boxed chip, as in the cluster ACTIVITY pane. The
// button is the 44 px touch target; the chip inside it is what is drawn, so
// rows stay compact without shrinking what a finger can hit.
function Chip({ label, name, tone = 'link', onClick, ...rest }: {
  label: ReactNode; name?: string; tone?: 'link' | 'file' | 'action'; onClick: () => void;
} & Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-expanded' | 'aria-controls' | 'title'>) {
  return <button type="button" className="research-hit" aria-label={name} onClick={onClick} {...rest}>
    <span className={`research-chip research-chip-${tone}`}>{label}</span>
  </button>;
}

// One line of a card: its links on the left, an Actions button on the right,
// and whatever those open (a returned-files list, then the action choices)
// inline underneath. What a control opens follows it in keyboard order.
function ResultRow({ children, name, actions, below, accent }: { children: ReactNode; name: string; actions?: ResultAction[]; below?: ReactNode; accent?: string }) {
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
    {below}
    {actions && <>
      <button type="button" ref={trigger} className="research-hit research-row-actions" aria-label={`Actions for ${name}`}
        aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)}>
        <span className="research-chip research-chip-action">Actions<span aria-hidden="true" className="research-caret" /></span>
      </button>
      <div id={id} hidden={!expanded} role="group" aria-label={`Actions for ${name}`} className="research-row-below" style={{ borderInlineStartColor: accent }}>
        {expanded && actions.map(action => <Chip key={action.label} tone="action" label={action.label}
          onClick={() => { close(); action.run(); }} />)}
      </div>
    </>}
  </div>;
}

// A researcher's line in a round card: the name in its ACTIVITY colour, the
// report, the files it returned and the report's actions.
function ReportRow({ who, where, colour, late, files, actions, onOpenReport, onOpenFile }: {
  who: string; where: string; colour: string; late?: boolean; files: Array<{ name: string; path: string }>;
  actions: ResultAction[]; onOpenReport: () => void; onOpenFile: (path: string) => void;
}) {
  const [showFiles, setShowFiles] = useState(false);
  const id = useId();
  const [name, authors] = splitWho(who);
  return <ResultRow name={`${who} report, ${where}`} actions={actions} accent={colour} below={files.length > 0 &&
    <ul id={id} hidden={!showFiles} aria-label={`${who} returned files`} role="list" className="research-row-below" style={{ borderInlineStartColor: colour }}>
      {showFiles && files.map(file => <li key={file.path}><Chip tone="file" label={file.name} onClick={() => onOpenFile(file.path)} /></li>)}
    </ul>}>
    <Who name={name} authors={authors} colour={colour} />
    <Chip label="Report" name={`${who} report`} onClick={onOpenReport} />
    {files.length > 0 && <Chip name={`Files (${files.length}) for ${who}, ${where}`} aria-expanded={showFiles} aria-controls={id}
      label={<>Files ({files.length})<span aria-hidden="true" className="research-caret" /></>} onClick={() => setShowFiles(!showFiles)} />}
    {late && <span className="research-tag">Late</span>}
  </ResultRow>;
}

// "Researcher A (provider, model)" as the name and, once revealed, the authors.
function splitWho(who: string): [string, string] {
  const at = who.indexOf(' (');
  return at < 0 ? [who, ''] : [who.slice(0, at), who.slice(at + 1)];
}

function Who({ name, authors, colour }: { name: string; authors: string; colour: string }) {
  return <span className="research-who">
    <span className="research-who-name display-font" style={{ color: `color-mix(in oklab, ${colour} 62%, var(--color-fg))` }}>{name.startsWith('Researcher ') ? <><span className="research-who-word">Researcher </span>{name.slice(11)}</> : name}</span>
    {authors && <span className="research-who-authors">{authors}</span>}
  </span>;
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
  const link = (label: string, path: string, name?: string) => <Chip label={label} name={name} onClick={() => setOpen(path)} />;
  const proposal = summaries?.proposal;
  const proposalAction = proposal?.action ?? 'send';
  return (
    <div className="research-results" data-help="research.results">
      {proposal && <div role="status" className="research-card research-card-note research-proposal">
        <span>The Research Director proposed {proposalAction === 'start' ? 'starting a project from' : proposalAction === 'chat' ? 'continuing in Chat with' : proposalAction === 'export' ? 'exporting' : proposalAction === 'rerun' ? 'rerunning' : 'sending'} {proposal.kind}.</span>
        <button type="button" className="display-font" style={touchButton} onClick={() => {
          if (proposalAction === 'start') setStart(proposal); else if (proposalAction === 'chat') continueChat(proposal); else if (proposalAction === 'export') setExporting(proposal); else if (proposalAction === 'rerun') setRerun(true); else setSend(proposal);
          setSummaries({ ...summaries, proposal: null });
          void fetch(`/api/research/${clusterId}/dismiss-send-proposal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        }}>{proposalAction === 'start' ? 'REVIEW START' : proposalAction === 'chat' ? 'REVIEW CHAT' : proposalAction === 'export' ? 'REVIEW EXPORT' : proposalAction === 'rerun' ? 'REVIEW RERUN' : 'REVIEW SEND'}</button>
      </div>}
      <section className="research-card" aria-label="Project">
        <div className="research-result-label">
          <h3 className="research-card-title display-font">Project</h3>
          <div role="group" aria-label="Research files" className="research-file-links">
            {link('Brief', join('brief.md'))}
            {summaries?.latest ? link('Summary', join('synthesis.md')) : <span className="research-tag">Awaiting summary</span>}
            {link('Director log', join('director-log.md'))}
            {link('Exports', join('exports.md'))}
          </div>
        </div>
        {research.rounds.length > 0 ? <div role="group" aria-label="Project actions" className="research-project-actions">
          {projectReady && <Chip tone="action" label="Send project" onClick={() => setSend({ kind: 'project' })} />}
          {(latestSummary || projectReady) && <Chip tone="action" label="Start project" onClick={() => setStart(latestSummary ?? { kind: 'project' })} />}
          {latestSummary && <Chip tone="action" label="Chat" name="Continue in Chat" title="Continue in Chat" onClick={() => continueChat(latestSummary)} />}
          {projectReady && <Chip tone="action" label="Export" onClick={() => setExporting({ kind: 'project' })} />}
          <Chip tone="action" label="Rerun" onClick={() => setRerun(true)} />
        </div> : <p className="research-card-note">No round yet. Released reports and project actions will appear here.</p>}
      </section>
      {roundsAndCatchUps(research).reverse().map((round) => {
        // A catch-up is the round 1 text answered by one late researcher.
        const dir = roundFolder(round);
        const where = round.catchUp ? 'catch-up' : `round ${round.n}`;
        return (
        <section className="research-card" key={round.catchUp ? `catch-up-${round.catchUp}` : `round-${round.n}`}>
          <ResultRow name={`round ${round.n} summary`} actions={
            !round.catchUp && round.releasedAt && roundSummary(round.n)
              ? actionsFor({ kind: 'synthesis', round: round.n }) : undefined
          }>
            <h3 className="research-card-title display-font">{round.catchUp ? `Catch-up ${round.catchUp}` : `Round ${round.n}`}</h3>
            {link('Record', join('rounds', dir, 'round.md'), 'Round record')}
            {!round.catchUp && roundSummary(round.n) && link('Summary', roundSummary(round.n)!)}
            {round.releasedAt && <time className="research-card-time" dateTime={round.releasedAt} title={`Released ${new Date(round.releasedAt).toLocaleString()}`}>{formatActivityTime(Date.parse(round.releasedAt))}</time>}
          </ResultRow>
          {round.contaminated && <p role="alert" className="research-card-note">
            <strong className="research-tag research-tag-warning">Independence check failed.</strong> This round contains another researcher's marker. Treat its reports as contaminated.
          </p>}
          {round.boundaryWarning && <p role="alert" className="research-card-note">
            <strong className="research-tag research-tag-warning">Sandbox warning.</strong> A researcher attempted to use a path or local address outside its sandbox. Check its activity.
          </p>}
          {!round.releasedAt && <p className="research-card-note">Still collecting replies; reports appear here when the round is released.</p>}
          {round.releasedAt && <ul className="research-rows" role="list">
            {[...research.researchers].sort((x, y) => x.letter.localeCompare(y.letter)).filter((r) => round.entries[r.letter]).map((r) => {
              const e = round.entries[r.letter];
              const who = researcherLabel(research, r.letter);
              const colour = memberColour(r.workflowId);
              const selection: ResearchSelection = round.catchUp ? { kind: 'report', catchUp: round.catchUp } : { kind: 'report', round: round.n, letter: r.letter };
              const [name, authors] = splitWho(who);
              return <li key={r.letter}>{e.state === 'replied'
                ? <ReportRow who={who} where={where} colour={colour} late={!!e.late} files={e.sources ?? []} actions={actionsFor(selection)}
                    onOpenReport={() => setOpen(reportPath(research, round, r.letter))} onOpenFile={(path) => setOpen(join(path))} />
                : <div className="research-result-label"><Who name={name} authors={authors} colour={colour} /><span className="research-tag">{ENTRY_WORDS[e.state]}</span></div>}</li>;
            })}
          </ul>}
        </section>
        );
      })}
      {rerun && <RerunResearchDialog clusterId={clusterId} onClose={() => setRerun(false)} />}
      {exporting && <ExportResearchDialog clusterId={clusterId} selection={exporting} onClose={() => setExporting(null)} />}
      {start && <StartResearchProjectDialog clusterId={clusterId} selection={start} onClose={() => setStart(null)} />}
      {send && <SendResearchDialog clusterId={clusterId} selection={send} defaultDestination={research.sourceProject} onClose={() => setSend(null)} />}
      {open && <FileViewerModal path={open} onClose={() => setOpen(null)} fallback={{ cwd: research.folder, workflowId: research.directorWorkflowId }} />}
    </div>
  );
}
