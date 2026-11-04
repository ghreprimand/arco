import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useDraftStore } from './draftStore.js';

test('accept applies only to the captured draft and undo restores it', () => {
  const store = useDraftStore.getState(); store.setDraft('fixture', 'original');
  assert.equal(store.applyTidy('fixture', 'stale', 'proposal'), false);
  assert.equal(useDraftStore.getState().drafts.fixture, 'original');
  assert.equal(store.applyTidy('fixture', 'original', 'proposal'), true);
  assert.equal(useDraftStore.getState().drafts.fixture, 'proposal');
  assert.equal(store.undoTidy('fixture'), true);
  assert.equal(useDraftStore.getState().drafts.fixture, 'original');
  store.clearDraft('fixture');
});
test('editing after accept clears undo rather than erasing later text', () => {
  const store = useDraftStore.getState(); store.setDraft('fixture', 'original'); store.applyTidy('fixture', 'original', 'proposal');
  store.setDraft('fixture', 'proposal plus edits');
  assert.equal(store.undoTidy('fixture'), false); assert.equal(useDraftStore.getState().drafts.fixture, 'proposal plus edits');
  store.clearDraft('fixture'); assert.equal(useDraftStore.getState().tidyUndo.fixture, undefined);
});
