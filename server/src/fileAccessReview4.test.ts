import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';
const root = mkdtempSync(join(tmpdir(), 'arco-file-review-'));
installIsolatedTestHome(root);
after(() => rmSync(root, { recursive: true, force: true }));
let serial = 0;
function folder() { const p = join(root, `fixture-${++serial}`); mkdirSync(p); return p; }
function context(cwd: string) { return { cwd, abortSignal: new AbortController().signal, shells: { byId: new Map(), mintId: () => 'fixture' }, readSet: new Set<string>(), planMode: false, onTodos: () => {} }; }
test('FA4 browser content search refuses an unbound folder', async () => {
  const { tryHandleSearchRoutes } = await import('./http/searchRoutes.js');
  const cwd = folder(); writeFileSync(join(cwd, 'note.txt'), 'synthetic boundary marker');
  const req = { method: 'GET', url: `/api/search/content?wfid=unbound-fixture&path=${encodeURIComponent(cwd)}&q=synthetic`, headers: {} };
  let status = 0;
  const res = { writeHead(code: number) { status = code; }, end() {} };
  await tryHandleSearchRoutes(req as any, res as any);
  assert.equal(status, 403);
});
test('FA4 binding ignores a forged cwd and accepts a known project without a workflow', async () => {
  const { requireProjectBinding } = await import('./http/projectBinding.js');
  const { workflowCwds } = await import('./server/state.js');
  const { realpathSync } = await import('node:fs');
  const cwd = folder(), other = folder();
  workflowCwds.set('binding-fixture', cwd);
  try {
    assert.equal(await requireProjectBinding(other, 'binding-fixture'), realpathSync(cwd));
    assert.equal(await requireProjectBinding(cwd), realpathSync(cwd));
    await assert.rejects(requireProjectBinding(other));
    await assert.rejects(requireProjectBinding(cwd, 'unknown-fixture'));
  } finally { workflowCwds.delete('binding-fixture'); }
});
