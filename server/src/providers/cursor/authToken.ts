// Where cursor-agent keeps its session JWT differs by platform:
//   - Linux: ~/.config/cursor/auth.json ({ accessToken, refreshToken }),
//     refreshed in the background by cursor-agent.
//   - macOS: login-keychain generic-password items `cursor-access-token` /
//     `cursor-refresh-token` (account `cursor-user`) — no auth.json is written,
//     which made auth.ts/cursorUsage.ts report "not signed in" on Macs.
// ARCO_CURSOR_AUTH force-points at a JSON file on any platform and disables
// the keychain fallback (an explicit override should never be second-guessed).

import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';

const AUTH_PATH = process.env.ARCO_CURSOR_AUTH
  ?? join(homedir(), '.config', 'cursor', 'auth.json');

const KEYCHAIN_TIMEOUT_MS = 5_000;

export type CursorTokenResult =
  | { token: string; source: 'file' | 'keychain' }
  | { token: null; reason: 'missing' | 'unreadable'; detail?: string };

// Read the session JWT fresh on every call — never cache it, so callers ride
// cursor-agent's background refresh.
export async function readCursorAccessToken(): Promise<CursorTokenResult> {
  let fileFailure: { reason: 'missing' | 'unreadable'; detail?: string };
  try {
    const raw = JSON.parse(await readFile(AUTH_PATH, 'utf8')) as { accessToken?: string };
    if (typeof raw.accessToken === 'string' && raw.accessToken) {
      return { token: raw.accessToken, source: 'file' };
    }
    fileFailure = { reason: 'unreadable', detail: `${AUTH_PATH} has no accessToken` };
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException)?.code === 'ENOENT';
    fileFailure = missing
      ? { reason: 'missing' }
      : { reason: 'unreadable', detail: `Could not read ${AUTH_PATH}: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (process.platform === 'darwin' && !process.env.ARCO_CURSOR_AUTH) {
    const token = await readKeychainToken();
    if (token) return { token, source: 'keychain' };
  }
  return { token: null, ...fileFailure };
}

function readKeychainToken(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-w', '-s', 'cursor-access-token'],
      { timeout: KEYCHAIN_TIMEOUT_MS },
      (err, stdout) => {
        if (err) return resolve(null);
        const token = stdout.trim();
        resolve(token.length > 0 ? token : null);
      },
    );
  });
}
