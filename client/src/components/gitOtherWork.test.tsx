import test from 'node:test';
import assert from 'node:assert/strict';
import { tabsAt } from './GitOtherWork';

test('tabs are matched by working directory or by an assigned task worktree', () => {
  const jobs = {
    a: { config: { name: 'Alpha', workingDirectory: '/work/main/' } },
    b: { config: { name: 'Beta', workingDirectory: 'C:\\work\\wt-x' } },
    c: { config: { name: 'Gamma', workingDirectory: '/elsewhere' } },
  };
  const ledger = { '/work/main': [{ assignee: 'c', worktree: { path: '/work/wt-y' } }, { assignee: 'zz', worktree: { path: '/work/wt-y' } }] };
  assert.deepEqual(tabsAt('/work/main', jobs, ledger), ['Alpha']);
  assert.deepEqual(tabsAt('c:/work/wt-x/', jobs, ledger), ['Beta']);
  assert.deepEqual(tabsAt('/work/wt-y', jobs, ledger), ['Gamma']);
  assert.deepEqual(tabsAt('/nowhere', jobs, ledger), []);
});
