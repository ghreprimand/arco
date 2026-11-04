import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../voice/run.mjs', import.meta.url));
test('packaged voice setup keeps uv downloads in the Arco home', (t) => {
  if (process.platform === 'win32') { t.skip('The fixture is a POSIX executable.'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'arco-voice-package-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, 'observed');
  writeFileSync(join(dir, 'uv'), '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\nprintf "%s\\n%s\\n" "$UV_CACHE_DIR" "$UV_PYTHON_INSTALL_DIR" > "$FIXTURE_OUTPUT"\n', { mode: 0o755 });
  const home = join(dir, 'arco-home');
  const env = { PATH: [dir, process.env.PATH || ''].join(delimiter), HOME: dir, ARCO_HOME: home, ARCO_PACKAGED: '1', FIXTURE_OUTPUT: output };
  const result = spawnSync(process.execPath, [script, 'setup.py'], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(output, 'utf8').trim().split('\n'), [join(home, 'cache', 'uv'), join(home, 'voice', 'python')]);
});
