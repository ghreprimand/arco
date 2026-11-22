// docs/RESEARCH.md - explicit, non-overwriting copies of released research.
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path';
import { withFileLock } from '../atomicFile.js';
import { writeCheckedFile } from '../checkedFile.js';
import { assertSafePath } from '../fileAccessPolicy.js';
import { storeAttachment } from '../http/attachmentUpload.js';
import { workflows } from '../server/state.js';
import * as clusterStore from '../clusterStore.js';
import { isClusterDirector } from '@arco/shared';
import { researchSlug } from './researchFolder.js';
import { selectResearchFiles, type ResearchSelection } from './resultSelection.js';
import type { ResearchState } from './researchState.js';
import { planRefsDir, touchPlan, writePlanRef } from '../planStore.js';

async function safeDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Choose an existing absolute project folder.');
  const normalized = resolve(path); assertSafePath(normalized);
  const stat = await fs.lstat(normalized);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(normalized) !== normalized) throw new Error('The project folder is a link or unavailable.');
  return normalized;
}

export async function recordResearchExport(state: ResearchState, selection: ResearchSelection, destination: string): Promise<void> {
  const path = join(await fs.realpath(state.folder), 'exports.md');
  const entry = `\n- ${new Date().toISOString()} - ${selection.kind} - destination: ${destination.replace(/[\r\n]/g, ' ')}\n`;
  await withFileLock(path, async () => {
    const before = await fs.lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || await fs.realpath(path) !== path) throw new Error('The export log is unavailable or unsafe.');
    const file = await fs.open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      const after = await file.stat();
      if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) throw new Error('The export log changed.');
      await file.writeFile(entry); await file.sync();
    } finally { await file.close(); }
  });
}

export interface FolderSendResult { target?: string; written: string[]; error?: string; receiptError?: string }

// A reference owns only the sources its selected text actually names. The
// reference and its adjacent files are created exclusively, never replaced.
export async function sendResearchToPlan(state: ResearchState, selection: ResearchSelection, destination: string, planId: string): Promise<FolderSendResult> {
  const files = await selectResearchFiles(state, selection);
  const root = await safeDirectory(destination);
  const textFiles = files.filter(file => /\.md$/i.test(file.relativePath));
  if (!textFiles.length) throw new Error('No research text is available.');
  const combined = textFiles.map(file => file.bytes.toString('utf8')).join('\n\n---\n\n');
  const linked = files.filter(file => file.relativePath.startsWith('sources/') && combined.includes(file.relativePath));
  const base = `research-${researchSlug(state.name)}`.slice(0, 55).replace(/-+$/, '');
  let slug = '';
  let assetDir = '';
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const directory = join(planRefsDir(root, planId), `${candidate}.files`);
    if (await fs.lstat(directory).then(() => true, (err: NodeJS.ErrnoException) => { if (err.code === 'ENOENT') return false; throw err; })) continue;
    const sourceNames = new Map(linked.map(file => [file.relativePath, file.relativePath.slice('sources/'.length)]));
    let body = `# Research: ${state.name.replace(/[\r\n]/g, ' ')}\n\nResearch project: ${state.name.replace(/[\r\n]/g, ' ')} (${state.createdAt.slice(0, 10)})\n\n${combined}`;
    for (const [original, filename] of sourceNames) {
      const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      body = body.replace(new RegExp(`(?:\\.\\./)*${escaped}`, 'g'), `${candidate}.files/${filename}`);
    }
    const written = await writePlanRef(root, planId, candidate, body, { createOnly: true });
    if (!written.ok) { if (written.error === 'ref already exists') continue; throw new Error(written.error); }
    slug = candidate; assetDir = directory; break;
  }
  if (!slug) throw new Error('No free plan reference name.');
  const written = [`${slug}.md`];
  let error: string | undefined;
  try {
    if (linked.length) {
      await fs.mkdir(assetDir);
      if (await fs.realpath(assetDir) !== assetDir) throw new Error('The reference files folder is unsafe.');
      for (const file of linked) {
        const name = file.relativePath.slice('sources/'.length);
        if (!name || name.includes('/') || name.includes('\\')) throw new Error('Invalid source filename.');
        await writeCheckedFile(join(assetDir, name), file.bytes, false);
        written.push(`${slug}.files/${name}`);
      }
    }
    await touchPlan(root, planId);
  } catch (err) { error = err instanceof Error ? err.message : String(err); }
  let receiptError: string | undefined;
  try { await recordResearchExport(state, selection, `plan ${planId} reference ${slug}`); }
  catch (err) { receiptError = err instanceof Error ? err.message : String(err); }
  return { target: `${planRefsDir(root, planId)}/${slug}.md`, written, ...(error ? { error } : {}), ...(receiptError ? { receiptError } : {}) };
}
export async function sendResearchToFolder(state: ResearchState, selection: ResearchSelection, destination: string): Promise<FolderSendResult> {
  const files = await selectResearchFiles(state, selection);
  const root = await safeDirectory(destination);
  const research = join(root, 'research');
  try { await fs.mkdir(research); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await safeDirectory(research);
  const base = researchSlug(state.name);
  let target: string | undefined;
  for (let n = 1; n < 1000; n++) {
    const candidate = join(research, n === 1 ? base : `${base}-${n}`);
    try { await fs.mkdir(candidate); target = candidate; break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  if (!target) throw new Error('No free research destination name.');
  const written: string[] = [];
  let error: string | undefined;
  try {
    for (const file of files) {
      const path = join(target, file.relativePath);
      if (!path.startsWith(target + sep)) throw new Error('Invalid research destination.');
      let current = target;
      for (const part of file.relativePath.split('/').slice(0, -1)) {
        current = join(current, part);
        try { await fs.mkdir(current); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; }
        await safeDirectory(current);
      }
      await safeDirectory(dirname(path));
      let bytes = file.bytes;
      if (/\.md$/i.test(file.relativePath)) {
        let body = bytes.toString('utf8');
        for (const source of files.filter(item => item.relativePath.startsWith('sources/'))) {
          const escaped = source.relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const link = posix.relative(posix.dirname(file.relativePath), source.relativePath);
          body = body.replace(new RegExp(`(?:\\.\\./)*${escaped}`, 'g'), () => link);
        }
        bytes = Buffer.from(body, 'utf8');
      }
      await writeCheckedFile(path, bytes, false);
      written.push(file.relativePath);
    }
  } catch (err) { error = err instanceof Error ? err.message : String(err); }
  let receiptError: string | undefined;
  if (written.length) {
    try { await recordResearchExport(state, selection, target); }
    catch (err) { receiptError = err instanceof Error ? err.message : String(err); }
  }
  return { target, written, ...(error ? { error } : {}), ...(receiptError ? { receiptError } : {}) };
}

export interface ComposerSendResult { attachments: Array<{ path: string; filename: string; isImage: boolean }>; token?: string; error?: string }
const pendingComposer = new Map<string, { state: ResearchState; selection: ResearchSelection; workflowId: string; expires: number }>();
export async function stageResearchForComposer(state: ResearchState, selection: ResearchSelection, workflowId: string): Promise<ComposerSendResult> {
  const wf = workflows.get(workflowId);
  if (!wf || wf.config.incognito) throw new Error('Choose an open, saved conversation.');
  const clusterId = clusterStore.getClusterIdForWorkflow(workflowId);
  if (clusterId && !isClusterDirector(clusterStore.getMemberRole(clusterId, workflowId))) throw new Error('Choose the cluster Director.');
  const files = await selectResearchFiles(state, selection);
  if (files.length > 16 || files.reduce((sum, file) => sum + file.bytes.length, 0) > 20 * 1024 * 1024) throw new Error('This selection exceeds the attachment limit. Select a report or summary instead.');
  const attachments: ComposerSendResult['attachments'] = [];
  const reserved = files.map(file => ({ file, fileId: randomUUID().slice(0, 8), filename: file.relativePath.split('/').at(-1) || 'research.txt' }));
  let error: string | undefined;
  try {
    for (const { file, fileId, filename } of reserved) {
      const image = /\.(png|jpe?g|gif|webp)$/i.test(filename);
      let bytes = file.bytes;
      if (/\.md$/i.test(filename)) {
        let body = bytes.toString('utf8');
        for (const item of reserved) {
          if (item.file === file) continue;
          const original = item.file.relativePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          body = body.replace(new RegExp(`(?:\\.\\./)*${original}`, 'g'), `${item.fileId}-${item.filename}`);
        }
        bytes = Buffer.from(body, 'utf8');
      }
      const stored = await storeAttachment(bytes, filename, image ? 'image/' + (filename.toLowerCase().endsWith('.jpg') ? 'jpeg' : filename.split('.').at(-1)) : 'application/octet-stream', { fileId, beforeWrite: async () => {} });
      attachments.push({ path: stored.path, filename: stored.filename, isImage: image });
    }
  } catch (err) { error = err instanceof Error ? err.message : String(err); }
  const token = attachments.length ? randomUUID() : undefined;
  if (token) {
    for (const [key, pending] of pendingComposer) if (pending.expires < Date.now()) pendingComposer.delete(key);
    pendingComposer.set(token, { state, selection, workflowId, expires: Date.now() + 10 * 60_000 });
  }
  return { attachments, ...(token ? { token } : {}), ...(error ? { error } : {}) };
}

export async function confirmResearchComposer(clusterId: string, token: string): Promise<void> {
  const pending = pendingComposer.get(token);
  if (!pending || pending.state.clusterId !== clusterId || pending.expires < Date.now()) throw new Error('The staged attachment confirmation expired.');
  if (!workflows.has(pending.workflowId)) throw new Error('The destination conversation is no longer open.');
  await recordResearchExport(pending.state, pending.selection, `composer ${pending.workflowId}`);
  pendingComposer.delete(token);
}
