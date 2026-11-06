import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getCodexCatalog } from './catalog.js';

test('an absent Codex executable returns an empty catalog without crashing', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'arco-catalog-missing-'));
  const previousPath = process.env.PATH;
  process.env.PATH = empty;
  try {
    const result = await getCodexCatalog(true, join(empty, 'profile'));
    assert.deepEqual(result.models, []);
    assert.equal(result.fresh, false);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(empty, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
