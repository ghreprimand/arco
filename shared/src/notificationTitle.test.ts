import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attentionTitle, noticeSourceLabel, scopedNoticeTitle } from './notificationTitle.js';

test('notification source identifies a member and its cluster, or a single tab', () => {
  assert.equal(noticeSourceLabel('Director', { name: 'Harbor', cwd: '/projects/one', clusterId: 'cluster-one' }), 'Director in Harbor');
  assert.equal(noticeSourceLabel('Director', { name: 'Beacon', cwd: '/projects/two', clusterId: 'cluster-two' }), 'Director in Beacon');
  assert.equal(noticeSourceLabel('Build', null), 'Build');
  assert.equal(noticeSourceLabel('Director', { cwd: '/projects/harbor/', clusterId: 'abcdef1234' }), 'Director in harbor · abcdef12');
});

test('notification titles stay on one line and retain full names', () => {
  const source = noticeSourceLabel('  Long\nmember  ', { name: 'A   long\ncluster', clusterId: 'a', cwd: '' });
  assert.equal(attentionTitle(source, 'finished'), 'Long member in A long cluster finished');
  assert.equal(attentionTitle(source, 'waiting'), 'Long member in A long cluster is waiting for you');
  assert.equal(scopedNoticeTitle(source, 'Terminal\nexited'), 'Long member in A long cluster: Terminal exited');
  assert.equal(scopedNoticeTitle('', 'Backup completed'), 'Backup completed');
});
