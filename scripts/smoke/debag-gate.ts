// DEBAG sub-phase 1 — sensitivity classifier + inert gate (docs/DEBAG_PLAN.md §9.1).
//
// Headless / module-level (no live server, no API spend). The gate is fed from
// the Native worker's dispatchTool, which would need real Anthropic turns to
// drive end-to-end. Instead we exercise the EXACT decision path the worker uses
// — `evaluateGate(armed, name, input, cwd)` — and assert the `gate_required`
// payload the worker broadcasts when it returns a proposal, plus the two-
// condition firing (sensitive AND armed) and the NON-lossy signature.
//
// Run: npm run smoke:debag-gate   (no server needed)

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, assert, assertEq, summary } from './lib.js';

const CWD = '/home/operator/Projects/Archon';

async function main(): Promise<void> {
  const { evaluateGate, gateSignature, classifyGate, gateOutcome } = await import(
    '../../server/src/providers/claude-native/gateReview.js'
  );

  // Mirror worker.dispatchTool: when evaluateGate returns a proposal, build the
  // gate_required event exactly as the worker broadcasts it.
  function dispatch(
    armed: boolean,
    toolName: string,
    input: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const gate = evaluateGate(armed, toolName, input, CWD);
    if (!gate) return null;
    return {
      type: 'gate_required',
      workflowId: 'wf_test',
      gateId: 'tu_1',
      toolUseId: 'tu_1',
      toolName,
      category: gate.category,
      reason: gate.reason,
      proposedArgs: gate.proposedArgs,
      signature: gate.signature,
      createdAt: 0,
    };
  }

  await step('1.0 armed + Bash → gate_required (category bash)', () => {
    const e = dispatch(true, 'Bash', { command: 'npm test' });
    assert(e !== null, 'a sensitive call emits gate_required');
    assertEq(e!.type, 'gate_required', 'event type');
    assertEq(e!.category, 'bash', 'category');
    assert(typeof e!.signature === 'string' && (e!.signature as string).length === 16, 'signature present');
  });

  await step('1.1 armed + git push → git-destructive category', () => {
    const e = dispatch(true, 'Bash', { command: 'git push origin main' });
    assert(e !== null, 'emits');
    assertEq(e!.category, 'git-destructive', 'more-specific category wins over bash');
  });

  await step('1.2 armed + write outside cwd → write-outside-cwd', () => {
    const e = dispatch(true, 'Write', { file_path: '/etc/x', content: 'y' });
    assert(e !== null, 'emits');
    assertEq(e!.category, 'write-outside-cwd', 'category');
  });

  await step('1.3 armed + KillShell → kill-shell', () => {
    const e = dispatch(true, 'KillShell', { shell_id: 's1' });
    assert(e !== null, 'emits');
    assertEq(e!.category, 'kill-shell', 'category');
  });

  await step('1.4 armed + non-sensitive (Read) → NO gate', () => {
    assertEq(dispatch(true, 'Read', { file_path: 'README.md' }), null, 'read-only never gates');
  });

  await step('1.5 armed + in-cwd Write → NO gate', () => {
    assertEq(dispatch(true, 'Write', { file_path: 'server/src/x.ts', content: 'z' }), null, 'in-cwd write is inert');
  });

  await step('1.6 DISARMED + Bash → NO gate (two-condition AND)', () => {
    assertEq(dispatch(false, 'Bash', { command: 'rm -rf node_modules' }), null, 'safe-mode off ⇒ inert');
    // classifyGate alone still reports sensitive — arming is the second condition.
    assertEq(classifyGate('Bash', { command: 'rm -rf node_modules' }, CWD).sensitive, true, 'classifier independent of arming');
  });

  await step('1.7 signature is NON-lossy: digit-different commands differ', () => {
    // The whole point of §4.1 — outputHash would collapse these to one hash.
    const a = gateSignature('Bash', { command: 'rm -rf dir1' });
    const b = gateSignature('Bash', { command: 'rm -rf dir2' });
    assert(a !== b, 'rm -rf dir1 and dir2 must NOT share a standing-approval signature');
  });

  await step('1.8 signature is stable across arg key order', () => {
    const a = gateSignature('Edit', { file_path: '/etc/x', old_string: 'a', new_string: 'b' });
    const b = gateSignature('Edit', { new_string: 'b', file_path: '/etc/x', old_string: 'a' });
    assertEq(a, b, 'canonicalized key order → same signature (no spurious re-prompt)');
  });

  await step('1.9 proposedArgs carries the effective input verbatim', () => {
    const e = dispatch(true, 'Bash', { command: 'ls -la', timeout: 5000 });
    assert(e !== null, 'emits');
    const args = e!.proposedArgs as Record<string, unknown>;
    assertEq(args.command, 'ls -la', 'command preserved');
    assertEq(args.timeout, 5000, 'all args preserved for the operator to edit');
  });

  // ── Sub-phase 2 — resolution outcome (the branch dispatchTool takes) ───────

  await step('2.0 reject → call does NOT run, refusal tool_result', () => {
    const o = gateOutcome('reject', 'Bash', { command: 'git push' });
    assertEq(o.run, false, 'rejected call must not run');
    assertEq(o.wasEdited, false, 'reject is not an edit');
    assert(typeof o.refusalText === 'string' && o.refusalText!.includes('refused by operator review gate'), 'refusal text present');
  });

  await step('2.1 approve (no edit) → call runs with the proposed args', () => {
    const proposed = { command: 'npm test' };
    const o = gateOutcome('approve', 'Bash', proposed);
    assertEq(o.run, true, 'approved call runs');
    assertEq(o.wasEdited, false, 'no edit');
    assertEq(o.effectiveInput, proposed, 'runs the original proposal');
    assertEq(o.refusalText, undefined, 'no refusal on approve');
  });

  await step('2.2 approve with finalArgs → runs the EDITED args, wasEdited=true', () => {
    // (edit UI lands in sub-phase 3; the server-side outcome already supports it)
    const o = gateOutcome('approve', 'Bash', { command: 'rm -rf /' }, { command: 'rm -rf ./build' });
    assertEq(o.run, true, 'runs');
    assertEq(o.wasEdited, true, 'edited');
    assertEq((o.effectiveInput as Record<string, unknown>).command, 'rm -rf ./build', 'effective input is the edit');
  });

  await step('2.3 gate_resolved payload the worker would broadcast (approve)', () => {
    // Mirror the worker: evaluateGate → resolve(approve) → gateOutcome → event.
    const gate = evaluateGate(true, 'Bash', { command: 'ls' }, CWD)!;
    const o = gateOutcome('approve', 'Bash', gate.proposedArgs);
    const ev = {
      type: 'gate_resolved',
      workflowId: 'wf_test',
      gateId: 'tu_1',
      toolUseId: 'tu_1',
      toolName: 'Bash',
      decision: 'approve' as const,
      wasEdited: o.wasEdited,
      liveArgsAtFire: gate.proposedArgs,
      createdAt: 0,
    };
    assertEq(ev.type, 'gate_resolved', 'event type');
    assertEq(ev.wasEdited, false, 'unedited approve');
    assertEq((ev.liveArgsAtFire as Record<string, unknown>).command, 'ls', 'liveArgsAtFire captured for audit');
  });

  // ── Sub-phase 3 — edit-then-approve (client edit-parse, pure) ──────────────

  const { buildGateFinalArgs, renderGateArgs } = await import('../../client/src/utils/gateArgs.js');

  await step('3.0 unchanged text → undefined (plain approve, not an edit)', () => {
    const orig = renderGateArgs('Bash', { command: 'npm test' });
    assertEq(buildGateFinalArgs('Bash', orig, orig, { command: 'npm test' }), undefined, 'no edit ⇒ no finalArgs');
  });

  await step('3.1 edited Bash command → finalArgs with the new command', () => {
    const orig = renderGateArgs('Bash', { command: 'rm -rf /', timeout: 5000 });
    const fa = buildGateFinalArgs('Bash', orig, 'rm -rf ./build', { command: 'rm -rf /', timeout: 5000 });
    assert(fa !== undefined, 'edited ⇒ finalArgs');
    assertEq(fa!.command, 'rm -rf ./build', 'new command');
    assertEq(fa!.timeout, 5000, 'other args preserved');
  });

  await step('3.2 edited non-Bash args → parsed JSON object', () => {
    const orig = renderGateArgs('Write', { file_path: '/etc/x', content: 'a' });
    const edited = JSON.stringify({ file_path: '/etc/x', content: 'EDITED' }, null, 2);
    const fa = buildGateFinalArgs('Write', orig, edited, { file_path: '/etc/x', content: 'a' });
    assert(fa !== undefined, 'edited ⇒ finalArgs');
    assertEq(fa!.content, 'EDITED', 'parsed edit applied');
  });

  await step('3.3 invalid JSON edit throws (card surfaces the error, sends nothing)', () => {
    let threw = false;
    try {
      buildGateFinalArgs('Write', '{}', '{ not valid json', { file_path: '/etc/x' });
    } catch {
      threw = true;
    }
    assert(threw, 'invalid JSON must throw rather than send garbage');
  });

  await step('3.4 edit then full round-trip: buildGateFinalArgs → gateOutcome runs the edit', () => {
    const orig = renderGateArgs('Bash', { command: 'git push --force' });
    const fa = buildGateFinalArgs('Bash', orig, 'git push', { command: 'git push --force' });
    const o = gateOutcome('approve', 'Bash', { command: 'git push --force' }, fa);
    assertEq(o.run, true, 'runs');
    assertEq(o.wasEdited, true, 'wasEdited');
    assertEq((o.effectiveInput as Record<string, unknown>).command, 'git push', 'the de-escalated command runs, not the original');
  });

  // ── Sub-phase 4 — durability (the sidecar rehydrate + restart-resume read) ──

  const { recordPendingGate, readGateStore, clearPendingGate, addStandingApproval, hasStandingApproval, removeStandingApproval } = await import(
    '../../server/src/providers/claude-native/gateStore.js'
  );
  const tmpRoot = await fs.mkdtemp(join(tmpdir(), 'debag-'));
  const WFID = 'wf-debag-test';
  const rec = (gateId: string, command: string) => ({
    gateId,
    toolName: 'Bash',
    category: 'bash',
    reason: 'Bash command.',
    proposedArgs: { command },
    signature: `sig-${gateId}`,
    createdAt: 1,
  });

  await step('4.0 fresh cwd → empty store (ENOENT-safe)', async () => {
    const s = await readGateStore(tmpRoot, WFID);
    assertEq(s.pending.length, 0, 'no pending');
    assertEq(s.standing.length, 0, 'no standing');
  });

  await step('4.1 record persists a pending gate (what rehydrate re-emits)', async () => {
    await recordPendingGate(tmpRoot, WFID, rec('g1', 'npm test'));
    const s = await readGateStore(tmpRoot, WFID);
    assertEq(s.pending.length, 1, 'one pending');
    assertEq(s.pending[0].gateId, 'g1', 'gateId persisted');
    assertEq((s.pending[0].proposedArgs as Record<string, unknown>).command, 'npm test', 'args persisted across the "restart" read');
  });

  await step('4.2 record is idempotent on gateId; a second gate coexists', async () => {
    await recordPendingGate(tmpRoot, WFID, rec('g1', 'npm test')); // dup
    await recordPendingGate(tmpRoot, WFID, rec('g2', 'git push'));
    const s = await readGateStore(tmpRoot, WFID);
    assertEq(s.pending.length, 2, 'g1 not duplicated, g2 added');
  });

  await step('4.3 clear returns the record (restart-resume reads proposedArgs from it)', async () => {
    const cleared = await clearPendingGate(tmpRoot, WFID, 'g1');
    assert(cleared !== null, 'returns the cleared record');
    assertEq((cleared!.proposedArgs as Record<string, unknown>).command, 'npm test', 'orphan-resume can re-issue this command');
    const s = await readGateStore(tmpRoot, WFID);
    assertEq(s.pending.length, 1, 'only g2 left');
    assertEq(s.pending[0].gateId, 'g2', 'g2 survived');
  });

  await step('4.4 clear unknown → null (truly stale reply path)', async () => {
    assertEq(await clearPendingGate(tmpRoot, WFID, 'nope'), null, 'unknown gateId clears to null');
  });

  // ── Sub-phase 5 — scoped standing approval (live-args re-evaluation) ───────

  await step('5.0 add standing approval keyed by the non-lossy signature', async () => {
    const sig = gateSignature('Bash', { command: 'npm test' });
    await addStandingApproval(tmpRoot, WFID, { signature: sig, toolName: 'Bash', approvedAt: 1, sample: 'npm test' });
    assertEq(await hasStandingApproval(tmpRoot, WFID, sig), true, 'standing match for the exact call');
  });

  await step('5.1 a DIFFERENT command does NOT match (re-prompts) — the §4.1 guard', () => {
    // The live re-evaluation: the gate computes the live signature; a changed
    // command hashes differently, so the standing approval never green-lights it.
    const approved = gateSignature('Bash', { command: 'npm test' });
    const live = gateSignature('Bash', { command: 'npm test -- --runInBand' });
    assert(approved !== live, 'changed args ⇒ different signature ⇒ no auto-approve');
  });

  await step('5.2 add is idempotent on signature', async () => {
    const sig = gateSignature('Bash', { command: 'npm test' });
    await addStandingApproval(tmpRoot, WFID, { signature: sig, toolName: 'Bash', approvedAt: 2 });
    const s = await readGateStore(tmpRoot, WFID);
    assertEq(s.standing.filter((x) => x.signature === sig).length, 1, 'not duplicated');
  });

  await step('5.3 revoke removes it (operator list + revoke)', async () => {
    const sig = gateSignature('Bash', { command: 'npm test' });
    assertEq(await removeStandingApproval(tmpRoot, WFID, sig), true, 'revoked');
    assertEq(await hasStandingApproval(tmpRoot, WFID, sig), false, 'no longer auto-approves');
    assertEq(await removeStandingApproval(tmpRoot, WFID, sig), false, 'revoking again is a no-op');
  });

  await fs.rm(tmpRoot, { recursive: true, force: true });

  summary('debag-gate');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
