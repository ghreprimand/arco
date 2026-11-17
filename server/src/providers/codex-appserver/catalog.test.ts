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

test('a changed CLI model cache refreshes before the hourly TTL without crossing account homes', async () => {
  const { mkdirSync, writeFileSync, chmodSync, appendFileSync } = await import('node:fs');
  const { delimiter } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'arco-catalog-refresh-'));
  const previousPath = process.env.PATH;
  const bin = join(root, 'bin'); mkdirSync(bin);
  const fixture = `import { readFileSync } from 'node:fs';
import { join } from 'node:path';
let input = '';
process.stdin.on('data', chunk => {
  input += chunk;
  let end;
  while ((end = input.indexOf('\\n')) >= 0) {
    const message = JSON.parse(input.slice(0, end)); input = input.slice(end + 1);
    if (message.method === 'initialize') console.log(JSON.stringify({ id: message.id, result: {} }));
    if (message.method === 'model/list') {
      const data = JSON.parse(readFileSync(join(process.env.CODEX_HOME, 'models_cache.json'), 'utf8'));
      console.log(JSON.stringify(data.fail ? { id: message.id, error: { code: -32000, message: 'Fixture refresh failed' } } : { id: message.id, result: { data: data.models, nextCursor: null } }));
    }
  }
});`;
  writeFileSync(join(bin, 'fake-cli.mjs'), fixture);
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'codex.cmd'), `@ECHO off\r\nSET "dp0=%~dp0"\r\n"${process.execPath}" "%dp0%\\fake-cli.mjs" %*\r\n`);
  } else {
    writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, 'fake-cli.mjs')}" "$@"\n`);
    chmodSync(join(bin, 'codex'), 0o755);
  }
  process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`;
  const homes = ['one', 'two'].map(name => { const home = join(root, name); mkdirSync(home); return home; });
  const save = (home: string, id: string) => writeFileSync(join(home, 'models_cache.json'), JSON.stringify({ models: [{
    id, displayName: id, description: 'Fixture model', hidden: false, isDefault: true,
    supportedReasoningEfforts: ['ultra', 'low', 'max'].map(reasoningEffort => ({ reasoningEffort })),
    defaultReasoningEffort: 'low', inputModalities: ['text', 'image'], supportsPersonality: false,
    max_context_window: 872_000,
  }] }));
  try {
    save(homes[0], 'gpt-6.1-sol'); save(homes[1], 'account-two');
    const before = await getCodexCatalog(true, homes[0]);
    const other = await getCodexCatalog(true, homes[1]);
    assert.equal(await getCodexCatalog(false, homes[0]), before, 'unchanged metadata reuses the snapshot');
    save(homes[0], 'gpt-6.2-astra');
    // Atomic CLI replacements or content writes invalidate even within the TTL.
    appendFileSync(join(homes[0], 'models_cache.json'), '\n');
    const refreshed = await getCodexCatalog(false, homes[0]);
    assert.equal(refreshed.fresh, true);
    assert.equal(refreshed.models[0].id, 'gpt-6.2-astra');
    assert.deepEqual(refreshed.models[0].supportedReasoningEfforts, ['low', 'max', 'ultra']);
    assert.equal(refreshed.models[0].supportsImageInput, true);
    assert.equal(refreshed.models[0].maxContextWindow, 872_000);
    assert.equal(await getCodexCatalog(false, homes[1]), other, 'another account stays cached');
    writeFileSync(join(homes[0], 'models_cache.json'), JSON.stringify({ fail: true }));
    const stale = await getCodexCatalog(false, homes[0]);
    assert.equal(stale.fresh, false);
    assert.equal(stale.fetchedAt, refreshed.fetchedAt, 'failure does not extend freshness');
    assert.deepEqual(stale.models, refreshed.models);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
