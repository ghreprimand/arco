// Aggregate only the fixture-based source unit tests, never smoke/live scripts.
// Credentials and runtime settings from the invoking shell are not inherited.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function testsIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testsIn(path);
    return entry.isFile() && /\.test\.(?:[cm]?js|tsx?)$/.test(entry.name) ? [path] : [];
  });
}
const files = ['shared/src', 'server/src', 'client/src'].flatMap(path => testsIn(join(root, path))).sort();
if (!files.length) throw new Error('No unit tests discovered.');
const sandbox = mkdtempSync(join(tmpdir(), 'arco-unit-'));
try {
  const home = join(sandbox, 'home'), temporary = join(sandbox, 'tmp'), binaries = join(sandbox, 'bin');
  for (const directory of [home, temporary, binaries]) mkdirSync(directory);
  // A test may prepend its own fake executable. Otherwise an accidental real
  // provider subprocess fails before it can make a paid call or use host auth.
  for (const command of ['claude', 'codex', 'gemini', 'cursor-agent', 'agent', 'ollama', 'llama-server', 'llama-cli', 'lms', 'antigravity', 'xolotl', 'docker', 'podman', 'gh', 'systemctl', 'journalctl', 'ssh', 'curl', 'wget']) {
    writeFileSync(join(binaries, command), '#!/bin/sh\necho "Real provider commands are disabled in unit tests; install a fixture on PATH." >&2\nexit 97\n', { mode: 0o755 });
  }
  const gitConfig = join(sandbox, 'gitconfig');
  writeFileSync(gitConfig, '');
  const env = {
    PATH: [binaries, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter),
    HOME: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CACHE_HOME: join(home, '.cache'), CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfig,
    CI: '1', LANG: 'C.UTF-8', TSX_TSCONFIG_PATH: join(root, 'client/tsconfig.json'),
  };
  console.log(`Running ${files.length} source unit-test files with isolated HOME, temporary storage and provider fixtures.`);
  const testArgs = ['--conditions', 'development', '--import', 'tsx', '--test', '--test-concurrency=1', ...files];
  // Run the whole suite, including every server process the tests start, inside an empty network
  // namespace (loopback only) so no test can reach a host service on a default port. Hosted runners
  // that forbid unprivileged namespaces fall back to the environment fixtures above; set
  // ARCO_TEST_REQUIRE_NETNS=1 to make that fatal and ARCO_TEST_NETNS=0 to opt out explicitly.
  // The inner user namespace maps the invoking uid back (not root), so permission-based tests keep
  // their meaning; plain `-rn` (uid 0) is the fallback.
  const uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000;
  const wrappers = [
    ['sh', '-c', `ip link set lo up && exec unshare -U --map-user=${uid} --map-group=${gid} "$@"`, 'sh'],
    ['sh', '-c', 'ip link set lo up && exec "$@"', 'sh'],
  ];
  const wrapper = process.env.ARCO_TEST_NETNS === '0' ? undefined
    : wrappers.find((w) => spawnSync('unshare', ['-rn', ...w, 'true'], { stdio: 'ignore' }).status === 0);
  const namespaced = !!wrapper;
  if (!namespaced && process.env.ARCO_TEST_REQUIRE_NETNS === '1') throw new Error('An isolated network namespace is required but unavailable.');
  console.log(namespaced ? 'Network: isolated namespace (loopback only).' : 'Network: host namespace (no unprivileged network namespace; environment fixtures only).');
  const result = namespaced
    ? spawnSync('unshare', ['-rn', ...wrapper, process.execPath, ...testArgs], { cwd: root, env, stdio: 'inherit' })
    : spawnSync(process.execPath, testArgs, { cwd: root, env, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
