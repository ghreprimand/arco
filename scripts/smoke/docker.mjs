import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { clusterSmoke } from './docker-cluster.mjs';
import { HOST_MODEL, startHostModel } from './fixtures/ollama-host.mjs';

// Creates only temporary projects and state. No host credentials or model calls.
const image = process.env.ARCO_SMOKE_IMAGE || 'arco:development';
const name = `arco-smoke-${process.pid}`;
const volume = `${name}-data`;
const project = mkdtempSync(join(tmpdir(), 'arco-project-'));
const fixtureBin = mkdtempSync(join(tmpdir(), 'arco-fixture-bin-'));
copyFileSync('scripts/smoke/fixtures/cluster-codex.mjs', join(fixtureBin, 'codex'));
copyFileSync('scripts/smoke/fixtures/login-claude.mjs', join(fixtureBin, 'claude'));
chmodSync(fixtureBin, 0o755); chmodSync(join(fixtureBin, 'codex'), 0o755); chmodSync(join(fixtureBin, 'claude'), 0o755);
chmodSync(project, 0o777);
mkdirSync(join(project, 'sample-app'));
// CI runs this script as root while the container runs as uid 1000, so the
// child folder must be writable by any user, like the project folder.
chmodSync(join(project, 'sample-app'), 0o777);
writeFileSync(join(project, 'example.txt'), 'host file\n');
chmodSync(join(project, 'example.txt'), 0o666);
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
// Node's fetch may reuse a keep-alive socket the server already closed after a
// long pause (the browser step); retry that one transport error once.
const rawFetch = globalThis.fetch;
const fetch = async (url, options) => {
  try { return await rawFetch(url, options); } catch (error) {
    if (error?.cause?.code === 'UND_ERR_SOCKET') return rawFetch(url, options);
    throw error;
  }
};
// A host-served model listens where host.docker.internal points: the bridge
// gateway on Linux Docker Engine. Override for daemons with a custom gateway.
const hostBind = process.env.ARCO_SMOKE_HOST_BIND || docker('network', 'inspect', 'bridge', '-f', '{{(index .IPAM.Config 0).Gateway}}').trim();
const hostModel = await startHostModel(hostBind);
const hostModelUrl = `http://host.docker.internal:${hostModel.port}`;
let base = '';
let socket;
async function waitReady() {
  for (let n = 0; n < 100; n++) {
    try { if ((await fetch(`${base}/readyz`)).ok) return; } catch { /* Booting. */ }
    await delay(300);
  }
  throw new Error('Isolated container failed readiness');
}
async function boot(fixture = false) {
  const extra = fixture ? ['--mount', `type=bind,src=${fixtureBin},dst=/fixtures,readonly`, '-e', 'PATH=/fixtures:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'] : [];
  // Same host alias Compose adds through extra_hosts.
  docker('run', '-d', '--name', name, '-p', '127.0.0.1::3001', '--add-host', 'host.docker.internal:host-gateway', '--mount', `type=bind,src=${project},dst=/projects`, '--mount', `type=volume,src=${volume},dst=/data`, ...extra, image);
  const port = docker('port', name, '3001/tcp').trim().split(':').at(-1);
  base = `http://127.0.0.1:${port}`;
  await waitReady();
}
async function cookie() {
  const response = await fetch(`${base}/api/session`, { method: 'POST', headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' } });
  assert.equal(response.status, 204);
  const header = response.headers.get('set-cookie');
  assert.ok(header?.includes('HttpOnly'));
  return header.split(';')[0];
}
async function connect() {
  socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws`, { headers: { Cookie: await cookie(), Origin: base } });
  const messages = [];
  socket.on('message', raw => messages.push(JSON.parse(raw.toString())));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return async predicate => {
    for (let n = 0; n < 200; n++) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return messages.splice(index, 1)[0];
      await delay(100);
    }
    throw new Error('Isolated socket message timed out');
  };
}
async function disconnect() {
  if (!socket || socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.close(); await closed;
}
try {
  if (process.env.ARCO_SMOKE_SKIP_BUILD !== '1') execFileSync('docker', ['build', '-t', image, '.'], { stdio: 'inherit' });
  await boot();
  assert.equal(docker('exec', name, 'id', '-u').trim(), '1000');
  assert.ok(docker('exec', name, 'codex', '--version').includes('codex'));
  assert.ok(docker('exec', name, 'claude', '--version').trim());
  assert.match(await (await fetch(base)).text(), /<title>ARCO<\/title>/);
  assert.equal((await fetch(`${base}/api/settings`)).status, 401);
  assert.equal((await fetch(`${base}/api/session`, { method: 'POST', headers: { Origin: 'https://example.com' } })).status, 403);
  const headers = { Cookie: await cookie(), Origin: base, 'Content-Type': 'application/json' };
  const settings = await (await fetch(`${base}/api/settings`, { headers })).json();
  assert.equal(settings.defaultWorkingDirectory, '/projects');
  const auth = await (await fetch(`${base}/api/auth-status`, { headers })).json();
  assert.equal(auth.codex.loggedIn, false, 'Clean bundled Codex must require login');

  for (const provider of ['gemini', 'cursor', 'antigravity', 'llamacpp']) assert.equal(settings.enabledProviders[provider], false);
  assert.equal(existsSync(join(project, 'auth.json')), false);
  // The default endpoint is the container's own localhost, not the host.
  assert.equal(auth.ollama.loggedIn, false, 'Ollama must not appear reachable before the host endpoint is configured');
  const configured = await (await fetch(`${base}/api/settings`, { method: 'POST', headers, body: JSON.stringify({ ollama: { baseUrl: hostModelUrl } }) })).json();
  assert.equal(configured.ollama.baseUrl, hostModelUrl);
  const hostStatus = (await (await fetch(`${base}/api/auth-status`, { headers })).json()).ollama;
  assert.equal(hostStatus.loggedIn, true, hostStatus.error);
  assert.equal(hostStatus.apiProvider, `ollama:${hostModelUrl}`);
  assert.ok(hostStatus.installedModels.includes(HOST_MODEL));
  assert.equal(hostStatus.installedModelCapabilities[HOST_MODEL].tools, true);
  console.log('PASS: host-served model endpoint reachable through host.docker.internal');
  const read = await fetch(`${base}/api/file-content?cwd=/projects&path=example.txt`, { headers });
  assert.equal(read.status, 200);
  assert.match(await read.text(), /host file/);
  const written = await fetch(`${base}/api/files/write`, { method: 'POST', headers, body: JSON.stringify({ cwd: '/projects', path: 'example.txt', content: 'container edit\n' }) });
  assert.equal(written.status, 200);
  assert.equal(readFileSync(join(project, 'example.txt'), 'utf8'), 'container edit\n');
  const escaped = await fetch(`${base}/api/files/write`, { method: 'POST', headers, body: JSON.stringify({ cwd: '/projects', path: '../escape.txt', content: 'refused' }) });
  assert.notEqual(escaped.status, 200);
  console.log('PASS: non-root runtime, CLI binaries, browser guards and host file read/write');

  let waitFor = await connect();
  await waitFor(message => message.type === 'connected');
  socket.send(JSON.stringify({ type: 'create_workflow', config: { name: 'Container fixture', primaryProvider: 'codex', primaryModel: 'gpt-5.5', primaryEffort: 'low', workingDirectory: '/projects', skipPermissions: false } }));
  const created = await waitFor(message => message.type === 'workflow_created');
  const id = created.workflowId;
  assert.ok(id);
  await disconnect();
  waitFor = await connect();
  await waitFor(message => message.type === 'connected');
  socket.send(JSON.stringify({ type: 'rehydrate_workflows', workflows: [{ workflowId: id, config: created.config, currentSessionId: id, lastSeq: 0 }] }));
  await waitFor(message => message.type === 'workflow_state_snapshot' && message.workflowId === id);
  await disconnect();
  console.log('PASS: saved workflow survives browser socket disconnect and reconnect');

  docker('exec', name, 'node', '-e', "require('node:fs').writeFileSync('/data/home/.arco/arco-smoke-sentinel','persisted')");
  docker('stop', '--time', '20', name);
  docker('rm', name);
  await boot();
  assert.equal(docker('exec', name, 'cat', '/data/home/.arco/arco-smoke-sentinel'), 'persisted');
  assert.ok(JSON.parse(docker('exec', name, 'cat', `/projects/.arco/workflows/${id}/meta.json`)));
  assert.equal(readFileSync(join(project, 'example.txt'), 'utf8'), 'container edit\n');
  const persisted = await (await fetch(`${base}/api/settings`, { headers: { Cookie: await cookie(), Origin: base } })).json();
  assert.equal(persisted.ollama.baseUrl, hostModelUrl, 'Host endpoint setting must survive container replacement');
  console.log('PASS: durable home, endpoint settings and workflow metadata survive container replacement');
  // Backup capture of the volume's home: the settings restore intact.
  const settingsOnVolume = docker('exec', name, 'cat', '/data/home/.arco/settings.json');
  assert.match(docker('exec', name, 'stat', '-c', '%U', '/data/home/.arco/settings.json').trim(), /^node$/);
  const backupRoot = mkdtempSync(join(tmpdir(), 'arco-backup-'));
  try {
    docker('cp', `${name}:/data/home/.arco`, join(backupRoot, 'home'));
    const backupEnv = { PATH: process.env.PATH, HOME: backupRoot, ARCO_HOME: join(backupRoot, 'home'), TMPDIR: backupRoot };
    const backup = args => execFileSync(process.execPath, ['--import', 'tsx', 'scripts/arco-backup.ts', ...args], { env: backupEnv, encoding: 'utf8' });
    backup(['snapshot', '--out', join(backupRoot, 'volume.arcobk')]);
    assert.match(backup(['verify', join(backupRoot, 'volume.arcobk')]), /ok|verified|pass/i);
    backup(['restore', join(backupRoot, 'volume.arcobk'), '--into', join(backupRoot, 'restored')]);
    assert.deepEqual(JSON.parse(readFileSync(join(backupRoot, 'restored', 'settings.json'), 'utf8')), JSON.parse(settingsOnVolume), 'the backed-up settings restore intact');
  } finally { rmSync(backupRoot, { recursive: true, force: true }); }
  console.log('PASS: the data volume home is captured by backup and its settings restore intact');
  docker('stop', '--time', '20', name); docker('rm', name);
  await boot(true);
  // Provider sign-in from inside the container, against the CLI fixtures:
  // the documented `docker compose exec` commands run the provider CLI with the
  // service's persistent home, so the running server sees the new login.
  const authHeaders = { Cookie: await cookie(), Origin: base, 'Content-Type': 'application/json' };
  const authStatus = async () => (await fetch(`${base}/api/auth-status`, { headers: authHeaders })).json();
  assert.equal((await authStatus()).codex.loggedIn, false);
  const device = docker('exec', name, 'codex', 'login', '--device-auth');
  assert.match(device, /https:\/\/auth\.example\.test\/codex\/device/);
  assert.match(device, /ARCO-FIXTURE-CODE/);
  assert.match(docker('exec', name, 'codex', 'login', 'status'), /Logged in/);
  assert.ok(docker('exec', name, 'sh', '-c', 'test -f "$CODEX_HOME/fixture-login" && echo yes').trim() === 'yes', 'Codex login is stored in the data volume');
  const pasted = execFileSync('docker', ['exec', '-i', name, 'claude', 'auth', 'login', '--claudeai'], { input: 'ARCO-FIXTURE-PASTE\n', encoding: 'utf8' });
  assert.match(pasted, /https:\/\/auth\.example\.test\/claude\/authorize/);
  assert.match(pasted, /Login successful/);
  assert.match(docker('exec', name, 'claude', 'auth', 'status'), /"loggedIn":true/);
  console.log('PASS: device sign-in for Codex and paste-back sign-in for Claude through docker exec, stored on the volume');
  const cluster = await clusterSmoke({
    connect, disconnect,
    send: message => socket.send(JSON.stringify(message)),
    api: async (path, options = {}) => fetch(`${base}${path}`, { ...options, headers: { Cookie: await cookie(), Origin: base, 'Content-Type': 'application/json' } }),
    hostModel: HOST_MODEL,
  });
  assert.equal(readFileSync(join(project, 'fixture-result.txt'), 'utf8'), 'Fixture worker edited the mounted project.\n');
  const eventsOf = workflowId => readFileSync(join(project, '.arco/workflows', workflowId, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const events = eventsOf(cluster.coordinator);
  assert.ok(events.some(event => event.type === 'review_artifact_ready'));
  assert.ok(events.some(event => event.type === 'peer_message_sent'));
  assert.ok(events.some(event => event.type === 'operator_question'));
  const local = eventsOf(cluster.local);
  assert.ok(local.some(event => event.type === 'peer_message_received' && event.from === cluster.coordinator));
  assert.ok(local.some(event => event.type === 'peer_message_sent' && event.to === cluster.coordinator));
  for (const tool of ['peer_list', 'peer_send']) assert.ok(local.some(event => event.type === 'primary_tool_use' && event.tool === tool), `host member must record ${tool}`);
  assert.deepEqual(hostModel.errors, []);
  for (const route of ['GET /api/tags', 'POST /api/show', 'POST /api/chat']) assert.ok(hostModel.requests.includes(route), `host model never received ${route}`);
  console.log('PASS: fixture edits reach host files and mixed-provider cluster effects are durably recorded');
} catch (error) {
  try {
    // Synthetic state only. Keep diagnostics out of source and CI artifacts.
    const log = join(tmpdir(), `${name}.log`);
    writeFileSync(log, docker('logs', name));
    console.error(`Container log: ${log}`);
  } catch { /* Container may not have started. */ }
  throw error;
} finally {
  await disconnect();
  await hostModel.close();
  // The container user (uid 1000) creates files in the bind-mounted project.
  // When the host user has another uid (hosted runners use 1001), the host
  // cannot delete them, so hand them to everyone from inside a container first.
  const openUp = ['chmod', '-R', 'a+rwX', '/projects'];
  try { docker('exec', '-u', '0', name, ...openUp); } catch {
    try { docker('run', '--rm', '-u', '0', '--entrypoint', openUp[0], '--mount', `type=bind,src=${project},dst=/projects`, image, ...openUp.slice(1)); } catch { /* Image or daemon unavailable. */ }
  }
  try { docker('rm', '-f', name); } catch { /* Already removed. */ }
  try { docker('volume', 'rm', volume); } catch { /* Not created. */ }
  rmSync(project, { recursive: true, force: true });
  rmSync(fixtureBin, { recursive: true, force: true });
}
