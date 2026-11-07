import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolveCodexHome(explicit?: string): string {
  return explicit ?? (process.env.CODEX_HOME || join(homedir(), '.codex'));
}
