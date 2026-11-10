import dns from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { fileContentFromBytes, fileHeaderKind, MAX_FILE_CONTENT_BYTES, type FileContentOptions, type FileContentResult } from './fileContent.js';
import { requestWithDeadline } from './providers/requestDeadline.js';

export type FetchFileContentOptions = FileContentOptions & { timeoutMs?: number; maxBytes?: number };
export type FetchFileContentResult = FileContentResult & {
  url: string;
  status?: number;
  contentType?: string;
  /** A policy or source-size refusal must never trigger a browser retry. */
  refused?: boolean;
};
// Admit before downloading so callers cannot queue large source buffers behind
// the decoder's own two-worker limit. The request deadline includes this wait.
let activeFetches = 0;
interface FetchWaiter { resolve: () => void; reject: (error: unknown) => void; signal: AbortSignal; abort: () => void }
const fetchWaiters: FetchWaiter[] = [];
async function withFetchSlot<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  if (activeFetches < 2) activeFetches++;
  else await new Promise<void>((resolve, reject) => {
    const waiter: FetchWaiter = { resolve, reject, signal, abort: () => {
      const index = fetchWaiters.indexOf(waiter);
      if (index >= 0) fetchWaiters.splice(index, 1);
      reject(signal.reason);
    } };
    fetchWaiters.push(waiter);
    signal.addEventListener('abort', waiter.abort, { once: true });
    if (signal.aborted) waiter.abort();
  });
  let onAbort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    const pending = Promise.resolve().then(() => { signal.throwIfAborted(); return run(); });
    return await Promise.race([pending, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
    let transferred = false;
    while (fetchWaiters.length) {
      const waiter = fetchWaiters.shift()!;
      waiter.signal.removeEventListener('abort', waiter.abort);
      if (waiter.signal.aborted) { waiter.reject(waiter.signal.reason); continue; }
      waiter.resolve(); transferred = true; break;
    }
    if (!transferred) activeFetches--;
  }
}
const blocked = new BlockList();
// IPv4 policy prefixes are represented as leading octets and prefix lengths.
for (const [first, second, prefix] of [[0, 0, 8], [10, 0, 8], [100, 64, 10], [127, 0, 8], [169, 254, 16], [172, 16, 12], [192, 168, 16]] as const) {
  blocked.addSubnet([first, second, 0, 0].join('.'), prefix, 'ipv4');
}
blocked.addAddress('::', 'ipv6');
blocked.addAddress('::1', 'ipv6');
blocked.addSubnet('fc00::', 7, 'ipv6');
blocked.addSubnet('fe80::', 10, 'ipv6');
blocked.addSubnet('fec0::', 10, 'ipv6');

export function isPrivateFetchHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  const family = isIP(name);
  return family !== 0 && blocked.check(name, family === 4 ? 'ipv4' : 'ipv6');
}
class RefusedFetch extends Error {}

/** Revalidate each redirect before issuing another request. */
async function authorize(url: URL, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new RefusedFetch(`Only http(s) URLs are supported; got ${url.protocol}`);
  if (isPrivateFetchHost(url.hostname)) throw new RefusedFetch('The URL targets a loopback, private or link-local host.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!isIP(host)) {
    const records = await dns.lookup(host, { all: true });
    signal.throwIfAborted();
    if (!records.length) throw new RefusedFetch('The URL host has no resolved addresses.');
    if (records.some(record => isPrivateFetchHost(record.address))) throw new RefusedFetch('The URL resolves to a loopback, private or link-local address.');
  }
}
/** The browser fallback uses the same initial URL policy and bounded DNS check. */
export async function assertPublicFileFetchUrl(url: string, signal?: AbortSignal): Promise<void> {
  await requestWithDeadline(signal, 10_000, checkSignal => authorize(new URL(url), checkSignal));
}

function failure(url: string, error: unknown, refused = false): FetchFileContentResult {
  const text = `[error] URL fetch: ${error instanceof Error ? error.message : String(error)}`;
  return { url, text, blocks: [{ type: 'text', text }], kind: 'error', truncated: false, isError: true, ...(refused ? { refused: true } : {}) };
}
function fileMime(type: string): boolean {
  return /image\/|application\/(pdf|msword|vnd\.|zip)|(?:text|application)\/rtf/i.test(type);
}
async function responseBytes(response: Response, maxBytes: number, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: Buffer.alloc(0), truncated: false, fileLike: false };
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  const parts: Buffer[] = [];
  let used = 0, done = false, fileLike = fileMime(response.headers.get('content-type') ?? '');
  try {
    for (;;) {
      signal.throwIfAborted();
      const cap = fileLike ? maxBytes : Math.min(maxBytes, 128 * 1024);
      if (used >= cap) break;
      const next = await reader.read();
      if (next.done) { done = true; break; }
      if (!fileLike && used < 4096) {
        const prefix = Buffer.concat([...parts, Buffer.from(next.value.subarray(0, 4096 - used))], Math.min(4096, used + next.value.byteLength));
        const kind = fileHeaderKind(prefix);
        fileLike = kind.startsWith('image/') || ['application/pdf', 'application/zip', 'application/x-ole-storage', 'application/rtf'].includes(kind);
      }
      const keep = Math.min(next.value.byteLength, (fileLike ? maxBytes : Math.min(maxBytes, 128 * 1024)) - used);
      parts.push(Buffer.from(next.value.subarray(0, keep)));
      used += keep;
    }
    return { bytes: Buffer.concat(parts, used), truncated: !done, fileLike };
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Public URL reader. Callers choose provider media limits; no local file access. */
export async function fetchFileContent(url: string, options: FetchFileContentOptions = {}): Promise<FetchFileContentResult> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return failure(url, new Error('Invalid URL.'), true); }
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs! > 0 ? Math.min(options.timeoutMs!, 120_000) : 10_000;
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes! > 0 ? Math.min(Math.floor(options.maxBytes!), MAX_FILE_CONTENT_BYTES) : MAX_FILE_CONTENT_BYTES;
  try {
    return await requestWithDeadline(options.signal, timeoutMs, async signal => withFetchSlot(signal, async () => {
      let current = parsed;
      for (let redirects = 0; ; redirects++) {
        await authorize(current, signal);
        const response = await fetch(current.toString(), {
          signal, redirect: 'manual', headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
          },
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel().catch(() => {});
          if (!location) throw new RefusedFetch('Redirect has no Location header.');
          if (redirects >= 5) throw new RefusedFetch('Redirect limit exceeded.');
          current = new URL(location, current);
          continue;
        }
        const contentType = response.headers.get('content-type') ?? '';
        const body = await responseBytes(response, maxBytes, signal);
        if (body.fileLike && body.truncated) return failure(current.toString(), new RefusedFetch('File response exceeds the decoding byte budget; request a smaller file.'), true);
        const result = await fileContentFromBytes(body.bytes, current.pathname.split('/').pop() || 'response', { ...options, signal });
        if (body.truncated) {
          result.text += '\n[truncated response at byte budget]';
          result.blocks.push({ type: 'text', text: '[truncated response at byte budget]' });
        }
        return { ...result, truncated: result.truncated || body.truncated, isError: result.isError || !response.ok, url: current.toString(), status: response.status, contentType };
      }
    }));
  } catch (error) { return failure(parsed.toString(), error, error instanceof RefusedFetch); }
}
