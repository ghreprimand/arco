import { isIsolatedAccessMode } from '@arco/shared';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { withFileLock } from '../atomicFile.js';
import * as clusterStore from '../clusterStore.js';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/;
const MARKER = 'arco-isolated-cli-home-v1\n';

async function directory(path: string, privateStorage = false): Promise<void> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isDirectory() || (privateStorage && process.platform !== 'win32'
    && ((entry.mode & 0o077) !== 0 || (process.getuid && entry.uid !== process.getuid())))) {
    throw new Error('Isolated CLI storage must be a private owned directory.');
  }
}

/** Private provider state for one isolated member; it never contains a renewal key. */
export async function prepareIsolatedCliHome(clusterId: string, workflowId: string): Promise<string> {
  if (typeof clusterId !== 'string' || typeof workflowId !== 'string' || !ID.test(clusterId) || !ID.test(workflowId)) throw new Error('Invalid isolated CLI identity.');
  const cluster = clusterStore.clusterDir(clusterId);
  const isolates = join(cluster, 'isolates');
  const slot = join(isolates, workflowId);
  const home = join(slot, 'cli-home');
  const marker = join(slot, '.cli-home-owner');
  return withFileLock(slot, async () => {
    const state = await clusterStore.readCluster(clusterId);
    if (!state?.members.includes(workflowId) || !isIsolatedAccessMode(clusterStore.getMemberAccessMode(clusterId, workflowId))) {
      throw new Error('CLI storage requires an isolated cluster member.');
    }
    for (const path of [dirname(cluster), cluster, isolates]) await directory(path);
    await directory(slot, true);
    let created = false;
    try { await mkdir(home, { mode: 0o700 }); created = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (created && process.platform !== 'win32') await chmod(home, 0o700);
    await directory(home, true);
    if (created) {
      await writeFile(marker, MARKER, { mode: 0o600, flag: 'wx' });
    } else {
      const file = await open(marker, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const entry = await file.stat();
        if (!entry.isFile() || entry.nlink !== 1 || entry.size !== Buffer.byteLength(MARKER)
          || (process.platform !== 'win32' && ((entry.mode & 0o077) !== 0 || (process.getuid && entry.uid !== process.getuid())))
          || await file.readFile('utf8') !== MARKER) throw new Error('Isolated CLI home is not owned by Arco.');
      } finally { await file.close(); }
    }
    return home;
  });
}

/** Remove only a home bearing this helper's ownership marker. */
export async function removeIsolatedCliHome(clusterId: string, workflowId: string): Promise<void> {
  if (typeof clusterId !== 'string' || typeof workflowId !== 'string' || !ID.test(clusterId) || !ID.test(workflowId)) throw new Error('Invalid isolated CLI identity.');
  const cluster = clusterStore.clusterDir(clusterId);
  const isolates = join(cluster, 'isolates');
  const slot = join(isolates, workflowId);
  try { for (const path of [dirname(cluster), cluster, isolates]) await directory(path); await directory(slot, true); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  await withFileLock(slot, async () => {
    const home = join(slot, 'cli-home');
    const marker = join(slot, '.cli-home-owner');
    try { await directory(home, true); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const file = await open(marker, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const entry = await file.stat();
      if (!entry.isFile() || entry.nlink !== 1 || entry.size !== Buffer.byteLength(MARKER)
        || (process.platform !== 'win32' && ((entry.mode & 0o077) !== 0 || (process.getuid && entry.uid !== process.getuid())))
        || await file.readFile('utf8') !== MARKER) throw new Error('Isolated CLI home is not owned by Arco.');
    } finally { await file.close(); }
    await rm(home, { recursive: true, force: true });
    await rm(marker, { force: true });
  });
}
