import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeLegacyText } from './legacyText.js';

test('Windows-1252 decoding uses the per-chunk control boundary', () => {
  const accepted = Buffer.alloc(101, 0x61);
  accepted[0] = 1;
  accepted[1] = 0xe9;
  assert.match(decodeLegacyText(accepted)!, /é/);
  assert.equal(decodeLegacyText(accepted.subarray(0, 100)), null);
  assert.equal(decodeLegacyText(Buffer.from([0x80, 0])), null);
  assert.equal(decodeLegacyText(Buffer.concat([Buffer.alloc(16384, 0x61), Buffer.from([0x80, 1])])), null);
  assert.notEqual(decodeLegacyText(Buffer.from([0xe9, 9, 10, 11, 12, 13, 27])), null);
});
