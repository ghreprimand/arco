import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import type { ProviderName, ProviderAccountProfile } from '@archon/shared';
import { readSettings } from './settings.js';
import { archonHome } from './archonHome.js';

export interface ResolvedProviderAccount {
  provider: ProviderName;
  profile: ProviderAccountProfile;
  codexHome?: string;
}

export function expandHomePath(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function defaultCodexHome(id: string): string {
  return join(archonHome(), 'provider-accounts', `codex-${id}`);
}

export function accountShortLabel(profile: ProviderAccountProfile): string {
  const raw = (profile.shortLabel || profile.label || profile.id).trim();
  return (raw || profile.id).slice(0, 4).toUpperCase();
}

export async function configuredAccounts(provider: 'codex' | 'claude', cwd?: string): Promise<ProviderAccountProfile[]> {
  const settings = await readSettings(cwd).catch(() => null);
  return settings?.providerAccounts?.[provider] ?? [];
}

export async function resolveProviderAccount(
  provider: ProviderName,
  accountRef: string | undefined,
  cwd?: string,
): Promise<ResolvedProviderAccount | null> {
  if (provider !== 'codex' && provider !== 'claude') return null;
  const accounts = await configuredAccounts(provider, cwd);
  if (accounts.length === 0) return null;
  const profile = (accountRef ? accounts.find((a) => a.id === accountRef) : undefined) ?? accounts[0];
  if (!profile) return null;
  if (provider === 'codex') {
    return {
      provider,
      profile,
      codexHome: resolve(expandHomePath(profile.codexHome || defaultCodexHome(profile.id))),
    };
  }
  return { provider, profile };
}

export async function ensureCodexAccountHome(codexHome: string): Promise<void> {
  await mkdir(codexHome, { recursive: true });
  const configPath = join(codexHome, 'config.toml');
  let existing = '';
  try {
    existing = await readFile(configPath, 'utf8');
  } catch {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, 'cli_auth_credentials_store = "file"\n', 'utf8');
    return;
  }
  if (!/^\s*cli_auth_credentials_store\s*=/m.test(existing)) {
    const next = existing.trimEnd() + '\ncli_auth_credentials_store = "file"\n';
    await writeFile(configPath, next, 'utf8');
  }
}
