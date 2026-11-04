import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NotificationChannelsView } from '@arco/shared';
import { isJobWaiting, titleWithWaiting, waitingJobIds } from './waiting';
import { shouldRaiseDesktop } from './desktopAlerts';

const msg = (extra: Record<string, unknown>) => ({ id: 'm', role: 'system', content: '', timestamp: 1, ...extra }) as never;

test('a tab is waiting while a question or an approval is open', () => {
  assert.equal(isJobWaiting({ messages: [msg({ operatorQuestion: { status: 'pending' } })] }), true);
  assert.equal(isJobWaiting({ messages: [msg({ operatorQuestion: { status: 'answered' } })] }), false);
  assert.equal(isJobWaiting({ messages: [msg({ toolUse: { tool: 'Gate', input: { status: 'pending' } } })] }), true);
  assert.equal(isJobWaiting({ messages: [msg({ toolUse: { tool: 'Gate', input: { status: 'approved' } } })] }), false);
  assert.equal(isJobWaiting({ messages: [] }), false);
  assert.deepEqual(waitingJobIds({ a: { messages: [] }, b: { messages: [msg({ operatorQuestion: { status: 'pending' } })] } }), ['b']);
});

test('the title shows a count only when something waits', () => {
  assert.equal(titleWithWaiting('ARCO', 0), 'ARCO');
  assert.equal(titleWithWaiting('ARCO', 2), '(2) ARCO');
});

const view = (desktop: Partial<Record<'finished' | 'failed' | 'waiting', boolean>>) => ({ desktop: { finished: false, failed: false, waiting: false, ...desktop } }) as unknown as NotificationChannelsView;

test('a desktop notification needs the switch, permission and an unfocused window', () => {
  const away = { permission: 'granted', hasFocus: false, visible: true };
  assert.equal(shouldRaiseDesktop(view({ waiting: true }), 'waiting', away), true);
  assert.equal(shouldRaiseDesktop(view({}), 'waiting', away), false, 'off by default');
  assert.equal(shouldRaiseDesktop(view({ waiting: true }), 'finished', away), false, 'per-event switch');
  assert.equal(shouldRaiseDesktop(view({ waiting: true }), 'waiting', { ...away, permission: 'default' }), false);
  assert.equal(shouldRaiseDesktop(view({ waiting: true }), 'waiting', { permission: 'granted', hasFocus: true, visible: true }), false, 'focused window');
  assert.equal(shouldRaiseDesktop(view({ waiting: true }), 'waiting', { permission: 'granted', hasFocus: true, visible: false }), true, 'hidden tab');
  assert.equal(shouldRaiseDesktop(null, 'waiting', away), false);
});
