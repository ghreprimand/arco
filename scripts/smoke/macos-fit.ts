// DD15 — macOS unified-memory fit smoke.
//
// PURE-FUNCTION phase: no server, no WS, NO Mac required. Builds a SYNTHETIC
// Apple-Silicon HardwareProfile (the shape probeAppleSilicon() would return on a
// real Mac) and runs it through scoreFit + the pure budget/bandwidth helpers.
// Asserts the DD15 fix:
//
//   1. appleUnifiedMemoryBudget scales by RAM size (0.67 / 0.75 / 0.80) and the
//      sysctl iogpu.wired_limit_mb override wins.
//   2. parseAppleGpu pulls name + cores and applies the "apple"-name guard.
//   3. The pre-DD15 darwin profile (totalVramBytes 0) scores NO — proving the
//      bug the fix addresses.
//   4. A synthetic Apple-Silicon profile (unified-memory budget as VRAM) scores
//      a 32B Q4_K_M model NON-NO on GPU — the fix.
//   5. Throughput tiers with GPU cores (APPLE_BANDWIDTH_BY_CORES): more cores →
//      higher t/s for the same model.
//
// Run: npm run smoke:macos-fit  (no dev server, no Mac needed)

import { step, assert, assertEq, summary } from './lib.js';
import { scoreFit, APPLE_BANDWIDTH_BY_CORES } from '../../server/src/cookbook/fit.js';
import { appleUnifiedMemoryBudget, parseAppleGpu } from '../../server/src/cookbook/hardware.js';
import type { HardwareProfile, ModelSpec } from '@arco/shared';

const GB = 1024 * 1024 * 1024;

// A 32B coder at Q4_K_M — the model that scored NO on darwin pre-DD15.
const qwenCoder32b: ModelSpec = { params: 32, quant: 'Q4_K_M', arch: 'qwen', contextMax: 131072 };

// Build a synthetic Apple-Silicon profile the way probeAppleSilicon() would.
function appleProfile(ramGb: number, gpuCores: number, wiredLimitMb?: number): HardwareProfile {
  const systemRamBytes = ramGb * GB;
  const budget = appleUnifiedMemoryBudget(systemRamBytes, wiredLimitMb);
  return {
    gpus: [{ name: 'Apple M3 Max', vramBytes: budget }],
    totalVramBytes: budget,
    systemRamBytes,
    cores: 16,
    gpuCores,
    backend: 'metal',
  };
}

async function main() {
  await step('appleUnifiedMemoryBudget scales by RAM size (0.67 / 0.75 / 0.80)', () => {
    assertEq(appleUnifiedMemoryBudget(32 * GB), Math.floor(32 * GB * 0.67), '32 GB → 0.67');
    assertEq(appleUnifiedMemoryBudget(64 * GB), Math.floor(64 * GB * 0.75), '64 GB → 0.75');
    assertEq(appleUnifiedMemoryBudget(128 * GB), Math.floor(128 * GB * 0.8), '128 GB → 0.80');
  });

  await step('sysctl iogpu.wired_limit_mb override wins over the fraction', () => {
    const budget = appleUnifiedMemoryBudget(64 * GB, 60000); // 60000 MB ≈ 58.6 GB
    assertEq(budget, Math.floor(60000 * 1024 * 1024), 'override → exact MB value');
    assert(budget > Math.floor(64 * GB * 0.75), 'override exceeds the default fraction here');
  });

  await step('parseAppleGpu pulls name + cores, applies the apple-name guard', () => {
    const apple = parseAppleGpu(JSON.stringify({ SPDisplaysDataType: [{ sppci_model: 'Apple M3 Max', sppci_cores: '40' }] }));
    assert(apple !== null && apple.cores === 40 && /apple/i.test(apple.name), 'Apple GPU parsed with 40 cores');
    const intel = parseAppleGpu(JSON.stringify({ SPDisplaysDataType: [{ sppci_model: 'Intel Iris Plus' }] }));
    assertEq(intel, null, 'non-Apple GPU is rejected by the name guard');
    assertEq(parseAppleGpu('not json'), null, 'malformed JSON → null');
  });

  await step('pre-DD15 darwin profile (VRAM 0) scores a 32B model NO (the bug)', () => {
    const oldDarwin: HardwareProfile = {
      gpus: [], totalVramBytes: 0, systemRamBytes: 64 * GB, cores: 16, backend: 'metal',
    };
    const r = scoreFit(qwenCoder32b, oldDarwin);
    assertEq(r.verdict, 'NO', 'VRAM 0 → NO (every model scored NO before DD15)');
  });

  await step('synthetic Apple-Silicon profile scores the 32B model NON-NO on GPU (the fix)', () => {
    // 64 GB M-series → ~48 GB unified budget, comfortably fits a 32B Q4.
    const r = scoreFit(qwenCoder32b, appleProfile(64, 40));
    assert(r.verdict !== 'NO', `expected a fitting verdict on unified memory, got ${r.verdict}`);
    assertEq(r.mode, 'gpu', 'fits in unified memory → gpu mode');
    assert(r.maxContextThatFits >= 8192, `expected a usable ctx, got ${r.maxContextThatFits}`);
    assert(r.throughputTps > 0, 'throughput must be positive');
  });

  await step('throughput tiers with GPU cores (APPLE_BANDWIDTH_BY_CORES)', () => {
    // Same model + RAM; only GPU cores differ → bandwidth (hence t/s) must rise.
    const base = scoreFit(qwenCoder32b, appleProfile(96, 8)); // ~100 GB/s tier
    const ultra = scoreFit(qwenCoder32b, appleProfile(96, 64)); // ~800 GB/s tier
    assert(ultra.throughputTps > base.throughputTps, `ultra (${ultra.throughputTps}) must beat base (${base.throughputTps})`);
    // Table is monotonic in bandwidth across ascending core tiers.
    for (let i = 1; i < APPLE_BANDWIDTH_BY_CORES.length; i++) {
      assert(APPLE_BANDWIDTH_BY_CORES[i].bytesPerSec > APPLE_BANDWIDTH_BY_CORES[i - 1].bytesPerSec, 'bandwidth rises with cores');
    }
  });

  summary('macos-fit');
}

main();
