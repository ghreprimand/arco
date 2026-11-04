// docs/ARCHITECTURE.md A1 - mem-retention smoke.
//
// Retention is CLIENT state (the Zustand store + memoryTrim caps), not a server
// WS surface, so unlike the other smokes this one does not boot a workflow. It
// runs the client-side retention guards (`retentionStats.test.ts`) headlessly:
//   1. trimJobMemory caps every hot array regardless of input size, and
//   2. getRetentionStats reports the live footprint (per-tab counts + blob URLs)
//      that the dev MemoryHud surfaces during a long soak.
// Kept as a `scripts/smoke/*.ts` entry so the phase's named artifact exists and
// `npm run smoke:mem-retention` works from the repo root like the others.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const testFile = resolve(here, '../../client/src/stores/retentionStats.test.ts');

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', testFile],
  { stdio: 'inherit', cwd: resolve(here, '../../client') },
);

process.exit(result.status ?? 1);
