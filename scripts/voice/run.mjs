#!/usr/bin/env node
// Runs a voice Python script (default: setup.py) through uv, which supplies a
// matching Python on Linux, macOS and Windows. No system `python3` is needed.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, process.argv[2] ?? 'setup.py');
const home = resolve(process.env.ARCO_HOME?.trim() || join(homedir(), '.arco'));
const env = process.env.ARCO_PACKAGED === '1' ? { ...process.env, UV_CACHE_DIR: process.env.UV_CACHE_DIR || join(home, 'cache', 'uv'), UV_PYTHON_INSTALL_DIR: process.env.UV_PYTHON_INSTALL_DIR || join(home, 'voice', 'python') } : process.env;
const probe = spawnSync('uv', ['--version'], { stdio: 'ignore', env });
if (probe.error || probe.status !== 0) {
  const command = process.env.ARCO_PACKAGED === '1' ? 'arco voice setup' : 'npm run voice:setup';
  console.error(`Voice setup needs uv. Install it from https://docs.astral.sh/uv/getting-started/installation/ and run ${command} again.`);
  process.exit(1);
}
const result = spawnSync('uv', ['run', '--no-project', '--python', '3.12', script, ...process.argv.slice(3)], { stdio: 'inherit', env });
process.exit(result.status ?? 1);
