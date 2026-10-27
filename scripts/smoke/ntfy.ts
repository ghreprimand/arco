// docs/ARCHITECTURE.md - ntfy external transport smoke.
//
// Pure (no dev server, no network, no real ~/.arco): exercises the transport
// seam + the ntfy request builder end to end with a temp mutes file and an
// injected fake fetch. Asserts:
//
//   1. deriveConsoleUrl maps ws→http / wss→https and drops the path.
//   2. buildNtfyRequest: Title sanitized, Priority by severity, Tags, Click
//      (when consoleUrl set), Authorization (when token set), body shape.
//   3. The chokepoint fans out to a registered transport for SURVIVING notices
//      and SUPPRESSES muted ones (the load-bearing single-chokepoint promise).
//   4. initNtfyTransport is INERT without ARCO_NTFY_URL, ACTIVE with it, and
//      a live emit() drives one POST with the built request.
//
// Run: npm run smoke:ntfy

import { tmpdir } from 'os';
import { join } from 'path';
import { step, assert, assertEq, summary } from './lib.js';
import {
  initNotifications,
  emit,
  setMutes,
  registerNoticeTransport,
  _resetTransportsForTest,
  _setMutesPathForTest,
} from '../../server/src/notifications.js';
import {
  buildNtfyRequest,
  deriveConsoleUrl,
  initNtfyTransport,
  getNtfyConfig,
} from '../../server/src/ntfyTransport.js';
import type { WorkbenchNotice } from '../../shared/src/protocol/notifications.js';

function notice(over: Partial<WorkbenchNotice> = {}): WorkbenchNotice {
  return {
    id: 'wn_test',
    category: 'turn-finished',
    severity: 'success',
    title: 'Turn finished — demo',
    body: 'Ran 2m 3s.',
    ts: 0,
    ...over,
  };
}

async function main() {
  // Isolate persistence: never touch the real ~/.arco mutes.
  _setMutesPathForTest(join(tmpdir(), `arco-ntfy-smoke-${process.pid}.json`));
  await initNotifications(() => { /* swallow in-app broadcasts */ });

  await step('deriveConsoleUrl maps ws/wss → http/https + drops path', () => {
    assertEq(deriveConsoleUrl('ws://100.64.0.20:3500/agent'), 'http://100.64.0.20:3500/', 'ws→http');
    assertEq(deriveConsoleUrl('wss://hub.example:3500/instance'), 'https://hub.example:3500/', 'wss→https');
    assertEq(deriveConsoleUrl(undefined), undefined, 'undefined passes through');
    assertEq(deriveConsoleUrl('not a url'), undefined, 'garbage → undefined');
  });

  await step('buildNtfyRequest: headers + body shape', () => {
    const req = buildNtfyRequest(notice({ workflowId: 'abcd1234ef' }), {
      topicUrl: 'http://hub:3501/arco-x',
      token: 'tk_secret',
      consoleUrl: 'http://hub:3500/',
      instanceLabel: 'workstation',
    });
    assertEq(req.url, 'http://hub:3501/arco-x', 'url is the topic');
    assertEq(req.headers.Title, 'Turn finished - demo', 'em-dash transliterated to ascii hyphen');
    assertEq(req.headers.Priority, 'default', 'success → default priority');
    assertEq(req.headers.Tags, 'white_check_mark', 'success tag');
    // R6 — workflow-scoped notices deep-link to that workflow's row.
    assertEq(req.headers.Click, 'http://hub:3500/#w=abcd1234ef', 'click → console deep link');
    assertEq(req.headers.Authorization, 'Bearer tk_secret', 'bearer token');
    assert(req.body.startsWith('[workstation]'), `body leads with workstation: ${req.body}`);
    assert(req.body.includes('Ran 2m 3s.'), 'body carries the notice body');
    assert(req.body.includes('workflow abcd1234'), 'body carries an 8-char workflow hint');
  });

  await step('buildNtfyRequest: priority + tag by severity; no Click/Auth when unset', () => {
    const err = buildNtfyRequest(notice({ severity: 'error', title: 'Auth expired' }), { topicUrl: 't' });
    assertEq(err.headers.Priority, 'high', 'error → high');
    assertEq(err.headers.Tags, 'rotating_light', 'error tag');
    assert(!('Click' in err.headers), 'no Click without consoleUrl');
    assert(!('Authorization' in err.headers), 'no auth without token');
    const warn = buildNtfyRequest(notice({ severity: 'warning' }), { topicUrl: 't' });
    assertEq(warn.headers.Priority, 'high', 'warning → high');
    const info = buildNtfyRequest(notice({ severity: 'info' }), { topicUrl: 't' });
    assertEq(info.headers.Priority, 'low', 'info → low');
  });

  await step('chokepoint fans out to transports for surviving notices', () => {
    _resetTransportsForTest();
    const seen: WorkbenchNotice[] = [];
    registerNoticeTransport((n) => { seen.push(n); });
    const out = emit({ category: 'quota-recovered', severity: 'success', title: 'claude quota recovered' });
    assert(out !== null, 'non-muted notice broadcasts');
    assertEq(seen.length, 1, 'transport received exactly one');
    assertEq(seen[0].category, 'quota-recovered', 'right notice');
  });

  await step('muted category is suppressed from transports too', () => {
    _resetTransportsForTest();
    const seen: WorkbenchNotice[] = [];
    registerNoticeTransport((n) => { seen.push(n); });
    setMutes(['terminal-exited']);
    const out = emit({ category: 'terminal-exited', severity: 'warning', title: 'Terminal exited (code 1)' });
    assertEq(out, null, 'muted notice returns null');
    assertEq(seen.length, 0, 'transport NOT called for a muted category');
    setMutes([]); // restore
  });

  await step('initNtfyTransport is inert without ARCO_NTFY_URL', () => {
    _resetTransportsForTest();
    const active = initNtfyTransport({ env: {}, instanceLabel: 'x' });
    assertEq(active, false, 'inert when unconfigured');
    assertEq(getNtfyConfig(), null, 'no config stored');
  });

  await step('initNtfyTransport active → live emit drives one POST', async () => {
    _resetTransportsForTest();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response('1', { status: 200 });
    }) as unknown as typeof fetch;

    const active = initNtfyTransport({
      env: { ARCO_NTFY_URL: 'http://hub:3501/arco-x', ARCO_HUB_URL: 'ws://hub:3500/agent', ARCO_NTFY_TOKEN: 'tk' },
      fetchImpl: fakeFetch,
      instanceLabel: 'workstation',
    });
    assertEq(active, true, 'active when ARCO_NTFY_URL set');
    const cfg = getNtfyConfig();
    assert(cfg !== null, 'config stored');
    assertEq(cfg!.consoleUrl, 'http://hub:3500/', 'console derived from hub url');

    emit({ category: 'turn-finished', severity: 'success', title: 'Turn finished — live' });
    // The transport is fire-and-forget (async); give the microtask a beat.
    await new Promise((r) => setTimeout(r, 50));
    assertEq(calls.length, 1, 'exactly one POST fired');
    assertEq(calls[0].url, 'http://hub:3501/arco-x', 'POST to the topic url');
    assertEq((calls[0].init.method || '').toUpperCase(), 'POST', 'method POST');
    const headers = calls[0].init.headers as Record<string, string>;
    assertEq(headers.Title, 'Turn finished - live', 'title header');
    assertEq(headers.Click, 'http://hub:3500/', 'click header');
    assertEq(headers.Authorization, 'Bearer tk', 'auth header');
  });

  _resetTransportsForTest();
  summary('J2 ntfy transport');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
