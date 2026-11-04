// M9 (LOCAL_AI_MASTER_PLAN / Excellence LE-8) — Ollama context-window fallback
// offline smoke.
//
// Two layers, BOTH offline (NO WebSocket, NO server boot, NO live daemon):
//
//   PART A — pure planner unit tests against
//     server/src/providers/ollamaCtxFallback.ts (planCtxEscalation) + the M4
//     classifier discriminator (classifyOllamaError → contextOverflow). These
//     pin the larger-target SELECTION ALGORITHM and its order (num_ctx bump
//     first, then peer), the trusted-ceiling guard, and the bounded-budget
//     exhaustion (no target ⇒ null, no loop).
//
//   PART B — INTEGRATION: a real OllamaWorkerProcess driven with a STUB
//     global.fetch that returns an overflow 400 on the first /api/chat and a
//     valid NDJSON stream on the larger (num_ctx-bumped) re-dispatch. Asserts:
//       - the overflow is CAUGHT (turn does not fail)
//       - a larger target is chosen and re-dispatch happens EXACTLY ONCE
//       - the re-dispatch carried the bumped options.num_ctx (the bigger window)
//       - a context_window_fallback system_notice records from→to
//       - a 400 with NO larger window ⇒ clean terminal failure (no loop)
//       - a 400 AFTER bytes were emitted does NOT re-dispatch (mid-stream guard)
//
// HOME is redirected to a temp dir BEFORE importing the settings module so
// readSettings() sees an empty config (single-backend cascade against the env
// base URL) and the smoke is deterministic regardless of the operator's real
// ~/.arco/settings.json.
//
// Run: npm run smoke:ollama-ctx-fallback   (no dev server needed)

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { EventEmitter } from 'events';

// ── Isolate settings: redirect HOME to an empty temp dir BEFORE any import that
// computes ~/.arco at module-load time. ───────────────────────────────────
const TMP_HOME = mkdtempSync(path.join(tmpdir(), 'arco-m9-'));
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME; // Windows parity
// Point the single-backend cascade at a fixed fake base.
const BASE = 'http://m9-test:11434';
process.env.OLLAMA_URL_BASE = BASE;

let passes = 0;
let fails = 0;
const failures: string[] = [];
function check(name: string, cond: unknown): void {
  if (cond) { passes++; console.log(`  ok  ${name}`); }
  else { fails++; failures.push(name); console.log(`FAIL  ${name}`); }
}

async function main(): Promise<void> {
  // Dynamic imports AFTER HOME is set so settings.ts resolves the temp dir.
  const { planCtxEscalation, MAX_CTX_ESCALATIONS, OLLAMA_DEFAULT_WINDOW } =
    await import('../../server/src/providers/ollamaCtxFallback.js');
  const { classifyOllamaError, _resetCooldownsForTest } =
    await import('../../server/src/providers/ollamaResilience.js');
  const { OllamaWorkerProcess } =
    await import('../../server/src/providers/ollama.js');

  // ════════════════════════════════════════════════════════════════════════
  // PART A — pure planner + classifier discriminator
  // ════════════════════════════════════════════════════════════════════════

  // The classifier flags a 400 as a context overflow (the M9 seam's trigger),
  // and leaves it non-retryable + non-cooling (host stays HOT).
  {
    const d = classifyOllamaError(new Error('overflow'), 400);
    check('classify: 400 → contextOverflow=true', d.contextOverflow === true);
    check('classify: 400 → NOT retryable, NOT cooling (host stays hot)', !d.retryable && !d.cooldown);
    const d503 = classifyOllamaError(new Error('x'), 503);
    check('classify: 503 → NOT contextOverflow', !d503.contextOverflow);
    const d404 = classifyOllamaError(new Error('x'), 404);
    check('classify: 404 → NOT contextOverflow (genuine client error)', !d404.contextOverflow);
  }

  // Strategy 1 (num_ctx bump): same backend, preset below the probed ceiling →
  // bump to the ceiling.
  {
    const t = planCtxEscalation({
      failedWindow: 2048,
      failedBase: BASE,
      failedProbedNumCtx: 32768,
      backends: [{ baseUrl: BASE, label: 'solo', probedNumCtx: 32768, serves: true }],
      alreadyEscalated: new Set(),
    });
    check('plan: num_ctx bump chosen first (2048 → 32768 ceiling)',
      t?.kind === 'numctx_bump' && t.toWindow === 32768 && t.baseUrl === BASE);
  }

  // Trusted-ceiling guard: failing window already AT the probed ceiling → no
  // bump (can't request above the model's real max).
  {
    const t = planCtxEscalation({
      failedWindow: 32768,
      failedBase: BASE,
      failedProbedNumCtx: 32768,
      backends: [{ baseUrl: BASE, label: 'solo', probedNumCtx: 32768, serves: true }],
      alreadyEscalated: new Set(),
    });
    check('plan: NO bump when already at the probed ceiling (trusted-ceiling guard)', t === null);
  }

  // Strategy 2 (peer): same backend at its ceiling, but a peer has a bigger
  // probed window → escalate to the peer.
  {
    const t = planCtxEscalation({
      failedWindow: 8192,
      failedBase: BASE,
      failedProbedNumCtx: 8192,
      backends: [
        { baseUrl: BASE, label: 'small', probedNumCtx: 8192, serves: true },
        { baseUrl: 'http://big:11434', label: 'big', probedNumCtx: 131072, serves: true },
      ],
      alreadyEscalated: new Set(),
    });
    check('plan: peer backend chosen when same-host is maxed and a bigger-window peer exists',
      t?.kind === 'peer_backend' && t.label === 'big' && t.toWindow === 131072);
  }

  // Order: when BOTH a bump and a bigger peer are possible, the bump wins
  // (cheaper, same host — LE-8 order).
  {
    const t = planCtxEscalation({
      failedWindow: 2048,
      failedBase: BASE,
      failedProbedNumCtx: 16384,
      backends: [
        { baseUrl: BASE, label: 'small', probedNumCtx: 16384, serves: true },
        { baseUrl: 'http://big:11434', label: 'big', probedNumCtx: 131072, serves: true },
      ],
      alreadyEscalated: new Set(),
    });
    check('plan: bump precedes peer when both are available (LE-8 order)', t?.kind === 'numctx_bump');
  }

  // Unknown peer window is NOT a valid escalation (a bigger window must be a
  // KNOWN probe, never a guess — guessing risks a second overflow).
  {
    const t = planCtxEscalation({
      failedWindow: 8192,
      failedBase: BASE,
      failedProbedNumCtx: 8192,
      backends: [
        { baseUrl: BASE, label: 'small', probedNumCtx: 8192, serves: true },
        { baseUrl: 'http://unknown:11434', label: 'unknown', probedNumCtx: undefined, serves: undefined },
      ],
      alreadyEscalated: new Set(),
    });
    check('plan: an unknown-window peer is NOT a target (probe required, not a guess)', t === null);
  }

  // Bounded exhaustion: already-escalated targets are excluded → null (no loop).
  {
    const t = planCtxEscalation({
      failedWindow: 2048,
      failedBase: BASE,
      failedProbedNumCtx: 32768,
      backends: [{ baseUrl: BASE, label: 'solo', probedNumCtx: 32768, serves: true }],
      alreadyEscalated: new Set([BASE]),
    });
    check('plan: an already-escalated base yields no further target (bounded, no loop)', t === null);
  }

  // Unknown failing window (M8 deferral case): a KNOWN bigger probe is still a
  // strict upgrade over the assumed default.
  {
    const t = planCtxEscalation({
      failedWindow: undefined,
      failedBase: BASE,
      failedProbedNumCtx: 32768,
      backends: [{ baseUrl: BASE, label: 'solo', probedNumCtx: 32768, serves: true }],
      alreadyEscalated: new Set(),
    });
    check('plan: unknown failing window → bump to a known bigger ceiling (M8 deferral catch)',
      t?.kind === 'numctx_bump' && t.toWindow === 32768);
    check('plan: OLLAMA_DEFAULT_WINDOW exported (= 2048)', OLLAMA_DEFAULT_WINDOW === 2048);
  }

  check('config: MAX_CTX_ESCALATIONS bounded in [1,4]', MAX_CTX_ESCALATIONS >= 1 && MAX_CTX_ESCALATIONS <= 4);

  // ════════════════════════════════════════════════════════════════════════
  // PART B — integration: real worker + stub fetch
  // ════════════════════════════════════════════════════════════════════════

  // NDJSON success body for /api/chat — one content line then a done envelope.
  function chatSuccessBody(text: string): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    const lines =
      JSON.stringify({ message: { role: 'assistant', content: text }, done: false }) + '\n' +
      JSON.stringify({ done: true, prompt_eval_count: 50, eval_count: 5, total_duration: 1_000_000 }) + '\n';
    return new ReadableStream({
      start(controller) { controller.enqueue(enc.encode(lines)); controller.close(); },
    });
  }

  // /api/show metadata: model probed at a 32768 ceiling, no special caps.
  function showBody(numCtx: number): string {
    return JSON.stringify({ parameters: `num_ctx                ${numCtx}\nstop                   "<|im_end|>"`, capabilities: ['tools'] });
  }

  type FetchCall = { url: string; body: unknown };

  // Build a stub fetch. `chatHandler` decides each /api/chat response from the
  // parsed body + call index; /api/show returns the probe; /api/tags returns a
  // model list. Returns the recorded call log.
  function installStubFetch(opts: {
    probedNumCtx: number;
    chatHandler: (call: { index: number; body: any }) => Response;
  }): { calls: FetchCall[]; restore: () => void } {
    const calls: FetchCall[] = [];
    let chatIndex = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ url, body });
      if (url.endsWith('/api/show')) {
        return new Response(showBody(opts.probedNumCtx), { status: 200 });
      }
      if (url.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }), { status: 200 });
      }
      if (url.endsWith('/api/chat')) {
        return opts.chatHandler({ index: chatIndex++, body });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    return { calls, restore: () => { globalThis.fetch = realFetch; } };
  }

  function makeWorker(extra: Record<string, unknown> = {}): InstanceType<typeof OllamaWorkerProcess> {
    // No cwd → no tools, maybeCompact short-circuits → a clean single chat turn
    // that hits the M9 seam directly. Colon-form model skips the /api/tags alias
    // resolve in resolveOllamaModel.
    const config: any = { model: 'qwen3:8b', effort: 'medium', provider: 'ollama', ...extra };
    return new OllamaWorkerProcess('m9-test', config);
  }

  // Drive a worker to terminal (result|error) and collect notices.
  function runWorker(w: InstanceType<typeof OllamaWorkerProcess>, prompt: string): Promise<{ outcome: 'result' | 'error'; payload: any; notices: string[] }> {
    return new Promise((resolve) => {
      const notices: string[] = [];
      (w as EventEmitter).on('system_notice', (n: string) => notices.push(n));
      (w as EventEmitter).on('result', (payload: any) => resolve({ outcome: 'result', payload, notices }));
      (w as EventEmitter).on('error', (payload: any) => resolve({ outcome: 'error', payload, notices }));
      w.spawn(prompt);
    });
  }

  const OVERFLOW_400 = () => new Response('{"error":"context window exceeded"}', { status: 400 });

  // ── B1: overflow → num_ctx bump → success, re-dispatch exactly ONCE ───────
  {
    const stub = installStubFetch({
      probedNumCtx: 32768,
      chatHandler: ({ index }) => index === 0 ? OVERFLOW_400() : new Response(chatSuccessBody('done after bump'), { status: 200 }),
    });
    const w = makeWorker();
    const { outcome, payload, notices } = await runWorker(w, 'hello');
    stub.restore();

    const chatCalls = stub.calls.filter((c) => c.url.endsWith('/api/chat'));
    check('B1: turn succeeds despite the first-dispatch overflow', outcome === 'result');
    check('B1: re-dispatch happened EXACTLY ONCE (2 total /api/chat calls)', chatCalls.length === 2);
    check('B1: the re-dispatch carried the bumped options.num_ctx = 32768',
      (chatCalls[1]?.body as any)?.options?.num_ctx === 32768);
    check('B1: the FIRST dispatch did NOT force the bigger window (ran on default)',
      (chatCalls[0]?.body as any)?.options?.num_ctx === undefined);
    check('B1: a context_window_fallback notice records from→to',
      notices.some((n) => n.includes('context_window_fallback') && n.includes('escalating') && n.includes('32768')));
    check('B1: success notice emitted', notices.some((n) => n.includes('context_window_fallback') && n.includes('succeeded')));
    check('B1: result text is the post-bump answer', String((payload as any)?.text ?? '').includes('done after bump'));
  }

  // ── B2: overflow with NO larger window → clean terminal failure, NO loop ──
  {
    let chatCount = 0;
    const stub = installStubFetch({
      // Probed ceiling EQUALS what the turn would use after applying no preset →
      // wait: no preset means the turn ran on the daemon default (2048), and the
      // probe is the ceiling. To force "no larger window", probe at the default
      // so a bump can't beat it AND there is no peer.
      probedNumCtx: OLLAMA_DEFAULT_WINDOW,
      chatHandler: () => { chatCount++; return OVERFLOW_400(); },
    });
    const w = makeWorker();
    const { outcome, payload, notices } = await runWorker(w, 'hello');
    stub.restore();

    check('B2: a 400 with no larger window terminates with an error', outcome === 'error');
    check('B2: NO re-dispatch loop — chat called exactly once', chatCount === 1);
    check('B2: the terminal message is actionable (mentions raising num_ctx)',
      String(payload).toLowerCase().includes('num_ctx'));
    check('B2: no context_window_fallback escalation notice emitted (nothing to escalate to)',
      !notices.some((n) => n.includes('context_window_fallback') && n.includes('escalating')));
  }

  // ── B3: mid-stream guard — a 400-shaped failure AFTER bytes does NOT re-dispatch
  // We simulate "bytes already emitted then the stream drops" via a body that
  // emits a content chunk then throws. The wrapper sees _emittedBytes>0 and must
  // NOT re-dispatch (would double-emit). This is the explicit mid-stream caveat.
  {
    const enc = new TextEncoder();
    function midStreamDropBody(): ReadableStream<Uint8Array> {
      let sent = false;
      return new ReadableStream({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(enc.encode(JSON.stringify({ message: { role: 'assistant', content: 'partial answer ' }, done: false }) + '\n'));
          } else {
            controller.error(new Error('stream reset mid-flight'));
          }
        },
      });
    }
    let chatCount = 0;
    const stub = installStubFetch({
      probedNumCtx: 32768, // a bigger window IS available, but the guard must suppress re-dispatch
      chatHandler: () => { chatCount++; return new Response(midStreamDropBody(), { status: 200 }); },
    });
    const w = makeWorker();
    const { outcome, notices } = await runWorker(w, 'hello');
    stub.restore();

    check('B3: a mid-stream drop after bytes terminates (no double-emit re-dispatch)', outcome === 'error');
    check('B3: chat called exactly once — the mid-stream guard suppressed re-dispatch', chatCount === 1);
    check('B3: no context_window_fallback escalation after bytes were emitted',
      !notices.some((n) => n.includes('context_window_fallback') && n.includes('escalating')));
  }

  // ── B4: peer escalation end-to-end (multi-backend via temp settings.json) ──
  // Write a 2-backend settings.json into the temp HOME: a small-window primary
  // and a big-window peer. First dispatch overflows (small host at its ceiling
  // → no bump possible); M9 escalates to the peer, which succeeds.
  {
    mkdirSync(path.join(TMP_HOME, '.arco'), { recursive: true });
    writeFileSync(
      path.join(TMP_HOME, '.arco', 'settings.json'),
      JSON.stringify({
        ollama: {
          backends: [
            { baseUrl: BASE, label: 'small', weight: 1 },
            { baseUrl: 'http://m9-big:11434', label: 'big', weight: 1 },
          ],
        },
      }),
    );

    const PEER = 'http://m9-big:11434';
    let chatCalls: FetchCall[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(init.body) : undefined;
      const isSmall = url.startsWith(BASE);
      if (url.endsWith('/api/show')) {
        // small host probed at 8192 (its ceiling), big host at 131072.
        return new Response(showBody(isSmall ? 8192 : 131072), { status: 200 });
      }
      if (url.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }), { status: 200 });
      }
      if (url.endsWith('/api/chat')) {
        chatCalls.push({ url, body });
        // The small host overflows; the big peer succeeds. Pin the operator
        // preset to 8192 on the small host so it's already at its ceiling (no
        // bump available) → forces the PEER path.
        if (isSmall) return OVERFLOW_400();
        return new Response(chatSuccessBody('done on big peer'), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    // Clear the module-level cooldown map so no leftover state from B1–B3 can
    // influence selection here (a 400 never cools the host, but be explicit).
    _resetCooldownsForTest();

    // Preset num_ctx=8192 so the small host runs at its ceiling (bump can't beat
    // it) and the only escalation is the bigger peer.
    const w = makeWorker({ ollamaParams: { num_ctx: 8192 } });
    // DETERMINISM: the two backends have equal weight, so the weighted-shuffle
    // INITIAL selection (selectBackend, default Math.random) would pick small or
    // big with ~50% probability. When it picked the big peer first, that peer
    // succeeded immediately — no overflow, no escalation — and B4 flaked. Pin the
    // selection RNG to 0 so the FIRST dispatch always lands on the small host
    // (cumulative-weight roll 0 → first backend = "small", the settings.json
    // order), forcing the genuine overflow → peer-escalation path under test.
    // The escalation itself is window-driven (planCtxEscalation), not RNG-driven,
    // so this does NOT weaken what B4 verifies.
    w.__setRngForTest(() => 0);
    const { outcome, payload, notices } = await runWorker(w, 'hello');
    globalThis.fetch = realFetch;

    const small = chatCalls.filter((c) => c.url.startsWith(BASE));
    const big = chatCalls.filter((c) => c.url.startsWith(PEER));
    check('B4: peer escalation succeeds end-to-end', outcome === 'result' && String((payload as any)?.text ?? '').includes('big peer'));
    check('B4: the small host overflowed once', small.length === 1);
    check('B4: re-dispatched to the bigger peer exactly once', big.length === 1);
    check('B4: a context_window_fallback [peer_backend] notice records the hop',
      notices.some((n) => n.includes('context_window_fallback') && n.includes('peer_backend') && n.includes('big')));
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log('');
  console.log(`ollama-ctx-fallback: ${passes}/${passes + fails} checks passed`);
  if (fails > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('ollama-ctx-fallback: harness error', err);
  process.exit(1);
});
