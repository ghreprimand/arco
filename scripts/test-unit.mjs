// Aggregate fixture-based source unit tests and the standalone onboarding UI unit suite.
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
const files = ['shared/src', 'server/src', 'client/src', 'scripts/release'].flatMap(path => testsIn(join(root, path))).concat(join(root, 'scripts/smoke/onboarding-ui.test.tsx')).sort();
if (!files.length) throw new Error('No unit tests discovered.');
const sandbox = mkdtempSync(join(tmpdir(), 'arco-unit-'));
try {
  const home = join(sandbox, 'home'), temporary = join(sandbox, 'tmp'), binaries = join(sandbox, 'bin');
  for (const directory of [home, temporary, binaries]) mkdirSync(directory);
  // A test may prepend its own fake executable. Otherwise an accidental real
  // provider subprocess fails before it can make a paid call or use host auth.
  const windows = process.platform === 'win32';
  for (const command of ['claude', 'codex', 'gemini', 'cursor-agent', 'agent', 'ollama', 'llama-server', 'llama-cli', 'lms', 'antigravity', 'xolotl', 'docker', 'podman', 'gh', 'systemctl', 'journalctl', 'ssh', 'curl', 'wget']) {
    writeFileSync(join(binaries, command), '#!/bin/sh\necho "Real provider commands are disabled in unit tests; install a fixture on PATH." >&2\nexit 97\n', { mode: 0o755 });
    // Windows resolves commands through PATHEXT, so an extensionless script
    // would not shadow an npm-installed `codex.cmd`; add a `.cmd` stub too.
    if (windows) writeFileSync(join(binaries, `${command}.cmd`), '@echo Real provider commands are disabled in unit tests; install a fixture on PATH. 1>&2\r\n@exit /b 97\r\n');
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
  if (windows) {
    // os.homedir() reads USERPROFILE on Windows, and Node, Git and child
    // processes need the system variables; without them sockets, crypto and
    // process creation can fail or hang.
    Object.assign(env, {
      USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    });
    for (const name of ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT', 'SystemDrive', 'ProgramData', 'ProgramFiles', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    mkdirSync(env.APPDATA, { recursive: true }); mkdirSync(env.LOCALAPPDATA, { recursive: true });
  }
  console.log(`Running ${files.length} source unit-test files with isolated HOME, temporary storage and provider fixtures.`);
  // A per-test timeout turns a hang into a named failure instead of a stalled job.
  const testArgs = ['--conditions', 'development', '--import', 'tsx', '--test', '--test-concurrency=1', '--test-timeout=120000', ...files];
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
  const wrapper = process.env.ARCO_TEST_NETNS === '0' || process.platform !== 'linux' ? undefined
    : wrappers.find((w) => spawnSync('unshare', ['-rn', ...w, 'true'], { stdio: 'ignore' }).status === 0);
  const namespaced = !!wrapper;
  if (!namespaced && process.env.ARCO_TEST_REQUIRE_NETNS === '1') throw new Error('An isolated network namespace is required but unavailable.');
  console.log(namespaced ? 'Network: isolated namespace (loopback only).' : 'Network: host namespace (no unprivileged network namespace; environment fixtures only).');
  if (windows || process.env.ARCO_TEST_PER_FILE === '1') {
    // One process per file with a wall-clock limit: a file that never exits
    // (an open handle, a child waiting on a POSIX-only tool) is named and
    // killed, and the remaining files still run.
    const baseArgs = testArgs.slice(0, testArgs.length - files.length);
    const failed = [], timedOut = [];
    for (const file of files) {
      const r = spawnSync(process.execPath, [...baseArgs, file], { cwd: root, env, stdio: 'inherit', timeout: 120_000, killSignal: 'SIGKILL' });
      const name = file.slice(root.length + 1);
      if (r.error?.code === 'ETIMEDOUT' || (r.status === null && r.signal)) timedOut.push(name);
      else if (r.status !== 0) failed.push(name);
    }
    console.log(`\nFiles: ${files.length}, failed: ${failed.length}, timed out: ${timedOut.length}`);
    for (const name of failed) console.log(`FAILED   ${name}`);
    for (const name of timedOut) console.log(`TIMEOUT  ${name}`);
    process.exitCode = failed.length || timedOut.length ? 1 : 0;
  } else {
    const result = namespaced
      ? spawnSync('unshare', ['-rn', ...wrapper, process.execPath, ...testArgs], { cwd: root, env, stdio: 'inherit' })
      : spawnSync(process.execPath, testArgs, { cwd: root, env, stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
