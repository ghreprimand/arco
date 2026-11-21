import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleTerminalWindows, type TerminalWindow } from './terminalStore';

const win = (windowId: string): TerminalWindow => ({ windowId, workflowId: 'w', sessionId: windowId });

test('a phone draws only the newest terminal window; a wider screen draws them all', () => {
  const windows = [win('a'), win('b')];
  assert.deepEqual(visibleTerminalWindows(windows, true).map((w) => w.windowId), ['b']);
  assert.deepEqual(visibleTerminalWindows(windows, false).map((w) => w.windowId), ['a', 'b']);
  assert.deepEqual(visibleTerminalWindows([win('a')], true).map((w) => w.windowId), ['a']);
});
