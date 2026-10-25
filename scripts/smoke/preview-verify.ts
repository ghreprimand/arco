// G1 + G2 — Preview verification capture smoke.
//
// PURE — NO Arco WebSocket / server boot / live model. Exercises the CDP
// capture module (server/src/preview/captureViaCdp.ts) directly:
//   - browser discovery is total (returns string | null, never throws)
//   - graceful degradation: no preview listening → ok:false naming the cause,
//     OR (no browser installed) → ok:false naming Chrome/Chromium
//   - when a system browser IS present, a real capture against a tiny local
//     server surfaces the page title, a console.error, a 404 network entry, and
//     a screenshot.
//   - G2: layout/accessibility notes are collected (missing alt, unlabelled
//     input, no <html lang>); the viewport preset is honored (desktop 1280 vs
//     mobile 390) and a 1000px block overflows only the mobile viewport.
//
// Stays green on any box: the live-capture asserts only run when a browser is
// found; otherwise they are reported as SKIP and the degradation path is asserted
// instead. Run: npm run smoke:preview-verify  (no dev server needed)

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { capturePreview, findBrowserBinary } from '../../server/src/preview/captureViaCdp.js';

let passes = 0;
let fails = 0;
let skips = 0;
const failures: string[] = [];

function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`  PASS  ${label}`); passes++; }
  else { const m = `${label}${detail ? `: ${detail}` : ''}`; console.log(`  FAIL  ${m}`); failures.push(m); fails++; }
}
function skip(label: string, reason: string): void {
  console.log(`  SKIP  ${label} (${reason})`);
  skips++;
}

// Tiny page that logs a console error and fires a request that 404s, so the
// capture has something concrete to collect. G2: it also carries deliberate
// layout/accessibility smells — an <img> with no alt, an unlabelled <input>,
// and a 1000px-wide block. The block fits a 1280px desktop viewport (no
// overflow) but overflows a 390px mobile viewport, so the same page reads
// "clean" on desktop and "overflowing" on mobile — exercising viewport
// sensitivity. `<html>` has no `lang` on purpose (a flagged signal).
const PAGE = `<!doctype html><html><head><title>Arco Preview Smoke</title></head>
<body><h1>hello</h1>
<img src="/missing.png">
<input type="text" name="unlabelled">
<div style="width:1000px;height:10px;background:#ccc"></div>
<script>
  console.error('SMOKE_CONSOLE_ERR boom');
  fetch('/definitely-missing').catch(() => {});
</script></body></html>`;

function startServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url && req.url.startsWith('/definitely-missing')) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('nope');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ port, close: () => server.close() });
    });
  });
}

// Find a port nothing is listening on (for the degradation case). 0-listen then
// immediately close hands back a very-recently-free port.
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function main(): Promise<void> {
  // ── browser discovery is total ──
  const binary = findBrowserBinary();
  check('findBrowserBinary returns string|null (no throw)', binary === null || typeof binary === 'string', String(binary));
  const hasBrowser = typeof binary === 'string';

  if (!hasBrowser) {
    // No browser: every capture must degrade to ok:false naming Chrome/Chromium.
    const srv = await startServer();
    try {
      const res = await capturePreview({ port: srv.port });
      check('no-browser capture returns ok:false', res.ok === false);
      check('no-browser error names Chrome/Chromium', /chrom/i.test(res.error || ''), res.error);
    } finally {
      srv.close();
    }
    skip('live capture (title/console/network/screenshot)', 'no system Chrome/Chromium installed');
  } else {
    // ── live capture against a real local server ──
    const srv = await startServer();
    try {
      const res = await capturePreview({ port: srv.port, navigateTimeoutMs: 15000 });
      check('live capture ok', res.ok === true, res.error);
      check('live capture reports the page title', res.title === 'Arco Preview Smoke', res.title);
      check('live capture has a screenshot', typeof res.screenshotBase64 === 'string' && res.screenshotBase64.length > 0);
      check(
        'live capture collected the console.error',
        res.console.some((e) => e.level === 'error' && e.text.includes('SMOKE_CONSOLE_ERR')),
        JSON.stringify(res.console),
      );
      check(
        'live capture collected the 404 network entry',
        res.network.some((n) => n.url.includes('/definitely-missing') && n.status === 404),
        JSON.stringify(res.network),
      );

      // ── G2: layout/accessibility notes on the default (desktop) capture ──
      check('desktop capture reports layout notes', !!res.layout, JSON.stringify(res.layout));
      check('desktop layout viewport is desktop 1280×800', res.layout?.viewport === 'desktop' && res.layout?.width === 1280, JSON.stringify(res.layout));
      check('layout flags the missing alt', (res.layout?.imagesMissingAlt ?? 0) >= 1, String(res.layout?.imagesMissingAlt));
      check('layout flags the unlabelled input', (res.layout?.inputsMissingLabel ?? 0) >= 1, String(res.layout?.inputsMissingLabel));
      check('layout flags the missing <html lang>', res.layout?.lang === '', JSON.stringify(res.layout?.lang));
      check('1000px block fits the desktop viewport (no overflow)', res.layout?.horizontalOverflowPx === 0, String(res.layout?.horizontalOverflowPx));

      // ── G2: the same page on a mobile viewport overflows ──
      const mob = await capturePreview({ port: srv.port, viewport: 'mobile', navigateTimeoutMs: 15000 });
      check('mobile capture ok', mob.ok === true, mob.error);
      check('mobile layout viewport is mobile 390×844', mob.layout?.viewport === 'mobile' && mob.layout?.width === 390, JSON.stringify(mob.layout));
      check('1000px block overflows the 390px mobile viewport', (mob.layout?.horizontalOverflowPx ?? 0) > 0, String(mob.layout?.horizontalOverflowPx));
    } finally {
      srv.close();
    }

    // ── degradation: nothing listening on the port ──
    const dead = await freePort();
    const res = await capturePreview({ port: dead, navigateTimeoutMs: 8000 });
    // A refused connection still resolves ok (we capture the error page) but the
    // navigation failure must surface as a console entry — nothing is silent.
    check('dead-port capture still resolves ok', res.ok === true, res.error);
    check(
      'dead-port capture surfaces the navigation failure',
      res.console.some((e) => /navigation/i.test(e.text)) || res.network.length > 0,
      JSON.stringify({ console: res.console, network: res.network }),
    );
  }

  console.log(`\n${fails === 0 ? 'OK' : 'FAIL'} — ${passes} passed, ${fails} failed, ${skips} skipped`);
  if (fails > 0) {
    console.log('Failures:\n' + failures.map((f) => `  - ${f}`).join('\n'));
    process.exit(1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
