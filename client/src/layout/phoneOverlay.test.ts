import test from 'node:test';
import assert from 'node:assert/strict';
import { shutOutside, type InertNode, type Reach } from './phoneOverlay';

// A small element tree with the members the walk uses.
class Node implements InertNode {
  parentElement: Node | null = null;
  children: Node[] = [];
  attrs = new Set<string>();
  constructor(readonly name: string, kids: Node[] = []) {
    for (const kid of kids) { kid.parentElement = this; this.children.push(kid); }
  }
  contains(other: InertNode | null): boolean {
    for (let n = other as Node | null; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  setAttribute(name: string, _value?: string): void { this.attrs.add(name); }
  removeAttribute(name: string): void { this.attrs.delete(name); }
}

// Inert itself or inside an inert element: unreachable by Tab and touch.
const shut = (n: Node | null): boolean => { for (; n; n = n.parentElement) if (n.hasAttribute('inert')) return true; return false; };

// The phone screen: a header beside the conversation area, which holds the
// chat and the sheet host; the terminal window sits at the root.
function screen() {
  const header = new Node('header', [new Node('tabs'), new Node('panels')]);
  const banner = new Node('banner');
  const chat = new Node('chat', [new Node('composer'), new Node('send')]);
  const sheet = new Node('sheet', [new Node('back')]);
  const area = new Node('area', [sheet, chat]);
  const shell = new Node('shell', [banner, header, area]);
  const terminal = new Node('terminal', [new Node('kill')]);
  const root = new Node('root', [new Node('shader'), shell, terminal]);
  const reach = (el: InertNode): Reach => (el === header ? 'keep' : el.contains(header) ? 'descend' : 'shut');
  return { root, header, banner, chat, sheet, terminal, reach };
}

test('a phone sheet shuts out the chat it covers but keeps the header reachable', () => {
  const s = screen();
  const undo = shutOutside(s.sheet, s.root, s.reach);
  assert.ok(s.chat.hasAttribute('inert'));
  assert.ok(s.terminal.hasAttribute('inert'));
  assert.ok(!s.header.hasAttribute('inert'));
  assert.ok(!s.sheet.hasAttribute('inert'));
  undo();
  assert.ok(!s.chat.hasAttribute('inert'));
  assert.ok(!s.terminal.hasAttribute('inert'));
});

test('the terminal window shuts out the chat inside the element that also holds the header', () => {
  const s = screen();
  const undo = shutOutside(s.terminal, s.root, s.reach);
  assert.ok(shut(s.chat));
  assert.ok(s.banner.hasAttribute('inert'));
  assert.ok(!s.header.hasAttribute('inert'));
  assert.ok(!s.header.parentElement!.hasAttribute('inert'));
  undo();
  assert.ok(!s.chat.hasAttribute('inert'));
});

test('overlapping overlays keep the chat shut until both close, and an element inert before stays inert', () => {
  const s = screen();
  s.banner.setAttribute('inert', '');
  const first = shutOutside(s.sheet, s.root, s.reach);
  const second = shutOutside(s.terminal, s.root, s.reach);
  first();
  assert.ok(shut(s.chat));
  second();
  assert.ok(!shut(s.chat));
  assert.ok(s.banner.hasAttribute('inert'));
});
