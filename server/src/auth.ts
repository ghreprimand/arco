import { authLoginInstructions } from './authLoginInstructions.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { access, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import {} from '@arco/shared';
import type { ProviderName, AuthLoginTarget, AuthLoginResult } from '@arco/shared';
import { getOllamaBase, probeOllama } from './providers/ollama.js';
import { probeCodexLoggedIn } from './providers/codex.js';
import { probeLlamacpp } from './providers/llamacpp.js';
import { getDeepSeekBase, probeDeepSeek } from './providers/deepseek.js';
import { getStrataBase, probeStrata } from './providers/strata.js';
import { getLmstudioBase, probeLmstudio } from './providers/lmstudio.js';
import { accountShortLabel, configuredAccounts, ensureCodexAccountHome, resolveProviderAccount } from './providerAccounts.js';
import { readCursorAccessToken } from './providers/cursor/authToken.js';
import { commandArgs } from './windowsCommand.js';

const execFileAsync = promisify(execFile);

export interface AuthStatus {
  loggedIn: boolean;
  probeFailed?: boolean;
  email?: string;
  subscriptionType?: string;
  orgName?: string;
  apiProvider?: string;
  error?: string;
  accountStatuses?: Array<{
    id: string;
    label: string;
    shortLabel?: string;
    loggedIn: boolean;
    email?: string;
    apiProvider?: string;
    error?: string;
  }>;
  installedModels?: string[];
  installedModelLabels?: Record<string, string>;
  // Ollama-only: per-model capability badges + Modelfile-configured num_ctx
  // (plan §6.3). Drives picker badges (e.g. "tools" / "vision") and the
  // CTX-bar default before any turn fires. Other providers leave this unset.
  installedModelCapabilities?: Record<string, {
    tools: boolean;
    vision: boolean;
    thinking: boolean;
    numCtx?: number;
    // Ollama graded thinking (ascending) — drives the per-model effort picker.
    thinkingLevels?: string[];
    thinkingCanDisable?: boolean;
  }>;
}

export interface AuthStatusByProvider {
  claude: AuthStatus;
  gemini: AuthStatus;
  ollama: AuthStatus;
  codex: AuthStatus;
  github: AuthStatus;
  // llama.cpp: loggedIn == llama-server binary present + ~/.arco/llamacpp.json
  // parses cleanly. Models from the catalog populate installedModels +
  // installedModelCapabilities so the picker UI works identically to Ollama's.
  llamacpp: AuthStatus;
  // LM Studio (M13): loggedIn == GET <baseUrl>/v1/models reachable. Discovered
  // model ids populate installedModels so the picker behaves like Ollama's. No
  // auth flow — it's a local/self-hosted OpenAI-compatible endpoint.
  lmstudio: AuthStatus;
  strata: AuthStatus;
  deepseek: AuthStatus;
  // Cursor (ACP): loggedIn == ~/.config/cursor/auth.json has a session token
  // that `cursor-agent` maintains. Arco doesn't run the login flow — the
  // operator authenticates once via `cursor-agent login`.
  cursor: AuthStatus;
}

// Shell out to `claude auth status --json`. Safe to call repeatedly; the
// CLI exits fast (it just reads local credentials + probes metadata).
//
// A probe that fails outright (timeout under load, wake-from-sleep, non-JSON)
// is NOT "logged out". It used to be: one flaky probe flipped loggedIn=false,
// the client stopped polling, and the header chip stuck red until clicked —
// the near-daily false "re-login" prompt. Now only a parsed `loggedIn:false`
// counts; a failed probe retries once, then reports the last known answer
// flagged `probeFailed`.
let lastClaudeStatus: AuthStatus | null = null;

async function probeClaudeAuthStatus(): Promise<AuthStatus | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(...commandArgs('claude', ['auth', 'status', '--json']), {
      maxBuffer: 256 * 1024,
      timeout: 10_000,
    }));
  } catch (err) {
    // A logged-out CLI may exit non-zero with the JSON verdict still on stdout.
    const out = (err as { stdout?: unknown }).stdout;
    if (typeof out !== 'string' || !out.trim()) return null;
    stdout = out;
  }
  try {
    const parsed = JSON.parse(stdout);
    return {
      loggedIn: Boolean(parsed.loggedIn),
      email: parsed.email,
      subscriptionType: parsed.subscriptionType,
      orgName: parsed.orgName,
      apiProvider: parsed.apiProvider,
    };
  } catch {
    return null;
  }
}

export async function getClaudeAuthStatus(): Promise<AuthStatus> {
  const status = (await probeClaudeAuthStatus()) ?? (await probeClaudeAuthStatus());
  if (status) {
    lastClaudeStatus = status;
    return status;
  }
  const error = 'claude auth status probe failed (timeout or unparseable output)';
  if (lastClaudeStatus) return { ...lastClaudeStatus, probeFailed: true, error };
  return { loggedIn: false, probeFailed: true, error };
}

// Gemini CLI authenticates either via Google OAuth (writes
// ~/.gemini/oauth_creds.json) or via the GEMINI_API_KEY env var. There's no
// `gemini auth status` command; we inspect the filesystem directly.
async function getGeminiAuthStatus(): Promise<AuthStatus> {
  if (process.env.GEMINI_API_KEY) {
    return { loggedIn: true, apiProvider: 'google-api-key' };
  }
  const credsPath = join(homedir(), '.gemini', 'oauth_creds.json');
  try {
    await access(credsPath);
    const st = await stat(credsPath);
    if (!st.size) return { loggedIn: false };
  } catch {
    return { loggedIn: false };
  }
  let email: string | undefined;
  try {
    const raw = await readFile(join(homedir(), '.gemini', 'google_accounts.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.active === 'string' && parsed.active) {
      email = parsed.active;
    }
  } catch { /* optional — just skip the email */ }
  return {
    loggedIn: true,
    email,
    apiProvider: 'google-oauth',
    subscriptionType: 'gemini-cli',
  };
}

// `gh auth status` exits non-zero when not logged in and prints to stderr.
// We shell out, then parse the active account / scopes. The `--active` flag
// restricts to the currently-active host/account so multi-host users don't
// produce ambiguous status.
async function getGithubAuthStatus(): Promise<AuthStatus> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'status', '--active'], {
      maxBuffer: 256 * 1024,
      timeout: 10_000,
    });
    const account = stdout.match(/Logged in to \S+ account (\S+)/)?.[1];
    const scopes = stdout.match(/Token scopes: (.+)/)?.[1];
    return {
      loggedIn: Boolean(account),
      email: account,
      apiProvider: 'github-cli',
      subscriptionType: scopes ? `gh (${scopes.replace(/'/g, '')})` : 'gh',
    };
  } catch (err) {
    return {
      loggedIn: false,
      error: err instanceof Error && 'stderr' in err ? String((err as { stderr: string }).stderr).slice(0, 200) : 'gh auth status failed',
    };
  }
}

// Ollama is auth-less — there's no login flow. The "loggedIn" semantics here
// just mean "the local daemon is up and responding on the configured port".
// Operator starts/stops it themselves (`ollama serve`); we just probe.
// Codex CLI uses ChatGPT OAuth (or an OPENAI_API_KEY env var fallback). The
// `codex login status` subcommand prints "Logged in using ChatGPT" or similar
// when authed. We parse for "logged in" loosely so wording drifts don't break
// the check.
async function getCodexAuthStatus(): Promise<AuthStatus> {
  const accounts = await configuredAccounts('codex').catch(() => []);
  if (accounts.length > 0) {
    const accountStatuses = await Promise.all(accounts.map(async (profile) => {
      const resolved = await resolveProviderAccount('codex', profile.id).catch(() => null);
      const codexHome = resolved?.codexHome;
      try {
        if (codexHome) await ensureCodexAccountHome(codexHome);
        const probe = await probeCodexLoggedIn(codexHome);
        return {
          id: profile.id,
          label: profile.label,
          shortLabel: accountShortLabel(profile),
          loggedIn: probe.loggedIn,
          ...(probe.account ? { email: probe.account } : {}),
          apiProvider: 'chatgpt-oauth',
          ...(!probe.loggedIn ? { error: probe.raw || 'not authenticated' } : {}),
        };
      } catch (err) {
        return {
          id: profile.id,
          label: profile.label,
          shortLabel: accountShortLabel(profile),
          loggedIn: false,
          apiProvider: 'chatgpt-oauth',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }));
    return {
      loggedIn: accountStatuses.some((a) => a.loggedIn),
      apiProvider: 'chatgpt-oauth',
      subscriptionType: 'codex-cli',
      accountStatuses,
      ...(!accountStatuses.some((a) => a.loggedIn) ? { error: 'no configured Codex profile is authenticated' } : {}),
    };
  }
  if (process.env.OPENAI_API_KEY) {
    // Env-var fallback — Codex will use this transparently.
    return { loggedIn: true, apiProvider: 'openai-api-key' };
  }
  try {
    const probe = await probeCodexLoggedIn();
    if (!probe.loggedIn) {
      return { loggedIn: false, error: probe.raw || 'not authenticated' };
    }
    return {
      loggedIn: true,
      apiProvider: 'chatgpt-oauth',
      subscriptionType: 'codex-cli',
      email: probe.account,
    };
  } catch (err) {
    return {
      loggedIn: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function getOllamaAuthStatus(): Promise<AuthStatus> {
  const probe = await probeOllama();
  const apiProvider = `ollama:${await getOllamaBase()}`;
  if (!probe.up) {
    return {
      loggedIn: false,
      apiProvider,
      error: probe.error || 'daemon not reachable',
    };
  }
  return {
    loggedIn: true,
    apiProvider,
    subscriptionType: 'local',
    installedModels: probe.models,
    ...(probe.capabilities ? { installedModelCapabilities: probe.capabilities } : {}),
  };
}

async function getLlamacppAuthStatus(): Promise<AuthStatus> {
  const probe = await probeLlamacpp();
  if (!probe.up) {
    return {
      loggedIn: false,
      apiProvider: 'llamacpp-localhost',
      error: probe.error || 'llama-server unavailable',
    };
  }
  return {
    loggedIn: true,
    apiProvider: 'llamacpp-localhost',
    subscriptionType: 'local',
    installedModels: probe.models,
    ...(probe.capabilities ? { installedModelCapabilities: probe.capabilities } : {}),
  };
}

async function getLmstudioAuthStatus(): Promise<AuthStatus> {
  const base = await getLmstudioBase();
  const probe = await probeLmstudio();
  const apiProvider = `lmstudio:${base}`;
  if (!probe.up) {
    return {
      loggedIn: false,
      apiProvider,
      error: probe.error || 'LM Studio server not reachable',
    };
  }
  return {
    loggedIn: true,
    apiProvider,
    subscriptionType: 'local',
    installedModels: probe.models,
    ...(probe.capabilities ? { installedModelCapabilities: probe.capabilities } : {}),
  };
}

async function getStrataAuthStatus(): Promise<AuthStatus> {
  const base = await getStrataBase();
  const probe = await probeStrata();
  const apiProvider = `strata:${base}`;
  if (!probe.up) {
    return {
      loggedIn: false,
      apiProvider,
      error: probe.error || 'Strata server not reachable',
    };
  }
  return {
    loggedIn: true,
    apiProvider,
    subscriptionType: 'local',
    installedModels: probe.models,
    installedModelLabels: probe.labels,
    ...(probe.capabilities ? { installedModelCapabilities: probe.capabilities } : {}),
  };
}

async function getDeepSeekAuthStatus(): Promise<AuthStatus> {
  const base = await getDeepSeekBase();
  const probe = await probeDeepSeek();
  const apiProvider = `deepseek:${base}`;
  if (!probe.up) {
    return {
      loggedIn: false,
      apiProvider,
      error: probe.error || 'DeepSeek server not reachable',
    };
  }
  return {
    loggedIn: true,
    apiProvider,
    subscriptionType: 'local',
    installedModels: probe.models,
    installedModelLabels: probe.labels,
    ...(probe.capabilities ? { installedModelCapabilities: probe.capabilities } : {}),
  };
}

// Cursor stores a cursor.com session JWT that `cursor-agent` refreshes in the
// background — auth.json on Linux, the login keychain on macOS. loggedIn == a
// token is readable. No `cursor-agent auth status --json` command exists, so
// we inspect the store directly (readCursorAccessToken owns the platform split).
async function getCursorAuthStatus(): Promise<AuthStatus> {
  const result = await readCursorAccessToken();
  if (result.token === null) {
    return { loggedIn: false, error: result.detail ?? 'Not signed in to Cursor — run `cursor-agent login`' };
  }
  return { loggedIn: true, apiProvider: 'cursor-session', subscriptionType: 'cursor' };
}

export async function getAuthStatus(): Promise<AuthStatusByProvider> {
  const [claude, gemini, ollama, codex, github, llamacpp, lmstudio, strata, deepseek, cursor] = await Promise.all([
    getClaudeAuthStatus(),
    getGeminiAuthStatus(),
    getOllamaAuthStatus(),
    getCodexAuthStatus(),
    getGithubAuthStatus(),
    getLlamacppAuthStatus(),
    getLmstudioAuthStatus(),
    getStrataAuthStatus(),
    getDeepSeekAuthStatus(),
    getCursorAuthStatus(),
  ]);
  return { claude, gemini, ollama, codex, github, llamacpp, lmstudio, strata, deepseek, cursor };
}

// Explicit Connections check: probe only the operator-selected integration.
// This reuses provider-owned detection and never starts an inference turn.
export async function getConnectionStatus(provider: AuthLoginTarget): Promise<AuthStatus> {
  const probes: Record<AuthLoginTarget, () => Promise<AuthStatus>> = {
    claude:getClaudeAuthStatus, codex:getCodexAuthStatus, gemini:getGeminiAuthStatus, github:getGithubAuthStatus, cursor:getCursorAuthStatus,
    ollama:getOllamaAuthStatus, lmstudio:getLmstudioAuthStatus, strata:getStrataAuthStatus,
    llamacpp:getLlamacppAuthStatus, deepseek:getDeepSeekAuthStatus,
  };
  return probes[provider]();
}

// Terminal login commands remain available in Arco (a PTY on the server).
// Connections can explicitly request a relayed session through the HTTP route. Each command below is the CLI's headless mode; it prints a
// URL / device code (and a paste prompt where the flow needs one) instead of
// requiring a browser on this machine, so it works identically at the desk,
// from a laptop over the tailnet, or from a phone. Prior incident: the old
// path ran `claude auth login` detached with stdio ignored (and the rest via a
// desktop terminal emulator) — no browser/display meant a silent no-op, and
// remotely the browser opened on the wrong machine.
//
// Commands are POSIX-quoted and use `env VAR=…` so they paste into bash, zsh,
// or fish alike.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const TERMINAL_HINT = 'Run it in Arco\'s terminal (TOOLS → TERMINAL) — it prints a link/code to open on whatever device you\'re using.';

export async function triggerAuthLogin(provider: AuthLoginTarget = 'claude', accountRef?: string): Promise<AuthLoginResult> {
  if (provider === 'claude') {
    // Prints the authorize URL + a "Paste code here" prompt when no browser
    // opens; at the desk it also opens the local browser and completes itself.
    const command = 'claude auth login --claudeai';
    return authLoginInstructions(command, 'Sign in, then paste the code it shows back into the terminal.');
  }
  if (provider === 'gemini') {
    // Gemini CLI has no `auth login` — OAuth runs inside the interactive TUI.
    // NO_BROWSER switches it to the print-URL / paste-code flow.
    const command = 'env NO_BROWSER=true gemini';
    return authLoginInstructions(command, 'Finish the Google sign-in, then /quit.');
  }
  if (provider === 'codex') {
    const account = accountRef ? await resolveProviderAccount('codex', accountRef) : null;
    if (accountRef && !account) {
      return { started: false, manual: `Unknown Codex account profile: ${accountRef}` };
    }
    if (account?.codexHome) await ensureCodexAccountHome(account.codexHome);
    // Device-code auth: no localhost:1455 callback and no browser launch, so
    // it completes from any device. A profile's authBrowser (account
    // separation) is moot here — the operator picks the browser the link opens in.
    const command = `${account?.codexHome ? `env CODEX_HOME=${shellQuote(account.codexHome)} ` : ''}codex login --device-auth`;
    const label = account?.profile.label ? ` Sign in with the ${account.profile.label} ChatGPT account.` : '';
    return authLoginInstructions(command, `Open the link and enter the one-time code.${label}`);
  }

  if (provider === 'cursor') {
    // The JWT lands at ~/.config/cursor/auth.json, which getCursorAuthStatus /
    // cursorUsage read fresh on each poll. The CLI polls for completion, so no
    // paste step.
    const command = 'env NO_OPEN_BROWSER=1 cursor-agent login';
    return authLoginInstructions(command, 'Open the link it prints; it finishes on its own.');
  }
  if (provider === 'ollama') {
    // No login flow. Surface a hint instead so the UI can show actionable text
    // when the operator clicks the row's button.
    return {
      started: false,
      manual: 'Ollama has no auth. If the row reads "daemon not reachable", run `ollama serve` on this machine (or set OLLAMA_URL_BASE to point elsewhere).',
    };
  }
  if (provider === 'deepseek') return { started: false, manual: 'Use DeepSeek controls to load Exact or Light through the guarded Xolotl launcher. Endpoint defaults to http://127.0.0.1:8150/v1.' };
  if (provider === 'strata') return { started: false, manual: 'Start the standalone Strata service; configure settings.strata.baseUrl or STRATA_URL_BASE (default http://127.0.0.1:8081/v1).' };
  if (provider === 'lmstudio') {
    return {
      started: false,
      manual: 'LM Studio has no auth. If the row reads "server not reachable", start the LM Studio app and enable its local server (Developer → Start Server, default port 1234), then load a model. Set settings.lmstudio.baseUrl (or LMSTUDIO_URL_BASE) to point elsewhere.',
    };
  }
  if (provider === 'github') {
    // --web = device flow: prints a one-time code + github.com/login/device.
    const command = 'gh auth login --hostname github.com --git-protocol https --web';
    return authLoginInstructions(command, 'Open github.com/login/device and enter the one-time code.');
  }
  return { started: false, manual: `Unknown provider: ${provider}` };
}
