// Runs Playwright browser smokes sequentially. UI suites use Vite with fixture APIs.
// Isolated-server suites use the built client and start temporary Arco servers with
// synthetic projects, denying CLI stubs and fixture providers (Linux only).
// Chromium comes from ARCO_TEST_CHROME or Playwright's installed browser.
// Usage: node scripts/smoke/run-browser-suites.mjs [suite-name ...]   (default: every listed suite)
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SUITES = [
  { name: 'home-start-page', script: 'home-start-page-browser.py', port: 5196 },
  { name: 'first-run', script: 'first-run-browser.py', isolatedServer: true },
  { name: 'connections', script: 'connections-browser.py', isolatedServer: true },
  { name: 'update-notice', script: 'update-notice-browser.py', port: 5198 },
  { name: 'phosphor-demo', script: 'phosphor-demo-browser.py', port: 5178 },
  { name: 'computer-panel', script: 'computer-panel-browser.py', port: 5193 },
  { name: 'deepseek', script: 'deepseek-browser.py', port: 5197 },
  { name: 'operator-questions', script: 'operator-questions-browser.py', port: 5187 },
  { name: 'voice-scroll', script: 'voice-scroll-browser.py', port: 5195 },
  { name: 'help-docs', script: 'help-docs-browser.py', port: 5179 },
  { name: 'phosphor-production', script: 'phosphor-production-browser.py', port: 5179 },
  { name: 'voice', script: 'voice-browser.py', port: 5193 },
  { name: 'interrupt-send', script: 'interrupt-send-browser.py', port: 5194 },
];
// Suites known to fail are listed here with the board task that tracks them.
const KNOWN_FAILING = [];
const wanted = process.argv.slice(2);
const pool = process.env.ARCO_BROWSER_INCLUDE_KNOWN_FAILING === '1' ? [...SUITES, ...KNOWN_FAILING] : SUITES;
const selected = wanted.length ? pool.filter((s) => wanted.includes(s.name)) : pool;
if (!selected.length) { console.error('No matching browser suites.'); process.exit(2); }

const viteBin = join(root, 'node_modules/vite/bin/vite.js');
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
for (const suite of selected) {
  if (suite.isolatedServer) {
    if (process.platform !== 'linux') {
      console.log(`browser suite ${suite.name}: skipped (isolated-server harness requires Linux)`);
      results.push({ ...suite, status: 'skip' });
      continue;
    }
    let status = 'fail';
    if (!existsSync(join(root, 'client/dist/index.html'))) console.error(`${suite.name}: built client missing; run npm run build first`);
    else {
      const run = spawnSync('python3', [join(root, 'scripts/smoke', suite.script)], { cwd: root, env: process.env, stdio: 'inherit', timeout: 240_000 });
      if (run.error) console.error(`${suite.name}: ${run.error.message}`);
      status = run.status === 0 ? 'pass' : 'fail';
    }
    results.push({ ...suite, status });
    console.log(`browser suite ${suite.name}: ${status}`);
    continue;
  }
  const port = suite.port === 5179 ? Number(process.env.ARCO_BROWSER_ALT_PORT || suite.port) : suite.port;
  const env = { ...process.env, ARCO_CLIENT_PORT: String(port) };
  if (env.ARCO_TEST_CHROME) env.CHROMIUM_PATH = env.ARCO_TEST_CHROME;
  if (!(await portFree(port))) {
    console.error(`${suite.name}: port ${port} is already in use by another process; stop it and rerun`);
    results.push({ ...suite, status: 'fail' });
    console.log(`browser suite ${suite.name}: fail`);
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
    const run = spawnSync('python3', [join(root, 'scripts/smoke', suite.script)], { cwd: root, env, stdio: 'inherit', timeout: 240_000 });
    status = run.status === 0 ? 'pass' : 'fail';
  }
  // Wait for the dev server to exit so the next suite on the same port starts its own.
  if (vite.exitCode === null && vite.signalCode === null) await new Promise((done) => { vite.once('exit', done); vite.kill(); });
  results.push({ ...suite, status });
  console.log(`browser suite ${suite.name}: ${status}`);
}
console.log(`\n${results.filter((r) => r.status === 'pass').length}/${results.filter((r) => r.status !== 'skip').length} browser suites passed; ${results.filter((r) => r.status === 'skip').length} skipped`);
process.exitCode = results.every((r) => r.status !== 'fail') ? 0 : 1;
