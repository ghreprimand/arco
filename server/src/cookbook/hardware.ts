// ── Cookbook hardware probe (Workbench Expansion G1) ──
//
// Detect the serving box's GPU(s)/VRAM, system RAM, core count, and backend, so
// the fit engine (fit.ts) can size models against REAL hardware automatically.
// On the Linux 5090 this shells out to `nvidia-smi`; on macOS / a box without
// nvidia-smi it falls back to a Metal / CPU profile (gpus=[], a note) rather than
// throwing. The probe is READ-ONLY — it never writes or mutates anything on the
// system; it only reads RAM/cores via `os` and GPU info via nvidia-smi stdout.
//
// SECURITY (the #1 review item): the nvidia-smi call uses execFile with an ARGV
// array — a fixed binary name and a fixed, literal argument list. NEVER a shell
// string, NEVER any interpolation of a value into a command. There is no operator
// input on this path at all; the argv is a compile-time constant.

import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import type {
  HardwareProfile,
  GpuInfo,
  HardwareSimPreset,
} from '@archon/shared';

const execFileAsync = promisify(execFile);

// In-module cache. probeHardware() populates it; rescanHardware() clears it and
// re-probes. The cache means repeated fit-scoring calls don't re-spawn
// nvidia-smi on every request.
let cached: HardwareProfile | null = null;
let inFlight: Promise<HardwareProfile> | null = null;

// Parse `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`.
// Each line: "NVIDIA GeForce RTX 5090, 32607" (name, MiB). memory.total is MiB.
function parseNvidiaSmi(stdout: string): GpuInfo[] {
  const gpus: GpuInfo[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // Split on the LAST comma so a GPU name containing a comma (rare) stays intact.
    const lastComma = line.lastIndexOf(',');
    if (lastComma < 0) continue;
    const name = line.slice(0, lastComma).trim();
    const mibStr = line.slice(lastComma + 1).trim();
    const mib = Number(mibStr);
    if (!name || !Number.isFinite(mib) || mib <= 0) continue;
    gpus.push({ name, vramBytes: Math.round(mib * 1024 * 1024) });
  }
  return gpus;
}

// Build the macOS / no-GPU fallback profile. backend is 'metal' on darwin (Apple
// Silicon unified memory) else 'cpu'. gpus stays empty (the operator can declare
// VRAM by hand in a later phase); RAM + cores are still populated.
function fallbackProfile(reason: string): HardwareProfile {
  const backend: HardwareProfile['backend'] = os.platform() === 'darwin' ? 'metal' : 'cpu';
  return {
    gpus: [],
    totalVramBytes: 0,
    systemRamBytes: os.totalmem(),
    cores: os.cpus().length,
    backend,
    note: reason,
  };
}

// ── Apple Silicon unified-memory budget (DD15) ───────────────────────────────
//
// On Apple Silicon there is no discrete VRAM: the GPU addresses a large fraction
// of system RAM as "VRAM" (unified memory). Before DD15 the darwin probe returned
// totalVramBytes:0, so every model scored NO. We instead derive a GPU-addressable
// budget so the fit engine sizes against the RAM the Metal backend can actually
// wire.
//
// macOS lets the GPU wire a size-scaled fraction of unified memory — bigger boxes
// can dedicate a larger share because the OS's fixed reserve is a smaller slice.
// The operator can override the kernel limit via `sysctl iogpu.wired_limit_mb`;
// when set (>0) that exact value wins. These thresholds/fractions are PORTED
// constants (matching the macOS defaults), not imported.
const APPLE_BUDGET_FRACTION_SMALL = 0.67; // ≤ 36 GB boxes
const APPLE_BUDGET_FRACTION_MED = 0.75; // ≤ 64 GB
const APPLE_BUDGET_FRACTION_LARGE = 0.8; // > 64 GB
const GIB = 1024 * 1024 * 1024;

export function appleUnifiedMemoryBudget(systemRamBytes: number, wiredLimitMb?: number): number {
  // Operator override via `sysctl iogpu.wired_limit_mb` — exact, wins over the
  // heuristic. 0 / unset falls through to the size-scaled fraction.
  if (wiredLimitMb && wiredLimitMb > 0) return Math.floor(wiredLimitMb * 1024 * 1024);
  if (!Number.isFinite(systemRamBytes) || systemRamBytes <= 0) return 0;
  const gb = systemRamBytes / GIB;
  const frac = gb <= 36 ? APPLE_BUDGET_FRACTION_SMALL : gb <= 64 ? APPLE_BUDGET_FRACTION_MED : APPLE_BUDGET_FRACTION_LARGE;
  return Math.floor(systemRamBytes * frac);
}

// Parse the GPU model + core count from `system_profiler SPDisplaysDataType -json`.
// Returns the first display whose name contains "apple" (the Apple-Silicon guard —
// an Intel Mac with a non-Apple GPU is NOT unified memory and must not get a budget).
// Pure; exported for the smoke. `sppci_cores` is the GPU core count (a string).
export function parseAppleGpu(stdout: string): { name: string; cores?: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const displays = (parsed as { SPDisplaysDataType?: unknown })?.SPDisplaysDataType;
  if (!Array.isArray(displays)) return null;
  for (const d of displays) {
    const rec = d as Record<string, unknown>;
    const name = String(rec?.sppci_model ?? rec?._name ?? '');
    if (!/apple/i.test(name)) continue;
    const c = Number(rec?.sppci_cores);
    return { name, ...(Number.isFinite(c) && c > 0 ? { cores: c } : {}) };
  }
  return null;
}

// Read `sysctl -n iogpu.wired_limit_mb`. execFile argv only, no shell. Returns the
// MB value when the operator has overridden the GPU wired limit, else undefined
// (the sysctl is absent / returns 0 / the call fails on a non-Apple box).
async function readWiredLimitMb(): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync('sysctl', ['-n', 'iogpu.wired_limit_mb'], { timeout: 3000 });
    const mb = Number(stdout.trim());
    return Number.isFinite(mb) && mb > 0 ? mb : undefined;
  } catch {
    return undefined;
  }
}

// Probe Apple Silicon: detect the GPU (model + cores), derive the unified-memory
// budget, and present it as VRAM so the fit engine stops scoring every model NO.
// READ-ONLY (system_profiler + sysctl, both execFile argv, no shell). Falls back
// to the conservative no-VRAM profile when no Apple GPU is found (Intel Mac, or
// the probe fails).
async function probeAppleSilicon(): Promise<HardwareProfile> {
  const systemRamBytes = os.totalmem();
  const cores = os.cpus().length;

  let gpu: { name: string; cores?: number } | null = null;
  try {
    // execFile with an ARGV ARRAY — fixed binary, fixed literal args, no shell.
    const { stdout } = await execFileAsync('system_profiler', ['SPDisplaysDataType', '-json'], { timeout: 5000 });
    gpu = parseAppleGpu(stdout);
  } catch {
    /* no system_profiler / parse miss → fall through to fallback below */
  }

  // Not Apple Silicon (Intel Mac, or the probe couldn't find an Apple GPU): keep
  // the conservative fallback (no unified-memory budget — don't pretend an Intel
  // iGPU has hundreds of GB of VRAM).
  if (!gpu) {
    return fallbackProfile('macOS: no Apple-Silicon GPU detected; Metal/CPU profile (set VRAM manually)');
  }

  const wiredLimitMb = await readWiredLimitMb();
  const budget = appleUnifiedMemoryBudget(systemRamBytes, wiredLimitMb);
  const budgetGb = Math.round(budget / GIB);
  const ramGb = Math.round(systemRamBytes / GIB);
  return {
    gpus: [{ name: gpu.name, vramBytes: budget }],
    totalVramBytes: budget,
    systemRamBytes,
    cores,
    ...(gpu.cores ? { gpuCores: gpu.cores } : {}),
    backend: 'metal',
    note: `Apple Silicon unified memory: ${budgetGb} GB GPU-addressable of ${ramGb} GB${wiredLimitMb ? ' (iogpu.wired_limit_mb override)' : ''}`,
  };
}

// Probe the hardware once and cache it. READ-ONLY. Never throws — a failed /
// missing nvidia-smi (ENOENT on macOS, non-zero exit, parse miss) degrades to the
// fallback profile.
export async function probeHardware(): Promise<HardwareProfile> {
  if (cached) return cached;
  if (inFlight) return inFlight;
  inFlight = doProbe()
    .then((p) => {
      cached = p;
      return p;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

async function doProbe(): Promise<HardwareProfile> {
  // macOS never has nvidia-smi; probe Apple Silicon's unified memory instead (the
  // GPU addresses a fraction of system RAM as VRAM — DD15) rather than scoring NO.
  if (os.platform() === 'darwin') {
    return probeAppleSilicon();
  }
  try {
    // execFile with an ARGV ARRAY — fixed binary, fixed literal args, no shell,
    // no interpolation. See the security note at the top of this file.
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 5000 },
    );
    const gpus = parseNvidiaSmi(stdout);
    if (gpus.length === 0) {
      return fallbackProfile('nvidia-smi returned no GPUs; CPU profile');
    }
    const totalVramBytes = gpus.reduce((sum, g) => sum + g.vramBytes, 0);
    return {
      gpus,
      totalVramBytes,
      systemRamBytes: os.totalmem(),
      cores: os.cpus().length,
      backend: 'cuda',
    };
  } catch (err) {
    // ENOENT (no nvidia-smi on PATH) or any other failure → fallback, no throw.
    const code = (err as NodeJS.ErrnoException)?.code;
    const reason =
      code === 'ENOENT'
        ? 'nvidia-smi not found; CPU profile (no CUDA GPU detected)'
        : `nvidia-smi probe failed (${code ?? 'error'}); CPU profile`;
    return fallbackProfile(reason);
  }
}

// Clear the cache and re-probe (the operator-facing RESCAN). Returns the fresh
// profile.
export async function rescanHardware(): Promise<HardwareProfile> {
  cached = null;
  inFlight = null;
  return probeHardware();
}

// ── Hardware-simulation presets ───────────────────────────────────────────────
// Hypothetical rigs the operator can preview a fit against without owning them.
// RAM is the CPU-only box (system RAM as the budget, no VRAM). gpu1..gpu8 are
// N × a 5090-class 32 GB CUDA card. Pure data — no system reads.
const GPU_5090_VRAM_BYTES = 32 * 1024 * 1024 * 1024; // 32 GiB
const SIM_SYSTEM_RAM_BYTES = 128 * 1024 * 1024 * 1024; // assume a 128 GB host
const SIM_CORES = 32;

function nGpuProfile(n: number): HardwareProfile {
  const gpus: GpuInfo[] = [];
  for (let i = 0; i < n; i++) gpus.push({ name: 'NVIDIA RTX 5090 (simulated)', vramBytes: GPU_5090_VRAM_BYTES });
  return {
    gpus,
    totalVramBytes: GPU_5090_VRAM_BYTES * n,
    systemRamBytes: SIM_SYSTEM_RAM_BYTES,
    cores: SIM_CORES,
    backend: 'cuda',
    note: `simulated: ${n} × RTX 5090 (32 GB)`,
  };
}

export function simulatedProfile(preset: HardwareSimPreset): HardwareProfile {
  switch (preset) {
    case 'ram':
      return {
        gpus: [],
        totalVramBytes: 0,
        systemRamBytes: SIM_SYSTEM_RAM_BYTES,
        cores: SIM_CORES,
        backend: 'cpu',
        note: 'simulated: CPU / system-RAM only (no GPU)',
      };
    case 'gpu1':
      return nGpuProfile(1);
    case 'gpu2':
      return nGpuProfile(2);
    case 'gpu4':
      return nGpuProfile(4);
    case 'gpu8':
      return nGpuProfile(8);
  }
}
