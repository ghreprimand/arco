// Quick research promotion: a persistent request waits for idle workflows,
// copies the managed workspace, then rebinds it under a recovery journal.
import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { atomicWriteFile, withFileLock } from '../atomicFile.js';
import { arcoHome } from '../arcoHome.js';
import { safeDirectory, isPathWithin } from '../fileAccessPolicy.js';
import { readSettings, patchSettings, acquireProjectSettingsWatcher, releaseProjectSettingsWatcher } from '../settings.js';
import { clusterDir, loadAllClustersFromDisk, readCluster, rebindResearchCwd } from '../clusterStore.js';
import { buildClusterStatePayload, broadcastCluster, broadcastWorkflow, acquirePlansWatcher, releasePlansWatcher } from '../server/broadcast.js';
import { workflowCwds, workflows } from '../server/state.js';
import { workspaceRebindWorkflow } from '../workspace.js';
import { rememberCwd } from '../crashRecovery.js';
import { updateMeta } from '../workflowMeta.js';
import { flushWorkflowBuffer, forgetWorkflowBuffer, initWorkflowStore } from '../workflowStore.js';
import { createResearchFolder, writeProjectFiles } from './researchFolder.js';
import { addToLibrary } from './researchLibrary.js';
import { loadResearch, updateResearch } from './researchState.js';

export interface QuickPromotionJournal {
  clusterId: string;
  projectId: string;
  directorWorkflowId: string;
  source: string;
  root: string;
  target?: string;
  phase: 'waiting' | 'copying' | 'switching' | 'done' | 'error';
  message?: string;
}
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const running = new Set<string>();
export interface ActivePromotion { controller: AbortController; settled: Promise<boolean>; finish: (ready: boolean) => void }
const activeDirectors = new Map<string, ActivePromotion>();
export function hasQuickPromotion(workflowId: string): boolean { return activeDirectors.has(workflowId); }

export function beginQuickPromotion(workflowId: string): ActivePromotion {
  let finish!: (ready: boolean) => void;
  const settled = new Promise<boolean>(resolve => { finish = resolve; });
  const active = { controller: new AbortController(), settled, finish };
  activeDirectors.set(workflowId, active);
  return active;
}

export function finishQuickPromotion(workflowId: string, active: ActivePromotion, ready: boolean): void {
  if (activeDirectors.get(workflowId) === active) activeDirectors.delete(workflowId);
  active.finish(ready);
}

// A follow-up takes priority over a copy. The message handler waits until the
// original workspace is restored and the migration reservation is released.
export async function yieldQuickPromotionToMessage(workflowId: string): Promise<boolean> {
  const active = activeDirectors.get(workflowId);
  if (!active) return false;
  active.controller.abort();
  return active.settled;
}

const journalPath = (clusterId: string) => join(clusterDir(clusterId), 'quick-promotion.json');
const copyFailureMessage = (target?: string) => target ? `The copy did not complete. Quick research is still available; the incomplete copy remains at ${target}.` : 'The copy did not complete. Quick research is still available.';
const save = (journal: QuickPromotionJournal) => atomicWriteFile(journalPath(journal.clusterId), JSON.stringify(journal, null, 2) + '\n', { mode: 0o600 });

export async function readQuickPromotion(clusterId: string): Promise<QuickPromotionJournal | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(journalPath(clusterId), 'utf8')) as QuickPromotionJournal;
    const expectedSource = join(await fs.realpath(arcoHome()), 'chat-workspaces', parsed.projectId ?? '');
    if (parsed.clusterId !== clusterId || !/^[0-9a-f-]{36}$/i.test(parsed.projectId ?? '') || resolve(parsed.source ?? '') !== resolve(expectedSource) || !isAbsolute(parsed.root ?? '') || (parsed.target && (!isAbsolute(parsed.target) || !isPathWithin(parsed.root, parsed.target) || resolve(parsed.target) === resolve(parsed.root))) || (['copying', 'switching', 'done'].includes(parsed.phase) && !parsed.target) || !['waiting', 'copying', 'switching', 'done', 'error'].includes(parsed.phase)) throw new Error('Invalid promotion journal.');
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function schedule(clusterId: string): void {
  if (timers.has(clusterId)) return;
  const timer = setTimeout(() => { timers.delete(clusterId); void attemptQuickPromotion(clusterId); }, 1000);
  timer.unref(); timers.set(clusterId, timer);
}

export class QuickPromotionFolderMissingError extends Error {}

export async function resolveQuickPromotionRoot(source: string, folderRoot?: string): Promise<string> {
  const settings = await readSettings();
  const selected = folderRoot?.trim();
  const requested = selected || settings.researchFolder;
  if (!requested || !isAbsolute(requested)) throw new Error('Choose a research folder.');

  let root: string;
  try {
    root = safeDirectory(requested);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new QuickPromotionFolderMissingError(selected
      ? 'The folder you chose is gone. Choose another folder.'
      : 'The saved research folder is gone. Choose a new folder to keep this research.');
  }

  if (isPathWithin(source, root) || isPathWithin(root, source)) throw new Error('Choose a research folder outside the Quick research workspace.');
  if (selected && root !== settings.researchFolder) await patchSettings({ researchFolder: root });
  return root;
}

export async function requestQuickPromotion(clusterId: string, folderRoot?: string): Promise<QuickPromotionJournal> {
  return withFileLock(journalPath(clusterId), async () => {
    const current = await readQuickPromotion(clusterId);
    if (current && ['waiting', 'copying', 'switching', 'done'].includes(current.phase)) return current;
    const state = await loadResearch(clusterId);
    if (!state?.quick || state.closedAt) throw new Error('This is not an open Quick research.');
    if (!/^[0-9a-f-]{36}$/i.test(state.projectId) || resolve(state.folder) !== resolve(join(await fs.realpath(arcoHome()), 'chat-workspaces', state.projectId)) || (await fs.lstat(state.folder)).isSymbolicLink()) throw new Error('The Quick research workspace is unavailable.');
    const root = await resolveQuickPromotionRoot(state.folder, folderRoot);
    const journal: QuickPromotionJournal = { clusterId, projectId: state.projectId, directorWorkflowId: state.directorWorkflowId, source: state.folder, root, phase: 'waiting' };
    await save(journal); schedule(clusterId); return journal;
  });
}

function rebindLiveDirector(workflowId: string, cwd: string): void {
  const previous = workflowCwds.get(workflowId);
  const wf = workflows.get(workflowId);
  if (previous && previous !== cwd) {
    releaseProjectSettingsWatcher(previous);
    acquireProjectSettingsWatcher(cwd);
    if (wf?.planId) { releasePlansWatcher(previous); acquirePlansWatcher(cwd); }
  }
  workflowCwds.set(workflowId, cwd);
  workspaceRebindWorkflow(workflowId, cwd);
  if (wf) wf.config.workingDirectory = cwd;
}

async function restoreSource(journal: QuickPromotionJournal): Promise<void> {
  const state = await loadResearch(journal.clusterId);
  if (!state || state.projectId !== journal.projectId) throw new Error('The Quick research record changed.');
  const cluster = await readCluster(journal.clusterId);
  if (!cluster) throw new Error('The research cluster is unavailable.');
  if (journal.target && cluster.cwd === journal.target && !await rebindResearchCwd(journal.clusterId, journal.target, journal.source)) throw new Error('Could not restore the research folder.');
  if (cluster.cwd !== journal.source && cluster.cwd !== journal.target) throw new Error('The research cluster folder changed.');
  const restored = await updateResearch(journal.clusterId, current => { current.folder = journal.source; current.quick = true; });
  if (!restored || restored.folder !== journal.source || !restored.quick) throw new Error('Could not restore the Quick research record.');
  await addToLibrary({ projectId: state.projectId, folder: journal.source, name: state.name, createdAt: state.createdAt }).catch(error => console.warn('[arco] Could not restore the research library:', error));
  rebindLiveDirector(journal.directorWorkflowId, journal.source);
  const wf = workflows.get(journal.directorWorkflowId);
  if (wf) { broadcastWorkflow(journal.directorWorkflowId, { type: 'workflow_config_synced', workflowId: journal.directorWorkflowId, config: wf.config }); }
  if (journal.target) forgetWorkflowBuffer(journal.target, journal.directorWorkflowId);
}

// An interrupted switch is rolled back to the intact source. A completed
// journal is not rolled back, so a confirmed promotion survives restart.
export async function recoverQuickPromotion(journal: QuickPromotionJournal): Promise<QuickPromotionJournal> {
  if (journal.phase === 'switching') await restoreSource(journal);
  if (journal.phase === 'done') {
    const state = await loadResearch(journal.clusterId);
    const cluster = await readCluster(journal.clusterId);
    if (!journal.target || state?.folder !== journal.target || cluster?.cwd !== journal.target) {
      await restoreSource(journal);
      journal = { ...journal, phase: 'error', message: copyFailureMessage(journal.target) };
      await save(journal);
    } else {
      rebindLiveDirector(journal.directorWorkflowId, journal.target);
      await rememberCwd(journal.target);
      await cleanupPromotedSource(journal);
    }
  }
  if (journal.phase === 'copying' || journal.phase === 'switching') {
    journal = { ...journal, phase: 'error', message: copyFailureMessage(journal.target) };
    await save(journal);
  }
  return journal;
}

async function cleanupPromotedSource(journal: QuickPromotionJournal): Promise<void> {
  try { await (await import('./quickResearchChat.js')).removeQuickWorkspace(journal.projectId, journal.source); }
  catch (error) {
    const content = `The project was kept, but the original Quick research folder could not be removed: ${journal.source}.`;
    console.warn('[arco] Quick research source cleanup failed:', error);
    broadcastWorkflow(journal.directorWorkflowId, { type: 'system_notice', workflowId: journal.directorWorkflowId, content });
    await save({ ...journal, message: content }).catch(() => undefined);
  }
}

export function stopQuickPromotionTimer(clusterId: string): boolean {
  const timer = timers.get(clusterId);
  if (timer) { clearTimeout(timer); timers.delete(clusterId); }
  return running.has(clusterId);
}

export async function cancelQuickPromotion(clusterId: string): Promise<void> {
  const current = await readQuickPromotion(clusterId);
  if (current) await yieldQuickPromotionToMessage(current.directorWorkflowId);
  stopQuickPromotionTimer(clusterId);
  await withFileLock(journalPath(clusterId), async () => {
    const journal = await readQuickPromotion(clusterId);
    if (journal?.phase === 'waiting') await save({ ...journal, phase: 'error', message: 'Keeping this project was cancelled.' });
  });
}

export async function copyWorkspace(source: string, target: string, signal: AbortSignal): Promise<void> {
  async function copyDirectory(from: string, to: string): Promise<void> {
    const destination = await fs.lstat(to);
    if (!destination.isDirectory() || destination.isSymbolicLink()) throw new Error('The destination folder changed.');
    for (const entry of await fs.readdir(from, { withFileTypes: true })) {
      signal.throwIfAborted();
      const src = join(from, entry.name), dst = join(to, entry.name);
      const info = await fs.lstat(src);
      if (info.isSymbolicLink()) throw new Error('The Quick research workspace contains a link.');
      if (info.isDirectory()) {
        try { await fs.mkdir(dst, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        await copyDirectory(src, dst);
      } else if (info.isFile()) {
        const input = await fs.open(src, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        let output: Awaited<ReturnType<typeof fs.open>> | undefined;
        try {
          const before = await input.stat();
          if (!before.isFile() || before.nlink !== 1) throw new Error('A workspace file is not a regular file.');
          output = await fs.open(dst, 'wx', before.mode & 0o777);
          const buffer = Buffer.allocUnsafe(64 * 1024);
          for (let offset = 0; offset < before.size;) {
            signal.throwIfAborted();
            const read = await input.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
            if (!read.bytesRead) throw new Error('A workspace file changed during copying.');
            for (let written = 0; written < read.bytesRead;) {
              const result = await output.write(buffer, written, read.bytesRead - written, offset + written);
              if (!result.bytesWritten) throw new Error('A workspace file could not be copied.');
              written += result.bytesWritten;
            }
            offset += read.bytesRead;
          }
          const after = await input.stat();
          if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('A workspace file changed during copying.');
          await output.sync();
        } finally {
          try { await output?.close(); } finally { await input.close().catch(() => undefined); }
        }
      } else throw new Error('The Quick research workspace contains a special file.');
    }
  }
  await copyDirectory(source, target);
}

export async function attemptQuickPromotion(clusterId: string): Promise<void> {
  if (running.has(clusterId)) return;
  running.add(clusterId);
  const releases: Array<() => void> = [];
  let retry = false;
  let active: ActivePromotion | undefined;
  let ready = true;
  try {
    await withFileLock(journalPath(clusterId), async () => {
      let journal = await readQuickPromotion(clusterId);
      if (!journal || journal.phase !== 'waiting') return;
      const state = await loadResearch(clusterId);
      if (!state?.quick || state.closedAt || state.projectId !== journal.projectId) throw new Error('The Quick research has closed or changed.');
      // Do not reserve the Director while a researcher is still working:
      // follow-up messages remain available throughout the waiting period.
      const ids = [...state.researchers.filter(r => !r.removedAt).map(r => r.workflowId), state.directorWorkflowId];
      if (ids.some(id => !workflows.get(id) || workflows.get(id)?.busy)) { retry = true; return; }
      const { reserveWorkflowMigration } = await import('../ws/turnEngine.js');
      for (const id of ids) {
        const wf = workflows.get(id);
        if (!wf) { retry = true; return; }
        try { releases.push(reserveWorkflowMigration(wf)); }
        catch { retry = true; return; }
      }
      active = beginQuickPromotion(state.directorWorkflowId);
      const signal = active.controller.signal;
      if (safeDirectory(journal.root) !== journal.root || await fs.realpath(journal.source) !== journal.source || (await fs.lstat(journal.source)).isSymbolicLink()) throw new Error('A research folder changed while waiting.');
      signal.throwIfAborted();
      await flushWorkflowBuffer(journal.source, state.directorWorkflowId);
      signal.throwIfAborted();
      const target = await createResearchFolder(journal.root, state.name, new Date());
      journal = { ...journal, target, phase: 'copying' }; await save(journal);
      signal.throwIfAborted();
      await copyWorkspace(journal.source, target, signal);
      signal.throwIfAborted();
      if (!await updateMeta(target, state.directorWorkflowId, meta => { meta.cwd = target; })) throw new Error('The Director conversation is missing.');
      journal = { ...journal, phase: 'switching' }; await save(journal);
      signal.throwIfAborted();
      if (!await rebindResearchCwd(clusterId, journal.source, target)) throw new Error('The research cluster changed.');
      signal.throwIfAborted();
      const updated = await updateResearch(clusterId, current => { if (!current.quick || current.folder !== journal!.source) return false; current.folder = target; delete current.quick; });
      if (!updated || updated.folder !== target || updated.quick) throw new Error('The research state changed.');
      signal.throwIfAborted();
      await writeProjectFiles(updated);
      await addToLibrary({ projectId: updated.projectId, folder: target, name: updated.name, createdAt: updated.createdAt });
      signal.throwIfAborted();
      const wf = workflows.get(state.directorWorkflowId);
      if (!wf) throw new Error('The Research Director is unavailable.');
      rebindLiveDirector(state.directorWorkflowId, target);
      await initWorkflowStore(target, state.directorWorkflowId);
      if (wf.primary.provider === 'codex') await (await import('../providers/codex-appserver/index.js')).releaseCodexAppServerWorker(state.directorWorkflowId);
      if (wf.primary.provider === 'cursor') (await import('../providers/cursor/index.js')).disposeCursorWorker(state.directorWorkflowId);
      signal.throwIfAborted();
      journal = { ...journal, phase: 'done', message: 'Quick research is now a project.' }; await save(journal);
      void rememberCwd(target).catch(error => console.warn('[arco] Could not remember the research folder:', error));
      forgetWorkflowBuffer(journal.source, state.directorWorkflowId);
      await cleanupPromotedSource(journal);
      try {
        broadcastWorkflow(state.directorWorkflowId, { type: 'workflow_config_synced', workflowId: state.directorWorkflowId, config: wf.config });
        const payload = await buildClusterStatePayload(clusterId); if (payload) broadcastCluster(clusterId, { type: 'cluster_state', clusterId, state: payload });
      } catch (error) { console.warn('[arco] Quick research promotion notification failed:', error); }
    });
  } catch (error) {
    const interrupted = active?.controller.signal.aborted === true;
    if (!interrupted) console.warn('[arco] Quick research promotion failed:', error);
    try {
      let journal = await readQuickPromotion(clusterId);
      if (journal) {
        if (journal.phase === 'switching') await restoreSource(journal);
        if (interrupted) {
          const previousTarget = journal.target;
          journal = { ...journal, phase: 'waiting', target: undefined,
            message: previousTarget ? `A partial copy remains at ${previousTarget}; the follow-up runs before another copy.` : undefined };
          if (previousTarget) broadcastWorkflow(journal.directorWorkflowId, { type: 'system_notice', workflowId: journal.directorWorkflowId, content: `The interrupted copy remains at ${previousTarget}.` });
          retry = true;
        } else journal = { ...journal, phase: 'error', message: copyFailureMessage(journal.target) };
        await save(journal);
      }
    } catch (restoreError) {
      ready = false;
      console.error('[arco] Quick research promotion recovery failed:', restoreError);
    }
  } finally {
    for (const release of releases.reverse()) release();
    running.delete(clusterId);
    if (active) {
      for (const [id, current] of activeDirectors) if (current === active) finishQuickPromotion(id, active, ready);
    }
    if (retry) schedule(clusterId);
  }
}

// Called after workflow recovery. A waiting request can continue; an
// interrupted copy or switch restores Quick research and reports the failure.
export async function resumeQuickPromotions(): Promise<void> {
  for (const cluster of await loadAllClustersFromDisk()) {
    if (!cluster.research) continue;
    try {
      const journal = await readQuickPromotion(cluster.clusterId);
      if (!journal) continue;
      const recovered = await recoverQuickPromotion(journal);
      if (recovered.phase === 'waiting') schedule(cluster.clusterId);
    } catch (error) { console.error('[arco] Quick research promotion recovery failed:', error); }
  }
}
