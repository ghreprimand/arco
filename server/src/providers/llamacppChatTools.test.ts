import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { LlamacppModelDef, WorkerConfig } from '@arco/shared';
import { LlamacppProvider } from './llamacpp.js';
import { defaultRecoveryConfig, type RecoveryConfig } from './llamacppRecovery.js';
import type { LlamacppLoadedState } from './llamacppManager.js';
import { ToolLoopDetector } from './ollamaTools.js';

// A llama.cpp Chat tab, or a plan-review turn in an agent tab, offers the
// model no tools. The XML fallback can still turn `<tool_call>` text in the
// reply into a call; dispatch must refuse it even with AUTO on.

type Call = { id: string; type: 'function'; function: { name: string; arguments: string } };
interface Dispatcher {
  abortController: AbortController | null;
  dispatchToolCalls(calls: Call[], autoMode: boolean, loop: ToolLoopDetector): Promise<Array<{ content: string }>>;
  streamOneTurn(baseUrl: string, model: string, messages: unknown[], tools: undefined, recovery: unknown): Promise<{ assistantMessage: { tool_calls?: Call[] } } | null>;
  runLoaded(prompt: string, def: LlamacppModelDef, loaded: LlamacppLoadedState, startedAt: number): Promise<void>;
  on(event: string, fn: (...args: unknown[]) => void): unknown;
}

function worker(cwd: string, extra: Partial<WorkerConfig>): Dispatcher {
  const w = LlamacppProvider.create('fixture', { cwd, skipPermissions: true, workflowId: 'fixture', ...extra } as WorkerConfig) as unknown as Dispatcher;
  w.on('error', () => {});
  return w;
}

const bash = (command: string): Call => ({ id: 'c1', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command }) } });

const cases: Array<[string, Partial<WorkerConfig>]> = [
  ['Chat tab', { interactionMode: 'chat', chatWebAccess: false }],
  ['plan-review turn', { interactionMode: 'chat', chatWebAccess: false, disableProviderHooks: true }],
];

for (const [label, extra] of cases) {
  test(`llama.cpp ${label}: a Bash call with AUTO on runs nothing`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'arco-llamacpp-chat-'));
    try {
      const out = await worker(dir, extra).dispatchToolCalls([bash('touch ran.txt')], true, new ToolLoopDetector());
      assert.equal(existsSync(join(dir, 'ran.txt')), false);
      assert.equal(out.length, 1);
      assert.match(out[0].content, /not enabled for this turn/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('llama.cpp Chat tab: an XML tool call in the reply is extracted and still refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arco-llamacpp-chat-'));
  const realFetch = globalThis.fetch;
  const text = '<tool_call><function=Bash><parameter=command>touch ran.txt</parameter></function></tool_call>';
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
  globalThis.fetch = (async () => new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch;
  try {
    const w = worker(dir, { interactionMode: 'chat', chatWebAccess: false });
    w.abortController = new AbortController();
    const turn = await w.streamOneTurn('http://127.0.0.1:9', 'fixture', [{ role: 'user', content: 'hi' }], undefined, defaultRecoveryConfig());
    const calls = turn?.assistantMessage.tool_calls ?? [];
    assert.equal(calls.length, 1, 'the XML fallback produced the call');
    const out = await w.dispatchToolCalls(calls, true, new ToolLoopDetector());
    assert.equal(existsSync(join(dir, 'ran.txt')), false);
    assert.match(out[0].content, /not enabled for this turn/);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('llama.cpp Chat and plan review refuse shell and file calls, and a plan review refuses web calls too', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arco-llamacpp-chat-'));
  const call = (name: string, args: Record<string, string>) => ({ id: 'c1', type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });
  const refused = async (label: string, extra: Partial<WorkerConfig>, name: string, args: Record<string, string>) => {
    const out = await worker(dir, extra).dispatchToolCalls([call(name, args)], true, new ToolLoopDetector());
    assert.equal(existsSync(join(dir, 'ran.txt')), false, label);
    assert.match(out[0].content, /not enabled for this turn/, `${label}: ${out[0].content}`);
  };
  const planReview = { interactionMode: 'chat' as const, chatWebAccess: false, disableProviderHooks: true };
  const armed = { interactionMode: 'chat' as const, chatWebAccess: true };
  try {
    for (const name of ['Bash', 'Read', 'WebFetch', 'WebSearch']) {
      const args: Record<string, string> = name === 'Bash' ? { command: 'touch ran.txt' } : name === 'Read' ? { file_path: join(dir, 'ran.txt') } : { url: 'http://127.0.0.1:9/fixture' };
      await refused(`plan review ${name}`, planReview, name, args);
      await refused(`disarmed chat ${name}`, { interactionMode: 'chat', chatWebAccess: false }, name, args);
    }
    await refused('armed chat Bash', armed, 'Bash', { command: 'touch ran.txt' });
    await refused('armed chat Read', armed, 'Read', { file_path: join(dir, 'ran.txt') });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('llama.cpp agent turn with AUTO still runs the call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arco-llamacpp-chat-'));
  try {
    await worker(dir, { interactionMode: 'agent' }).dispatchToolCalls([bash('touch ran.txt')], true, new ToolLoopDetector());
    assert.equal(existsSync(join(dir, 'ran.txt')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('llama.cpp bounds active and stalled streams with recovery off and retains the recovery limit when on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arco-llamacpp-deadline-'));
  const realFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const chunk = encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'working ' }, finish_reason: null }] })}\n\n`);
  const def = { alias: 'fixture', ggufPath: 'unused.gguf', ctxSize: 4096, ngl: 0, capabilities: { tools: false } } as LlamacppModelDef;
  const loaded = { alias: 'fixture', host: '127.0.0.1', port: 9, pid: 0, loadedAt: 0, lastUsedAt: 0 };
  const timers = new Set<ReturnType<typeof setInterval>>();
  const fallbacks = new Set<ReturnType<typeof setTimeout>>();
  try {
    for (const enabled of [false, true]) {
      for (const active of [true, false]) {
        let requests = 0, erasures = 0, cancelled = 0, guardMisses = 0;
        globalThis.fetch = (async (url: unknown) => {
          if (String(url).includes('/slots/')) { erasures++; return new Response('{}'); }
          requests++;
          let interval: ReturnType<typeof setInterval> | undefined;
          let fallback: ReturnType<typeof setTimeout>;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(chunk);
              if (active) {
                interval = setInterval(() => controller.enqueue(chunk), 5);
                timers.add(interval);
              }
              // A broken guard must fail the assertion, not hang the test.
              fallback = setTimeout(() => {
                guardMisses++;
                if (interval) { clearInterval(interval); timers.delete(interval); }
                fallbacks.delete(fallback);
                controller.close();
              }, 2000);
              fallbacks.add(fallback);
            },
            cancel() {
              cancelled++;
              if (interval) { clearInterval(interval); timers.delete(interval); }
              clearTimeout(fallback); fallbacks.delete(fallback);
            },
          });
          return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }) as typeof fetch;
        const w = worker(dir, { interactionMode: 'chat' });
        w.abortController = new AbortController();
        const errors: string[] = [], notices: string[] = [];
        w.on('error', value => errors.push(String(value)));
        w.on('system_notice', value => notices.push(String(value)));
        const read = w.streamOneTurn.bind(w);
        // Exercise the actual SSE parser and run loop with short fixture limits.
        w.streamOneTurn = (base, model, messages, tools, recovery) => {
          Object.assign(recovery as RecoveryConfig, {
            enabled, maxAutoRecoveries: 1,
            turnBudgetMs: active ? 100 : 1000, stallTimeoutMs: active ? 1000 : 100,
          });
          return read(base, model, messages, tools, recovery);
        };
        await w.runLoaded('fixture', def, loaded, Date.now());
        assert.equal(guardMisses, 0, 'the stream guard must finish before the fixture fallback');
        assert.equal(requests, enabled ? 3 : 1, 'one recovery and one final-summary attempt only when enabled');
        assert.equal(cancelled, requests, 'each interrupted stream is cancelled');
        assert.equal(erasures, enabled ? 2 : 1, 'free the slot without retrying when recovery is off');
        assert.equal(errors.length, 1, 'one terminal error');
        if (enabled) {
          assert.equal(notices.filter(line => line.startsWith('auto-recovery:')).length, 1);
          assert.equal(notices.filter(line => line.startsWith('auto-recovery exhausted')).length, 1);
          assert.match(errors[0], /after exhausting 1 auto-recoveries/);
        } else {
          assert.deepEqual(notices, []);
          assert.match(errors[0], /Automatic recovery is off; no retry was made\.$/);
          assert.match(errors[0], active ? /reply exceeded the 100ms time limit/ : /no stream data for 100ms/);
        }
      }
    }
  } finally {
    for (const timer of timers) clearInterval(timer);
    for (const timer of fallbacks) clearTimeout(timer);
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});
