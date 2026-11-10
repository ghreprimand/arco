import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remainingTempFolders, snapshotTempFolders } from './temp-folder-gate.mjs';

const temporary = mkdtempSync(join(tmpdir(), 'arco-browser-gate-'));
const before = snapshotTempFolders(temporary);
try {
  const [command, ...args] = process.argv.slice(2);
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary, ARCO_BROWSER_TEMP_ROOT_ACTIVE: '1' },
  });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
} finally {
  const leftovers = remainingTempFolders(temporary, before);
  if (leftovers.length) {
    console.error(`Temporary folders left by browser tests (${leftovers.length}): ${leftovers.join(', ')}\nRetained in ${temporary}`);
    process.exitCode = 1;
  } else {
    rmSync(temporary, { recursive: true, force: true });
  }
}
