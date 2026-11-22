// docs/RESEARCH.md - select only material that has crossed a round's release
// barrier. The selection is shared by result actions, never by researchers.
import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { ResearchState } from './researchState.js';
import { sourceFileName } from './researchFolder.js';

export type ResearchSelection =
  | { kind: 'report'; round: number; letter: string }
  | { kind: 'report'; catchUp: string }
  | { kind: 'synthesis'; round: number }
  | { kind: 'project' };
export interface SelectedResearchFile { relativePath: string; bytes: Buffer }
const MAX_FILE = 16 * 1024 * 1024;
const MAX_TOTAL = 64 * 1024 * 1024;
const MAX_FILES = 300;

async function readChecked(root: string, name: string): Promise<Buffer> {
  const path = join(root, name);
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith('..' + sep)) throw new Error('Invalid research file.');
  const before = await fs.lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_FILE || await fs.realpath(path) !== path) throw new Error(`Research file is unavailable or unsafe: ${name}`);
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino || after.size > MAX_FILE) throw new Error(`Research file changed: ${name}`);
    const data = Buffer.alloc(after.size + 1);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const final = await handle.stat();
    if (offset !== after.size || final.size !== after.size || final.mtimeMs !== after.mtimeMs || final.nlink !== 1) throw new Error(`Research file changed: ${name}`);
    return data.subarray(0, offset);
  } finally { await handle.close(); }
}

// Every name is constructed from the recorded state, never from a supplied path.
export async function selectResearchFiles(state: ResearchState, selection: ResearchSelection): Promise<SelectedResearchFile[]> {
  const root = await fs.realpath(state.folder);
  const released = state.rounds.filter(round => !!round.releasedAt);
  const releasedCatchUps = (state.catchUps ?? []).filter(round => !!round.releasedAt);
  const names = new Set<string>();
  const addSources = (round: typeof released[number], letter?: string) => {
    for (const [who, entry] of Object.entries(round.entries)) {
      if (letter && letter !== who) continue;
      for (const artifact of entry.artifacts ?? []) names.add(join('sources', sourceFileName(artifact)));
    }
  };
  if (selection.kind === 'report') {
    const letter = 'catchUp' in selection ? selection.catchUp : selection.letter;
    const round = 'catchUp' in selection ? releasedCatchUps.find(r => r.catchUp === letter) : released.find(r => r.n === selection.round);
    if (!round || typeof letter !== 'string' || !/^[A-Z]$/.test(letter) || round.entries[letter]?.state !== 'replied') throw new Error('This report is not released.');
    const dir = round.catchUp ? `catch-up-${letter.toLowerCase()}` : `round-${round.n}`;
    names.add(join('rounds', dir, `report-${letter.toLowerCase()}.md`));
    addSources(round, letter);
  } else if (selection.kind === 'synthesis') {
    const round = released.find(r => r.n === selection.round);
    if (!round) throw new Error('This synthesis is not released.');
    const archive = join('syntheses', `round-${round.n}.md`);
    if (await fs.access(join(root, archive)).then(() => true, () => false)) names.add(archive);
    else if (released.at(-1)?.n === round.n && await fs.access(join(root, 'synthesis.md')).then(() => true, () => false)) names.add('synthesis.md');
    else throw new Error('This synthesis is not available.');
    for (const sourceRound of released.filter(r => r.n <= round.n)) addSources(sourceRound);
  } else if (selection.kind === 'project') {
    if (state.rounds.some(r => !r.releasedAt)) throw new Error('Wait until the current round is released.');
    names.add('brief.md'); names.add('research.json'); names.add('director-log.md');
    if (await fs.access(join(root, 'synthesis.md')).then(() => true, () => false)) names.add('synthesis.md');
    for (const round of releasedCatchUps) {
      const letter = round.catchUp;
      if (!letter || !/^[A-Z]$/.test(letter)) continue;
      names.add(join('rounds', `catch-up-${letter.toLowerCase()}`, 'round.md'));
      if (round.entries[letter]?.state === 'replied') names.add(join('rounds', `catch-up-${letter.toLowerCase()}`, `report-${letter.toLowerCase()}.md`));
      addSources(round);
    }
    for (const round of released) {
      names.add(join('rounds', `round-${round.n}`, 'round.md'));
      for (const [letter, entry] of Object.entries(round.entries)) if (/^[A-Z]$/.test(letter) && entry.state === 'replied') names.add(join('rounds', `round-${round.n}`, `report-${letter.toLowerCase()}.md`));
      const summary = join('syntheses', `round-${round.n}.md`);
      if (await fs.access(join(root, summary)).then(() => true, () => false)) names.add(summary);
      addSources(round);
    }
  } else throw new Error('Choose a report, synthesis or project.');
  if (names.size > MAX_FILES) throw new Error('The selected research has too many files to send at once.');
  let total = 0;
  const out: SelectedResearchFile[] = [];
  for (const name of names) {
    const bytes = await readChecked(root, name);
    total += bytes.length;
    if (total > MAX_TOTAL) throw new Error('The selected research is too large to send at once.');
    out.push({ relativePath: name.split(sep).join('/'), bytes });
  }
  return out;
}
