import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { isUpdateStatus, useAppUpdateStore } from './appUpdateStore.js';
const notice = { type: 'app_update_available' as const, current: '0.1.0', latest: 'v0.2.0', url: 'https://github.com/ghreprimand/arco/releases/tag/v0.2.0', publishedAt: '2026-10-27T12:00:00Z' };
afterEach(() => useAppUpdateStore.setState({ status: null, notice: null }));
test('invalid status and unsafe release links cannot create an update notice', () => {
  assert.equal(isUpdateStatus({}), false);
  assert.equal(isUpdateStatus({ current: '0.1.0', enabled: true, updateAvailable: true, latest: {} }), false);
  useAppUpdateStore.getState().receive({ ...notice, url: 'javascript:alert(1)' });
  assert.equal(useAppUpdateStore.getState().notice, null);
});
test('a version is deduplicated and a newer message replaces it', () => {
  useAppUpdateStore.getState().receive(notice);
  const first = useAppUpdateStore.getState().notice;
  useAppUpdateStore.getState().receive({ ...notice });
  assert.equal(useAppUpdateStore.getState().notice, first);
  useAppUpdateStore.getState().receive({ ...notice, latest: 'v0.3.0' });
  assert.equal(useAppUpdateStore.getState().notice?.latest, 'v0.3.0');
});
test('cached GET and explicit POST use only the local API; opt-out clears a notice', async (t) => {
  let enabled = true;
  const methods: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, '/api/update-check'); methods.push(options.method!);
    return Response.json({ ...notice, checkedAt: null, updateAvailable: true, enabled });
  });
  await useAppUpdateStore.getState().refresh();
  assert.equal(useAppUpdateStore.getState().notice?.latest, 'v0.2.0');
  enabled = false; await useAppUpdateStore.getState().refresh(true);
  assert.deepEqual(methods, ['GET', 'POST']); assert.equal(useAppUpdateStore.getState().notice, null);
});
test('failed refresh preserves known release information', async (t) => {
  useAppUpdateStore.getState().receive(notice);
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  await assert.rejects(useAppUpdateStore.getState().refresh());
  assert.equal(useAppUpdateStore.getState().notice?.latest, 'v0.2.0');
});
