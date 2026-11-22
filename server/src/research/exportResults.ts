// docs/RESEARCH.md - export only released results; record after the browser
// reports a clipboard write or starts a download.
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { zipSync } from 'fflate';
import { recordResearchExport } from './sendToProject.js';
import { researchFolderForZip, selectResearchFiles, type ResearchSelection } from './resultSelection.js';
import type { ResearchState } from './researchState.js';

type ExportKind = 'markdown' | 'file' | 'zip';
const pending = new Map<string, { state: ResearchState; selection: ResearchSelection; kind: ExportKind; expires: number }>();
export async function previewResearchExport(state: ResearchState, selection: ResearchSelection) {
  const files = await selectResearchFiles(state, selection);
  return files.map(file => ({ path: file.relativePath, size: file.bytes.length }));
}
export async function prepareResearchExport(state: ResearchState, selection: ResearchSelection, kind: ExportKind, selectedPath?: string) {
  let bytes: Uint8Array, filename: string, mime: string;
  const selected = await selectResearchFiles(state, selection);
  if (kind === 'zip') {
    const files = await researchFolderForZip(state);
    const entries: Record<string, Uint8Array> = Object.create(null);
    for (const file of files) entries[file.relativePath] = file.bytes;
    bytes = zipSync(entries, { level: 0 }); filename = 'research.zip'; mime = 'application/zip';
  } else {
    const files = selected;
    if (kind === 'file') {
      const file = files.find(item => item.relativePath === selectedPath);
      if (!file) throw new Error('Choose a file from this released result.');
      bytes = file.bytes; filename = basename(file.relativePath); mime = 'application/octet-stream';
    } else if (kind === 'markdown') {
      const text = files.filter(file => /\.md$/i.test(file.relativePath));
      if (!text.length) throw new Error('No Markdown is available for this result.');
      bytes = Buffer.from(text.map(file => `# ${file.relativePath}\n\n${file.bytes.toString('utf8')}`).join('\n\n---\n\n'));
      filename = 'research.md'; mime = 'text/markdown';
    } else throw new Error('Choose an export action.');
  }
  const token = randomUUID();
  for (const [key, entry] of pending) if (entry.expires < Date.now()) pending.delete(key);
  pending.set(token, { state, selection, kind, expires: Date.now() + 10 * 60_000 });
  return { token, filename, mime, data: Buffer.from(bytes).toString('base64') };
}
export async function confirmResearchExport(clusterId: string, token: string): Promise<void> {
  const entry = pending.get(token);
  if (!entry || entry.state.clusterId !== clusterId || entry.expires < Date.now()) throw new Error('The export confirmation expired.');
  await recordResearchExport(entry.state, entry.selection, entry.kind === 'markdown' ? 'Markdown copied' : `${entry.kind} download started`);
  pending.delete(token);
}
