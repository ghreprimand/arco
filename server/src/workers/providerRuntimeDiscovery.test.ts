import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverProviderRuntime } from './providerRuntimeDiscovery.js';

test('Linux runtime discovery selects recognized provider files and excludes private or linked entries', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'arco-provider-runtime-'));
  try {
    const claude = join(root, 'claude');
    await writeFile(claude, Buffer.from([0x7f, 0x45, 0x4c, 0x46])); await chmod(claude, 0o700);
    const native = await discoverProviderRuntime('claude', claude);
    assert.equal(native.mounts.length, 1); assert.equal(native.mounts[0].source, claude);

    const codex = join(root, 'codex'); await mkdir(join(codex, 'bin'), { recursive: true });
    await writeFile(join(codex, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
    await writeFile(join(codex, 'bin', 'codex.js'), 'fixture'); await chmod(join(codex, 'bin', 'codex.js'), 0o700);
    await writeFile(join(codex, '.private'), 'must not be mounted');
    if (process.execPath.startsWith('/usr/')) {
      const js = await discoverProviderRuntime('codex', join(codex, 'bin', 'codex.js'));
      assert.ok(js.argsPrefix[0].endsWith('/bin/codex.js'));
      assert.ok(js.mounts.some(m => m.source.endsWith('package.json')));
      assert.ok(!js.mounts.some(m => m.source.endsWith('.private')));
    }

    const cursor = join(root, 'cursor'); await mkdir(cursor);
    await writeFile(join(cursor, 'package.json'), JSON.stringify({ name: '@anysphere/agent-cli-runtime' }));
    for (const name of ['cursor-agent', 'node', 'index.js']) { await writeFile(join(cursor, name), 'fixture'); if (name !== 'index.js') await chmod(join(cursor, name), 0o700); }
    await writeFile(join(cursor, 'account.backup'), 'must not be mounted');
    await mkdir(join(cursor, '.running')); await writeFile(join(cursor, '.running', 'private'), 'must not be mounted');
    const selected = await discoverProviderRuntime('cursor', join(cursor, 'cursor-agent'));
    assert.ok(selected.mounts.some(m => m.target.endsWith('/cursor-agent')));
    assert.ok(!selected.mounts.some(m => /account\.backup|\.running/.test(m.source)));
    await writeFile(join(cursor, 'state.json'), 'must not be mounted');
    await assert.rejects(discoverProviderRuntime('cursor', join(cursor, 'cursor-agent')), /unrecognized JSON state/);
    await rm(join(cursor, 'state.json'));
    await symlink(join(root, 'outside'), join(cursor, 'linked-runtime'));
    await assert.rejects(discoverProviderRuntime('cursor', join(cursor, 'cursor-agent')), /unsupported entry/);
    await assert.rejects(discoverProviderRuntime('codex', claude), /recognized isolated runtime/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
