// Workbench Expansion G1 — Cookbook fit/scoring engine smoke.
//
// PURE-FUNCTION phase: no server, no WS. Imports scoreFit directly, runs sample
// models against a fixed RTX 5090 profile (32 GB, cuda) + the simulation presets,
// and asserts the verdicts/scores/modes the engine must produce:
//
//   1. A qwen-coder-class 32B Q4_K_M FITS on the 5090 (GOOD/PERFECT) at a
//      plausible max context, mode 'gpu'.
//   2. A ~200B model does NOT fit on the single 5090 → verdict NO / cpu-offload.
//   3. Determinism: scoreFit called twice with identical args returns an
//      identical result.
//   4. The same 200B model on the 8×5090 simulated rig fits (mode gpu, not NO).
//
// Run: npm run smoke:cookbook-fit  (no dev server needed)

import { step, assert, assertEq, summary } from './lib.js';
import { scoreFit, estimateVram, QUANT_BPW } from '../../server/src/cookbook/fit.js';
import { simulatedProfile } from '../../server/src/cookbook/hardware.js';
import type { HardwareProfile, ModelSpec } from '@arco/shared';

const GB = 1024 * 1024 * 1024;

// Fixed, detected-style profile for the operator's box: one RTX 5090, 32 GB.
const rig5090: HardwareProfile = {
  gpus: [{ name: 'NVIDIA GeForce RTX 5090', vramBytes: 32 * GB }],
  totalVramBytes: 32 * GB,
  systemRamBytes: 128 * GB,
  cores: 32,
  backend: 'cuda',
};

const qwenCoder32b: ModelSpec = { params: 32, quant: 'Q4_K_M', arch: 'qwen', contextMax: 131072 };
const big200b: ModelSpec = { params: 200, quant: 'Q4_K_M', arch: 'moe', contextMax: 131072 };

async function main() {
  await step('qwen-coder 32B Q4_K_M fits the 5090 (GOOD/PERFECT, gpu)', () => {
    const r = scoreFit(qwenCoder32b, rig5090);
    assert(r.mode === 'gpu', `expected gpu mode, got ${r.mode}`);
    assert(r.verdict === 'GOOD' || r.verdict === 'PERFECT', `expected GOOD/PERFECT, got ${r.verdict}`);
    assert(r.maxContextThatFits >= 8192, `expected a plausible ctx, got ${r.maxContextThatFits}`);
    assert(r.estVramBytes < rig5090.totalVramBytes, 'estVram must be under board VRAM when it fits');
    assert(r.score >= 40 && r.score <= 100, `score out of range: ${r.score}`);
    assert(r.throughputTps > 0, 'throughput must be positive');
  });

  await step('200B model does NOT fit one 5090 (NO / cpu-offload)', () => {
    const r = scoreFit(big200b, rig5090);
    assert(r.verdict === 'NO', `expected NO, got ${r.verdict}`);
    assert(r.mode === 'cpu-offload', `expected cpu-offload, got ${r.mode}`);
    assert(r.estVramBytes > rig5090.totalVramBytes, 'a 200B Q4 model must exceed 32 GB');
  });

  await step('scoreFit is deterministic (same args → same result)', () => {
    const a = scoreFit(qwenCoder32b, rig5090, 16384);
    const b = scoreFit(qwenCoder32b, rig5090, 16384);
    assertEq(JSON.stringify(a), JSON.stringify(b), 'two identical calls must match exactly');
  });

  await step('200B model fits on the simulated 8×5090 rig (gpu, not NO)', () => {
    const r = scoreFit(big200b, simulatedProfile('gpu8'));
    assert(r.mode === 'gpu', `expected gpu on 8×5090, got ${r.mode}`);
    assert(r.verdict !== 'NO', `expected a fitting verdict on 256 GB VRAM, got ${r.verdict}`);
  });

  await step('quant bpw table is sane (Q4_K_M ≈ 4.5, Q8_0 ≈ 8.5, F16 = 16)', () => {
    assertEq(QUANT_BPW.Q4_K_M, 4.5, 'Q4_K_M bpw');
    assertEq(QUANT_BPW.Q8_0, 8.5, 'Q8_0 bpw');
    assertEq(QUANT_BPW.F16, 16, 'F16 bpw');
  });

  await step('estimateVram grows with context (KV-cache term)', () => {
    const small = estimateVram(qwenCoder32b, 4096);
    const large = estimateVram(qwenCoder32b, 65536);
    assert(large > small, 'more context must cost more VRAM');
  });

  await step('higher quant of same model costs more VRAM than lower', () => {
    const q4 = scoreFit({ params: 14, quant: 'Q4_K_M', arch: 'qwen' }, rig5090);
    const q8 = scoreFit({ params: 14, quant: 'Q8_0', arch: 'qwen' }, rig5090);
    assert(q8.estVramBytes > q4.estVramBytes, 'Q8 must need more VRAM than Q4 for the same model');
  });

  summary('cookbook-fit');
}

main();
