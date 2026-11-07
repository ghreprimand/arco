import test from 'node:test';
import assert from 'node:assert/strict';
import { redactPaths } from './supportBundle.js';

test('support text redacts Windows drive and UNC paths outside home', () => {
  const paths = [
    String.raw`D:\Projects\fixture-private\events.jsonl`,
    String.raw`\\fixture-server\private-share\events.jsonl`,
    String.raw`D:\Private Projects\fixture-private\events.jsonl`,
    'D:/Private Projects/fixture-private/events.jsonl',
    String.raw`D:\Program Files (x86)\fixture-private\events.jsonl`,
    String.raw`D:\Dev's Projects\fixture-private\events.jsonl`,
  ];
  for (const path of paths) {
    const redacted = redactPaths(`opened "${path}"; retry`);
    assert.equal(redacted, 'opened "<path>/events.jsonl"; retry');
    assert.ok(!JSON.stringify({ detail: redacted }).includes('fixture-private'));
  }
});

test('path redaction preserves diagnostic boundaries and POSIX behavior', () => {
  assert.equal(redactPaths('opened /srv/synthetic/events.jsonl'), 'opened <path>/events.jsonl');
  assert.equal(redactPaths('and/or a relative/path'), 'and/or a relative/path');
  assert.equal(redactPaths('opened "D:\\Fixture Space\\events.jsonl" then retry'), 'opened "<path>/events.jsonl" then retry');
  assert.equal(redactPaths('opened D:\\fixture\\events.jsonl; retry'), 'opened <path>/events.jsonl; retry');
  assert.equal(redactPaths('opened D:\\fixture\\events.jsonl\nnext check'), 'opened <path>/events.jsonl\nnext check');
});
