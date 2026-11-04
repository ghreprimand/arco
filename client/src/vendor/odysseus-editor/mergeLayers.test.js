// Behavior tests for the vendored editor's merge / flatten paths.
//
// Run: npm run test:editor-merge -w client
//   node --test src/vendor/odysseus-editor/mergeLayers.test.js
//
// WHY THESE EXIST: the pre-2026-09 vendored copy baked `layer.canvas`
// directly, so a layer's non-destructive adjustments were silently dropped on
// Merge Down / Merge All / Flatten Copy, and the baked layer kept stale
// opacity / offset / adjustment-cache state. Upstream fixed it by routing each
// layer through the adjustment pipeline (`renderLayer`) and normalizing the
// result to document coordinates. See VENDOR.md § Ported upstream fixes.
//
// There is no jsdom / node-canvas in this repo, and adding both to test third-
// party code is disproportionate. The defect was a call-shape bug — WHICH
// source is drawn, at WHAT opacity and offset — so a recording canvas stub
// tests it directly and pins the exact regression.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// --- minimal canvas / document stubs ---------------------------------------

let created = [];

function makeCtx(owner) {
  return {
    globalAlpha: 1,
    _owner: owner,
    save() {}, restore() {},
    drawImage(src, x, y) {
      owner.ops.push({ src: src && src._tag, x, y, alpha: this.globalAlpha });
    },
  };
}

function makeCanvas(tag) {
  const c = { _tag: tag, width: 0, height: 0, ops: [] };
  c.getContext = () => (c._ctx ||= makeCtx(c));
  return c;
}

globalThis.document = {
  createElement(kind) {
    assert.equal(kind, 'canvas');
    const c = makeCanvas(`merged#${created.length}`);
    created.push(c);
    return c;
  },
};

const { state } = await import('./editor/state.js');
const { mergeLayerDownAtIndex } = await import('./editor/wire-merge-buttons.js');

// --- fixtures ---------------------------------------------------------------

function layer(id, { opacity = 1, visible = true } = {}) {
  const canvas = makeCanvas(`raw:${id}`);
  const l = { id, canvas, opacity, visible, adjLayers: [] };
  l.ctx = canvas.getContext('2d');
  return l;
}

function reset(layers, offsets = {}) {
  created = [];
  state.imgWidth = 100;
  state.imgHeight = 50;
  state.layers = layers;
  state.layerOffsets = new Map(Object.entries(offsets));
  state.activeLayerId = null;
}

// --- tests ------------------------------------------------------------------

test('merge down draws the ADJUSTED source, not the raw layer canvas', () => {
  // The regression: passing no renderLayer must still work, but when one is
  // supplied its output is what gets baked.
  const lower = layer('lo');
  const upper = layer('up');
  reset([lower, upper]);

  const adjusted = new Map([
    [lower, makeCanvas('adj:lo')],
    [upper, makeCanvas('adj:up')],
  ]);
  mergeLayerDownAtIndex(1, (l) => adjusted.get(l));

  const merged = created[0];
  assert.deepEqual(
    merged.ops.map((o) => o.src),
    ['adj:lo', 'adj:up'],
    'both layers rendered through the adjustment pipeline',
  );
});

test('merge down honours per-layer opacity', () => {
  const lower = layer('lo', { opacity: 0.5 });
  const upper = layer('up', { opacity: 0.25 });
  reset([lower, upper]);

  mergeLayerDownAtIndex(1, null);

  const merged = created[0];
  assert.deepEqual(merged.ops.map((o) => o.alpha), [0.5, 0.25]);
});

test('merge down normalizes offsets to document coordinates', () => {
  const lower = layer('lo');
  const upper = layer('up');
  reset([lower, upper], { lo: { x: 10, y: 4 }, up: { x: 30, y: 9 } });

  mergeLayerDownAtIndex(1, null);

  const merged = created[0];
  // Each layer is drawn at its own document offset onto a full-document canvas.
  assert.deepEqual(
    merged.ops.map((o) => ({ x: o.x, y: o.y })),
    [{ x: 10, y: 4 }, { x: 30, y: 9 }],
  );
  // ...and the survivor is reset to the origin, since it now IS the document.
  assert.deepEqual(state.layerOffsets.get('lo'), { x: 0, y: 0 });
});

test('merged canvas is sized to the document, not to either layer', () => {
  reset([layer('lo'), layer('up')]);
  mergeLayerDownAtIndex(1, null);
  assert.equal(created[0].width, 100);
  assert.equal(created[0].height, 50);
});

test('baking resets opacity, visibility and adjustment caches on the survivor', () => {
  const lower = layer('lo', { opacity: 0.3, visible: false });
  lower.adjLayers = [{ type: 'levels' }];
  lower._adjFinal = makeCanvas('stale');
  lower._adjFinalKey = 'stale-key';
  lower._adjCache = makeCanvas('stale2');
  lower._adjCacheKey = 'stale-key-2';
  reset([lower, layer('up')]);

  mergeLayerDownAtIndex(1, null);

  // Opacity and adjustments are now baked into the pixels — leaving them set
  // would apply them a second time on the next composite.
  assert.equal(lower.opacity, 1);
  assert.equal(lower.visible, true);
  assert.deepEqual(lower.adjLayers, []);
  assert.equal(lower._adjFinal, null);
  assert.equal(lower._adjFinalKey, '');
  assert.equal(lower._adjCache, null);
  assert.equal(lower._adjCacheKey, '');
});

test('merge down removes the upper layer and its offset entry', () => {
  const lower = layer('lo');
  const upper = layer('up');
  reset([lower, upper], { lo: { x: 0, y: 0 }, up: { x: 5, y: 5 } });

  const survivor = mergeLayerDownAtIndex(1, null);

  assert.equal(survivor, lower);
  assert.deepEqual(state.layers, [lower]);
  assert.equal(state.layerOffsets.has('up'), false);
  assert.equal(state.activeLayerId, 'lo');
});

test('merge down refuses the bottom layer and out-of-range indices', () => {
  reset([layer('lo'), layer('up')]);
  assert.equal(mergeLayerDownAtIndex(0, null), null, 'cannot merge the bottom layer');
  assert.equal(mergeLayerDownAtIndex(2, null), null, 'index past the top');
  assert.equal(state.layers.length, 2, 'no layer was consumed');
});

test('a throwing renderLayer degrades to the raw canvas instead of failing', () => {
  reset([layer('lo'), layer('up')]);
  mergeLayerDownAtIndex(1, () => { throw new Error('adjustment pipeline blew up'); });
  assert.deepEqual(created[0].ops.map((o) => o.src), ['raw:lo', 'raw:up']);
});
