import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveCommand } from '../../windowsCommand.js';

let authState: 'unknown' | 'ready' | 'rejected' = 'unknown';
let models: string[] = [];
let capabilities: Record<string, { tools: boolean; vision: boolean; thinking: boolean; thinkingLevels: string[] }> = {};
let lastProbe = 0;
const exec = promisify(execFile);
export function noteAntigravityLoginCompleted(): void { authState = 'ready'; }
export function noteAntigravityTurnSuccess(): void { authState = 'ready'; }
export function noteAntigravitySignInRequired(): void { authState = 'rejected'; }
export async function antigravityStatus(): Promise<{ loggedIn: boolean; probeFailed: boolean; error?: string; signInRejected?: boolean; installedModels: string[]; installedModelCapabilities: typeof capabilities }> {
  if (Date.now() - lastProbe > 60_000) {
    lastProbe = Date.now();
    try {
      const agy = resolveCommand('agy', ['models'], { fresh: true });
      const { stdout } = await exec(agy.command, agy.args, { timeout: 10_000, maxBuffer: 256 * 1024, ...(agy.env ? { env: agy.env } : {}) });
      const ids = stdout.split(/\r?\n/).map(line => line.split(/\s+/)[0]).filter(id => /^gemini-[a-z0-9.-]+$/.test(id));
      models = [...new Set(ids.map(id => id.replace(/-(low|medium|high|xhigh)$/, '')))];
      capabilities = Object.fromEntries(models.map(model => { const levels = ['low', 'medium', 'high', 'xhigh'].filter(level => ids.includes(`${model}-${level}`)); return [model, { tools: true, vision: true, thinking: levels.length > 0, thinkingLevels: levels }]; }));
    } catch { models = []; capabilities = {}; }
  }
  return { loggedIn: authState === 'ready', probeFailed: authState === 'unknown', ...(authState === 'unknown' ? { error: 'Sign-in status is unknown until an interactive turn.' } : authState === 'rejected' ? { signInRejected: true, error: 'Antigravity needs sign-in. Run agy acp --login.' } : {}), installedModels: models, installedModelCapabilities: capabilities };
}
