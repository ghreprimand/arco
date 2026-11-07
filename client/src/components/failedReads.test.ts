import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transform } from 'esbuild';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

for (const [file, exported, props] of [
  ['GitHubPanel/IssueView.tsx', 'IssueView', { view: { owner: 'fixture', name: 'repo', number: 1 }, onBack() {} }],
  ['GitHubPanel/RunView.tsx', 'RunView', { view: { owner: 'fixture', name: 'repo', id: 1 }, onBack() {} }],
  ['GitHubPanel/PullView.tsx', 'PullView', { view: { owner: 'fixture', name: 'repo', number: 1 }, onBack() {} }],
  ['DiagnosticsTab.tsx', 'DiagnosticsTab', {}],
  ['ModelHealthPanel.tsx', 'ModelHealthPanel', {}],
  ['RightPanel/UsageTab.tsx', 'ProjectUsageTab', { cwd: '/projects/fixture' }],
] as const) {
  for (const status of [500, 200]) test(`B154: ${exported} (${status}) shows read errors without a render failure`, async () => {
    const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost' });
    const previous = Object.getOwnPropertyDescriptors(globalThis);
    const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
      fetch: async () => Response.json({ error: 'Synthetic service unavailable' }, { status }),
    };
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    const fileUrl = new URL(file, import.meta.url);
    const require = createRequire(fileUrl);
    const mockedRequire = (name: string) => {
      if (name === './shared') return new Proxy({}, { get: (_target, key) => key === 'useVisiblePolling' ? () => {} : (p: any) => React.createElement('div', null, p?.message ?? p?.children) });
      if (name.endsWith('/appStore')) return { useAppStore: (selector: any) => selector({ authStatus: {}, cursorUsage: null }) };
      if (name === './FilesTab') return { EmptyState: (p: any) => React.createElement('div', null, p.text) };
      if (name.endsWith('/CursorIncludedGauge')) return { CursorIncludedGauge: () => null };
      if (name === './GhFilesDiff') return { GhFilesDiff: () => null };
      return require(name);
    };
    const result = await transform(await readFile(fileUrl, 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'automatic' });
    const module = { exports: {} as Record<string, React.ComponentType<any>> };
    new Function('require', 'module', 'exports', result.code)(mockedRequire, module, module.exports);
    const root = createRoot(dom.window.document.getElementById('root')!);
    try {
      await act(async () => root.render(React.createElement(module.exports[exported], props)));
      assert.match(dom.window.document.body.textContent ?? '', /Synthetic service unavailable|500|invalid response/);
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
      for (const key of Object.keys(globals)) {
        if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
        else delete (globalThis as any)[key];
      }
    }
  });
}
