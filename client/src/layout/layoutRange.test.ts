import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutRange, rangeWidthKey, readLayoutMode, readRangeFraction, writeRangeFraction } from './layoutRange';

test('Automatic uses the agreed interface pixel boundaries', () => {
  assert.equal(layoutRange(1499, 1, 'auto'), 'narrow');
  assert.equal(layoutRange(1500, 1, 'auto'), 'medium');
  assert.equal(layoutRange(1999, 1, 'auto'), 'medium');
  assert.equal(layoutRange(2000, 1, 'auto'), 'standard');
  assert.equal(layoutRange(1920, 1.2, 'auto'), 'medium');
  assert.equal(layoutRange(1920, 1.5, 'auto'), 'narrow');
  assert.equal(layoutRange(1920, 0, 'auto'), 'medium');
});

test('fixed layouts apply at every width', () => {
  for (const w of [800, 1280, 1920, 3840]) {
    assert.equal(layoutRange(w, 1, 'standard'), 'standard');
    assert.equal(layoutRange(w, 1, 'compact'), 'medium');
    assert.equal(layoutRange(w, 1, 'narrow'), 'narrow');
  }
});

function memory(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, data };
}

test('splitter positions are kept per layout and ignore retired wide values', () => {
  const store = memory({ base: '0.4', 'base.wide': '0.3' });
  assert.equal(rangeWidthKey('base', 'standard'), 'base');
  assert.equal(readRangeFraction('base', 'standard', 0.1, 0.5, store), 0.4);
  assert.equal(readRangeFraction('base', 'medium', 0.1, 0.5, store), null);
  writeRangeFraction('base', 'medium', 0.2, store);
  assert.equal(readRangeFraction('base', 'medium', 0.1, 0.5, store), 0.2);
  assert.equal(readRangeFraction('base', 'standard', 0.1, 0.5, store), 0.4);
  store.data.set('base.narrow', '9');
  assert.equal(readRangeFraction('base', 'narrow', 0.1, 0.5, store), null);
});

test('the saved layout mode defaults to Automatic', () => {
  assert.equal(readLayoutMode(memory()), 'auto');
  assert.equal(readLayoutMode(memory({ 'arco.layoutMode': 'compact' })), 'compact');
  assert.equal(readLayoutMode(memory({ 'arco.layoutMode': 'narrow' })), 'narrow');
  assert.equal(readLayoutMode(memory({ 'arco.layoutMode': 'tiny' })), 'auto');
});
