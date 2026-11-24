import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleTerminalWindows, type TerminalWindow } from './terminalStore';
import { PHONE_TERMINAL_KEYS, phoneControlInput } from '../components/Terminal/phoneKeys';

const win = (windowId: string): TerminalWindow => ({ windowId, workflowId: 'w', sessionId: windowId });

test('a phone draws only the newest terminal window; a wider screen draws them all', () => {
  const windows = [win('a'), win('b')];
  assert.deepEqual(visibleTerminalWindows(windows, true).map((w) => w.windowId), ['b']);
  assert.deepEqual(visibleTerminalWindows(windows, false).map((w) => w.windowId), ['a', 'b']);
  assert.deepEqual(visibleTerminalWindows([win('a')], true).map((w) => w.windowId), ['a']);
});

test('phone terminal keys use terminal bytes and CTRL modifies the next letter', () => {
  assert.deepEqual(Object.fromEntries(PHONE_TERMINAL_KEYS), { ESC: '\u001b', TAB: '\t', '←': '\u001b[D', '↓': '\u001b[B', '↑': '\u001b[A', '→': '\u001b[C', '|': '|', '~': '~' });
  assert.equal(phoneControlInput('c'), '\u0003');
  assert.equal(phoneControlInput('D'), '\u0004');
  assert.equal(phoneControlInput('\u001b[A'), '\u001b[A');
});
