import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { linkFolder } from './testSupport/links.js';

const root = await mkdtemp(join(tmpdir(), 'arco-recent-activity-'));
process.env.ARCO_HOME = join(root, 'home');
const { RecentProjectActivityCache } = await import('./recentProjectActivity.js');
const { readMeta } = await import('./workflowMeta.js');

test('unchanged metadata is reused, and updates or removals refresh the newest activity', async () => {
  const project = join(root, 'project');
  const dir = (id: string) => join(project, '.arco', 'workflows', id);
  await Promise.all([mkdir(dir('first'), { recursive: true }), mkdir(dir('second'), { recursive: true })]);
  const content = (id: string, at: number) => JSON.stringify({ workflowId: id, cwd: project, name: id, createdAt: 1, lastActiveAt: at, cliSessions: [] });
  await writeFile(join(dir('first'), 'meta.json'), content('first', 100));
  await writeFile(join(dir('second'), 'meta.json'), content('second', 200));
  const alias = join(root, 'alias');
  await linkFolder(project, alias);
  let loads = 0;
  let failThird = true;
  const cache = new RecentProjectActivityCache(async (cwd, id) => {
    loads += 1;
    if (id === 'third' && failThird) { failThird = false; throw new Error('synthetic transient read failure'); }
    return readMeta(cwd, id);
  });
  try {
    assert.deepEqual(await Promise.all([cache.get(project), cache.get(project)]), [200, 200]);
    assert.equal(loads, 2);
    assert.equal(await cache.get(project), 200);
    assert.equal(loads, 2);
    assert.equal(await cache.get(alias), 200);
    assert.equal(loads, 2, 'linked paths share the cached metadata');
    await writeFile(join(dir('first'), 'replacement'), content('first', 300));
    await rename(join(dir('first'), 'replacement'), join(dir('first'), 'meta.json'));
    assert.equal(await cache.get(project), 300);
    assert.equal(loads, 3, 'only the changed metadata is read again');
    await rm(dir('first'), { recursive: true });
    assert.equal(await cache.get(project), 200);
    assert.equal(loads, 3);
    await mkdir(dir('third'));
    await writeFile(join(dir('third'), 'meta.json'), content('third', 400));
    assert.equal(await cache.get(project), 200);
    assert.equal(loads, 4);
    assert.equal(await cache.get(project), 400);
    assert.equal(loads, 5, 'a failed read is retried even when metadata is unchanged');
  } finally { await rm(root, { recursive: true, force: true }); }
});
