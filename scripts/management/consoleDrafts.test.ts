import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { consoleHtml, consoleJs, chatHtml } from './console.js';

const settled = () => new Promise<void>(resolve => setImmediate(resolve));

test('B194: polling preserves broadcast text, recipient picks and question answers', async () => {
  const dom = new JSDOM(consoleHtml(), { url: 'http://localhost', runScripts: 'outside-only' });
  const workflow = (id: string) => ({ workflowId: id, title: id, state: 'idle', provider: 'fixture', model: 'fixture', pendingQuestion: { questionId: 'question-' + id, text: 'Continue?' } });
  const data = { instances: [{ instance: { instanceId: 'instance', name: 'Fixture', platform: 'linux' }, state: 'online',
    workflows: [workflow('one'), workflow('two')], clusters: [{ clusterId: 'cluster', name: 'Fixture', memberIds: ['one', 'two'], efficiencyLevel: 'balanced' }] }] };
  const win = dom.window;
  win.fetch = async () => Response.json(data);
  win.setInterval = (() => 0) as any;
  try {
    win.eval(consoleJs());
    await settled();
    const broadcast = [...win.document.querySelectorAll('button')].find(b => b.textContent === 'Broadcast')!;
    assert.ok(broadcast);
    broadcast.click();
    win.document.querySelector<HTMLTextAreaElement>('.bc-text')!.value = 'Unsent broadcast';
    win.document.querySelector<HTMLInputElement>('.bc-member input')!.checked = false;
    win.document.querySelector<HTMLInputElement>('.needs-input')!.value = 'Unsent answer';
    data.instances[0].workflows[1].title = 'Changed worker';
    await win.eval('refresh()');
    assert.equal(win.document.querySelector<HTMLTextAreaElement>('.bc-text')?.value, 'Unsent broadcast');
    assert.equal(win.document.querySelector<HTMLInputElement>('.bc-member input')?.checked, false);
    assert.equal(win.document.querySelector<HTMLInputElement>('.needs-input')?.value, 'Unsent answer');
  } finally { win.close(); }
});

test('B194: a completed phone chat send does not clear a newer draft', async () => {
  const dom = new JSDOM(chatHtml('instance', 'workflow', 'Fixture'), { url: 'http://localhost', runScripts: 'outside-only' });
  const win = dom.window;
  win.setInterval = (() => 0) as any;
  win.setTimeout = (() => 0) as any;
  let resolveSend!: (value: Response) => void;
  win.fetch = async (_url: any, init?: any) => init?.method === 'POST'
    ? new Promise<Response>(resolve => { resolveSend = resolve; })
    : Response.json({ turns: [], totalTurns: 0, busy: false });
  try {
    win.eval(win.document.querySelector('script')!.textContent!);
    await settled();
    const input = win.document.querySelector<HTMLTextAreaElement>('#input')!;
    input.value = 'First message';
    const pending = win.eval('sendMsg()');
    input.value = 'New unsent message';
    input.dispatchEvent(new win.Event('input', { bubbles: true }));
    resolveSend(Response.json({ ok: true }));
    await pending;
    assert.equal(input.value, 'New unsent message');
  } finally { win.close(); }
});
