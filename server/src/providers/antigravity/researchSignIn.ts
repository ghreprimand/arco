// docs/RESEARCH.md "Gemini researchers": the separate Antigravity sign-in used
// only by fenced Gemini researchers. It lives in an Arco-owned home. The CLI
// is started there with no D-Bus session and a private runtime folder, so it
// stores the sign-in as a file instead of in the system keyring; the
// operator's own Antigravity sign-in and ~/.gemini are never read.
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { arcoHome } from '../../arcoHome.js';

export const GEMINI_RESEARCH_TOKEN = join('.gemini', 'antigravity-cli', 'antigravity-oauth-token');
export const GEMINI_RESEARCH_SCOPE = join('.config', 'antigravity', 'credential-user-scope');
const MAX_TOKEN_BYTES = 16 * 1024;
export const GEMINI_RESEARCH_SIGN_IN_NEEDED = 'Gemini for research needs signing in. Sign in from Settings, Providers and models, GEMINI FOR RESEARCH.';

export function geminiResearchRoot(): string { return join(arcoHome(), 'antigravity-research'); }
export function geminiResearchHome(): string { return join(geminiResearchRoot(), 'home'); }
function geminiResearchRun(): string { return join(geminiResearchRoot(), 'run'); }

async function privateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || (process.getuid && entry.uid !== process.getuid())) throw new Error('The Gemini research sign-in folder is not owned by Arco.');
  if ((entry.mode & 0o077) !== 0) await chmod(path, 0o700);
}

/** Create the Arco-owned home (mode 700) before a sign-in. */
export async function ensureGeminiResearchHome(): Promise<{ home: string; run: string }> {
  await privateDirectory(geminiResearchRoot());
  await privateDirectory(geminiResearchHome());
  await privateDirectory(geminiResearchRun());
  return { home: geminiResearchHome(), run: geminiResearchRun() };
}

/** The environment changes for a sign-in into the Arco-owned home. */
export function geminiResearchLoginEnv(home: string, run: string): { set: Record<string, string>; unset: string[] } {
  // BROWSER=true keeps the CLI from opening a browser under this home; the
  // link is relayed to Connections instead.
  return { set: { HOME: home, XDG_RUNTIME_DIR: run, XDG_CONFIG_HOME: join(home, '.config'), BROWSER: 'true', NO_BROWSER: 'true' }, unset: ['DBUS_SESSION_BUS_ADDRESS'] };
}

export interface GeminiResearchCredentials { token: Record<string, unknown>; scope?: string }

async function readPrivateFile(path: string, max: number): Promise<string | null> {
  let file;
  try { file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const entry = await file.stat();
    if (!entry.isFile() || entry.size > max || (entry.mode & 0o077) !== 0 || (process.getuid && entry.uid !== process.getuid())) throw new Error('The Gemini research sign-in file is not private.');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}

/** The stored sign-in, or null when none was made. Values are never logged. */
export async function readGeminiResearchCredentials(): Promise<GeminiResearchCredentials | null> {
  const raw = await readPrivateFile(join(geminiResearchHome(), GEMINI_RESEARCH_TOKEN), MAX_TOKEN_BYTES);
  if (raw === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const token = (parsed as { token?: unknown }).token;
  if (!token || typeof token !== 'object' || typeof (token as { refresh_token?: unknown }).refresh_token !== 'string') return null;
  const scope = await readPrivateFile(join(geminiResearchHome(), GEMINI_RESEARCH_SCOPE), 1024).catch(() => null);
  return { token: parsed as Record<string, unknown>, ...(scope ? { scope } : {}) };
}

let expired = false;
/** A fenced turn found the sign-in rejected; cleared by the next sign-in. */
export function noteGeminiResearchSignInExpired(value: boolean): void { expired = value; }

export async function geminiResearchSignInState(): Promise<'missing' | 'ready' | 'expired'> {
  const credentials = await readGeminiResearchCredentials().catch(() => null);
  if (!credentials) return 'missing';
  return expired ? 'expired' : 'ready';
}
