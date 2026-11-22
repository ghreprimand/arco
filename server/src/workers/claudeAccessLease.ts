import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerAccessPass } from './workerAccessPass.js';
import { readClaudeAccessSource } from './claudeAccessSource.js';

function accessFingerprint(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const auth = (input as Record<string, unknown>).claudeAiOauth;
  if (!auth || typeof auth !== 'object') return undefined;
  const { accessToken, expiresAt } = auth as Record<string, unknown>;
  if (typeof accessToken !== 'string' || !accessToken || typeof expiresAt !== 'number') return undefined;
  return createHash('sha256').update(accessToken).update(String(expiresAt)).digest('hex');
}
export async function claudeSignInFingerprint(): Promise<string | undefined> {
  return accessFingerprint(await readClaudeAccessSource().catch(() => undefined));
}

/** Wait for the normal sign-in to be replaced; never expose its contents to a worker. */
export async function waitForClaudeSignIn(signal: AbortSignal, options: {
  read?: () => Promise<unknown>; pause?: (signal: AbortSignal) => Promise<unknown>; onWaiting?: () => Promise<void>;
  initial?: string | null;
} = {}): Promise<void> {
  const read = options.read ?? readClaudeAccessSource;
  const pause = options.pause ?? (async abort => { await delay(2000, undefined, { signal: abort }); });
  const initial = options.initial === undefined ? accessFingerprint(await read().catch(() => undefined)) : options.initial ?? undefined;
  await options.onWaiting?.();
  while (!signal.aborted) {
    const current = await read().catch(() => undefined);
    const fingerprint = accessFingerprint(current);
    if (fingerprint && fingerprint !== initial) {
      try { workerAccessPass('claude', current); return; } catch { /* Wait for a usable sign-in. */ }
    }
    await pause(signal);
  }
  throw new Error('Claude sign-in preparation cancelled.');
}

/** Serializes Arco's own isolated Claude passes around a normal sign-in refresh. */
export class ClaudeAccessLeaseBroker {
  private active = 0;
  private serial: Promise<void> = Promise.resolve();
  private idleWaiters = new Set<() => void>();
  constructor(private readonly read: () => Promise<unknown>, private readonly renew: (signal?: AbortSignal) => Promise<void>, private readonly now: () => number = Date.now) {}

  async acquire(signal?: AbortSignal): Promise<{ credentials: unknown; release(): void }> {
    for (;;) {
      if (signal?.aborted) throw new Error('Claude sign-in preparation cancelled.');
      const previous = this.serial;
      let unlock!: () => void;
      const held = new Promise<void>(resolve => { unlock = resolve; });
      this.serial = previous.then(() => held);
      try {
        await new Promise<void>((resolve, reject) => {
          const abort = () => { signal?.removeEventListener('abort', abort); reject(new Error('Claude sign-in preparation cancelled.')); };
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) { abort(); return; }
          previous.then(() => { signal?.removeEventListener('abort', abort); resolve(); }, reject);
        });
      } catch (error) { unlock(); throw error; }
      let wait: Promise<void> | undefined;
      try {
        if (signal?.aborted) throw new Error('Claude sign-in preparation cancelled.');
        let credentials = await this.read();
        const root = credentials && typeof credentials === 'object' ? credentials as Record<string, unknown> : {};
        const value = root.claudeAiOauth && typeof root.claudeAiOauth === 'object' ? root.claudeAiOauth as Record<string, unknown> : {};
        if (typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) && value.expiresAt <= this.now() + 300_000) {
          if (this.active > 0) {
            wait = new Promise<void>((resolve, reject) => {
              const finish = () => { this.idleWaiters.delete(finish); signal?.removeEventListener('abort', abort); resolve(); };
              const abort = () => { this.idleWaiters.delete(finish); signal?.removeEventListener('abort', abort); reject(new Error('Claude sign-in preparation cancelled.')); };
              this.idleWaiters.add(finish); signal?.addEventListener('abort', abort, { once: true });
              if (signal?.aborted) abort();
            });
          } else {
            await this.renew(signal);
            credentials = await this.read();
          }
        }
        if (!wait) {
          workerAccessPass('claude', credentials, this.now());
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

async function renewClaude(binary: string, signal?: AbortSignal): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'arco-claude-refresh-'));
  try {
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('Claude sign-in preparation cancelled.')); return; }
      const child = spawn(binary, ['-p', '--tools', '', '--strict-mcp-config', '--permission-mode', 'dontAsk',
        '--settings', '{"disableAllHooks":true}', '--no-session-persistence'], { cwd, env: { ...process.env }, stdio: ['pipe', 'ignore', 'ignore'], signal });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 90_000);
      child.stdin?.on('error', () => {});
      child.once('error', () => { clearTimeout(timeout); reject(new Error('Claude sign-in needs renewing.')); });
      child.once('close', code => { clearTimeout(timeout); if (code === 0) resolve(); else reject(new Error('Claude sign-in needs renewing.')); });
      child.stdin?.end('Reply with exactly OK.');
    });
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

let broker: ClaudeAccessLeaseBroker | undefined;
let currentBinary = '';
/** The broker covers isolated Claude turns started by this Arco server. */
export function claudeAccessLeaseBroker(binary: string): ClaudeAccessLeaseBroker {
  currentBinary = binary;
  if (!broker) broker = new ClaudeAccessLeaseBroker(readClaudeAccessSource, signal => renewClaude(currentBinary, signal));
  return broker;
}
