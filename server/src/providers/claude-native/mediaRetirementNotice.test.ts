import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaRetirementNotice } from './mediaRetirementNotice.js';
for (const [images, documents, phrase] of [
  [1, 0, '1 old image with a text receipt'],
  [0, 1, '1 old PDF document with a text receipt'],
  [3, 0, '3 old images with text receipts'],
  [0, 2, '2 old PDF documents with text receipts'],
  [1, 1, '1 old image and 1 old PDF document with text receipts'],
] as const) {
  test(`retirement wording: ${phrase}`, () => {
    const notice = mediaRetirementNotice(images, documents)!;
    assert.equal(notice, `Replaced ${phrase} to make room for new media. Attach or request a file again to bring it back.`);
    assert.doesNotMatch(notice, /0 old|COMPACT|HANDOFF/);
  });
}
test('no retired media produces no notice', () => assert.equal(mediaRetirementNotice(0, 0), undefined));
