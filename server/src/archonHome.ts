// The Arco home: global state, settings and provider logins. Internally it is
// still the Archon home, so the default stays `~/.archon` (on Windows
// `%USERPROFILE%\.archon`) and Archon and Arco share it. ARCHON_HOME relocates
// it; ARCO_HOME takes precedence (copied onto ARCHON_HOME by envAliases.ts).
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function archonHome(): string {
  const configured = process.env.ARCHON_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), '.archon');
}
