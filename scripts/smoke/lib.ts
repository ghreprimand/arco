// Shared harness for headless WebSocket smoke scenarios.
//
// Why: manual 10-step UI acceptance recipes after every phase don't scale.
// Most steps are pure protocol — message in, broadcast out — and can be
// driven from a node script. UI affordances (PLAN sub-tab renders, role
// pencil widget exists) stay manual; everything else lives here.
//
// Usage:
//   const c = await connect();
//   await c.send({ type: 'create_workflow', config: {...} });
//   const created = await c.waitFor(m => m.type === 'workflow_created');
//   step('plan: 8 KB cap rejected', async () => { ... assert(...) ... });
//   await c.close();
//   summary();  // exits with code 0 or 1

import WebSocket from 'ws';

const DEFAULT_URL = process.env.ARCHON_SMOKE_WS_URL || 'ws://localhost:3001/ws';
const DEFAULT_TIMEOUT_MS = 5000;

export interface AnyMessage {
  type: string;
  [k: string]: unknown;
}

// Several scenarios need the server booted with a specific env var (the
// ARCHON_TEST debug hooks, a shortened cluster idle floor). Prod deliberately
// runs without them, so pointing a smoke at the live service produced a
// cryptic 8s waitFor timeout that read like a product regression. Call this
// first to fail immediately with the actual fix.
export function requireServerEnv(vars: Record<string, string>, scenario: string): void {
  const missing = Object.entries(vars).filter(([k, v]) => process.env[k] !== v);
  if (missing.length === 0) return;
  const set = missing.map(([k, v]) => `${k}=${v}`).join(' ');
  console.error(
    `\n${scenario} needs the server booted with: ${set}\n` +
    `The live archon.service does NOT set these (by design), so this scenario\n` +
    `cannot pass against it. Start a dev server with them instead:\n\n` +
    `  ${set} ARCHON_PORT=3099 npm run dev:server &\n` +
    `  ${set} ARCHON_PORT=3099 ARCHON_SMOKE_WS_URL=ws://localhost:3099/ws npm run smoke:...\n\n` +
    `Re-run with the same vars exported here so this check passes.\n`,
  );
  process.exit(1);
}

export class SmokeClient {
  private ws: WebSocket;
  private buffer: AnyMessage[] = [];
  private waiters: Array<{
    predicate: (m: AnyMessage) => boolean;
    resolve: (m: AnyMessage) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  public sessionId: string | undefined;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => {
      let msg: AnyMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      // Walk waiters first; if one matches, the message is consumed by that
      // waiter and does NOT land in the buffer. Otherwise push to buffer so
      // a later waitFor can scan for it. This keeps the "matched once,
      // consumed" invariant symmetric across the buffer-scan path
      // (waitFor's for-loop already splices on match) and the live-arrival
      // path — without it, every matched message would also accumulate in
      // the buffer and a later waitFor with the same predicate type would
      // re-match the stale event.
      for (let i = 0; i < this.waiters.length; i++) {
        const w = this.waiters[i];
        if (w.predicate(msg)) {
          clearTimeout(w.timer);
          this.waiters.splice(i, 1);
          w.resolve(msg);
          return;
        }
      }
      this.buffer.push(msg);
    });
  }

  send(msg: AnyMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  // Read-only view of the buffer for negative assertions ("X must not have
  // landed by now"). Consumers must NOT mutate the returned array.
  peekMessages(): readonly AnyMessage[] {
    return this.buffer;
  }

  // Resolve with the next message matching `predicate`. If a matching message
  // is already in the buffer, resolve immediately. Rejects after `timeoutMs`.
  waitFor(
    predicate: (m: AnyMessage) => boolean,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    label: string = 'message',
  ): Promise<AnyMessage> {
    // Check buffer first.
    for (let i = 0; i < this.buffer.length; i++) {
      if (predicate(this.buffer[i])) {
        const hit = this.buffer[i];
        this.buffer.splice(0, i + 1);
        return Promise.resolve(hit);
      }
    }
    return new Promise<AnyMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`waitFor("${label}") timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

export async function connect(url: string = DEFAULT_URL): Promise<SmokeClient> {
  const ws = new WebSocket(url);
  // A loopback server can send connected in the same frame as the upgrade.
  // Buffer messages before awaiting open, or that first message can be lost.
  const client = new SmokeClient(ws);
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => { ws.off('error', onError); resolve(); };
    const onError = (e: Error) => {
      ws.off('open', onOpen);
      // server/src/http/wsAuth.ts — /ws needs a browser session cookie unless
      // the target server was booted with ARCHON_WS_AUTH=off.
      if (/\b401\b/.test(e.message)) {
        reject(new Error(`${e.message}\nThe server refused the upgrade (session-cookie gate). Boot the smoke target with ARCHON_WS_AUTH=off, e.g.\n  ARCHON_WS_AUTH=off ARCHON_PORT=3099 npm run dev:server &\n  ARCHON_SMOKE_WS_URL=ws://localhost:3099/ws npm run smoke:...`));
        return;
      }
      reject(e);
    };
    ws.once('open', onOpen);
    ws.once('error', onError);
  });
  try {
    const conn = await client.waitFor((m) => m.type === 'connected', DEFAULT_TIMEOUT_MS, 'connected');
    client.sessionId = conn.sessionId as string;
    return client;
  } catch (error) { await client.close(); throw error; }
}

// ── Step runner ──

let passes = 0;
let fails = 0;
const failures: string[] = [];

export async function step(name: string, fn: () => Promise<void> | void): Promise<void> {
  const t0 = Date.now();
  try {
    await fn();
    const dt = Date.now() - t0;
    console.log(`  PASS  ${name}  (${dt}ms)`);
    passes++;
  } catch (err) {
    const dt = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  FAIL  ${name}  (${dt}ms)\n        ${msg}`);
    failures.push(`${name}: ${msg}`);
    fails++;
  }
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

export function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`assertion failed: ${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
  }
}

export function summary(scenarioName: string): never {
  const total = passes + fails;
  console.log('');
  console.log(`${scenarioName}: ${passes}/${total} steps passed`);
  if (fails > 0) {
    console.log('');
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}
