import test from 'node:test';
import assert from 'node:assert/strict';
import { lastProjectFolder } from './researchExports';

const line = (where: string) => `- 2026-10-31T12:00:00.000Z - project - destination: ${where}`;

test('the last project folder comes from the newest export that names one', () => {
  const text = ['# Exports', '', 'Where results were sent and when.', '',
    line('/projects/first/research/sample'),
    line('started project /projects/second'),
    line('plan 1234 reference sample'),
    line('Markdown copied'),
    line('composer 5678'),
  ].join('\n');
  assert.equal(lastProjectFolder(text, '/research/sample'), '/projects/second');
  assert.equal(lastProjectFolder(line('C:\\work\\app\\research\\sample-2'), 'C:\\research\\sample'), 'C:\\work\\app');
  // Nothing sent to a folder yet, and never the research folder itself.
  assert.equal(lastProjectFolder('# Exports\n', '/research/sample'), undefined);
  assert.equal(lastProjectFolder(line('started project /research/sample/'), '/research/sample'), undefined);
});
