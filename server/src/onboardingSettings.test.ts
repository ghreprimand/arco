import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'arco-setup-settings-')));
process.env.HOME = home;
process.env.USERPROFILE = home;
mkdirSync(join(home, '.arco'));
after(() => rmSync(home, { recursive: true, force: true }));

test('setup completion survives unrelated settings patches and cannot be reset by an old browser', async () => {
  const { readSettings, patchSettings } = await import('./settings.js');
  assert.equal((await readSettings()).onboardingComplete, undefined);
  await patchSettings({ onboardingComplete: true });
  await patchSettings({ projects: [] });
  await patchSettings({ onboardingComplete: false });
  assert.equal((await readSettings()).onboardingComplete, true);
  assert.equal(JSON.parse(readFileSync(join(home, '.arco', 'settings.json'), 'utf8')).onboardingComplete, true);
});

test('default font survives settings round trips and saved choices remain intact', async () => {
  const { readSettings, patchSettings } = await import('./settings.js');
  assert.equal((await readSettings()).fontPackOverride, 'victor-mono-uniform');
  await patchSettings({ themeId: 'matrix', fontPackOverride: 'space-mono-uniform' });
  assert.equal((await readSettings()).themeId, 'matrix');
  assert.equal((await readSettings()).fontPackOverride, 'space-mono-uniform');
  await patchSettings({ fontPackOverride: null });
  assert.equal((await readSettings()).fontPackOverride, null);
  await patchSettings({ projects: [] });
  assert.equal((await readSettings()).fontPackOverride, null);
});
