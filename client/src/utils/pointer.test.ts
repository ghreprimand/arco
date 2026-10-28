import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutPoint, layoutRect } from './pointer';

test('pointer coordinates map into the scaled layout', () => {
  const doc = globalThis.document;
  const style = globalThis.getComputedStyle;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: {} } });
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ zoom: '1.5' }) });
  try {
    assert.deepEqual(layoutPoint({ clientX: 150, clientY: 90 }), { x: 100, y: 60 });
    assert.deepEqual(layoutRect({ left: 150, right: 300, top: 30, bottom: 120, width: 150, height: 90 }), { left: 100, right: 200, top: 20, bottom: 80, width: 100, height: 60 });
  } finally {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
    Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: style });
  }
});
