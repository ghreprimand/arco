#!/usr/bin/env node
// Runs a voice Python script (default: setup.py) through uv, which supplies a
// matching Python on Linux, macOS and Windows. No system `python3` is needed.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, process.argv[2] ?? 'setup.py');
const probe = spawnSync('uv', ['--version'], { stdio: 'ignore' });
if (probe.error || probe.status !== 0) {
  console.error('Voice setup needs uv. Install it from https://docs.astral.sh/uv/getting-started/installation/ and run npm run voice:setup again.');
  process.exit(1);
}
const result = spawnSync('uv', ['run', '--no-project', '--python', '3.12', script, ...process.argv.slice(3)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
