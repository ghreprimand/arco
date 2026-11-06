import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { ArcoSettings, AuthStatusByProvider, ModelName, ProviderName, SessionInfo, WorkerState } from '@arco/shared';
import { useAppStore } from '../stores/appStore';
import { UsageBar } from './UsageBar';
import { WorkerCard } from './WorkerCard';
import { TerminalSessions } from './TerminalSessions';

// One letter per provider: A Claude, C Codex, X Cursor, O Ollama, L llama.cpp.
// The old pair (C Claude, R Cursor, X Codex) must not come back on a surface.

const OLD = [
  ['letter=', '"', 'R', '"'].join(''),
  ['letter=', "'", 'R', "'"].join(''),
  ['case ', "'cursor': return '", 'R', "'"].join(''),
  ['case ', "'claude': return '", 'C', "'"].join(''),
  ['case ', "'codex': return '", 'X', "'"].join(''),
  ['claude', "' ? '", 'C', "'"].join(''),
  ['cursor', "' ? '", 'R', "'"].join(''),
  ['codex', "' ? '", 'X', "'"].join(''),
  ['<C>', 'R', '</C>'].join(''),
  ['<Code>', 'R', '</Code>'].join(''),
];

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path);
    return /\.(tsx?|py)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

test('no surface still assigns the old provider letters', () => {
  const root = resolve(import.meta.dirname, '../../..');
  const hits: string[] = [];
  for (const path of [...filesUnder(join(root, 'client/src')), ...filesUnder(join(root, 'scripts/smoke'))]) {
    const text = readFileSync(path, 'utf8');
    for (const phrase of OLD) if (text.includes(phrase)) hits.push(`${path.slice(root.length + 1)}: ${phrase}`);
  }
  assert.deepEqual(hits, []);
});

function worker(provider: ProviderName): WorkerState {
  return {
    id: 'worker-1', model: 'fixture' as ModelName, effort: 'medium', status: 'completed', provider,
    task: '', output: '', thinking: '', toolCalls: [], spawnedAt: 0, lastActivityAt: 0, durationMs: 1,
  };
}

test('dots, worker cards and terminal sessions show A C X O L', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const globals = Object.getOwnPropertyDescriptors(globalThis);
  const before = useAppStore.getState();
  const storage = useAppStore.persist.getOptions().storage;
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    localStorage: { configurable: true, value: dom.window.localStorage },
    fetch: { configurable: true, value: async () => new Response(JSON.stringify({ sessions: [
      { sessionId: 'claude-1', cwd: '/fixture', name: 'Claude session', startedAt: Date.now(), provider: 'claude' },
      { sessionId: 'codex-1', cwd: '/fixture', name: 'Codex session', startedAt: Date.now(), provider: 'codex' },
    ] satisfies SessionInfo[] }), { status: 200, headers: { 'Content-Type': 'application/json' } }) },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  useAppStore.persist.setOptions({ storage: { getItem: () => null, setItem() {}, removeItem() {} } });
  const auth = Object.fromEntries(['claude', 'codex', 'cursor', 'ollama', 'github', 'llamacpp', 'lmstudio', 'strata', 'deepseek'].map((id) => [id, { loggedIn: true, cli: { loggedIn: true } }])) as unknown as AuthStatusByProvider;
  useAppStore.setState({
    authStatus: auth, jobs: {}, activeJobId: null, connected: true,
    settings: { enabledProviders: { claude: true, codex: true, cursor: true, ollama: true } } as ArcoSettings,
  });
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    await act(async () => root.render(createElement(UsageBar, { usage: null, onDotClick: () => {} })));
    const dots = [...dom.window.document.querySelectorAll('[data-testid="provider-dot"], [aria-label$="status details"]')].map((el) => el.textContent?.trim());
    assert.deepEqual(dots, ['A', 'C', 'X', 'O']);
    assert.equal(dom.window.document.querySelector('[aria-label="Claude usage page"], [aria-label^="Claude status"]')?.textContent?.includes('R'), false);

    const titles = { codex: 'Codex (OpenAI)', cursor: 'Cursor (ACP · ~153 models)', ollama: 'Ollama (local)', llamacpp: 'llama.cpp (local)' } as const;
    for (const [provider, letter] of [['codex', 'C'], ['cursor', 'X'], ['ollama', 'O'], ['llamacpp', 'L']] as const) {
      await act(async () => root.render(createElement(WorkerCard, { jobId: 'job', worker: worker(provider) })));
      const badge = dom.window.document.querySelector(`[aria-label="${titles[provider]}"]`);
      assert.equal(badge?.textContent?.trim(), letter, provider);
    }
    await act(async () => root.render(createElement(WorkerCard, { jobId: 'job', worker: worker('claude') })));
    assert.equal(dom.window.document.body.textContent?.includes('Claude (Anthropic)'), false);

    await act(async () => {
      root.render(createElement(TerminalSessions, { cwd: '/fixture', onOpen: () => {} }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const marks = [...dom.window.document.querySelectorAll('span[title]')].map((el) => `${el.getAttribute('title')}:${el.textContent?.trim()}`);
    assert.deepEqual(marks.sort(), ['Claude:A', 'Codex:C']);
  } finally {
    await act(async () => root.unmount());
    useAppStore.setState(before, true);
    useAppStore.persist.setOptions({ storage });
    for (const name of ['window', 'document', 'localStorage', 'fetch', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (globals[name]) Object.defineProperty(globalThis, name, globals[name]);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
});
