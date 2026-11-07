import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newFolderNameError } from './folderName';

test('new folder names are single, portable, non-hidden path segments', () => {
  for (const name of ['Project', 'field notes', 'projet-é', 'draft.v2', 'under_score']) assert.equal(newFolderNameError(name), null, name);
  for (const name of ['', ' ', ' leading', 'trailing ', '.', '..', '.hidden', 'trailing.', 'a/b', 'a\\b', 'a:b', 'a?b', 'a\u0000b', 'CON', 'CON .txt', 'aux.txt', 'COM1', 'lpt9.log', 'x'.repeat(256)]) assert.notEqual(newFolderNameError(name), null, name);
});
