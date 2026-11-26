// Keep a closed Quick research as a project without discarding its saved Chat.
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { atomicWriteFile, withFileLock } from '../atomicFile.js';
import { arcoHome } from '../arcoHome.js';
import { antigravityChatWorkspace, chatStorageDir } from '../chatMode.js';
import { readLogLines } from '../eventLog.js';
import { isPathWithin, safeDirectory } from '../fileAccessPolicy.js';
import { workflows } from '../server/state.js';
import { flushWorkflowBuffer } from '../workflowStore.js';
import { createResearchFolder, writeProjectFiles } from './researchFolder.js';
import { closedResearchRecordPath } from './researchClose.js';
import { addToLibrary, readClosedRecord } from './researchLibrary.js';
import { beginQuickPromotion, copyWorkspace, finishQuickPromotion, resolveQuickPromotionRoot, yieldQuickPromotionToMessage, type ActivePromotion } from './quickPromotion.js';

interface Journal { projectId: string; source: string; root: string; target?: string; phase: 'waiting' | 'copying' | 'switching' | 'done' | 'error'; message?: string }
const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const pathFor = (id: string) => join(arcoHome(), 'research', 'closed-promotions', `${id}.json`);
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const running = new Set<string>();
async function save(journal: Journal): Promise<void> {
  await fs.mkdir(dirname(pathFor(journal.projectId)), { recursive: true, mode: 0o700 });
  await atomicWriteFile(pathFor(journal.projectId), JSON.stringify(journal, null, 2) + '\n', { mode: 0o600 });
}
export async function readSavedQuickPromotion(id: string): Promise<Journal | null> {
  if (!validId(id)) throw new Error('Invalid Chat.');
  try {
    const j = JSON.parse(await fs.readFile(pathFor(id), 'utf8')) as Journal;
    if (j.projectId !== id || resolve(j.source) !== resolve(antigravityChatWorkspace(id)) || !isAbsolute(j.root) || (j.target && (!isAbsolute(j.target) || !isPathWithin(j.root, j.target) || resolve(j.target) === resolve(j.root))) || !['waiting', 'copying', 'switching', 'done', 'error'].includes(j.phase) || (['copying', 'switching', 'done'].includes(j.phase) && !j.target)) throw new Error('Invalid saved Quick research journal.');
    return j;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function savedRecord(id: string) {
  if (!validId(id)) return null;
  const marker = await fs.readFile(join(chatStorageDir(id), 'quick-research.json'), 'utf8').then(x => JSON.parse(x) as { projectId?: string }).catch(() => null);
  if (marker?.projectId !== id) return null;
  return readClosedRecord(id);
}
export async function savedQuickStatus(id: string): Promise<{ phase: string; message?: string } | null> {
  const state = await savedRecord(id);
  if (!state) return null;
  const j = await readSavedQuickPromotion(id);
  if (j && ['waiting', 'copying', 'switching'].includes(j.phase)) return { phase: j.phase, message: j.message };
  if (!state.quick) return { phase: 'done', message: `Quick research is now a project: ${state.folder}` };
  return j ? { phase: j.phase, message: j.message } : { phase: 'idle' };
}
function schedule(id: string) {
  if (timers.has(id)) return;
  const timer = setTimeout(() => { timers.delete(id); void attemptSavedQuickPromotion(id); }, 1000);
  timer.unref(); timers.set(id, timer);
}
export async function requestSavedQuickPromotion(id: string, folderRoot?: string): Promise<Journal> {
  return withFileLock(pathFor(id), async () => {
    const previous = await readSavedQuickPromotion(id);
    if (previous && ['waiting', 'copying', 'switching', 'done'].includes(previous.phase)) return previous;
    const state = await savedRecord(id);
    const source = antigravityChatWorkspace(id);
    if (!state?.quick || !state.closedAt || resolve(state.folder) !== resolve(source) || (await fs.lstat(source)).isSymbolicLink()) throw new Error('This saved Chat has no Quick research to keep.');
    const root = await resolveQuickPromotionRoot(source, folderRoot);
    const journal: Journal = { projectId: id, source, root, phase: 'waiting' };
    await save(journal); schedule(id); return journal;
  });
}
async function restore(j: Journal): Promise<void> {
  const state = await savedRecord(j.projectId);
  if (!state) throw new Error('The saved Chat or research record is missing.');
  if (state.folder !== j.source && state.folder !== j.target) throw new Error('The research record changed.');
  state.folder = j.source; state.quick = true; delete state.savedQuickChat;
  await atomicWriteFile(closedResearchRecordPath(j.projectId), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await addToLibrary({ projectId: state.projectId, folder: j.source, name: state.name, createdAt: state.createdAt });
}
// Copy the complete saved Chat transcript into the kept project as readable
// text. The original chat and its files remain owned by the saved Chat.
async function copyChat(id: string, target: string, signal: AbortSignal): Promise<void> {
  const cwd = chatStorageDir(id);
  await flushWorkflowBuffer(cwd, id);
  const output = await fs.open(join(target, 'saved-chat.md'), 'wx', 0o600);
  try {
    await output.writeFile('# Saved Quick research Chat\n\n');
    for await (const line of readLogLines(join(cwd, '.arco', 'workflows', id))) {
      signal.throwIfAborted();
      let event: { type?: string; content?: unknown; text?: unknown };
      try { event = JSON.parse(line) as typeof event; } catch { continue; }
      const text = event.type === 'user_message_echo' ? event.content : event.type === 'primary_text' ? event.text : undefined;
      if (typeof text === 'string') await output.writeFile(`${event.type === 'user_message_echo' ? '\nOperator: ' : ''}${text}\n`);
    }
  } finally { await output.close(); }
  const artifacts = join(cwd, '.arco', 'workflows', id, 'artifacts');
  const info = await fs.lstat(artifacts).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
  if (info) {
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The Chat attachments folder changed.');
    const dest = join(target, 'sources', 'saved-chat');
    await fs.mkdir(dest, { mode: 0o700 });
    await copyWorkspace(artifacts, dest, signal);
  }
}
export async function attemptSavedQuickPromotion(id: string): Promise<void> {
  if (running.has(id)) return;
  running.add(id);
  let active: ActivePromotion | undefined, release: (() => void) | undefined, retry = false, ready = true;
  try {
    await withFileLock(pathFor(id), async () => {
      let j = await readSavedQuickPromotion(id);
      if (!j || j.phase !== 'waiting') return;
      const state = await savedRecord(id);
      if (!state?.quick || resolve(state.folder) !== resolve(j.source)) throw new Error('The saved Quick research changed.');
      const wf = workflows.get(id);
      if (wf?.busy) { retry = true; return; }
      if (wf) { try { release = (await import('../ws/turnEngine.js')).reserveWorkflowMigration(wf); } catch { retry = true; return; } }
      active = beginQuickPromotion(id);
      const signal = active.controller.signal;
      if (safeDirectory(j.root) !== j.root || await fs.realpath(j.source) !== j.source || (await fs.lstat(j.source)).isSymbolicLink()) throw new Error('A research folder changed while waiting.');
      const target = await createResearchFolder(j.root, state.name, new Date());
      j = { ...j, target, phase: 'copying' }; await save(j);
      await copyWorkspace(j.source, target, signal);
      await copyChat(id, target, signal);
      signal.throwIfAborted();
      j = { ...j, phase: 'switching' }; await save(j);
      const updated = { ...state, folder: target, savedQuickChat: true }; delete updated.quick;
      await fs.appendFile(join(target, 'director-log.md'), '\nThe saved Quick research Chat, including later follow-ups, is in saved-chat.md.\n');
      await writeProjectFiles(updated);
      signal.throwIfAborted();
      await atomicWriteFile(closedResearchRecordPath(id), JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 });
      await addToLibrary({ projectId: id, folder: target, name: state.name, createdAt: state.createdAt });
      signal.throwIfAborted();
      await save({ ...j, phase: 'done', message: 'Quick research is now a project.' });
    });
  } catch (error) {
    const interrupted = active?.controller.signal.aborted === true;
    try {
      let j = await readSavedQuickPromotion(id);
      if (j) {
        if (j.phase === 'switching') await restore(j);
        const target = j.target;
        if (interrupted) { retry = true; j = { ...j, phase: 'waiting', target: undefined, message: target ? `A partial copy remains at ${target}; the follow-up runs before another copy.` : undefined }; }
        else j = { ...j, phase: 'error', message: target ? `The copy did not complete. The saved Chat is still available; the incomplete copy remains at ${target}.` : 'The copy did not complete. The saved Chat is still available.' };
        await save(j);
      }
    } catch (recoveryError) { ready = false; console.error('[arco] Saved Quick research recovery failed:', recoveryError); }
    if (!interrupted) console.warn('[arco] Saved Quick research promotion failed:', error);
  } finally {
    release?.(); running.delete(id);
    if (active) finishQuickPromotion(id, active, ready);
    if (retry) schedule(id);
  }
}
export async function cancelSavedQuickPromotion(id: string): Promise<void> {
  await yieldQuickPromotionToMessage(id);
  const timer = timers.get(id); if (timer) { clearTimeout(timer); timers.delete(id); }
  await withFileLock(pathFor(id), async () => { const j = await readSavedQuickPromotion(id); if (j?.phase === 'waiting') await save({ ...j, phase: 'error', message: 'Keeping this project was cancelled.' }); });
}
export async function removeSavedQuickPromotion(id: string): Promise<void> {
  if (!validId(id)) throw new Error('Invalid Chat.');
  await fs.rm(pathFor(id), { force: true });
}
export async function resumeSavedQuickPromotions(): Promise<void> {
  const names = await fs.readdir(join(arcoHome(), 'research', 'closed-promotions')).catch(() => [] as string[]);
  for (const name of names) {
    const id = name.endsWith('.json') ? name.slice(0, -5) : '';
    if (!validId(id)) continue;
    try {
      let j = await readSavedQuickPromotion(id); if (!j) continue;
      if (j.phase === 'switching') await restore(j);
      if (j.phase === 'switching' || j.phase === 'copying') { j = { ...j, phase: 'error', message: j.target ? `The copy did not complete. The saved Chat is still available; the incomplete copy remains at ${j.target}.` : 'The copy did not complete. The saved Chat is still available.' }; await save(j); }
      if (j.phase === 'waiting') schedule(id);
    } catch (error) { console.error('[arco] Saved Quick research recovery failed:', error); }
  }
}
