// The Arco home: global state, settings and provider logins. Defaults to
// `~/.arco` (on Windows `%USERPROFILE%\.arco`); ARCO_HOME relocates it
// (envAliases.ts fills ARCO_HOME from the upstream-prefixed name when only
// that one is set).
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function arcoHome(): string {
  const configured = process.env.ARCO_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), '.arco');
}
