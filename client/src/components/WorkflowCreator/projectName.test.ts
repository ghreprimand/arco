import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectNameForDirectory } from './projectName';

test('workflow defaults use project display names and handle both path styles', () => {
  const projects = [
    { path: '/projects/parent', name: 'Parent project', source: 'scanned' as const, exists: true },
    { path: 'C:\\Projects\\Parent', name: 'Windows project', source: 'scanned' as const, exists: true },
  ];
  assert.equal(projectNameForDirectory('/projects/parent/', projects), 'Parent project');
  assert.equal(projectNameForDirectory('c:/projects/parent/', projects), 'Windows project');
  assert.equal(projectNameForDirectory('C:\\Projects\\Child', projects), 'Child');
  assert.equal(projectNameForDirectory('/projects/Child', projects), 'Child');
});
