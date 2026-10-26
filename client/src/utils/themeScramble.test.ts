import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { installThemeScramble } from './themeScramble.js';

// The scramble runs on requestAnimationFrame against live DOM text. A frame
// clock driven by the test makes the 420 ms reveal deterministic.
function setup(html: string) {
  const { window } = new JSDOM(`<body>${html}</body>`, { pretendToBeVisual: true });
  let now = 0;
  const frames: Array<() => void> = [];
  const g = globalThis as Record<string, unknown>;
  const saved = ['window', 'document', 'Node', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame'].map((k) => [k, g[k]] as const);
  Object.assign(g, {
    window, document: window.document, Node: window.Node, performance: { now: () => now },
    requestAnimationFrame: (cb: () => void) => { frames.push(cb); return frames.length; },
    cancelAnimationFrame: () => {},
  });
  const uninstall = installThemeScramble();
  const change = () => window.dispatchEvent(new window.Event('arco:theme-changed'));
  const step = (ms: number) => { now += ms; const run = frames.splice(0); run.forEach((cb) => cb()); };
  const restore = () => { uninstall(); for (const [k, v] of saved) g[k] = v; };
  return { doc: window.document, change, step, restore };
}

test('text React replaces mid-scramble keeps the new value', () => {
  const { doc, change, step, restore } = setup('<h3>Appearance</h3><span class="display-font">Voice</span>');
  try {
    change(); // the first event (initial theme load) never scrambles
    change();
    step(16); step(100);
    const heading = doc.querySelector('h3')!.firstChild as Text;
    assert.notEqual(heading.data, 'Appearance', 'scrambling while the reveal runs');
    heading.data = 'Search results'; // what React does when the heading changes
    for (let i = 0; i < 10; i++) step(100);
    assert.equal(heading.data, 'Search results');
    assert.equal(doc.querySelector('span')!.textContent, 'Voice', 'untouched text still resolves');
  } finally { restore(); }
});

test('a second theme change restores only text the scramble still owns', () => {
  const { doc, change, step, restore } = setup('<h3>Projects</h3><h2>SETTINGS</h2>');
  try {
    change(); change(); step(16); step(50);
    (doc.querySelector('h3')!.firstChild as Text).data = 'Voice';
    change(); for (let i = 0; i < 10; i++) step(100);
    assert.equal(doc.querySelector('h3')!.textContent, 'Voice');
    assert.equal(doc.querySelector('h2')!.textContent, 'SETTINGS');
  } finally { restore(); }
});
