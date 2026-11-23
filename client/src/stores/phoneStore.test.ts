import assert from 'node:assert/strict';
import test from 'node:test';
import { mobileBackStep, mobileDepth, usePhoneStore } from './phoneStore';

test('Back in the mobile view closes the top layer first, then leaves the conversation', () => {
  const none = { sheet: false, dialog: false, settings: false, terminal: false, panel: false, conversation: false };
  assert.equal(mobileBackStep(none), null);
  assert.equal(mobileDepth(none), 0);
  const all = { sheet: true, dialog: true, settings: true, terminal: true, panel: true, conversation: true };
  assert.equal(mobileBackStep(all), 'sheet');
  assert.equal(mobileDepth(all), 6);
  assert.equal(mobileBackStep({ ...none, panel: true, conversation: true }), 'panel');
  assert.equal(mobileBackStep({ ...none, terminal: true, panel: true, conversation: true }), 'terminal');
  assert.equal(mobileBackStep({ ...none, conversation: true }), 'conversation');
  // The manual (or Recall, System) opened from PANELS closes before the conversation.
  assert.equal(mobileBackStep({ ...none, dialog: true, conversation: true }), 'dialog');
  // A Settings category goes back to the category list, then Settings closes.
  assert.equal(mobileBackStep({ ...none, settings: true, settingsPage: true, conversation: true }), 'settingsPage');
  assert.equal(mobileBackStep({ ...none, settings: true, conversation: true }), 'settings');
  assert.equal(mobileDepth({ ...none, settings: true, settingsPage: true, conversation: true }), 3);
});

test('Back closes a local Quick dialog before the conversation', () => {
  const layers = { localDialog: true, sheet: false, dialog: false, settings: false, terminal: false, panel: false, conversation: true };
  assert.equal(mobileBackStep(layers), 'localDialog');
  assert.equal(mobileDepth(layers), 2);
});

test('a question opened from the directory keeps its member as owner', () => {
  usePhoneStore.getState().openSheet('questions', 'researcher-a');
  assert.equal(usePhoneStore.getState().questionWorkflowId, 'researcher-a');
  usePhoneStore.getState().openSheet(null);
  assert.equal(usePhoneStore.getState().questionWorkflowId, null);
});
