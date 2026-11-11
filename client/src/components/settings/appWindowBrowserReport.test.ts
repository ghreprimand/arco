import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toReport } from './appWindowBrowserReport.js';

const chrome = { id: 'chrome', name: 'Google Chrome', path: '/usr/bin/google-chrome' };

test('a well-formed reply is kept', () => {
  assert.deepEqual(toReport({ platform: 'linux', choice: 'chrome', browsers: [chrome], using: chrome, missing: false }),
    { platform: 'linux', choice: 'chrome', browsers: [chrome], using: chrome, missing: false });
  assert.deepEqual(toReport({ platform: 'win32', choice: 'firefox', browsers: [], using: null, missing: true, unsupported: true }),
    { platform: 'win32', choice: 'firefox', browsers: [], using: null, missing: true, unsupported: true });
});

test('a reply without a browser list is refused instead of breaking Settings', () => {
  for (const value of [null, undefined, 'text', 42, {}, { files: [], entries: [] }, { browsers: 'chrome' }]) assert.equal(toReport(value), null);
});

test('malformed entries are dropped', () => {
  const r = toReport({ browsers: [chrome, { id: 1 }, null], using: { id: 'x' }, choice: '' });
  assert.deepEqual(r, { platform: '', choice: null, browsers: [chrome], using: null, missing: false });
});


test('a malformed version cannot reach the Settings renderer', () => {
  const report = toReport({ browsers: [{ id: 'b', name: 'Browser', path: '/bin/b', version: {} }], using: { id: 'b', name: 'Browser', path: '/bin/b', version: {} } });
  assert.deepEqual(report?.browsers, []); assert.equal(report?.using, null);
});
