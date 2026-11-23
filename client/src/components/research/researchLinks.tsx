import type { ClusterResearchSummary, ResearchRoundSummary } from '@arco/shared';

// docs/RESEARCH.md - links from RESULTS and the rounds strip to the files a
// released round wrote in the research folder. Both places use these, so
// reports and returned files open the same way and carry the same names.

export function researchPath(research: Pick<ClusterResearchSummary, 'folder'>, ...parts: string[]): string {
  return [research.folder.replace(/[\\/]+$/, ''), ...parts].join('/');
}

export function roundFolder(round: Pick<ResearchRoundSummary, 'n' | 'catchUp'>): string {
  return round.catchUp ? `catch-up-${round.catchUp.toLowerCase()}` : `round-${round.n}`;
}

export function reportPath(research: Pick<ClusterResearchSummary, 'folder'>, round: Pick<ResearchRoundSummary, 'n' | 'catchUp'>, letter: string): string {
  return researchPath(research, 'rounds', roundFolder(round), `report-${letter.toLowerCase()}.md`);
}

// Provider and model only once the reports are not blind (or after REVEAL).
export function researcherLabel(research: Pick<ClusterResearchSummary, 'blind' | 'revealedAt' | 'researchers'>, letter: string): string {
  const r = research.researchers.find((x) => x.letter === letter);
  const authors = !research.blind || !!research.revealedAt;
  return `Researcher ${letter}${authors && r ? ` (${r.provider}, ${r.model})` : ''}`;
}

export function ResearchFileLink({ label, path, onOpen }: { label: string; path: string; onOpen: (path: string) => void }) {
  return (
    <button type="button" onClick={() => onOpen(path)} style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44, background: 'none', border: 'none', padding: 0, color: 'var(--color-accent-secondary)', textDecoration: 'underline', cursor: 'pointer', font: 'inherit', textAlign: 'left', overflowWrap: 'anywhere' }}>{label}</button>
  );
}
