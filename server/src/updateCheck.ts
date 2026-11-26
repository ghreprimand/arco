import type { AppUpdateAvailableMessage, AppUpdateStatusChangedMessage, UpdateCheckStatus } from '@arco/shared';

const GITHUB_LATEST = 'https://api.github.com/repos/ghreprimand/arco/releases/latest';
const NPM_LATEST = 'https://registry.npmjs.org/arco-workbench/latest';
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
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
  broadcast: (message: AppUpdateAvailableMessage | AppUpdateStatusChangedMessage) => void;
  fetch?: typeof fetch;
  environment?: () => string | undefined;
  packaged?: boolean;
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
  async function lookup(): Promise<{ latest: string; url: string; publishedAt: string | null }> {
    const response = await request(deps.packaged ? NPM_LATEST : GITHUB_LATEST, {
      headers: { Accept: deps.packaged ? 'application/json' : 'application/vnd.github+json', 'User-Agent': `arco/${deps.current}` },
      signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    if (!response.ok) throw new Error('Release check unavailable');
    if (deps.packaged) {
      const pkg = await response.json() as { name?: string; version?: string; dist?: { tarball?: string } };
      const version = pkg?.version;
      if (pkg?.name !== 'arco-workbench' || typeof version !== 'string' || !STABLE_VERSION.test(version) ||
          pkg.dist?.tarball !== `https://registry.npmjs.org/arco-workbench/-/arco-workbench-${version}.tgz`) throw new Error('Invalid npm release');
      const latest = `v${version}`;
      return { latest, url: RELEASE_PREFIX + latest, publishedAt: null };
    }
    const release = await response.json() as Record<string, unknown>;
    const tag = release?.tag_name;
    if (typeof tag !== 'string' || !STABLE_VERSION.test(tag.replace(/^v/, '')) ||
        typeof release.html_url !== 'string' || !release.html_url.startsWith(RELEASE_PREFIX) ||
        typeof release.published_at !== 'string' || !Number.isFinite(Date.parse(release.published_at))) throw new Error('Invalid GitHub release');
    return { latest: `v${tag.replace(/^v/, '')}`, url: release.html_url, publishedAt: release.published_at };
  }
  async function perform(): Promise<UpdateCheckStatus> {
    if (!enabled(await deps.settings())) return status();
    const checkedAt = now().toISOString();
    let release;
    try { release = await lookup(); } catch { /* Record the source of the failed check without exposing upstream detail. */ }
    const settings = await deps.settings();
    if (!enabled(settings)) return status();
    const previous = cache;
    if (release) {
      const order = compareVersions(release.latest, deps.current);
      cache = { ...release, current: deps.current, enabled: true, checkedAt, updateAvailable: order === 1 };
    } else {
      const checkFailure = deps.packaged ? 'npm' : 'github';
      cache = { ...cache, checkedAt, updateAvailable: false, checkFailure };
      if (!loggedFailure) { loggedFailure = true; deps.debug?.(`Release check unavailable (${checkFailure}); retrying on the next scheduled check.`); }
    }
    if (previous.latest !== cache.latest || previous.checkFailure !== cache.checkFailure || previous.updateAvailable !== cache.updateAvailable) {
      deps.broadcast({ type: 'app_update_status_changed' });
    }
    const { latest, url, publishedAt } = cache;
    if (cache.updateAvailable && latest && url && settings.updateCheckDismissed !== latest && !announced.has(latest)) {
      announced.add(latest);
      deps.broadcast({ type: 'app_update_available', current: deps.current, latest, url, publishedAt });
      deps.log?.(`app_update_available ${latest}`);
    }
    return { ...cache, enabled: true };
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
