// Startup gate: decides whether the first-run provider setup replaces the
// workspace. A provider outage (expired login, local daemon restarting) must
// never lock a returning operator out of saved work, so the full-screen setup
// is shown only when nothing says this installation has been used before.
// Pure so the onboarding tests can pin every branch.
import type { AuthStatus, AuthStatusByProvider, ProviderName } from '@arco/shared';
import { PRIMARY_PROVIDERS } from '@arco/shared';

export type StartupGate = 'workspace' | 'setup' | 'pending';

export interface StartupGateInput {
  // /api/auth-status has answered at least once.
  authKnown: boolean;
  // Machine-wide login status prefills setup, but never establishes home history.
  providerConnected: boolean;
  // The operator chose "continue without a provider" in this browser tab.
  setupDeferred: boolean;
  // Open tabs or clusters exist (server workspace, or this browser's copy).
  hasOpenWork: boolean;
  // A non-incognito workflow or saved Chat has existed here before
  // (GET /api/installation-history); null while unknown or unreadable.
  hasHistory: boolean | null;
  // The server's workspace snapshot has been applied in this page load.
  workspaceSynced: boolean;
  setupCompleted?: boolean;
}

export function startupGate(input: StartupGateInput): StartupGate {
  if (!input.authKnown) return 'workspace';
  if (input.setupCompleted || input.setupDeferred || input.hasOpenWork || input.hasHistory === true) return 'workspace';
  if (input.workspaceSynced && input.hasHistory === false) return 'setup';
  // Signals still loading: keep the workspace rather than flash the setup
  // screen at a returning operator.
  return 'pending';
}

export const INSTALLATION_HISTORY_URL = '/api/installation-history';

// Only a well-formed 2xx answer decides. A failed request, a non-2xx status or
// a malformed body stays unknown (null), which keeps the workspace up; it must
// never read as "first run".
export function parseInstallationHistory(ok: boolean, body: unknown): boolean | null {
  if (!ok || !body || typeof body !== 'object') return null;
  const used = (body as { used?: unknown }).used;
  return typeof used === 'boolean' ? used : null;
}

export async function fetchInstallationHistory(fetcher: typeof fetch = fetch): Promise<boolean | null> {
  try {
    const res = await fetcher(INSTALLATION_HISTORY_URL, { cache: 'no-store' });
    if (!res.ok) return null;
    return parseInstallationHistory(true, await res.json());
  } catch {
    return null;
  }
}

export function anyPrimaryProviderConnected(
  authStatus: Partial<AuthStatusByProvider> | null | undefined,
  isEnabled: (provider: ProviderName) => boolean,
): boolean {
  if (!authStatus) return false;
  return PRIMARY_PROVIDERS.some((provider) => isEnabled(provider) && authStatus[provider]?.loggedIn === true);
}

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  claude: 'Claude (Anthropic)',
  codex: 'Codex (OpenAI)',
  gemini: 'Gemini (Google)',
  cursor: 'Cursor',

  ollama: 'Ollama (local)',
  lmstudio: 'LM Studio (local)',
  llamacpp: 'llama.cpp (local)',
  strata: 'Strata (local)',
  deepseek: 'DeepSeek via Xolotl (local, optional)',
};

export const LOCAL_PROVIDERS: ProviderName[] = ['ollama', 'lmstudio', 'llamacpp', 'strata', 'deepseek'];

// Opt-in local runtimes with no default endpoint. Until the operator sets one
// they are "not set up", not "unreachable", and never count as an outage.
const OPT_IN_PROVIDERS: ReadonlySet<ProviderName> = new Set<ProviderName>(['deepseek']);
export function optInNotSetUp(provider: ProviderName, status: AuthStatus | undefined): boolean {
  return OPT_IN_PROVIDERS.has(provider) && !status?.loggedIn && !endpointOf(status);
}

export interface ProviderStatusLine {
  provider: ProviderName;
  label: string;
  detail: string;
}

function endpointOf(status: AuthStatus | undefined): string {
  const api = status?.apiProvider ?? '';
  const i = api.indexOf(':');
  const rest = i > 0 ? api.slice(i + 1) : '';
  return /^https?:\/\//.test(rest) ? rest : '';
}

// One plain-language line per enabled primary provider explaining why it is
// not usable right now. Local runtimes name the endpoint they tried.
export function disconnectedProviderLines(
  authStatus: Partial<AuthStatusByProvider> | null | undefined,
  isEnabled: (provider: ProviderName) => boolean,
): ProviderStatusLine[] {
  const lines: ProviderStatusLine[] = [];
  for (const provider of PRIMARY_PROVIDERS) {
    if (!isEnabled(provider)) continue;
    const status = authStatus?.[provider];
    if (status?.loggedIn || optInNotSetUp(provider, status)) continue;
    const local = LOCAL_PROVIDERS.includes(provider);
    const endpoint = endpointOf(status);
    const error = status?.error && status.error !== 'Not logged in' ? status.error.replace(/\s+/g, ' ').slice(0, 120) : '';
    let detail: string;
    if (local) detail = `not reachable${endpoint ? ` at ${endpoint}` : ''}${error ? ` (${error})` : ''}`;
    else detail = error ? `not signed in (${error})` : 'not signed in';
    lines.push({ provider, label: PROVIDER_LABELS[provider], detail });
  }
  return lines;
}

// Endpoint help shared by the setup screen and Settings. Inside the Docker
// image `localhost` is the container itself, not the operator's computer.
export const DOCKER_ENDPOINT_HELP =
  'If Arco runs in Docker, localhost means the container itself. For a model server on your computer use host.docker.internal instead, for example http://host.docker.internal:11434 (Ollama) or http://host.docker.internal:1234 (LM Studio).';

const DEFERRED_KEY = 'arco.providerSetupDeferred';

// Deferral lasts for this browser tab's session only: a reload keeps it, a new
// browser or tab asks again. It never pretends a provider is connected.
export function readSetupDeferred(): boolean {
  try { return sessionStorage.getItem(DEFERRED_KEY) === '1'; } catch { return false; }
}

export function writeSetupDeferred(deferred: boolean): void {
  try {
    if (deferred) sessionStorage.setItem(DEFERRED_KEY, '1');
    else sessionStorage.removeItem(DEFERRED_KEY);
  } catch { /* storage unavailable; the in-memory flag still applies */ }
}
