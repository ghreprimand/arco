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


test('transport and text brightness defaults preserve explicit choices', async () => {
  const { readSettings, patchSettings } = await import('./settings.js');
  const fresh = await readSettings();
  assert.equal(fresh.codex?.transport, 'appserver');
  assert.equal(fresh.claude?.transport, 'native');
  assert.equal(fresh.textBrightness, 30);
  await patchSettings({ codex: { transport: 'exec' }, claude: { transport: 'cli' }, textBrightness: 0 });
  await patchSettings({ projects: [] });
  const saved = await readSettings();
  assert.equal(saved.codex?.transport, 'exec');
  assert.equal(saved.claude?.transport, 'cli');
  assert.equal(saved.textBrightness, 0);
});

test('interface scale defaults, snaps to allowed steps, and persists', async () => {
  const { readSettings, patchSettings } = await import('./settings.js');
  assert.equal((await readSettings()).uiScale, 1.1);
  assert.equal((await patchSettings({ uiScale: 1.27 })).uiScale, 1.3);
  assert.equal((await patchSettings({ uiScale: 0.1 })).uiScale, 0.9);
  await patchSettings({ projects: [] });
  assert.equal((await readSettings()).uiScale, 0.9);
  assert.equal((await patchSettings({ uiScale: 9 })).uiScale, 1.5);
  await assert.rejects(patchSettings({ uiScale: NaN }));
});
