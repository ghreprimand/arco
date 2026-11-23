import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dns from 'node:dns/promises';
import { installIsolatedTestHome } from '../testSupport/isolatedHome.js';
const home = await mkdtemp(join(tmpdir(), 'arco-url-tools-'));
installIsolatedTestHome(home);
test.after(() => rm(home, { recursive: true, force: true }));
const { registerFileTools } = await import('./fileMcpTools.js');
const { executeOllamaTool } = await import('../providers/ollamaTools.js');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

test('worker web proxy refuses non-public targets, mixed DNS results and disabled web access', async () => {
  const { isWorkerProxyPublicAddress, startWorkerWebProxy } = await import('../workers/workerWebProxy.js');
  const ip4 = (...octets: number[]) => octets.join('.');
  const loopback = ip4(127, 0, 0, 1);
  const publicAddress = ip4(8, 8, 8, 8);
  const mappedLoopback = ['', '', 'ffff', loopback].join(':');
  for (const ip of [loopback, ip4(10, 0, 0, 1), ip4(100, 64, 0, 1), ip4(169, 254, 1, 1), ip4(192, 0, 2, 1), ip4(198, 18, 0, 1), ip4(224, 0, 0, 1), ['', '', '1'].join(':'), mappedLoopback, ['2001', 'db8', '', '1'].join(':'), ['2002', '', '1'].join(':'), ['fe80', '', '1'].join(':')]) {
    assert.equal(isWorkerProxyPublicAddress(ip), false, ip);
  }
  for (const ip of [publicAddress, ['2606', '4700', '4700', '', '1111'].join(':')]) assert.equal(isWorkerProxyPublicAddress(ip), true, ip);
  let resolutions = 0;
  const proxy = await startWorkerWebProxy({ parentDir: home, webAccess: true, providerHosts: [], lookup: async () => {
    resolutions++; return [{ address: publicAddress, family: 4 }, { address: loopback, family: 4 }];
  } });
  async function ask(socketPath: string, request: string): Promise<string> {
    return await new Promise((resolve, reject) => {
      const socket = createConnection(socketPath); let data = '';
      socket.setTimeout(3000, () => socket.destroy(new Error('proxy request timed out')));
      socket.on('connect', () => socket.write(request)); socket.on('data', chunk => { data += chunk.toString(); });
      socket.once('end', () => resolve(data)); socket.once('error', reject);
    });
  }
  let closedProxy = false;
  try {
    assert.equal((await stat(proxy.socketPath)).mode & 0o777, 0o600);
    for (const authority of [`${loopback}:443`, `[${mappedLoopback}]:443`, 'example.com:443']) {
      assert.match(await ask(proxy.socketPath, `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 403/);
    }
    assert.equal(resolutions, 1, 'literal IP addresses do not need DNS');
    assert.match(await ask(proxy.socketPath, `GET http://${loopback}/ HTTP/1.1\r\nHost: ${loopback}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 403/);
    const hanging = createConnection(proxy.socketPath);
    await new Promise<void>((resolve, reject) => { hanging.once('connect', resolve); hanging.once('error', reject); });
    const disconnected = new Promise<void>((resolve) => hanging.once('close', () => resolve()));
    await proxy.close(); closedProxy = true;
    await disconnected;
    await assert.rejects(stat(proxy.socketPath));
  } finally { if (!closedProxy) await proxy.close(); }
  const offOptions = { parentDir: home, webAccess: false, providerHosts: ['provider.example'], lookup: async () => { throw new Error('web-off must reject before DNS'); } };
  const off = await startWorkerWebProxy(offOptions);
  offOptions.webAccess = true;
  try { assert.match(await ask(off.socketPath, 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 403/); }
  finally { await off.close(); }
});

test('worker web proxy keeps an established tunnel through silence longer than the handshake limit', async () => {
  const { startWorkerWebProxy } = await import('../workers/workerWebProxy.js');
  const { createServer } = await import('node:net');
  // A model stream: one chunk, a silence longer than the handshake limit, then the rest.
  const upstream = createServer((socket) => { socket.on('error', () => {}); socket.write('first'); setTimeout(() => socket.end('second'), 800); });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  const port = (upstream.address() as { port: number }).port;
  const proxy = await startWorkerWebProxy({ parentDir: home, webAccess: true, providerHosts: [], lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    dial: () => createConnection({ host: '127.0.0.1', port }), timeouts: { handshakeMs: 300, streamIdleMs: 5000 } });
  try {
    const received = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(proxy.socketPath); let data = '';
      socket.on('connect', () => socket.write('CONNECT model.example:443 HTTP/1.1\r\nHost: model.example:443\r\n\r\n'));
      socket.on('data', (chunk) => { data += chunk.toString(); });
      socket.once('close', () => resolve(data)); socket.once('error', reject);
    });
    assert.match(received, /^HTTP\/1\.1 200/);
    assert.ok(received.endsWith('firstsecond'), received);
  } finally { await proxy.close(); upstream.close(); }
});

test('portable file server exposes guarded URL media to every CLI transport', async (t) => {
  const handlers = new Map<string, (args: any) => Promise<any>>();
  registerFileTools({ registerTool: (name: string, _schema: unknown, callback: any) => handlers.set(name, callback) } as any, home);
  assert.ok(handlers.has('fetch_file'), 'the portable reader needs a URL tool');
  t.mock.method(dns, 'lookup', async () => [{ address: '203.0.113.1', family: 4 }] as any);
  t.mock.method(globalThis, 'fetch', async () => new Response(Uint8Array.from(png), { headers: { 'content-type': 'image/png' } }));
  const result = await handlers.get('fetch_file')!({ url: 'https://example.com/figure.png' });
  assert.equal(result.isError, false);
  assert.ok(result.content.some((block: any) => block.type === 'image'));
  assert.ok(result.content.some((block: any) => block.type === 'text' && block.text.includes('figure.png')));
});

test('WebFetch refuses a redirect into a private service before requesting it', async (t) => {
  const urls: string[] = [];
  t.mock.method(dns, 'lookup', async () => [{ address: '203.0.113.1', family: 4 }] as any);
  t.mock.method(globalThis, 'fetch', async (url: any) => {
    urls.push(String(url));
    return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  });
  const result = await executeOllamaTool('WebFetch', { url: 'https://example.com/redirect', mode: 'fast' }, { cwd: home });
  assert.match(result, /private|loopback/i);
  assert.deepEqual(urls, ['https://example.com/redirect']);
});


const { fetchFileContent } = await import('../fileFetch.js');
const { PDFDocument, StandardFonts } = await import('pdf-lib');
async function pdf(scanned = false) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const label of ['First URL page', 'Second URL page']) {
    const page = doc.addPage([200, 200]);
    if (!scanned) page.drawText(label, { x: 10, y: 100, size: 10, font });
  }
  return Uint8Array.from(await doc.save());
}
function portableTools() {
  const handlers = new Map<string, (args: any) => Promise<any>>();
  registerFileTools({ registerTool: (name: string, _schema: unknown, handler: any) => handlers.set(name, handler) } as any, home);
  return handlers;
}
test('URL PDFs provide selected document blocks or text and scanned-page images', async (t) => {
  let bytes = await pdf();
  t.mock.method(dns, 'lookup', async () => [{ address: '203.0.113.1', family: 4 }] as any);
  t.mock.method(globalThis, 'fetch', async () => new Response(bytes, { headers: { 'content-type': 'application/pdf' } }));
  const native = await fetchFileContent('https://example.com/paper.pdf', { pages: '2', limits: { documents: true, images: true } });
  assert.equal(native.isError, false, native.text);
  assert.ok(native.blocks.some(block => block.type === 'document' && block.pages === 1));
  assert.match(native.text, /Second URL page/);
  assert.doesNotMatch(native.text, /First URL page/);
  const documents: any[] = [];
  const local = await executeOllamaTool('WebFetch', { url: 'https://example.com/paper.pdf', mode: 'fast', pages: '2' }, { cwd: home, onFileContent: result => documents.push(result) });
  assert.equal(documents.length, 1, 'decoded URL documents must reach the replay snapshot collector');
  assert.match(documents[0].text, /Second URL page/);
  assert.match(local, /Second URL page/); assert.doesNotMatch(local, /First URL page/);
  const tool = portableTools().get('fetch_file')!;
  const cli = await tool({ url: 'https://example.com/paper.pdf', pages: '2' });
  const text = cli.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n');
  assert.match(text, /Second URL page/); assert.doesNotMatch(text, /First URL page/);
  bytes = await pdf(true);
  const images: any[] = [];
  const scan = await executeOllamaTool('WebFetch', { url: 'https://example.com/scan.pdf', mode: 'fast', pages: '1' }, { cwd: home, onImages: blocks => images.push(...blocks) });
  assert.match(scan, /No extractable text/); assert.equal(images.length, 1);
  const scannedCli = await tool({ url: 'https://example.com/scan.pdf', pages: '2' });
  assert.equal(scannedCli.content.filter((block: any) => block.type === 'image').length, 1);
});

test('URL policy covers literal and resolved private addresses, IPv4-mapped IPv6 and redirect loops', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('', { status: 302, headers: { location: '/again' } }); });
  t.mock.method(dns, 'lookup', async () => [{ address: '127.0.0.1', family: 4 }] as any);
  for (const url of ['file:///fixture', 'http://localhost/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://100.65.1.2/', 'http://[fec0::1]/', 'https://example.com/']) {
    const result = await fetchFileContent(url);
    assert.equal(result.isError, true, url); assert.equal(result.refused, true, url);
  }
  assert.equal(calls, 0);
  t.mock.method(dns, 'lookup', async () => [{ address: '203.0.113.1', family: 4 }] as any);
  const loop = await fetchFileContent('https://example.com/again');
  assert.equal(loop.refused, true); assert.match(loop.text, /Redirect limit/); assert.equal(calls, 6);
});

test('URL decoding cancels streams at the source budget', async (t) => {
  let cancelled = false;
  t.mock.method(dns, 'lookup', async () => [{ address: '203.0.113.1', family: 4 }] as any);
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Uint8Array.from(png)); }, cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'image/png' } }));
  const result = await fetchFileContent('https://example.com/large.png', { maxBytes: 32 });
  assert.equal(result.refused, true); assert.equal(cancelled, true);
});

test('URL deadline releases a stalled response reader and never makes a later request', async (t) => {
  let cancelled = false, calls = 0;
  t.mock.method(dns, 'lookup', async () => [{ address: '203.0.113.1', family: 4 }] as any);
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(new ReadableStream({ cancel() { cancelled = true; } })); });
  const result = await fetchFileContent('https://example.com/stalled', { timeoutMs: 20 });
  assert.equal(result.isError, true);
  assert.equal(cancelled, true);
  assert.equal(calls, 1);
});


test('all five local adapters carry fetched PDF text and scanned pages into their tool results', async (t) => {
  let bytes = await pdf();
  t.mock.method(dns, 'lookup', async () => [{ address: '203.0.113.1', family: 4 }] as any);
  t.mock.method(globalThis, 'fetch', async () => new Response(bytes, { headers: { 'content-type': 'application/pdf' } }));
  const { OllamaProvider } = await import('../providers/ollama.js');
  const { LlamacppProvider } = await import('../providers/llamacpp.js');
  const { LmstudioProvider } = await import('../providers/lmstudio.js');
  const { StrataProvider } = await import('../providers/strata.js');
  const { DeepSeekProvider } = await import('../providers/deepseek.js');
  const { ToolLoopDetector } = await import('../providers/ollamaTools.js');
  for (const [kind, provider] of Object.entries({ ollama: OllamaProvider, llama: LlamacppProvider, lmstudio: LmstudioProvider, strata: StrataProvider, deepseek: DeepSeekProvider })) {
    const worker = provider.create('fixture', { cwd: home, interactionMode: 'agent' } as any) as any;
    worker.advertisedTools = new Set(['WebFetch']);
    const calls = () => [{ id: 'url-read', function: { name: 'WebFetch', arguments: kind === 'ollama' ? { url: 'https://example.com/paper.pdf', mode: 'fast', pages: '2' } : JSON.stringify({ url: 'https://example.com/paper.pdf', mode: 'fast', pages: '2' }) } }];
    bytes = await pdf();
    const text = await worker.dispatchToolCalls(calls(), true, new ToolLoopDetector());
    assert.match(text[0].content, /Second URL page/, kind); assert.doesNotMatch(text[0].content, /First URL page/, kind);
    bytes = await pdf(true);
    const scan = await worker.dispatchToolCalls(calls(), true, new ToolLoopDetector());
    assert.equal(scan[1]?.role, 'user', kind);
    if (kind === 'ollama') assert.equal(scan[1].images.length, 1, kind);
    else assert.equal(scan[1].content.filter((part: any) => part.type === 'image_url').length, 1, kind);
  }
});


test('real portable MCP stdio server lists and returns fetched images and PDF pages', async () => {
  const { connectServer } = await import('./client.js');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const fixture = join(home, 'URL preload #fixture.mjs');
  await writeFile(fixture, `import ${JSON.stringify(new URL('./fixtures/urlFetchNetwork.ts', import.meta.url).href)};`);
  const entry = fileURLToPath(new URL('./fileMcpServer.ts', import.meta.url));
  const session = await connectServer({ id: 'fixture', name: 'fixture', enabled: true, createdAt: 0, command: process.execPath, args: ['--conditions', 'development', '--import', 'tsx', '--import', pathToFileURL(fixture).href, entry, home], env: {} });
  try {
    if (session.isClosed()) assert.fail((await session.callTool('fetch_file', {})).text);
    assert.ok(session.listTools().some(tool => tool.name === 'fetch_file' && tool.annotations?.readOnlyHint));
    const image = await session.callTool('fetch_file', { url: 'https://example.com/figure.png' });
    assert.equal(image.isError, false, image.text);
    assert.equal(image.blocks?.filter(block => block.type === 'image').length, 1);
    const document = await session.callTool('fetch_file', { url: 'https://example.com/paper.pdf', pages: '2' });
    assert.match(document.text, /Second URL page/); assert.doesNotMatch(document.text, /First URL page/);
    const scan = await session.callTool('fetch_file', { url: 'https://example.com/scan.pdf', pages: '1' });
    assert.equal(scan.blocks?.filter(block => block.type === 'image').length, 1);
  } finally { session.close(); }
});


test('URL source buffers are bounded before decoder admission', async (t) => {
  let requests = 0, release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(dns, 'lookup', async () => [{ address: '203.0.113.1', family: 4 }] as any);
  t.mock.method(globalThis, 'fetch', async () => { requests++; await ready; return new Response('fixture'); });
  const pending = Array.from({ length: 8 }, (_, index) => fetchFileContent(`https://example.com/file-${index}`));
  try {
    for (let tick = 0; tick < 200 && requests < 2; tick++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(requests > 0 && requests <= 2, `started ${requests} downloads before bounded decoding`);
  } finally { release(); await Promise.all(pending); }
});


test('a cancelled DNS lookup releases URL admission for the next request', async (t) => {
  let lookups = 0, requests = 0;
  t.mock.method(dns, 'lookup', async () => ++lookups <= 2 ? new Promise(() => {}) : [{ address: '203.0.113.1', family: 4 }] as any);
  t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response(Uint8Array.from(png), { headers: { 'content-type': 'image/png' } }); });
  await Promise.all([1, 2].map(index => fetchFileContent(`https://example.com/stalled-${index}`, { timeoutMs: 20 })));
  const next = await fetchFileContent('https://example.com/next', { timeoutMs: 3000 });
  assert.equal(next.isError, false, next.text);
  assert.equal(requests, 1);
});
