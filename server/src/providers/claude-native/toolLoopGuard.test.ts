// Unit tests for H9 — in-turn tool-loop guardrail.
//
// Contracts:
//  • hashArgs is stable, key-order-insensitive, deterministic;
//  • no-progress trips at NO_PROGRESS_THRESHOLD identical (tool,args,output);
//  • identical-repeat trips at IDENTICAL_REPEAT_THRESHOLD identical (tool,args)
//    even when output keeps changing;
//  • no-progress outranks identical-repeat;
//  • firstTrip fires exactly once per key;
//  • reset() clears per-turn state;
//  • differing args / tools never cross-contaminate.
//
// Run: node --conditions development --import tsx --test src/providers/claude-native/toolLoopGuard.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolLoopGuard,
  hashArgs,
  NO_PROGRESS_THRESHOLD,
  IDENTICAL_REPEAT_THRESHOLD,
} from './toolLoopGuard.js';

test('hashArgs: deterministic + key-order insensitive', () => {
  assert.equal(hashArgs({ a: 1, b: 2 }), hashArgs({ b: 2, a: 1 }));
  assert.equal(hashArgs('cmd'), hashArgs('cmd'));
  assert.notEqual(hashArgs({ a: 1 }), hashArgs({ a: 2 }));
});

test('hashArgs: nested objects/arrays canonicalize', () => {
  assert.equal(
    hashArgs({ x: [{ p: 1, q: 2 }] }),
    hashArgs({ x: [{ q: 2, p: 1 }] }),
  );
});

test('no-progress trips at the threshold (same args + same output)', () => {
  const g = new ToolLoopGuard();
  const ah = hashArgs({ cmd: 'make' });
  let v;
  for (let i = 0; i < NO_PROGRESS_THRESHOLD; i++) {
    v = g.record('Bash', ah, 'samehash');
  }
  assert.equal(v!.signal, 'no-progress');
  assert.equal(v!.tripped, true);
  assert.equal(v!.firstTrip, true);
  assert.equal(v!.sameOutputCount, NO_PROGRESS_THRESHOLD);
});

test('one call before threshold does not trip', () => {
  const g = new ToolLoopGuard();
  const ah = hashArgs({ cmd: 'make' });
  let v;
  for (let i = 0; i < NO_PROGRESS_THRESHOLD - 1; i++) v = g.record('Bash', ah, 'h');
  assert.equal(v!.tripped, false);
  assert.equal(v!.signal, 'none');
});

test('firstTrip fires once; later identical calls stay tripped but not first', () => {
  const g = new ToolLoopGuard();
  const ah = hashArgs({ cmd: 'x' });
  let firstTrips = 0;
  for (let i = 0; i < NO_PROGRESS_THRESHOLD + 3; i++) {
    const v = g.record('Bash', ah, 'h');
    if (v.firstTrip) firstTrips++;
  }
  assert.equal(firstTrips, 1, 'exactly one firstTrip');
});

test('identical-repeat trips on same args even when output changes', () => {
  const g = new ToolLoopGuard();
  const ah = hashArgs({ file: 'a.ts' });
  let v;
  for (let i = 0; i < IDENTICAL_REPEAT_THRESHOLD; i++) {
    v = g.record('Read', ah, `out-${i}`); // output differs every time
  }
  assert.equal(v!.signal, 'identical-repeat');
  assert.equal(v!.tripped, true);
});

test('no-progress outranks identical-repeat when both would cross', () => {
  // make both thresholds crossable in one run by repeating same args+output past
  // the larger threshold.
  const g = new ToolLoopGuard();
  const ah = hashArgs({ cmd: 'q' });
  let v;
  for (let i = 0; i < IDENTICAL_REPEAT_THRESHOLD; i++) v = g.record('Bash', ah, 'same');
  assert.equal(v!.signal, 'no-progress', 'stronger signal reported');
});

test('differing args do not cross-contaminate', () => {
  const g = new ToolLoopGuard();
  for (let i = 0; i < NO_PROGRESS_THRESHOLD + 2; i++) {
    const v = g.record('Bash', hashArgs({ cmd: `c${i}` }), `h${i}`);
    assert.equal(v.tripped, false, `distinct call ${i} never trips`);
    assert.equal(v.repeatCount, 1);
  }
});

test('no outputHash → only identical-repeat can fire', () => {
  const g = new ToolLoopGuard();
  const ah = hashArgs({ cmd: 'z' });
  let v;
  for (let i = 0; i < NO_PROGRESS_THRESHOLD; i++) v = g.record('Bash', ah);
  assert.equal(v!.signal, 'none', 'no-progress needs an outputHash');
  assert.equal(v!.sameOutputCount, 0);
});

test('reset clears per-turn state', () => {
  const g = new ToolLoopGuard();
  const ah = hashArgs({ cmd: 'r' });
  for (let i = 0; i < NO_PROGRESS_THRESHOLD; i++) g.record('Bash', ah, 'h');
  g.reset();
  const v = g.record('Bash', ah, 'h');
  assert.equal(v.repeatCount, 1);
  assert.equal(v.tripped, false);
});
