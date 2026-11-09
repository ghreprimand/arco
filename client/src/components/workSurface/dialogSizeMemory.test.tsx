import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { act, createElement, createRef, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorkSurfaceControls } from './WorkSurfaceControls';

// Remembered dialog size: one key per kind, rejected when it could carry a
// path, applied again on the next open, and stored in CSS pixels at 150%.

function rectFor(el: HTMLElement): DOMRect {
  const scale = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')) || 1;
  const width = el.style.width.endsWith('px') ? parseFloat(el.style.width) : 640;
  const height = el.style.height.endsWith('px') ? parseFloat(el.style.height) : 360;
  return { x: 0, y: 0, left: 0, top: 0, width: width * scale, height: height * scale, right: width * scale, bottom: height * scale, toJSON() { return this; } } as DOMRect;
}

async function mount(storageKey: string | undefined, scale = 1, outerScroll = false): Promise<{ root: Root; el: HTMLDivElement; host: HTMLDivElement }> {
  document.documentElement.style.setProperty('--ui-scale', String(scale));
  const el = document.createElement('div');
  el.style.width = '400px';
  el.style.height = '240px';
  if (outerScroll) { el.style.overflowY = 'auto'; el.style.padding = '18px 22px'; el.style.rowGap = '6px'; }
  el.getBoundingClientRect = () => rectFor(el);
  document.body.append(el);
  const surface = createRef<HTMLDivElement>();
  surface.current = el;
  const host = document.createElement('div');
  el.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(WorkSurfaceControls, { surface, storageKey })); });
  return { root, el, host };
}

const button = (host: HTMLElement, label: string) => [...(host.parentElement ?? host).querySelectorAll('button')].find((item) => item.getAttribute('aria-label') === label)!;

test('dialog kinds remember their own size, ignore a bad or path-like key, and store CSS pixels at 150%', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  const globals = Object.getOwnPropertyDescriptors(globalThis);
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: dom.window },
    document: { configurable: true, value: dom.window.document },
    localStorage: { configurable: true, value: dom.window.localStorage },
    getComputedStyle: { configurable: true, value: dom.window.getComputedStyle.bind(dom.window) },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  const clicks: Event[] = [];
  const seeClick = (event: Event) => { clicks.push(event); };
  try {
    localStorage.setItem('arco.dialog-size.form', '{');
    localStorage.setItem('arco.dialog-size.confirm', JSON.stringify({ width: 10001, height: 400, maximized: false }));
    localStorage.setItem('arco.dialog-size.picker', JSON.stringify({ width: '480', height: 300 }));
    const ignored = await mount('form');
    assert.equal(ignored.el.style.width, '400px', 'corrupt JSON must not change the size');
    await act(async () => ignored.root.unmount());

    const confirm = await mount('confirm');
    assert.equal(confirm.el.style.width, '400px', 'an out-of-range saved width is ignored');
    const resize = button(confirm.host, 'Resize dialog');
    assert.equal(resize.textContent?.trim(), '', 'the corner grip has no misleading text button');
    assert.equal(resize.parentElement, confirm.el, 'the grip belongs to the frame, outside its header');
    assert.match(resize.title, /Drag to resize/);
    resize.setPointerCapture = () => {};
    await act(async () => {
      resize.dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 395, clientY: 235 }));
      resize.dispatchEvent(new dom.window.PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 425, clientY: 255 }));
      resize.dispatchEvent(new dom.window.PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
      // The browser's release click is suppressed for this event-loop turn.
      await new Promise(resolve => setTimeout(resolve, 1));
    });
    assert.equal(confirm.el.style.width, '460px');
    assert.equal(confirm.el.style.height, '280px');
    await act(async () => { button(confirm.host, 'Reset dialog size').click(); });
    await act(async () => { resize.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    assert.equal(confirm.el.style.width, '420px');
    assert.equal(JSON.parse(localStorage.getItem('arco.dialog-size.confirm')!).width, 420);
    await act(async () => { resize.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
    assert.equal(confirm.el.style.width, '400px');
    assert.equal(localStorage.getItem('arco.dialog-size.confirm'), null);
    await act(async () => confirm.root.unmount());

    const scrolling = await mount('scroll-picker', 1, true);
    assert.equal(scrolling.el.style.paddingBottom, '18px');
    assert.equal(scrolling.el.style.paddingRight, '26px');
    assert.equal(scrolling.el.classList.contains('work-surface-scroll-frame'), true);
    scrolling.el.scrollLeft = 120;
    scrolling.el.scrollTop = 800;
    scrolling.el.dispatchEvent(new dom.window.Event('scroll'));
    assert.equal(scrolling.el.style.getPropertyValue('--work-surface-scroll-left'), '120px');
    assert.equal(scrolling.el.style.getPropertyValue('--work-surface-scroll-top'), '800px');
    await act(async () => scrolling.root.unmount());
    assert.equal(scrolling.el.style.paddingBottom, '18px');
    assert.equal(scrolling.el.style.paddingRight, '22px');

    const wide = await mount('viewer', 1.5);
    await act(async () => { button(wide.host, 'Resize dialog').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
    assert.equal(wide.el.style.width, '420px', '150% adds CSS pixels, not window pixels');
    const stored = JSON.parse(localStorage.getItem('arco.dialog-size.viewer')!);
    assert.equal(stored.width, 420);
    assert.notEqual(stored.width, 420 * 1.5);
    await act(async () => wide.root.unmount());
    wide.el.style.width = '400px';
    const reopened = await mount('viewer', 1.5);
    assert.equal(reopened.el.style.width, '420px', 'the kind remembers its size on the next open');
    await act(async () => { button(reopened.host, 'Maximize dialog').click(); });
    assert.equal(reopened.el.style.width, 'calc(96vw / var(--ui-scale, 1))');
    assert.equal(JSON.parse(localStorage.getItem('arco.dialog-size.viewer')!).maximized, true);
    assert.ok(button(reopened.host, 'Restore dialog size'));
    await act(async () => reopened.root.unmount());
    const restored = await mount('viewer', 1);
    assert.match(restored.el.style.width, /96vw/);
    await act(async () => { button(restored.host, 'Reset dialog size').click(); });
    assert.equal(restored.el.style.width, '400px');
    assert.equal(localStorage.getItem('arco.dialog-size.viewer'), null);
    await act(async () => restored.root.unmount());
    const form = await mount('form');
    assert.equal(form.el.style.width, '400px', 'another kind keeps its own size');
    await act(async () => form.root.unmount());

    const leaked = await mount('project/secret');
    await act(async () => { button(leaked.host, 'Resize dialog').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    assert.equal([...Object.keys(localStorage)].some((key) => key.includes('secret')), false);
    await act(async () => leaked.root.unmount());

    localStorage.setItem('arco.dialog-size.picker', JSON.stringify({ width: 199, height: 400 }));
    const tiny = await mount('picker');
    assert.equal(tiny.el.style.width, '400px');
    localStorage.setItem('arco.dialog-size.picker', JSON.stringify({ width: '480', height: 300 }));
    await act(async () => tiny.root.unmount());
    const textWidth = await mount('picker');
    assert.equal(textWidth.el.style.width, '400px', 'a non-numeric saved width is ignored');

    window.addEventListener('click', seeClick, true);
    const drag = textWidth.el;
    await act(async () => {
      drag.dispatchEvent(new dom.window.PointerEvent('pointerdown', { bubbles: true, clientX: 390, clientY: 230 }));
      drag.style.width = '460px';
      window.dispatchEvent(new dom.window.PointerEvent('pointerup', { bubbles: true }));
      window.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
      assert.equal(clicks.length, 0, 'the click after a resize must not reach the backdrop');
    });
    await act(async () => textWidth.root.unmount());
  } finally {
    window.removeEventListener('click', seeClick, true);
    document.body.replaceChildren();
    for (const name of ['window', 'document', 'localStorage', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT']) {
      if (globals[name]) Object.defineProperty(globalThis, name, globals[name]);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
});
