import type { AuthStatus, AuthStatusByProvider, ConnectionCatalog, ConnectionDefinition } from '@arco/shared';

export const KINDS = [
  { id:'plan', label:'Provider sign-in', description:'Use a provider-owned tool and an eligible account. A subscription is not an API key.' },
  { id:'api', label:'API keys', description:'Use credentials authorized for the configured endpoint. Billing depends on the provider and endpoint; a key is not a universal subscription login.' },
  { id:'local', label:'Local models', description:'Connect a separately installed runtime. No models are installed by this screen.' },
  { id:'desktop', label:'Desktop integrations', description:'Integrations that need a compatible application on the Arco server.' },
  { id:'tool', label:'Tool accounts', description:'Accounts for features such as GitHub. These do not provide AI models.' },
] as const;
const IDS = ['claude','codex','gemini','cursor','zai','ollama','lmstudio','strata','llamacpp','deepseek','antigravity','github'];
export function parseConnectionCatalog(body: unknown): ConnectionCatalog | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as ConnectionCatalog;
  if (b.version !== 1 || !['docker','host'].includes(b.deployment) || typeof b.checkedOn !== 'string' || !Array.isArray(b.providers) || !Array.isArray(b.environmentKeys) || !b.environmentKeys.every(k=>typeof k==='string') || !b.zaiKey || typeof b.zaiKey.configured !== 'boolean') return null;
  const ids = new Set<string>();
  for (const p of b.providers) {
    if (!p || !IDS.includes(p.id) || ids.has(p.id) || !KINDS.some(k=>k.id===p.kind) || !['label','access','prerequisite','recovery','settingsSection'].every(k=>typeof p[k as keyof ConnectionDefinition]==='string')) return null;
    ids.add(p.id);
  }
  return ids.size === IDS.length ? b : null;
}
export function parseConnectionStatus(ok: boolean, body: unknown): AuthStatusByProvider | null {
  if (!ok || !body || typeof body !== 'object' || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  const result: Record<string, AuthStatus> = {};
  let reported = false;
  for (const id of IDS) {
    const status = input[id];
    if (status === undefined) {
      const unavailable = { installed: false, cliInstalled: false, loggedIn: false };
      result[id] = unavailable;
    } else {
      if (!status || typeof status !== 'object' || typeof (status as AuthStatus).loggedIn !== 'boolean') return null;
      result[id] = status as AuthStatus;
      reported = true;
    }
  }
  return reported ? result as unknown as AuthStatusByProvider : null;
}
export function connectionState(p: ConnectionDefinition, status: AuthStatus | undefined, enabled: boolean, docker: boolean): string {
  if (docker && p.kind === 'desktop') return 'Unavailable here';
  if (!enabled) return 'Disabled';
  if (!status || status.probeFailed) return 'Status unknown';
  if (p.id==='deepseek' && !status.loggedIn && !status.apiProvider) return 'Not set up';
  if (status.loggedIn) return p.kind === 'local' ? 'Runtime detected' : p.kind === 'desktop' ? 'Desktop detected' : 'Connected';
  return p.kind === 'local' || p.kind === 'desktop' ? 'Needs attention' : 'Not connected';
}
export function safeEndpoint(raw: string | undefined): string {
  try {
    const url = new URL(raw ?? '');
    if (!['http:','https:'].includes(url.protocol)) return '';
    return url.origin + (url.pathname === '/' ? '' : url.pathname);
  } catch { return ''; }
}
export function credentialSource(p: ConnectionDefinition, status: AuthStatus | undefined, catalog: ConnectionCatalog): string {
  if (p.id === 'zai') return catalog.zaiKey.configured ? `Key source: ${catalog.zaiKey.source}. Presence does not verify access.` : 'No key configured.';
  if (status?.accountStatuses?.length) return 'Configured account profiles; individual status is listed below.';
  if (p.kind === 'local') return 'Service availability; no account identity is reported.';
  if (p.kind === 'desktop') return 'Desktop detection only; account access is not verified.';
  if (status?.apiProvider === 'openai-api-key') return 'OpenAI API key reported active; API usage is billed separately.';
  if (status?.apiProvider === 'google-api-key') return 'Gemini API key reported active; review the provider account billing.';
  if (status?.apiProvider === 'chatgpt-oauth') return 'ChatGPT sign-in reported by Codex.';
  if (status?.apiProvider === 'google-oauth') return 'Google sign-in reported by Gemini CLI.';
  if (status?.loggedIn) return 'Provider-owned credentials detected. This check does not establish billing or model access.';
  return 'No active credential reported. Sign in or review provider settings.';
}
