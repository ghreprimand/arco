import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'arco-local-capacity-'));
process.env.HOME = home;
process.env.ARCO_HOME = join(home, '.arco');
delete process.env.ARCO_CLUSTER_ALLOW_MULTIPLE_LOCAL;

test('server refusal follows saved capacity, ignores changes without local members and honors the env override', async () => {
  try {
    const { localCapacityRefusal } = await import('./localCapacity.js');
    const { patchSettings, readSettings } = await import('./settings.js');
    // Fresh home: default 1.
    assert.match(await localCapacityRefusal(['ollama', 'ollama'], ['ollama']) ?? '', /^local_capacity: 2 members use Ollama/);
    // Adding a non-local member to an over-capacity cluster is not refused.
    assert.equal(await localCapacityRefusal(['ollama', 'ollama', 'claude'], ['claude']), null);
    const saved = await patchSettings({ localClusterCapacity: { ollama: 3 } });
    assert.deepEqual(saved.localClusterCapacity, { ollama: 3 });
    assert.equal(await localCapacityRefusal(['ollama', 'ollama', 'ollama'], ['ollama']), null);
    assert.match(await localCapacityRefusal(['ollama', 'ollama', 'ollama', 'ollama'], ['ollama']) ?? '', /allows 3 at once/);
    // Patching one runtime keeps the other; invalid values are ignored.
    await patchSettings({ localClusterCapacity: { llamacpp: 2 } });
    await patchSettings({ localClusterCapacity: { ollama: 99 } as never });
    assert.deepEqual((await readSettings()).localClusterCapacity, { ollama: 3, llamacpp: 2 });
    assert.deepEqual(JSON.parse(readFileSync(join(home, '.arco', 'settings.json'), 'utf8')).localClusterCapacity, { ollama: 3, llamacpp: 2 });
    // A hand-edited out-of-range value reads as the default.
    writeFileSync(join(home, '.arco', 'settings.json'), JSON.stringify({ localClusterCapacity: { ollama: 0, llamacpp: '4' } }));
    assert.equal((await readSettings()).localClusterCapacity, undefined);
    assert.match(await localCapacityRefusal(['ollama', 'ollama'], ['ollama']) ?? '', /allows 1 at once/);
    process.env.ARCO_CLUSTER_ALLOW_MULTIPLE_LOCAL = '1';
    assert.equal(await localCapacityRefusal(['ollama', 'ollama', 'ollama', 'ollama', 'ollama'], ['ollama']), null);
  } finally {
    delete process.env.ARCO_CLUSTER_ALLOW_MULTIPLE_LOCAL;
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
