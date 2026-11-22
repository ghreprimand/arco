import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCheckedLinuxWorker } from './checkedLinuxWorker.js';
import { makeWorkerSocketDirectory } from './workerSocketDirectory.js';

test('a long temporary path uses a private directory short enough for worker sockets', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'arco-long-socket-'));
  const long = join(root, 'a'.repeat(90));
  await mkdir(long);
  const before = process.env.TMPDIR;
  let socketRoot: string | undefined;
  try {
    process.env.TMPDIR = long;
    socketRoot = await makeWorkerSocketDirectory('arco-claude-isolation-');
    assert.ok(Buffer.byteLength(join(socketRoot, 'worker-mail-XXXXXX', 'mail.sock')) <= 107);
    assert.equal((await stat(socketRoot)).mode & 0o777, 0o700);
  } finally {
    if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before;
    if (socketRoot) await rm(socketRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('same-namespace preflight starts the worker only when network and mailbox checks pass', { skip: process.platform !== 'linux' }, async t => {
  if (spawnSync('bwrap', ['--version']).error || spawnSync('socat', ['-V']).error || !process.execPath.startsWith('/usr/')) {
    t.skip('The Linux isolation runtime is unavailable.'); return;
  }
  const root = await mkdtemp(join(tmpdir(), 'arco-checked-worker-'));
  const workspace = join(root, 'work'), privateHome = join(root, 'home'), foreign = join(root, 'foreign');
  await mkdir(workspace); await mkdir(privateHome); await mkdir(foreign);
  const token = 'a'.repeat(64), loopback = [127, 0, 0, 1].join('.');
  let denyWeb = false, webOff = false, extraMailTool = false;
  function fixture(body: (request: string) => { status: number; content: string }): Server {
    return createServer(socket => {
      let request = '';
      let answered = false;
      socket.on('error', () => {});
      socket.on('data', chunk => {
        if (answered) return;
        request += chunk.toString();
        if (!request.includes('\r\n\r\n')) return;
        answered = true;
        const response = body(request);
        socket.end(`HTTP/1.1 ${response.status} ${response.status === 200 ? 'OK' : 'Forbidden'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(response.content)}\r\nConnection: close\r\n\r\n${response.content}`);
      });
    });
  }
  const web = fixture(request => ({ status: denyWeb || (webOff && !request.startsWith('CONNECT ')) ? 403 : 200, content: '{}' }));
  const mail = fixture(() => ({ status: 200, content: JSON.stringify({ result: { tools: [{ name: 'peer_send' }, { name: 'peer_read' }, ...(extraMailTool ? [{ name: 'peer_list' }] : [])] } }) }));
  const host = createServer(socket => socket.end('host fixture'));
  let prepared: Awaited<ReturnType<typeof prepareCheckedLinuxWorker>> | undefined;
  try {
    await Promise.all([
      new Promise<void>((resolve, reject) => { web.once('error', reject); web.listen(join(root, 'web.sock'), resolve); }),
      new Promise<void>((resolve, reject) => { mail.once('error', reject); mail.listen(join(root, 'mail.sock'), resolve); }),
      new Promise<void>((resolve, reject) => { host.once('error', reject); host.listen(0, loopback, resolve); }),
    ]);
    await chmod(join(root, 'web.sock'), 0o600); await chmod(join(root, 'mail.sock'), 0o600);
    const address = host.address(); assert.ok(address && typeof address !== 'string');
    const args = () => ['-c', 'test "$http_proxy" = "$HTTP_PROXY" && test "$https_proxy" = "$HTTPS_PROXY" && node -e \'const l=require("fs").readFileSync("/etc/hosts","utf8").trim().split("\\n");if(l.length!==2||l.some(x=>!x.endsWith(" localhost")))process.exit(1)\' && touch /work/started'];
    await assert.rejects(prepareCheckedLinuxWorker({ workspace, privateHome, executable: '/work/unsafe', args, webSocket: join(root, 'web.sock'), mailSocket: join(root, 'mail.sock'), mailToken: token, webAccess: true, arcoPort: address.port }), /mounted runtime/);
    await assert.rejects(prepareCheckedLinuxWorker({ workspace, privateHome, executable: '/usr/bin/sh', args, webSocket: join(root, 'web.sock'), mailSocket: join(root, 'web.sock'), mailToken: token, webAccess: true, arcoPort: address.port }), /must be separate/);
    prepared = await prepareCheckedLinuxWorker({ workspace, privateHome, hiddenDirectories: [foreign], executable: '/usr/bin/sh', args, webSocket: join(root, 'web.sock'), mailSocket: join(root, 'mail.sock'), mailToken: token, webAccess: true, arcoPort: address.port });
    async function run(): Promise<{ error: Error | null; stderr: string }> {
      return await new Promise(resolve => execFile(prepared!.command.file, prepared!.command.args, { timeout: 25_000, env: { PATH: '/usr/bin:/bin' } }, (error, _stdout, stderr) => resolve({ error, stderr })));
    }
    const good = await run();
    if (/bwrap:.*(?:No permissions to create new namespace|Creating new namespace failed|Operation not permitted)/i.test(good.stderr)) { t.skip('Unprivileged namespaces are unavailable.'); return; }
    assert.equal(good.error, null, good.stderr);
    assert.ok(await stat(join(workspace, 'started')));
    await rm(join(workspace, 'started'));
    await prepared.close(); prepared = undefined;
    prepared = await prepareCheckedLinuxWorker({ workspace, privateHome, hiddenDirectories: ['/usr'], executable: '/usr/bin/sh', args, webSocket: join(root, 'web.sock'), mailSocket: join(root, 'mail.sock'), mailToken: token, webAccess: true, arcoPort: address.port });
    const visible = await run();
    assert.ok(visible.error); assert.match(visible.stderr, /Worker isolation self-check failed/);
    await assert.rejects(stat(join(workspace, 'started')));
    await prepared.close(); prepared = undefined;
    prepared = await prepareCheckedLinuxWorker({ workspace, privateHome, hiddenDirectories: [foreign], executable: '/usr/bin/sh', args, webSocket: join(root, 'web.sock'), mailSocket: join(root, 'mail.sock'), mailToken: token, webAccess: true, arcoPort: address.port });
    denyWeb = true;
    const denied = await run();
    assert.ok(denied.error); assert.match(denied.stderr, /Worker isolation self-check failed/);
    await assert.rejects(stat(join(workspace, 'started')));
    denyWeb = false; extraMailTool = true;
    const excess = await run();
    assert.ok(excess.error); assert.match(excess.stderr, /Worker isolation self-check failed/);
    await assert.rejects(stat(join(workspace, 'started')));
    await prepared.close(); prepared = undefined;
    extraMailTool = false; webOff = true;
    prepared = await prepareCheckedLinuxWorker({ workspace, privateHome, executable: '/usr/bin/sh', args, webSocket: join(root, 'web.sock'), mailSocket: join(root, 'mail.sock'), mailToken: token, webAccess: false, providerProbeHost: 'provider.example', arcoPort: address.port });
    const limited = await run();
    assert.equal(limited.error, null, limited.stderr);
    assert.ok(await stat(join(workspace, 'started')));
    await rm(join(workspace, 'started')); webOff = false;
    const unexpectedlyOpen = await run();
    assert.ok(unexpectedlyOpen.error); assert.match(unexpectedlyOpen.stderr, /Worker isolation self-check failed/);
    await assert.rejects(stat(join(workspace, 'started')));
    await prepared.close(); prepared = undefined;
    webOff = false;

    // A provider's nested sandbox: the fence hides the ID-map helpers, and the
    // worker starts only when the helper denies reads outside the workspace.
    const helpers = join(root, 'helpers'); await mkdir(helpers);
    const helperScript = (deny: boolean) => ['#!/bin/sh', 'test -f "$2" || exit 9', 'shift 2', 'test "$1" = --preflight-only && exit 0', 'shift',
      ...(deny ? ['case "$*" in *arco-check.json*|*/home/worker*) exit 1;; esac'] : []), 'exec "$@"', ''].join('\n');
    for (const [name, deny] of [['denying', true], ['open', false]] as const) {
      await mkdir(join(helpers, name)); await writeFile(join(helpers, name, 'cursorsandbox'), helperScript(deny), { mode: 0o700 });
    }
    const nestedArgs = () => ['-c', 'test ! -e /usr/bin/newuidmap && test ! -e /bin/newuidmap && test ! -e /usr/bin/newgidmap && test -x /usr/bin/ls && touch /work/started'];
    const nested = (name: string) => prepareCheckedLinuxWorker({ workspace, privateHome, executable: '/usr/bin/sh', args: nestedArgs,
      runtimeMounts: [{ source: join(helpers, name, 'cursorsandbox'), target: '/opt/arco-runtime/fake/cursorsandbox' }], nestedSandboxHelper: '/opt/arco-runtime/fake/cursorsandbox',
      webSocket: join(root, 'web.sock'), mailSocket: join(root, 'mail.sock'), mailToken: token, webAccess: true, arcoPort: address.port });
    await assert.rejects(prepareCheckedLinuxWorker({ workspace, privateHome, executable: '/usr/bin/sh', args: nestedArgs, nestedSandboxHelper: '/usr/bin/true',
      webSocket: join(root, 'web.sock'), mailSocket: join(root, 'mail.sock'), mailToken: token, webAccess: true, arcoPort: address.port }), /nested sandbox helper/);
    prepared = await nested('denying');
    const fenced = await run();
    assert.equal(fenced.error, null, fenced.stderr);
    assert.ok(await stat(join(workspace, 'started')));
    await rm(join(workspace, 'started'));
    await prepared.close(); prepared = undefined;
    prepared = await nested('open');
    const permissive = await run();
    assert.ok(permissive.error); assert.match(permissive.stderr, /Worker isolation self-check failed/);
    await assert.rejects(stat(join(workspace, 'started')));
  } finally {
    if (prepared) await prepared.close();
    for (const server of [web, mail, host]) if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
