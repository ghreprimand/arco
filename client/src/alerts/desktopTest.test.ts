import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDesktopTest, type NotificationApi } from './desktopTest';

// A stand-in for window.Notification: the permission the browser would give,
// how requestPermission answers (promise or the older callback) and whether
// the system reports the notification shown, failed or says nothing.
function fake(opts: { permission: string; answer?: string; callbackOnly?: boolean; event?: 'show' | 'error' | 'none'; throws?: boolean }) {
  const shown: string[] = [];
  let asked = 0;
  class Fake {
    static permission = opts.permission;
    static requestPermission(cb?: (p: string) => void): Promise<string> | void {
      asked++;
      Fake.permission = opts.answer ?? Fake.permission;
      if (opts.callbackOnly) { setTimeout(() => cb?.(Fake.permission), 0); return; }
      return Promise.resolve(Fake.permission);
    }
    onshow: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(title: string) {
      if (opts.throws) throw new TypeError('Illegal constructor');
      shown.push(title);
      setTimeout(() => { if (opts.event === 'show') this.onshow?.(); else if (opts.event === 'error') this.onerror?.(); }, 0);
    }
  }
  return { api: Fake as unknown as NotificationApi, shown, asked: () => asked };
}

test('not asked yet: TEST DESKTOP asks for permission itself, then sends', async () => {
  const f = fake({ permission: 'default', answer: 'granted', event: 'show' });
  const r = await runDesktopTest(f.api, 50);
  assert.equal(f.asked(), 1);
  assert.equal(r.result, 'sent');
  assert.equal(r.label, 'Sent');
  assert.deepEqual(f.shown, ['Arco notification test']);
});

test('the older callback form of requestPermission is answered too', async () => {
  const f = fake({ permission: 'default', answer: 'granted', callbackOnly: true, event: 'show' });
  assert.equal((await runDesktopTest(f.api, 50)).result, 'sent');
});

test('already granted: no permission request, the test is sent', async () => {
  const f = fake({ permission: 'granted', event: 'show' });
  assert.equal((await runDesktopTest(f.api, 50)).result, 'sent');
  assert.equal(f.asked(), 0);
});

test('blocked by the browser: nothing is shown and the result says how to allow it', async () => {
  for (const start of ['denied', 'default']) {
    const f = fake({ permission: start, answer: 'denied' });
    const r = await runDesktopTest(f.api, 50);
    assert.equal(r.result, 'blocked');
    assert.equal(r.label, 'Blocked');
    assert.match(r.detail, /site settings/);
    assert.match(r.detail, /own browser profile/);
    assert.deepEqual(f.shown, []);
  }
});

test('a permission request closed without an answer is reported, not sent', async () => {
  const f = fake({ permission: 'default', answer: 'default' });
  const r = await runDesktopTest(f.api, 50);
  assert.equal(r.result, 'not-allowed');
  assert.deepEqual(f.shown, []);
});

test('no Notification support is reported as unsupported', async () => {
  const r = await runDesktopTest(undefined, 50);
  assert.equal(r.result, 'unsupported');
  assert.equal(r.label, 'Not supported');
});

test('a browser that cannot construct a notification or reports an error gives Failed', async () => {
  assert.equal((await runDesktopTest(fake({ permission: 'granted', throws: true }).api, 50)).result, 'failed');
  assert.equal((await runDesktopTest(fake({ permission: 'granted', event: 'error' }).api, 50)).result, 'failed');
});

test('a browser that reports neither show nor error counts as sent after the wait', async () => {
  const r = await runDesktopTest(fake({ permission: 'granted', event: 'none' }).api, 30);
  assert.equal(r.result, 'sent');
  assert.match(r.detail, /notification service/);
});
