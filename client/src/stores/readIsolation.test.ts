import test from 'node:test';
import assert from 'node:assert/strict';
import { useSessionIndexStore } from './sessionIndexStore';
import { useRecallStore, EMPTY_FILTERS } from './recallStore';
import { useTerminalStore } from './terminalStore';

for (const kind of ['session', 'recall']) test(`${kind}: only the latest read may install results or errors`, async () => {
  const original = globalThis.fetch;
  const pending: Array<(response: Response) => void> = [];
  const failures: Array<(error: Error) => void> = [];
  globalThis.fetch = () => new Promise((resolve, reject) => { pending.push(resolve); failures.push(reject); });
  try {
    const run = (key: string) => kind === 'session' ? useSessionIndexStore.getState().fetchIndex(key) : useRecallStore.getState().runSearch({ ...EMPTY_FILTERS, q: key });
    const body = (key: string) => kind === 'session' ? { entries: [{ provider: 'claude', sessionId: key }] } : { hits: [{ wfid: key }], transcriptsAvailable: true };
    const first = run('first'); const second = run('second');
    pending[1](Response.json(body('second'))); await second;
    pending[0](Response.json(body('first'))); await first;
    if (kind === 'session') assert.ok(useSessionIndexStore.getState().entries['claude:second']);
    else assert.equal(useRecallStore.getState().hits[0]?.wfid, 'second');
    const stale = run('stale-error'); const latest = run('current');
    failures[2](new Error('stale failure')); await stale;
    assert.equal(kind === 'session' ? useSessionIndexStore.getState().loading : useRecallStore.getState().searching, true);
    pending[3](Response.json(body('current'))); await latest;
    assert.equal(kind === 'session' ? useSessionIndexStore.getState().error : useRecallStore.getState().searchError, null);
  } finally { globalThis.fetch = original; }
});

test('terminal snapshots reconcile only their own workflow windows', () => {
  const before = useTerminalStore.getState();
  useTerminalStore.setState({ windows: [
    { windowId: 'one', workflowId: 'one', sessionId: 'session-one' },
    { windowId: 'two', workflowId: 'two', sessionId: 'session-two' },
  ] });
  try {
    useTerminalStore.getState().setSessions('one', []);
    assert.equal(useTerminalStore.getState().windows[0].sessionId, null);
    assert.equal(useTerminalStore.getState().windows[1].sessionId, 'session-two');
  } finally { useTerminalStore.setState({ windows: before.windows, sessionsByWorkflow: before.sessionsByWorkflow }); }
});
