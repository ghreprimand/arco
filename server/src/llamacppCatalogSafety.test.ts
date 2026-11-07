import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const root = mkdtempSync(join(tmpdir(), 'arco-catalog-safety-'));
installIsolatedTestHome(root);
after(() => rmSync(root, { recursive: true, force: true }));
const catalog = await import('./llamacppCatalog.js');
const file = join(process.env.ARCO_HOME!, 'llamacpp.json');
const revision = () => createHash('sha256').update(readFileSync(file)).digest('hex');
const models = ['one', 'two', 'three'].map((alias) => ({ alias, ggufPath: `/fixture/${alias}.gguf` }));

test('B158: colliding aliases are rejected before replacing the catalog', async () => {
  await catalog.writeCatalog({ models });
  const before = readFileSync(file);
  await assert.rejects((catalog.writeCatalog as Function)({ models: [models[0], { ...models[1], alias: 'one' }] }, revision()), /alias|duplicate/i);
  assert.deepEqual(readFileSync(file), before);
});

test('B159: concurrent deletions against one revision yield one success and one conflict', async () => {
  const base = revision();
  const results = await Promise.allSettled([
    (catalog.writeCatalog as Function)({ models: models.filter((m) => m.alias !== 'one') }, base),
    (catalog.writeCatalog as Function)({ models: models.filter((m) => m.alias !== 'two') }, base),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  assert.equal((await catalog.readCatalog()).models.length, 2);
});

test('B159: a stale replacement cannot restore an acknowledged deletion', async () => {
  const stale = revision();
  const current = await catalog.readCatalog();
  await (catalog.writeCatalog as Function)({ models: current.models.slice(1) }, stale);
  const accepted = readFileSync(file);
  await assert.rejects((catalog.writeCatalog as Function)({ models }, stale), /changed|revision|reload/i);
  assert.deepEqual(readFileSync(file), accepted);
});

test('B159: replacing an existing catalog without a review revision is refused', async () => {
  const accepted = readFileSync(file);
  await assert.rejects(catalog.writeCatalog({ models }), /revision|reload|review/i);
  assert.deepEqual(readFileSync(file), accepted);
});
