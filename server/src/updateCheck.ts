import type { AppUpdateAvailableMessage, UpdateCheckStatus } from '@arco/shared';

const ENDPOINT = 'https://api.github.com/repos/ghreprimand/arco/releases/latest';
const RELEASE_PREFIX = 'https://github.com/ghreprimand/arco/releases/tag/';
const SEMVER = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][\da-zA-Z-]*))*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/;

export function compareVersions(a: string, b: string): number | null {
  const x = SEMVER.exec(a), y = SEMVER.exec(b);
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = BigInt(x[i]) - BigInt(y[i]);
    if (d) return d > 0n ? 1 : -1;
  }
  if (!x[4] || !y[4]) return x[4] === y[4] ? 0 : x[4] ? -1 : 1;
  const xp = x[4].split('.'), yp = y[4].split('.');
  for (let i = 0; i < Math.max(xp.length, yp.length); i++) {
    if (xp[i] === undefined || yp[i] === undefined) return xp[i] === undefined ? -1 : 1;
    if (xp[i] === yp[i]) continue;
    const xn = /^\d+$/.test(xp[i]), yn = /^\d+$/.test(yp[i]);
    if (xn && yn) return BigInt(xp[i]) > BigInt(yp[i]) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return xp[i] > yp[i] ? 1 : -1;
  }
  return 0;
}

type Preferences = { updateCheck?: boolean; updateCheckDismissed?: string };
interface Dependencies {
  current: string;
  settings: () => Promise<Preferences>;
  broadcast: (message: AppUpdateAvailableMessage) => void;
  fetch?: typeof fetch;
  environment?: () => string | undefined;
  debug?: (message: string) => void;
  log?: (message: string) => void;
  now?: () => Date;
}

export function createUpdateChecker(deps: Dependencies) {
  const request = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => new Date());
  const enabled = (s: Preferences) => (deps.environment ?? (() => process.env.ARCO_UPDATE_CHECK))() !== '0' && s.updateCheck !== false;
  let cache: UpdateCheckStatus = { current: deps.current, latest: null, url: null, publishedAt: null, checkedAt: null, updateAvailable: false, enabled: true };
  let pending: Promise<UpdateCheckStatus> | undefined;
  let loggedFailure = false;
  const announced = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  async function status(): Promise<UpdateCheckStatus> {
    return { ...cache, enabled: enabled(await deps.settings()) };
  }
  async function perform(): Promise<UpdateCheckStatus> {
    if (!enabled(await deps.settings())) return status();
    cache.checkedAt = now().toISOString();
    try {
      const response = await request(ENDPOINT, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `arco/${deps.current}` },
        signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      if (!response.ok) throw new Error('release check unavailable');
      const release = await response.json() as Record<string, unknown>;
      const tag = release.tag_name;
      if (typeof tag !== 'string' || compareVersions(tag, deps.current) === null ||
          typeof release.html_url !== 'string' || !release.html_url.startsWith(RELEASE_PREFIX) ||
          typeof release.published_at !== 'string' || !Number.isFinite(Date.parse(release.published_at))) throw new Error('invalid release');
      const latest = `v${tag.replace(/^v/, '')}`;
      // Re-read preferences: an opt-out or dismissal can arrive during the request.
      const settings = await deps.settings();
      if (!enabled(settings)) return status();
      cache = { ...cache, latest, url: release.html_url, publishedAt: release.published_at, updateAvailable: compareVersions(tag, deps.current)! > 0 };
      if (cache.updateAvailable && settings.updateCheckDismissed !== latest && !announced.has(latest)) {
        announced.add(latest);
        const message: AppUpdateAvailableMessage = { type: 'app_update_available', current: deps.current, latest, url: release.html_url, publishedAt: release.published_at };
        deps.broadcast(message);
        deps.log?.(`app_update_available ${latest}`);
      }
    } catch {
      if (!loggedFailure) { loggedFailure = true; deps.debug?.('Release check unavailable; retrying on the next scheduled check.'); }
    }
    return status();
  }
  function check(): Promise<UpdateCheckStatus> {
    if (!pending) pending = perform().finally(() => { pending = undefined; });
    return pending;
  }
  function start() {
    if (timer) return;
    stopped = false;
    const tick = async () => {
      try { await check(); } catch { /* Settings read failures must not interrupt the server. */ }
      if (!stopped) { timer = setTimeout(tick, 6 * 60 * 60 * 1000); timer.unref(); }
    };
    timer = setTimeout(tick, 30_000);
    timer.unref();
  }
  function stop() { stopped = true; clearTimeout(timer); timer = undefined; }
  return { status, check, start, stop };
}
