import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'arco-handoff-settings-')));
process.env.ARCO_HOME = join(home, '.arco');
process.env.HOME = home;
process.env.USERPROFILE = home;
after(() => rmSync(home, { recursive: true, force: true }));

test('quick and written auto-handoff choices persist across settings patches', async () => {
  const { readSettings, patchSettings } = await import('./settings.js');
  for (const mode of ['quick', 'original-worker', 'fresh-summarizer'] as const) {
    await patchSettings({ autoHandoffDefaults: { mode } });
    await patchSettings({ projects: [] });
    assert.equal((await readSettings()).autoHandoffDefaults?.mode, mode);
  }
});
