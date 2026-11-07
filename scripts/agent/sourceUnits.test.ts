import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSystemdUnit } from '../service/unit.js';
import { renderAgentUnit } from './unit.js';
import { renderManagementUnit } from '../management/unit.js';

const root = '/fixture/Checkout with spaces';
function argv(unit: string): string[] {
  const line = unit.split('\n').find(line => line.startsWith('ExecStart='))!.slice(10);
  return (line.match(/"(?:\\.|[^"\\])*"|[^\s]+/g) ?? []).map(token => (token.startsWith('"') ? JSON.parse(token) : token).replace(/%%/g, '%').replace(/\$\$/g, '$'));
}
for (const [name, render, entry] of [
  ['app', () => renderSystemdUnit({ repoRoot: root }), `${root}/server/dist/index.js`],
  ['agent', () => renderAgentUnit({ repoRoot: root, publicKeyPath: `${root}/keys/hub.pub` }), `${root}/scripts/arco-agent.ts`],
  ['management', () => renderManagementUnit({ repoRoot: root, host: 'localhost', port: 3500, privateKeyPath: `${root}/keys/hub.key` }), `${root}/scripts/arco-management.ts`],
] as const) test(`B196: ${name} source unit retains a spaced entry as one argument`, () => {
  const unit = render();
  const args = argv(unit);
  assert.ok(args.includes(entry), JSON.stringify(args));
  assert.equal(args[0], process.execPath);
  for (const line of unit.split('\n').filter(line => line.startsWith('Environment=') && line.includes('/keys/'))) {
    assert.equal((line.slice(12).match(/"(?:\\.|[^"\\])*"|[^\s]+/g) ?? []).length, 1);
  }
});

test('B196: systemd accepts a source unit with a spaced working directory', async (t) => {
  if (process.platform !== 'linux') { t.skip('systemd parser is Linux-only'); return; }
  const { spawnSync } = await import('node:child_process');
  if (spawnSync('systemd-analyze', ['--version']).status !== 0) { t.skip('systemd-analyze unavailable'); return; }
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const temp = await mkdtemp(join(tmpdir(), 'arco-unit-parser-'));
  try {
    const file = join(temp, 'fixture.service');
    await writeFile(file, renderSystemdUnit({ repoRoot: root }));
    const result = spawnSync('systemd-analyze', ['verify', '--man=no', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
