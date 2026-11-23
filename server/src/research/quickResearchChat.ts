// Preserve a closed Quick research answer as an ordinary saved Chat. The
// source research workspace remains intact until the operator promotes or
// removes it; a failed snapshot never removes researcher files.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { ServerMessage } from '@arco/shared';
import { withFileLock } from '../atomicFile.js';
import { antigravityChatWorkspace, chatRootDir, chatStorageDir } from '../chatMode.js';
import { readLogLines } from '../eventLog.js';
import { ensureStorageRoot } from '../storageRoot.js';
import { readMeta, persistInitialMeta, updateMeta, workflowConfigFromMeta } from '../workflowMeta.js';
import { flushWorkflowBuffer, forgetWorkflowBuffer, initWorkflowStore, persistAndStampSeq } from '../workflowStore.js';
import type { ResearchState } from './researchState.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function saveQuickResearchChat(state: ResearchState, moved: string[]): Promise<string> {
  if (!state.quick || !UUID.test(state.projectId)) throw new Error('Invalid Quick research record.');
  const chatId = state.projectId;
  const final = chatStorageDir(chatId);
  return withFileLock(final, async () => {
    const expected = [...moved].sort();
    const marker = join(final, 'quick-research.json');
    const existing = await fs.readFile(marker, 'utf8').then(text => JSON.parse(text) as { projectId?: string; files?: string[] }).catch(() => null);
    if (existing) {
      if (existing.projectId !== chatId || JSON.stringify(existing.files) !== JSON.stringify(expected)) throw new Error('The saved Quick research files changed. The researcher files remain available.');
      return chatId;
    }
    const sourceMeta = await readMeta(state.folder, state.directorWorkflowId);
    if (!sourceMeta) throw new Error('The Research Director conversation is missing.');
    await flushWorkflowBuffer(state.folder, state.directorWorkflowId);
    const root = await ensureStorageRoot(chatRootDir());
    const stage = await fs.mkdtemp(join(root, 'quick-save-'));
    let initialized = false;
    let reserved = false;
    try {
      await initWorkflowStore(stage, chatId); initialized = true;
      const config = { ...workflowConfigFromMeta(sourceMeta, final), name: state.name, kind: 'chat' as const, workingDirectory: final, incognito: false };
      await persistInitialMeta(stage, chatId, config, { provider: sourceMeta.primaryProvider, model: sourceMeta.primaryModel, effort: sourceMeta.primaryEffort });
      await updateMeta(stage, chatId, meta => { meta.cwd = final; meta.kind = 'chat'; meta.lastUserPreview = state.brief.replace(/\s+/g, ' ').trim().slice(0, 80); });
      let retained = 0;
      const log = join(state.folder, '.arco', 'workflows', state.directorWorkflowId);
      for await (const line of readLogLines(log)) {
        let event: ServerMessage;
        try { event = JSON.parse(line) as ServerMessage; } catch { continue; }
        if (event.type !== 'user_message_echo' && event.type !== 'primary_text' && event.type !== 'primary_complete') continue;
        persistAndStampSeq(stage, chatId, { ...event, workflowId: chatId } as ServerMessage);
        if (++retained % 100 === 0) await flushWorkflowBuffer(stage, chatId);
      }
      if (moved.length) {
        const artifacts = join(stage, '.arco', 'workflows', chatId, 'artifacts');
        const finalArtifacts = join(final, '.arco', 'workflows', chatId, 'artifacts');
        const attachments: string[] = [];
        for (const name of moved) {
          const file = basename(name);
          if (name !== `sources/${file}` || !file) throw new Error('Invalid researcher file name.');
          const storedName = `${randomUUID().slice(0, 8)}-${file}`;
          const target = join(artifacts, storedName);
          const sourcePath = join(state.folder, 'sources', file);
          if ((await fs.lstat(sourcePath)).isSymbolicLink()) throw new Error('A researcher file is a link.');
          const source = await fs.open(sourcePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
          let destination: Awaited<ReturnType<typeof fs.open>> | undefined;
          try {
            const stat = await source.stat();
            if (!stat.isFile() || stat.nlink !== 1) throw new Error('A researcher file is no longer a regular file.');
            destination = await fs.open(target, 'wx', 0o600);
            const buffer = Buffer.allocUnsafe(64 * 1024);
            for (let offset = 0; offset < stat.size;) {
              const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
              if (!bytesRead) throw new Error('A researcher file changed while being saved.');
              for (let written = 0; written < bytesRead;) {
                const result = await destination.write(buffer, written, bytesRead - written, offset + written);
                if (!result.bytesWritten) throw new Error('A researcher file could not be saved.');
                written += result.bytesWritten;
              }
              offset += bytesRead;
            }
            const after = await source.stat();
            if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('A researcher file changed while being saved.');
          } catch (error) {
            await destination?.close().catch(() => undefined);
            if (destination) await fs.rm(target, { force: true }).catch(() => undefined);
            destination = undefined;
            throw error;
          } finally { await destination?.close().catch(() => undefined); await source.close().catch(() => undefined); }
          attachments.push(join(finalArtifacts, storedName));
        }
        persistAndStampSeq(stage, chatId, { type: 'user_message_echo', workflowId: chatId, content: 'Files kept from researchers.', attachments, timestamp: Date.now() });
      }
      await flushWorkflowBuffer(stage, chatId);
      forgetWorkflowBuffer(stage, chatId); initialized = false;
      await fs.writeFile(join(stage, 'quick-research.json'), JSON.stringify({ projectId: chatId, files: expected }), { flag: 'wx', mode: 0o600 });
      await fs.mkdir(final, { mode: 0o700 }); reserved = true;
      // Windows cannot rename onto an existing directory, even an empty one.
      await fs.rmdir(final); reserved = false;
      await fs.rename(stage, final);
      return chatId;
    } catch (error) {
      if (initialized) forgetWorkflowBuffer(stage, chatId);
      if (reserved) await fs.rmdir(final).catch(() => undefined);
      await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  });
}

// Called only by explicit Chat purge. The marker, closed record and managed
// workspace must all agree before any Quick research source is removed.
export async function deleteQuickResearchForChat(cwd: string, chatId: string): Promise<boolean> {
  if (!UUID.test(chatId) || resolve(cwd) !== resolve(chatStorageDir(chatId))) return false;
  const markerPath = join(cwd, 'quick-research.json');
  let marker: { projectId?: string };
  try { marker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as { projectId?: string }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  if (marker.projectId !== chatId) throw new Error('The Quick research marker does not match this Chat.');
  await (await import('./savedQuickPromotion.js')).cancelSavedQuickPromotion(chatId);
  const { readClosedRecord, removeQuickLibraryEntry } = await import('./researchLibrary.js');
  const { closedResearchRecordPath } = await import('./researchClose.js');
  const record = await readClosedRecord(chatId);
  if (!record) throw new Error('The Quick research record is missing; its files were not deleted.');
  const workspace = antigravityChatWorkspace(chatId);
  if (record.quick && resolve(record.folder) !== resolve(workspace)) throw new Error('The Quick research record points to another folder.');
  await removeQuickWorkspace(chatId, workspace);
  if (record.quick) {
    await removeQuickLibraryEntry(chatId, workspace);
    await fs.rm(closedResearchRecordPath(chatId), { force: true });
  }
  await (await import('./savedQuickPromotion.js')).removeSavedQuickPromotion(chatId);
  await fs.rm(markerPath, { force: true });
  return true;
}

// Only the matching managed workspace may be removed after a successful
// promotion or explicit deletion of its owning saved Chat.
export async function removeQuickWorkspace(projectId: string, workspace: string): Promise<void> {
  if (!UUID.test(projectId) || resolve(workspace) !== resolve(antigravityChatWorkspace(projectId))) throw new Error('The Quick research workspace path does not match.');
  const root = await fs.lstat(dirname(workspace)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (root?.isSymbolicLink()) throw new Error('The Quick research workspace root is a link.');
  const info = await fs.lstat(workspace).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (info) {
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('The Quick research workspace is not a real folder.');
    const manifest = JSON.parse(await fs.readFile(join(workspace, 'research.json'), 'utf8')) as { projectId?: string };
    if (manifest.projectId !== projectId) throw new Error('The Quick research workspace does not match this project.');
    await fs.rm(workspace, { recursive: true });
  }
}
