// Whether Cursor has rejected the saved sign-in.
//
// A readable token does not prove the login works: Cursor can reject it
// ("Authentication required" from session/new, the "Please sign in" reply, a
// 401 from the usage API). The last rejection is remembered together with a
// fingerprint of the token it was seen with, so the status shows "not signed
// in" until the token changes (a new `cursor-agent login`) or Cursor accepts
// it again. Nothing here calls the network on a status poll; the explicit
// Connections check may run `cursor-agent status` once (checkCursorLoginWithCli).

import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { readCursorAccessToken } from './authToken.js';
import { commandArgs } from '../../windowsCommand.js';

interface Rejection { fingerprint: string | null; source: string; at: number }
let rejected: Rejection | null = null;

const fingerprint = (token: string): string => createHash('sha256').update(token).digest('hex').slice(0, 16);

const AUTH_ERROR_RE = /authentication required|not authenticated|unauthori[sz]ed|please (?:sign|log) ?in|not logged in|login required|unable to fetch user details/i;

export function isCursorAuthErrorText(text: string): boolean {
  return AUTH_ERROR_RE.test(text);
}

export async function noteCursorAuthRejected(source: string): Promise<void> {
  let token: string | null = null;
  try { token = (await readCursorAccessToken()).token; } catch { token = null; }
  rejected = { fingerprint: token ? fingerprint(token) : null, source, at: Date.now() };
}

export function noteCursorAuthOk(): void {
  rejected = null;
}

// The rejection that still applies to `token`, if any. A different token
// (signed in again, or refreshed) clears it.
export function cursorAuthRejection(token: string | null): { source: string; at: number } | null {
  if (!rejected) return null;
  if (token && rejected.fingerprint && fingerprint(token) !== rejected.fingerprint) {
    rejected = null;
    return null;
  }
  return { source: rejected.source, at: rejected.at };
}

export type CliLoginCheck = 'ok' | 'rejected' | 'unknown';

export function parseCursorStatusOutput(text: string): CliLoginCheck {
  if (/logged in as/i.test(text) && !/not logged in/i.test(text)) return 'ok';
  if (isCursorAuthErrorText(text)) return 'rejected';
  return 'unknown';
}

// One `cursor-agent status` (no model call, no usage), for the explicit
// Connections check only. Updates the remembered state.
export function checkCursorLoginWithCli(timeoutMs = 15_000): Promise<CliLoginCheck> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: CliLoginCheck): void => { if (!done) { done = true; resolve(result); } };
    try {
      const [cmd, args] = commandArgs('cursor-agent', ['status']);
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
        const result = parseCursorStatusOutput(`${stdout ?? ''}\n${stderr ?? ''}`);
        if (result === 'ok') noteCursorAuthOk();
        if (result === 'rejected') { void noteCursorAuthRejected('cursor-agent status').then(() => finish(result)); return; }
        finish(err && result === 'unknown' ? 'unknown' : result);
      });
    } catch { finish('unknown'); }
  });
}
