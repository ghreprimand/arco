import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'arco-utility-settings-')));
process.env.HOME = home;
process.env.USERPROFILE = home;
mkdirSync(join(home, '.arco'));
after(() => rmSync(home, { recursive: true, force: true }));

test('the utility agent is unset by default, kept across other patches, replaced whole and cleared by null', async () => {
  const { readSettings, patchSettings } = await import('./settings.js');
  assert.equal((await readSettings()).utilityAgent, undefined);
  await patchSettings({ utilityAgent: { provider: 'cursor', model: 'auto' } });
  await patchSettings({ projects: [] });
  assert.deepEqual((await readSettings()).utilityAgent, { provider: 'cursor', model: 'auto' });
  // An unsupported provider or empty model is dropped; the earlier choice stays.
  await patchSettings({ utilityAgent: { provider: 'unsupported', model: 'x' } as never });
  await patchSettings({ utilityAgent: { provider: 'claude', model: '  ' } as never });
  assert.deepEqual((await readSettings()).utilityAgent, { provider: 'cursor', model: 'auto' });
  await patchSettings({ utilityAgent: { provider: 'ollama', model: ' qwen ' } });
  assert.deepEqual((await readSettings()).utilityAgent, { provider: 'ollama', model: 'qwen' });
  await patchSettings({ utilityAgent: null as never });
  assert.equal((await readSettings()).utilityAgent, undefined);
});
