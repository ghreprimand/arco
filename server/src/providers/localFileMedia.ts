import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { FileContextMessage, FileContextReference, WorkerConfig } from '@arco/shared';
import { readFileContent } from '../fileContent.js';
import { ensureStorageRoot } from '../storageRoot.js';
import { openCheckedFile, writeCheckedFile } from '../checkedFile.js';
import { UPLOADS_DIR } from '../server/constants.js';
import { resolveToolPath } from '../toolPath.js';
import { clipFileText, fileLabel, fileReferenceKey, FILE_CONTEXT_CACHE_DIR, MAX_FILE_REFERENCES, validFileReference } from '../fileContextReceipts.js';
import type { ProviderImage } from './providerFileContent.js';

export type LocalContextPreparation = { text: string; images: ProviderImage[]; notices: string[] };
export type ContextEmitter = (event: Omit<FileContextMessage, 'type' | 'workflowId'>) => void;
export type SavedToolText = { name: string; text: string };
type Snapshot = { text: string; images: ProviderImage[] };
const memory = new Map<string, { owner: string; workflowId: string; bytes: number; snapshot: Snapshot }>();
let memoryBytes = 0;
const MEMORY_BUDGET = 32 * 1024 * 1024;
const warned = new Set<string>();
const owner = (config: WorkerConfig) => `${path.resolve(config.fileContextCwd ?? config.cwd ?? '.')}::${config.workflowId ?? ''}`;
export function clearLocalFileMedia(workflowId: string): void {
  for (const [key, entry] of memory) if (entry.workflowId === workflowId) { memoryBytes -= entry.bytes; memory.delete(key); }
  for (const key of warned) if (key.endsWith(`::${workflowId}`)) warned.delete(key);
}
function rememberMemory(config: WorkerConfig, snapshot: Snapshot): string {
  const key = randomUUID(), images = snapshot.images.slice(-2), text = clipFileText(snapshot.text, 32 * 1024);
  const bytes = Buffer.byteLength(text) + images.reduce((sum, image) => sum + image.data.length, 0);
  memory.set(key, { owner: owner(config), workflowId: config.workflowId!, bytes, snapshot: { text, images } }); memoryBytes += bytes;
  while (memoryBytes > MEMORY_BUDGET && memory.size > 1) {
    const oldest = memory.keys().next().value!; memoryBytes -= memory.get(oldest)!.bytes; memory.delete(oldest);
  }
  return key;
}
async function cacheRoot(cwd: string, workflowId: string, create: boolean): Promise<string> {
  if (typeof workflowId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(workflowId)) throw new Error('Invalid conversation identifier.');
  let root = await realpath(cwd);
  for (const segment of ['.arco', 'workflows', workflowId]) root = await ensureStorageRoot(path.join(root, segment), false);
  const target = path.join(root, FILE_CONTEXT_CACHE_DIR);
  if (create) { try { await mkdir(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
  return ensureStorageRoot(target, false);
}
function addReferences(config: WorkerConfig, refs: FileContextReference[]): void {
  if (!config.priorFiles) return;
  const all = new Map(config.priorFiles.map(ref => [fileReferenceKey(ref), ref]));
  for (const ref of refs) { const key = fileReferenceKey(ref); all.delete(key); all.set(key, ref); }
  config.priorFiles.splice(0, config.priorFiles.length, ...[...all.values()].slice(-MAX_FILE_REFERENCES));
}
function briefInput(input: unknown): string {
  let text = '';
  try { text = JSON.stringify(input); } catch { return '(input unavailable)'; }
  return clipFileText(text.replace(/[A-Za-z0-9+/]{200,}={0,2}/g, '[data]'), 700);
}
async function saveContent(root: string, content: Buffer, extension: string): Promise<string> {
  const cacheName = `${createHash('sha256').update(content).digest('hex')}.${extension}`;
  const target = path.join(root, cacheName);
  try {
    const existing = await openCheckedFile(target);
    await existing.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await writeCheckedFile(target, content, false, 0o600);
  }
  return cacheName;
}
async function saveSnapshot(config: WorkerConfig, name: string, snapshot: Snapshot, signal?: AbortSignal): Promise<FileContextReference[]> {
  signal?.throwIfAborted();
  if (config.incognito) return [{ kind: 'memory', name, key: rememberMemory(config, snapshot), media: snapshot.images.length ? 'image' : 'text' }];
  const root = await cacheRoot(config.fileContextCwd ?? config.cwd!, config.workflowId!, true);
  const refs: FileContextReference[] = [];
  // These immutable saved inputs belong to conversation retention. They are
  // never automatically deleted; archive and purge include the entire folder.
  if (snapshot.text.trim()) {
    const clipped = clipFileText(snapshot.text, 32 * 1024);
    const cacheName = await saveContent(root, Buffer.from(clipped), 'txt');
    refs.push({ kind: 'cached', cacheName, ownerWorkflowId: config.workflowId!, name: `${name} text`, media: 'text' });
  }
  for (const image of snapshot.images.slice(-2)) {
    signal?.throwIfAborted();
    if (image.data.length > 5 * 1024 * 1024) continue;
    const cacheName = await saveContent(root, Buffer.from(image.data, 'base64'), image.mediaType === 'image/jpeg' ? 'jpg' : 'png');
    refs.push({ kind: 'cached', cacheName, ownerWorkflowId: config.workflowId!, name: fileLabel(image.name), media: 'image' });
  }
  return refs;
}
function describeReference(ref: FileContextReference): string {
  if (ref.kind === 'cached') return `${ref.name}: ${JSON.stringify(path.join('.arco', 'workflows', ref.ownerWorkflowId, FILE_CONTEXT_CACHE_DIR, ref.cacheName))}`;
  return `${ref.name}: recent private-memory snapshot`;
}
async function retain(config: WorkerConfig, snapshot: Snapshot, options: { name: string; origin: 'attachment' | 'tool'; sourcePaths?: string[]; tool?: string; input?: unknown; toolUseId?: string; signal?: AbortSignal; emit: ContextEmitter; notice?: (text: string) => void }): Promise<string | undefined> {
  if (config.priorFiles === undefined || !config.workflowId || !config.cwd || options.signal?.aborted || (!snapshot.text.trim() && !snapshot.images.length)) return;
  let refs: FileContextReference[];
  try { refs = await saveSnapshot(config, options.name, snapshot, options.signal); warned.delete(owner(config)); }
  catch {
    if (options.signal?.aborted) return;
    refs = [{ kind: 'memory', name: options.name, key: rememberMemory(config, snapshot), media: snapshot.images.length ? 'image' : 'text' }];
    if (!warned.has(owner(config))) { warned.add(owner(config)); options.notice?.('File context could not be saved on disk. Recent media is retained in memory; named sources remain in the conversation.'); }
  }
  if (options.signal?.aborted) return;
  const source = options.tool ? `${options.tool} ${briefInput(options.input)}` : `attachments: ${options.name}`;
  const receipt = clipFileText(`[Saved file context from ${source}]\n${refs.map(describeReference).join('\n')}`, 4096);
  addReferences(config, refs);
  options.emit({ origin: options.origin, receipt, files: refs,
    ...(options.sourcePaths ? { sourcePaths: options.sourcePaths.slice(-64) } : {}),
    ...(config.fileContextInputIds?.length ? { inputClientMessageIds: config.fileContextInputIds.slice(-128) } : {}),
    ...(options.tool ? { tool: options.tool, toolInput: briefInput(options.input), toolUseId: options.toolUseId } : {}) });
  return receipt;
}
export async function rememberLocalAttachments(config: WorkerConfig, prepared: Snapshot, emit: ContextEmitter, notice: (text: string) => void, signal?: AbortSignal): Promise<void> {
  if (!config.attachments?.length || config.incognito) return;
  await retain(config, prepared, { name: 'Attachments', origin: 'attachment', sourcePaths: config.attachments, emit, notice, signal });
}
export async function rememberLocalToolMedia(config: WorkerConfig, tool: string, input: unknown, toolUseId: string, images: ProviderImage[], documents: SavedToolText[], emit: ContextEmitter, notice: (text: string) => void, signal?: AbortSignal): Promise<string | undefined> {
  if (!images.length && !documents.length) return;
  const text = documents.map(document => `${fileLabel(document.name)}\n${document.text}`).join('\n\n');
  return retain(config, { text, images }, { name: tool, origin: 'tool', tool, input, toolUseId, emit, notice, signal });
}
function within(root: string, candidate: string): boolean { const relative = path.relative(root, candidate); return !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); }
async function authorizedSource(config: WorkerConfig, value: string): Promise<string> {
  const target = path.resolve(config.fileContextCwd ?? config.cwd!, value);
  for (const cwd of [config.cwd, config.fileContextCwd].filter((root): root is string => !!root)) {
    if (within(path.resolve(cwd), target)) return resolveToolPath(cwd, target);
  }
  const uploads = await ensureStorageRoot(UPLOADS_DIR, false);
  const canonical = await realpath(target);
  if (!within(uploads, canonical) || canonical !== target) throw new Error('Earlier attachment is outside its authorized folder.');
  return canonical;
}
async function referencePath(config: WorkerConfig, ref: FileContextReference): Promise<string> {
  if (!validFileReference(ref)) throw new Error('Invalid saved file reference.');
  if (ref.kind === 'source') return authorizedSource(config, ref.path);
  if (ref.kind !== 'cached') throw new Error('No saved file.');
  const root = await cacheRoot(config.fileContextCwd ?? config.cwd!, ref.ownerWorkflowId, false);
  const candidate = path.join(root, ref.cacheName);
  const stat = await lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Saved context file is not regular.');
  return candidate;
}
/** Read can reopen only explicitly retained sources outside its ordinary cwd. */
export async function resolveLocalContextRead(config: WorkerConfig, requested: string): Promise<string> {
  let ordinary: string | undefined;
  try { ordinary = resolveToolPath(config.cwd!, requested); } catch { /* Try exact retained references only. */ }
  if (ordinary) {
    try { await lstat(ordinary); return ordinary; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const candidates = [path.resolve(config.cwd!, requested), path.resolve(config.fileContextCwd ?? config.cwd!, requested)];
  const refs: FileContextReference[] = [...(config.priorFiles ?? []), ...(config.attachments ?? []).map(value => ({ kind: 'source' as const, path: value, name: path.basename(value) }))];
  for (const ref of refs) {
    if (!validFileReference(ref) || ref.kind === 'memory') continue;
    const expected = ref.kind === 'source' ? path.resolve(config.fileContextCwd ?? config.cwd!, ref.path) : path.resolve(config.fileContextCwd ?? config.cwd!, '.arco', 'workflows', ref.ownerWorkflowId, FILE_CONTEXT_CACHE_DIR, ref.cacheName);
    if (candidates.includes(expected)) return referencePath(config, ref);
  }
  throw new Error('Read path is outside the workflow or its retained attached files.');
}
export async function prepareLocalFileContext(config: WorkerConfig, vision: boolean, signal?: AbortSignal): Promise<LocalContextPreparation> {
  const current = new Set((config.attachments ?? []).map(value => path.resolve(config.fileContextCwd ?? config.cwd ?? '.', value)));
  const refs = (config.priorFiles ?? []).filter(ref => ref.kind !== 'source' || !current.has(path.resolve(config.fileContextCwd ?? config.cwd ?? '.', ref.path)));
  const selected = new Set([
    ...refs.filter(ref => ref.media === 'image').slice(-2),
    ...refs.filter(ref => ref.media !== 'image' && !(ref.kind === 'source' && ref.restore === false)).slice(-6),
  ]);
  const entries: Array<{ text: string; images: ProviderImage[] }> = [];
  const notices: string[] = [];
  let textBudget = 8 * 1024, imageBudget = 2;
  for (const ref of [...refs].reverse()) {
    if (!selected.has(ref) || signal?.aborted) continue;
    try {
      let snapshot: Snapshot;
      if (ref.kind === 'memory') {
        const entry = memory.get(ref.key);
        if (!entry || entry.owner !== owner(config)) throw new Error('Private-memory snapshot is no longer available.');
        snapshot = entry.snapshot;
      } else {
        const result = await readFileContent(await referencePath(config, ref), { signal, limits: { images: vision && imageBudget > 0, documents: false, maxImages: Math.max(1, imageBudget), maxImageBase64Bytes: 2 * 1024 * 1024, maxTextBytes: Math.max(1, textBudget) } });
        snapshot = { text: result.text, images: result.blocks.filter((block): block is ProviderImage => block.type === 'image') };
      }
      const body = clipFileText(snapshot.text, textBudget); textBudget -= Buffer.byteLength(body);
      const images = vision && imageBudget > 0 ? snapshot.images.slice(-imageBudget).map(image => ({ ...image, name: ref.name })) : [];
      imageBudget -= images.length;
      const label = ref.kind === 'cached' ? describeReference(ref) : ref.name;
      entries.push({ text: `[Earlier file: ${label}]\n${body}${!vision && snapshot.images.length ? '\n[Image not sent: the selected model did not report vision support.]' : ''}`, images });
    } catch {
      if (signal?.aborted) break;
      const note = `Earlier file unavailable: ${ref.name}. The named receipt and original source remain in the conversation.`;
      entries.push({ text: `[${note}]`, images: [] }); notices.push(note);
    }
  }
  entries.reverse();
  return { text: entries.length ? '[Earlier file context]\n' + entries.map(entry => entry.text).join('\n\n') : '', images: entries.flatMap(entry => entry.images), notices };
}
