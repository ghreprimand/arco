import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_NOTIFICATION_CHANNELS, isValidNtfyTopic, normalizeNtfyServer, sanitizeNotificationChannels } from './notifications.js';

test('everything is off by default and malformed input falls back to off', () => {
  assert.deepEqual(sanitizeNotificationChannels(undefined), { ...DEFAULT_NOTIFICATION_CHANNELS, ntfy: { server: 'https://ntfy.sh', topic: '' } });
  const s = sanitizeNotificationChannels({ desktop: { finished: 'yes', failed: 1 }, phone: 5, phoneText: 'true', clusterFinished: 'x' });
  assert.deepEqual(s.desktop, { finished: false, failed: false, waiting: false });
  assert.equal(s.phoneText, false);
  assert.equal(s.clusterFinished, 'director');
});

test('switches, cluster source and address are kept when valid', () => {
  const s = sanitizeNotificationChannels({ desktop: { waiting: true }, phone: { finished: true, failed: true }, clusterFinished: 'all', phoneText: true, ntfy: { server: 'https://ntfy.example.org/', topic: 'arco-abc_123' } });
  assert.equal(s.desktop.waiting, true);
  assert.equal(s.phone.finished, true);
  assert.equal(s.clusterFinished, 'all');
  assert.equal(s.ntfy.server, 'https://ntfy.example.org');
  assert.equal(s.ntfy.topic, 'arco-abc_123');
});

test('topic and server are validated', () => {
  assert.equal(isValidNtfyTopic('a b'), false);
  assert.equal(isValidNtfyTopic('x'.repeat(65)), false);
  assert.equal(normalizeNtfyServer('ftp://x'), null);
  assert.equal(normalizeNtfyServer('https://' + 'user:pw' + '@host.example'), null);
  assert.equal(sanitizeNotificationChannels({ ntfy: { server: 'nope', topic: '../x' } }).ntfy.topic, '');
});

test('the access token is kept, replaced or cleared explicitly', () => {
  assert.equal(sanitizeNotificationChannels({ ntfy: {} }, 'old').ntfy.token, 'old');
  assert.equal(sanitizeNotificationChannels({ ntfy: { token: ' new ' } }, 'old').ntfy.token, 'new');
  assert.equal(sanitizeNotificationChannels({ ntfy: { token: null } }, 'old').ntfy.token, undefined);
  assert.equal(sanitizeNotificationChannels({ ntfy: { token: '' } }, 'old').ntfy.token, undefined);
});
