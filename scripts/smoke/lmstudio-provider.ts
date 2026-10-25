// M13 (LOCAL_AI_MASTER_PLAN Stage 5 / Excellence LE-7) — LM Studio provider
// unit smoke.
//
// PURE unit test — NO WebSocket, NO server boot, NO live LM Studio app. It
// stubs global fetch and drives the LmstudioProvider worker + probe directly,
// asserting the OpenAI-compatible HTTP contract. Offline-runnable.
//
// STANDING VERDICT under test (docs/LOCAL_AI_MASTER_PLAN.md §"Two standing
// verdicts" + LE-7): LM Studio is an OpenAI-COMPATIBLE HTTP endpoint, NOT the
// native lmstudio.js SDK. So every assertion here is about the OpenAI wire
// shape: POST /v1/chat/completions with an OpenAI-shaped body, SSE `data:`
// streaming with a `[DONE]` terminator, OpenAI `tool_calls` round-trip, the
// `usage` object, GET /v1/models discovery, and a custom base URL honored.
//
// Asserts:
//   - getLmstudioBase honors LMSTUDIO_URL_BASE and appends /v1 when absent.
//   - probeLmstudio parses GET /v1/models → installed model id list (no M1
//     empty-dropdown gap) + conservative capability flags.
//   - a turn POSTs to <base>/chat/completions with stream:true, OpenAI
//     messages, stream_options.include_usage, and OpenAI tools[].
//   - SSE content deltas stream as `text` events; `[DONE]` terminates cleanly.
//   - reasoning_content deltas route to `thinking`, not `text`.
//   - fragmented OpenAI tool_calls reassemble, dispatch (SAFE mode → refusal
//     string, so no real tool runs), and the loop continues to a final answer.
//   - the `usage` object is read into the result's input/output tokens.
//   - a custom base URL (env) is honored on BOTH /v1/models and the chat POST.
//
// Run: npm run smoke:lmstudio-provider   (no dev server needed)

import {
  LmstudioProvider,
  getLmstudioBase,
  lmstudioBaseFromEnv,
  probeLmstudio,
} from '../../server/src/providers/lmstudio.js';
import type { WorkerConfig } from '@archon/shared';

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

// ── fetch stub plumbing ───────────────────────────────────────────────────────
// Record every request so assertions can inspect URL + body. Each test installs
// a handler that returns the Response it wants for a given URL.
interface RecordedRequest { url: string; init?: RequestInit; body?: any }
let recorded: RecordedRequest[] = [];
let handler: (url: string, init?: RequestInit) => Response | Promise<Response> = () => {
  throw new Error('no fetch handler installed');
};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.url;
  let body: any;
  if (init?.body && typeof init.body === 'string') {
    try { body = JSON.parse(init.body); } catch { body = init.body; }
  }
  recorded.push({ url, init, body });
  return handler(url, init);
}) as typeof fetch;

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

// Build a Response whose body is an SSE stream of the given OpenAI chunks,
// terminated by `[DONE]`. Mirrors how LM Studio / llama-server frame events.
function sseResponse(chunks: unknown[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
      }
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

// Drive a worker turn to settle, collecting all emitted events.
interface Collected {
  text: string;
  thinking: string;
  toolUses: Array<{ name: string; input: string; toolUseId?: string }>;
  notices: string[];
  result?: any;
  error?: string;
}
function runWorker(config: WorkerConfig, prompt: string): Promise<Collected> {
  const proc = LmstudioProvider.create('smoke-lmstudio', config);
  const out: Collected = { text: '', thinking: '', toolUses: [], notices: [] };
  return new Promise<Collected>((resolve) => {
    proc.on('text', (t: string) => { out.text += t; });
    proc.on('thinking', (t: string) => { out.thinking += t; });
    proc.on('tool_use', (d: any) => { out.toolUses.push(d); });
    proc.on('system_notice', (n: string) => { out.notices.push(n); });
    proc.once('result', (r: any) => { out.result = r; resolve(out); });
    proc.once('error', (e: string) => { out.error = e; resolve(out); });
    proc.spawn(prompt);
  });
}

const CUSTOM_BASE_HOST = 'http://127.0.0.1:9912'; // bare host:port — exercises the /v1 auto-append

async function main(): Promise<void> {
  // ── 1. base-url cascade ─────────────────────────────────────────────────────
  console.log('\n[1] base URL cascade (env + /v1 auto-append)');
  delete process.env.LMSTUDIO_URL_BASE;
  check('default base is localhost:1234/v1', lmstudioBaseFromEnv() === 'http://localhost:1234/v1');

  process.env.LMSTUDIO_URL_BASE = CUSTOM_BASE_HOST; // no /v1 suffix
  check('env base honored', lmstudioBaseFromEnv() === `${CUSTOM_BASE_HOST}/v1`);
  check('env base auto-appends /v1', lmstudioBaseFromEnv().endsWith('/v1'));

  process.env.LMSTUDIO_URL_BASE = `${CUSTOM_BASE_HOST}/v1/`; // already-suffixed + trailing slash
  check('explicit /v1 not doubled', lmstudioBaseFromEnv() === `${CUSTOM_BASE_HOST}/v1`);

  // getLmstudioBase falls back to env when settings has no override. (Settings
  // may or may not pin lmstudio on the dev box; assert it resolves to a /v1 URL
  // either way — the env override path is the one M13 adds.)
  process.env.LMSTUDIO_URL_BASE = CUSTOM_BASE_HOST;
  const resolved = await getLmstudioBase();
  check('getLmstudioBase resolves to a /v1 URL', /\/v\d+$/.test(resolved));

  // ── 2. model discovery via /v1/models ───────────────────────────────────────
  console.log('\n[2] model discovery (GET /v1/models → installed list)');
  process.env.LMSTUDIO_URL_BASE = CUSTOM_BASE_HOST;
  recorded = [];
  handler = (url) => {
    if (url.endsWith('/models')) {
      return jsonResponse({ object: 'list', data: [
        { id: 'qwen2.5-coder-7b-instruct', object: 'model' },
        { id: 'llama-3.2-3b-instruct', object: 'model' },
        { id: 42 }, // malformed id → dropped
      ] });
    }
    throw new Error(`unexpected ${url}`);
  };
  const probe = await probeLmstudio();
  check('probe up', probe.up === true);
  check('probe hit /v1/models on the custom base', recorded.some((r) => r.url === `${CUSTOM_BASE_HOST}/v1/models`));
  check('probe discovered both well-formed model ids',
    probe.models.length === 2 &&
    probe.models.includes('qwen2.5-coder-7b-instruct') &&
    probe.models.includes('llama-3.2-3b-instruct'));
  check('probe dropped the malformed id', !probe.models.some((m) => m === '42' || m === '' ));
  check('probe reports conservative tools:true capability flag',
    probe.capabilities?.['qwen2.5-coder-7b-instruct']?.tools === true);

  // probe fail-soft when the endpoint is down (non-OK).
  recorded = [];
  handler = () => jsonResponse({ error: 'nope' }, 503);
  const downProbe = await probeLmstudio();
  check('probe fail-soft on HTTP error (up=false, no throw)', downProbe.up === false && downProbe.models.length === 0);

  // ── 3. a plain streamed turn (content deltas + [DONE] + usage) ───────────────
  console.log('\n[3] streamed chat turn (content + [DONE] + usage)');
  process.env.LMSTUDIO_URL_BASE = CUSTOM_BASE_HOST;
  recorded = [];
  handler = (url) => {
    if (url.endsWith('/chat/completions')) {
      return sseResponse([
        { choices: [{ delta: { reasoning_content: 'let me think… ' } }] },
        { choices: [{ delta: { content: 'Hello' } }] },
        { choices: [{ delta: { content: ', world' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 123, completion_tokens: 45 } },
      ]);
    }
    throw new Error(`unexpected ${url}`);
  };
  const plain = await runWorker(
    { model: 'qwen2.5-coder-7b-instruct', effort: 'high', provider: 'lmstudio', systemPrompt: 'You are a test.' },
    'say hello',
  );
  const chatReq = recorded.find((r) => r.url.endsWith('/chat/completions'));
  check('POST hit <custom-base>/v1/chat/completions', chatReq?.url === `${CUSTOM_BASE_HOST}/v1/chat/completions`);
  check('request method is POST', chatReq?.init?.method === 'POST');
  check('request body is OpenAI-shaped (model + messages array)',
    chatReq?.body?.model === 'qwen2.5-coder-7b-instruct' && Array.isArray(chatReq?.body?.messages));
  check('request streams with include_usage',
    chatReq?.body?.stream === true && chatReq?.body?.stream_options?.include_usage === true);
  check('system message carried through as OpenAI role:system',
    chatReq?.body?.messages?.[0]?.role === 'system' && String(chatReq?.body?.messages?.[0]?.content).includes('You are a test.'));
  check('content deltas streamed to text (no reasoning leak)', plain.text === 'Hello, world');
  check('reasoning_content routed to thinking channel', plain.thinking.includes('let me think'));
  check('usage object read into result tokens',
    plain.result?.usage?.input_tokens === 123 && plain.result?.usage?.output_tokens === 45);
  check('result settled (no error)', !plain.error && plain.result !== undefined);

  // ── 4. tool_calls round-trip (fragmented → reassembled → dispatched) ─────────
  console.log('\n[4] OpenAI tool_calls round-trip (SAFE mode → refusal, loop continues)');
  recorded = [];
  let chatCall = 0;
  handler = (url) => {
    if (url.endsWith('/chat/completions')) {
      chatCall++;
      if (chatCall === 1) {
        // First turn: emit a tool_call fragmented across two deltas (OpenAI
        // streaming splits function.arguments). finish_reason tool_calls.
        const argFrag1 = '{"file_path":';
        const argFrag2 = '"/tmp/x.txt"}';
        const tc1 = { index: 0, id: 'call_1', function: { name: 'Read', arguments: argFrag1 } };
        const tc2 = { index: 0, function: { arguments: argFrag2 } };
        return sseResponse([
          { choices: [{ delta: { tool_calls: [tc1] } }] },
          { choices: [{ delta: { tool_calls: [tc2] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 50, completion_tokens: 10 } },
        ]);
      }
      // Second turn (after the tool result message): produce a final answer.
      return sseResponse([
        { choices: [{ delta: { content: 'done reading' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 5 } },
      ]);
    }
    throw new Error(`unexpected ${url}`);
  };
  const tooled = await runWorker(
    // cwd set so tools are exposed; skipPermissions OMITTED → SAFE mode, so the
    // dispatch returns a refusal string instead of actually reading the file.
    { model: 'qwen2.5-coder-7b-instruct', effort: 'high', provider: 'lmstudio', cwd: '/tmp' },
    'read a file',
  );
  const firstReq = recorded.filter((r) => r.url.endsWith('/chat/completions'))[0];
  check('first request exposed OpenAI tools[] (function-typed)',
    Array.isArray(firstReq?.body?.tools) &&
    firstReq.body.tools.length > 0 &&
    firstReq.body.tools[0].type === 'function' &&
    typeof firstReq.body.tools[0].function?.name === 'string');
  check('fragmented tool_call reassembled + dispatched once',
    tooled.toolUses.length === 1 && tooled.toolUses[0].name === 'Read');
  check('reassembled arguments parsed to the right path',
    (() => { try { return JSON.parse(tooled.toolUses[0].input).file_path === '/tmp/x.txt'; } catch { return false; } })());
  check('made a SECOND chat round-trip after the tool result', chatCall === 2);
  check('second request carried a role:tool message answering call_1',
    (() => {
      const second = recorded.filter((r) => r.url.endsWith('/chat/completions'))[1];
      const msgs = second?.body?.messages ?? [];
      return msgs.some((m: any) => m.role === 'tool' && m.tool_call_id === 'call_1');
    })());
  check('final answer streamed after the tool loop', tooled.text === 'done reading');
  check('tool-loop result settled with summed output tokens',
    tooled.result?.usage?.output_tokens === 15 && tooled.result?.usage?.input_tokens === 80);

  // ── teardown ────────────────────────────────────────────────────────────────
  globalThis.fetch = realFetch;
  delete process.env.LMSTUDIO_URL_BASE;

  console.log(`\n${passes} passed, ${fails} failed`);
  if (fails > 0) {
    console.log('failures:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
