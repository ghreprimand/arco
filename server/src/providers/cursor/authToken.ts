// Where cursor-agent keeps its session JWT differs by platform and CLI version:
//   - Linux: $XDG_CONFIG_HOME/cursor/auth.json (default ~/.config). Current
//     CLIs move the tokens into the desktop secret service and leave only
//     { "storedIn": "os-secret-store" } in auth.json; the secret itself is the
//     same JSON under service `cursor-credentials`, account `cursor-user`.
//   - macOS: login-keychain generic-password items `cursor-access-token` /
//     `cursor-refresh-token` (account `cursor-user`).
//   - Windows: %APPDATA%\Cursor\auth.json.
// Arco read ~/.config/cursor/auth.json on every platform before, so that path
// stays as a fallback where the CLI's own path differs.
// A file with { "signedOut": true } means the operator signed out.
// ARCO_CURSOR_AUTH force-points at a JSON file on any platform and disables
// the keychain and secret-service reads (an explicit override should never be
// second-guessed).

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execFile } from 'child_process';

const STORE_TIMEOUT_MS = 5_000;
const SECRET_TOOLS = ['/usr/bin/secret-tool', '/usr/local/bin/secret-tool'];

export type CursorTokenResult =
  | { token: string; source: 'file' | 'keychain' | 'secret-store' }
  | { token: null; reason: 'missing' | 'signed-out' | 'unreadable'; detail?: string; uncertain?: boolean };

// Linux secret-service read result. `locked`: the keyring holds the item but
// is locked, so its value is not available without the desktop unlocking it.
export type SecretStoreRead =
  | { kind: 'found'; value: string }
  | { kind: 'absent' }
  | { kind: 'locked' }
  | { kind: 'unavailable'; detail: string };

export interface CursorTokenSources {
  platform: NodeJS.Platform;
  // The CLI's own auth.json first, then earlier locations Arco read.
  authPaths: string[];
  override: boolean;
  readFileText: (path: string) => Promise<string>;
  readKeychain: () => Promise<string | null>;
  readSecretStore: () => Promise<SecretStoreRead>;
}

export function cursorAuthPaths(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  if (env.ARCO_CURSOR_AUTH) return [env.ARCO_CURSOR_AUTH];
  const legacy = join(home, '.config', 'cursor', 'auth.json');
  const own = platform === 'win32'
    ? join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Cursor', 'auth.json')
    : platform === 'darwin'
      ? join(home, '.cursor', 'auth.json')
      : join(env.XDG_CONFIG_HOME || join(home, '.config'), 'cursor', 'auth.json');
  return own === legacy ? [own] : [own, legacy];
}

const SIGN_IN_AGAIN = 'Sign in to Cursor again from Connections.';

function tokenFrom(raw: unknown): string | null {
  const value = (raw as { accessToken?: unknown } | null)?.accessToken;
  return typeof value === 'string' && value ? value : null;
}

// Read the session JWT fresh on every call, keyring included and nothing
// cached, so callers ride cursor-agent's background refresh and a check right
// after a sign-in never sees an old token.
export async function readCursorAccessTokenFrom(src: CursorTokenSources): Promise<CursorTokenResult> {
  let file: { accessToken?: unknown; storedIn?: unknown; signedOut?: unknown } | null = null;
  let fileFailure: Extract<CursorTokenResult, { token: null }>;
  fileFailure = { token: null, reason: 'missing' };
  // The first file that exists decides; a missing one falls through.
  for (const path of src.authPaths) {
    try {
      file = JSON.parse(await src.readFileText(path));
      const token = tokenFrom(file);
      if (token) return { token, source: 'file' };
      fileFailure = file?.signedOut === true
        ? { token: null, reason: 'signed-out', detail: `Signed out of Cursor. ${SIGN_IN_AGAIN}` }
        : { token: null, reason: 'unreadable', detail: `Cursor's saved sign-in has no session token. ${SIGN_IN_AGAIN}` };
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      fileFailure = { token: null, reason: 'unreadable', detail: `Cursor's saved sign-in could not be read. ${SIGN_IN_AGAIN}` };
      break;
    }
  }
  if (src.override) return fileFailure;
  if (src.platform === 'darwin') {
    const token = await src.readKeychain();
    if (token) return { token, source: 'keychain' };
    return fileFailure;
  }
  if (src.platform === 'linux' && file?.storedIn === 'os-secret-store' && file.signedOut !== true) {
    const stored = await src.readSecretStore();
    if (stored.kind === 'found') {
      let token: string | null = null;
      try { token = tokenFrom(JSON.parse(stored.value)); } catch { token = null; }
      if (token) return { token, source: 'secret-store' };
      return { token: null, reason: 'unreadable', detail: `Cursor's sign-in in the system keyring has no session token. ${SIGN_IN_AGAIN}` };
    }
    if (stored.kind === 'locked') {
      return { token: null, reason: 'unreadable', uncertain: true, detail: 'Cursor keeps its sign-in in the system keyring, which is locked. Unlock the keyring (sign in to the desktop session), then check again.' };
    }
    if (stored.kind === 'unavailable') {
      return { token: null, reason: 'unreadable', uncertain: true, detail: `Cursor keeps its sign-in in the system keyring, which Arco could not read (${stored.detail}). Cursor itself can still work.` };
    }
    return { token: null, reason: 'unreadable', detail: `Cursor's sign-in is missing from the system keyring. ${SIGN_IN_AGAIN}` };
  }
  return fileFailure;
}

// `secret-tool search` without --unlock never prompts: an unlocked item
// prints its `secret = ...` line, a locked one prints only its attributes.
export function parseSecretToolSearch(stdout: string, stderr: string): SecretStoreRead {
  const secret = /^secret = (.*)$/m.exec(stdout)?.[1];
  if (secret !== undefined) return { kind: 'found', value: secret };
  if (/^\[/m.test(stdout) || /locked/i.test(stderr)) return { kind: 'locked' };
  return { kind: 'absent' };
}

function readLinuxSecretStore(): Promise<SecretStoreRead> {
  const tool = SECRET_TOOLS.find((path) => existsSync(path));
  if (!tool) return Promise.resolve({ kind: 'unavailable', detail: 'secret-tool is not installed' });
  return new Promise((resolve) => {
    execFile(
      tool,
      ['search', 'service', 'cursor-credentials', 'account', 'cursor-user'],
      { timeout: STORE_TIMEOUT_MS, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        const parsed = parseSecretToolSearch(stdout ?? '', stderr ?? '');
        // No match exits quietly; a timeout or a message on stderr (no session
        // bus, no keyring service) means the keyring was not read.
        resolve(err && parsed.kind === 'absent' && ((err as { killed?: boolean }).killed || (stderr ?? '').trim())
          ? { kind: 'unavailable', detail: 'the keyring service did not answer' }
          : parsed);
      },
    );
  });
}

function readKeychainToken(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-w', '-s', 'cursor-access-token'],
      { timeout: STORE_TIMEOUT_MS },
      (err, stdout) => {
        if (err) return resolve(null);
        const token = stdout.trim();
        resolve(token.length > 0 ? token : null);
      },
    );
  });
}

export function readCursorAccessToken(): Promise<CursorTokenResult> {
  return readCursorAccessTokenFrom({
    platform: process.platform,
    authPaths: cursorAuthPaths(),
    override: !!process.env.ARCO_CURSOR_AUTH,
    readFileText: (path) => readFile(path, 'utf8'),
    readKeychain: readKeychainToken,
    readSecretStore: readLinuxSecretStore,
  });
}
