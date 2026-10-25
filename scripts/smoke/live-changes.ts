// Live workspace changes smoke.
//
// Covers the WS subscription path added for the FILES/LIVE tab:
//   1. Create a workflow in a temp git repo.
//   2. Subscribe to live_changes for that workflow/cwd.
//   3. Mutate tracked + untracked files.
//   4. Assert live_changes_snapshot reports the actual working-tree status.
//
// Run with Arco server up:
//   npm run smoke:live-changes

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, step, assert, summary } from './lib.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-live-changes-'));
  console.log(`Live changes smoke - cwd ${cwd}`);
  console.log('');

  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'test@arco.local');
  git(cwd, 'config', 'user.name', 'arco-test');
  writeFileSync(join(cwd, '.gitignore'), '.arco/\n');
  writeFileSync(join(cwd, 'tracked.txt'), 'base\n');
  git(cwd, 'add', '.gitignore', 'tracked.txt');
  git(cwd, 'commit', '-q', '-m', 'initial');

  const c = await connect();
  let workflowId = '';

  await step('create workflow for live changes cwd', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'Smoke Live Changes',
        primaryProvider: 'claude',
        primaryModel: 'claude-opus-4-7',
        primaryEffort: 'normal',
        skipPermissions: true,
        workingDirectory: cwd,
        claudeTransport: 'native',
      },
    });
    const created = await c.waitFor((m) => m.type === 'workflow_created', 8000, 'workflow_created');
    workflowId = created.workflowId as string;
    assert(workflowId.length > 0, 'workflowId returned');
  });

  await step('subscribe receives an initial clean snapshot', async () => {
    c.send({ type: 'live_changes_subscribe', workflowId, cwd });
    const snap = await c.waitFor(
      (m) => m.type === 'live_changes_snapshot' && m.workflowId === workflowId,
      5000,
      'initial live_changes_snapshot',
    ) as { data: { isRepo: boolean; staged: unknown[]; unstaged: unknown[]; untracked: unknown[] } };
    assert(snap.data.isRepo, 'snapshot is a git repo');
    assert(snap.data.staged.length === 0, 'initial staged clean');
    assert(snap.data.unstaged.length === 0, 'initial unstaged clean');
    assert(snap.data.untracked.length === 0, 'initial untracked clean');
  });

  await step('tracked edit appears in live snapshot', async () => {
    writeFileSync(join(cwd, 'tracked.txt'), 'changed\n');
    const snap = await c.waitFor(
      (m) => {
        if (m.type !== 'live_changes_snapshot' || m.workflowId !== workflowId) return false;
        const data = m.data as { unstaged?: Array<{ path: string }> };
        return data.unstaged?.some((f) => f.path === 'tracked.txt') === true;
      },
      5000,
      'live snapshot with tracked edit',
    );
    assert(snap, 'tracked edit snapshot observed');
  });

  await step('untracked file appears in live snapshot', async () => {
    writeFileSync(join(cwd, 'new-level.json'), '{"rooms":[]}\n');
    const snap = await c.waitFor(
      (m) => {
        if (m.type !== 'live_changes_snapshot' || m.workflowId !== workflowId) return false;
        const data = m.data as { untracked?: Array<{ path: string }> };
        return data.untracked?.some((f) => f.path === 'new-level.json') === true;
      },
      5000,
      'live snapshot with untracked file',
    );
    assert(snap, 'untracked snapshot observed');
  });

  await step('unsubscribe is accepted', async () => {
    c.send({ type: 'live_changes_unsubscribe', workflowId, cwd });
    c.send({ type: 'remove_workflow', workflowId });
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  await c.close();
  rmSync(cwd, { recursive: true, force: true });
  summary('live-changes');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
