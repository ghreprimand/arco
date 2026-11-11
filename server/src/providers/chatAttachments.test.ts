import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { zipSync, strToU8 } from 'fflate';
import * as XLSX from 'xlsx';
const home = await mkdtemp(join(tmpdir(), 'arco-chat-providers-'));
process.env.ARCO_HOME = home;
process.env.ARCO_UPLOADS_DIR = join(home, 'uploads');
test.after(async () => { await rm(home, { recursive: true, force: true }); });
const { OllamaProvider } = await import('./ollama.js');
const { LlamacppProvider } = await import('./llamacpp.js');
const { LmstudioProvider } = await import('./lmstudio.js');
const { StrataProvider } = await import('./strata.js');
const { DeepSeekProvider } = await import('./deepseek.js');
const { defaultRecoveryConfig } = await import('./llamacppRecovery.js');

async function fixtureSet(dir: string): Promise<string[]> {
  const text = join(dir, 'fixture.txt'), image = join(dir, 'fixture.png'), word = join(dir, 'fixture.docx'), sheet = join(dir, 'fixture.xlsx'), pdf = join(dir, 'fixture.pdf');
  await writeFile(text, 'fixture marker');
  await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'));
  await writeFile(word, zipSync({ 'word/document.xml': strToU8('<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>word fixture marker</w:t></w:r></w:p></w:body></w:document>') }));
  const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['sheet fixture marker']]), 'Sheet1');
  await writeFile(sheet, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  const document = await PDFDocument.create(), font = await document.embedFont(StandardFonts.Helvetica);
  document.addPage().drawText('pdf fixture marker', { font }); await writeFile(pdf, await document.save());
  return [text, image, word, sheet, pdf];
}

for (const [name, provider] of Object.entries({ ollama: OllamaProvider, llamacpp: LlamacppProvider, lmstudio: LmstudioProvider, strata: StrataProvider, deepseek: DeepSeekProvider })) {
  test(`${name} Chat delivers attachment content on its outbound request without paths`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'arco-chat-file-'));
    try {
      const files = await fixtureSet(dir); const path = files[0];
      const worker = provider.create('fixture', { provider: name, cwd: dir, workflowId: 'fixture', model: 'fixture', effort: 'medium', interactionMode: 'chat', attachments: files } as any) as any;
      worker.abortController = new AbortController(); worker.visionCapable = true; worker.on('error', () => {});
      const messages = name === 'llamacpp'
        ? await worker.buildMessages('Inspect', { capabilities: { vision: true }, mmprojPath: 'fixture' })
        : await worker.buildMessages('Inspect');
      let outbound = '';
      t.mock.method(globalThis, 'fetch', async (_url: unknown, opts: any) => {
        outbound = opts.body;
        return new Response(name === 'ollama'
          ? JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }) + '\n'
          : 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      });
      if (name === 'ollama') await worker.streamOneTurn('http://127.0.0.1:9', 'fixture', messages, undefined, false, {});
      else if (name === 'llamacpp') await worker.streamOneTurn('http://127.0.0.1:9', 'fixture', messages, undefined, defaultRecoveryConfig());
      else await worker.streamOneTurn('http://127.0.0.1:9', 'fixture', messages, undefined);
      for (const marker of ['fixture marker', 'word fixture marker', 'sheet fixture marker', 'pdf fixture marker']) assert.ok(outbound.includes(marker), marker);
      assert.ok(!outbound.includes(path));
    } finally { t.mock.restoreAll(); await rm(dir, { recursive: true, force: true }); }
  });
}

test('Claude CLI Chat sends attachment content on stdin without a path', async t => {
  const childProcess = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { ClaudeProvider } = await import('./claude.js');
  const dir = await mkdtemp(join(tmpdir(), 'arco-chat-cli-'));
  try {
    const files = await fixtureSet(dir); const path = files[0];
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    let input = ''; child.stdin.on('data', chunk => { input += String(chunk); });
    let launched!: () => void; const started = new Promise<void>(resolve => { launched = resolve; });
    t.mock.method(childProcess, 'spawn', (() => { launched(); return child; }) as any); syncBuiltinESMExports();
    const worker = ClaudeProvider.create('fixture', { provider: 'claude', cwd: dir, model: 'fixture', effort: 'medium', interactionMode: 'chat', attachments: files } as any);
    let failure = ''; worker.on('error', value => { failure = String(value); }); worker.spawn('Inspect');
    await Promise.race([started, new Promise<void>(resolve => setTimeout(resolve, 5000))]);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(input, `No stdin input: ${failure}`);
    for (const marker of ['fixture marker', 'word fixture marker', 'sheet fixture marker', 'pdf fixture marker']) assert.ok(input.includes(marker), marker); assert.ok(!input.includes(path));
    child.emit('close', 0, null); child.emit('exit', 0, null);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(dir, { recursive: true, force: true }); }
});

for (const name of ['codex', 'cursor'] as const) test(`${name} Chat sends attachment content on stdin without a path`, async t => {
  const childProcess = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const provider = name === 'codex' ? (await import('./codex.js')).CodexProvider : (await import('./cursor/print.js')).CursorPrintProvider;
  const dir = await mkdtemp(join(tmpdir(), 'arco-chat-cli-'));
  try {
    const files = await fixtureSet(dir); const path = files[0];
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    let input = ''; child.stdin.on('data', chunk => { input += String(chunk); });
    let launched!: () => void; const started = new Promise<void>(resolve => { launched = resolve; });
    t.mock.method(childProcess, 'spawn', (() => { launched(); return child; }) as any);
    t.mock.method(childProcess, 'execFile', ((_command: string, _args: string[], _options: unknown, callback: any) => { queueMicrotask(() => callback(Object.assign(new Error('probe'), { code: 1 }), '', "error: unknown option '--arco-chat-capability-probe'")); return child; }) as any);
    t.mock.method(childProcess, 'spawnSync', ((_cmd: string, args: string[]) => ({ status: 0, stdout: args.includes('--version') ? 'codex-cli 0.167.0' : args.includes('--help') ? '--ignore-user-config --ignore-rules --strict-config' : `shell_tool stable ${args.includes('-c') ? 'false' : 'true'}\nview_image stable ${args.includes('-c') ? 'false' : 'true'}` })) as any);
    syncBuiltinESMExports();
    const worker = provider.create('fixture', { provider: name, cwd: dir, workflowId: 'fixture', model: 'fixture', effort: 'medium', interactionMode: 'chat', codexHome: join(dir, 'codex'), attachments: files } as any);
    let failure = ''; worker.on('error', value => { failure = String(value); }); worker.spawn('Inspect');
    await Promise.race([started, new Promise<void>(resolve => setTimeout(resolve, 5000))]);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(input, `No stdin input: ${failure}`);
    for (const marker of ['fixture marker', 'word fixture marker', 'sheet fixture marker', 'pdf fixture marker']) assert.ok(input.includes(marker), marker); assert.ok(!input.includes(path));
    child.emit('close', 0, null); child.emit('exit', 0, null);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(dir, { recursive: true, force: true }); }
});

for (const [name, provider] of Object.entries({ ollama: OllamaProvider, llamacpp: LlamacppProvider, lmstudio: LmstudioProvider, strata: StrataProvider, deepseek: DeepSeekProvider })) {
  for (const present of [true, false]) test(`${name} Chat replay ${present ? 'restores upload content' : 'reports a missing upload'}`, async t => {
    const { mkdir } = await import('node:fs/promises');
    const { projectLocalFileReferences } = await import('../primitives/localFileContext.js');
    const { renderTranscript } = await import('../primitives/exportContext.js');
    const dir = await mkdtemp(join(tmpdir(), 'arco-chat-history-'));
    const path = join(home, 'uploads', `${name}-${present}.txt`);
    try {
      await mkdir(join(home, 'uploads'), { recursive: true });
      if (present) await writeFile(path, 'older fixture marker');
      const events: any[] = [
        { type: 'user_message_echo', workflowId: 'fixture', seq: 1, content: 'Earlier', attachments: [path] },
        { type: 'primary_text', workflowId: 'fixture', seq: 2, phase: 'passthrough', text: 'Earlier response' },
        { type: 'primary_complete', workflowId: 'fixture', seq: 3, phase: 'passthrough' },
      ];
      const worker = provider.create('fixture', { provider: name, cwd: dir, workflowId: 'fixture', model: 'fixture', effort: 'medium', interactionMode: 'chat', appendSystemPrompt: renderTranscript(events, { attachmentOnly: true }), priorFiles: projectLocalFileReferences(events, dir, true) } as any) as any;
      worker.abortController = new AbortController(); worker.visionCapable = true; worker.on('error', () => {});
      const messages = name === 'llamacpp' ? await worker.buildMessages('Continue', { capabilities: { vision: true }, mmprojPath: 'fixture' }) : await worker.buildMessages('Continue');
      let outbound = '';
      t.mock.method(globalThis, 'fetch', async (_url: unknown, opts: any) => {
        outbound = opts.body;
        return new Response(name === 'ollama' ? JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }) + '\n' : 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      });
      if (name === 'ollama') await worker.streamOneTurn('http://127.0.0.1:9', 'fixture', messages, undefined, false, {});
      else if (name === 'llamacpp') await worker.streamOneTurn('http://127.0.0.1:9', 'fixture', messages, undefined, defaultRecoveryConfig());
      else await worker.streamOneTurn('http://127.0.0.1:9', 'fixture', messages, undefined);
      if (present) assert.equal((outbound.match(/older fixture marker/g) ?? []).length, 1); else assert.match(outbound, /attach it again/i);
      assert.ok(!outbound.includes(path));
    } finally { t.mock.restoreAll(); await rm(dir, { recursive: true, force: true }); await rm(path, { force: true }); }
  });
}

for (const name of ['claude', 'codex', 'cursor'] as const) for (const present of [true, false]) for (const resumed of [false, true]) test(`${name} Chat ${resumed ? 'resumed' : 'new'} session ${present ? 'with present upload' : 'with missing upload'}`, async t => {
  const childProcess = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { mkdir } = await import('node:fs/promises');
  const provider = name === 'claude' ? (await import('./claude.js')).ClaudeProvider : name === 'codex' ? (await import('./codex.js')).CodexProvider : (await import('./cursor/print.js')).CursorPrintProvider;
  const dir = await mkdtemp(join(tmpdir(), 'arco-chat-cli-replay-'));
  const path = join(home, 'uploads', `${name}-${present}.txt`);
  try {
    await mkdir(join(home, 'uploads'), { recursive: true }); if (present) await writeFile(path, 'older fixture marker');
    const currentPath = join(dir, 'current.txt'); if (resumed) await writeFile(currentPath, 'current fixture marker');
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    let input = ''; child.stdin.on('data', chunk => { input += String(chunk); });
    let launched!: () => void; const started = new Promise<void>(resolve => { launched = resolve; });
    t.mock.method(childProcess, 'spawn', (() => { launched(); return child; }) as any);
    t.mock.method(childProcess, 'execFile', ((_command: string, _args: string[], _options: unknown, callback: any) => { queueMicrotask(() => callback(Object.assign(new Error('probe'), { code: 1 }), '', "error: unknown option '--arco-chat-capability-probe'")); return child; }) as any);
    t.mock.method(childProcess, 'spawnSync', ((_cmd: string, args: string[]) => ({ status: 0, stdout: args.includes('--version') ? 'codex-cli 0.167.0' : args.includes('--help') ? '--ignore-user-config --ignore-rules --strict-config' : `shell_tool stable ${args.includes('-c') ? 'false' : 'true'}\nview_image stable ${args.includes('-c') ? 'false' : 'true'}` })) as any);
    syncBuiltinESMExports();
    const worker = provider.create('fixture', { provider: name, cwd: dir, workflowId: 'fixture', model: 'fixture', effort: 'medium', interactionMode: 'chat', codexHome: join(dir, 'codex'), ...(resumed ? { resumeSessionId: 'fixture-thread', attachments: [currentPath] } : {}), priorFiles: [{ kind: 'source', path, name: 'prior.txt' }] } as any);
    worker.on('error', () => {}); worker.spawn('Continue'); await Promise.race([started, new Promise<void>(resolve => setTimeout(resolve, 5000))]); await new Promise(resolve => setImmediate(resolve));
    if (resumed) assert.match(input, /current fixture marker/);
    if (resumed && name !== 'cursor') { assert.doesNotMatch(input, /older fixture marker|attach it again/i); }
    else if (present) { assert.equal((input.match(/older fixture marker/g) ?? []).length, 1); }
    else assert.match(input, /attach it again/i);
    assert.ok(!input.includes(path)); child.emit('close', 0, null); child.emit('exit', 0, null);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await rm(dir, { recursive: true, force: true }); await rm(path, { force: true }); }
});

test('Chat replay refuses outside paths, symlinks and over-limit content', async () => {
  const { mkdir, symlink } = await import('node:fs/promises');
  const { prepareLocalFileContext } = await import('./localFileMedia.js');
  const outside = join(home, 'outside.txt'), uploads = join(home, 'uploads'), link = join(uploads, 'link.txt'), large = join(uploads, 'large.txt');
  await mkdir(uploads, { recursive: true }); await writeFile(outside, 'PRIVATE_FIXTURE'); await symlink(outside, link); await writeFile(large, 'x'.repeat(40_000));
  const refs = [outside, link, large].map(path => ({ kind: 'source' as const, path, name: 'fixture' }));
  const result = await prepareLocalFileContext({ cwd: home, workflowId: 'fixture', interactionMode: 'chat', priorFiles: refs } as any, true);
  assert.doesNotMatch(result.text, /PRIVATE_FIXTURE|x{100}/);
  assert.equal((result.text.match(/attach it again/g) ?? []).length, 3);
  assert.ok(!result.text.includes(home));
});

test('Agent attachment bytes and guidance are unchanged by the Chat option', async () => {
  const { prepareProviderAttachments } = await import('./providerFileContent.js');
  const dir = await mkdtemp(join(tmpdir(), 'arco-agent-attachment-'));
  try {
    const files = await fixtureSet(dir);
    const original = await prepareProviderAttachments(files, true, undefined, false);
    const explicitAgent = await prepareProviderAttachments(files, true, undefined, false, false);
    assert.deepEqual(explicitAgent, original);
    assert.ok(original.text.includes(dir)); assert.match(original.text, /pdf_mode=visual/);
    const chat = await prepareProviderAttachments(files, true, undefined, false, true);
    assert.ok(!chat.text.includes(dir)); assert.doesNotMatch(chat.text, /pdf_mode|read_file/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Chat replay keeps every attachment in a delivered queued batch', async () => {
  const { projectDeliveredInputs } = await import('../inputDeliveryHistory.js');
  const events = [
    { type: 'user_message_echo', seq: 1, content: 'first', clientMessageId: 'a', deliveryTracked: true, attachments: ['first.txt'] },
    { type: 'user_message_echo', seq: 2, content: 'second', clientMessageId: 'b', deliveryTracked: true, attachments: ['second.txt'] },
    { type: 'primary_turn_started', seq: 3, inputClientMessageIds: ['a', 'b'] },
  ];
  const projected = (projectDeliveredInputs as any)(events, events, undefined, true);
  assert.deepEqual(projected.find((event: any) => event.type === 'user_message_echo').attachments, ['first.txt', 'second.txt']);
});

test('Cursor Chat routes to stateless print while Agent uses the ACP session', async () => {
  const { createProviderProcess } = await import('./index.js');
  const { disposeCursorWorker } = await import('./cursor/index.js');
  const config = { provider: 'cursor', workflowId: 'cursor-routing-fixture', model: 'fixture', effort: 'medium', cwd: home } as any;
  try {
    const chat = createProviderProcess('chat', { ...config, interactionMode: 'chat', resumeSessionId: 'fixture-session' });
    const agent = createProviderProcess('agent', { ...config, interactionMode: 'agent', resumeSessionId: 'fixture-session' });
    assert.equal(chat.constructor.name, 'CursorPrintProcess');
    assert.equal(agent.constructor.name, 'CursorAcpTurn');
  } finally { disposeCursorWorker(config.workflowId); }
});
