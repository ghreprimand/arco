#!/usr/bin/env node
// Live DOM probe for Antigravity's CHAT PANE. Connects to CDP on :9222,
// finds the workbench target, and dumps every selector/attribute hint that
// might uniquely identify assistant messages vs. user messages vs. UI chrome.
//
// Usage (with Antigravity open AND an assistant response visible on screen):
//   node scripts/antigravity-chat-dump.mjs
//
// Paste the entire output back to the chat so the primary-mode scrape
// selectors in server/src/providers/antigravity.ts can be tuned.

import WebSocket from 'ws';

const CDP_URL = 'http://localhost:9222';

const res = await fetch(`${CDP_URL}/json`);
const targets = await res.json();
const target = targets.find(
  (t) => t.type === 'page' && t.url.includes('workbench.html') && !t.url.includes('jetski-agent'),
);
if (!target) {
  console.error('No workbench page target found. Targets:');
  for (const t of targets) console.error(`  ${t.type} | ${t.title} | ${t.url}`);
  process.exit(1);
}
console.log(`target: ${target.title}`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, e) => { ws.once('open', r); ws.once('error', e); });

let nextId = 1;
const pending = new Map();
ws.on('message', (buf) => {
  const msg = JSON.parse(buf.toString());
  if (typeof msg.id !== 'number') return;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(msg.error.message));
  else p.resolve(msg.result);
});

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

// ONE big probe so we see everything in one roundtrip.
const script = `
(() => {
  const out = {};

  // 1. Common message-ish selectors. Count + first node's tag/classes/aria.
  const probes = [
    '[role="log"]',
    '[role="log"] [role="listitem"]',
    '[role="log"] > *',
    '[data-role="assistant"]',
    '[data-kind="assistant"]',
    '[data-testid*="assistant"]',
    '[data-testid*="message"]',
    '[data-testid*="response"]',
    '[class*="assistant-message"]',
    '[class*="bot-message"]',
    '[class*="ai-message"]',
    '[class*="chat-item"]',
    '[class*="chat-message"]',
    '[class*="interactive-response"]',
    '[class*="interactive-request"]',
    '[class*="rendered-markdown"]',
    '[class*="conversation"]',
    '[class*="message-content"]',
    '[class*="message-body"]',
    '.interactive-session',
    '.interactive-item-container',
    '.chat-list',
  ];
  out.selectorCounts = {};
  for (const sel of probes) {
    const nodes = document.querySelectorAll(sel);
    out.selectorCounts[sel] = nodes.length;
  }

  // 2. Walk up from the composer to find the chat-scroll ancestor, then
  // describe the N-deep descendants so we can see the DOM shape.
  const composer = document.querySelector('[aria-label="Message input"]');
  let scroll = composer?.parentElement ?? null;
  const ancestorChain = [];
  while (scroll && scroll.parentElement) {
    const style = getComputedStyle(scroll);
    ancestorChain.push({
      tag: scroll.tagName.toLowerCase(),
      cls: scroll.className?.toString?.().slice(0, 120) ?? '',
      aria: scroll.getAttribute('aria-label'),
      overflowY: style.overflowY,
    });
    if (/(auto|scroll)/.test(style.overflowY)) break;
    scroll = scroll.parentElement;
  }
  out.ancestorChain = ancestorChain;

  // 3. If we found a scrollable ancestor, list its first-level children's
  // tag + class fingerprints so we can see whether messages are immediate
  // children or nested.
  if (scroll) {
    const kids = [...scroll.children].slice(0, 20).map(el => ({
      tag: el.tagName.toLowerCase(),
      cls: el.className?.toString?.().slice(0, 160) ?? '',
      role: el.getAttribute('role'),
      aria: el.getAttribute('aria-label'),
      textHead: (el.textContent ?? '').trim().slice(0, 80),
      textLen: (el.textContent ?? '').length,
    }));
    out.scrollAncestorChildren = kids;

    // 4. Dig two levels deep — the message container might be a grandchild.
    const deep = [];
    for (const kid of scroll.children) {
      for (const gkid of kid.children ?? []) {
        deep.push({
          path: kid.tagName.toLowerCase() + '>' + gkid.tagName.toLowerCase(),
          cls: gkid.className?.toString?.().slice(0, 160) ?? '',
          role: gkid.getAttribute('role'),
          textHead: (gkid.textContent ?? '').trim().slice(0, 80),
          textLen: (gkid.textContent ?? '').length,
        });
      }
    }
    out.scrollAncestorGrandchildren = deep.slice(0, 20);
  }

  // 5. All elements whose textContent ends with a substring of the last
  // visible assistant message body — use a keyword most Antigravity replies
  // will have: the bullet-heavy Markdown style often has "•" or "-" markers.
  // Instead, look for elements containing a recognizable substring operators
  // can confirm — fall back to "largest visible text blocks".
  const everyElement = [...document.querySelectorAll('*')];
  const visibleLargeBlocks = everyElement
    .filter(el => el.offsetParent !== null)
    .map(el => ({
      tag: el.tagName.toLowerCase(),
      cls: (el.className?.toString?.() ?? '').slice(0, 140),
      role: el.getAttribute('role'),
      aria: el.getAttribute('aria-label'),
      textLen: (el.textContent ?? '').length,
      childCount: el.children.length,
    }))
    .filter(e => e.textLen > 200 && e.textLen < 15000 && e.childCount < 200)
    .sort((a, b) => b.textLen - a.textLen)
    .slice(0, 15);
  out.visibleLargeBlocks = visibleLargeBlocks;

  // 6. Look specifically for anything that looks like a finished-message
  // container: an element with multiple <p> / <li> / <code> descendants.
  const markdownish = everyElement
    .filter(el => el.offsetParent !== null)
    .map(el => ({
      el,
      p: el.querySelectorAll(':scope > p, :scope > * > p').length,
      li: el.querySelectorAll('li').length,
      code: el.querySelectorAll('code').length,
      h: el.querySelectorAll('h1,h2,h3,h4').length,
    }))
    .filter(e => e.p + e.li + e.h >= 2)
    .slice(-15) // last 15 (most recent in DOM order)
    .map(e => ({
      tag: e.el.tagName.toLowerCase(),
      cls: (e.el.className?.toString?.() ?? '').slice(0, 140),
      role: e.el.getAttribute('role'),
      p: e.p, li: e.li, code: e.code, h: e.h,
      textHead: (e.el.textContent ?? '').trim().slice(0, 80),
      textLen: (e.el.textContent ?? '').length,
    }));
  out.markdownishContainers = markdownish;

  // 7. Stop button / turn-in-progress signals — do they exist on a settled
  // conversation too, or only during a turn?
  out.stopButtons = [...document.querySelectorAll('[aria-label]')]
    .filter(el => el.offsetParent !== null)
    .map(el => el.getAttribute('aria-label'))
    .filter(l => l && /stop|cancel|pause|halt/i.test(l))
    .slice(0, 10);

  // 8. aria-live regions.
  out.ariaLiveRegions = [...document.querySelectorAll('[aria-live]')]
    .filter(el => el.offsetParent !== null)
    .map(el => ({
      live: el.getAttribute('aria-live'),
      text: (el.textContent ?? '').trim().slice(0, 80),
    }))
    .slice(0, 10);

  return out;
})()
`;

const result = await evaluate(script);
console.log(JSON.stringify(result, null, 2));
ws.close();
