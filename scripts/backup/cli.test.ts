import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const run = (args: string[], home: string) => spawnSync(process.execPath, ['--import', 'tsx', join(root, 'scripts/arco-backup.ts'), ...args], {
  cwd: root, encoding: 'utf8', env: { ...process.env, ARCO_HOME: home },
});

test('backup usage names the command that actually runs it', () => {
  const home = mkdtempSync(join(tmpdir(), 'arco-backup-usage-'));
  try {
    const outputs = [[], ['snapshot', '--help'], ['verify', '--help'], ['restore', '--help'], ['nonsense']].map((args) => {
      const result = run(args, home);
      return `${result.stdout}${result.stderr}`;
    });
    for (const output of outputs) {
      assert.match(output, /Usage: npx tsx scripts\/arco-backup\.ts /);
      assert.doesNotMatch(output, /arco backup/, 'there is no `arco backup` command');
    }
    assert.match(outputs[4], /\[arco-backup\] unknown command: nonsense/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the packaged arco command has no backup subcommand to point at', () => {
  const result = spawnSync(process.execPath, [join(root, 'scripts/packaging/arco.mjs'), 'backup'], { cwd: root, encoding: 'utf8', env: { ...process.env, ARCO_HOME: join(tmpdir(), 'arco-backup-none') } });
  assert.notEqual(result.status, 0);
});
