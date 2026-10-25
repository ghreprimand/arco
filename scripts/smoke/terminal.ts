// WORKBENCH_EXPANSION §K1/§K2 — operator PTY smoke.
//
// Drives PtyManager DIRECTLY (no WS, no LLM) and asserts the load-bearing
// behaviors:
//   1. spawn → write('echo hi\n') → output contains `hi`.
//   2. detach: the child shell is STILL ALIVE after a window detaches
//      (session ≠ connection — THE acceptance criterion).
//   3. re-attach: scrollback replays the prior output.
//   4. cwd guard: spawn with a cwd that escapes the workflow root is REFUSED
//      and no shell is spawned.
//   5. kill: the child is reaped (session gone, child not alive).
//   §K2:
//   6. multi-listener: TWO listeners on one session both receive output.
//   7. two sessions in one workflow run INDEPENDENTLY; both survive detach;
//      killForWorkflow reaps BOTH.
//   8. labels are distinct (`shell 1` / `shell 2`); infoForWorkflow lists them.
//   9. orphan registry round-trip: a registered pid is reaped by the boot
//      sweep and the registry ends empty.
//
// Run: npm run smoke:terminal  (no dev server needed)

import { step, assert, summary } from './lib.js';
import { PtyManager, reapOrphanTerminals } from '../../server/src/terminal/ptyManager.js';
import {
  registerTerminalPid,
  readRegisteredTerminalPids,
  clearRegisteredTerminalPids,
} from '../../server/src/terminal/ptyPidRegistry.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn as spawnProc } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Is a pid still alive? signal 0 probes without delivering a signal.
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Poll until predicate or timeout — PTY output is async.
async function waitUntil(pred: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'arco-term-'));
  const mgr = new PtyManager();
  const wfid = 'wf-smoke';

  let sessionId = '';
  let pid = 0;

  await step('spawn → echo → output contains hi', async () => {
    const session = mgr.spawn(wfid, root);
    sessionId = session.id;
    pid = session.proc.pid;
    let buf = '';
    mgr.attach(session.id, (d) => { buf += d; });
    mgr.write(session.id, 'echo hi\n');
    const ok = await waitUntil(() => /hi/.test(buf));
    assert(ok, `expected "hi" in output, got: ${JSON.stringify(buf.slice(-120))}`);
  });

  await step('detach: child shell stays alive (session ≠ connection)', async () => {
    mgr.detach(sessionId);
    // Detach must NOT reap the shell. Give it a beat, then assert the pid lives.
    await new Promise((r) => setTimeout(r, 150));
    assert(alive(pid), `child pid ${pid} should still be alive after detach`);
    assert(mgr.get(sessionId) !== undefined, 'session should still exist after detach');
  });

  await step('re-attach: scrollback replays prior output', async () => {
    const replay = mgr.attach(sessionId, () => { /* noop */ });
    assert(replay !== null, 're-attach should succeed on a live session');
    assert(/hi/.test(replay!.scrollback), `scrollback should replay "hi", got: ${JSON.stringify(replay!.scrollback.slice(-120))}`);
  });

  await step('cwd guard: escaping cwd is refused, no shell spawned', async () => {
    let threw = false;
    try {
      mgr.spawn(wfid, root, '../outside');
    } catch {
      threw = true;
    }
    assert(threw, 'spawn with escaping cwd must throw');
    // Only the one legit session should exist for this workflow.
    assert(mgr.listForWorkflow(wfid).length === 1, 'no extra session should have been created on the rejected spawn');
  });

  await step('kill: child reaped', async () => {
    mgr.kill(sessionId);
    const dead = await waitUntil(() => !alive(pid));
    assert(dead, `child pid ${pid} should be reaped after kill`);
    assert(mgr.get(sessionId) === undefined, 'session should be gone after kill');
  });

  // ── §K2 ──

  await step('multi-listener: two listeners on one session both get output', async () => {
    const s = mgr.spawn(wfid, root);
    let a = '';
    let b = '';
    const da = mgr.attach(s.id, (d) => { a += d; });
    const db = mgr.attach(s.id, (d) => { b += d; });
    assert(da !== null && db !== null, 'both attaches should succeed');
    mgr.write(s.id, 'echo multi\n');
    const ok = await waitUntil(() => /multi/.test(a) && /multi/.test(b));
    assert(ok, `both listeners should receive "multi" — a=${JSON.stringify(a.slice(-60))} b=${JSON.stringify(b.slice(-60))}`);
    // Disposing ONE listener must leave the other receiving.
    da!.dispose();
    b = '';
    mgr.write(s.id, 'echo again\n');
    const ok2 = await waitUntil(() => /again/.test(b));
    assert(ok2, 'remaining listener should still receive after the other disposed');
    mgr.kill(s.id);
  });

  let s1Pid = 0;
  let s2Pid = 0;
  let s1Id = '';
  let s2Id = '';

  await step('two sessions: distinct labels + independent output', async () => {
    const s1 = mgr.spawn(wfid, root);
    const s2 = mgr.spawn(wfid, root);
    s1Id = s1.id; s2Id = s2.id; s1Pid = s1.proc.pid; s2Pid = s2.proc.pid;
    assert(s1.id !== s2.id, 'two sessions must have distinct ids');
    assert(s1.label !== s2.label, `labels must differ, got ${s1.label} / ${s2.label}`);
    const info = mgr.infoForWorkflow(wfid);
    assert(info.length === 2, `infoForWorkflow should list 2 sessions, got ${info.length}`);
    // Independent: write to s1 only; s2's buffer must NOT see it.
    let b1 = '';
    let b2 = '';
    mgr.attach(s1.id, (d) => { b1 += d; });
    mgr.attach(s2.id, (d) => { b2 += d; });
    mgr.write(s1.id, 'echo one_only\n');
    const ok = await waitUntil(() => /one_only/.test(b1));
    assert(ok, 's1 should see its own output');
    assert(!/one_only/.test(b2), 's2 must NOT see s1 output (independent sessions)');
  });

  await step('two sessions: both survive detach (session ≠ connection)', async () => {
    mgr.detach(s1Id);
    mgr.detach(s2Id);
    await new Promise((r) => setTimeout(r, 150));
    assert(alive(s1Pid), 's1 child should still be alive after detach');
    assert(alive(s2Pid), 's2 child should still be alive after detach');
  });

  await step('killForWorkflow: BOTH sessions reaped', async () => {
    const killed = mgr.killForWorkflow(wfid);
    assert(killed.length === 2, `killForWorkflow should report 2 killed, got ${killed.length}`);
    const dead = await waitUntil(() => !alive(s1Pid) && !alive(s2Pid));
    assert(dead, 'both children should be reaped after killForWorkflow');
    assert(mgr.listForWorkflow(wfid).length === 0, 'no sessions should remain for the workflow');
  });

  await step('orphan registry: boot sweep SIGKILLs a stale pid + clears file', async () => {
    // Simulate a leaked PTY child from a prior crashed run: a real long-lived
    // process whose pid we register, then run the boot sweep and assert it's
    // reaped and the registry is empty. Uses `sleep` (POSIX, no shell string).
    clearRegisteredTerminalPids();
    const child = spawnProc('sleep', ['30'], { stdio: 'ignore' });
    const orphanPid = child.pid!;
    registerTerminalPid(orphanPid);
    assert(readRegisteredTerminalPids().includes(orphanPid), 'pid should be registered');
    reapOrphanTerminals();
    const dead = await waitUntil(() => !alive(orphanPid));
    assert(dead, `orphan pid ${orphanPid} should be SIGKILLed by the boot sweep`);
    assert(readRegisteredTerminalPids().length === 0, 'registry should be cleared after the sweep');
  });

  rmSync(root, { recursive: true, force: true });
  summary('terminal');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
