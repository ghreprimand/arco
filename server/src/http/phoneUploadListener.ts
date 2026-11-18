import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';

// A temporary listener for phone upload when the main server cannot be
// reached from the private network (the default loopback bind). It binds
// each private network or tailnet address separately, never a wildcard, and
// answers one path: the phone upload page and its upload endpoint. Upgrade
// requests (WebSocket) are refused, and nothing reaches the workbench router.
// The main server's bind is never changed.

export interface PhoneListener {
  origins: string[];
  close(): void;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const PHONE_PATH = '/phone-upload';

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' });
  res.end(JSON.stringify({ error: 'Not found.' }));
}

/** An HTTP server that answers only the phone upload path and refuses everything else. */
export function createPhoneServer(handler: Handler): Server {
  const server = http.createServer((req, res) => {
    if (req.url !== PHONE_PATH || req.headers.upgrade) return notFound(res);
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end();
    });
  });
  server.on('upgrade', (_req, socket) => { socket.destroy(); });
  server.headersTimeout = 15_000;
  server.requestTimeout = 5 * 60_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 32;
  return server;
}

// Tests bind the listener to loopback while it reports a fixture private
// address, so the operator route can be exercised without that interface.
let bindAddressForTest: ((address: string) => string) | null = null;
export function _bindPhoneListenerForTest(map: ((address: string) => string) | null): void {
  bindAddressForTest = map;
}

function listen(server: Server, address: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, address, () => {
      server.off('error', reject);
      const bound = server.address();
      resolve(typeof bound === 'object' && bound ? bound.port : port);
    });
  });
}

/**
 * Bind one phone server per address. Arco's own port is tried first, so a
 * firewall rule for that port also covers phones; when it is taken on an
 * address, the system picks a free port there. Addresses that cannot be
 * bound are left out.
 */
export async function startPhoneListener(addresses: string[], preferredPort: number, handler: Handler): Promise<PhoneListener> {
  const servers: Server[] = [];
  const origins: string[] = [];
  for (const address of addresses) {
    let reason = '';
    for (const port of preferredPort ? [preferredPort, 0] : [0]) {
      const server = createPhoneServer(handler);
      try {
        const bound = await listen(server, bindAddressForTest?.(address) ?? address, port);
        server.on('error', error => console.warn(`[arco] phone upload listener: ${error.message}`));
        servers.push(server);
        origins.push(new URL(`http://${address}:${bound}`).origin);
        reason = '';
        break;
      } catch (e) {
        reason = (e as NodeJS.ErrnoException).code ?? 'unknown error';
        server.close();
      }
    }
    // The error code only: the address itself stays out of the log.
    if (reason) console.warn(`[arco] phone upload listener could not bind a private address: ${reason}`);
  }
  return {
    origins,
    close() {
      for (const server of servers) {
        server.close();
        server.closeIdleConnections();
      }
    },
  };
}
