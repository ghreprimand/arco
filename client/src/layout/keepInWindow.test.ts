import test from 'node:test';
import assert from 'node:assert/strict';
import { drawnSide, planPlacement, widthCap, type Box } from './keepInWindow';

const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, width, height, right: left + width, bottom: top + height });
const viewport = { width: 1280, height: 800 };
const M = 8;

test('a panel that fits is left where its own CSS put it', () => {
  const anchor = box(600, 20, 80, 24);
  const panel = box(560, 50, 200, 300);
  assert.deepEqual(planPlacement(panel, anchor, viewport, M), { left: 560, top: 50, maxHeight: null, side: 'below' });
});

test('a right-aligned menu under a trigger near the left edge shifts right to the margin', () => {
  // The top-bar case: right: 0 under a trigger at x 20 puts the left edge at -180.
  const anchor = box(20, 10, 60, 20);
  const panel = box(-180, 36, 260, 200);
  const plan = planPlacement(panel, anchor, viewport, M);
  assert.equal(plan.left, M);
  assert.equal(plan.top, 36);
});

test('a menu that runs off the right edge shifts left', () => {
  const plan = planPlacement(box(1200, 100, 240, 100), box(1200, 70, 40, 24), viewport, M);
  assert.equal(plan.left, 1280 - M - 240);
});

test('a dropdown near the bottom flips above its trigger when there is more room there', () => {
  const anchor = box(400, 700, 80, 24);
  const panel = box(400, 730, 200, 300); // gap 6 below the trigger
  const plan = planPlacement(panel, anchor, viewport, M);
  assert.equal(plan.side, 'above');
  assert.equal(plan.top, 700 - 6 - 300);
  assert.equal(plan.maxHeight, null);
});

test('a menu that opens upward near the top flips below', () => {
  const anchor = box(400, 40, 80, 24);
  const panel = box(400, 40 - 4 - 200, 150, 200);
  const plan = planPlacement(panel, anchor, viewport, M);
  assert.equal(plan.side, 'below');
  assert.equal(plan.top, 64 + 4);
});

test('a tall panel is capped to the room on the larger side and scrolls', () => {
  const anchor = box(400, 300, 80, 24);
  const panel = box(400, 330, 200, 900);
  const plan = planPlacement(panel, anchor, viewport, M);
  // Below: 800 - 8 - 330 = 462; above: 300 - 6 - 8 = 286.
  assert.equal(plan.side, 'below');
  assert.equal(plan.maxHeight, 462);
  assert.equal(plan.top, 330);
});

test('it does not flip when the other side is smaller; it caps instead', () => {
  const anchor = box(400, 100, 80, 24);
  const panel = box(400, 130, 200, 800);
  const plan = planPlacement(panel, anchor, viewport, M);
  assert.equal(plan.side, 'below');
  assert.equal(plan.maxHeight, 800 - M - 130);
});

test('a panel without a trigger (pointer menu, notice) is shifted and capped inside the window', () => {
  const plan = planPlacement(box(1250, 780, 200, 120), null, viewport, M);
  assert.deepEqual(plan, { left: 1280 - M - 200, top: 800 - M - 120, maxHeight: null, side: 'free' });
  const tall = planPlacement(box(10, 10, 200, 2000), null, viewport, M);
  assert.equal(tall.maxHeight, 800 - 2 * M);
  assert.equal(tall.top, M);
});

test('a panel overlapping its trigger is free: shifted only', () => {
  assert.equal(drawnSide(box(0, 10, 50, 50), box(0, 0, 50, 30)), 'free');
  assert.equal(drawnSide(box(0, 30, 50, 50), box(0, 0, 50, 30)), 'below');
  assert.equal(drawnSide(box(0, -60, 50, 50), box(0, 0, 50, 30)), 'above');
});

test('width is capped to the window less both margins', () => {
  assert.equal(widthCap(340, 480, M), null);
  assert.equal(widthCap(510, 480, M), 480 - 2 * M);
  // At 150% interface scale a 340px panel is 510 window pixels wide.
  assert.equal(widthCap(340 * 1.5, 480, M * 1.5), 480 - 3 * M);
});

test('a trigger partly outside the window still yields a panel inside it', () => {
  const plan = planPlacement(box(-50, -40, 200, 100), box(-50, -70, 40, 24), viewport, M);
  assert.ok(plan.left >= M && plan.top >= M);
});
