import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { renderLifecycleCommand } from './allowlist.js';
// @ts-expect-error -- plain ESM packaging module without type declarations
import { renderService, servicePaths } from '../packaging/services.mjs';

const plistLabel = (): string => {
  const plist: string = renderService('darwin', { node: '/n', entry: '/e', config: '/h/service/config.json', home: '/h' });
  const match = /<key>Label<\/key><string>([^<]+)<\/string>/.exec(plist);
  assert.ok(match, 'the packaged LaunchAgent has a label');
  return match[1];
};

test('macOS lifecycle commands address the LaunchAgent that arco service install writes', () => {
  const label = plistLabel();
  assert.ok(servicePaths('darwin', {}).unit.endsWith(`${label}.plist`), 'plist file name matches its label');
  const target = `gui/501/${label}`;
  assert.deepEqual(renderLifecycleCommand('arco.status', 'macos', { uid: 501 }), { cmd: 'launchctl', args: ['print', target] });
  assert.deepEqual(renderLifecycleCommand('arco.start', 'macos', { uid: 501 }), { cmd: 'launchctl', args: ['kickstart', target] });
  assert.deepEqual(renderLifecycleCommand('arco.restart', 'macos', { uid: 501 }), { cmd: 'launchctl', args: ['kickstart', '-k', target] });
});

test('macOS stop leaves the job loaded so a later start can kickstart it', () => {
  const stop = renderLifecycleCommand('arco.stop', 'macos', { uid: 501 });
  assert.equal(stop?.cmd, 'launchctl');
  assert.notEqual(stop?.args[0], 'bootout', 'bootout unloads the job and kickstart then fails');
  assert.deepEqual(stop?.args, ['kill', 'SIGTERM', `gui/501/${plistLabel()}`]);
});

test('macOS commands need the user id and honor a label override', () => {
  for (const command of ['arco.status', 'arco.start', 'arco.stop', 'arco.restart'] as const) {
    assert.equal(renderLifecycleCommand(command, 'macos'), null, `${command} without a uid`);
    assert.equal(renderLifecycleCommand(command, 'macos', { uid: -1 }), null, `${command} with an invalid uid`);
  }
  assert.deepEqual(renderLifecycleCommand('arco.restart', 'macos', { uid: 501, macLabel: 'com.example.arco' })?.args, ['kickstart', '-k', 'gui/501/com.example.arco']);
  assert.equal(renderLifecycleCommand('arco.logs.tail', 'macos', { uid: 501 }), null);
});

test('Linux lifecycle commands are unchanged', () => {
  assert.deepEqual(renderLifecycleCommand('arco.restart', 'linux'), { cmd: 'systemctl', args: ['--user', 'restart', 'arco.service'] });
  assert.equal(servicePaths('linux', { XDG_CONFIG_HOME: '/c' }).unit, join('/c', 'systemd', 'user', 'arco.service'));
});
