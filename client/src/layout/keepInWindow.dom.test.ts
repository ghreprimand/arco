import test from 'node:test';
import assert from 'node:assert/strict';
import { keepElementInWindow, placeInWindow, planPlacement, widthCap, WINDOW_MARGIN, type Box } from './keepInWindow';

// A layout stand-in for the browser: CSS pixels times the interface zoom are
// window pixels, matching getBoundingClientRect under root zoom. No real
// layout engine, so a wrong translate, a missed resize, or a nested panel
// that ignores its parent's shift fails these checks.

interface CssBox { left: number; top: number; width: number; height: number }

class FakeView {
  innerWidth: number;
  innerHeight: number;
  zoom: number;
  document = { documentElement: {} };
  private listeners = new Map<string, Set<(event?: unknown) => void>>();
  private rafs: Array<() => void> = [];
  observers: Array<{ cb: () => void }> = [];
  ResizeObserver = class {
    constructor(cb: () => void) { viewObservers.push({ cb }); }
    observe(): void {}
    disconnect(): void {}
  };
  constructor(width: number, height: number, zoom = 1) {
    this.innerWidth = width;
    this.innerHeight = height;
    this.zoom = zoom;
  }
  getComputedStyle(el: { zoomStyle?: string; position?: string; style?: { overflowY: string } }): { zoom: string; position: string; overflowY: string } {
    if (el === this.document.documentElement) return { zoom: String(this.zoom), position: 'static', overflowY: 'visible' };
    const overflow = el.style?.overflowY;
    return { zoom: String(this.zoom), position: el.position ?? 'absolute', overflowY: overflow === 'auto' || overflow === 'scroll' ? overflow : 'visible' };
  }
  requestAnimationFrame(fn: () => void): number {
    this.rafs.push(fn);
    return this.rafs.length;
  }
  cancelAnimationFrame(): void {}
  addEventListener(type: string, fn: (event?: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: (event?: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  dispatch(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
  flush(): void {
    const queued = this.rafs.splice(0);
    for (const fn of queued) fn();
  }
  fireObservers(): void {
    for (const observer of viewObservers) observer.cb();
  }
}

let viewObservers: Array<{ cb: () => void }> = [];

class FakeEl {
  style = { maxHeight: '', maxWidth: '', overflowY: '', translate: '', width: '', height: '' };
  position: 'absolute';
  isConnected = true;
  parent: FakeEl | null = null;
  offsetParent: FakeEl | null = null;
  css: CssBox;
  attrs = new Map<string, string>();
  private listeners = new Map<string, Set<() => void>>();
  ownerDocument: { defaultView: FakeView };
  constructor(view: FakeView, css: CssBox) {
    this.ownerDocument = { defaultView: view };
    this.css = css;
  }
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    const view = this.ownerDocument.defaultView;
    const scale = view.zoom;
    let width = this.css.width;
    let height = this.css.height;
    if (this.style.maxWidth.endsWith('px')) width = Math.min(width, parseFloat(this.style.maxWidth));
    if (this.style.maxHeight.endsWith('px')) height = Math.min(height, parseFloat(this.style.maxHeight));
    const shift = this.style.translate.match(/(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px/);
    const tx = shift ? parseFloat(shift[1]) : 0;
    const ty = shift ? parseFloat(shift[2]) : 0;
    const origin = this.parent ? this.parent.getBoundingClientRect() : { left: 0, top: 0 };
    const left = origin.left + (this.css.left + tx) * scale;
    const top = origin.top + (this.css.top + ty) * scale;
    return { left, top, width: width * scale, height: height * scale, right: left + width * scale, bottom: top + height * scale };
  }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  closest(): null { return null; }
  addEventListener(type: string, fn: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: () => void): void { this.listeners.get(type)?.delete(fn); }
  dispatch(type: string): void { for (const fn of this.listeners.get(type) ?? []) fn(); }
}

function inside(el: FakeEl, view: FakeView, label: string): void {
  const box = el.getBoundingClientRect();
  const margin = WINDOW_MARGIN * view.zoom - 0.6;
  assert.ok(box.width > 0 && box.height > 0, `${label}: collapsed`);
  assert.ok(box.left >= margin, `${label}: left ${box.left}`);
  assert.ok(box.top >= margin, `${label}: top ${box.top}`);
  assert.ok(box.right <= view.innerWidth - margin, `${label}: right ${box.right} > ${view.innerWidth - margin}`);
  assert.ok(box.bottom <= view.innerHeight - margin, `${label}: bottom ${box.bottom} > ${view.innerHeight - margin}`);
}

const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, width, height, right: left + width, bottom: top + height });

test('a panel wider than the window is capped, then shifted inside, at 100% and 150%', () => {
  for (const scale of [1, 1.5]) {
    const viewport = { width: 480, height: 800 };
    const margin = WINDOW_MARGIN * scale;
    const cap = widthCap(600 * scale, viewport.width, margin);
    assert.equal(cap, viewport.width - 2 * margin);
    for (const left of [-80 * scale, 400 * scale]) {
      const plan = planPlacement(box(left, 40, cap!, 120), null, viewport, margin);
      assert.ok(plan.left >= margin - 0.01);
      assert.ok(plan.left + cap! <= viewport.width - margin + 0.01);
    }
  }
});

test('menus at every edge stay inside from 1280x800 through 3840x2160 at 100% and 150%', () => {
  const sizes = [[1280, 800], [3840, 2160]] as const;
  for (const [width, height] of sizes) {
    for (const zoom of [1, 1.5]) {
      const view = new FakeView(width, height, zoom);
      const panelW = 260;
      const panelH = 320;
      const trigger = new FakeEl(view, { left: 0, top: 0, width: 48, height: 24 });
      const cases: Array<[string, CssBox, CssBox]> = [
        ['top-left', { left: 4, top: 4, width: 48, height: 24 }, { left: -180, top: 36, width: panelW, height: panelH }],
        ['top-right', { left: width / zoom - 60, top: 4, width: 48, height: 24 }, { left: width / zoom - 40, top: 36, width: panelW, height: panelH }],
        ['bottom-left', { left: 4, top: height / zoom - 40, width: 48, height: 24 }, { left: -40, top: height / zoom - 20, width: panelW, height: panelH }],
        ['bottom-right', { left: width / zoom - 60, top: height / zoom - 40, width: 48, height: 24 }, { left: width / zoom - 80, top: height / zoom - 16, width: panelW, height: panelH }],
      ];
      for (const [name, triggerCss, panelCss] of cases) {
        trigger.css = triggerCss;
        const panel = new FakeEl(view, panelCss);
        placeInWindow(panel as unknown as HTMLElement, trigger as unknown as HTMLElement);
        inside(panel, view, `${width}x${height}@${zoom} ${name}`);
        const once = panel.getBoundingClientRect();
        placeInWindow(panel as unknown as HTMLElement, trigger as unknown as HTMLElement);
        const twice = panel.getBoundingClientRect();
        assert.ok(Math.abs(once.left - twice.left) < 0.6 && Math.abs(once.top - twice.top) < 0.6, `${name}: second pass walked`);
      }
    }
  }
});

test('a nested popover stays inside after its parent is shifted off the right edge', () => {
  const view = new FakeView(1280, 800, 1);
  const parent = new FakeEl(view, { left: 1100, top: 40, width: 240, height: 180 });
  const child = new FakeEl(view, { left: 160, top: 20, width: 200, height: 140 });
  child.parent = parent;
  placeInWindow(parent as unknown as HTMLElement, null);
  placeInWindow(child as unknown as HTMLElement, null);
  inside(parent, view, 'parent');
  inside(child, view, 'nested');
});

test('resize, an interface-scale change, and a later size change pull an open menu back inside', () => {
  viewObservers = [];
  const view = new FakeView(1280, 800, 1);
  const trigger = new FakeEl(view, { left: 1180, top: 700, width: 48, height: 24 });
  const panel = new FakeEl(view, { left: 1100, top: 730, width: 260, height: 220 });
  const stop = keepElementInWindow(panel as unknown as HTMLElement, () => trigger as unknown as HTMLElement);
  inside(panel, view, 'open');
  view.innerWidth = 480;
  view.innerHeight = 700;
  view.dispatch('resize');
  view.flush();
  inside(panel, view, 'mid-resize');
  view.zoom = 1.5;
  view.dispatch('arco:ui-scale');
  view.flush();
  inside(panel, view, 'scale');
  panel.css = { left: 400, top: 600, width: 400, height: 500 };
  view.fireObservers();
  view.flush();
  inside(panel, view, 'grown');
  stop();
});

test('a hidden panel is placed once it has a size', () => {
  viewObservers = [];
  const view = new FakeView(800, 600, 1);
  const panel = new FakeEl(view, { left: -100, top: -100, width: 0, height: 0 });
  const stop = keepElementInWindow(panel as unknown as HTMLElement, () => null);
  assert.equal(panel.attrs.get('data-window-placement'), undefined);
  panel.css = { left: -100, top: 540, width: 220, height: 180 };
  view.fireObservers();
  view.flush();
  inside(panel, view, 'revealed');
  stop();
});
