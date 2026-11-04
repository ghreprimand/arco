// In-app provider login. The server runs the provider CLI's device login
// itself and relays what it prints: Codex shows a link plus a one-time code to
// type on the page; Claude shows a link and waits for the code the page hands
// back, which the operator pastes into Arco. Credentials land in the server's
// own home, so a Docker user never needs a terminal. One session per provider;
// the command fallback stays available for everything else.
import { spawn, type ChildProcess } from 'child_process';
import type { AuthLoginSession, AuthLoginTarget } from '@arco/shared';
import { killProcessTree } from './workers/processKill.js';

const SESSION_TTL_MS = 15 * 60_000;
const OUTPUT_CAP = 16 * 1024;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export const IN_APP_LOGIN: Partial<Record<AuthLoginTarget, { needsCode: boolean }>> = {
  codex: { needsCode: false },
  claude: { needsCode: true },
};

export function parseLoginOutput(text: string): { url?: string; code?: string; awaitingCode: boolean } {
  const clean = text.replace(ANSI, '');
  const url = /https?:\/\/[^\s"'<>]+/.exec(clean)?.[0]?.replace(/[.,)]+$/, '');
  // A line that is only hyphen-joined groups of letters and digits.
  const code = /^\s*([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)\s*$/m.exec(clean)?.[1];
  return { ...(url ? { url } : {}), ...(code ? { code } : {}), awaitingCode: /paste code here/i.test(clean) };
}

interface Live {
  session: AuthLoginSession;
  child: ChildProcess | null;
  output: string;
  timer: NodeJS.Timeout | null;
  cancelled: boolean;
}

const live = new Map<AuthLoginTarget, Live>();

function snapshot(entry: Live): AuthLoginSession {
  return { ...entry.session };
}

export function getLoginSession(provider: AuthLoginTarget): AuthLoginSession | null {
  const entry = live.get(provider);
  return entry ? snapshot(entry) : null;
}

// Ends the shell and everything it started (workers/processKill.ts).
function stopChild(entry: Live, label: string): void {
  const pid = entry.child?.pid;
  if (pid) killProcessTree(pid, { graceMs: 2000, label });
}

function finish(entry: Live, status: AuthLoginSession['status'], message?: string): void {
  if (entry.session.status !== 'pending') return;
  entry.session.status = status;
  entry.session.finishedAt = Date.now();
  if (message) entry.session.message = message;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  entry.child = null;
}

export function startLoginSession(provider: AuthLoginTarget, command: string): AuthLoginSession {
  const existing = live.get(provider);
  if (existing && existing.session.status === 'pending') return snapshot(existing);
  const spec = IN_APP_LOGIN[provider];
  if (!spec) throw new Error(`in-app login is not available for ${provider}`);
  const entry: Live = {
    session: { provider, status: 'pending', needsCode: spec.needsCode, startedAt: Date.now() },
    child: null,
    output: '',
    timer: null,
    cancelled: false,
  };
  live.set(provider, entry);
  let child: ChildProcess;
  try {
    // No browser exists where the server runs; the CLIs print the link anyway.
    // detached on POSIX makes the shell a process-group leader, so a cancel or
    // timeout reaches the provider CLI it started, not only the shell.
    child = spawn(command, { shell: true, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, BROWSER: 'true', NO_BROWSER: 'true' } });
  } catch (err) {
    finish(entry, 'failed', err instanceof Error ? err.message : String(err));
    return snapshot(entry);
  }
  entry.child = child;
  const onData = (chunk: Buffer): void => {
    entry.output = (entry.output + chunk.toString('utf8')).slice(-OUTPUT_CAP);
    const parsed = parseLoginOutput(entry.output);
    if (parsed.url) entry.session.url = parsed.url;
    if (parsed.code) entry.session.code = parsed.code;
    if (parsed.awaitingCode) entry.session.awaitingCode = true;
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('error', (err) => finish(entry, 'failed', err.message));
  child.on('exit', (code) => {
    if (entry.cancelled) return finish(entry, 'cancelled');
    if (code === 0) return finish(entry, 'completed');
    const tail = entry.output.replace(ANSI, '').trim().split('\n').filter((l) => l.trim()).slice(-3).join(' ');
    finish(entry, 'failed', tail || `login exited with code ${code}`);
  });
  entry.timer = setTimeout(() => {
    if (entry.session.status !== 'pending') return;
    stopChild(entry, 'login timeout');
    finish(entry, 'failed', 'login timed out; start again');
  }, SESSION_TTL_MS);
  return snapshot(entry);
}

export function submitLoginCode(provider: AuthLoginTarget, code: string): { ok: true; session: AuthLoginSession } | { ok: false; error: string } {
  const entry = live.get(provider);
  if (!entry || entry.session.status !== 'pending' || !entry.child) return { ok: false, error: 'no login in progress' };
  if (!entry.session.needsCode) return { ok: false, error: 'this provider does not take a pasted code' };
  const trimmed = code.trim();
  if (!trimmed || trimmed.length > 512 || /[\r\n]/.test(trimmed)) return { ok: false, error: 'code must be one line' };
  entry.child.stdin?.write(trimmed + '\n');
  entry.session.codeSubmitted = true;
  return { ok: true, session: snapshot(entry) };
}

export function cancelLoginSession(provider: AuthLoginTarget): AuthLoginSession | null {
  const entry = live.get(provider);
  if (!entry) return null;
  if (entry.session.status === 'pending') {
    entry.cancelled = true;
    stopChild(entry, 'login cancel');
    finish(entry, 'cancelled');
  }
  return snapshot(entry);
}
