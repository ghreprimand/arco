import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createLongPress, LONG_PRESS_MS } from './longPress';

test('a held press fires once; a scroll or an early lift does not', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let fired = 0;
    const press = createLongPress(() => { fired += 1; });

    press.down(100, 100);
    press.move(103, 104);
    mock.timers.tick(LONG_PRESS_MS);
    assert.equal(fired, 1);
    assert.equal(press.takeFired(), true);
    assert.equal(press.takeFired(), false);

    press.down(100, 100);
    press.move(100, 130);
    mock.timers.tick(LONG_PRESS_MS);
    assert.equal(fired, 1, 'a scroll cancels the press');

    press.down(100, 100);
    mock.timers.tick(LONG_PRESS_MS - 1);
    press.end();
    mock.timers.tick(10);
    assert.equal(fired, 1, 'an early lift cancels the press');
    assert.equal(press.takeFired(), false);
  } finally {
    mock.timers.reset();
  }
});
