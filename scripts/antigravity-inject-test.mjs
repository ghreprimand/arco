#!/usr/bin/env node
// Injection test for the Antigravity CDP channel.
//
// Stage 1 (default, safe): types a test prompt into the composer but does
// NOT submit. Operator visually confirms the text landed where expected.
//   node scripts/antigravity-inject-test.mjs
//
// Stage 2 (actually fires a turn — costs quota): types AND submits, then
// watches ~/.gemini/antigravity/brain/ for the marker-named artifact.
//   node scripts/antigravity-inject-test.mjs --send
//
// Requires: Antigravity running with --remote-debugging-port=9222 and the
// chat composer visible (Agent panel open — toggle with Ctrl+Alt+B if not).

import WebSocket from 'ws';
import { watch, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CDP_URL = 'http://localhost:9222';
const SEND = process.argv.includes('--send');
const BRAIN = join(homedir(), '.gemini', 'antigravity', 'brain');
const MARKER = `inject${Date.now().toString(36)}`;
const PROMPT = `Reply with the single word "PONG" and nothing else. Name your primary artifact archon_inject_${MARKER}.md.`;

// ── Locate the workbench target ────────────────────────────────────────────
const targets = await (await fetch(`${CDP_URL}/json`)).json();
const target = targets.find(
  (t) => t.type === 'page' && t.url.includes('workbench.html') && !t.url.includes('jetski-agent'),
);
if (!target) {
  console.error('no workbench page target');
  process.exit(1);
}
console.log(`target: ${target.title}`);

// ── CDP client ─────────────────────────────────────────────────────────────
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
const send = (method, params = {}) => {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
};
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const ex = r.exceptionDetails;
    const desc = ex.exception?.description || ex.exception?.value || ex.text || 'unknown';
    throw new Error(`CDP evaluate threw: ${desc}`);
  }
  return r.result.value;
}

// ── Inject prompt ──────────────────────────────────────────────────────────
console.log(`\nmarker: ${MARKER}`);
console.log(`prompt: ${PROMPT}\n`);

// Enable DOM domain for nice element lookup, but the real work is in the page.
await send('Page.enable');
await send('Runtime.enable');

// Step 0 — start a new conversation so we're working against a clean composer
// and React state. Ctrl+Shift+L is Antigravity's "New Conversation" binding.
// Dispatch via CDP's Input.dispatchKeyEvent: synthetic JS KeyboardEvents
// don't trigger VS Code-style keybindings, but real key events do.
// Modifiers bitmask: Ctrl=2, Shift=8.
await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 10, key: 'L', code: 'KeyL', windowsVirtualKeyCode: 76 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 10, key: 'L', code: 'KeyL', windowsVirtualKeyCode: 76 });
console.log('sent Ctrl+Shift+L (new conversation)');
// Give Antigravity a beat to swap the composer state.
await new Promise((r) => setTimeout(r, 500));

// Probe step 1 — does the composer element exist?
const probe = await evaluate(`
(() => {
  const candidates = {
    byAria: !!document.querySelector('[aria-label="Message input"]'),
    byRole: document.querySelectorAll('[role="textbox"]').length,
    contentEditables: document.querySelectorAll('[contenteditable=true]').length,
    allAriaMessage: [...document.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label')).filter(l => l && /message|prompt|input|ask/i.test(l)).slice(0, 10),
  };
  return candidates;
})()
`);
console.log('composer probe:', JSON.stringify(probe, null, 2));

if (!probe.byAria && probe.contentEditables === 0) {
  console.error('\nno composer candidates visible. Is the Agent panel open in Antigravity? (Ctrl+Alt+B to toggle)');
  ws.close();
  process.exit(1);
}

// Focus composer and insert via document.execCommand. This fires proper
// native-shaped input events that React's controlled contenteditable
// actually updates its internal state from — unlike raw textContent
// assignment, which React just re-renders over.
const injectionScript = `
(() => {
  const el = document.querySelector('[aria-label="Message input"]')
    || document.querySelector('[contenteditable=true]');
  if (!el) return { ok: false, reason: 'composer not found' };
  el.focus();
  // Clear any stale content.
  document.execCommand('selectAll', false);
  document.execCommand('delete', false);
  // Type the new prompt.
  const ok = document.execCommand('insertText', false, ${JSON.stringify(PROMPT)});
  return { ok, gotText: el.textContent, tag: el.tagName, ariaLabel: el.getAttribute('aria-label') };
})()
`;

const result = await evaluate(injectionScript);
console.log('injection result:', JSON.stringify(result, null, 2));

if (!SEND) {
  console.log('\nstage 1 complete — check Antigravity window, text should be in composer.');
  console.log('re-run with --send to actually submit.');
  ws.close();
  process.exit(0);
}

// ── Stage 2: submit + watch ────────────────────────────────────────────────
// Look for a Send button that appeared after we typed. Fall back to Enter key.
const submitResult = await evaluate(`
(() => {
  const sendBtn = [...document.querySelectorAll('[aria-label]')].find(e => /^send( message)?$|^submit$/i.test(e.getAttribute('aria-label')));
  if (sendBtn) { sendBtn.click(); return { via: 'click', aria: sendBtn.getAttribute('aria-label') }; }
  // Fallback: dispatch Enter on the composer.
  const composer = document.querySelector('[aria-label="Message input"]');
  if (!composer) return { via: 'none', reason: 'composer gone' };
  composer.focus();
  const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true });
  composer.dispatchEvent(ev);
  return { via: 'keydown-enter' };
})()
`);
console.log('submit result:', JSON.stringify(submitResult, null, 2));

// Watch brain/ for our marker file.
console.log(`\nwatching ${BRAIN} for archon_inject_${MARKER}.md ...`);
const expectedName = `archon_inject_${MARKER}.md`;
const pollStart = Date.now();
const timeout = 120_000;
let found = null;

const watcher = watch(BRAIN, { recursive: true }, (event, filename) => {
  if (filename?.endsWith(expectedName)) {
    const full = join(BRAIN, filename);
    if (existsSync(full)) {
      const st = statSync(full);
      if (st.size > 0 && !found) {
        found = full;
        const content = readFileSync(full, 'utf8');
        const elapsed = ((Date.now() - pollStart) / 1000).toFixed(1);
        console.log(`\n✓ artifact appeared after ${elapsed}s: ${full} (${st.size}B)`);
        console.log('─── content ─────────────────────────────');
        console.log(content.slice(0, 1000));
        console.log('─── end ─────────────────────────────────');
        watcher.close();
        ws.close();
        process.exit(0);
      }
    }
  }
});

setTimeout(() => {
  if (!found) {
    console.log(`\n✗ timeout after ${timeout / 1000}s — no marker file appeared`);
    watcher.close();
    ws.close();
    process.exit(1);
  }
}, timeout);
