import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'arco-picker-test-')));
const home = join(sandbox, 'home');
const systemTemp = join(sandbox, 'system-temp');
const location = join(sandbox, 'location');
const bookmark = join(sandbox, 'bookmark');
const historyOnly = join(sandbox, 'history-only');
for (const folder of [join(home, '.arco'), systemTemp, join(location, 'zeta'), join(location, 'Alpha'), bookmark, historyOnly, join(systemTemp, 'ignored')]) mkdirSync(folder, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.TMPDIR = systemTemp;
process.env.TMP = systemTemp;
process.env.TEMP = systemTemp;
writeFileSync(join(location, 'Alpha', 'package.json'), JSON.stringify({ name: 'other-name' }));
writeFileSync(join(home, '.arco', 'known-cwds.json'), JSON.stringify([historyOnly, join(location, 'Alpha'), join(sandbox, 'missing'), join(systemTemp, 'ignored')]));
for (const [folder, at] of [[historyOnly, 200], [join(location, 'Alpha'), 100]] as const) {
  const metaDir = join(folder, '.arco', 'workflows', 'fixture');
  mkdirSync(metaDir, { recursive: true });
  writeFileSync(join(metaDir, 'meta.json'), JSON.stringify({ workflowId: 'fixture', cwd: folder, name: 'Fixture', createdAt: 1, lastActiveAt: at, cliSessions: [] }));
}

test('picker choices exclude history, missing and temporary folders while containment retains history', async () => {
  try {
    const { patchSettings } = await import('./settings.js');
    const { listProjects, projectRoots, withinRoots } = await import('./projects.js');
    await patchSettings({ projectRoots: [{ name: 'Location', path: location }], projects: [bookmark, join(sandbox, 'missing'), join(systemTemp, 'ignored')] });
    const result = await listProjects();
    assert.deepEqual(result.pickerProjects?.map(p => p.name), ['Alpha', 'bookmark', 'zeta']);
    assert.equal(result.pickerProjects?.find(p => p.name === 'Alpha')?.rootPath, location);
    assert.deepEqual(result.recentProjects?.map(p => p.path), [historyOnly, join(location, 'Alpha')]);
    assert.equal(result.recentProjects?.some(p => p.path === join(systemTemp, 'ignored') || !p.exists), false);
    assert.equal(withinRoots(join(historyOnly, 'file.txt'), await projectRoots()), true);
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
});
