import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { BakeoffState } from '@arco/shared';
import { useAppStore } from '../../stores/appStore';

// DiffView imports presentation styles. Keep the real component graph while
// allowing Node's DOM fixture to load it without a browser stylesheet loader.
const styles = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.css')
      ? { format: 'module', source: '', shortCircuit: true }
      : nextLoad(url, context);
  },
});
const { BakeoffTab } = await import('./BakeoffTab');
styles.deregister();

for (const cached of [false, true]) {
  test(`Bakeoff survives an ${cached ? 'empty cached' : 'uncached'} list, delayed records and navigation`, async () => {
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
    const globals = Object.getOwnPropertyDescriptors(globalThis);
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: dom.window },
      document: { configurable: true, value: dom.window.document },
      localStorage: { configurable: true, value: dom.window.localStorage },
      IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    });
    const before = useAppStore.getState();
    const storage = useAppStore.persist.getOptions().storage;
    useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
    const root = createRoot(dom.window.document.getElementById('root')!);
    let requests = 0;
    const onList = () => { requests++; };
    try {
      useAppStore.setState({ jobs: {}, bakeoffsByWorkflow: {} });
      useAppStore.getState().createJob('bakeoff-fixture', {
        name: 'Saved source workflow', workingDirectory: '/projects/fixture', skipPermissions: false,
        primaryProvider: 'claude', primaryModel: 'sonnet', primaryEffort: 'low',
      });
      const job = useAppStore.getState().jobs['bakeoff-fixture'];
      const source = JSON.stringify(job);
      if (cached) useAppStore.getState().setBakeoffs(job.id, []);
      await act(async () => root.render(createElement(BakeoffTab, { job, onList })));
      assert.equal(requests, 1);
      assert.match(dom.window.document.body.textContent!, /NO BAKE-OFFS YET/);
      await act(async () => { useAppStore.setState({ connected: true }); });
      assert.equal(requests, 1);
      assert.equal(useAppStore.getState().bakeoffsByWorkflow[job.id]?.length, cached ? 0 : undefined);

      const record: BakeoffState = {
        id: 'saved-comparison', sourceWorkflowId: job.id, sourceCwd: '/projects/fixture',
        name: 'Saved candidate comparison', prompt: 'Preserved comparison prompt',
        baseRef: 'abcdef0123456789', baseBranch: 'main', createdAt: 1, updatedAt: 2,
        status: 'ready', attempts: [{
          id: 'saved-attempt', index: 0, label: 'Saved attempt result', provider: 'claude',
          model: 'sonnet', effort: 'low', workflowId: 'saved-attempt-workflow',
          worktreePath: '/projects/fixture-attempt', branch: 'fixture-attempt', status: 'done',
        }],
      };
      const original = structuredClone(record);
      await act(async () => { useAppStore.getState().setBakeoffs(job.id, [record]); });
      assert.match(dom.window.document.body.textContent!, /Saved candidate comparison/);
      assert.match(dom.window.document.body.textContent!, /SAVED ATTEMPT RESULT/);
      for (let index = 0; index < 3; index++) {
        await act(async () => root.render(createElement('div', null, 'Other tab')));
        await act(async () => root.render(createElement(BakeoffTab, { job, onList })));
      }
      assert.equal(requests, 4);
      assert.deepEqual(useAppStore.getState().bakeoffsByWorkflow[job.id], [original]);
      assert.deepEqual(record, original);
      assert.equal(JSON.stringify(useAppStore.getState().jobs[job.id]), source);
    } finally {
      await act(async () => root.unmount());
      useAppStore.setState(before, true);
      useAppStore.persist.setOptions({ storage });
      for (const name of ['window', 'document', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT']) {
        if (globals[name]) Object.defineProperty(globalThis, name, globals[name]);
        else Reflect.deleteProperty(globalThis, name);
      }
      dom.window.close();
    }
  });
}
