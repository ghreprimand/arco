#!/usr/bin/env node
// Live DOM-inspection tool. Connects to the running Antigravity CDP endpoint,
// finds the workbench page target, and runs a series of Runtime.evaluate
// expressions to map the composer UI. Prints what it finds.
//
// Usage: node scripts/antigravity-composer-probe.mjs
//
// Requires: Antigravity running with --remote-debugging-port=9222.

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
console.log(`ws:     ${target.webSocketDebuggerUrl}\n`);

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

// Probe series — look for common chat-composer shapes in VS Code forks.
const probes = [
  // High-level: what's the document title + any chat/task pane hints in the body?
  ['doc.title', 'document.title'],
  ['doc.body.className', 'document.body.className'],

  // Count likely composer candidates.
  ['textareas', 'document.querySelectorAll("textarea").length'],
  ['contenteditables', 'document.querySelectorAll("[contenteditable=true]").length'],
  ['monaco inputs', 'document.querySelectorAll(".monaco-editor").length'],

  // VS Code-style chat input classes (seen in upstream vscode chat).
  ['.interactive-session', 'document.querySelectorAll(".interactive-session").length'],
  ['.interactive-input', 'document.querySelectorAll(".interactive-input-part, .interactive-input-editor").length'],
  ['chat-input candidates', 'document.querySelectorAll("[class*=chat-input],[class*=ChatInput]").length'],

  // Dump the first textarea (if any) and its placeholder/aria.
  ['textarea[0] placeholder', 'document.querySelector("textarea")?.placeholder ?? null'],
  ['textarea[0] aria-label', 'document.querySelector("textarea")?.getAttribute("aria-label") ?? null'],
  ['textarea[0] classList', '[...(document.querySelector("textarea")?.classList ?? [])].join(" ")'],

  // Dump classes of all contenteditable elements (these are likely Monaco inputs used by the chat).
  [
    'contenteditable classNames',
    '[...document.querySelectorAll("[contenteditable=true]")].slice(0, 10).map(e => e.className).join("\\n---\\n")',
  ],

  // Look for aria-labels that mention "ask" / "chat" / "agent" — usually reliable.
  [
    'ask/chat aria-labels',
    '[...document.querySelectorAll("[aria-label]")].map(e => e.getAttribute("aria-label")).filter(l => l && /ask|chat|agent|message|prompt/i.test(l)).slice(0, 15).join("\\n")',
  ],

  // Submit-button candidates.
  [
    'submit-like buttons',
    '[...document.querySelectorAll("a[role=button],button,[class*=action]")].map(e => e.getAttribute("aria-label") || e.textContent?.trim()).filter(l => l && /send|submit|ask|run|go/i.test(l)).slice(0, 15).join("\\n")',
  ],
];

for (const [label, expr] of probes) {
  try {
    const v = await evaluate(expr);
    console.log(`\n── ${label} ──`);
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  } catch (err) {
    console.log(`\n── ${label} — ERROR: ${err.message}`);
  }
}

ws.close();
