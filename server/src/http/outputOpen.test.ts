import assert from 'node:assert/strict';
import { test } from 'node:test';
import { desktopOpenAvailable, isLoopbackAddress, openerCommand, refusalFor, REFUSED_EXTENSIONS } from './outputOpen.js';

test('opener passes the path as one argument on every OS', () => {
  const file = 'C:\\Users\\a b\\x & calc.pdf';
  assert.deepEqual(openerCommand('win32', file), { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', file] });
  assert.deepEqual(openerCommand('darwin', '/a b/x.pdf'), { command: 'open', args: ['/a b/x.pdf'] });
  assert.deepEqual(openerCommand('linux', '/a b/x.pdf'), { command: 'xdg-open', args: ['/a b/x.pdf'] });
});
test('program, script and extensionless types are refused; documents are not', () => {
  for (const name of ['a.exe', 'a.BAT', 'a.cmd', 'a.ps1', 'a.msi', 'a.com', 'a.scr', 'a.vbs', 'a.js', 'a.sh', 'a.app', 'a.command', 'a.desktop', 'a.jar', 'a.lnk', 'noext']) assert.ok(refusalFor(name), name);
  for (const name of ['a.pdf', 'a.docx', 'a.odt', 'a.md', 'a.png', 'a.zip']) assert.equal(refusalFor(name), null, name);
  assert.ok(REFUSED_EXTENSIONS.includes('exe'));
});
test('desktop availability and loopback checks', () => {
  assert.equal(desktopOpenAvailable('win32', {}, false), true);
  assert.equal(desktopOpenAvailable('darwin', {}, false), true);
  assert.equal(desktopOpenAvailable('linux', {}, false), false);
  assert.equal(desktopOpenAvailable('linux', { DISPLAY: ':0' }, false), true);
  assert.equal(desktopOpenAvailable('linux', { DISPLAY: ':0' }, true), false);
  assert.equal(desktopOpenAvailable('linux', { DISPLAY: ':0', ARCO_DOCKER: '1' }, false), false);
  assert.ok(isLoopbackAddress('127.0.0.1') && isLoopbackAddress('::1') && !isLoopbackAddress('10.0.0.5') && !isLoopbackAddress(undefined));
});
