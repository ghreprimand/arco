// Runs Playwright browser smokes sequentially. UI suites use Vite with fixture APIs.
// Isolated-server suites use the built client and start temporary Arco servers with
// synthetic projects, denying CLI stubs and fixture providers (Linux only).
// Chromium comes from ARCO_TEST_CHROME or one shared lookup (never the temporary HOME).
// The whole run is re-executed inside an empty network namespace when the host allows
// it, so fixed Vite ports stay private to this process. ARCO_TEST_REQUIRE_NETNS=1
// refuses to start on the shared host network. ARCO_TEST_NETNS=0 opts out.
// Usage: node scripts/smoke/run-browser-suites.mjs [suite-name ...]   (default: every listed suite)
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { outputTail, runWithCiRetry } from './browser-suite-retry.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function networkWrapper() {
  if (process.env.ARCO_TEST_NETNS === '0' || process.platform !== 'linux') return undefined;
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const wrappers = [
    ['sh', '-c', `ip link set lo up && exec unshare -U --map-user=${uid} --map-group=${gid} "$@"`, 'sh'],
    ['sh', '-c', 'ip link set lo up && exec "$@"', 'sh'],
  ];
  return wrappers.find((wrapper) => spawnSync('unshare', ['-rn', ...wrapper, 'true'], { stdio: 'ignore' }).status === 0);
}

function resolveChrome() {
  if (process.env.ARCO_TEST_CHROME) return process.env.ARCO_TEST_CHROME;
  const found = spawnSync('python3', ['-c', 'import host_isolation; print(host_isolation.chrome_executable(), end="")'], {
    cwd: join(root, 'scripts/smoke'),
    encoding: 'utf8',
  });
  if (found.status !== 0) {
    console.error(found.stderr || 'Chromium lookup failed.');
    process.exit(1);
  }
  return (found.stdout || '').trim();
}

function playwrightBrowsersPath(chrome) {
  const marker = `${sep}ms-playwright${sep}`;
  const at = chrome.lastIndexOf(marker);
  return at < 0 ? '' : chrome.slice(0, at + marker.length - 1);
}

if (process.env.ARCO_BROWSER_NETNS_ACTIVE !== '1') {
  const wrapper = networkWrapper();
  if (!wrapper && process.env.ARCO_TEST_REQUIRE_NETNS === '1') {
    console.error('An isolated network namespace is required but unavailable. Refusing to run browser suites on the shared host network.');
    process.exit(1);
  }
  const chromeFromCaller = Boolean(process.env.ARCO_TEST_CHROME);
  const chrome = resolveChrome();
  if (!chrome) {
    console.error('Chromium was not found via ARCO_TEST_CHROME or the shared lookup. Refusing to search a temporary HOME.');
    process.exit(1);
  }
  const env = {
    ...process.env,
    ARCO_TEST_CHROME: chrome,
    CHROMIUM_PATH: process.env.CHROMIUM_PATH || chrome,
    ARCO_BROWSER_CHROME_SOURCE: chromeFromCaller ? 'ARCO_TEST_CHROME' : 'shared lookup',
  };
  const browsers = playwrightBrowsersPath(chrome);
  if (browsers && !env.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = browsers;
  if (wrapper) {
    env.ARCO_BROWSER_NETNS_ACTIVE = '1';
    env.ARCO_TEST_NETNS_ACTIVE = '1';
    const isolated = spawnSync('unshare', ['-rn', ...wrapper, process.execPath, ...process.argv.slice(1)], { cwd: root, env, stdio: 'inherit' });
    process.exit(isolated.status ?? 1);
  }
  Object.assign(process.env, env);
  console.error('note: browser suites are using the host network namespace; parallel runs can collide on fixed ports');
  console.log(`Chromium: ${env.ARCO_BROWSER_CHROME_SOURCE}.`);
} else {
  console.log(`Browser network: isolated namespace (loopback only). Chromium: ${process.env.ARCO_BROWSER_CHROME_SOURCE || 'ARCO_TEST_CHROME'}.`);
}
const SUITES = [
  { name: 'file-selection', script: 'file-selection-browser.py', port: 5291 },
  { name: 'cluster-coordination-wire', script: 'cluster-coordination-server.py', isolatedServer: true },
  { name: 'cluster-coordination', script: 'cluster-coordination-browser.py', port: 5206 },
  { name: 'form-controls', script: 'form-controls-browser.py', port: 5207 },
  { name: 'creator-defaults', script: 'creator-defaults-browser.py', port: 5208 },
  { name: 'creator-modes', script: 'creator-modes-browser.py', port: 5209 },
  { name: 'creator-templates', script: 'creator-templates-browser.py', port: 5210 },
  { name: 'auto-pickup', script: 'auto-pickup-browser.py', port: 5211 },
  { name: 'reauth-continuity', script: 'reauth-continuity-browser.py', port: 5203 },
  { name: 'workspace-rename', script: 'workspace-rename-browser.py', port: 5203 },
  { name: 'cluster-mail-visibility', script: 'cluster-mail-visibility-browser.py', port: 5203 },
  { name: 'cluster-member-panels', script: 'cluster-member-panels-browser.py', port: 5203 },
  { name: 'automatic-messages', script: 'automatic-messages-browser.py', port: 5265 },
  { name: 'add-worker-identity', script: 'add-worker-identity-browser.py', port: 5203 },
  { name: 'member-settings', script: 'member-settings-browser.py', port: 5203 },
  { name: 'nudge-all', script: 'nudge-all-browser.py', port: 5203 },
  { name: 'catch-me-up', script: 'catch-me-up-browser.py', port: 5225 },
  { name: 'dialog-sizes', script: 'dialog-sizes-browser.py', port: 5250 },
  { name: 'app-window-browser', script: 'app-window-browser-browser.py', port: 5252 },
  { name: 'auto-handoff', script: 'auto-handoff-browser.py', port: 5253 },
  { name: 'image-editor-lifecycle', script: 'image-editor-lifecycle-browser.py', port: 5254 },
  { name: 'composer-stability', script: 'composer-stability-browser.py', port: 5254 },
  { name: 'composer-status', script: 'composer-status-browser.py', port: 5254 },
  { name: 'tidy-composer', script: 'tidy-composer-browser.py', port: 5226 },
  { name: 'recall-close', script: 'recall-close-browser.py', port: 5227 },
  { name: 'utility-agent', script: 'utility-agent-browser.py', port: 5203 },
  { name: 'brief', script: 'brief-browser.py', port: 5203 },
  { name: 'quick-handoff', script: 'quick-handoff-browser.py', port: 5203 },
  { name: 'skills-menu', script: 'skills-menu-browser.py', port: 5238 },
  { name: 'tuneup-preview', script: 'tuneup-preview-browser.py', port: 5239 },
  { name: 'claude-allowance', script: 'claude-allowance-browser.py', port: 5203 },
  { name: 'claude-auth-status', script: 'claude-auth-status-browser.py', port: 5203 },
  { name: 'compaction-threshold', script: 'compaction-threshold-browser.py', port: 5203 },
  { name: 'turn-visibility', script: 'turn-visibility-browser.py', port: 5203 },
  { name: 'tab-status', script: 'tab-status-browser.py', port: 5203 },
  { name: 'peer-ordering', script: 'peer-ordering-browser.py', port: 5203 },
  { name: 'bakeoff', script: 'bakeoff-browser.py', port: 5202 },
  { name: 'location-clarity', script: 'location-clarity-browser.py', isolatedServer: true },
  { name: 'outputs', script: 'outputs-browser.py', port: 5201 },
  { name: 'outputs-open', script: 'outputs-open-browser.py', port: 5201 },
  { name: 'home-start-page', script: 'home-start-page-browser.py', port: 5196 },
  { name: 'home-density', script: 'home-density-browser.py', port: 5207 },
  { name: 'project-roots', script: 'project-roots-browser.py', isolatedServer: true },
  { name: 'first-run', script: 'first-run-browser.py', isolatedServer: true },
  { name: 'preview-isolation', script: 'preview-isolation-browser.py', isolatedServer: true },
  { name: 'https-cookie', script: 'https-cookie-browser.py', isolatedServer: true },
  { name: 'origin-boundary', script: 'origin-boundary-browser.py', isolatedServer: true },
  { name: 'connections', script: 'connections-browser.py', isolatedServer: true },
  { name: 'update-reconnect', script: 'update-reconnect-browser.py', isolatedServer: true },
  { name: 'update-action', script: 'update-action-browser.py', port: 5198 },
  { name: 'update-notice', script: 'update-notice-browser.py', port: 5198 },
  { name: 'topbar', script: 'topbar-browser.py', port: 5203 },
  { name: 'popover-placement', script: 'popover-placement-browser.py', port: 5251 },
  { name: 'version-box', script: 'version-box-browser.py', port: 5198 },
  { name: 'cluster-surface', script: 'cluster-surface-browser.py', port: 5231 },
  { name: 'terminal-sessions', script: 'terminal-sessions-browser.py', port: 5233 },
  { name: 'turn-changes', script: 'turn-changes-browser.py', port: 5234 },
  { name: 'storage-warning', script: 'storage-warning-browser.py', port: 5249 },
  { name: 'artifact-copy', script: 'artifact-copy-browser.py', isolatedServer: true },
  { name: 'architecture-review', script: 'architecture-review-browser.py', isolatedServer: true },
  { name: 'skill-management', script: 'skill-management-browser.py', isolatedServer: true },
  { name: 'artifacts', script: 'artifacts-browser.py', port: 5255 },
  { name: 'plans-library', script: 'plans-library-browser.py', port: 5247 },
  { name: 'storage-view', script: 'storage-view-browser.py', isolatedServer: true },
  { name: 'layout-ranges', script: 'layout-ranges-browser.py', isolatedServer: true },
  { name: 'public-plan-server', script: 'public-plan-server.py', isolatedServer: true },
  { name: 'public-project', script: 'public-project-browser.py', port: 5246 },
  { name: 'board-release', script: 'board-release-browser.py', port: 5245 },
  { name: 'cursor-segments', script: 'cursor-segments-browser.py', port: 5232 },
  { name: 'git-dialog', script: 'git-dialog-browser.py', port: 5233 },
  { name: 'spawn-member', script: 'spawn-member-browser.py', port: 5234 },
  { name: 'second-opinion', script: 'second-opinion-browser.py', port: 5236 },
  { name: 'forward-messages', script: 'forward-messages-browser.py', port: 5235 },
  { name: 'git-other-work', script: 'git-other-work-browser.py', port: 5237 },
  { name: 'phosphor-demo', script: 'phosphor-demo-browser.py', port: 5178 },
  { name: 'computer-panel', script: 'computer-panel-browser.py', port: 5193 },
  { name: 'deepseek', script: 'deepseek-browser.py', port: 5197 },
  { name: 'operator-questions', script: 'operator-questions-browser.py', port: 5187 },
  { name: 'voice-scroll', script: 'voice-scroll-browser.py', port: 5195 },
  { name: 'help-docs', script: 'help-docs-browser.py', port: 5179 },
  { name: 'help-coverage', script: 'help-coverage-browser.py', port: 5179 },
  { name: 'selected-control-contrast', script: 'selected-control-contrast-browser.py', port: 5205 },
  { name: 'phosphor-production', script: 'phosphor-production-browser.py', port: 5179 },
  { name: 'dialog-opaque', script: 'dialog-opaque-browser.py', port: 5203 },
  { name: 'notification-target', script: 'notification-target-browser.py', port: 5203 },
  { name: 'notifications-settings', script: 'notifications-settings-browser.py', port: 5203 },
  { name: 'voice', script: 'voice-browser.py', port: 5193 },
  { name: 'interrupt-send', script: 'interrupt-send-browser.py', port: 5194 },
  { name: 'upload-attach', script: 'upload-attach-browser.py', port: 5227 },
  { name: 'unstyled-buttons', script: 'unstyled-buttons-browser.py', port: 5228 },
  { name: 'settings-text-color', script: 'settings-text-color-browser.py', port: 5255 },
  { name: 'theme-controls', script: 'theme-controls-browser.py', port: 5256 },
  { name: 'chat-timeline-order', script: 'chat-timeline-order-browser.py', port: 5262 },
  { name: 'cluster-create-tabs', script: 'cluster-create-tabs-browser.py', port: 5263 },
];
// Suites known to fail are listed here with the board task that tracks them.
const KNOWN_FAILING = [];
const wanted = process.argv.slice(2);
const pool = process.env.ARCO_BROWSER_INCLUDE_KNOWN_FAILING === '1' ? [...SUITES, ...KNOWN_FAILING] : SUITES;
const selected = wanted.length ? pool.filter((s) => wanted.includes(s.name)) : pool;
if (!selected.length) { console.error('No matching browser suites.'); process.exit(2); }

const viteBin = join(root, 'node_modules/vite/bin/vite.js');
const hostedCi = process.env.CI === 'true';
const harnessTests = [
  [process.execPath, ['--test', join(root, 'scripts/smoke/browser-suite-retry.test.mjs')]],
  [process.execPath, ['--test', join(root, 'scripts/smoke/browser-suite-isolation.test.mjs')]],
  ['python3', [join(root, 'scripts/smoke/browser_navigation.test.py')]],
];
for (const [command, args] of harnessTests) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: 'inherit', timeout: 30_000 });
  if (result.status !== 0) {
    console.error(`Browser smoke harness check failed: ${command} ${args.join(' ')}`);
    process.exit(1);
  }
}
const emitRun = (run) => {
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  if (run.error) console.error(run.error.message);
};
const runPython = (suite, env = process.env) => spawnSync('python3', [join(root, 'scripts/smoke', suite.script)], {
  cwd: root,
  env,
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
  // The full theme inventory visits every surface at four theme/viewport pairs.
  timeout: suite.name === 'theme-controls' ? 420_000 : 240_000,
});
async function runSuite(suite, env = process.env) {
  const result = await runWithCiRetry(() => runPython(suite, env), { ci: hostedCi });
  emitRun(result.first);
  if (result.status === 'flaky') {
    const tail = outputTail(result.first) || result.first.error?.message || `exit ${result.first.status}`;
    console.log(`FLAKY: ${suite.name}\nFirst attempt failure tail:\n${tail}`);
  } else if (result.status === 'fail' && result.retry) {
    emitRun(result.retry);
    console.error(`browser suite ${suite.name}: failed again on CI retry`);
  }
  if (result.status === 'flaky') emitRun(result.retry);
  return result.status;
}
// Each script expects its own fixed port. If another process already serves it,
// the readiness probe below would succeed against that process and the suite
// would test a different app, so refuse the suite instead.
const portFree = (port) => new Promise((done) => {
  const probe = createServer().once('error', () => done(false)).once('listening', () => probe.close(() => done(true)));
  probe.listen(port, '127.0.0.1');
});
if (selected.some((suite) => suite.isolatedServer) && process.platform === 'linux') {
  const selfCheck = spawnSync('python3', [join(root, 'scripts/smoke/host_isolation_test.py')], { cwd: root, env: process.env, stdio: 'inherit', timeout: 30_000 });
  if (selfCheck.status !== 0) { console.error('Host isolation self-check failed.'); process.exit(1); }
}
const results = [];
const suiteRunStartedAt = performance.now();
for (const suite of selected) {
  const suiteStartedAt = performance.now();
  const elapsed = () => `${((performance.now() - suiteStartedAt) / 1000).toFixed(1)}s`;
  if (suite.isolatedServer) {
    if (process.platform !== 'linux') {
      console.log(`browser suite ${suite.name}: skipped (isolated-server harness requires Linux; ${elapsed()})`);
      results.push({ ...suite, status: 'skip' });
      continue;
    }
    let status = 'fail';
    if (!existsSync(join(root, 'client/dist/index.html'))) console.error(`${suite.name}: built client missing; run npm run build first`);
    else {
      status = await runSuite(suite);
    }
    results.push({ ...suite, status });
    console.log(`browser suite ${suite.name}: ${status} (${elapsed()})`);
    continue;
  }
  const port = suite.port === 5179 ? Number(process.env.ARCO_BROWSER_ALT_PORT || suite.port) : suite.port;
  const env = { ...process.env, ARCO_CLIENT_PORT: String(port) };
  if (env.ARCO_TEST_CHROME) env.CHROMIUM_PATH = env.ARCO_TEST_CHROME;
  if (!(await portFree(port))) {
    console.error(`${suite.name}: port ${port} is already in use by another process; stop it and rerun`);
    results.push({ ...suite, status: 'fail' });
    console.log(`browser suite ${suite.name}: fail (${elapsed()})`);
    continue;
  }
  const vite = spawn(process.execPath, [viteBin, 'client', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, env, stdio: ['ignore', process.env.ARCO_BROWSER_VITE_LOG ? 'inherit' : 'ignore', 'inherit'] });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (vite.exitCode !== null || vite.signalCode !== null) break;
    ready = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.ok, () => false);
  }
  let status = 'fail';
  if (!ready) console.error(`${suite.name}: Vite did not start on ${port}`);
  else {
    status = await runSuite(suite, env);
  }
  // Wait for the dev server to exit so the next suite on the same port starts its own.
  if (vite.exitCode === null && vite.signalCode === null) await new Promise((done) => { vite.once('exit', done); vite.kill(); });
  results.push({ ...suite, status });
  console.log(`browser suite ${suite.name}: ${status} (${elapsed()})`);
}
const passed = results.filter((r) => r.status === 'pass' || r.status === 'flaky').length;
const flaky = results.filter((r) => r.status === 'flaky').map((r) => r.name);
console.log(`\n${passed}/${results.filter((r) => r.status !== 'skip').length} browser suites passed; ${results.filter((r) => r.status === 'skip').length} skipped${flaky.length ? `; ${flaky.length} FLAKY: ${flaky.join(', ')}` : ''}`);
console.log(`Browser suites completed in ${((performance.now() - suiteRunStartedAt) / 1000).toFixed(1)}s`);
process.exitCode = results.every((r) => r.status !== 'fail') ? 0 : 1;
