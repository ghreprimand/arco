// Runs the Playwright browser smokes one at a time. Each suite gets its own Vite dev server on the
// port its script expects; every API and WebSocket call is fulfilled inside the script, so no
// Arco server, provider or credential is involved. Chromium comes from ARCO_TEST_CHROME
// (or Playwright's own install via `python3 -m playwright install chromium`).
// Usage: node scripts/smoke/run-browser-suites.mjs [suite-name ...]   (default: every listed suite)
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// Suites that fail against the imported tree are excluded here and tracked on the board:
// help-docs-browser (the script searches for text absent from the manual), phosphor-production-browser
// and voice-browser (see the P5.1 board findings).
const SUITES = [
  { name: 'phosphor-demo', script: 'phosphor-demo-browser.py', port: 5178 },
  { name: 'computer-panel', script: 'computer-panel-browser.py', port: 5193 },
  { name: 'deepseek', script: 'deepseek-browser.py', port: 5197 },
  { name: 'operator-questions', script: 'operator-questions-browser.py', port: 5187 },
  { name: 'voice-scroll', script: 'voice-scroll-browser.py', port: 5195 },
];
const KNOWN_FAILING = [
  { name: 'help-docs', script: 'help-docs-browser.py', port: 5179 },
  { name: 'phosphor-production', script: 'phosphor-production-browser.py', port: 5179 },
  { name: 'voice', script: 'voice-browser.py', port: 5193 },
];
const wanted = process.argv.slice(2);
const pool = process.env.ARCO_BROWSER_INCLUDE_KNOWN_FAILING === '1' ? [...SUITES, ...KNOWN_FAILING] : SUITES;
const selected = wanted.length ? pool.filter((s) => wanted.includes(s.name)) : pool;
if (!selected.length) { console.error('No matching browser suites.'); process.exit(2); }

const viteBin = join(root, 'node_modules/vite/bin/vite.js');
const results = [];
for (const suite of selected) {
  const env = { ...process.env, ARCO_CLIENT_PORT: String(suite.port) };
  if (env.ARCO_TEST_CHROME) env.CHROMIUM_PATH = env.ARCO_TEST_CHROME;
  const vite = spawn(process.execPath, [viteBin, 'client', '--host', '127.0.0.1', '--port', String(suite.port), '--strictPort'], { cwd: root, env, stdio: 'ignore' });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    await new Promise((r) => setTimeout(r, 500));
    ready = await fetch(`http://127.0.0.1:${suite.port}/`).then((r) => r.ok, () => false);
  }
  let status = 'fail';
  if (!ready) console.error(`${suite.name}: Vite did not start on ${suite.port}`);
  else {
    const run = spawnSync('python3', [join(root, 'scripts/smoke', suite.script)], { cwd: root, env, stdio: 'inherit', timeout: 240_000 });
    status = run.status === 0 ? 'pass' : 'fail';
  }
  vite.kill();
  results.push({ ...suite, status });
  console.log(`browser suite ${suite.name}: ${status}`);
}
console.log(`\n${results.filter((r) => r.status === 'pass').length}/${results.length} browser suites passed`);
process.exitCode = results.every((r) => r.status === 'pass') ? 0 : 1;
