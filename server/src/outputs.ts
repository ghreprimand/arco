import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream, realpathSync } from 'node:fs';
import { open, lstat, writeFile, readFile, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { OutputCategory, WorkflowOutput, ServerMessage } from '@arco/shared';
import { atomicWriteFile, withFileLock } from './atomicFile.js';
import { assertSafePath, confinedPath, isPathWithin } from './fileAccessPolicy.js';
import { readSettings } from './settings.js';
import { knownRoots, resolveBoundCwd } from './http/writeConfinement.js';
import { workflows } from './server/state.js';
import { matchFileEvent } from './recentFilesLedger.js';
import { outputDirectory, readOutputIndex, writeOutputIndex, mappedOutputPath, type StoredOutput, type OutputIndex } from './outputStore.js';

export interface OutputContext { cwd: string; workflowId: string; producer: string; }
const LIMIT = 2000;
const EXTENSIONS: Record<OutputCategory, string[]> = {
  images: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'ico'],
  documents: ['md', 'markdown', 'txt', 'pdf', 'doc', 'docx', 'odt', 'rtf', 'csv', 'json', 'html', 'htm', 'xml', 'yaml', 'yml', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'py', 'rs', 'go', 'java', 'css', 'sh', 'sql', 'diff', 'patch'],
  audio: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'], video: ['mp4', 'webm', 'mov', 'mkv', 'avi'], other: [],
};
export function outputCategory(file: string): OutputCategory {
  const ext = path.extname(file).slice(1).toLowerCase();
  return (Object.keys(EXTENSIONS) as OutputCategory[]).find(kind => EXTENSIONS[kind].includes(ext)) ?? 'other';
}
const idFor = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const hiddenOutput = (file: string) => file.split(/[\\/]/).some(value => { const part = value.toLowerCase(); return (part.startsWith('.') && !['.arco', '.', '..'].includes(part)) || part === 'raw-tools'; });

export async function outputContext(cwd: string | undefined, workflowId: string): Promise<OutputContext> {
  if (!/^[a-z0-9_-]{1,64}$/i.test(workflowId)) throw new Error('Invalid output workflow.');
  const live = workflows.get(workflowId);
  if (live?.config.incognito || live?.config.voiceOperator) throw new Error('This workflow does not publish Outputs.');
  let bound = await resolveBoundCwd(cwd, workflowId);
  if (!bound.ok) bound = await resolveBoundCwd(cwd, undefined);
  if (!bound.ok) throw new Error('Output workflow is not available in an authorized project.');
  let dir: string;
  try { dir = await outputDirectory(bound.cwd, workflowId); } catch {
    // Cluster members may have saved work in different approved worktrees.
    // Probe this specific workflow id only, never aggregate unrelated stores.
    let found: { cwd: string; dir: string } | null = null;
    for (const candidate of [...await knownRoots()].sort().slice(0, 2048)) {
      try { found = { cwd: candidate, dir: await outputDirectory(candidate, workflowId) }; break; } catch { /* another project */ }
    }
    if (!found) throw new Error('Output workflow directory is unavailable.');
    bound = { ok: true, cwd: found.cwd }; dir = found.dir;
  }
  let producer = live?.config.name || workflowId.slice(0, 8);
  try {
    const metaFile = path.join(dir, 'meta.json');
    if (realpathSync(metaFile) !== metaFile || (await stat(metaFile)).size > 1024 * 1024) throw new Error();
    const meta = JSON.parse(await readFile(metaFile, 'utf8'));
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error();
    if (meta.incognito || meta.voiceOperator || meta.config?.incognito || meta.config?.voiceOperator) throw new Error('private');
    producer = live?.config.name || (typeof meta.name === 'string' ? meta.name : typeof meta.config?.name === 'string' ? meta.config.name : '') || producer;
  } catch (err) {
    if ((err as Error).message === 'private') throw new Error('This workflow does not publish Outputs.');
    if (!live) throw new Error('Saved workflow metadata is unavailable. Outputs were not published.');
  }
  return { cwd: bound.cwd, workflowId, producer };
}
export async function outputRoots(cwd: string): Promise<string[]> {
  const settings = await readSettings();
  return [cwd, ...await knownRoots(), ...(settings.mediaUnconfined ? settings.mediaAllowedRoots ?? [] : [])];
}
function assertOutputSpelling(ctx: OutputContext, target: string): void {
  assertSafePath(target);
  const parts = path.resolve(target).split(path.sep).map(part => part.toLowerCase());
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '.arco' && parts[i + 1] === 'workflows' && parts[i + 2] !== ctx.workflowId.toLowerCase()) throw new Error('Outputs cannot read another workflow artifact store.');
    if (parts[i] === '.arco' && ['chats', 'genesis'].includes(parts[i + 1]) && !isPathWithin(path.resolve(ctx.cwd), target)) throw new Error('Outputs cannot read another conversation store.');
  }
}
async function safeOutputFile(ctx: OutputContext, file: string, approved?: string[]): Promise<string> {
  const abs = path.resolve(ctx.cwd, file);
  if (hiddenOutput(abs.replace(ctx.cwd, ''))) throw new Error('This file is not a published output.');
  assertOutputSpelling(ctx, abs);
  const real = confinedPath(abs, approved ?? await outputRoots(ctx.cwd));
  assertOutputSpelling(ctx, real);
  if (hiddenOutput(real.replace(ctx.cwd, ''))) throw new Error('This file is not a published output.');
  return real;
}
export async function resolveTrackedOutput(cwd: string, workflowId: string, requested: string): Promise<string | null> {
  const ctx = await outputContext(cwd, workflowId);
  const mapped = await mappedOutputPath(ctx.cwd, workflowId, requested);
  return mapped ? safeOutputFile(ctx, mapped) : null;
}

// Exact generated-file forms only. Changed project files are not an output source.
export function outputEventPaths(message: Record<string, unknown>, cwd: string, artifactRoot: string): Array<{ path?: string; title?: string; key?: string; inline?: StoredOutput['inline']; source: string; inputPath?: string }> {
  if (message.type === 'output_saved' && typeof message.path === 'string') return [{ path: path.resolve(cwd, message.path), source: 'editor export', inputPath: typeof message.sourcePath === 'string' ? message.sourcePath : undefined }];
  if (message.type === 'primary_artifact') {
    if (!['image', 'code', 'text', 'diff'].includes(String(message.kind))) return [];
    const title = typeof message.title === 'string' ? message.title : undefined;
    if (typeof message.path === 'string' && message.path) return [{ path: path.resolve(cwd, message.path), title, source: 'artifact event' }];
    if (typeof message.content === 'string' && message.content.length <= 2 * 1024 * 1024) return [{ title, key: String(message.artifactId || message.seq || idFor(message.content)), inline: { content: message.content, ...(typeof message.language === 'string' ? { language: message.language } : {}) }, source: 'inline artifact' }];
  }
  if ((message.type === 'media_op_result' || message.type === 'media_stems_result') && message.ok) {
    const files = Array.isArray(message.outputPaths) ? message.outputPaths : typeof message.outputPath === 'string' ? [message.outputPath] : [];
    if (files.length) return files.filter((p): p is string => typeof p === 'string').slice(0, LIMIT).map(p => ({ path: path.resolve(cwd, p), source: 'media export', inputPath: typeof message.sourcePath === 'string' ? message.sourcePath : undefined }));
  }
  const match = matchFileEvent(message as unknown as ServerMessage);
  if (match && match.tool !== 'stems') return [{ path: path.resolve(match.scope === 'artifact' ? artifactRoot : cwd, match.rel), source: match.tool }];
  return [];
}

async function reconcile(ctx: OutputContext, index: OutputIndex): Promise<void> {
  const dir = await outputDirectory(ctx.cwd, ctx.workflowId);
  const root = path.join(dir, 'artifacts');
  const approved = await outputRoots(ctx.cwd);
  const record = async (file: string, title?: string, source = 'workflow artifacts', timestamp = Date.now(), inputPath?: string) => {
    let absolute = path.resolve(file);
    if (hiddenOutput(path.relative(ctx.cwd, absolute))) return;
    try { assertOutputSpelling(ctx, absolute); } catch { return; }
    // Missing known outputs retain provenance; unknown missing event paths must
    // still spell an authorized project before they enter the index.
    if (!approved.some(r => isPathWithin(path.resolve(r), absolute))) return;
    try { absolute = confinedPath(absolute, approved); assertOutputSpelling(ctx, absolute); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return; }
    const old = index.entries.find(e => e.path === absolute || e.originPath === absolute || e.aliases?.includes(absolute));
    let input: string | undefined;
    if (inputPath) { try { input = await safeOutputFile(ctx, inputPath, approved); } catch { /* unavailable input */ } }
    const parent = input ? index.entries.find(e => e.path === input || e.aliases?.includes(input!)) : undefined;
    if (old) { if (title && old.path === absolute) old.title = title; if (input && input !== absolute) { old.inputPath = input; if (parent) old.derivedFrom = parent.id; } return; }
    if (index.entries.length >= LIMIT) return;
    index.entries.push({ ...ctx, id: idFor(absolute), path: absolute, originPath: absolute, title: title || path.basename(absolute), name: path.basename(absolute), category: outputCategory(absolute), source, createdAt: timestamp, updatedAt: timestamp, ...(input && input !== absolute ? { inputPath: input, ...(parent ? { derivedFrom: parent.id } : {}) } : {}) });
  };
  const walk = async (folder: string, depth = 0) => {
    if (depth > 8 || index.entries.length >= LIMIT) return;
    try {
      const entries = await readdir(folder, { withFileTypes: true });
      for (const entry of entries.slice(0, LIMIT)) {
        if (entry.name.startsWith('.') || entry.name === 'raw-tools') continue;
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) await walk(file, depth + 1);
        else if (entry.isFile()) { const info = await stat(file); await record(file, undefined, 'workflow artifacts', info.birthtimeMs || info.mtimeMs); }
      }
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  };
  await walk(root);
  const events = path.join(dir, 'events.jsonl');
  let info;
  try { info = await lstat(events); } catch { return; }
  if (!info.isFile() || info.isSymbolicLink()) return;
  if (index.offset > info.size) index.offset = 0;
  const start = index.offset;
  if (start === info.size) return;
  // Resume through large histories in bounded chunks. Complete newline-delimited
  // events only; an in-progress writer's tail is read on the next refresh.
  const stream = createReadStream(events, { start, end: Math.min(info.size - 1, start + 32 * 1024 * 1024 - 1) });
  let consumed = 0, readBytes = 0, lineBytes = 0;
  let pending: Buffer[] = [], oversized = false;
  try {
    for await (const chunk of stream) {
      const bytes = chunk as Buffer;
      readBytes += bytes.length;
      let segment = 0;
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] !== 10) continue;
        const part = bytes.subarray(segment, i);
        lineBytes += part.length + 1;
        if (!oversized) pending.push(part);
        if (!oversized && lineBytes <= 2 * 1024 * 1024) {
          let event: Record<string, unknown> | null = null;
          try { event = JSON.parse(Buffer.concat(pending).toString('utf8')); } catch { /* malformed event */ }
          if (event) {
            const timestamp = typeof event.ts === 'number' ? event.ts : info.mtimeMs;
            for (const output of outputEventPaths(event, ctx.cwd, root)) {
              if (output.path) await record(output.path, output.title, output.source, timestamp, output.inputPath);
              else if (output.inline && !index.entries.some(e => e.id === idFor(`inline:${output.key}`)) && index.entries.length < LIMIT) index.entries.push({ ...ctx, id: idFor(`inline:${output.key}`), title: output.title || 'Inline artifact', name: output.title || 'Inline artifact', category: 'documents', createdAt: timestamp, updatedAt: timestamp, inline: output.inline, source: output.source });
            }
          }
        }
        consumed += lineBytes;
        pending = []; oversized = false; lineBytes = 0; segment = i + 1;
      }
      const tail = bytes.subarray(segment);
      lineBytes += tail.length;
      if (!oversized) pending.push(tail);
      if (lineBytes > 2 * 1024 * 1024) { pending = []; oversized = true; }
      if (readBytes >= 32 * 1024 * 1024) break;
    }
  } finally { stream.destroy(); }
  index.offset = start + consumed;
}

export async function listOutputs(ctx: OutputContext): Promise<WorkflowOutput[]> {
  return withFileLock(path.join(await outputDirectory(ctx.cwd, ctx.workflowId), 'outputs.json'), async () => {
    const index = await readOutputIndex(ctx.cwd, ctx.workflowId);
    const before = JSON.stringify(index);
    await reconcile(ctx, index);
    const approved = await outputRoots(ctx.cwd);
    const out: WorkflowOutput[] = [];
    for (const entry of index.entries) {
      if (entry.inline) { out.push({ ...entry, ...ctx, missing: false }); continue; }
      try {
        const file = await safeOutputFile(ctx, entry.path || '', approved);
        const info = await stat(file);
        entry.updatedAt = info.mtimeMs; entry.name = path.basename(file); entry.category = outputCategory(file);
        out.push({ ...entry, ...ctx, size: info.size, missing: false });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') out.push({ ...entry, ...ctx, missing: true });
      }
    }
    if (JSON.stringify(index) !== before) await writeOutputIndex(ctx.cwd, ctx.workflowId, index);
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  });
}
export async function readOutput(ctx: OutputContext, id: string): Promise<{ entry: StoredOutput; file: string }> {
  const index = await readOutputIndex(ctx.cwd, ctx.workflowId);
  const entry = index.entries.find(e => e.id === id);
  if (!entry?.path) throw new Error('Output file is unavailable.');
  return { entry, file: await safeOutputFile(ctx, entry.path) };
}
export async function trackOutputFile(ctx: OutputContext, file: string, derivedFrom?: string, inputPath?: string): Promise<void> {
  const absolute = await safeOutputFile(ctx, file);
  const info = await stat(absolute);
  await withFileLock(path.join(await outputDirectory(ctx.cwd, ctx.workflowId), 'outputs.json'), async () => {
    const index = await readOutputIndex(ctx.cwd, ctx.workflowId);
    const existing = index.entries.find(e => e.path === absolute);
    if (existing) { existing.updatedAt = info.mtimeMs; if (inputPath && inputPath !== absolute) existing.inputPath = inputPath; if (derivedFrom && derivedFrom !== existing.id) existing.derivedFrom = derivedFrom; }
    else if (index.entries.length < LIMIT) index.entries.push({ ...ctx, id: idFor(absolute), path: absolute, originPath: absolute, title: path.basename(absolute), name: path.basename(absolute), category: outputCategory(absolute), source: 'editor export', createdAt: info.birthtimeMs || info.mtimeMs, updatedAt: info.mtimeMs, ...(derivedFrom ? { derivedFrom } : {}), ...(inputPath && inputPath !== absolute ? { inputPath } : {}) });
    await writeOutputIndex(ctx.cwd, ctx.workflowId, index);
  });
}
async function copyOutputBytes(source: string, target: string): Promise<void> {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const info = await input.stat();
    if (!info.isFile()) throw new Error('Output source is not a regular file.');
    output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    if (info.size) await pipeline(createReadStream('', { fd: input.fd, autoClose: false, emitClose: false, start: 0, end: info.size - 1 }), createWriteStream('', { fd: output.fd, autoClose: false, emitClose: false }));
    await output.sync();
  } catch (err) {
    if (output) { await output.close().catch(() => {}); output = undefined; await unlink(target).catch(() => {}); }
    throw err;
  } finally { await output?.close(); await input.close(); }
}
export async function transferOutput(ctx: OutputContext, id: string, destination: string, move: boolean, writeIndex = writeOutputIndex, expectedSource?: string): Promise<void> {
  await withFileLock(path.join(await outputDirectory(ctx.cwd, ctx.workflowId), 'outputs.json'), async () => {
    const index = await readOutputIndex(ctx.cwd, ctx.workflowId);
    const entry = index.entries.find(e => e.id === id);
    if (!entry || (!entry.path && !entry.inline) || (move && !entry.path)) throw new Error('Only an existing file can be moved.');
    if ((!move && index.entries.length >= LIMIT) || (move && (entry.aliases?.length ?? 0) >= 128)) throw new Error('This workflow has reached its output metadata limit.');
    if (expectedSource && entry.path && path.resolve(ctx.cwd, expectedSource) !== path.resolve(entry.path)) throw new Error('The output moved since this dialog opened. Refresh before retrying.');
    const source = entry.path ? await safeOutputFile(ctx, entry.path) : '';
    if (!path.isAbsolute(destination) || destination.includes('\0')) throw new Error('Choose an absolute destination filename.');
    assertOutputSpelling(ctx, destination);
    const parent = confinedPath(path.dirname(destination), await outputRoots(ctx.cwd), 'directory');
    const target = path.join(parent, path.basename(destination));
    assertOutputSpelling(ctx, target);
    if (hiddenOutput(path.relative(ctx.cwd, target))) throw new Error('Choose a visible output filename and folder.');
    if (target === source) throw new Error('Choose a different destination.');
    // Exclusive destination creation refuses existing files and dangling links;
    // a no-follow source handle prevents final-component link swaps.
    if (entry.inline) await writeFile(target, entry.inline.content, { flag: 'wx' });
    else await copyOutputBytes(source, target);
    const old = JSON.parse(JSON.stringify(index)) as OutputIndex;
    if (move) {
      entry.aliases = [...new Set([...(entry.aliases ?? []), entry.path!])];
      entry.actions = [...(entry.actions ?? []), { action: 'move', from: source, to: target, at: Date.now() }];
      entry.path = target; entry.name = path.basename(target); entry.updatedAt = Date.now();
    } else index.entries.push({ ...entry, inline: undefined, category: outputCategory(target), id: idFor(randomUUID()), path: target, originPath: target, aliases: [], derivedFrom: entry.id, title: path.basename(target), name: path.basename(target), source: 'saved copy', actions: [{ action: 'copy', from: source, to: target, at: Date.now() }], createdAt: Date.now(), updatedAt: Date.now() });
    try { await writeIndex(ctx.cwd, ctx.workflowId, index); } catch (err) { await unlink(target).catch(() => {}); throw new Error('Output location was not saved. The source remains intact.'); }
    if (move) {
      try { await unlink(source); } catch (err) {
        await writeIndex(ctx.cwd, ctx.workflowId, old);
        await unlink(target).catch(() => {});
        throw new Error('The source could not be removed. It remains at its original location.');
      }
    }
  });
}
export async function outputDestination(ctx: OutputContext, destination: string): Promise<string> {
  const target = path.resolve(ctx.cwd, destination);
  assertOutputSpelling(ctx, target);
  const roots = await outputRoots(ctx.cwd);
  try { return confinedPath(target, roots); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  return path.join(confinedPath(path.dirname(target), roots, 'directory'), path.basename(target));
}
export async function trackEditorOutput(cwd: string, workflowId: string, file: string, sourcePath?: string): Promise<void> {
  const ctx = await outputContext(cwd, workflowId);
  const index = await readOutputIndex(ctx.cwd, workflowId);
  const source = sourcePath ? index.entries.find(e => e.path === path.resolve(cwd, sourcePath) || e.aliases?.includes(path.resolve(cwd, sourcePath))) : undefined;
  const input = source?.path || (sourcePath ? await safeOutputFile(ctx, sourcePath).catch(() => undefined) : undefined);
  await trackOutputFile(ctx, file, source?.id, input);
}

export async function saveOutputText(ctx: OutputContext, id: string, content: string): Promise<void> {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('Text output exceeds the edit limit.');
  await withFileLock(path.join(await outputDirectory(ctx.cwd, ctx.workflowId), 'outputs.json'), async () => {
    const index = await readOutputIndex(ctx.cwd, ctx.workflowId);
    const entry = index.entries.find(e => e.id === id);
    if (!entry?.path) throw new Error('Output file is unavailable.');
    const file = await safeOutputFile(ctx, entry.path);
    await atomicWriteFile(file, content); entry.updatedAt = Date.now();
    await writeOutputIndex(ctx.cwd, ctx.workflowId, index);
  });
}
