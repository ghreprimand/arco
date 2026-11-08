import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installIsolatedTestHome } from './testSupport/isolatedHome.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'arco-plan-list-')));
installIsolatedTestHome(root);

test('100 plan summaries load within one second and counts follow edits and unsafe replacements', async t => {
  const { listPlansWithTaskCounts } = await import('./planStore.js');
  const { requireProjectBinding } = await import('./http/projectBinding.js');
  const { workflowCwds } = await import('./server/state.js');
  const cwd = join(root, 'project'), dir = join(cwd, '.arco', 'plans');
  mkdirSync(dir, { recursive: true });
  const plans = Array.from({ length: 100 }, (_, i) => ({ id: `plan-${i}`, title: `Plan ${i}`, createdAt: i, updatedAt: i }));
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ plans }));
  for (const plan of plans) writeFileSync(join(dir, `${plan.id}.md`), '- [ ] First\n  - [x] Nested');
  workflowCwds.set('plan-performance', cwd);
  try {
    const start = performance.now();
    await requireProjectBinding(cwd);
    const listed = await listPlansWithTaskCounts(cwd);
    const elapsed = performance.now() - start;
    assert.equal(listed.length, 100);
    assert.ok(listed.every(plan => plan.taskCount === 2));
    assert.ok(elapsed < 1000, `100-plan listing took ${elapsed.toFixed(1)} ms`);
    t.diagnostic(`100 plans: ${elapsed.toFixed(1)} ms`);
    writeFileSync(join(dir, 'plan-0.md'), '- [X] Changed');
    assert.equal((await listPlansWithTaskCounts(cwd)).find(p => p.id === 'plan-0')?.taskCount, 1);
    const outside = join(root, 'outside.md'); writeFileSync(outside, '- [ ] Outside');
    rmSync(join(dir, 'plan-0.md'));
    try { symlinkSync(outside, join(dir, 'plan-0.md')); }
    catch { t.diagnostic('File symlinks unavailable'); return; }
    assert.equal((await listPlansWithTaskCounts(cwd)).find(p => p.id === 'plan-0')?.taskCount, null);
    await assert.rejects(requireProjectBinding(join(root, 'unregistered')));
  } finally { workflowCwds.delete('plan-performance'); rmSync(root, { recursive: true, force: true }); }
});
