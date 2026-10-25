import { readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

import { describeConfigValue, resolveConfigValue } from './configValue.js';
import { atomicWriteFile } from './atomicFile.js';

// `env` = ZAI_API_KEY directly set in the process environment (overrides the
// file, input disabled in the UI). DD12 adds the indirect FILE-stored forms:
// `command` (`!op read …`) and `env-ref` (`${ZAI_KEY}`) — resolved on demand,
// never persisted/logged. `file` = a literal stored key. `none` = unconfigured.
type SecretSource = 'env' | 'file' | 'command' | 'env-ref' | 'none';

interface ProviderSecretsFile {
  zaiApiKey?: string;
}

const SECRETS_PATH = join(homedir(), '.archon', 'provider-secrets.json');

async function readSecretsFile(): Promise<ProviderSecretsFile> {
  try {
    const raw = await readFile(SECRETS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const r = parsed as Record<string, unknown>;
    const out: ProviderSecretsFile = {};
    if (typeof r.zaiApiKey === 'string' && r.zaiApiKey.trim()) out.zaiApiKey = r.zaiApiKey.trim();
    return out;
  } catch {
    return {};
  }
}

async function writeSecretsFile(secrets: ProviderSecretsFile): Promise<void> {
  await atomicWriteFile(SECRETS_PATH, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600 });
}

export async function readZaiApiKey(): Promise<string | undefined> {
  const envKey = process.env.ZAI_API_KEY?.trim();
  if (envKey) return envKey;
  const stored = (await readSecretsFile()).zaiApiKey?.trim();
  if (!stored) return undefined;
  // DD12 — the stored value may be a literal key, a `!cmd`, or a `${ENV}` ref.
  // Resolve on demand; a resolution failure yields undefined (no key) rather
  // than leaking the raw ref. The resolved value is never logged.
  const resolved = await resolveConfigValue(stored);
  return resolved.value?.trim() || undefined;
}

export async function zaiApiKeyStatus(): Promise<{ configured: boolean; source: SecretSource }> {
  if (process.env.ZAI_API_KEY?.trim()) return { configured: true, source: 'env' };
  const stored = (await readSecretsFile()).zaiApiKey?.trim();
  if (!stored) return { configured: false, source: 'none' };
  // Introspect WITHOUT resolving — never spawn the command or read the env value
  // just to render a badge. `command` / `env` are "configured" even though the
  // value lives elsewhere; a plain stored string is `file`.
  const kind = describeConfigValue(stored).kind;
  const source: SecretSource = kind === 'command' ? 'command' : kind === 'env' ? 'env-ref' : 'file';
  return { configured: true, source };
}

export async function saveZaiApiKey(apiKey: string): Promise<{ configured: boolean; source: SecretSource }> {
  const cleaned = apiKey.trim();
  if (!cleaned || /[\r\n]/.test(cleaned) || cleaned.length > 4096) {
    throw new Error('invalid Z.ai API key');
  }
  const secrets = await readSecretsFile();
  secrets.zaiApiKey = cleaned;
  await writeSecretsFile(secrets);
  return zaiApiKeyStatus();
}

export async function clearZaiApiKey(): Promise<{ configured: boolean; source: SecretSource }> {
  const secrets = await readSecretsFile();
  delete secrets.zaiApiKey;
  await writeSecretsFile(secrets);
  return zaiApiKeyStatus();
}
