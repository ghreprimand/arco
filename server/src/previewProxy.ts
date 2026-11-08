// Preview listeners have their own authority and never expose operator routes.
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { activePreviewPorts } from './previewPorts.js';

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const reservedCookie = (value: string) => /^\s*(?:__Host-|__Secure-)?arco_/i.test(value);
const safeCookies = (value: string) => value.split(';').filter(part => !reservedCookie(part)).join(';');
// Cookies and host policies outlive a port lease and may affect other ports.
const SITE_HEADERS = new Set(['clear-site-data', 'strict-transport-security', 'public-key-pins', 'public-key-pins-report-only', 'alt-svc', 'report-to', 'reporting-endpoints', 'nel']);
const safeSetCookies = (values: string[] | undefined) => values?.filter(value => !reservedCookie(value) && !/;\s*domain\s*=/i.test(value));
function responseHeaders(source: http.IncomingHttpHeaders, upgrade: boolean) {
  const headers = { ...source };
  for (const key of Object.keys(headers)) if (SITE_HEADERS.has(key) || (!upgrade && HOP.has(key))) delete headers[key];
  headers['set-cookie'] = safeSetCookies(source['set-cookie']);
  if (!headers['set-cookie']?.length) delete headers['set-cookie'];
  headers['cache-control'] = 'no-store'; headers['referrer-policy'] = 'same-origin';
  delete headers.etag;
  delete headers['access-control-allow-origin']; delete headers['access-control-allow-credentials'];
  return headers;
}
const token = () => randomBytes(32).toString('hex');
const equal = (a: string, b: string) => /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const origin = (value: string | undefined): string | undefined => { try { return value ? new URL(value).origin : undefined; } catch { return undefined; } };
export interface PreviewLease { id: string; port: number; capability: string; }
interface Lease extends PreviewLease { expires: number; controlOrigin: string; }
interface Listener { capability: string; workflow: string; backend: number; port: number; server: http.Server; leases: Map<string, Lease>; sockets: Set<Duplex>; }
export interface PreviewGatewayOptions {
  host: string;
  range: () => Promise<string>;
  lookup: (workflow: string) => number | undefined;
  excludedPorts: () => number[];
  ttlMs?: number;
}

export class PreviewGateways {
  private listeners = new Map<string, Listener>();
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval>;
  constructor(private options: PreviewGatewayOptions) {
    this.timer = setInterval(() => this.sweep(), 1000); this.timer.unref();
  }
  private sweep() {
    for (const listener of this.listeners.values()) {
      for (const [id, lease] of listener.leases) if (lease.expires <= Date.now()) listener.leases.delete(id);
      if (!listener.leases.size || this.options.lookup(listener.workflow) !== listener.backend) this.closeListener(listener);
    }
  }
  private closeListener(listener: Listener) {
    if (this.listeners.get(listener.workflow) !== listener) return;
    this.listeners.delete(listener.workflow); activePreviewPorts.delete(listener.port);
    for (const socket of listener.sockets) socket.destroy();
    listener.server.close();
  }
  close() { clearInterval(this.timer); for (const listener of this.listeners.values()) this.closeListener(listener); }
  acquire(workflow: string, controlOrigin: string): Promise<PreviewLease> {
    const result = this.queue.then(() => this.allocate(workflow, controlOrigin));
    this.queue = result.catch(() => {}); return result;
  }
  private async allocate(workflow: string, controlOrigin: string): Promise<PreviewLease> {
    this.sweep();
    const backend = this.options.lookup(workflow);
    if (!backend || this.options.excludedPorts().includes(backend) || activePreviewPorts.has(backend)) throw new Error('Preview backend is unavailable.');
    let listener = this.listeners.get(workflow);
    if (!listener) {
      const range = await this.options.range();
      const [first, last] = parsePreviewPorts(range, 65536);
      for (let port = first; port <= last; port++) {
        if (port === backend || activePreviewPorts.has(port) || this.options.excludedPorts().includes(port) || port === Number(new URL(controlOrigin).port || (controlOrigin.startsWith('https:') ? 443 : 80))) continue;
        const candidate = { capability: token(), workflow, backend, port, leases: new Map(), sockets: new Set() } as Listener;
        candidate.server = http.createServer((req, res) => this.request(candidate, req, res));
        candidate.server.on('connection', socket => { candidate.sockets.add(socket); socket.on('close', () => candidate.sockets.delete(socket)); });
        candidate.server.on('upgrade', (req, socket, head) => this.upgrade(candidate, req, socket, head));
        const bound = await new Promise<boolean>((resolve, reject) => {
          candidate.server.once('error', error => { if (['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) resolve(false); else reject(error); });
          candidate.server.listen(port, this.options.host, () => resolve(true));
        });
        if (!bound) continue;
        listener = candidate; this.listeners.set(workflow, candidate); activePreviewPorts.add(port); break;
      }
      if (!listener) throw new Error(`No preview port is free in ${range}. Close another preview or change PREVIEW PORTS in Settings.`);
    }
    const lease: Lease = { id: token(), port: listener.port, capability: listener.capability, expires: Date.now() + (this.options.ttlMs ?? 180_000), controlOrigin };
    listener.leases.set(lease.id, lease);
    return { id: lease.id, port: lease.port, capability: lease.capability };
  }
  renew(workflow: string, id: string): boolean {
    this.sweep(); const lease = this.listeners.get(workflow)?.leases.get(id);
    if (!lease) return false; lease.expires = Date.now() + (this.options.ttlMs ?? 180_000); return true;
  }
  release(workflow: string, id: string) {
    const listener = this.listeners.get(workflow); if (!listener) return;
    listener.leases.delete(id); if (!listener.leases.size) this.closeListener(listener);
  }
  private authorize(listener: Listener, req: IncomingMessage, bootstrap: string | null = null): Lease | undefined {
    this.sweep();
    if (this.listeners.get(listener.workflow) !== listener || !req.headers.host) return;
    const own = origin(`http://${req.headers.host}`);
    const ownHttps = origin(`https://${req.headers.host}`);
    if (!own || Number(new URL(own).port || 80) !== listener.port && Number(new URL(ownHttps!).port || 443) !== listener.port) return;
    const from = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const ref = origin(req.headers.referer);
    const site = req.headers['sec-fetch-site'];
    if (site === 'cross-site' || from === 'null') return;
    for (const lease of listener.leases.values()) {
      if (bootstrap) {
        if (req.method !== 'GET' || !equal(bootstrap, lease.capability) || ref !== lease.controlOrigin || (from && from !== lease.controlOrigin)) continue;
        return lease;
      }
      if (from && from !== own && from !== ownHttps) continue;
      if (ref && ref !== own && ref !== ownHttps) continue;
      // Cross-port cookies are same-site. Only this authority may use them.
      if (!from && !ref && site && site !== 'same-origin' && site !== 'none') continue;
      const cookies = (req.headers.cookie ?? '').split(';').map(part => part.trim());
      if (cookies.some(part => part.startsWith(`arco_preview_${listener.port}=`) && equal(part.slice(part.indexOf('=') + 1), lease.capability))) return lease;
    }
  }
  private request(listener: Listener, req: IncomingMessage, res: ServerResponse) {
    let url: URL; try { url = new URL(req.url ?? '/', 'http://preview.invalid'); } catch { res.writeHead(400); res.end(); return; }
    const bootstrap = url.pathname === '/.arco-preview' ? url.searchParams.get('cap') : null;
    const lease = this.authorize(listener, req, bootstrap);
    // Do not allow a preview to install a worker that survives port reuse.
    if (!lease || req.headers['service-worker'] || req.headers['sec-fetch-dest'] === 'serviceworker') { res.writeHead(403); res.end('Preview access refused. Reopen PREVIEW from Arco.'); return; }
    if (bootstrap) {
      const secure = lease.controlOrigin.startsWith('https:') ? '; Secure' : '';
      const nonce = token();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'`, 'set-cookie': `arco_preview_${listener.port}=${lease.capability}; HttpOnly; SameSite=Strict; Path=/${secure}`, 'cache-control': 'no-store', 'referrer-policy': 'same-origin' }); res.end(`<!doctype html><title>Opening preview</title><script nonce="${nonce}">location.replace('/');</script>`); return;
    }
    const upstream = http.request({ host: '127.0.0.1', port: listener.backend, method: req.method, path: req.url, headers: proxyHeaders(req, listener.backend, false) }, response => {
      const headers = responseHeaders(response.headers, false);
      res.writeHead(response.statusCode ?? 502, headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Preview backend unreachable.'); });
    res.on('close', () => upstream.destroy()); req.pipe(upstream);
  }
  private upgrade(listener: Listener, req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (!this.authorize(listener, req)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    const upstream = http.request({ host: '127.0.0.1', port: listener.backend, method: 'GET', path: req.url, headers: proxyHeaders(req, listener.backend, true) });
    upstream.on('error', () => socket.destroy());
    upstream.on('response', response => { response.resume(); socket.end(`HTTP/1.1 ${response.statusCode ?? 502} Preview Upgrade Failed\r\nConnection: close\r\n\r\n`); });
    upstream.on('upgrade', (response, connection, pending) => {
      const lines = [`HTTP/1.1 101 Switching Protocols`];
      for (const [key, value] of Object.entries(responseHeaders(response.headers, true))) {
        if (value === undefined) continue;
        const values = Array.isArray(value) ? value : [value];
        for (const item of values) lines.push(`${key}: ${item}`);
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (pending.length) socket.write(pending); if (head.length) connection.write(head);
      connection.pipe(socket); socket.pipe(connection);
      socket.on('close', () => connection.destroy()); connection.on('close', () => socket.destroy());
      socket.on('error', () => connection.destroy()); connection.on('error', () => socket.destroy());
    }); upstream.end();
  }
}
function proxyHeaders(req: IncomingMessage, port: number, upgrade: boolean) {
  const headers = { ...req.headers };
  for (const key of Object.keys(headers)) if ((!upgrade && HOP.has(key)) || ['authorization', 'proxy-authorization', 'referer', 'forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-for'].includes(key)) delete headers[key];
  if (headers.cookie) { headers.cookie = safeCookies(headers.cookie); if (!headers.cookie.trim()) delete headers.cookie; }
  headers.host = `127.0.0.1:${port}`; return headers;
}
// Stay below the lowest supported host temporary-port range. Runtime host
// ranges may lower this ceiling further in previewPortConfiguration.ts.
export function parsePreviewPorts(value: unknown, ceiling = 32768): [number, number] {
  if (typeof value !== 'string' || !/^\d{1,5}-\d{1,5}$/.test(value)) throw new Error('PREVIEW PORTS must be a range such as 4300-4309.');
  const [first, last] = value.split('-').map(Number);
  if (first < 1024 || last < first || last >= ceiling || last - first > 99) throw new Error(`PREVIEW PORTS must contain 1 to 100 ports from 1024 to ${ceiling - 1}, below the host temporary-port range.`);
  return [first, last];
}
