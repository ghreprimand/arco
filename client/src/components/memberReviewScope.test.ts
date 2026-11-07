import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';
import { memberReviewScopeSupported } from '../utils/memberReviewScope.js';

test('B188: member routing refuses scopes it cannot resolve instead of substituting the whole plan', async () => {
  const source = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('  const buildClusterReviewTask =');
  const end = source.indexOf('\n  };', start) + '\n  };'.length;
  const output = await transform(`${source.slice(start, end)}\nmodule.exports=buildClusterReviewTask;`, { loader: 'ts', format: 'cjs' });
  const store = { jobs: { target: { messages: [{ role: 'user', content: 'Latest question' }, { role: 'assistant', content: 'Latest answer' }] } }, clusters: { cluster: { members: [{ workflowId: 'target', displayName: 'Target' }], plan: { body: '### First\n- [ ] one\n### Second\n- [ ] two' } } } };
  const module = { exports: undefined as unknown as (id: string, ref: unknown, diff: boolean) => string | null };
  new Function('module', 'useAppStore', 'activeClusterIdForWorkflow', 'memberReviewScopeSupported', output.code)(module, { getState: () => store }, () => 'cluster', memberReviewScopeSupported);
  for (const kind of ['plan-whole', 'plan-phase', 'plan-items', 'cluster-plan-whole', 'cluster-plan-phase', 'current-session', 'since-event', 'full', 'git-diff']) {
    assert.equal(module.exports('target', { kind, mode: 'verify', phaseIndex: 1, eventSeq: 10 }, false), null, kind);
  }
  assert.match(module.exports('target', { kind: 'last-turn' }, false) ?? '', /Latest question/);
});
