import { lookup as lookupDns } from 'node:dns/promises';
import { createServer, request as httpRequest } from 'node:http';
import { BlockList, connect, isIP, type Socket } from 'node:net';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

const denied = new BlockList();
// Special-purpose IPv4 ranges, represented as octets and prefix lengths.
for (const [first, second, third, bits] of [
  [0, 0, 0, 8], [10, 0, 0, 8], [100, 64, 0, 10], [127, 0, 0, 8],
  [169, 254, 0, 16], [172, 16, 0, 12], [192, 0, 0, 24], [192, 0, 2, 24],
  [192, 88, 99, 24], [192, 168, 0, 16], [198, 18, 0, 15], [198, 51, 100, 24],
  [203, 0, 113, 24], [224, 0, 0, 4], [240, 0, 0, 4],
] as const) denied.addSubnet([first, second, third, 0].join('.'), bits, 'ipv4');
for (const [parts, bits] of [[['2001', '', ''], 23], [['2001', 'db8', '', ''], 32], [['2002', '', ''], 16], [['3fff', '', ''], 20]] as const) {
  denied.addSubnet(parts.join(':'), bits, 'ipv6');
}
const globalIpv6 = new BlockList();
globalIpv6.addSubnet(['2000', '', ''].join(':'), 3, 'ipv6');

/** Conservative public-address policy; unrecognized and transition addresses are refused. */
export function isWorkerProxyPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !denied.check(address, 'ipv4');
  if (family === 6) return globalIpv6.check(address, 'ipv6') && !denied.check(address, 'ipv6');
  return false;
}

type Address = { address: string; family: number };
type Lookup = (name: string) => Promise<Address[]>;
const defaultLookup: Lookup = async (name) => lookupDns(name, { all: true });
const MAX_CONNECTIONS = 32;
// One plain-HTTP request or response body.
const MAX_BYTES = 64 * 1024 * 1024;
// Each direction of one CONNECT tunnel over its whole life. A provider keeps
// one TLS connection open for a long session and sends its full context with
// every request, so this bounds a runaway transfer without ending sessions.
const MAX_TUNNEL_BYTES = 1024 * 1024 * 1024;
// Until a request is read and its upstream connection is made.
const HANDSHAKE_TIMEOUT_MS = 30_000;
// Silence allowed on an established tunnel or a streamed response: a model can
// think for minutes between streamed chunks.
const STREAM_IDLE_TIMEOUT_MS = 10 * 60_000;
const HOP_HEADERS = new Set(['connection', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

interface Target { hostname: string; port: number }

function targetFromAuthority(authority: string): Target {
  const url = new URL(`http://${authority}`);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.hostname) throw new Error('Invalid target.');
  const port = url.port ? Number(url.port) : 80;
  if (port !== 80 && port !== 443) throw new Error('Port is not permitted.');
  return { hostname: url.hostname.replace(/^\[|\]$/g, '').toLowerCase(), port };
}

/** An entry starting with a dot allows every subdomain of that domain, not the domain itself. */
export function workerProviderHostAllowed(providerHosts: ReadonlySet<string>, hostname: string): boolean {
  if (providerHosts.has(hostname)) return true;
  for (const entry of providerHosts) {
    if (entry.startsWith('.') && entry.length > 1 && hostname.length > entry.length && hostname.endsWith(entry)) return true;
  }
  return false;
}

async function resolveTarget(target: Target, webAccess: boolean, providerHosts: ReadonlySet<string>, lookup: Lookup): Promise<Address> {
  if (!webAccess && !workerProviderHostAllowed(providerHosts, target.hostname)) throw new Error('Web access is disabled.');
  const family = isIP(target.hostname);
  const addresses = family ? [{ address: target.hostname, family }] : await new Promise<Address[]>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DNS timeout.')), 5000);
    timer.unref();
    lookup(target.hostname).then((answer) => { clearTimeout(timer); resolve(answer); }, (error) => { clearTimeout(timer); reject(error); });
  });
  const local = new BlockList();
  for (const entry of Object.values(networkInterfaces()).flat()) {
    if (!entry) continue;
    const family = isIP(entry.address);
    if (family) local.addAddress(entry.address, family === 4 ? 'ipv4' : 'ipv6');
  }
  if (!addresses.length || addresses.some((entry) => !isWorkerProxyPublicAddress(entry.address) || isIP(entry.address) !== entry.family
    || local.check(entry.address, entry.family === 4 ? 'ipv4' : 'ipv6'))) {
    throw new Error('Address is not public.');
  }
  return addresses[0];
}

/** Start a private per-worker HTTP proxy. The socket alone is exposed inside the sandbox. */
export async function startWorkerWebProxy(options: {
  parentDir: string;
  webAccess: boolean;
  providerHosts: readonly string[];
  /** Allows deterministic DNS policy tests; production uses the system resolver. */
  lookup?: Lookup;
  /** Tests only: where the checked address is dialled, and shorter time limits. */
  dial?: (address: Address, port: number) => Socket;
  timeouts?: { handshakeMs?: number; streamIdleMs?: number };
}): Promise<{ socketPath: string; close: () => Promise<void> }> {
  const allowed = new Set(options.providerHosts.map((host) => host.toLowerCase()));
  const webAccess = options.webAccess === true;
  const lookup = options.lookup ?? defaultLookup;
  const dial = options.dial ?? ((address: Address, port: number) => connect({ host: address.address, family: address.family, port }));
  const handshakeMs = options.timeouts?.handshakeMs ?? HANDSHAKE_TIMEOUT_MS;
  const streamIdleMs = options.timeouts?.streamIdleMs ?? STREAM_IDLE_TIMEOUT_MS;
  const directory = await mkdtemp(join(options.parentDir, 'worker-proxy-'));
  const socketPath = join(directory, 'web.sock');
  const active = new Set<Socket>();
  const outbound = new Set<Socket>();
  const server = createServer({ maxHeaderSize: 8192 });
  server.maxConnections = MAX_CONNECTIONS;
  server.headersTimeout = 10_000;
  server.requestTimeout = handshakeMs;
  server.on('connection', (socket) => {
    active.add(socket); socket.setTimeout(handshakeMs, () => socket.destroy());
    socket.once('close', () => active.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());

  function trackOutbound(socket: Socket): void {
    outbound.add(socket);
    socket.once('close', () => outbound.delete(socket));
  }

  function limitedPipe(source: Readable, destination: Writable, limit: number): void {
    let bytes = 0;
    source.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > limit) { source.destroy(); destination.destroy(); } });
    source.on('error', () => destination.destroy());
    destination.on('error', () => source.destroy());
    source.pipe(destination);
  }

  server.on('connect', (req, client, head) => {
    void (async () => {
      const target = targetFromAuthority(req.url ?? '');
      const address = await resolveTarget(target, webAccess, allowed, lookup);
      if (client.destroyed) return;
      const upstream = dial(address, target.port);
      trackOutbound(upstream);
      upstream.setTimeout(handshakeMs, () => upstream.destroy());
      upstream.once('error', () => client.destroy());
      client.once('close', () => upstream.destroy());
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        // Established: only long silence ends the tunnel.
        upstream.setTimeout(streamIdleMs); req.socket.setTimeout(streamIdleMs);
        limitedPipe(client, upstream, MAX_TUNNEL_BYTES); limitedPipe(upstream, client, MAX_TUNNEL_BYTES);
      });
    })().catch(() => { if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  });

  server.on('request', (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '');
      if (url.protocol !== 'http:' || url.username || url.password || url.hash) throw new Error('Invalid URL.');
      const target = targetFromAuthority(url.host);
      if (target.port !== 80) throw new Error('Port is not permitted.');
      const address = await resolveTarget(target, webAccess, allowed, lookup);
      if (res.destroyed) return;
      const nominated = String(req.headers.connection ?? '').toLowerCase().split(',').map((v) => v.trim());
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !HOP_HEADERS.has(name) && !nominated.includes(name)));
      headers.host = url.host;
      const upstream = httpRequest({ host: address.address, family: address.family, port: target.port, path: url.pathname + url.search, method: req.method, headers, timeout: handshakeMs, agent: false });
      upstream.once('socket', trackOutbound);
      upstream.once('timeout', () => upstream.destroy());
      upstream.once('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.once('close', () => upstream.destroy());
      upstream.once('response', (response) => {
        const responseNominated = String(response.headers.connection ?? '').toLowerCase().split(',').map((v) => v.trim());
        const clean = Object.fromEntries(Object.entries(response.headers).filter(([name]) => !HOP_HEADERS.has(name) && !responseNominated.includes(name)));
        // Streaming: only long silence ends the response.
        upstream.setTimeout(streamIdleMs); req.socket.setTimeout(streamIdleMs);
        res.writeHead(response.statusCode ?? 502, clean); limitedPipe(response, res, MAX_BYTES);
      });
      let bytes = 0;
      req.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_BYTES) { req.destroy(); upstream.destroy(); } });
      req.once('aborted', () => upstream.destroy());
      req.pipe(upstream);
    })().catch(() => { if (!res.headersSent) res.writeHead(403); res.end(); });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
  } catch (error) { server.close(); await rm(directory, { recursive: true, force: true }); throw error; }
  return {
    socketPath,
    close: async () => {
      for (const socket of active) socket.destroy();
      for (const socket of outbound) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
