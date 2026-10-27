// -- Genesis stage ladder + lightweight readiness (docs/ARCHITECTURE.md) --
//
// The reusable, model-free core of Genesis: a compressed 4-rung ladder
// (Spark → Concept → Case → Build-direction) with one primary narrative field per
// rung, plus *non-blocking* readiness checks. Readiness is advisory — Genesis never
// gates a turn on it; the operator drives stage transitions. The prompts module
// (./prompts.ts) consumes currentStage()/nextField() to assemble the staged system
// block and the next field prompt.
//
// Adapted from Seedbank's shared/stageReadiness.ts (the 40-char Spark threshold and
// the per-field check pattern carry over); compressed from Seedbank's 8-stage
// lifecycle to 4 rungs since Genesis only spans idea→build-direction, not the full
// shelved/cold-storage/market afterlife.

import type { GenesisField, GenesisReadiness, GenesisSeed, GenesisStage } from '@arco/shared';

// Ladder order, bottom rung first. The index into this array is the canonical
// stage ordering used for "never move behind the derived floor" comparisons.
export const GENESIS_STAGE_ORDER: readonly GenesisStage[] = ['spark', 'concept', 'case', 'build'] as const;

// Human-facing labels for each stage (UI + system-block headers).
export const GENESIS_STAGE_LABELS: Record<GenesisStage, string> = {
  spark: 'Spark',
  concept: 'Concept',
  case: 'The Case',
  build: 'Build-direction',
};

interface StageCheck {
  label: string;       // human-readable, surfaced in readiness.met / .missing
  field: GenesisField; // the field this check is about (drives nextField())
  pass: (seed: GenesisSeed) => boolean;
}

const isFilled = (value: string | undefined): boolean => Boolean(value && value.trim().length > 0);

// Per-stage checks, evaluated in array order. A stage is "satisfied" when every
// check passes. The first stage with an unmet check is the current working stage.
const STAGE_CHECKS: Record<GenesisStage, StageCheck[]> = {
  spark: [
    // Mirror Seedbank's 40-char Spark threshold: enough to anchor a concept on.
    { label: 'The Spark has enough detail', field: 'spark', pass: (s) => s.spark.trim().length >= 40 },
  ],
  concept: [
    { label: 'Concept is filled', field: 'concept', pass: (s) => isFilled(s.concept) },
    // The title is required before the Case stage advances (plan M1); gate it here
    // so it is asked for during the Concept rung rather than sprung at scaffold time.
    { label: 'Working name is set', field: 'title', pass: (s) => isFilled(s.title) },
  ],
  case: [
    { label: 'The Case is filled', field: 'theCase', pass: (s) => isFilled(s.theCase) },
  ],
  build: [
    { label: 'Build-direction is filled', field: 'buildDirection', pass: (s) => isFilled(s.buildDirection) },
  ],
};

function stageSatisfied(seed: GenesisSeed, stage: GenesisStage): boolean {
  return STAGE_CHECKS[stage].every((check) => check.pass(seed));
}

function stageIndex(stage: GenesisStage): number {
  return GENESIS_STAGE_ORDER.indexOf(stage);
}

// Derive the working stage purely from which fields are filled: the lowest rung
// whose checks are not all satisfied. When every rung is satisfied the seed sits at
// the top rung ('build') — ready to scaffold.
function derivedStage(seed: GenesisSeed): GenesisStage {
  for (const stage of GENESIS_STAGE_ORDER) {
    if (!stageSatisfied(seed, stage)) return stage;
  }
  return 'build';
}

// The effective current stage. An explicit seed.stage may hold a *later* stage open
// (e.g. the operator wants build-direction questions even though the Case is thin)
// but never moves the seed *behind* the derived floor — that would let an explicit
// 'spark' suppress questions about fields the operator already filled.
export function currentStage(seed: GenesisSeed): GenesisStage {
  const floor = derivedStage(seed);
  if (!seed.stage) return floor;
  return stageIndex(seed.stage) > stageIndex(floor) ? seed.stage : floor;
}

// The single most important field to prompt for next: the first unmet check across
// all rungs, in ladder order. null when every check passes (nothing left to ask —
// the seed is ready to scaffold).
export function nextField(seed: GenesisSeed): GenesisField | null {
  for (const stage of GENESIS_STAGE_ORDER) {
    for (const check of STAGE_CHECKS[stage]) {
      if (!check.pass(seed)) return check.field;
    }
  }
  return null;
}

// Non-blocking readiness snapshot for the current stage. `nextStage` is the rung
// above the current one (or 'build' at the top — there is nothing higher).
export function assessGenesisReadiness(seed: GenesisSeed): GenesisReadiness {
  const stage = currentStage(seed);
  const checks = STAGE_CHECKS[stage];
  const met: string[] = [];
  const missing: string[] = [];
  for (const check of checks) {
    if (check.pass(seed)) met.push(check.label);
    else missing.push(check.label);
  }
  const idx = stageIndex(stage);
  const isFinalStage = idx === GENESIS_STAGE_ORDER.length - 1;
  const nextStage = isFinalStage ? 'build' : GENESIS_STAGE_ORDER[idx + 1];
  const ready = missing.length === 0;
  return {
    stage,
    ready,
    met,
    missing,
    nextStage,
    isFinalStage,
    // Ready to scaffold only when the seed sits at the top rung AND that rung's
    // checks pass — i.e. all of spark/concept/title/case/build are satisfied.
    readyToScaffold: isFinalStage && ready,
  };
}
