// docs/RESEARCH.md - the research folder: plain files a person can read
// without Arco. Everything written here may be read by the Research
// Director, so nothing unreleased and, while blind, no provider or model.

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { atomicWriteFile } from '../atomicFile.js';
import type { ResearchArtifact, ResearchRound, ResearchState } from './researchState.js';
import { catchUpLetter, researcherName } from './researchState.js';

export function researchSlug(name: string): string {
  const words = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);
  const slug = words.slice(0, 6).join('-').slice(0, 48).replace(/-+$/, '');
  return slug || 'research';
}

export function researchFolderName(name: string, now: Date): string {
  return `${now.toISOString().slice(0, 10)}-${researchSlug(name)}`;
}

// Makes <root>/<yyyy-mm-dd>-<slug>/ (with -2, -3 when taken) and its
// subfolders. Never reuses or empties an existing folder.
export async function createResearchFolder(root: string, name: string, now: Date): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  const base = researchFolderName(name, now);
  for (let i = 1; i < 1000; i++) {
    const folder = join(root, i === 1 ? base : `${base}-${i}`);
    try {
      await fs.mkdir(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    for (const sub of ['rounds', 'syntheses', 'sources']) await fs.mkdir(join(folder, sub), { recursive: true });
    return folder;
  }
  throw new Error('No free research folder name.');
}

function showAuthors(state: ResearchState): boolean { return !state.blind || !!state.revealedAt; }

export function renderManifest(state: ResearchState, status: 'open' | 'closed' = state.closedAt ? 'closed' : 'open'): string {
  const authors = showAuthors(state);
  return JSON.stringify({
    schemaVersion: 1,
    // Matches the folder to its Research library entry (docs/RESEARCH.md).
    projectId: state.projectId,
    ...(state.quick ? { quick: true } : {}),
    name: state.name,
    brief: state.brief,
    status,
    createdAt: state.createdAt,
    ...(state.closedAt ? { closedAt: state.closedAt } : {}),
    ...(state.reopenedAt ? { reopenedAt: state.reopenedAt } : {}),
    blind: state.blind,
    ...(state.revealedAt ? { revealedAt: state.revealedAt } : {}),
    researchers: state.researchers.map((r) => ({
      letter: r.letter,
      ...(authors ? { provider: r.provider, model: r.model, ...(r.effort ? { effort: r.effort } : {}), ...(r.claudeTransport ? { transport: r.claudeTransport } : {}) } : {}),
      ...(r.joinedAt ? { joinedAt: r.joinedAt, includedFromRound: r.joinedFromRound } : {}),
      ...(r.removedAt ? { removedAt: r.removedAt } : {}),
    })),
    rounds: state.rounds.map(manifestRound),
    ...(state.catchUps?.length ? { catchUps: state.catchUps.map(manifestRound) } : {}),
  }, null, 2) + '\n';
}

function manifestRound(round: ResearchRound) {
  return {
      ...(round.catchUp ? { catchUp: round.catchUp } : { n: round.n }),
      startedAt: round.startedAt,
      ...(round.contaminated ? { contaminated: true } : {}),
      ...(round.boundaryWarning ? { boundaryWarning: true } : {}),
      ...(round.releasedAt ? { releasedAt: round.releasedAt } : {}),
      // Per-researcher outcome appears only once the round is released.
      ...(round.releasedAt ? { reports: Object.fromEntries(Object.entries(round.entries).map(([l, e]) => [l, e.state])) } : {}),
  };
}

export function renderBrief(state: ResearchState): string {
  const latest = state.rounds.at(-1);
  return [
    '# Research brief',
    '',
    `Project: ${state.name}`,
    '',
    '## Brief from the operator',
    '',
    state.brief,
    ...(latest ? ['', `## Round ${latest.n} brief, as sent ${latest.startedAt}`, '', latest.text] : []),
    '',
  ].join('\n');
}

const STATE_WORDS: Record<string, string> = {
  waiting: 'waiting', replied: 'replied', failed: 'failed', stopped: 'stopped', timed_out: 'timed out', removed: 'removed',
};

// "Round 2", or "Catch-up, Researcher C" for a researcher that joined late.
export function roundTitle(round: Pick<ResearchRound, 'n' | 'catchUp'>): string {
  return round.catchUp ? `Catch-up, ${researcherName(round.catchUp)}` : `Round ${round.n}`;
}

export function renderRound(state: ResearchState, round: ResearchRound): string {
  const authors = showAuthors(state);
  const lines = [`# ${roundTitle(round)}`, '', ...(round.catchUp ? ['The round 1 text, sent to this researcher alone after it joined.', ''] : []), `Started: ${round.startedAt}`, `Deadline: ${round.deadline}`,
    `Released: ${round.releasedAt ?? 'not yet'}`,
    ...(round.contaminated ? ['Independence check failed: treat this round as contaminated.'] : []),
    ...(round.boundaryWarning ? ['A researcher attempted access outside the sandbox; check its activity.'] : []),
    '', '## Asked', '', round.text, '', '## Researchers', ''];
  for (const r of state.researchers) {
    const entry = round.entries[r.letter];
    if (!entry) continue;
    // Before release the Director may read this file, so outcomes stay hidden.
    const outcome = round.releasedAt
      ? `${STATE_WORDS[entry.state] ?? entry.state}${entry.source === 'final_reply' ? ' (taken from final reply)' : ''}${entry.reason ? ` - ${entry.reason}` : ''}`
      : 'held until the round is released';
    lines.push(`- ${researcherName(r.letter)}${authors ? ` (${r.provider}${r.claudeTransport ? ` ${r.claudeTransport}` : ''}, ${r.model})` : ''}: ${outcome}`);
  }
  lines.push('', '## Targeted messages', '');
  if (round.targeted.length === 0) lines.push('None.');
  for (const t of round.targeted) {
    lines.push(`- ${t.at} ${t.from === 'operator' ? 'Operator' : 'Research Director'} to ${researcherName(t.letter)}:`, '', t.text.split('\n').map((l) => `  > ${l}`).join('\n'), '');
  }
  return lines.join('\n') + '\n';
}

// A catch-up has a negative key in place of a round number (catchUpKey).
export function roundDir(folder: string, n: number): string {
  return join(folder, 'rounds', n < 0 ? `catch-up-${catchUpLetter(n).toLowerCase()}` : `round-${n}`);
}

export function sourceFileName(artifact: ResearchArtifact): string {
  const data = Buffer.from(artifact.contentBase64, 'base64');
  const hash = createHash('sha256').update(data).digest('hex').slice(0, 12);
  const safe = artifact.name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'file';
  return `${hash}-${safe}`;
}

// Writes the released round: one report file per researcher that replied,
// returned files into sources/ (de-duplicated by content) and round.md.
export async function writeReleasedRound(state: ResearchState, round: ResearchRound): Promise<Record<string, { reportPath?: string; sources: string[] }>> {
  const dir = roundDir(state.folder, round.n);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(join(state.folder, 'sources'), { recursive: true });
  const out: Record<string, { reportPath?: string; sources: string[] }> = {};
  for (const r of state.researchers) {
    const entry = round.entries[r.letter];
    if (!entry) continue;
    const sources: string[] = [];
    for (const artifact of entry.artifacts ?? []) {
      const name = sourceFileName(artifact);
      const path = join(state.folder, 'sources', name);
      await fs.writeFile(path, Buffer.from(artifact.contentBase64, 'base64'), { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      sources.push(`sources/${name}`);
    }
    let reportPath: string | undefined;
    if (entry.state === 'replied' && entry.report) {
      reportPath = join(dir, `report-${r.letter.toLowerCase()}.md`);
      const header = [round.catchUp ? `# Catch-up on round 1, ${researcherName(r.letter)}` : `# Round ${round.n}, ${researcherName(r.letter)}`, '',
        ...(entry.source === 'final_reply' ? ['Taken from the researcher\'s final reply; no report was sent.', ''] : []),
        ...(sources.length ? ['Returned files:', ...sources.map((s) => `- ${s}`), ''] : []), ''];
      await atomicWriteFile(reportPath, header.join('\n') + entry.report.trim() + '\n');
    }
    out[r.letter] = { ...(reportPath ? { reportPath } : {}), sources };
  }
  await atomicWriteFile(join(dir, 'round.md'), renderRound(state, round));
  return out;
}

export async function writeProjectFiles(state: ResearchState): Promise<void> {
  await atomicWriteFile(join(state.folder, 'research.json'), renderManifest(state));
  await atomicWriteFile(join(state.folder, 'brief.md'), renderBrief(state));
}

export async function writeInitialFiles(state: ResearchState): Promise<void> {
  await writeProjectFiles(state);
  const create = async (name: string, text: string): Promise<void> => {
    await fs.writeFile(join(state.folder, name), text, { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
  };
  await create('director-log.md', '# Director log\n\nThe conversation between the operator and the Research Director. Tool calls are folded to one line each.\n');
  await create('exports.md', '# Exports\n\nWhere results were sent and when.\n');
}

export async function writeRoundStart(state: ResearchState, round: ResearchRound): Promise<void> {
  await fs.mkdir(roundDir(state.folder, round.n), { recursive: true });
  await atomicWriteFile(join(roundDir(state.folder, round.n), 'round.md'), renderRound(state, round));
  await writeProjectFiles(state);
}

export async function appendDirectorLog(folder: string, text: string): Promise<void> {
  await fs.appendFile(join(folder, 'director-log.md'), text);
}

// Which distilled answers exist: synthesis.md (the latest) and the rounds
// kept in syntheses/round-N.md.
export async function researchSummaries(state: Pick<ResearchState, 'folder'>): Promise<{ latest: boolean; rounds: number[] }> {
  const latest = await fs.access(join(state.folder, 'synthesis.md')).then(() => true, () => false);
  const names = await fs.readdir(join(state.folder, 'syntheses')).catch(() => [] as string[]);
  const rounds = names.flatMap((name) => { const m = /^round-(\d+)\.md$/.exec(name); return m ? [Number(m[1])] : []; }).sort((a, b) => a - b);
  return { latest, rounds };
}
