import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { linkTextFiles, resolveChatFilePath, type WrittenFilesIndex } from '../utils/chatFileLinks';

const empty = (): WrittenFilesIndex => ({ byBasename: new Map(), byTail: new Map() });

test('relative names are sent as written, never joined onto the project folder', () => {
  assert.equal(resolveChatFilePath('audit.md', '/work/proj'), 'audit.md');
  assert.equal(resolveChatFilePath('./notes/a.md', '/work/proj'), 'notes/a.md');
  assert.equal(resolveChatFilePath('audit.md', undefined), null);
});

test('Windows absolute paths are kept as they are', () => {
  assert.equal(resolveChatFilePath('C:\\Users\\me\\report.md', 'D:\\proj'), 'C:\\Users\\me\\report.md');
  assert.equal(resolveChatFilePath('D:/x/report.md', '/work/proj'), 'D:/x/report.md');
  assert.equal(resolveChatFilePath('\\\\host\\share\\r.md', '/work/proj'), '\\\\host\\share\\r.md');
});

test('the written-files index matches Windows separators', () => {
  const index = empty();
  index.byBasename.set('audit.md', 'C:\\p\\reports\\audit.md');
  index.byTail.set('reports/audit.md', 'C:\\p\\reports\\audit.md');
  assert.equal(resolveChatFilePath('reports\\audit.md', 'C:\\p', index), 'C:\\p\\reports\\audit.md');
  assert.equal(resolveChatFilePath('audit.md', 'C:\\p', index), 'C:\\p\\reports\\audit.md');
});

async function render(content: string, index: WrittenFilesIndex): Promise<string> {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  const globals = Object.getOwnPropertyDescriptors(globalThis);
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window }, document: { configurable: true, value: dom.window.document },
    localStorage: { configurable: true, value: dom.window.localStorage }, IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    const resolve = (name: string, strict: boolean) => {
      if (strict && !index.byBasename.has(name)) return null;
      return resolveChatFilePath(name, '/work/proj', index);
    };
    const tree = content.split('\n\n').map((para, i) => createElement('p', { key: i }, linkTextFiles(para, resolve, (p, label, key) => createElement('span', { key, title: p }, label))));
    await act(async () => root.render(createElement('div', null, ...tree)));
    return Array.from(dom.window.document.querySelectorAll('span[title]')).map((e) => `${e.textContent}=>${e.getAttribute('title')}`).join('|');
  } finally {
    await act(async () => root.unmount());
    for (const key of ['window', 'document', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (globals[key]) Object.defineProperty(globalThis, key, globals[key]); else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

test('a filename alone on a plain line links, even when nothing wrote it', async () => {
  const links = await render('Report ready:\n\nsummary.md\n\ndone', empty());
  assert.equal(links, 'summary.md=>summary.md');
});

test('a filename inside a sentence links only when it is a known file', async () => {
  const index = empty();
  index.byBasename.set('known.md', '/work/proj/.arco/workflows/wf/artifacts/known.md');
  const links = await render('See known.md and also other.md for details.', index);
  assert.equal(links, 'known.md=>/work/proj/.arco/workflows/wf/artifacts/known.md');
});
