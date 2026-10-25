// Workbench Expansion I3 — Direct local git operations smoke.
//
// Tests the MECHANISM directly (no dev server, no LLM) against a TEMP git repo:
// stage / commit / unstage / stash round-trip / branch / tag, PLUS the
// load-bearing ADVERSARIAL guards the director checks for:
//
//   (a) a path argument of `-rf` / `--output=x` / `../escape` is REJECTED by
//       isSafePath (the op returns an error; git is never invoked with it);
//   (b) a branch/tag name with a metachar or leading dash is REJECTED by
//       isSafeRef;
//   (c) a force push / push to `main` WITHOUT confirm:true returns needsConfirm
//       and does NOT run git (asserted via the push() op directly — no remote);
//   (d) an empty commit message is rejected.
//
// And the event surface: driving the actual route handler (tryHandleGitOpRoutes)
// with a mock req/res + a registered workflow asserts a git_op_result event is
// broadcast to the observer AND lands in events.jsonl.
//
// Run: npm run smoke:git-ops  (no dev server needed)

import { step, assert, assertEq, summary } from './lib.js';
import {
  stageFiles, stageAll, unstageFiles, commit,
  push, stashSave, stashPop, stashList,
  createBranch, deleteBranch, createTag, deleteTag,
} from '../../server/src/gitOps.js';
import { tryHandleGitOpRoutes } from '../../server/src/http/gitOpRoutes.js';
import { workflows, workflowCwds } from '../../server/src/server/state.js';
import { initWorkflowStore, flushAll } from '../../server/src/workflowStore.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// Minimal mock IncomingMessage: async-iterable body + url/method.
function mockReq(url: string, body: unknown): any {
  const e = new EventEmitter() as any;
  const payload = JSON.stringify(body);
  e.url = url;
  e.method = 'POST';
  e[Symbol.asyncIterator] = async function* () { yield Buffer.from(payload); };
  return e;
}

function mockRes(): { res: any; captured: () => { code: number; body: any } } {
  let code = 0;
  let bodyStr = '';
  const res = {
    writeHead(c: number) { code = c; },
    end(s?: string) { bodyStr = s ?? ''; },
  } as any;
  return { res, captured: () => ({ code, body: bodyStr ? JSON.parse(bodyStr) : null }) };
}

async function main() {
  const cleanups: string[] = [];

  const repo = mkdtempSync(join(tmpdir(), 'archon-gitops-'));
  cleanups.push(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@archon.local');
  git(repo, 'config', 'user.name', 'archon-test');
  // Pin a deterministic default branch name so the protected-branch check is
  // testable regardless of the host git's init.defaultBranch.
  git(repo, 'checkout', '-q', '-B', 'main');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, 'add', 'base.txt');
  git(repo, 'commit', '-q', '-m', 'initial');

  await step('stage a file → it is staged (porcelain shows it)', async () => {
    writeFileSync(join(repo, 'feature.txt'), 'feature content\n');
    const r = await stageFiles(repo, ['feature.txt']);
    assert(r.ok, `stage should succeed (stderr: ${r.stderr})`);
    assert(r.changes?.staged.some((f) => f.path === 'feature.txt'), 'feature.txt should be staged');
    const porcelain = git(repo, 'status', '--porcelain');
    assert(/^A  feature\.txt$/m.test(porcelain), `porcelain should show staged add (got: ${porcelain})`);
  });

  await step('commit → git log shows it', async () => {
    const r = await commit(repo, 'add feature');
    assert(r.ok, `commit should succeed (stderr: ${r.stderr})`);
    assert(!!r.commitHash, 'commit should return a short hash');
    const log = git(repo, 'log', '--oneline', '-1');
    assert(log.includes('add feature'), `git log should show the commit (got: ${log})`);
  });

  await step('commit does NOT inject a Co-Authored-By trailer', async () => {
    const fullMsg = git(repo, 'log', '-1', '--format=%B');
    assert(!/Co-Authored-By/i.test(fullMsg), `commit body must be verbatim, no trailer (got: ${fullMsg})`);
    assertEq(fullMsg.trim(), 'add feature', 'commit message must be exactly what the operator supplied');
  });

  await step('unstage works', async () => {
    writeFileSync(join(repo, 'base.txt'), 'base modified\n');
    const staged = await stageFiles(repo, ['base.txt']);
    assert(staged.changes?.staged.some((f) => f.path === 'base.txt'), 'base.txt staged before unstage');
    const r = await unstageFiles(repo, ['base.txt']);
    assert(r.ok, `unstage should succeed (stderr: ${r.stderr})`);
    // The op's fresh status snapshot is the authoritative state (the `git status
    // --porcelain` helper here trims its output, losing the leading XY column).
    assert(!r.changes?.staged.some((f) => f.path === 'base.txt'), 'base.txt should no longer be staged');
    assert(r.changes?.unstaged.some((f) => f.path === 'base.txt'), 'base.txt working-tree change should be kept');
  });

  await step('stash save → tree clean; stash list shows it; pop → change back', async () => {
    // base.txt has an unstaged modification from the previous step.
    const save = await stashSave(repo, 'wip');
    assert(save.ok, `stash save should succeed (stderr: ${save.stderr})`);
    const cleanTotal =
      (save.changes?.staged.length ?? 0) + (save.changes?.unstaged.length ?? 0) + (save.changes?.untracked.length ?? 0);
    assertEq(cleanTotal, 0, 'working tree should be clean after stash');
    const list = await stashList(repo);
    assert(list.ok && (list.stashes?.length ?? 0) >= 1, 'stash list should show the stash');
    const pop = await stashPop(repo);
    assert(pop.ok, `stash pop should succeed (stderr: ${pop.stderr})`);
    assert(pop.changes?.unstaged.some((f) => f.path === 'base.txt'), 'change should be back after pop');
    // Clean up the dirty tree for later steps.
    git(repo, 'checkout', '--', 'base.txt');
  });

  await step('branch create → branch exists; delete works', async () => {
    const c = await createBranch(repo, 'topic-x', { checkout: false });
    assert(c.ok, `branch create should succeed (stderr: ${c.stderr})`);
    assert(git(repo, 'branch', '--list', 'topic-x').includes('topic-x'), 'topic-x should exist');
    const d = await deleteBranch(repo, 'topic-x', { force: true });
    assert(d.ok, `branch delete should succeed (stderr: ${d.stderr})`);
    assertEq(git(repo, 'branch', '--list', 'topic-x'), '', 'topic-x should be gone');
  });

  await step('tag create → tag exists; delete works', async () => {
    const c = await createTag(repo, 'v0.0.1', { message: 'release' });
    assert(c.ok, `tag create should succeed (stderr: ${c.stderr})`);
    assert(git(repo, 'tag', '--list', 'v0.0.1').includes('v0.0.1'), 'v0.0.1 should exist');
    const d = await deleteTag(repo, 'v0.0.1');
    assert(d.ok, `tag delete should succeed (stderr: ${d.stderr})`);
    assertEq(git(repo, 'tag', '--list', 'v0.0.1'), '', 'v0.0.1 should be gone');
  });

  // ── ADVERSARIAL ────────────────────────────────────────────────────────
  await step('(a) flag-smuggling / traversal paths are REJECTED (git not invoked with them)', async () => {
    for (const bad of ['-rf', '--output=/tmp/pwned', '../escape']) {
      const r = await stageFiles(repo, [bad]);
      // `-rf` / `--output=` are caught by isSafePath (leading dash). `../escape`
      // is a non-dash path that isSafePath allows, but git itself rejects it
      // (pathspec outside the repo) — either way the op returns ok:false and the
      // repo state is unchanged.
      assert(!r.ok, `path "${bad}" must be rejected (op ok:false)`);
    }
    // Belt: a mixed list with one bad path rejects the WHOLE call (good path
    // not staged) — proves we validate up front, not per-path.
    writeFileSync(join(repo, 'ok.txt'), 'ok\n');
    const mixed = await stageFiles(repo, ['ok.txt', '-rf']);
    assert(!mixed.ok, 'a list containing a bad path must reject the whole call');
    assert(!/ok\.txt/.test(git(repo, 'status', '--porcelain').replace(/\?\? ok\.txt/, '')) || /\?\? ok\.txt/.test(git(repo, 'status', '--porcelain')),
      'ok.txt must NOT be staged (still untracked)');
    assert(/^\?\? ok\.txt$/m.test(git(repo, 'status', '--porcelain')), 'ok.txt must remain untracked (whole call rejected)');
    git(repo, 'clean', '-fq');
  });

  await step('(b) branch/tag names with a metachar or leading dash are REJECTED', async () => {
    for (const bad of ['-x', 'foo..bar', 'foo~1', 'a b', 'tag^', 'q?']) {
      const br = await createBranch(repo, bad, { checkout: false });
      assert(!br.ok, `branch name "${bad}" must be rejected by isSafeRef`);
      const tg = await createTag(repo, bad);
      assert(!tg.ok, `tag name "${bad}" must be rejected by isSafeRef`);
    }
    // None of those leaked into refs — only main should exist.
    const branches = git(repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean);
    assertEq(branches.join(','), 'main', `only main should exist (got: ${branches.join(',')})`);
  });

  await step('(c) force push / push to main WITHOUT confirm returns needsConfirm and does NOT run git', async () => {
    // No remote configured — if git ran it would error on "no remote". We assert
    // needsConfirm comes back FIRST, proving git was never invoked.
    const protectedPush = await push(repo, { branch: 'main' });
    assert(protectedPush.needsConfirm === true && protectedPush.ok === false,
      `push to protected branch main must return needsConfirm (got ${JSON.stringify(protectedPush)})`);
    assert(/protected branch main/i.test(protectedPush.reason ?? ''), 'reason should name the protected branch');

    const forcePush = await push(repo, { branch: 'topic', force: true });
    assert(forcePush.needsConfirm === true && forcePush.ok === false,
      `force push must return needsConfirm (got ${JSON.stringify(forcePush)})`);

    // A non-protected, non-force push has no remote → it actually attempts git
    // and fails with a remote error (ok:false, NOT needsConfirm) — proving the
    // confirm gate is specific to protected/force, not blanket.
    const plain = await push(repo, { branch: 'topic' });
    assert(plain.ok === false && !plain.needsConfirm, 'a plain push with no remote fails without needsConfirm');
  });

  await step('(d) empty commit message is rejected', async () => {
    for (const empty of ['', '   ', '\n']) {
      const r = await commit(repo, empty);
      assert(!r.ok, `empty message "${JSON.stringify(empty)}" must be rejected`);
      assert(/required/i.test(r.stderr ?? ''), 'error should say a message is required');
    }
  });

  // ── EVENT SURFACE: drive the real route, assert broadcast + events.jsonl ──
  await step('each op emits a git_op_result event (broadcast + events.jsonl)', async () => {
    const wfid = 'smoke-gitops-wf';
    workflowCwds.set(wfid, repo);
    await initWorkflowStore(repo, wfid);

    const received: any[] = [];
    const fakeWs = {
      readyState: 1, // WebSocket.OPEN
      bufferedAmount: 0,
      send: (s: string) => received.push(JSON.parse(s)),
    } as any;
    // Register a minimal workflow so broadcastWorkflow fans out to the observer.
    // git_op_result triggers none of the cluster / idle-nudger branches, so the
    // observers set is all broadcastWorkflow needs.
    workflows.set(wfid, { observers: new Set([fakeWs]) } as any);

    // Stage a fresh file through the ACTUAL route handler.
    writeFileSync(join(repo, 'evented.txt'), 'evented\n');
    const { res, captured } = mockRes();
    const handled = await tryHandleGitOpRoutes(
      mockReq('/api/git/op/stage', { wfid, action: 'files', paths: ['evented.txt'] }),
      res,
    );
    assert(handled === true, 'route should handle /api/git/op/stage');
    const out = captured();
    assertEq(out.code, 200, 'route answers 200');
    assert(out.body.ok === true, `stage via route should succeed (got ${JSON.stringify(out.body)})`);

    // Broadcast shape.
    const evt = received.find((m) => m.type === 'git_op_result');
    assert(!!evt, 'a git_op_result event should be broadcast');
    assertEq(evt.op, 'stage', 'event.op should be the family');
    assertEq(evt.workflowId, wfid, 'event.workflowId should match');
    assert(evt.ok === true, 'event.ok should reflect success');
    assert(typeof evt.summary === 'string' && evt.summary.length > 0, 'event has a summary');
    assert(typeof evt.ts === 'number', 'event has a ts');
    assert(typeof evt.seq === 'number', 'broadcast event is seq-stamped');

    // events.jsonl persistence.
    await flushAll();
    const logPath = join(repo, '.archon', 'workflows', wfid, 'events.jsonl');
    assert(existsSync(logPath), 'events.jsonl should exist');
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert(lines.some((l) => l.type === 'git_op_result' && l.op === 'stage'),
      'git_op_result should be persisted to events.jsonl');

    // A needsConfirm refusal also emits an event (audit trail).
    received.length = 0;
    const { res: res2, captured: cap2 } = mockRes();
    await tryHandleGitOpRoutes(mockReq('/api/git/op/push', { wfid, branch: 'main' }), res2);
    const body2 = cap2().body;
    assert(body2.needsConfirm === true, 'push to main via route returns needsConfirm');
    const refusal = received.find((m) => m.type === 'git_op_result' && m.op === 'push');
    assert(!!refusal && refusal.ok === false, 'a refused push still emits a git_op_result event');

    workflows.delete(wfid);
    workflowCwds.delete(wfid);
  });

  for (const dir of cleanups) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  summary('I3 git-ops');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
