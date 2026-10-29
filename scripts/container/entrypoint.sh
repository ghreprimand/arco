#!/bin/sh
set -eu
mkdir -p "$HOME/.arco" "$CODEX_HOME" /data/uploads
node --input-type=module - <<'JS'
import { openSync, writeFileSync, fsyncSync, closeSync, linkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
const file = join(process.env.HOME, '.arco', 'settings.json');
const temp = `${file}.init-${process.pid}`;
// Initialize only a new volume; preserve operator settings on every restart.
try {
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify({
      defaultWorkingDirectory: '/projects',
      enabledProviders: { cursor: false, llamacpp: false },
    }) + '\n');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  // Publish a complete file without overwriting another initializer's result.
  linkSync(temp, file);
  const directory = openSync(join(process.env.HOME, '.arco'), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
} finally { try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
JS
exec "$@"
