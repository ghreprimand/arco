import assert from 'node:assert/strict';
import test from 'node:test';
import childProcess from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linuxWorkerSandboxCommand } from './linuxWorkerSandbox.js';
import { prepareWorkerAccessPass, type WorkerAccessPass } from './workerAccessPass.js';

test('a Codex pass can be replaced through a read-only mounted directory', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'arco-pass-reissue-'));
  const workspace = join(root, 'workspace'), privateHome = join(root, 'home');
  await mkdir(workspace); await mkdir(privateHome);
  const credentials = (marker: string) => ({ auth_mode: 'chatgpt', tokens: { access_token: `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, marker })).toString('base64url')}.fixture`, account_id: 'fixture-account' }, last_refresh: new Date().toISOString() });
  const pass = await prepareWorkerAccessPass('codex', credentials('first'));
  let child: ReturnType<typeof childProcess.spawn> | undefined;
  try {
    const script = 'import json,sys\np="/run/arco-pass/access.json"\na=json.load(open(p))["tokens"]["access_token"]\nprint("READY",flush=True)\nsys.stdin.readline()\nb=json.load(open(p))["tokens"]["access_token"]\nassert a != b\ntry:\n open(p,"w")\n raise AssertionError("writable")\nexcept OSError: pass\nprint("UPDATED",flush=True)';
    const plan = await linuxWorkerSandboxCommand({ workspace, privateHome, executable: '/usr/bin/python3', args: ['-u', '-c', script], accessPass: pass });
    child = childProcess.spawn(plan.file, plan.args, { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout!.on('data', chunk => { out += String(chunk); });
    child.stderr!.on('data', chunk => { err += String(chunk); });
    let spawnMissing = false;
    const exited = new Promise<number | null>(resolve => { child!.once('error', error => { spawnMissing = (error as NodeJS.ErrnoException).code === 'ENOENT'; resolve(null); }); child!.once('close', resolve); });
    const ready = await Promise.race([new Promise<boolean>(resolve => child!.stdout!.on('data', () => { if (out.includes('READY')) resolve(true); })), exited.then(() => false), new Promise<boolean>(resolve => { setTimeout(() => resolve(false), 10_000).unref(); })]);
    if (!ready && (spawnMissing || /bwrap:.*(?:No permissions to create new namespace|Creating new namespace failed|Operation not permitted)/i.test(err))) { t.skip('Bubblewrap or unprivileged namespaces are unavailable.'); return; }
    assert.equal(ready, true, err);
    assert.ok(pass.replace);
    await pass.replace(credentials('second'));
    child.stdin!.end('\n');
    assert.equal(await exited, 0, err);
    assert.match(out, /UPDATED/);
  } finally { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await pass.close(); await rm(root, { recursive: true, force: true }); }
});

test('Linux worker fence isolates private files and host loopback while allowing workspace writes', { skip: process.platform !== 'linux' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'arco-worker-fence-'));
  const workspace = join(root, 'workspace');
  const privateHome = join(root, 'private-home');
  const foreign = join(root, 'foreign');
  const runtime = join(root, 'runtime');
  const loopback = [127, 0, 0, 1].join('.');
  const listener = createServer((socket) => socket.end('host fixture'));
  let pass: WorkerAccessPass | undefined;
  try {
    await Promise.all([mkdir(workspace), mkdir(privateHome), mkdir(foreign), mkdir(runtime)]);
    await writeFile(join(foreign, 'canary'), 'outside worker');
    await writeFile(join(runtime, 'runtime-file'), 'runtime');
    pass = await prepareWorkerAccessPass('claude', { claudeAiOauth: { accessToken: 'fixture-token', refreshToken: 'fixture-renewal', expiresAt: Date.now() + 600000, scopes: ['inference'], subscriptionType: 'plan', subscriptionTypeSource: 'source', rateLimitTier: 'tier' } });
    await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, loopback, resolve); });
    const address = listener.address();
    assert.ok(address && typeof address !== 'string');
    const script = [
      'import json, os, socket, subprocess, sys',
      'assert json.load(open("/run/arco-access.json"))["claudeAiOauth"]["refreshToken"] == ""',
      'try:',
      ' open("/run/arco-access.json", "w")',
      ' raise AssertionError("access pass was writable")',
      'except OSError: pass',
      ...(existsSync('/etc/ssl/certs/ca-certificates.crt') ? ['assert os.path.isfile("/etc/ssl/certs/ca-certificates.crt")'] : []),
      'assert not os.path.exists(sys.argv[1])',
      'assert not os.path.exists(sys.argv[2])',
      'open("/work/created", "w").write("ok")',
      'subprocess.run(["/bin/sh", "-c", "true"], check=True)',
      'assert open("/opt/arco-runtime/provider/runtime-file").read() == "runtime"',
      'try:',
      ' open("/opt/arco-runtime/provider/runtime-file", "w")',
      ' raise AssertionError("runtime was writable")',
      'except OSError: pass',
      's = socket.socket(); s.settimeout(2)',
      'assert s.connect_ex((sys.argv[4], int(sys.argv[3]))) != 0',
      's.close()',
    ].join('\n');
    const plan = await linuxWorkerSandboxCommand({ workspace, privateHome, executable: '/usr/bin/python3', args: ['-c', script, join(foreign, 'canary'), root, String(address.port), loopback], runtimeMounts: [{ source: runtime, target: '/opt/arco-runtime/provider' }], accessPass: pass });
    const outcome = await new Promise<{ error: (Error & { code?: string | number | null }) | null; stderr: string }>((resolve) => {
      childProcess.execFile(plan.file, plan.args, { timeout: 10_000, env: { PATH: '/usr/bin:/bin' } }, (error, _stdout, stderr) => resolve({ error, stderr }));
    });
    if (outcome.error?.code === 'ENOENT' || /bwrap:.*(?:No permissions to create new namespace|Creating new namespace failed|Operation not permitted)/i.test(outcome.stderr)) {
      t.skip('Bubblewrap or unprivileged namespaces are unavailable on this host.');
      return;
    }
    assert.equal(outcome.error, null, outcome.stderr);
    assert.equal(await readFile(join(workspace, 'created'), 'utf8'), 'ok');
    await assert.rejects(linuxWorkerSandboxCommand({ workspace, privateHome: workspace, executable: '/usr/bin/true', args: [] }), /must be separate/);
    await assert.rejects(linuxWorkerSandboxCommand({ workspace, privateHome, executable: '/usr/../bin/sh', args: [] }), /mounted absolute executable/);
    await assert.rejects(linuxWorkerSandboxCommand({ workspace, privateHome, executable: '/usr/bin/true', args: [], runtimeMounts: [{ source: root, target: '/opt/arco-runtime/unsafe' }] }), /not isolated/);
    await assert.rejects(linuxWorkerSandboxCommand({ workspace, privateHome, executable: '/usr/bin/true', args: [], accessPass: { path: pass.path, close: pass.close } }), /not prepared/);
  } finally {
    if (pass) {
      await pass.close();
      await assert.rejects(readFile(pass.path));
      await assert.rejects(linuxWorkerSandboxCommand({ workspace, privateHome, executable: '/usr/bin/true', args: [], accessPass: pass }), /not prepared/);
    }
    if (listener.listening) await new Promise<void>(resolve => listener.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
