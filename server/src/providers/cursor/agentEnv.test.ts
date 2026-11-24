import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideCursorDisplay, type CursorDisplayInputs } from './agentEnv.js';

// A service with a session bus and no display: cursor-agent reads its keyring
// sign-in only when given the user's own desktop display.
test('cursor-agent gets the user desktop display only for a keyring sign-in', () => {
  const sockets: Record<string, number> = {
    '/run/user/1000/bus': 1000,
    '/run/user/1000/wayland-1': 1000,
    '/run/user/1000/wayland-0': 0,
    '/tmp/.X11-unix/X0': 1000,
  };
  const base: CursorDisplayInputs = {
    platform: 'linux',
    env: { XDG_RUNTIME_DIR: '/run/user/1000' },
    storedIn: 'os-secret-store',
    uid: 1000,
    socketOwner: (path) => sockets[path],
    listDir: (dir) => Object.keys(sockets).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
  };

  assert.deepEqual(decideCursorDisplay(base), { kind: 'display', name: 'WAYLAND_DISPLAY', value: 'wayland-1' });
  delete sockets['/run/user/1000/wayland-1'];
  assert.deepEqual(decideCursorDisplay(base), { kind: 'display', name: 'DISPLAY', value: ':0' });
  delete sockets['/tmp/.X11-unix/X0'];
  assert.deepEqual(decideCursorDisplay(base), { kind: 'no-display' });
  assert.deepEqual(decideCursorDisplay({ ...base, storedIn: undefined }), { kind: 'not-needed' });
  assert.deepEqual(decideCursorDisplay({ ...base, env: { ...base.env, DISPLAY: ':1' } }), { kind: 'not-needed' });
  assert.deepEqual(decideCursorDisplay({ ...base, platform: 'darwin' }), { kind: 'not-needed' });
});
