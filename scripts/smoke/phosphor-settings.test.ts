import { strict as assert } from 'node:assert';
import { test, mock } from 'node:test';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';

test('Phosphor settings persist, validate and preserve Classic/operator preferences in an isolated directory', async () => {
  // Never point the settings module at the operator's real home. No server is
  // started, so worker orphan recovery and settings broadcasts cannot run.
  const fixture = await mkdtemp(join(os.tmpdir(), 'arco-phosphor-settings-'));
  mock.method(os, 'homedir', () => fixture);
  syncBuiltinESMExports();
  // An exported ARCO_HOME would otherwise send these writes to that home.
  const previousHome = process.env.ARCO_HOME;
  delete process.env.ARCO_HOME;
  try {
    const { patchSettings, readSettings } = await import('../../server/src/settings');
    const { VALID_THEME_IDS, PHOSPHOR_PALETTE_IDS } = await import('../../shared/src/protocol/themes');
    await patchSettings({ themeId: 'everforest', fontPackOverride: 'victor-mono-uniform', bgBrightness: -5, textBrightness: 8, crispText: true, frostedOverride: 'off', operatorName: 'Fixture operator' });
    const classic = await readSettings();
    for (const id of PHOSPHOR_PALETTE_IDS) {
      const themeId = `phosphor:arco:${id}`;
      assert.ok((VALID_THEME_IDS as readonly string[]).includes(themeId));
      assert.equal((await patchSettings({ themeId })).themeId, themeId);
    }
    await patchSettings({ phosphorSoftness: 35, phosphorEffects: false });
    const saved = await readSettings();
    assert.equal(saved.phosphorSoftness, 35);
    assert.equal(saved.phosphorEffects, false);
    for (const key of ['fontPackOverride', 'bgBrightness', 'textBrightness', 'crispText', 'frostedOverride', 'operatorName'] as const) assert.equal(saved[key], classic[key]);
    const file = join(fixture, '.arco', 'settings.json');
    const before = await readFile(file, 'utf8');
    for (const patch of [{ themeId: 'phosphor:arco:invalid' }, { phosphorSoftness: -1 }, { phosphorSoftness: 101 }, { phosphorSoftness: NaN }, { phosphorEffects: 'yes' }]) {
      await assert.rejects(() => patchSettings(patch as never));
      assert.equal(await readFile(file, 'utf8'), before);
    }
    await patchSettings({ themeId: 'everforest' });
    assert.equal((await readSettings()).themeId, 'everforest');
    assert.equal((await readSettings()).phosphorSoftness, 35);
    await patchSettings({ phosphorEffects: null, phosphorSoftness: null } as never);
    assert.equal((await readSettings()).phosphorEffects, undefined);
    assert.equal((await readSettings()).phosphorSoftness, undefined);
  } finally {
    if (previousHome !== undefined) process.env.ARCO_HOME = previousHome; mock.restoreAll(); syncBuiltinESMExports(); }
});
