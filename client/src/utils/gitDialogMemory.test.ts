import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forgetGitDialog, recallGitDialog, rememberGitDialog } from './gitDialogMemory.js';

test('an unsent GIT dialog is remembered per tab and forgotten on send', () => {
  assert.equal(recallGitDialog('tab-a'), undefined);
  rememberGitDialog('tab-a', { commitSubject: 'Subject', otherOpen: true });
  rememberGitDialog('tab-a', { scopeNotes: 'Only src', scrollTop: 40 });
  rememberGitDialog('tab-b', { commitSubject: 'Other tab' });
  const a = recallGitDialog('tab-a');
  assert.equal(a?.commitSubject, 'Subject');
  assert.equal(a?.scopeNotes, 'Only src');
  assert.equal(a?.otherOpen, true);
  assert.equal(a?.scrollTop, 40);
  assert.equal(recallGitDialog('tab-b')?.commitSubject, 'Other tab');
  forgetGitDialog('tab-a');
  assert.equal(recallGitDialog('tab-a'), undefined);
  assert.equal(recallGitDialog('tab-b')?.commitSubject, 'Other tab');
  forgetGitDialog('tab-b');
});
