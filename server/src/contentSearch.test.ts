import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { RIPGREP_BIN, searchContent } from './contentSearch.js';

test('content search omits private filenames without hiding ordinary hits', { skip: !RIPGREP_BIN }, async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'arco-search-policy-'));
  try {
    for (const name of ['credentials.json', 'fixture.pem', 'ordinary.txt']) {
      writeFileSync(path.join(cwd, name), 'synthetic search marker\n');
    }
    const result = await searchContent({ cwd, query: 'synthetic search marker' });
    assert.deepEqual(result.hits.map((hit) => hit.file), ['ordinary.txt']);
    const limited = await searchContent({ cwd, query: 'synthetic search marker', maxHits: 1 });
    assert.deepEqual(limited.hits.map((hit) => hit.file), ['ordinary.txt']);
    assert.equal(limited.capped, false);
    mkdirSync(path.join(cwd, 'nested'));
    writeFileSync(path.join(cwd, 'nested', 'ordinary.txt'), 'nested search marker\n');
    const nested = await searchContent({ cwd, query: 'nested search marker' });
    assert.deepEqual(nested.hits.map(hit => hit.file), ['nested/ordinary.txt']);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
