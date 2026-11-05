import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutRange, rangeWidthKey, readLayoutMode, readRangeFraction, writeRangeFraction } from './layoutRange';

test('Automatic switches range at 1099/1100 and 1599/1600 interface pixels', () => {
  assert.equal(layoutRange(1099, 1, 'auto'), 'narrow');
  assert.equal(layoutRange(1100, 1, 'auto'), 'medium');
  assert.equal(layoutRange(1599, 1, 'auto'), 'medium');
  assert.equal(layoutRange(1600, 1, 'auto'), 'wide');
});

test('the interface scale counts: 1920 px at 150% is 1280, 2400 px at 150% is 1600', () => {
  assert.equal(layoutRange(1920, 1.5, 'auto'), 'medium');
  assert.equal(layoutRange(1649, 1.5, 'auto'), 'narrow');
  assert.equal(layoutRange(2400, 1.5, 'auto'), 'wide');
  assert.equal(layoutRange(2398, 1.5, 'auto'), 'medium');
  assert.equal(layoutRange(1920, 0, 'auto'), 'wide', 'a bad scale counts as 100%');
});

test('Standard is the original layout at every width; Compact is medium except under 1100', () => {
  for (const w of [800, 1280, 1920, 3840]) assert.equal(layoutRange(w, 1, 'standard'), 'standard');
  assert.equal(layoutRange(1099, 1, 'compact'), 'narrow');
  assert.equal(layoutRange(1100, 1, 'compact'), 'medium');
  assert.equal(layoutRange(3840, 1, 'compact'), 'medium');
});

function memory(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, data };
}

test('splitter positions are kept per range; wide starts from the original saved value', () => {
  const store = memory({ base: '0.4' });
  assert.equal(rangeWidthKey('base', 'standard'), 'base');
  assert.equal(readRangeFraction('base', 'standard', 0.1, 0.5, store), 0.4);
  assert.equal(readRangeFraction('base', 'wide', 0.1, 0.5, store), 0.4, 'wide inherits the original value');
  assert.equal(readRangeFraction('base', 'medium', 0.1, 0.5, store), null, 'medium has its own default');
  writeRangeFraction('base', 'medium', 0.2, store);
  writeRangeFraction('base', 'wide', 0.3, store);
  assert.equal(readRangeFraction('base', 'medium', 0.1, 0.5, store), 0.2);
  assert.equal(readRangeFraction('base', 'wide', 0.1, 0.5, store), 0.3);
  assert.equal(readRangeFraction('base', 'standard', 0.1, 0.5, store), 0.4, 'Standard keeps its own value');
  store.data.set('base.narrow', '9');
  assert.equal(readRangeFraction('base', 'narrow', 0.1, 0.5, store), null, 'out-of-range values are ignored');
});

test('the saved layout mode defaults to Automatic', () => {
  assert.equal(readLayoutMode(memory()), 'auto');
  assert.equal(readLayoutMode(memory({ 'arco.layoutMode': 'compact' })), 'compact');
  assert.equal(readLayoutMode(memory({ 'arco.layoutMode': 'tiny' })), 'auto');
});
