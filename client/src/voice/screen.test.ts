import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { actOnScreen, readScreen, readText } from './screen.js';
import { voiceText } from '@arco/shared';

test('screen labels and capped reading never return half an emoji to MCP', () => {
  const {window} = new JSDOM(`<body><button>${'x'.repeat(59)}😀 tail</button><p>${'y'.repeat(11)}😀 tail</p></body>`,{pretendToBeVisual:true});
  const result=readScreen(window.document);
  assert.equal(result.controls[0].label,'x'.repeat(59));
  assert.equal(voiceText(result.text),result.text);
  assert.equal(voiceText(readText(window.document,{limit:60})),readText(window.document,{limit:60}));
  assert.equal(voiceText('a😀b',2),'a');
  assert.equal(voiceText('a😀b',3),'a😀');
  assert.equal(voiceText('a\uD83Db\uDE00c'),'a�b�c');
});

const page = () => new JSDOM(`<!doctype html><html><body>
  <header data-help="header.root"><button data-help="header.settings" title="Open settings">⚙</button></header>
  <div role="tablist"><button role="tab" aria-selected="true" data-help="tabbar.tab">GroundTruth</button><button role="tab" data-help="tabbar.tab">Ledger</button></div>
  <main>
    <label for="goal">North star</label><input id="goal" value="Ship it">
    <select aria-label="Effort"><option>low</option><option selected>medium</option><option>high</option></select>
    <input type="checkbox" aria-label="Auto-fold">
    <button>Purge conversation</button>
    <button disabled>SEND</button>
    <div role="dialog" aria-label="Settings"><h2>SETTINGS</h2><button id="close">CLOSE ✕</button><button>Save</button></div>
    <button style="display:none">Hidden</button>
  </main></body></html>`, { pretendToBeVisual: true });

test('readScreen lists visible controls with labels, regions and state; dialogs first', () => {
  const { window } = page();
  const { text, controls } = readScreen(window.document, { helpTitle: (k) => ({ 'header.settings': 'Settings' } as Record<string, string>)[k] });
  assert.match(text, /^Open dialogs: "Settings"\./m);
  assert.match(text, /dialog "Settings": \[\d+\] button CLOSE ✕; \[\d+\] button Save/);
  assert.match(text, /header: \[\d+\] button Settings/, 'icon-only button labelled from its help title');
  assert.match(text, /tab bar: \[\d+\] tab GroundTruth \(selected\); \[\d+\] tab Ledger/);
  assert.match(text, /field North star \(= "Ship it"\)/);
  assert.match(text, /select Effort \(= medium\)/);
  assert.match(text, /checkbox Auto-fold \(off\)/);
  assert.match(text, /button Purge conversation !/);
  assert.match(text, /button SEND \(disabled\)/);
  assert.doesNotMatch(text, /Hidden/);
  assert.equal(controls.find((c) => c.label === 'CLOSE ✕')?.region, 'dialog "Settings"');
  const { text: filtered } = readScreen(window.document, { filter: 'close' });
  assert.match(filtered, /\[1\] button CLOSE ✕/); assert.doesNotMatch(filtered, /Ledger/);
});

test('actOnScreen clicks by number or label, prefers the open dialog, types with React-visible events, guards destructive controls', async () => {
  const { window } = page();
  const doc = window.document;
  let closed = 0, purged = 0, typed = '', toggled = 0;
  doc.getElementById('close')!.addEventListener('click', () => { closed++; doc.querySelector('[role="dialog"]')!.remove(); });
  Array.from(doc.querySelectorAll('button')).find((b) => b.textContent === 'Purge conversation')!.addEventListener('click', () => purged++);
  doc.getElementById('goal')!.addEventListener('input', (e) => { typed = (e.target as HTMLInputElement).value; });
  doc.querySelector('input[type=checkbox]')!.addEventListener('change', () => toggled++);
  window.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Escape') closed += 10; });

  readScreen(doc);
  assert.equal(await actOnScreen(doc, { control: 'close', action: 'click' }), 'Clicked button CLOSE ✕ in dialog "Settings". Dialog Settings closed.');
  assert.equal(closed, 1);
  assert.match(await actOnScreen(doc, { control: 'close', action: 'click' }), /No visible control is labelled "close"/);
  assert.match(await actOnScreen(doc, { control: 'Purge conversation', action: 'click' }), /looks destructive/);
  assert.equal(purged, 0);
  assert.match(await actOnScreen(doc, { control: 'Purge conversation', action: 'click', confirm: true }), /^Clicked button Purge conversation\./);
  assert.equal(purged, 1);
  assert.match(await actOnScreen(doc, { control: 'North star', action: 'type', text: 'Finish the parser' }), /^Typed into North star: "Finish the parser"\./);
  assert.equal(typed, 'Finish the parser');
  assert.match(await actOnScreen(doc, { control: 'Auto-fold', action: 'toggle' }), /^Toggled checkbox Auto-fold\./);
  assert.equal(toggled, 1); assert.equal((doc.querySelector('input[type=checkbox]') as HTMLInputElement).checked, true);
  assert.match(await actOnScreen(doc, { control: 'Effort', action: 'select', text: 'high' }), /^Set Effort to high\./);
  assert.equal((doc.querySelector('select') as HTMLSelectElement).value, 'high');
  assert.match(await actOnScreen(doc, { control: 'SEND', action: 'click' }), /disabled/);
  assert.match(await actOnScreen(doc, { control: 'tab', action: 'click' }), /Several controls match "tab"/);
  assert.match(await actOnScreen(doc, { control: 'settings', action: 'click' }, { helpTitle: (k) => (k === 'header.settings' ? 'Settings' : undefined) }), /^Clicked button Settings\./, 'help-titled glyph button is clickable by that name');
  const { controls } = readScreen(doc);
  const tally = controls.find((c) => c.label === 'Ledger')!;
  assert.match(await actOnScreen(doc, { control: String(tally.n), action: 'click' }), /^Clicked tab Ledger\./);
  assert.equal(await actOnScreen(doc, { control: '', action: 'press', text: 'Escape' }), 'Pressed Escape.');
  assert.equal(closed, 11, 'Escape reached the window listener');
  assert.match(await actOnScreen(doc, { control: '', action: 'press', text: 'F5' }), /Keys: Escape, Enter/);
});

test('nested controls: a tab wrapper is named by its own text, exact kind+label matches, innermost match wins', async () => {
  const { window } = new JSDOM(`<!doctype html><html><body><div role="tablist" data-help="tabbar.root">
    <div role="button" class="tab"><span>SIGNALQUEUE</span><button aria-label="Close SignalQueue">×</button></div>
    <div role="button" class="tab"><button>ORBIT</button><button aria-label="Close ORBIT">×</button></div>
  </div></body></html>`, { pretendToBeVisual: true });
  const doc = window.document;
  let outer = 0, inner = 0;
  doc.querySelectorAll('div.tab')[1].addEventListener('click', () => outer++);
  Array.from(doc.querySelectorAll('button')).find((b) => b.textContent === 'ORBIT')!.addEventListener('click', () => inner++);
  const { text } = readScreen(doc);
  assert.match(text, /button SIGNALQUEUE; \[\d+\] button Close SignalQueue/, 'wrapper named by its own text, not "SIGNALQUEUE×"');
  assert.match(text, /button ORBIT ×; \[\d+\] button ORBIT; \[\d+\] button Close ORBIT/, 'a wrapper whose only text is in nested controls keeps the full text');
  assert.match(await actOnScreen(doc, { control: 'button ORBIT', action: 'click' }), /^Clicked button ORBIT\./, 'kind + label counts as exact');
  assert.equal(inner, 1, 'the innermost of the nested matches was clicked');
  assert.equal(outer, 1, 'and the click bubbled to the wrapper like a real one');
  assert.match(await actOnScreen(doc, { control: 'signalqueue', action: 'click' }), /^Clicked button SIGNALQUEUE\./);
});

test('build check: bundle parsing and stale comparison', async () => {
  const { bundleOf, runningBundle } = await import('../buildCheck.js');
  const html = '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-CAIBPL1y.js"></script></head><body></body></html>';
  assert.equal(bundleOf(html), '/assets/index-CAIBPL1y.js');
  assert.equal(bundleOf('<script type="module" src="/src/main.tsx"></script>'), null, 'dev entry has no hashed bundle');
  const { window } = new JSDOM(html);
  assert.equal(runningBundle(window.document), '/assets/index-CAIBPL1y.js');
});

test('readText reads the open dialog, one section by heading, or passages mentioning a word; the page when nothing is open', () => {
  const { window } = new JSDOM(`<!doctype html><html><body>
    <main><p>Welcome to Arco.</p><button>SEND</button></main>
    <div role="dialog" aria-label="ARCO · USER MANUAL"><h2>ARCO · USER MANUAL</h2>
      <nav><button>Strata MoE</button><button>Voice</button></nav>
      <section id="manual-strata"><h3>STRATA MOE</h3><p>Strata is a mixture-of-experts pack served by llama.cpp.</p><p>Prepare it from the Strata tab.</p></section>
      <section id="manual-voice"><h3>VOICE</h3><p>Say Computer, then speak.</p><p style="display:none">hidden text</p></section>
    </div></body></html>`, { pretendToBeVisual: true });
  const doc = window.document;
  const strata = readText(doc, { filter: 'strata' });
  assert.match(strata, /^Text of dialog "ARCO · USER MANUAL", the section matching "strata":\nSTRATA MOE\nStrata is a mixture-of-experts pack served by llama\.cpp\.\nPrepare it from the Strata tab\.$/);
  const all = readText(doc);
  assert.match(all, /^Text of dialog "ARCO · USER MANUAL":\n/); assert.match(all, /Say Computer, then speak\./); assert.doesNotMatch(all, /hidden text|Welcome/);
  assert.match(readText(doc, { filter: 'computer' }), /1 passage mentioning "computer":\nVOICE\nSay Computer, then speak\./);
  assert.match(readText(doc, { filter: 'kubernetes' }), /^Nothing on screen in dialog "ARCO · USER MANUAL" mentions "kubernetes"/);
  doc.querySelector('[role="dialog"]')!.remove();
  assert.match(readText(doc), /^Text of the page:\nWelcome to Arco\.\nSEND$/);
  assert.match(readText(doc, { limit: 10 }), /first 10 of \d+ characters/);
});

test('generic options, range values, context menus, hover and double-click use actual controls', async () => {
  const { window } = new JSDOM('<select aria-label="Model"><option value="a">Qwen small</option><option value="b">Qwen large</option><option disabled>Unavailable</option></select><input aria-label="Volume" type="range" min="0" max="100" value="40"><button>File</button>');
  const doc = window.document, events: string[] = [];
  const file = doc.querySelector('button')!;
  for (const e of ['mouseover', 'contextmenu', 'dblclick']) file.addEventListener(e, () => events.push(e));
  assert.match(await actOnScreen(doc, { control: 'Model', action: 'options' }), /Qwen large/);
  assert.match(await actOnScreen(doc, { control: 'Model', action: 'select', text: 'Qwen' }), /Several/);
  assert.equal((doc.querySelector('select')!).value, 'a');
  assert.match(await actOnScreen(doc, { control: 'Model', action: 'select', text: 'Unavailable' }), /disabled/);
  await actOnScreen(doc, { control: 'Volume', action: 'type', text: '70' }); assert.equal(doc.querySelector('input')!.value, '70');
  assert.match(await actOnScreen(doc, { control: 'Volume', action: 'type', text: '200' }), /bounds/);
  for (const action of ['hover', 'context_menu', 'double_click'] as const) await actOnScreen(doc, { control: 'File', action });
  assert.deepEqual(events, ['mouseover', 'contextmenu', 'dblclick']);
});
test('keyboard activation cannot bypass destructive or disabled controls, and Tab moves focus', async () => {
  const { window } = new JSDOM('<button>Delete project</button><button disabled>Disabled</button><input aria-label="Name">');
  const doc = window.document; let clicked = 0; doc.querySelector('button')!.addEventListener('keydown', () => clicked++);
  assert.match(await actOnScreen(doc, { control: 'Delete project', action: 'press', text: 'Enter' }), /confirm/); assert.equal(clicked, 0);
  assert.match(await actOnScreen(doc, { control: 'Disabled', action: 'press', text: 'Enter' }), /disabled/);
  await actOnScreen(doc, { control: 'Name', action: 'focus' });
  await actOnScreen(doc, { control: '', action: 'press', text: 'Tab' }); assert.equal(doc.activeElement, doc.querySelector('button'));
});

test('scrolling a named control scrolls its containing panel rather than the page', async () => {
  const { window } = new JSDOM('<div id="pane"><button>Latest item</button></div>');
  const doc = window.document, pane = doc.getElementById('pane')!;
  Object.defineProperties(pane, { scrollHeight: {value: 1500}, clientHeight: {value: 200} });
  await actOnScreen(doc, { control: 'Latest item', action: 'scroll', text: 'down' }); assert.equal(pane.scrollTop, 160);
  await actOnScreen(doc, { control: 'Latest item', action: 'scroll', text: 'top' }); assert.equal(pane.scrollTop, 0);
  await actOnScreen(doc, { control: 'Latest item', action: 'scroll', text: 'bottom' }); assert.equal(pane.scrollTop, 1500);
});
