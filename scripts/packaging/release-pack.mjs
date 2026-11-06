#!/usr/bin/env node
// Build the audited release tarball from all six collected native artifacts.
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [native, output, ...extra] = process.argv.slice(2);
if (!native || !output || extra.length) throw new Error('Usage: npm run release:pack -- <native-artifacts-directory> <output.tgz>');
const destination = resolve(output);
const scratch = mkdtempSync(resolve(tmpdir(), 'arco-release-pack-'));
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
  return result.stdout.trim();
}
try {
  const assembled = resolve(scratch, 'package');
  run(process.execPath, ['scripts/packaging/assemble.mjs', assembled, resolve(native)]);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = run(npm, ['pack', '--ignore-scripts', '--pack-destination', scratch, assembled]);
  if (!/^[A-Za-z0-9._-]+\.tgz$/.test(packed)) throw new Error('Unexpected npm pack output.');
  const audit = resolve(scratch, 'audit'); mkdirSync(audit);
  run('tar', ['-xzf', resolve(scratch, packed), '-C', audit, '--strip-components=1']);
  if (!existsSync(resolve(audit, 'THIRD_PARTY_NOTICES'))) throw new Error('The package is missing THIRD_PARTY_NOTICES.');
  run(process.execPath, ['scripts/public-audit.mjs', '--package', audit]);
  cpSync(resolve(scratch, packed), destination, { errorOnExist: true, force: false });
  console.log(`Audited release package: ${destination}`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
