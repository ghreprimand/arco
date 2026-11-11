import assert from 'node:assert/strict';
import { normalizeUiScale } from '@arco/shared';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'arco-interface-scale-')));
const state = join(home, 'state');
process.env.ARCO_HOME = state;
process.env.HOME = home;
process.env.USERPROFILE = home;
after(() => rmSync(home, { recursive: true, force: true }));
const settingsFile = join(state, 'settings.json');
function reset(saved?: object) {
  rmSync(state, { recursive: true, force: true });
  mkdirSync(state, { recursive: true });
  if (saved) writeFileSync(settingsFile, JSON.stringify(saved));
}

test('fresh homes get 110%, existing settings and saved work keep their scale', async () => {
  const { readSettings, patchSettings, initializeProviderSettings } = await import('./settings.js');
  reset();
  mkdirSync(join(state, 'uploads'));
  assert.equal((await readSettings()).uiScale, 1.1, 'new home uses 110%');
  assert.equal(existsSync(settingsFile), false, 'reading a new home does not write settings');
  assert.equal(await initializeProviderSettings(async () => ({ claude: true, codex: false, cursor: false, ollama: false, llamacpp: false, lmstudio: false, strata: false, deepseek: false })), true);
  assert.equal((await readSettings()).uiScale, 1.1, 'first-run provider initialization keeps 110%');

  for (const saved of [{ uiScale: 1 }, {}, { uiScale: 'invalid' }]) {
    reset(saved);
    const bytes = readFileSync(settingsFile, 'utf8');
    assert.equal((await readSettings()).uiScale, 1, 'legacy explicit, missing or malformed scale remains 100%');
    assert.equal(readFileSync(settingsFile, 'utf8'), bytes, 'read does not migrate existing settings');
    assert.equal((await patchSettings({ textBrightness: 35 })).uiScale, 1);
  }
  for (const uiScale of [1.25, 0]) {
    reset({ uiScale });
    const bytes = readFileSync(settingsFile, 'utf8');
    assert.equal((await readSettings()).uiScale, normalizeUiScale(uiScale), 'finite saved numbers retain their previous snapped size');
    assert.equal(readFileSync(settingsFile, 'utf8'), bytes, 'snapping on read leaves the saved file untouched');
  }
  reset({ uiScale: 1.3 });
  await patchSettings({ textBrightness: 35 });
  assert.equal((await readSettings()).uiScale, 1.3, 'chosen supported size survives unrelated save');
  assert.equal((await patchSettings({ uiScale: 1.1 })).uiScale, 1.1, 'deliberate reset selects 110%');

  for (const record of ['known-cwds.json', 'projects.json', 'chats/earlier.jsonl']) {
    reset();
    const file = join(state, record);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '[]');
    assert.equal((await readSettings()).uiScale, 1, `${record} preserves existing-home fallback without settings`);
    assert.equal(existsSync(settingsFile), false);
    assert.equal(await initializeProviderSettings(async () => { throw new Error('must not reinitialize existing home'); }), false);
    assert.equal((await patchSettings({ textBrightness: 35 })).uiScale, 1);
  }
});
