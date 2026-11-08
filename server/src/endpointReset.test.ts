import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home = mkdtempSync(join(tmpdir(), 'arco-endpoint-reset-'));
process.env.ARCO_HOME = join(home, 'test-state');
test('B149: explicit endpoint clearing survives reread and keeps unrelated options', async () => {
  try {
    const { patchSettings, readSettings } = await import('./settings.js');
    await patchSettings({ ollama: { baseUrl: 'http://fixture.invalid:11434', modelHostMap: { fixture: ['http://fixture.invalid:11434'] } }, lmstudio: { baseUrl: 'http://fixture.invalid:1234' } } as never);
    // JSON is the exact endpoint editor reset contract, without undefined fields.
    await patchSettings(JSON.parse('{"ollama":{"baseUrl":null},"lmstudio":{"baseUrl":null}}'));
    const saved = await readSettings();
    assert.equal(saved.ollama?.baseUrl, undefined);
    assert.equal(saved.lmstudio?.baseUrl, undefined);
    assert.deepEqual(saved.ollama?.modelHostMap, { fixture: ['http://fixture.invalid:11434'] });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
