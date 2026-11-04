import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'arco-initial-providers-'));
process.env.ARCO_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

test('new home saves only detected providers and existing choices stay intact', async () => {
  const { detectInitialProviders } = await import('./initialProviders.js');
  const { initializeProviderSettings, readSettings } = await import('./settings.js');
  const file = join(home, 'settings.json');
  const claudeOnly = () => detectInitialProviders(async id => ({ loggedIn: id === 'claude' }), async () => false);
  assert.equal(await initializeProviderSettings(claudeOnly), true);
  const expected = { claude: true, codex: false, cursor: false, ollama: false, lmstudio: false, llamacpp: false, strata: false, deepseek: false };
  assert.deepEqual((await readSettings()).enabledProviders, expected);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).enabledProviders, expected);
  assert.equal(await initializeProviderSettings(async () => { throw new Error('unexpected probe'); }), false);
  assert.deepEqual((await readSettings()).enabledProviders, expected);

  rmSync(file);
  const local = await detectInitialProviders(async id => ({ loggedIn: id === 'lmstudio' }), async name => name === 'llama-server');
  assert.equal(local.lmstudio, true); assert.equal(local.llamacpp, true); assert.equal(local.ollama, false);
  writeFileSync(file, JSON.stringify({ textBrightness: 10 }));
  assert.equal(await initializeProviderSettings(claudeOnly), false);
  assert.ok(Object.values((await readSettings()).enabledProviders).every(Boolean));
  writeFileSync(file, JSON.stringify({ enabledProviders: { claude: false, cursor: true } }));
  assert.equal(await initializeProviderSettings(claudeOnly), false);
  assert.equal((await readSettings()).enabledProviders.claude, false);
  assert.equal((await readSettings()).enabledProviders.cursor, true);
  rmSync(file);
  writeFileSync(join(home, 'known-cwds.json'), '["fixture"]');
  assert.equal(await initializeProviderSettings(claudeOnly), false);
  assert.ok(Object.values((await readSettings()).enabledProviders).every(Boolean));
});
