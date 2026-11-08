import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';

const root = mkdtempSync(join(tmpdir(), 'arco-old-skill-settings-'));
installIsolatedTestHome(root);
const state = join(root, 'state'); mkdirSync(state, { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

test('obsolete extra skill paths do not survive settings reads or unrelated patches', async () => {
  const file = join(state, 'settings.json');
  writeFileSync(file, JSON.stringify({ skillsExtraPaths: ['old-fixture'], updateCheck: false }));
  const { readSettings, patchSettings } = await import('./settings.js');
  const before = await readSettings();
  assert.equal('skillsExtraPaths' in before, false);
  assert.equal(before.updateCheck, false);
  await patchSettings({ projects: [] });
  const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  assert.equal('skillsExtraPaths' in saved, false);
  assert.equal(saved.updateCheck, false);
});
