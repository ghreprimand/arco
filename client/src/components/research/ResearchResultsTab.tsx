import { useEffect, useState } from 'react';
import type { ClusterResearchSummary } from '@arco/shared';
import { FileViewerModal } from '../FileViewerModal';
import { ENTRY_WORDS, roundsAndCatchUps } from './researchView';

// docs/RESEARCH.md - RESULTS in a research project's right panel: the brief,
// the summary, each released round's reports and the sources folder.
export function ResearchResultsTab({ clusterId, research }: { clusterId: string; research: ClusterResearchSummary }) {
  const [open, setOpen] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<{ latest: boolean; rounds: number[] } | null>(null);
  const releasedKey = roundsAndCatchUps(research).map((r) => `${r.n}:${r.releasedAt ?? ''}`).join('|');
  useEffect(() => {
    let live = true;
    const load = () => fetch(`/api/research/${clusterId}/summaries`)
      .then(async (res) => (res.ok ? await res.json() as { latest: boolean; rounds: number[] } : null))
      .then((body) => { if (live && body) setSummaries(body); }).catch(() => undefined);
    void load();
    const timer = setInterval(load, 30_000);
    return () => { live = false; clearInterval(timer); };
  }, [clusterId, releasedKey]);
  const lastRound = research.rounds.at(-1)?.n;
  const roundSummary = (n: number): string | null => summaries?.rounds.includes(n) ? join('syntheses', `round-${n}.md`) : n === lastRound && summaries?.latest ? join('synthesis.md') : null;
  const join = (...parts: string[]) => [research.folder.replace(/[\\/]+$/, ''), ...parts].join('/');
  const link = (label: string, path: string) => (
    <button type="button" onClick={() => setOpen(path)} style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, background: 'none', border: 'none', padding: 0, color: 'var(--color-accent-secondary)', textDecoration: 'underline', cursor: 'pointer', font: 'inherit', textAlign: 'left' }}>{label}</button>
  );
  const authors = !research.blind || !!research.revealedAt;
  return (
    <div data-help="research.results" style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12, color: 'var(--color-fg)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        {link('Brief', join('brief.md'))}
        {summaries?.latest ? link('Summary', join('synthesis.md')) : <span style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>Awaiting summary</span>}
        {link('Director log', join('director-log.md'))}
        {link('Exports', join('exports.md'))}
      </div>
      {research.rounds.length === 0 && <div style={{ color: 'var(--color-fg)' }}>No round yet.</div>}
      {roundsAndCatchUps(research).reverse().map((round) => {
        // A catch-up is the round 1 text answered by one late researcher.
        const dir = round.catchUp ? `catch-up-${round.catchUp.toLowerCase()}` : `round-${round.n}`;
        return (
        <div key={round.n}>
          <div className="display-font" style={{ letterSpacing: 1, marginBottom: 4 }}>{round.catchUp ? `CATCH-UP ${round.catchUp}` : `ROUND ${round.n}`} {link('round record', join('rounds', dir, 'round.md'))}{!round.catchUp && roundSummary(round.n) ? <> · {link('summary', roundSummary(round.n)!)}</> : null}</div>
          {round.contaminated && <div role="alert" style={{ color: 'var(--color-warning)' }}>Independence check failed: this round contains another researcher's marker. Treat its reports as contaminated.</div>}
          {round.boundaryWarning && <div role="alert" style={{ color: 'var(--color-warning)' }}>A researcher attempted to use a path or local address outside its sandbox. Check its activity.</div>}
          {!round.releasedAt && <div style={{ color: 'var(--color-fg)' }}>Still collecting replies; reports appear here when the round is released.</div>}
          {round.releasedAt && <ul style={{ margin: 0, paddingLeft: 16 }}>
            {[...research.researchers].sort((x, y) => x.letter.localeCompare(y.letter)).filter((r) => round.entries[r.letter]).map((r) => {
              const e = round.entries[r.letter];
              const who = `Researcher ${r.letter}${authors ? ` (${r.provider}, ${r.model})` : ''}`;
              return <li key={r.letter}>{e.state === 'replied' ? link(`${who} report`, join('rounds', dir, `report-${r.letter.toLowerCase()}.md`)) : `${who}: ${ENTRY_WORDS[e.state]}`}</li>;
            })}
          </ul>}
        </div>
        );
      })}
      <div style={{ color: 'var(--color-fg)' }}>Returned files are in <code>sources/</code>; open them from FILES.</div>
      {open && <FileViewerModal path={open} onClose={() => setOpen(null)} fallback={{ cwd: research.folder, workflowId: research.directorWorkflowId }} />}
    </div>
  );
}
