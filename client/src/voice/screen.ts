// docs/VOICE.md - the generic mouse and keyboard. The operator (2026-10-17):
// "there are going to be tons of random little obscure things I want to do
// that there's no specific tool for. This needs to work like my mouse and
// keyboard." Named tools cover the common moves; this covers the rest the
// way a person does: look at the screen, find the control by its label,
// click it or type into it. Two tools: `arco_screen` lists every visible
// control (numbered, labelled, grouped by dialog/area, with state) and
// `arco_act` clicks / types / toggles / selects / presses a key on one.
// Nothing here knows what any button does; the UI's own handlers run, so
// every effect is the same as a click, logged the same way, and the tool
// call itself lands in the Computer transcript.

import { voiceText } from '@arco/shared';

export interface ScreenControl {
  n: number; kind: string; label: string; region: string; state?: string; danger?: boolean; el: Element;
}
export interface ScreenOptions { helpTitle?: (key: string) => string | undefined; filter?: string; limit?: number }
export interface ActRequest { control: string; action: 'click' | 'type' | 'toggle' | 'select' | 'press' | 'options' | 'focus' | 'hover' | 'double_click' | 'context_menu' | 'scroll'; text?: string; confirm?: boolean }

const CONTROL_SELECTOR = 'button, a[href], input, textarea, select, summary, [role="button"], [role="tab"], [role="menuitem"], [role="switch"], [role="checkbox"], [role="option"], [role="link"], [contenteditable="true"], [role="combobox"], [role="treeitem"], [role="radio"], [role="slider"], [role="spinbutton"], [role="textbox"], [role="menuitemcheckbox"], [tabindex="0"]';
// Clicks that throw work away or dismiss state the operator may want back.
// Dialog Cancel/Close buttons are deliberately not on this list.
const DANGER = /\b(delete|remove|discard|purge|kill|wipe|detach|reset|rewind|overwrite|force)\b/i;
const collapse = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

let lastSnapshot: ScreenControl[] = [];

function visible(el: Element): boolean {
  if (el.getAttribute('aria-hidden') === 'true' || el.closest('[aria-hidden="true"], [hidden]')) return false;
  const h = el as HTMLElement;
  // jsdom (tests) has no layout: every element reports zero rects, so the
  // rect test only applies where the body itself has one.
  const hasLayout = (el.ownerDocument.body?.getClientRects?.().length ?? 0) > 0;
  if (hasLayout && h.getClientRects().length === 0) return false;
  const view = el.ownerDocument.defaultView;
  if (view && typeof view.getComputedStyle === 'function') {
    const cs = view.getComputedStyle(h);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
  }
  return true;
}

// Most Arco modals are a fixed full-viewport backdrop with no role="dialog"
// (2026-10-17: the nudge picker was invisible as a dialog to Computer). Any
// fixed ancestor that covers the viewport and takes pointer events is one;
// the phosphor backdrops are pointer-events:none and never qualify.
function overlayOf(el: Element): Element | null {
  const view = el.ownerDocument.defaultView;
  if (!view || typeof view.getComputedStyle !== 'function' || !view.innerWidth || !view.innerHeight) return null;
  for (let node = el.parentElement; node; node = node.parentElement) {
    const cs = view.getComputedStyle(node);
    if (cs.position !== 'fixed' || cs.pointerEvents === 'none') continue;
    const r = node.getBoundingClientRect();
    if (r.width >= view.innerWidth * 0.8 && r.height >= view.innerHeight * 0.8) return node;
  }
  return null;
}
const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"], dialog';
const dialogOf = (el: Element): Element | null => el.closest(DIALOG_SELECTOR) ?? overlayOf(el);

function dialogName(dialog: Element): string {
  const aria = collapse(dialog.getAttribute('aria-label'));
  if (aria) return voiceText(aria, 40);
  const heading = collapse(dialog.querySelector('h1, h2, h3, h4, [role="heading"]')?.textContent);
  if (heading) return voiceText(heading, 40);
  // No heading: the first short run of text that is not inside a control.
  const walker = dialog.ownerDocument.createTreeWalker(dialog, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const t = collapse(node.textContent);
    if (t.length >= 2 && t.length <= 48 && !node.parentElement?.closest(CONTROL_SELECTOR)) return t;
  }
  return '';
}
const dialogRegion = (dialog: Element): string => { const name = dialogName(dialog); return name ? `dialog "${name}"` : 'dialog (unnamed)'; };

// A tab's wrapper button holds its close button: the wrapper is named by its
// own text ("SIGNALQUEUE"), not the concatenation ("SIGNALQUEUE×").
function ownText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  for (const nested of Array.from(clone.querySelectorAll(CONTROL_SELECTOR))) nested.remove();
  return textOf(clone);
}
// textContent runs adjacent elements together ("DirectorDIRECTOR"); join
// the text nodes with spaces instead.
function textOf(el: Element): string {
  const walker = el.ownerDocument.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
  const parts: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { const t = collapse(n.textContent); if (t) parts.push(t); }
  return parts.join(' ');
}

function kindOf(el: Element): string {
  const role = el.getAttribute('role');
  if (role) return role;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    return ['checkbox', 'radio', 'range', 'file', 'color', 'number', 'password'].includes(type) ? type : ['button', 'submit', 'reset'].includes(type) ? 'button' : 'field';
  }
  if (tag === 'textarea' || el.getAttribute('contenteditable') === 'true') return 'field';
  if (tag === 'a') return 'link';
  if (tag === 'summary') return 'disclosure';
  return tag === 'select' ? 'select' : 'button';
}

function labelOf(el: Element, doc: Document, helpTitle?: ScreenOptions['helpTitle']): string {
  const aria = collapse(el.getAttribute('aria-label'));
  if (aria) return aria;
  const labelled = el.getAttribute('aria-labelledby');
  if (labelled) { const t = collapse(labelled.split(/\s+/).map((id) => doc.getElementById(id)?.textContent ?? '').join(' ')); if (t) return t; }
  const id = el.getAttribute('id');
  if (id) { const t = collapse(Array.from(doc.querySelectorAll('label[for]')).find((l) => l.getAttribute('for') === id)?.textContent); if (t) return t; }
  const wrapping = el.closest('label');
  if (wrapping) { const t = textOf(wrapping); if (t) return voiceText(t, 60); }
  const text = ownText(el) || textOf(el);
  // A glyph-only button ("⚙", "✕") is named by its help title or tooltip.
  const wordy = text && /[a-z0-9]/i.test(text);
  if (wordy && !/^(input|select|textarea)$/i.test(el.tagName)) return voiceText(text, 60);
  const help = el.getAttribute('data-help') ?? el.closest('[data-help]')?.getAttribute('data-help');
  const title = (help && helpTitle?.(help)) || collapse(el.getAttribute('title')) || collapse(el.getAttribute('placeholder')) || collapse(el.getAttribute('name'));
  if (title) return voiceText(title, 60);
  if (text) return voiceText(text, 60);
  if (el.tagName.toLowerCase() === 'input') return voiceText(collapse((el as HTMLInputElement).value), 40) || 'unlabelled field';
  return help ? voiceText(help, 60) : 'unlabelled';
}

function regionOf(el: Element): string {
  const dialog = dialogOf(el);
  if (dialog) return dialogRegion(dialog);
  const help = el.closest('[data-help]')?.getAttribute('data-help') ?? '';
  const area = help.split('.')[0];
  if (area) return ({ tabbar: 'tab bar', rightPanel: 'right panel', composer: 'composer', header: 'header', cluster: 'cluster', settings: 'settings', chat: 'chat', github: 'github', gitOps: 'git', recall: 'recall', media: 'media', cookbook: 'cookbook' } as Record<string, string>)[area] ?? area;
  const landmark = el.closest('header, nav, aside, main, footer, form, [role="tabpanel"], [role="region"]');
  if (landmark) return collapse(landmark.getAttribute('aria-label')) || landmark.tagName.toLowerCase();
  return 'page';
}

function stateOf(el: Element, kind: string): string | undefined {
  const parts: string[] = [];
  const h = el as HTMLInputElement & HTMLSelectElement;
  if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled');
  if (kind === 'tab' && (el.getAttribute('aria-selected') === 'true' || el.classList.contains('active'))) parts.push('selected');
  if (kind === 'checkbox' || kind === 'switch' || kind === 'radio') {
    const on = el.tagName.toLowerCase() === 'input' ? h.checked : el.getAttribute('aria-checked') === 'true';
    parts.push(on ? 'on' : 'off');
  }
  if (kind === 'select' && h.selectedOptions?.[0]) parts.push(`= ${voiceText(collapse(h.selectedOptions[0].textContent), 40)}`);
  if (kind === 'range' || kind === 'slider') parts.push(`= ${h.value ?? el.getAttribute('aria-valuenow') ?? ''}, min ${h.min || el.getAttribute('aria-valuemin') || '0'}, max ${h.max || el.getAttribute('aria-valuemax') || '100'}`);
  if (kind === 'field' || kind === 'number') {
    const value = el.tagName.toLowerCase() === 'input' || el.tagName.toLowerCase() === 'textarea' ? h.value : collapse(el.textContent);
    if (value) parts.push(`= "${voiceText(collapse(value), 40)}${value.length > 40 ? '…' : ''}"`);
  }
  if (kind === 'password') parts.push(h.value ? '(filled)' : '(empty)');
  if (el.getAttribute('aria-expanded')) parts.push(el.getAttribute('aria-expanded') === 'true' ? 'expanded' : 'collapsed');
  return parts.length ? parts.join(', ') : undefined;
}

export function readScreen(doc: Document, options: ScreenOptions = {}): { controls: ScreenControl[]; text: string } {
  const limit = options.limit ?? 160;
  const all = Array.from(doc.querySelectorAll(CONTROL_SELECTOR)).filter(visible);
  const filter = collapse(options.filter).toLowerCase();
  const controls: ScreenControl[] = [];
  for (const el of all) {
    const kind = kindOf(el);
    const label = labelOf(el, doc, options.helpTitle);
    const region = regionOf(el);
    const state = stateOf(el, kind);
    if (filter && !`${label} ${region} ${kind} ${state ?? ''}`.toLowerCase().includes(filter)) continue;
    controls.push({ n: controls.length + 1, kind, label, region, state, danger: DANGER.test(label) || undefined, el });
  }
  lastSnapshot = controls;
  // Dialogs first: whatever is modal is what the operator is looking at.
  const regions = new Map<string, ScreenControl[]>();
  for (const c of controls) regions.set(c.region, [...(regions.get(c.region) ?? []), c]);
  const ordered = [...regions.entries()].sort(([a], [b]) => Number(b.startsWith('dialog')) - Number(a.startsWith('dialog')));
  const lines: string[] = [];
  const dialogs = ordered.filter(([r]) => r.startsWith('dialog')).map(([r]) => r.slice(7));
  lines.push(dialogs.length ? `Open dialogs: ${dialogs.join(', ')}.` : 'No dialog is open.');
  let shown = 0;
  for (const [region, list] of ordered) {
    const items = list.slice(0, Math.max(0, limit - shown)).map((c) => `[${c.n}] ${c.kind} ${c.label}${c.state ? ` (${c.state})` : ''}${c.danger ? ' !' : ''}`);
    shown += items.length;
    if (items.length) lines.push(`${region}: ${items.join('; ')}`);
    if (shown >= limit) { lines.push(`… ${controls.length - shown} more; call arco_screen with a filter word.`); break; }
  }
  if (!controls.length) lines.push(filter ? `No visible control matches "${options.filter}".` : 'No visible controls.');
  lines.push('Controls marked ! are destructive and need confirm.');
  return { controls, text: voiceText(lines.join('\n'), 12000) };
}

function resolve(doc: Document, query: string, options: ScreenOptions): ScreenControl | string {
  const q = collapse(query);
  if (/^\d+$/.test(q)) {
    const hit = lastSnapshot[Number(q) - 1];
    if (hit && hit.el.isConnected && visible(hit.el)) return hit;
    return `Control ${q} is no longer on screen. Call arco_screen again.`;
  }
  const { controls } = readScreen(doc, { helpTitle: options.helpTitle, limit: 1000 });
  const lower = q.toLowerCase();
  const exact = controls.filter((c) => c.label.toLowerCase() === lower || `${c.kind} ${c.label}`.toLowerCase() === lower);
  let pick = exact.length ? exact : controls.filter((c) => `${c.kind} ${c.label}`.toLowerCase().includes(lower));
  if (pick.length === 1) return pick[0];
  if (!pick.length) return `No visible control is labelled "${q}". Call arco_screen to see what is on screen.`;
  // Prefer the open dialog: it is what the operator is looking at.
  const inDialog = pick.filter((c) => c.region.startsWith('dialog'));
  if (inDialog.length) pick = inDialog;
  if (pick.length === 1) return pick[0];
  // Nested matches (a tab wrapper and the name button inside it): the
  // innermost is where a finger would land.
  const inner = pick.filter((c) => !pick.some((o) => o !== c && c.el.contains(o.el)));
  if (inner.length === 1) return inner[0];
  return `Several controls match "${q}": ${pick.slice(0, 6).map((c) => `[${c.n}] ${c.kind} ${c.label} in ${c.region}`).join('; ')}. Use the number.`;
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  // React listens to the native input event but tracks the value through
  // the prototype setter; writing el.value directly would be swallowed.
  const proto = Object.getPrototypeOf(el) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new (el.ownerDocument.defaultView?.Event ?? Event)('input', { bubbles: true }));
  el.dispatchEvent(new (el.ownerDocument.defaultView?.Event ?? Event)('change', { bubbles: true }));
}

function pressKey(target: Element | Document, key: string): void {
  const view = (target as Document).defaultView ?? (target as Element).ownerDocument.defaultView;
  const KE = view?.KeyboardEvent ?? KeyboardEvent;
  const shiftKey = key.startsWith('Shift+'); if (shiftKey) key = key.slice(6);
  const init = { shiftKey, key, code: key === 'Escape' ? 'Escape' : key === 'Enter' ? 'Enter' : key, bubbles: true, cancelable: true };
  target.dispatchEvent(new KE('keydown', init));
  target.dispatchEvent(new KE('keyup', init));
}

function openDialogs(doc: Document): Element[] {
  const found = new Set<Element>();
  for (const d of Array.from(doc.querySelectorAll(DIALOG_SELECTOR))) if (visible(d)) found.add(d);
  for (const c of Array.from(doc.querySelectorAll(CONTROL_SELECTOR))) { if (!visible(c)) continue; const d = dialogOf(c); if (d) found.add(d); }
  return [...found];
}
const dialogsOf = (doc: Document): string[] => openDialogs(doc).map((d) => dialogName(d) || '(unnamed)');

export async function actOnScreen(doc: Document, request: ActRequest, options: ScreenOptions = {}): Promise<string> {
  const before = dialogsOf(doc);
  if (request.action === 'scroll') {
    const direction = collapse(request.text).toLowerCase();
    if (!['up', 'down', 'left', 'right', 'top', 'bottom'].includes(direction)) return 'Scroll text must be up, down, left, right, top or bottom.';
    let base: Element | null = null;
    if (request.control) { const hit = resolve(doc, request.control, options); if (typeof hit === 'string') return hit; base = hit.el; }
    const canScroll = (e: Element) => e.scrollHeight > e.clientHeight || e.scrollWidth > e.clientWidth;
    let node = base;
    while (node && !canScroll(node)) node = node.parentElement;
    if (!node) {
      const scope = openDialogs(doc).at(-1) ?? doc.body;
      node = [scope, ...Array.from(scope.querySelectorAll('*'))].filter(visible).filter(canScroll)
        .filter((e) => /auto|scroll/.test(doc.defaultView?.getComputedStyle(e).overflow + ' ' + doc.defaultView?.getComputedStyle(e).overflowY))
        .sort((a, b) => b.clientHeight - a.clientHeight)[0] ?? doc.scrollingElement;
    }
    if (!node) return 'No scrollable region is available.';
    if (direction === 'top') node.scrollTop = 0;
    else if (direction === 'bottom') node.scrollTop = node.scrollHeight;
    else if (direction === 'left' || direction === 'right') node.scrollLeft += Math.max(100, node.clientWidth * .8) * (direction === 'left' ? -1 : 1);
    else node.scrollTop += Math.max(100, node.clientHeight * .8) * (direction === 'up' ? -1 : 1);
    return finish(doc, before, `Scrolled ${direction}.`);
  }
  if (request.action === 'press') {
    const key = collapse(request.text || request.control);
    if (!['Escape', 'Enter', 'Tab', 'Shift+Tab', 'Shift+Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Backspace', 'Delete', ' '].includes(key)) return `Keys: Escape, Enter, Shift+Enter, Tab, Shift+Tab, arrows, Home, End, PageUp, PageDown, Backspace, Delete, space. Not "${key}".`;
    const target = (/^\d+$/.test(collapse(request.control)) || !/^(escape|enter|tab|arrow)/i.test(collapse(request.control))) && collapse(request.control)
      ? resolve(doc, request.control, options) : (doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : doc);
    if (typeof target === 'string') return target;
    const element = 'el' in (target as ScreenControl) ? (target as ScreenControl).el : (target as Element | Document);
    if ('tagName' in element && (key === 'Enter' || key === ' ') && DANGER.test(labelOf(element, doc, options.helpTitle)) && !request.confirm) return 'That control looks destructive. Ask the operator to confirm, then pass confirm true.';
    if ('tagName' in element && ((element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true')) return 'That control is disabled.';
    if (key === 'Tab' || key === 'Shift+Tab') {
      const scope = openDialogs(doc).at(-1) ?? doc.body;
      const tabs = Array.from(scope.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)).filter((e) => visible(e) && !('disabled' in e && e.disabled) && e.tabIndex >= 0);
      const current = tabs.indexOf(doc.activeElement as HTMLElement);
      const next = key === 'Tab' ? (current + 1) % tabs.length : (current <= 0 ? tabs.length - 1 : current - 1);
      tabs[next]?.focus();
    } else pressKey(element, key);
    return finish(doc, before, `Pressed ${key}.`);
  }
  const hit = resolve(doc, request.control, options);
  if (typeof hit === 'string') return hit;
  const el = hit.el as HTMLElement;
  if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return `${hit.label} is disabled right now.`;
  if (hit.danger && ['click', 'toggle', 'double_click', 'press'].includes(request.action) && !request.confirm) return `${hit.label} looks destructive. Ask the operator to confirm it, then call arco_act again with confirm set to true.`;
  const where = hit.region.startsWith('dialog') ? ` in ${hit.region}` : '';
  switch (request.action) {
    case 'options': {
      if (el.tagName.toLowerCase() !== 'select') return `${hit.label} is a custom control. Click it, then inspect arco_screen to see its options.`;
      return JSON.stringify(Array.from((el as HTMLSelectElement).options).filter((o) => !request.text || `${o.textContent} ${o.value}`.toLowerCase().includes(request.text.toLowerCase())).slice(0, 120).map((o) => ({ label: collapse(o.textContent), value: o.value, disabled: o.disabled || !!o.closest('optgroup[disabled]'), selected: o.selected })));
    }
    case 'focus': el.focus?.(); return finish(doc, before, `Focused ${hit.label}.`);
    case 'hover': case 'double_click': case 'context_menu': {
      const EventClass = doc.defaultView!.MouseEvent;
      const events = request.action === 'hover' ? ['mouseover', 'mouseenter', 'mousemove'] : [request.action === 'double_click' ? 'dblclick' : 'contextmenu'];
      for (const type of events) el.dispatchEvent(new EventClass(type, { bubbles: type !== 'mouseenter', cancelable: true, button: request.action === 'context_menu' ? 2 : 0, detail: request.action === 'double_click' ? 2 : 0 }));
      return finish(doc, before, `${request.action} on ${hit.label}.`);
    }
    case 'click': case 'toggle': {
      el.focus?.();
      el.click();
      return finish(doc, before, `${request.action === 'toggle' ? 'Toggled' : 'Clicked'} ${hit.kind} ${hit.label}${where}.`);
    }
    case 'type': {
      const text = request.text ?? '';
      el.focus?.();
      if (el.getAttribute('contenteditable') === 'true') {
        doc.execCommand?.('selectAll');
        if (!doc.execCommand?.('insertText', false, text)) el.textContent = text;
        el.dispatchEvent(new (doc.defaultView?.Event ?? Event)('input', { bubbles: true }));
      } else if (el instanceof (doc.defaultView?.HTMLInputElement ?? HTMLInputElement) || el instanceof (doc.defaultView?.HTMLTextAreaElement ?? HTMLTextAreaElement)) {
        const input = el as HTMLInputElement;
        if (input.readOnly) return `${hit.label} is read-only.`;
        if (input.type === 'file') return 'The browser requires a manual file choice. Voice cannot fabricate a file upload.';
        if (input.type === 'range' || input.type === 'number') {
          const n = Number(text);
          if (!text.trim() || !Number.isFinite(n) || (input.min && n < Number(input.min)) || (input.max && n > Number(input.max))) return `${hit.label} needs a number within its displayed bounds.`;
        }
        setNativeValue(input, text);
      } else return `${hit.label} is a ${hit.kind}, not something you can type into.`;
      return finish(doc, before, `Typed into ${hit.label}${where}: "${voiceText(text, 80)}${text.length > 80 ? '…' : ''}".`);
    }
    case 'select': {
      if (!(el instanceof (doc.defaultView?.HTMLSelectElement ?? HTMLSelectElement))) return `${hit.label} is not a dropdown.`;
      const want = collapse(request.text).toLowerCase();
      if (!want) return 'Choose a named option. Use action options to list them.';
      const exact = Array.from(el.options).find((o) => collapse(o.textContent).toLowerCase() === want || o.value.toLowerCase() === want);
      const matches = Array.from(el.options).filter((o) => collapse(o.textContent).toLowerCase().includes(want));
      if (!exact && matches.length > 1) return 'Several dropdown options match. Use action options and choose an exact label or value.';
      const option = exact ?? matches[0];
      if (option && (option.disabled || option.closest('optgroup[disabled]'))) return 'That option is disabled.';
      if (!option) return `${hit.label} has no option "${request.text}". Options: ${Array.from(el.options).map((o) => collapse(o.textContent)).join(', ')}.`;
      setNativeValue(el as unknown as HTMLInputElement, option.value);
      return finish(doc, before, `Set ${hit.label} to ${collapse(option.textContent)}${where}.`);
    }
    default: return `Unknown action ${String(request.action)}. Use click, type, toggle, select or press.`;
  }
}

async function finish(doc: Document, before: string[], did: string): Promise<string> {
  // Let React commit the click's state update before describing the result.
  await new Promise((r) => setTimeout(r, 60));
  const after = dialogsOf(doc);
  const opened = after.filter((d) => !before.includes(d)), closed = before.filter((d) => !after.includes(d));
  const notes = [...opened.map((d) => `Dialog ${d} opened.`), ...closed.map((d) => `Dialog ${d} closed.`)];
  return [did, ...notes].join(' ');
}

// ---- Reading words, not controls ------------------------------------------
// 2026-10-17: "read me the section on Strata from the user manual" — Computer
// opened the manual and clicked the right entry, then said the text was not
// exposed to it. arco_screen lists controls; this reads the text of the
// open dialog (or the page), optionally one section by heading.
export interface ReadTextOptions { filter?: string; limit?: number }
const BLOCK_TAG = /^(p|div|li|ul|ol|h[1-6]|section|article|header|footer|tr|td|th|pre|blockquote|dt|dd|details|summary|label|table|br|hr|nav|aside|main|form|fieldset|legend|figcaption|figure)$/;

// innerText needs layout (real browsers); jsdom gets a walker that breaks
// lines at block elements. Hidden subtrees are skipped either way.
function visibleText(el: Element): string {
  const h = el as HTMLElement;
  const hasLayout = (el.ownerDocument.body?.getClientRects?.().length ?? 0) > 0;
  if (hasLayout && typeof h.innerText === 'string') return h.innerText;
  const out: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3) { out.push(node.textContent ?? ''); return; }
    if (node.nodeType !== 1) return;
    const e = node as Element;
    const tag = e.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || !visible(e)) return;
    const block = BLOCK_TAG.test(tag);
    if (block) out.push('\n');
    for (const child of Array.from(e.childNodes)) walk(child);
    if (block) out.push('\n');
  };
  walk(el);
  return out.join('');
}
const tidy = (s: string) => s.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');

export function readText(doc: Document, options: ReadTextOptions = {}): string {
  const limit = options.limit ?? 12000;
  const filter = collapse(options.filter).toLowerCase();
  const dialogs = openDialogs(doc);
  // Later-mounted portals come later in the DOM: the last dialog is on top.
  const scope = dialogs[dialogs.length - 1] ?? doc.body;
  const scopeName = dialogs.length ? `dialog "${dialogName(scope) || '(unnamed)'}"` : 'the page';
  let text: string; let where = scopeName;
  if (filter) {
    const headings = Array.from(scope.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"], summary, legend, dt')).filter(visible)
      .filter((h) => collapse(h.textContent).toLowerCase().includes(filter));
    const sections = headings.map((h) => h.closest('section, article, details, [role="region"], [role="tabpanel"], li, fieldset') ?? h.parentElement ?? h);
    const unique = sections.filter((sec, i) => sections.indexOf(sec) === i && !sections.some((o) => o !== sec && o.contains(sec)));
    if (unique.length) {
      text = unique.map((sec) => tidy(visibleText(sec))).join('\n\n');
      where = `${scopeName}, ${unique.length === 1 ? 'the section' : `${unique.length} sections`} matching "${options.filter}"`;
    } else {
      // No heading matched: the smallest visible elements whose text mentions it, with a little context.
      const hits = Array.from(scope.querySelectorAll('p, li, td, dd, blockquote, pre, div, span')).filter((e) => visible(e)
        && collapse(e.textContent).toLowerCase().includes(filter) && !Array.from(e.children).some((c) => collapse(c.textContent).toLowerCase().includes(filter)));
      if (!hits.length) return `Nothing on screen in ${scopeName} mentions "${options.filter}". Call arco_read_text without a filter to read all of it, or arco_screen to see the controls.`;
      const passages = hits.slice(0, 20).map((e) => {
        const own = tidy(visibleText(e));
        const parent = e.parentElement ? tidy(visibleText(e.parentElement)) : '';
        return own.length < 120 && parent && parent.length <= 2000 ? parent : own;
      });
      text = passages.filter((t, i) => passages.indexOf(t) === i).join('\n\n');
      where = `${scopeName}, ${hits.length} passage${hits.length === 1 ? '' : 's'} mentioning "${options.filter}"`;
    }
  } else text = tidy(visibleText(scope));
  if (!text) return `${scopeName} has no readable text.`;
  const cut = text.length > limit;
  return `Text of ${where}${cut ? ` (first ${limit} of ${text.length} characters; pass a filter word for one section)` : ''}:\n${cut ? voiceText(text, limit) : text}`;
}
