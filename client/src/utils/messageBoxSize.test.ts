import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseMessageBoxSize, messageBoxMinHeight, messageBoxMaxHeight } from './messageBoxSize';

describe('messageBoxSize', () => {
  it('defaults unknown values to small', () => {
    assert.equal(parseMessageBoxSize(undefined), 'small');
    assert.equal(parseMessageBoxSize('huge'), 'small');
    assert.equal(parseMessageBoxSize('large'), 'large');
  });
  it('small keeps the composer base height, larger sizes grow it', () => {
    assert.equal(messageBoxMinHeight('small', 24), 24);
    assert.equal(messageBoxMinHeight('medium', 24), 96);
    assert.equal(messageBoxMinHeight('large', 24), 192);
  });
  it('max height never drops below the resting height or the base max', () => {
    assert.equal(messageBoxMaxHeight('small', 24, 240), 240);
    assert.ok(messageBoxMaxHeight('large', 24, 240) >= 192);
  });
});
