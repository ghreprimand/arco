// Isolate provider binaries, credentials and HTTP; no inference or live data.
import os from 'node:os';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
os.homedir = () => process.env.ARCO_INTERRUPT_HOME;
const originalSpawn = cp.spawn;
cp.spawn = (command, args, options) => originalSpawn(
  command === 'claude' || command === 'codex' ? join(process.env.ARCO_INTERRUPT_BIN, command) : command, args, options);
syncBuiltinESMExports();
const record = (event, prompt = '') => appendFileSync(process.env.ARCO_INTERRUPT_JOURNAL, JSON.stringify({ event, prompt, native: true }) + '\n');
let active = false;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url ?? String(input);
  if (!url.includes('api.anthropic.com/v1/messages')) return new Response('{}', { status: 503 });
  const body = JSON.parse(init?.body ?? await input.text());
  if (url.includes('count_tokens')) return Response.json({ input_tokens: 100 });
  if (active) throw new Error('Concurrent Native requests!');
  active = true;
  const prompt = JSON.stringify(body.messages.at(-1).content);
  record('start', prompt);
  const marker = prompt.includes('HOLD') ? 'HOLD' : prompt.includes('CORRECTION') ? 'CORRECTION' : 'FOLLOW';
  const signal = init?.signal ?? input.signal;
  let timer;
  const stream = new ReadableStream({ start(controller) {
    const send = (type, rest) => controller.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`));
    send('message_start', { message: { id: 'fixture', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `READY ${marker}` } });
    signal.addEventListener('abort', () => {
      clearTimeout(timer); active = false; record('interrupted');
      try { controller.error(new DOMException('Aborted', 'AbortError')); } catch {}
    }, { once: true });
    if (marker !== 'HOLD') timer = setTimeout(() => {
      active = false; record('completed');
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
      send('message_stop', {}); controller.close();
    }, 400);
  } });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
};
