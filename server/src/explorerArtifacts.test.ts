import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathWithinHome } from './explorerArtifacts.js';

async function withHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try { return await fn(); } finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; }
}

test('projects stay inside the home fence when the home is reached through a symlink', { skip: process.platform === 'win32' ? 'POSIX HOME symlink' : false }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'arco-home-fence-'));
  try {
    const realHome = join(root, 'real-home');
    await mkdir(join(realHome, 'proj'), { recursive: true });
    const linkHome = join(root, 'link-home');
    await symlink(realHome, linkHome, 'dir');
    const expected = await realpath(join(realHome, 'proj'));
    await withHome(linkHome, async () => {
      assert.equal(await realpathWithinHome(join(linkHome, 'proj')), expected);
      assert.equal(await realpathWithinHome(root), null, 'a folder above the home stays outside');
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});
