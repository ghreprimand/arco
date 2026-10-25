// Unit tests for §3.1 — the stuck-worker breaker (deterministic core).
//
// Contracts:
//  • a failing signature recurring DETECT_AT× → 'nudge' (once);
//  • continuing to ESCALATE_AT× → 'pause' (once), latched;
//  • a success interleaved resets the streak and clears the latch ('recovered');
//  • a DIFFERENT signature (progress) breaks the streak — never trips;
//  • a failing call with no outputHash is treated as a streak-breaker;
//  • the singleton isolates workflows and clears on an operator turn.
//
// Run: node --conditions development --import tsx --test src/workers/stuckBreaker.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  step,
  observe,
  isPaused,
  clearOnOperatorTurn,
  dispose,
  DETECT_AT,
  ESCALATE_AT,
} from './stuckBreaker.js';

function freshState() {
  return { lastSig: null as string | null, streak: 0, nudged: false, paused: false };
}

const fail = (outputHash = 'h1') => ({ toolName: 'Bash', inputHash: 'i1', outputHash, failing: true });
const ok = () => ({ toolName: 'Bash', inputHash: 'i1', outputHash: 'h2', failing: false });

test('nudge fires once at DETECT_AT', () => {
  const s = freshState();
  let v;
  const actions: string[] = [];
  for (let i = 0; i < DETECT_AT; i++) { v = step(s, fail()); actions.push(v.action); }
  assert.equal(v!.action, 'nudge');
  assert.equal(v!.streak, DETECT_AT);
  // only one nudge across the run
  assert.equal(actions.filter((a) => a === 'nudge').length, 1);
});

test('pause fires once at ESCALATE_AT and latches', () => {
  const s = freshState();
  let v;
  for (let i = 0; i < ESCALATE_AT; i++) v = step(s, fail());
  assert.equal(v!.action, 'pause');
  assert.equal(v!.paused, true);
  // subsequent identical failures stay paused but don't re-emit 'pause'
  v = step(s, fail());
  assert.equal(v.action, 'none');
  assert.equal(v.paused, true);
});

test('success interleaved resets the streak (no trip)', () => {
  const s = freshState();
  step(s, fail());
  step(s, fail());
  const r = step(s, ok());
  assert.equal(r.action, 'none');
  assert.equal(r.streak, 0);
  // streak restarts from 1 afterwards
  const after = step(s, fail());
  assert.equal(after.streak, 1);
});

test('success after a pause reports recovered + clears the latch', () => {
  const s = freshState();
  for (let i = 0; i < ESCALATE_AT; i++) step(s, fail());
  assert.equal(s.paused, true);
  const r = step(s, ok());
  assert.equal(r.action, 'recovered');
  assert.equal(r.paused, false);
});

test('a different signature breaks the streak (progress)', () => {
  const s = freshState();
  step(s, fail('h1'));
  step(s, fail('h1'));
  // output changes → progress → streak resets to 1
  const r = step(s, fail('h2'));
  assert.equal(r.streak, 1);
  assert.equal(r.action, 'none');
});

test('failing call with no outputHash is a streak-breaker, never accuses', () => {
  const s = freshState();
  for (let i = 0; i < ESCALATE_AT + 2; i++) {
    const r = step(s, { toolName: 'Bash', inputHash: 'i1', failing: true });
    assert.equal(r.action, 'none');
    assert.equal(r.streak, 0);
  }
});

test('different input does not cross-contaminate the streak', () => {
  const s = freshState();
  for (let i = 0; i < ESCALATE_AT; i++) {
    const r = step(s, { toolName: 'Bash', inputHash: `i${i}`, outputHash: 'h1', failing: true });
    assert.equal(r.action, 'none', `varying input call ${i} never trips`);
  }
});

test('singleton: workflows are isolated', () => {
  dispose('wfA'); dispose('wfB');
  for (let i = 0; i < DETECT_AT; i++) observe('wfA', fail());
  const b = observe('wfB', fail());
  assert.equal(b.streak, 1, 'wfB independent of wfA');
  dispose('wfA'); dispose('wfB');
});

test('singleton: clearOnOperatorTurn clears the latch (reversibility)', () => {
  dispose('wfC');
  for (let i = 0; i < ESCALATE_AT; i++) observe('wfC', fail());
  assert.equal(isPaused('wfC'), true);
  clearOnOperatorTurn('wfC');
  assert.equal(isPaused('wfC'), false);
  const r = observe('wfC', fail());
  assert.equal(r.streak, 1, 'streak reset after operator turn');
  dispose('wfC');
});
