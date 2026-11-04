// Conversation purge smoke (Phase D). Exercises purgeWorkflow() directly against
// throwaway temp workflows — no dev server. Asserts the load-bearing tier
// difference:
//
//   arco  → the workflow dir tree is deleted, but the bound provider session
//             file (~/.claude/projects/…) is KEPT.
//   nuclear → the workflow dir AND the provider session file are deleted.
//
// Isolation: each case uses its own mkdtemp cwd; the Claude session file lives
// under ~/.claude/projects/<encoded-temp-cwd>/ (a path derived from the temp dir,
// so it can't collide with real sessions) and is cleaned up. handleRemoveWorkflow
// is a no-op for these never-loaded workflows; recall .delete() touches no real
// rows (fake wfids).
//
// Run: npm run smoke:purge

import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { step, assert, assertEq, summary } from './lib.js';
import { purgeWorkflow } from '../../server/src/workflows/purgeWorkflow.js';
import { encodeProjectDir } from '../../server/src/http/fileRead.js';

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function seed(wfid: string, sessionId: string): Promise<{ cwd: string; wfDir: string; sessionFile: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-purge-'));
  const wfDir = join(cwd, '.arco', 'workflows', wfid);
  await mkdir(join(wfDir, 'artifacts'), { recursive: true });
  await writeFile(join(wfDir, 'meta.json'), JSON.stringify({
    workflowId: wfid, name: 'Purge Test', cwd, createdAt: 1, lastActiveAt: 1,
    primaryProvider: 'claude', primaryModel: 'claude-opus-4-8', primaryEffort: 'high',
    cliSessions: [{ provider: 'claude', sessionId }],
  }));
  await writeFile(join(wfDir, 'events.jsonl'), '{"type":"user_message_echo","content":"hi"}\n');
  await writeFile(join(wfDir, 'artifacts', 'review-1.md'), '# review\n');
  // The provider session file at the exact path purgeWorkflow computes.
  const projDir = join(homedir(), '.claude', 'projects', encodeProjectDir(cwd));
  await mkdir(projDir, { recursive: true });
  const sessionFile = join(projDir, `${sessionId}.jsonl`);
  await writeFile(sessionFile, '{"type":"user"}\n');
  return { cwd, wfDir, sessionFile };
}

async function main() {
  await step('arco tier: deletes the workflow dir, KEEPS the provider session file', async () => {
    const wfid = 'purge-arco-1111';
    const { cwd, wfDir, sessionFile } = await seed(wfid, 'sess-arco-aaaa');
    const res = await purgeWorkflow(cwd, wfid, { nuclear: false });
    assert(res.ok, `purge ok (${res.error ?? ''})`);
    assertEq(await exists(wfDir), false, 'workflow dir deleted');
    assert(res.removed.includes('workflow dir'), 'removed list mentions workflow dir');
    assertEq(await exists(sessionFile), true, 'provider session file KEPT on arco tier');
    await rm(cwd, { recursive: true, force: true });
    await rm(join(homedir(), '.claude', 'projects', encodeProjectDir(cwd)), { recursive: true, force: true });
  });

  await step('nuclear tier: deletes the workflow dir AND the provider session file', async () => {
    const wfid = 'purge-nuclear-2222';
    const { cwd, wfDir, sessionFile } = await seed(wfid, 'sess-nuclear-bbbb');
    const res = await purgeWorkflow(cwd, wfid, { nuclear: true });
    assert(res.ok, `purge ok (${res.error ?? ''})`);
    assertEq(await exists(wfDir), false, 'workflow dir deleted');
    assertEq(await exists(sessionFile), false, 'provider session file DELETED on nuclear tier');
    await rm(cwd, { recursive: true, force: true });
    await rm(join(homedir(), '.claude', 'projects', encodeProjectDir(cwd)), { recursive: true, force: true });
  });

  await step('purge of an absent workflow is a safe no-op (ok, nothing removed beyond best-effort)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'arco-purge-'));
    const res = await purgeWorkflow(cwd, 'purge-absent-3333', { nuclear: false });
    assert(res.ok, 'purge of absent workflow still returns ok (rm force)');
    await rm(cwd, { recursive: true, force: true });
  });

  summary('Phase D — conversation purge');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
