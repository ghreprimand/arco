// M7 (LOCAL_AI_MASTER_PLAN / Excellence LE-3) — Ollama utility-model unit smoke.
//
// PURE unit test — NO WebSocket, NO server boot, NO live Ollama daemon. It
// drives runUtilityJob + its request-shaping helpers in
// server/src/providers/ollamaUtility.ts directly, with a STUB fetch, and asserts
// on the request body the helper would send. Offline-runnable (CI has no
// daemon).
//
// The load-bearing assertions (the "bounded helper, not distill" fences):
//   - stream:false (a single non-streaming round-trip, not the interactive turn)
//   - the num_predict OUTPUT cap is applied + clamped to the ceiling
//   - the input WINDOW bounds the prompt (last-N messages + byte cap)
//   - the JSON/`format` path rides when a schema is given (M5 reuse)
//   - unconfigured ⇒ ok:false reason:'unconfigured' (default-OFF fallback)
//   - fail-soft: a failing fetch returns ok:false, never throws
//   - the M8 host seam (runUtilitySummaryJob) returns text / null
//
// Run: npm run smoke:ollama-utility   (no dev server needed)

import {
  runUtilityJob,
  runUtilitySummaryJob,
  buildUtilityRequest,
  windowUtilityMessages,
  resolveUtilityConfig,
  UTILITY_DEFAULT_MAX_TOKENS,
  type UtilityJobInput,
  type UtilityMessage,
  type UtilityModelConfig,
} from '../../server/src/providers/ollamaUtility.js';
import type { ResolvedBackend } from '../../server/src/providers/ollamaResilience.js';

let passes = 0;
let fails = 0;
const failures: string[] = [];

function check(name: string, cond: boolean): void {
  if (cond) {
    passes++;
    console.log(`  ok  ${name}`);
  } else {
    fails++;
    failures.push(name);
    console.log(`FAIL  ${name}`);
  }
}

const CFG: UtilityModelConfig = { model: 'qwen3:3b' };
const BACKENDS: ResolvedBackend[] = [{ baseUrl: 'http://localhost:11434', weight: 1, label: 'local', isLocal: true }];

// A stub fetch that captures the request body + returns a canned non-stream
// /api/chat response. `bodyOut` is filled with the parsed request body so we can
// assert on the shaping.
function stubFetch(bodyOut: { value?: any }, response: unknown, status = 200): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    // The body-less GET /api/version liveness probe (added with d251dcc)
    // precedes every /api/chat — answer it without clobbering bodyOut.
    if (String(url).endsWith('/api/version')) {
      return { ok: true, status: 200, json: async () => ({ version: 'stub' }), text: async () => '{}' } as Response;
    }
    bodyOut.value = JSON.parse(String(init?.body));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response,
      text: async () => JSON.stringify(response),
    } as Response;
  }) as unknown as typeof fetch;
}

async function main(): Promise<void> {
  // ── buildUtilityRequest: stream:false + num_predict cap ──────────────────────
  {
    const req = buildUtilityRequest({ job: 'title', prompt: 'hello' }, 'qwen3:3b');
    check('build: stream is false', req.stream === false);
    check('build: num_predict defaults to UTILITY_DEFAULT_MAX_TOKENS',
      req.options.num_predict === UTILITY_DEFAULT_MAX_TOKENS);
    check('build: a single user message when given a prompt',
      req.messages.length === 1 && req.messages[0].role === 'user' && req.messages[0].content === 'hello');
    check('build: keep_alive set (short, warms but does not camp VRAM)', req.keep_alive === '5m');
    check('build: no format on a free-text job', req.format === undefined);
  }

  // ── num_predict cap is honored + clamped to the ceiling ──────────────────────
  {
    const small = buildUtilityRequest({ job: 'x', prompt: 'p', maxTokens: 32 }, 'm');
    check('build: caller maxTokens honored', small.options.num_predict === 32);
    const huge = buildUtilityRequest({ job: 'x', prompt: 'p', maxTokens: 999999 }, 'm');
    check('build: maxTokens clamped to the 4096 ceiling', huge.options.num_predict === 4096);
  }

  // ── format (M5 reuse) rides on a structured job ──────────────────────────────
  {
    const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] };
    const req = buildUtilityRequest({ job: 'x', prompt: 'p', format: schema }, 'm');
    check('build: format attached when a schema is given', JSON.stringify(req.format) === JSON.stringify(schema));
    const jsonReq = buildUtilityRequest({ job: 'x', prompt: 'p', format: 'json' }, 'm');
    check('build: format:"json" attached', jsonReq.format === 'json');
  }

  // ── windowing bounds the input (last-N messages) ─────────────────────────────
  {
    const msgs: UtilityMessage[] = [];
    for (let i = 0; i < 50; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` });
    const windowed = windowUtilityMessages(msgs, 10, 1_000_000);
    check('window: last-N keeps only N messages', windowed.length === 10);
    check('window: keeps the NEWEST messages', windowed[windowed.length - 1].content === 'm49');
  }

  // ── windowing preserves a leading system message (exempt from the window) ─────
  {
    const msgs: UtilityMessage[] = [{ role: 'system', content: 'SYS' }];
    for (let i = 0; i < 50; i++) msgs.push({ role: 'user', content: `m${i}` });
    const windowed = windowUtilityMessages(msgs, 5, 1_000_000);
    check('window: system message preserved at the head', windowed[0].role === 'system' && windowed[0].content === 'SYS');
    check('window: system + N body messages', windowed.length === 6);
  }

  // ── windowing byte cap drops oldest body messages first ──────────────────────
  {
    const msgs: UtilityMessage[] = [
      { role: 'user', content: 'a'.repeat(1000) },
      { role: 'assistant', content: 'b'.repeat(1000) },
      { role: 'user', content: 'c'.repeat(1000) },
    ];
    const windowed = windowUtilityMessages(msgs, 100, 1500);
    check('window: byte cap drops oldest first', windowed.length < 3 && windowed[windowed.length - 1].content[0] === 'c');
  }

  // ── windowing truncates a single oversized message (keeps the tail) ──────────
  {
    const msgs: UtilityMessage[] = [{ role: 'user', content: 'z'.repeat(10000) }];
    const windowed = windowUtilityMessages(msgs, 100, 500);
    check('window: single huge message truncated to the byte cap', Buffer.byteLength(windowed[0].content, 'utf8') <= 500);
  }

  // ── runUtilityJob: unconfigured ⇒ default-OFF fallback ───────────────────────
  {
    const res = await runUtilityJob({ job: 'x', prompt: 'p', config: null, backends: BACKENDS });
    check('run: unconfigured returns ok:false reason:unconfigured', !res.ok && res.reason === 'unconfigured');
  }

  // ── runUtilityJob: success path sends stream:false + reports usage + notice ───
  {
    const captured: { value?: any } = {};
    const notices: string[] = [];
    const res = await runUtilityJob({
      job: 'session-title',
      system: 'frame',
      prompt: 'summarize this',
      maxTokens: 64,
      config: CFG,
      backends: BACKENDS,
      onNotice: (l) => notices.push(l),
      fetchImpl: stubFetch(captured, { message: { content: 'A Nice Title' }, prompt_eval_count: 42, eval_count: 7 }),
    });
    check('run: ok on a 200 response', res.ok === true);
    check('run: returns the model text', res.ok && res.text === 'A Nice Title');
    check('run: sent stream:false', captured.value?.stream === false);
    check('run: sent the num_predict cap', captured.value?.options?.num_predict === 64);
    check('run: reports input/output token usage', res.ok && res.inputTokens === 42 && res.outputTokens === 7);
    check('run: emitted a visibility notice naming the job + model', notices.some((l) => l.includes('session-title') && l.includes('qwen3:3b')));
  }

  // ── runUtilityJob: structured job parses JSON ────────────────────────────────
  {
    const captured: { value?: any } = {};
    const res = await runUtilityJob({
      job: 'structured',
      prompt: 'p',
      format: { type: 'object' },
      config: CFG,
      backends: BACKENDS,
      fetchImpl: stubFetch(captured, { message: { content: '{"title":"x"}' }, prompt_eval_count: 1, eval_count: 1 }),
    });
    check('run: format sent on a structured job', captured.value?.format !== undefined);
    check('run: structured result parsed into json', res.ok && (res.json as any)?.title === 'x');
  }

  // ── runUtilityJob: fail-soft on an error response (never throws) ──────────────
  {
    const res = await runUtilityJob({
      job: 'x',
      prompt: 'p',
      config: CFG,
      backends: BACKENDS,
      fetchImpl: stubFetch({}, { error: 'boom' }, 500),
    });
    check('run: HTTP 500 → ok:false reason:error (fail-soft, no throw)', !res.ok && res.reason === 'error');
  }

  // ── runUtilityJob: fail-soft when fetch itself throws ────────────────────────
  {
    const throwingFetch = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const res = await runUtilityJob({ job: 'x', prompt: 'p', config: CFG, backends: BACKENDS, fetchImpl: throwingFetch });
    check('run: connection error → ok:false reason:error (no throw)', !res.ok && res.reason === 'error');
  }

  // ── resolveUtilityConfig: default-OFF + parse ────────────────────────────────
  {
    check('config: unset ⇒ null (default-OFF)', resolveUtilityConfig(undefined) === null);
    check('config: blank model ⇒ null', resolveUtilityConfig({ utility: { model: '  ' } }) === null);
    const c = resolveUtilityConfig({ utility: { model: 'qwen3:3b', baseUrl: 'http://h:11434/' } });
    check('config: parses model + strips trailing slash on baseUrl', c?.model === 'qwen3:3b' && c?.baseUrl === 'http://h:11434');
  }

  // ── M8 host seam: runUtilitySummaryJob returns text / null ───────────────────
  {
    const captured: { value?: any } = {};
    const text = await runUtilitySummaryJob({
      messages: [{ role: 'user', content: 'old turn 1' }, { role: 'assistant', content: 'old turn 2' }],
      maxTokens: 256,
      config: CFG,
      backends: BACKENDS,
      fetchImpl: stubFetch(captured, { message: { content: 'dense recap' }, prompt_eval_count: 5, eval_count: 3 }),
    });
    check('M8 seam: returns the summary text', text === 'dense recap');
    check('M8 seam: uses the compaction-summary num_predict cap', captured.value?.options?.num_predict === 256);
    check('M8 seam: stream:false', captured.value?.stream === false);

    const nullText = await runUtilitySummaryJob({ messages: [{ role: 'user', content: 'x' }], config: null, backends: BACKENDS });
    check('M8 seam: unconfigured ⇒ null (M8 owns the deterministic fallback)', nullText === null);
  }

  // ── summary ──────────────────────────────────────────────────────────────────
  console.log('');
  console.log(`ollama-utility: ${passes}/${passes + fails} checks passed`);
  if (fails > 0) {
    console.log('');
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

void main();
