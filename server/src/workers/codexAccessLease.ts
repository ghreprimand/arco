import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { JsonRpcClient } from '../providers/codex-appserver/jsonRpc.js';
import { workerAccessPass } from './workerAccessPass.js';
import { setTimeout as delay } from 'node:timers/promises';

export function codexSignInHome(configuredHome?: string): string {
  let home = resolve(configuredHome || process.env.CODEX_HOME || join(homedir(), '.codex'));
  try { home = realpathSync(home); } catch { /* The source reader reports a missing sign-in. */ }
  return home;
}

function accessFingerprint(input: unknown): string | undefined {
  try {
    const pass = JSON.parse(workerAccessPass('codex', input)) as { tokens: { access_token: string; account_id: string } };
    return createHash('sha256').update(pass.tokens.access_token).update('\0').update(pass.tokens.account_id).digest('hex');
  } catch { return undefined; }
}
export async function codexSignInFingerprint(home: string): Promise<string | undefined> {
  return accessFingerprint(await readCodexAccessSource(home).catch(() => undefined));
}
export async function waitForCodexSignIn(home: string, signal: AbortSignal, options: {
  initial?: string | null; read?: () => Promise<unknown>; pause?: (signal: AbortSignal) => Promise<unknown>; onWaiting?: () => Promise<void>;
} = {}): Promise<void> {
  const read = options.read ?? (() => readCodexAccessSource(home));
  const pause = options.pause ?? (async abort => { await delay(2000, undefined, { signal: abort }); });
  const initial = options.initial === undefined ? accessFingerprint(await read().catch(() => undefined)) : options.initial ?? undefined;
  await options.onWaiting?.();
  while (!signal.aborted) {
    const fingerprint = accessFingerprint(await read().catch(() => undefined));
    if (fingerprint && fingerprint !== initial) return;
    await pause(signal);
  }
  throw new Error('Codex sign-in preparation cancelled.');
}

export async function readCodexAccessSource(home: string): Promise<unknown> {
  let handle;
  try {
    handle = await open(join(home, 'auth.json'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 65536 || (process.getuid && metadata.uid !== process.getuid())) throw new Error();
    const bytes = Buffer.alloc(65537);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 65536) throw new Error();
    return JSON.parse(bytes.toString('utf8', 0, bytesRead)) as unknown;
  } catch { throw new Error('Codex sign-in needs renewing.'); }
  finally { await handle?.close(); }
}

export async function refreshCodexSignIn(binary: string, home: string, signal?: AbortSignal): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-codex-refresh-'));
  const child = spawn(binary, ['app-server'], { cwd, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'], detached: true, signal });
  child.stderr?.resume();
  let rpc: JsonRpcClient | undefined;
  try {
    if (!child.stdin || !child.stdout) throw new Error();
    rpc = new JsonRpcClient(child.stdin, child.stdout, undefined, 30_000);
    child.once('error', () => rpc?.close('Codex refresh process failed.'));
    child.once('exit', () => rpc?.close('Codex refresh process exited.'));
    await rpc.request('initialize', { clientInfo: { name: 'arco', version: '1' }, capabilities: { experimentalApi: false } });
    rpc.notify('initialized');
    const account = await rpc.request<{ account?: unknown }>('account/read', { refreshToken: true });
    if (!account.account) throw new Error();
  } catch { throw new Error('Codex sign-in needs renewing.'); }
  finally {
    rpc?.close();
    if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }
    await new Promise<void>(done => { if (child.exitCode !== null || child.signalCode !== null) done(); else { child.once('close', () => done()); setTimeout(done, 3000).unref(); } });
    await rm(cwd, { recursive: true, force: true });
  }
}

function expiryOf(credentials: unknown): number | undefined {
  try {
    const root = credentials as { tokens?: { access_token?: unknown } };
    if (typeof root?.tokens?.access_token !== 'string') return undefined;
    const payload = JSON.parse(Buffer.from(root.tokens.access_token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : undefined;
  } catch { return undefined; }
}

/** Coordinates passes for one Codex sign-in within this server. */
export class CodexAccessLeaseBroker {
  private active = 0;
  private serial: Promise<void> = Promise.resolve();
  private idleWaiters = new Set<() => void>();
  constructor(private readonly read: () => Promise<unknown>, private readonly renew: (signal?: AbortSignal) => Promise<void>, private readonly now: () => number = Date.now) {}
  async acquire(signal?: AbortSignal): Promise<{ credentials: unknown; release(): void }> {
    for (;;) {
      if (signal?.aborted) throw new Error('Codex sign-in preparation cancelled.');
      const previous = this.serial;
      let unlock!: () => void;
      const held = new Promise<void>(done => { unlock = done; });
      this.serial = previous.then(() => held);
      try {
        await new Promise<void>((done, fail) => {
          const abort = () => { signal?.removeEventListener('abort', abort); fail(new Error('Codex sign-in preparation cancelled.')); };
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) { abort(); return; }
          previous.then(() => { signal?.removeEventListener('abort', abort); done(); }, fail);
        });
      } catch (error) { unlock(); throw error; }
      let wait: Promise<void> | undefined;
      try {
        if (signal?.aborted) throw new Error('Codex sign-in preparation cancelled.');
        let credentials = await this.read();
        const expiry = expiryOf(credentials);
        if (expiry !== undefined && expiry <= this.now() + 300_000) {
          if (this.active > 0) {
            wait = new Promise<void>((done, fail) => {
              const finish = () => { this.idleWaiters.delete(finish); signal?.removeEventListener('abort', abort); done(); };
              const abort = () => { this.idleWaiters.delete(finish); signal?.removeEventListener('abort', abort); fail(new Error('Codex sign-in preparation cancelled.')); };
              this.idleWaiters.add(finish); signal?.addEventListener('abort', abort, { once: true });
              if (signal?.aborted) abort();
            });
          } else { await this.renew(signal); credentials = await this.read(); }
        }
        if (!wait) {
          try { workerAccessPass('codex', credentials, this.now()); } catch { throw new Error('Codex sign-in needs renewing.'); }
          this.active++;
          let released = false;
          return { credentials, release: () => {
            if (released) return;
            released = true; this.active--;
            if (this.active === 0) for (const wake of [...this.idleWaiters]) wake();
          } };
        }
      } finally { unlock(); }
      await wait;
    }
  }
}

const brokers = new Map<string, CodexAccessLeaseBroker>();
/** A selected account's normal home remains on the server side of the fence. */
export function codexAccessLeaseBroker(binary: string, configuredHome?: string): CodexAccessLeaseBroker {
  const home = codexSignInHome(configuredHome);
  let broker = brokers.get(home);
  if (!broker) { broker = new CodexAccessLeaseBroker(() => readCodexAccessSource(home), signal => refreshCodexSignIn(binary, home, signal)); brokers.set(home, broker); }
  return broker;
}
