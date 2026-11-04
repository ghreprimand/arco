// Workbench Expansion I2 — local ↔ remote comparison smoke.
//
// Tests the MECHANISM directly (no WS, no LLM): builds a local repo, a bare
// "remote", and a clone, then diverges them and asserts getUpstreamComparison
// + fetchRemote + getComparisonDiff report the right state. Everything is local
// (file://-style path remotes) so it runs offline.
//
// Topology:
//   bare/        — the shared remote (git init --bare)
//   work/        — a clone of bare; we add a LOCAL commit (ahead) here
//   pusher/      — a second clone; pushes a commit to bare so `work` is BEHIND
//
// Assertions:
//   1. After diverging + fetch, getUpstreamComparison(work) reports the ahead
//      commit list (local-only, to push) AND the behind commit list (remote-
//      only, to pull) with the right subjects.
//   2. getComparisonDiff(work, 'ahead'/'behind') yields the right patches.
//   3. An in-sync clone → ahead:[] behind:[].
//   4. A repo with no upstream → hasUpstream:false.
//   5. A non-git dir → isRepo:false.
//   6. fetchRemote against the local bare remote succeeds offline; a bogus
//      remote name fails cleanly (ok:false), and a flag-smuggling remote is
//      rejected without running git.
//
// Run: npm run smoke:git-compare  (no dev server needed)

import { step, assert, assertEq, summary } from './lib.js';
import {
  getUpstreamComparison,
  getComparisonDiff,
  fetchRemote,
} from '../../server/src/gitWorking.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function configIdentity(cwd: string): void {
  git(cwd, 'config', 'user.email', 'test@arco.local');
  git(cwd, 'config', 'user.name', 'arco-test');
}

async function main() {
  const cleanups: string[] = [];
  const root = mkdtempSync(join(tmpdir(), 'arco-gitcompare-'));
  cleanups.push(root);

  // ── bare remote ──
  const bare = join(root, 'bare.git');
  git(root, 'init', '-q', '--bare', bare);

  // ── work clone: the repo under test ──
  const work = join(root, 'work');
  git(root, 'clone', '-q', bare, work);
  configIdentity(work);
  writeFileSync(join(work, 'base.txt'), 'base line\n');
  git(work, 'add', 'base.txt');
  git(work, 'commit', '-q', '-m', 'base commit');
  // Push base so the branch has an upstream with a shared starting point.
  git(work, 'push', '-q', '-u', 'origin', 'HEAD');

  // ── pusher clone: produces a remote-only (behind) commit ──
  const pusher = join(root, 'pusher');
  git(root, 'clone', '-q', bare, pusher);
  configIdentity(pusher);
  writeFileSync(join(pusher, 'remote-only.txt'), 'pulled content\n');
  git(pusher, 'add', 'remote-only.txt');
  git(pusher, 'commit', '-q', '-m', 'remote only commit');
  git(pusher, 'push', '-q', 'origin', 'HEAD');

  // ── diverge work: a local-only (ahead) commit ──
  writeFileSync(join(work, 'local-only.txt'), 'pushed content\n');
  git(work, 'add', 'local-only.txt');
  git(work, 'commit', '-q', '-m', 'local only commit');

  await step('fetchRemote updates remote-tracking refs offline', async () => {
    const r = await fetchRemote(work);
    assert(r.ok, `fetch should succeed against local bare remote (got ${JSON.stringify(r)})`);
    assertEq(r.remote, 'origin', 'default remote resolves to origin');
    assert(r.fetched, 'fetched flag should be true');
  });

  await step('getUpstreamComparison reports ahead AND behind commit lists', async () => {
    const cmp = await getUpstreamComparison(work);
    assert(cmp.isRepo, 'should be a repo');
    assertEq(cmp.hasUpstream, true, 'should have an upstream after push -u');
    assert(!cmp.detached, 'not detached');
    assert(!!cmp.upstream && cmp.upstream.startsWith('origin/'), `upstream should be origin/* (got ${cmp.upstream})`);

    const ahead = cmp.ahead ?? [];
    const behind = cmp.behind ?? [];
    assertEq(ahead.length, 1, `exactly one ahead commit (got ${JSON.stringify(ahead.map((c) => c.subject))})`);
    assertEq(behind.length, 1, `exactly one behind commit (got ${JSON.stringify(behind.map((c) => c.subject))})`);
    assertEq(ahead[0].subject, 'local only commit', 'ahead = the local-only commit (to push)');
    assertEq(behind[0].subject, 'remote only commit', 'behind = the remote-only commit (to pull)');
    assert(!!ahead[0].hash && !!ahead[0].author, 'ahead commit carries hash + author');
    assert(ahead[0].ts > 0, 'ahead commit carries an author timestamp');

    assert(!!cmp.aheadDiffstat && cmp.aheadDiffstat.files >= 1, 'ahead diffstat counts the new file');
    assert(!!cmp.behindDiffstat && cmp.behindDiffstat.files >= 1, 'behind diffstat counts the new file');
  });

  await step('getComparisonDiff returns the right patch each direction', async () => {
    const aheadDiff = await getComparisonDiff(work, 'ahead');
    assert(aheadDiff.isRepo, 'ahead diff: repo');
    assert(aheadDiff.patch.includes('local-only.txt'), 'ahead diff mentions the local-only file');
    assert(aheadDiff.patch.includes('+pushed content'), 'ahead diff shows the local-only addition');
    assert(!aheadDiff.patch.includes('remote-only.txt'), 'ahead diff must NOT include remote-only changes');

    const behindDiff = await getComparisonDiff(work, 'behind');
    assert(behindDiff.isRepo, 'behind diff: repo');
    assert(behindDiff.patch.includes('remote-only.txt'), 'behind diff mentions the remote-only file');
    assert(behindDiff.patch.includes('+pulled content'), 'behind diff shows the remote-only addition');
    assert(!behindDiff.patch.includes('local-only.txt'), 'behind diff must NOT include local-only changes');
  });

  await step('in-sync clone → both lists empty', async () => {
    const sync = join(root, 'sync');
    git(root, 'clone', '-q', bare, sync);
    const cmp = await getUpstreamComparison(sync);
    assert(cmp.isRepo, 'sync: repo');
    assertEq(cmp.hasUpstream, true, 'sync: has upstream');
    assertEq((cmp.ahead ?? []).length, 0, 'sync: nothing to push');
    assertEq((cmp.behind ?? []).length, 0, 'sync: nothing to pull');
  });

  await step('no-upstream repo → hasUpstream:false', async () => {
    const solo = join(root, 'solo');
    git(root, 'init', '-q', solo);
    configIdentity(solo);
    writeFileSync(join(solo, 'a.txt'), 'alpha\n');
    git(solo, 'add', 'a.txt');
    git(solo, 'commit', '-q', '-m', 'lone commit');
    const cmp = await getUpstreamComparison(solo);
    assert(cmp.isRepo, 'solo: repo');
    assertEq(cmp.hasUpstream, false, 'solo: no upstream configured');
    assert(!cmp.detached, 'solo: on a branch, not detached');
    assert(!!cmp.branch, 'solo: reports the branch name');
  });

  await step('non-git directory degrades gracefully', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'arco-gitcompare-plain-'));
    cleanups.push(plain);
    const cmp = await getUpstreamComparison(plain);
    assertEq(cmp.isRepo, false, 'non-git: isRepo false');
    const diff = await getComparisonDiff(plain, 'ahead');
    assertEq(diff.isRepo, false, 'non-git: comparison diff isRepo false');
    assertEq(diff.patch, '', 'non-git: empty patch');
    const f = await fetchRemote(plain);
    assertEq(f.ok, false, 'non-git: fetch reports ok:false, not a throw');
  });

  await step('fetchRemote rejects unsafe / unknown remotes cleanly', async () => {
    // Flag-smuggling remote name — rejected by isSafeRemote before running git.
    const flag = await fetchRemote(work, '--upload-pack=touch /tmp/pwned');
    assertEq(flag.ok, false, 'dash-leading remote rejected');
    assert(!flag.fetched, 'no fetch performed for an unsafe remote');

    // A syntactically-valid but nonexistent remote → git errors, ok:false.
    const missing = await fetchRemote(work, 'nope');
    assertEq(missing.ok, false, 'unknown remote → ok:false');
    assertEq(missing.remote, 'nope', 'echoes the requested remote');
    assert(!!missing.error, 'carries git stderr');
  });

  for (const dir of cleanups) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  summary('I2 git-compare');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
