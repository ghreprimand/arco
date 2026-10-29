// Proof that the acceptance harnesses cannot reach host provider CLIs or services.
//
// Needs an isolated network namespace (loopback only), which scripts/test-unit.mjs and
// scripts/smoke/host_isolation.py create with `unshare -rn`; elsewhere the test skips,
// because decoys on the default ports could not prove anything about a real host.
// Nothing here starts or queries a host service, and no real provider executable runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { promises as fs, mkdtempSync, mkdirSync, openSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmodSync, writeFileSync } from 'node:fs';
import { createServer as createIsolationServer } from 'node:net';
const DENIED_COMMANDS = [
  'claude', 'codex',  'cursor-agent', 'agent', 'ollama', 'llama-server', 'llama-cli',
  'lms',  'xolotl', 'docker', 'podman', 'gh', 'systemctl', 'journalctl', 'ssh', 'curl', 'wget',
] as const;

async function closedPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createIsolationServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
  });
}

function installDenyStubs(root: string): { stubs: string; log: string } {
  const stubs = path.join(root, 'deny-bin'), log = path.join(root, 'deny.log');
  mkdirSync(stubs, { recursive: true });
  for (const name of DENIED_COMMANDS) {
    const file = path.join(stubs, name);
    writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${log}"\necho "Host provider and service commands are disabled in acceptance tests." >&2\nexit 97\n`);
    chmodSync(file, 0o755);
  }
  return { stubs, log };
}

async function hardenServerEnv(env: Record<string, string>, root: string): Promise<{ env: Record<string, string>; denyLog: string }> {
  const { stubs, log } = installDenyStubs(root);
  const dead = `http://127.0.0.1:${await closedPort()}`;
  const home = env.HOME ?? path.join(root, 'home');
  const hardened: Record<string, string> = {
    ...env,
    PATH: [stubs, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    DEEPSEEK_URL_BASE: `${dead}/v1`, OLLAMA_URL_BASE: dead, LMSTUDIO_URL_BASE: `${dead}/v1`, STRATA_URL_BASE: `${dead}/v1`,
    ARCO_LLAMACPP_BIN: path.join(stubs, 'llama-server'), ARCO_LLAMACPP_HOST: '127.0.0.1', ARCO_LLAMACPP_PORT: String(await closedPort()),
    ANTIGRAVITY_BINARY: path.join(stubs, 'antigravity'), ANTIGRAVITY_CDP_PORT: String(await closedPort()),
    ARCO_SEARXNG_URL: dead, ARCO_CHROME_BINARY: path.join(stubs, 'curl'), CHROME_PATH: path.join(stubs, 'curl'),
    CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_CACHE_HOME: path.join(home, '.cache'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  };
  for (const key of ['ARCO_HUB_URL', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) delete hardened[key];
  return { env: hardened, denyLog: log };
}


const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_PORTS = [11434, 1234, 8081, 8080, 8150, 9222];

const onlyLoopback = () => Object.values(networkInterfaces()).flat().every((i) => !i || i.internal);

interface Decoys { hits: Map<number, number>; close(): Promise<void> }
async function startDecoys(): Promise<Decoys | null> {
  const hits = new Map<number, number>(), servers: Server[] = [];
  for (const port of DEFAULT_PORTS) {
    const server = createServer((socket) => { hits.set(port, (hits.get(port) ?? 0) + 1); socket.destroy(); });
    const ok = await new Promise<boolean>((resolve) => { server.once('error', () => resolve(false)); server.listen(port, '127.0.0.1', () => resolve(true)); });
    if (!ok) { await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r())))); return null; }
    servers.push(server);
  }
  return { hits, close: async () => { await Promise.all(servers.map((s) => new Promise<void>((r) => { s.close(() => r()); }))); } };
}

async function stopServer(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => { const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000); child.once('exit', () => { clearTimeout(t); resolve(); }); });
}

test('hardened environment: provider CLIs resolve to denying stubs even after the server merges its PATH, and default endpoints stay untouched', async (t) => {
  if (!onlyLoopback()) { t.skip('not inside an isolated network namespace (run via npm run test:unit or the browser scripts)'); return; }
  const decoys = await startDecoys();
  if (!decoys) { t.skip('a default port is already in use; this is not an isolated namespace'); return; }
  const root = mkdtempSync(path.join(tmpdir(), 'arco-hostiso-'));
  const home = path.join(root, 'home'), scratch = path.join(root, 'tmp'), uploads = path.join(root, 'uploads');
  for (const d of [home, scratch, uploads]) mkdirSync(d, { recursive: true });
  let child: ChildProcess | undefined;
  try {
    const port = await closedPort();
    const { env, denyLog } = await hardenServerEnv({ HOME: home, TMPDIR: scratch, PATH: '/usr/bin:/bin', ARCO_PORT: String(port), ARCO_HOST: '127.0.0.1', ARCO_UPLOADS_DIR: uploads, ARCO_SERVE_CLIENT: '1' }, root);

    // Positive control 1 (network): a process in this namespace that does contact the defaults is seen.
    const dialer = spawnSync(process.execPath, ['-e', `const net=require('net');let n=${DEFAULT_PORTS.length};for(const p of ${JSON.stringify(DEFAULT_PORTS)}){const s=net.connect(p,'127.0.0.1',()=>{s.destroy();if(--n===0)process.exit(0)});s.on('error',()=>{if(--n===0)process.exit(1)})}`], { timeout: 15000 });
    assert.equal(dialer.status, 0, 'the control dialer could not reach the decoys');
    await delay(200);
    for (const p of DEFAULT_PORTS) assert.equal(decoys.hits.get(p), 1, `decoy on ${p} did not register the control connection`);
    decoys.hits.clear();

    // Positive control 2 (executables): after the server's own PATH merge, every provider/service command still resolves to the stub.
    const probe = spawnSync(process.execPath, ['--conditions', 'development', '--import', 'tsx', '-e', `
      const { hydrateProcessPathFromUserEnv } = await import('./server/src/runtimeEnv.ts');
      const { execFileSync, spawnSync } = await import('node:child_process');
      hydrateProcessPathFromUserEnv();
      const out = {};
      for (const name of ${JSON.stringify([...DENIED_COMMANDS])}) {
        const r = spawnSync(name, ['--version'], { encoding: 'utf8' });
        out[name] = r.status;
      }
      console.log(JSON.stringify(out));`], { cwd: repo, env, encoding: 'utf8', timeout: 60000 });
    assert.equal(probe.status, 0, probe.stderr.slice(0, 400));
    const statuses = JSON.parse(probe.stdout.trim().split('\n').pop() ?? '{}') as Record<string, number>;
    for (const name of DENIED_COMMANDS) assert.equal(statuses[name], 97, `${name} did not resolve to the denying stub after the PATH merge`);
    const stubLog = await fs.readFile(denyLog, 'utf8');
    for (const name of DENIED_COMMANDS) assert.ok(stubLog.includes(`${name} --version`), `${name} left no trace in the deny log`);
    await fs.rm(denyLog);

    // The real server, hardened: boot, sign in, ask for provider/capability state, wait out startup probes.
    child = spawn(process.execPath, ['--conditions', 'development', '--import', 'tsx', 'server/src/index.ts'], {
      cwd: repo, stdio: ['ignore', openSync(path.join(root, 'server.log'), 'a'), openSync(path.join(root, 'server.log'), 'a')], env,
    });
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 90_000;
    for (;;) {
      try { if ((await fetch(`${base}/readyz`)).ok) break; } catch { /* starting */ }
      assert.ok(Date.now() < deadline, 'server never became ready');
      await delay(100);
    }
    const minted = await fetch(`${base}/api/session`, { method: 'POST', headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' } });
    assert.equal(minted.status, 204);
    const cookie = minted.headers.get('set-cookie')?.split(';')[0] ?? '';
    for (const route of ['/api/auth-status', '/api/capabilities', '/api/deepseek', '/api/settings']) {
      const res = await fetch(`${base}${route}`, { headers: { Cookie: cookie, Origin: base } });
      await res.arrayBuffer();
    }
    for (const route of ['/api/auth-login?provider=antigravity', '/api/check-updates?provider=antigravity', '/api/auth-login?provider=gemini', '/api/check-updates?provider=gemini']) {
      const res = await fetch(`${base}${route}`, { method: 'POST', headers: { Cookie: cookie, Origin: base } });
      assert.equal(res.status, 400, `${route} must not fall through to another provider`);
      assert.match((await res.json() as { error: string }).error, /support has been removed/);
    }
    await delay(4000);
    const contacted = [...decoys.hits].filter(([, n]) => n > 0).map(([p]) => p);
    assert.deepEqual(contacted, [], `the hardened server contacted default endpoints: ${contacted.join(', ')}`);
    const attempts = (await fs.readFile(denyLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
    // Informational: every attempted host command was denied; none ran.
    t.diagnostic(`host commands attempted and denied during boot: ${attempts.length ? [...new Set(attempts)].join(' | ') : 'none'}`);
    const log = await fs.readFile(path.join(root, 'server.log'), 'utf8').catch(() => '');
    assert.ok(!/\/usr\/local\/bin\/(claude|codex|ollama)/.test(log), 'a host provider path appears in the server log');
  } finally {
    await stopServer(child);
    await decoys.close();
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('the old harness environment is what let host executables in (documented, not executed)', () => {
  // The previous Instance.start used PATH=<node dir>:/usr/bin:/bin. runtimeEnv.ts appends /usr/local/bin and
  // /usr/bin/usr/sbin after it with a first-occurrence-wins merge, so real CLIs there were reachable. This test
  // pins the merge rule that makes the stub-first PATH sufficient, without running any host command.
  const source = spawnSync('sh', ['-c', `grep -n "mergePathValues" server/src/runtimeEnv.ts | head -n 3; grep -n "'/usr/local/bin'" server/src/runtimeEnv.ts | head -n 1`], { cwd: repo, encoding: 'utf8' }).stdout;
  assert.match(source, /mergePathValues/);
  assert.match(source, /\/usr\/local\/bin/);
});
