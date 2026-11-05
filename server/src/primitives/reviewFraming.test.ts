import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFraming } from './runReviewer.js';

// P8.5: every reviewer, hosted or local, gets the short change-shape checklist.
test('the review framing carries the change-shape checklist for every provider', () => {
  for (const provider of ['claude', 'codex', 'ollama'] as const) {
    const text = buildFraming(provider);
    assert.match(text, /second implementation of logic that already exists/);
    assert.match(text, /wrapper that only passes calls through/);
    assert.match(text, /tests at the changed module's interface/);
    assert.match(text, /edits in many places/);
  }
});
