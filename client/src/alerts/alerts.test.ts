import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NotificationChannelsView } from '@arco/shared';
import { isJobWaiting, titleWithWaiting, waitingJobIds } from './waiting';
import { isViewingWorkflow, shouldRaiseDesktop, shouldAddAttentionNotice } from './desktopAlerts';

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

test('in-app attention is recorded only for a tab not being viewed', () => {
  assert.equal(shouldAddAttentionNotice(true, false), true);
  assert.equal(shouldAddAttentionNotice(true, true), false);
  assert.equal(shouldAddAttentionNotice(false, false), false);
});

test('in a cluster tab only the member in view counts as viewed', () => {
  const cluster = { clusterId: 'c1', members: [{ workflowId: 'director' }, { workflowId: 'builder' }] };
  const base = { showHome: false, showCreator: false, activeJobId: null, activeClusterId: 'c1', clusters: { c1: cluster }, clusterFocusedMember: {} } as never as Parameters<typeof isViewingWorkflow>[0];
  // No member chosen: the first member is in view.
  assert.equal(isViewingWorkflow(base, 'director'), true);
  assert.equal(isViewingWorkflow(base, 'builder'), false);
  const focused = { ...base, clusterFocusedMember: { c1: 'builder' } };
  assert.equal(isViewingWorkflow(focused, 'builder'), true);
  assert.equal(isViewingWorkflow(focused, 'director'), false);
  // A member id that left the cluster falls back to the first member.
  assert.equal(isViewingWorkflow({ ...base, clusterFocusedMember: { c1: 'gone' } }, 'director'), true);
  // Home, the creator, another cluster or a workflow tab: not viewed.
  assert.equal(isViewingWorkflow({ ...focused, showHome: true }, 'builder'), false);
  assert.equal(isViewingWorkflow({ ...focused, showCreator: true }, 'builder'), false);
  assert.equal(isViewingWorkflow({ ...focused, activeClusterId: null, activeJobId: 'other' }, 'builder'), false);
  assert.equal(isViewingWorkflow({ ...focused, activeClusterId: null, activeJobId: 'builder' }, 'builder'), true);
});
