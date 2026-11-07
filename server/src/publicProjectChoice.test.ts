import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'arco-public-choice-'));
installIsolatedTestHome(root);
const { getPublicProjectChoice, setPublicProjectChoice } = await import('./publicProjectChoice.js');
after(() => rmSync(root, { recursive: true, force: true }));

test('public choices are independent per project, persistent and changeable', async () => {
  const first = join(root, 'first'); const second = join(root, 'second');
  mkdirSync(first); mkdirSync(second);
  assert.equal(await getPublicProjectChoice(first), null);
  await Promise.all([setPublicProjectChoice(first, true), setPublicProjectChoice(second, false)]);
  assert.equal(await getPublicProjectChoice(first), true);
  assert.equal(await getPublicProjectChoice(second), false);
  await setPublicProjectChoice(first, false);
  assert.equal(await getPublicProjectChoice(first), false);
  assert.equal(await getPublicProjectChoice(second), false);
});
