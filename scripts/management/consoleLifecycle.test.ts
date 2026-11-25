import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { consoleHtml, consoleJs, lifecycleDisabled } from './console.js';

const COMMANDS = ['arco.status', 'arco.start', 'arco.restart', 'arco.stop', 'arco.logs.tail'] as const;

test('an offline card keeps Status, Start and Logs only when an SSH target is configured', async () => {
  for (const cmd of COMMANDS) {
    const kept = cmd === 'arco.status' || cmd === 'arco.start' || cmd === 'arco.logs.tail';
    assert.equal(lifecycleDisabled('offline', cmd, true), !kept, cmd);
    assert.equal(lifecycleDisabled('offline', cmd, false), true, cmd);
    assert.equal(lifecycleDisabled('online', cmd, false), false, cmd);
    assert.equal(lifecycleDisabled('stale', cmd, false), false, cmd);
  }

  const dom = new JSDOM(consoleHtml(), { url: 'http://localhost', runScripts: 'outside-only' });
  const instance = { instanceId: 'instance', name: 'Fixture', hostname: 'fixture', platform: 'linux', serviceMode: 'service', version: '0', gitRevision: 'abc' };
  const card = (ssh: boolean) => ({ instance, state: 'offline', ssh, lastHeartbeatAt: 1, workflows: [], clusters: [] });
  const win = dom.window;
  const data = { instances: [card(true), { ...card(false), instance: { ...instance, instanceId: 'other', name: 'Other' } }] };
  win.fetch = async () => Response.json(data);
  win.setInterval = (() => 0) as typeof win.setInterval;
  try {
    win.eval(consoleJs());
    await new Promise<void>(resolve => setImmediate(resolve));
    const cards = [...win.document.querySelectorAll('.card')];
    assert.equal(cards.length, 2);
    const enabled = (root: Element, label: string) => !([...root.querySelectorAll('button')].find(b => b.textContent === label) as HTMLButtonElement).disabled;
    assert.equal(enabled(cards[0], 'Start'), true);
    assert.equal(enabled(cards[0], 'Status'), true);
    assert.equal(enabled(cards[0], 'Logs'), true);
    assert.equal(enabled(cards[0], 'Restart'), false);
    assert.equal(enabled(cards[0], 'Stop'), false);
    assert.equal(cards[0].textContent?.includes('No SSH target is configured'), false);
    for (const label of ['Status', 'Start', 'Restart', 'Stop', 'Logs']) assert.equal(enabled(cards[1], label), false, label);
    assert.equal(cards[1].textContent?.includes('No SSH target is configured. Status, Start, Restart, Stop and Logs stay off.'), true);
  } finally { win.close(); }
});
