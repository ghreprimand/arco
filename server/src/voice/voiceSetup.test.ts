import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cancelVoiceInstall, startVoiceInstall, voiceInstallRunning, voiceSetupStatus, VOICE_SETUP_MODELS, VOICE_SETUP_PACKAGES, VOICE_TEST_MAX_BYTES } from './voiceSetup.js';
import { LocalRecognizer } from './localRecognizer.js';
import { tryHandleVoiceRoutes } from '../http/voiceRoutes.js';

const setupPy = readFileSync(fileURLToPath(new URL('../../../scripts/voice/setup.py', import.meta.url)), 'utf8');
const touch = (path: string, body = '') => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); };

function withVoiceHome(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), 'arco-voice-setup-'));
  const prev = process.env.ARCO_VOICE_HOME;
  process.env.ARCO_VOICE_HOME = root;
  t.after(() => { if (prev === undefined) delete process.env.ARCO_VOICE_HOME; else process.env.ARCO_VOICE_HOME = prev; rmSync(root, { recursive: true, force: true }); });
  return root;
}

function installFixture(root: string, platform: NodeJS.Platform, skipParakeet = false) {
  touch(join(root, 'venv', platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
  touch(join(root, 'venv', 'pyvenv.cfg'), 'home = /usr/bin\nversion_info = 3.12.9\n');
  const site = platform === 'win32' ? join(root, 'venv', 'Lib', 'site-packages') : join(root, 'venv', 'lib', 'python3.12', 'site-packages');
  for (const [name, v] of [['sherpa_onnx', '1.13.3'], ['numpy', '2.2.6'], ['vosk', '0.3.45']]) mkdirSync(join(site, `${name}-${v}.dist-info`), { recursive: true });
  for (const m of VOICE_SETUP_MODELS) if (!(skipParakeet && m.skipOn)) touch(join(root, m.name, m.marker));
  for (const f of ['preprocess.onnx', 'encode.int8.onnx', 'uncached_decode.int8.onnx', 'cached_decode.int8.onnx']) touch(join(root, 'sherpa-onnx-moonshine-tiny-en-int8', f));
  if (!skipParakeet) for (const f of ['decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']) touch(join(root, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', f));
}

test('the status list matches what scripts/voice/setup.py installs', () => {
  for (const m of VOICE_SETUP_MODELS) {
    assert(setupPy.includes(`'name': '${m.name}', 'marker': '${m.marker}'`), `${m.name} and its marker are in setup.py`);
  }
  for (const p of VOICE_SETUP_PACKAGES) assert(setupPy.includes(`('${p}==`), `${p} is pinned in setup.py`);
  assert(setupPy.includes("'skip': os.name == 'nt'"), 'setup.py still skips Parakeet on Windows');
});

test('status reports an empty voice home, then versions and models after setup', async (t) => {
  const root = withVoiceHome(t);
  const empty = await voiceSetupStatus({ ARCO_VOICE_HOME: root }, 'linux');
  assert.equal(empty.voiceHome, root); assert.equal(empty.voiceHomeFromEnv, true);
  assert.equal(empty.ready, false); assert.equal(empty.python.found, false); assert.equal(empty.notices, false);
  assert(empty.packages.every((p) => p.version === null)); assert(empty.models.every((m) => !m.installed));
  installFixture(root, process.platform);
  touch(join(root, 'NOTICES.md'), '# notices\n');
  const full = await voiceSetupStatus({}, process.platform);
  assert.equal(full.ready, true); assert.equal(full.notices, true); assert.equal(full.voiceHomeFromEnv, false);
  assert.deepEqual(full.python, { found: true, version: '3.12.9' });
  assert.deepEqual(full.packages.map((p) => p.version), ['1.13.3', '2.2.6', '0.3.45']);
});

test('Parakeet is not required where setup.py skips it', async (t) => {
  const root = withVoiceHome(t);
  installFixture(root, process.platform, true);
  const status = await voiceSetupStatus({}, 'win32');
  const parakeet = status.models.find((m) => m.name.includes('parakeet'))!;
  assert.equal(parakeet.installed, false); assert.equal(parakeet.applies, false); assert.equal(status.ready, true);
  assert.equal((await voiceSetupStatus({}, 'linux')).ready, false);
});

test('Docker reports voice as native-only and refuses to install', async (t) => {
  withVoiceHome(t);
  const status = await voiceSetupStatus({ ARCO_DEPLOYMENT: 'docker' }, 'linux');
  assert.equal(status.deployment, 'docker'); assert.equal(status.uv.found, false);
  const started = startVoiceInstall({ ARCO_DEPLOYMENT: 'docker' });
  assert.equal(started.ok, false); assert.equal(!started.ok && started.status, 400);
});

const waitIdle = async () => { for (let i = 0; i < 400 && voiceInstallRunning(); i++) await new Promise((r) => setTimeout(r, 25)); };

test('install streams the script output, records the exit code and refuses a second run', async (t) => {
  withVoiceHome(t);
  const script = "console.log('Downloading model'); console.error('warning line'); setTimeout(() => process.exit(3), 200)";
  assert.deepEqual(startVoiceInstall(process.env, { file: process.execPath, args: ['-e', script] }), { ok: true });
  const again = startVoiceInstall(process.env, { file: process.execPath, args: ['-e', ''] });
  assert.equal(!again.ok && again.status, 409);
  await waitIdle();
  const { install } = await voiceSetupStatus();
  assert.equal(install.running, false); assert.equal(install.exitCode, 3);
  assert.match(install.log, /Downloading model/); assert.match(install.log, /warning line/); assert.match(install.log, /exited with code 3/);
});

test('cancel stops a running install', async (t) => {
  withVoiceHome(t);
  assert.deepEqual(startVoiceInstall(process.env, { file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }), { ok: true });
  assert.equal(cancelVoiceInstall(), true);
  await waitIdle();
  const { install } = await voiceSetupStatus();
  assert.equal(install.running, false); assert.notEqual(install.exitCode, 0); assert.match(install.log, /cancel requested/);
  assert.equal(cancelVoiceInstall(), false);
});

test('the test phrase route needs local speech, bounds the audio and returns the text', async (t) => {
  const root = withVoiceHome(t);
  const stopped: LocalRecognizer[] = [];
  t.mock.method(LocalRecognizer.prototype, 'stop', function (this: LocalRecognizer) { stopped.push(this); });
  t.mock.method(LocalRecognizer.prototype, 'recognize', async () => ({ text: 'testing one two three', phrases: '' }));
  const unfinishedUploads: Array<{ destroyed: boolean; complete: boolean }> = [];
  const server = createServer((req, res) => {
    void tryHandleVoiceRoutes(req, res).then(() => {
      if (req.headers['transfer-encoding'] === 'chunked') unfinishedUploads.push({ destroyed: req.destroyed, complete: req.complete });
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (body: Buffer) => fetch(base + '/api/voice/setup/transcribe', { method: 'POST', body: new Blob([new Uint8Array(body)]) });
  try {
    assert.equal((await post(Buffer.alloc(3200))).status, 503);
    assert.equal((await fetch(base + '/api/voice/setup/notices')).status, 404);
    installFixture(root, process.platform);
    touch(join(root, 'NOTICES.md'), '# Voice components\n');
    assert.equal((await post(Buffer.alloc(3201))).status, 400);
    assert.equal((await post(Buffer.alloc(16000 * 2 * 11))).status, 400);
    // Do not end the upload until the error response arrives. This pins the
    // rejection while a body is still in flight, independently of packet timing.
    const oversized = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const upload = request(base + '/api/voice/setup/transcribe', { method: 'POST' }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('error', reject);
        res.on('end', () => { upload.end(); resolve({ status: res.statusCode!, body }); });
      });
      upload.on('error', reject);
      upload.setTimeout(3000, () => upload.destroy(new Error('Oversized upload response timed out.')));
      upload.write(Buffer.alloc(VOICE_TEST_MAX_BYTES + 2));
    });
    assert.equal(oversized.status, 400);
    assert.match(JSON.parse(oversized.body).error, /exceeds its limit/);
    assert.deepEqual(unfinishedUploads, [{ destroyed: false, complete: false }], 'reject without aborting the request socket before its JSON response');
    const ok = await post(Buffer.alloc(3200));
    assert.equal(ok.status, 200);
    const body = await ok.json() as { text: string; recognizer: string };
    assert.equal(body.text, 'testing one two three'); assert.equal(stopped.length, 1, 'the one-off recognizer is stopped');
    const notices = await fetch(base + '/api/voice/setup/notices');
    assert.equal(notices.status, 200); assert.equal(await notices.text(), '# Voice components\n');
    const status = await (await fetch(base + '/api/voice/setup')).json() as { ready: boolean };
    assert.equal(status.ready, true);
  } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
});
