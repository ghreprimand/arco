import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'arco-retired-provider-'));
process.env.ARCO_HOME = home;

test('a home with retired provider fields preserves unrelated settings across read and patch', async () => {
  const settingsFile = join(home, 'settings.json');
  const original = {
    zai: { transport: 'native' }, enabledProviders: { zai: false, codex: false, claude: true },
    workflowDefaults: { primaryProvider: 'zai', primaryModel: 'glm-5.2', zaiTransport: 'native', outputStyle: 'terse', skipPermissions: false },
    themeId: 'matrix', textBrightness: 27, onboardingComplete: true,
    projects: [join(home, 'synthetic-project')],
    providerAccounts: { zai: [{ id: 'old' }], codex: [{ id: 'work', label: 'Work' }] },
  };
  writeFileSync(settingsFile, JSON.stringify(original));
  const secretsFile = join(home, 'provider-secrets.json');
  const secrets = JSON.stringify({ zaiApiKey: 'retired-synthetic-key', unrelated: 'preserve' });
  writeFileSync(secretsFile, secrets);
  try {
    const { PRIMARY_PROVIDERS } = await import('@arco/shared');
    const { isKnownProvider, createProviderProcess } = await import('./providers/index.js');
    assert.equal((PRIMARY_PROVIDERS as string[]).includes('zai'), false);
    assert.equal(isKnownProvider('zai'), false);
    assert.throws(() => createProviderProcess('retired', { provider: 'zai' } as never), /Z\.ai support has been removed/);
    const { readSettings, patchSettings } = await import('./settings.js');
    const settings = await readSettings();
    assert.equal('zai' in settings, false);
    assert.equal('zai' in settings.enabledProviders, false);
    assert.equal(settings.enabledProviders.codex, false);
    assert.deepEqual(settings.providerAccounts?.codex, [{ id: 'work', label: 'Work' }]);
    assert.equal('zai' in (settings.providerAccounts ?? {}), false);
    assert.equal(settings.workflowDefaults?.primaryProvider, undefined);
    assert.equal(settings.workflowDefaults?.primaryModel, undefined);
    assert.equal(settings.workflowDefaults?.outputStyle, 'terse');
    assert.equal(settings.workflowDefaults?.skipPermissions, false);
    assert.equal(settings.textBrightness, 27);
    assert.deepEqual(settings.projects, original.projects);
    const patched = await patchSettings({ updateCheck: false });
    assert.equal(patched.onboardingComplete, true);
    assert.equal(patched.enabledProviders.codex, false);
    assert.equal(patched.textBrightness, 27);
    assert.deepEqual(patched.projects, original.projects);
    const written = JSON.parse(readFileSync(settingsFile, 'utf8'));
    assert.equal('zai' in written, false);
    assert.equal('zai' in written.enabledProviders, false);
    assert.equal('zaiTransport' in written.workflowDefaults, false);
    assert.equal(readFileSync(secretsFile, 'utf8'), secrets, 'retired secret files are left untouched');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
