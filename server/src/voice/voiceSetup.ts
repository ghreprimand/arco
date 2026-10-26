// Settings -> VOICE SETUP. Reports what `npm run voice:setup` has installed
// under the voice home, runs that same script on request with a bounded live
// log, and transcribes one short test phrase through the local recognizer.
// Nothing here listens: the browser records the test phrase and sends it once.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killProcessTree } from '../workers/processKill.js';
import { voicePaths } from './localRecognizer.js';

// The components scripts/voice/setup.py installs, with the file that marks
// each one complete. voiceSetup.test.ts checks this list against setup.py.
export const VOICE_SETUP_MODELS: ReadonlyArray<{ name: string; marker: string; title: string; size: string; skipOn?: NodeJS.Platform }> = [
  { name: 'sherpa-onnx-moonshine-tiny-en-int8', marker: 'tokens.txt', title: 'Moonshine tiny speech recognition', size: '~108 MB' },
  { name: 'kokoro-multi-lang-v1_0', marker: 'model.onnx', title: 'Kokoro speech output voices', size: '~350 MB' },
  { name: 'vosk-model-small-en-us-0.15', marker: 'am/final.mdl', title: 'Vosk wake and reserved phrases', size: '~41 MB' },
  // setup.py skips Parakeet on Windows, where the recognizer keeps Moonshine.
  { name: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', marker: 'encoder.int8.onnx', title: 'Parakeet v3 speech recognition', size: '~487 MB', skipOn: 'win32' },
];
export const VOICE_SETUP_PACKAGES = ['sherpa-onnx', 'numpy', 'vosk'] as const;

const LOG_LIMIT = 64_000;
export const VOICE_TEST_MAX_BYTES = 16000 * 2 * 10;

export interface VoiceSetupStatus {
  deployment: 'docker' | 'host';
  platform: NodeJS.Platform;
  voiceHome: string;
  voiceHomeFromEnv: boolean;
  uv: { found: boolean; version: string | null };
  python: { found: boolean; version: string | null };
  packages: Array<{ name: string; version: string | null }>;
  models: Array<{ name: string; title: string; size: string; installed: boolean; applies: boolean }>;
  ready: boolean;
  notices: boolean;
  install: { running: boolean; exitCode: number | null; startedAt: number | null; finishedAt: number | null; log: string };
}

function sitePackages(root: string): string[] {
  const venv = join(root, 'venv');
  const dirs = [join(venv, 'Lib', 'site-packages')];
  try {
    for (const entry of readdirSync(join(venv, 'lib'))) dirs.push(join(venv, 'lib', entry, 'site-packages'));
  } catch { /* no POSIX lib folder */ }
  return [...new Set(dirs)].filter((d) => existsSync(d));
}

// Package versions from the venv's *.dist-info folder names; no Python start.
export function installedPackages(root: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const dir of sitePackages(root)) {
    for (const entry of readdirSync(dir)) {
      const m = /^(.+)-([^-]+)\.dist-info$/.exec(entry);
      if (m) found.set(m[1].toLowerCase().replace(/[-_.]+/g, '-'), m[2]);
    }
  }
  return found;
}

// pyvenv.cfg records the interpreter version the environment was made with.
export function venvPythonVersion(root: string): string | null {
  try {
    const cfg = readFileSync(join(root, 'venv', 'pyvenv.cfg'), 'utf8');
    return /^\s*version(?:_info)?\s*=\s*(\S+)/m.exec(cfg)?.[1] ?? null;
  } catch { return null; }
}

type Probe = { found: boolean; version: string | null };
let uvCache: { at: number; value: Probe } | null = null;
async function probeUv(): Promise<Probe> {
  if (uvCache && Date.now() - uvCache.at < 15_000) return uvCache.value;
  const value = await new Promise<Probe>((resolve) => {
    let out = '';
    const child = spawn('uv', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const timer = setTimeout(() => { child.kill(); resolve({ found: false, version: null }); }, 5000);
    child.stdout.on('data', (d) => { out += String(d); });
    child.on('error', () => { clearTimeout(timer); resolve({ found: false, version: null }); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? { found: true, version: out.trim().split(/\s+/)[1] ?? null } : { found: false, version: null }); });
  });
  uvCache = { at: Date.now(), value };
  return value;
}

interface InstallJob { child: ChildProcess | null; exitCode: number | null; startedAt: number | null; finishedAt: number | null; log: string }
const job: InstallJob = { child: null, exitCode: null, startedAt: null, finishedAt: null, log: '' };
const append = (text: string) => { job.log = (job.log + text).slice(-LOG_LIMIT); };

export async function voiceSetupStatus(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<VoiceSetupStatus> {
  const paths = voicePaths();
  const root = paths.root;
  const pkgs = installedPackages(root);
  const models = VOICE_SETUP_MODELS.map((m) => ({ name: m.name, title: m.title, size: m.size,
    installed: existsSync(join(root, m.name, m.marker)), applies: m.skipOn !== platform }));
  const packages = VOICE_SETUP_PACKAGES.map((name) => ({ name, version: pkgs.get(name) ?? null }));
  const deployment = env.ARCO_DEPLOYMENT === 'docker' ? 'docker' : 'host';
  const pythonFound = existsSync(paths.python);
  return {
    deployment, platform, voiceHome: root, voiceHomeFromEnv: Boolean(env.ARCO_VOICE_HOME),
    uv: deployment === 'docker' ? { found: false, version: null } : await probeUv(),
    python: { found: pythonFound, version: pythonFound ? venvPythonVersion(root) : null },
    packages, models,
    ready: pythonFound && packages.every((p) => p.version) && models.every((m) => m.installed || !m.applies),
    notices: existsSync(join(root, 'NOTICES.md')),
    install: { running: job.child !== null, exitCode: job.exitCode, startedAt: job.startedAt, finishedAt: job.finishedAt, log: job.log },
  };
}

export const VOICE_SETUP_SCRIPT = fileURLToPath(new URL('../../../scripts/voice/run.mjs', import.meta.url));

// Runs `node scripts/voice/run.mjs setup.py`, exactly what voice:setup runs.
export function startVoiceInstall(env: NodeJS.ProcessEnv = process.env,
  command: { file: string; args: string[] } = { file: process.execPath, args: [VOICE_SETUP_SCRIPT, 'setup.py'] }): { ok: true } | { ok: false; error: string; status: number } {
  if (env.ARCO_DEPLOYMENT === 'docker') return { ok: false, status: 400, error: 'Voice runs on a native install; the Docker image has no microphone or speech runtime.' };
  if (job.child) return { ok: false, status: 409, error: 'Voice setup is already running.' };
  if (command.args[0] === VOICE_SETUP_SCRIPT && !existsSync(VOICE_SETUP_SCRIPT)) return { ok: false, status: 500, error: 'scripts/voice/run.mjs is missing from this install.' };
  job.log = ''; job.exitCode = null; job.finishedAt = null; job.startedAt = Date.now();
  append('$ npm run voice:setup\n');
  const child = spawn(command.file, command.args, { env: { ...env, PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  job.child = child;
  child.stdout?.on('data', (d) => append(String(d)));
  child.stderr?.on('data', (d) => append(String(d)));
  const finish = (code: number | null) => {
    if (job.child !== child) return;
    job.child = null; job.exitCode = code ?? 1; job.finishedAt = Date.now();
    append(`\n[voice setup ${job.exitCode === 0 ? 'finished' : `exited with code ${job.exitCode}`}]\n`);
    uvCache = null;
  };
  child.on('error', (e) => { append(`${e.message}\n`); finish(1); });
  child.on('close', (code) => finish(code));
  return { ok: true };
}

export function cancelVoiceInstall(): boolean {
  const pid = job.child?.pid;
  if (!pid) return false;
  append('\n[cancel requested]\n');
  killProcessTree(pid);
  return true;
}

export async function readVoiceNotices(): Promise<string | null> {
  try { return await readFile(join(voicePaths().root, 'NOTICES.md'), 'utf8'); } catch { return null; }
}

export function voiceInstallRunning(): boolean { return job.child !== null; }
