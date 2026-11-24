// docs/RESEARCH.md "Copied research layout" - how released research is laid
// out when it is copied into a project folder (Send to a project and Start a
// project). The research project's own folder is never changed; this only
// renames files in the copy and writes a README.md index.
import { promises as fs } from 'node:fs';
import { posix } from 'node:path';
import type { ResearchRound, ResearchState } from './researchState.js';
import { researcherName } from './researchState.js';
import { readChecked, selectResearchFiles, RESEARCH_COPY_LIMITS, type ResearchSelection, type SelectedResearchFile } from './resultSelection.js';
import { sourceFileName } from './researchFolder.js';

export interface ResearchCopyCounts { rounds: number; catchUps: number; reports: number; summaries: number; returnedFiles: number }
export interface ResearchCopy {
  files: SelectedResearchFile[];
  counts: ResearchCopyCounts;
  // The copied summary the new project starts from, when there is one.
  startSummary?: string;
}

// Start project and Start from summary copy the whole released project plus
// the chosen summary; Start from report copies that report with its brief.
export async function researchCopyForStart(state: ResearchState, selection: ResearchSelection): Promise<ResearchCopy> {
  if (selection.kind === 'report') {
    const files = await selectResearchFiles(state, selection);
    const brief = await readChecked(await fs.realpath(state.folder), 'brief.md').then(bytes => [{ relativePath: 'brief.md', bytes }], () => []);
    return layoutResearchCopy(state, [...brief, ...files], selection, false);
  }
  const whole = await selectResearchFiles(state, { kind: 'project' }, { releasedSoFar: true });
  const chosen = selection.kind === 'synthesis' ? (await selectResearchFiles(state, selection)).find(file => /\.md$/.test(file.relativePath) && !file.relativePath.startsWith('sources/')) : undefined;
  const paths = new Set(whole.map(file => file.relativePath));
  return layoutResearchCopy(state, [...whole, ...(chosen && !paths.has(chosen.relativePath) ? [chosen] : [])], selection, true, chosen?.relativePath);
}

// Send to a project copies exactly the selection, in the same layout.
export async function researchCopyForSend(state: ResearchState, selection: ResearchSelection): Promise<ResearchCopy> {
  return layoutResearchCopy(state, await selectResearchFiles(state, selection), selection, selection.kind === 'project');
}

const roundFolder = (round: ResearchRound) => round.catchUp ? `catch-up-${round.catchUp.toLowerCase()}` : `round-${round.n}`;

function splitName(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
}

interface RoundIndex { round: ResearchRound; summary?: string; roundFile?: string; reports: Array<{ letter: string; path?: string; files: string[] }> }

function layoutResearchCopy(state: ResearchState, selected: SelectedResearchFile[], selection: ResearchSelection, whole: boolean, chosenSummary?: string): ResearchCopy {
  const byPath = new Map(selected.map(file => [file.relativePath, file]));
  const released = state.rounds.filter(round => !!round.releasedAt);
  const catchUps = (state.catchUps ?? []).filter(round => !!round.releasedAt && !!round.catchUp && /^[A-Z]$/.test(round.catchUp));
  // Old path in the research folder -> new paths in the copy.
  const moves = new Map<string, string[]>();
  const out: Array<{ path: string; from: string; preferSources?: string }> = [];
  const add = (from: string, to: string, preferSources?: string): boolean => {
    if (!byPath.has(from)) return false;
    out.push({ path: to, from, ...(preferSources ? { preferSources } : {}) });
    moves.set(from, [...(moves.get(from) ?? []), to]);
    return true;
  };
  const counts: ResearchCopyCounts = { rounds: 0, catchUps: 0, reports: 0, summaries: 0, returnedFiles: 0 };
  for (const name of ['brief.md', 'director-log.md', 'research.json']) add(name, name);
  // The summary the copy starts from is also summary.md at the top.
  let startSummary: string | undefined;
  const top = chosenSummary ?? (byPath.has('synthesis.md') ? 'synthesis.md' : selection.kind === 'synthesis' ? selected.find(file => file.relativePath.startsWith('syntheses/'))?.relativePath : undefined);
  if (top && add(top, 'summary.md')) startSummary = 'summary.md';
  const rounds: RoundIndex[] = [];
  for (const round of [...released, ...catchUps]) {
    const dir = `rounds/${roundFolder(round)}`;
    const entry: RoundIndex = { round, reports: [] };
    if (add(`${dir}/round.md`, `${dir}/round.md`)) entry.roundFile = `${dir}/round.md`;
    if (!round.catchUp && whole && add(`syntheses/round-${round.n}.md`, `${dir}/summary.md`)) entry.summary = `${dir}/summary.md`;
    // synthesis.md is the latest round's summary until it is archived, as in RESULTS.
    else if (!round.catchUp && whole && round === released.at(-1) && add('synthesis.md', `${dir}/summary.md`)) entry.summary = `${dir}/summary.md`;
    for (const [letter, result] of Object.entries(round.entries)) {
      if (!/^[A-Z]$/.test(letter)) continue;
      const lower = letter.toLowerCase();
      const filesDir = `${dir}/files/researcher-${lower}`;
      const report = `${dir}/researcher-${lower}.md`;
      const hasReport = add(`${dir}/report-${lower}.md`, report, `${filesDir}/`);
      const taken = new Set<string>();
      const seen = new Set<string>();
      const files: string[] = [];
      for (const artifact of result.artifacts ?? []) {
        const from = `sources/${sourceFileName(artifact)}`;
        if (seen.has(from) || !byPath.has(from)) continue;
        seen.add(from);
        // The original name, without the content-hash prefix.
        const original = sourceFileName(artifact).slice(13);
        const [stem, ext] = splitName(original);
        let name = original;
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem}-${n}${ext}`;
        taken.add(name.toLowerCase());
        add(from, `${filesDir}/${name}`);
        files.push(`${filesDir}/${name}`);
        counts.returnedFiles++;
      }
      if (hasReport) counts.reports++;
      if (hasReport || files.length) entry.reports.push({ letter, ...(hasReport ? { path: report } : {}), files });
    }
    if (entry.roundFile || entry.summary || entry.reports.length) {
      rounds.push(entry);
      if (round.catchUp) counts.catchUps++; else counts.rounds++;
    }
  }
  counts.summaries = [...moves.keys()].filter(path => path === 'synthesis.md' || path.startsWith('syntheses/')).length;
  // Anything not placed above keeps its research-folder path.
  for (const file of selected) if (!moves.has(file.relativePath)) add(file.relativePath, file.relativePath);
  // Links to copied files are rewritten in one pass, so a rewritten link is
  // never rewritten again. A returned file kept by several researchers links
  // to the copy beside the report that names it.
  const olds = [...moves.keys()].sort((a, b) => b.length - a.length);
  const pattern = olds.length ? new RegExp(`(?:\\.\\./)*(?:${olds.map(old => old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g') : null;
  const files: SelectedResearchFile[] = out.map(item => {
    let bytes = byPath.get(item.from)!.bytes;
    if (pattern && /\.md$/i.test(item.from)) {
      const here = posix.dirname(item.path);
      bytes = Buffer.from(bytes.toString('utf8').replace(pattern, match => {
        const targets = moves.get(match.replace(/^(?:\.\.\/)*/, ''))!;
        const target = targets.find(path => !!item.preferSources && path.startsWith(item.preferSources)) ?? targets.find(path => path.startsWith(here + '/')) ?? targets[0]!;
        return posix.relative(here, target);
      }), 'utf8');
    }
    return { relativePath: item.path, bytes };
  });
  const latest = top !== 'synthesis.md' && moves.get('synthesis.md')?.find(path => path !== 'summary.md');
  files.unshift({ relativePath: 'README.md', bytes: Buffer.from(renderReadme(state, selection, rounds, { startSummary, top, ...(latest ? { latest } : {}), brief: byPath.has('brief.md'), log: byPath.has('director-log.md') }), 'utf8') });
  if (files.length > RESEARCH_COPY_LIMITS.files) throw new Error(`This research has ${files.length} files to copy; the limit is ${RESEARCH_COPY_LIMITS.files}.`);
  const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (total > RESEARCH_COPY_LIMITS.bytes) throw new Error(`This research is ${Math.ceil(total / 1048576)} MiB to copy; the limit is ${RESEARCH_COPY_LIMITS.bytes / 1048576} MiB.`);
  return { files, counts, ...(startSummary ? { startSummary } : {}) };
}

function summaryName(path: string | undefined): string {
  const match = path ? /^syntheses\/round-(\d+)\.md$/.exec(path) : null;
  if (match) return `the summary of round ${match[1]}`;
  return 'the latest summary';
}

function renderReadme(state: ResearchState, selection: ResearchSelection, rounds: RoundIndex[], index: { startSummary?: string; top?: string; latest?: string; brief: boolean; log: boolean }): string {
  const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
  const authors = !state.blind || !!state.revealedAt;
  const who = (letter: string) => {
    const researcher = (state.researchers ?? []).find(r => r.letter === letter);
    return `${researcherName(letter)}${authors && researcher ? ` (${researcher.provider}, ${researcher.model})` : ''}`;
  };
  const link = (path: string) => `[${path}](${path.split('/').map(encodeURIComponent).join('/')})`;
  const briefText = oneLine(state.brief ?? '');
  const lines = [`# Research: ${oneLine(state.name ?? '') || 'Research'}`, '',
    `Copied from an Arco research project${state.createdAt ? ` started ${state.createdAt.slice(0, 10)}` : ''}. Only released research is included.`, ''];
  if (briefText) lines.push('## Brief', '', briefText.length > 600 ? `${briefText.slice(0, 600)}...` : briefText, '');
  lines.push('## Start here', '');
  if (index.startSummary) lines.push(`- ${link(index.startSummary)}: ${summaryName(index.top)}, which this copy starts from.`);
  else if (selection.kind === 'report') lines.push(`- This copy holds one report: ${rounds.flatMap(r => r.reports).flatMap(r => r.path ? [link(r.path)] : []).join(', ') || 'none'}.`);
  if (index.latest) lines.push(`- ${link(index.latest)}: the latest summary.`);
  if (index.brief) lines.push(`- ${link('brief.md')}: the full brief and the latest round's question.`);
  if (index.log) lines.push(`- ${link('director-log.md')}: the conversation with the Research Director.`);
  lines.push('');
  for (const entry of rounds) {
    lines.push(`## ${entry.round.catchUp ? `Catch-up, ${researcherName(entry.round.catchUp)}` : `Round ${entry.round.n}`}`, '');
    if (entry.roundFile) lines.push(`- ${link(entry.roundFile)}: what was asked and how each researcher finished.`);
    if (entry.summary) lines.push(`- ${link(entry.summary)}: the summary of this round.`);
    for (const report of entry.reports) {
      const files = report.files.length ? `; ${report.files.length} returned file${report.files.length === 1 ? '' : 's'} in ${link(posix.dirname(report.files[0]!) + '/')}` : '';
      lines.push(`- ${who(report.letter)}: ${report.path ? link(report.path) : 'no report'}${files}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
