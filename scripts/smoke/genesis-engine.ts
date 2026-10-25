// Genesis M1 — staged engine assembly smoke.
//
// PURE unit test — NO WebSocket, NO server boot, NO live model. Feeds partial
// GenesisSeeds through the stage ladder + prompt assembly and asserts: the derived
// stage, the next field, the next-field prompt, and that the assembled system block
// carries the stage personality + anti-hallucination + anchoring rules. Mirrors the
// M1 acceptance: "given a partial seed, the engine produces the correct staged
// system block + the right next field prompt, with anchoring/anti-hallucination
// rules present."
//
// Run: npm run smoke:genesis-engine  (no dev server needed)

import {
  GENESIS_STAGE_ORDER,
  assessGenesisReadiness,
  currentStage,
  nextField,
} from '../../server/src/genesis/stages.js';
import { buildGenesisSystemBlock, nextFieldPrompt } from '../../server/src/genesis/prompts.js';
import { emptyGenesisSeed } from '@arco/shared';
import type { GenesisField, GenesisSeed, GenesisStage } from '@arco/shared';

let passes = 0;
let fails = 0;
const failures: string[] = [];

function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
    passes++;
  } else {
    const msg = `${label}${detail ? `: ${detail}` : ''}`;
    console.log(`  FAIL  ${msg}`);
    failures.push(msg);
    fails++;
  }
}

// A spark long enough to clear the 40-char Spark threshold.
const SPARK = 'A terminal dashboard that watches my local dev servers and shows which ports are live.';

function seedAt(stage: GenesisStage): GenesisSeed {
  const base = emptyGenesisSeed();
  // Fill cumulatively up to (but not including) the target stage's primary field.
  if (stage !== 'spark') base.spark = SPARK;
  if (stage === 'case' || stage === 'build') { base.concept = 'A live grid of detected dev servers with one-click open.'; base.title = 'PortWatch'; }
  if (stage === 'build') base.theCase = 'I lose track of which servers I left running; this surfaces them at a glance.';
  return base;
}

// 1) Empty seed → Spark stage, next field is spark.
{
  const seed = emptyGenesisSeed();
  check('empty seed → spark stage', currentStage(seed) === 'spark', currentStage(seed));
  check('empty seed → next field spark', nextField(seed) === 'spark', String(nextField(seed)));
  const r = assessGenesisReadiness(seed);
  check('empty seed not ready', r.ready === false && r.readyToScaffold === false);
  check('empty seed missing the spark detail', r.missing.some((m) => /spark/i.test(m)));
}

// 2) Spark filled (>=40 chars) → Concept stage; short spark stays in Spark stage.
{
  const filled: GenesisSeed = { ...emptyGenesisSeed(), spark: SPARK };
  check('spark filled → concept stage', currentStage(filled) === 'concept', currentStage(filled));
  check('spark filled → next field concept', nextField(filled) === 'concept', String(nextField(filled)));
  const short: GenesisSeed = { ...emptyGenesisSeed(), spark: 'too short' };
  check('short spark stays in spark stage', currentStage(short) === 'spark', currentStage(short));
}

// 3) Concept stage also requires the working name before advancing to the Case.
{
  const noTitle: GenesisSeed = { ...seedAt('case'), title: '' };
  check('concept w/o title → next field title', nextField(noTitle) === 'title', String(nextField(noTitle)));
  check('concept w/o title still at concept stage', currentStage(noTitle) === 'concept', currentStage(noTitle));
}

// 4) Ladder walk: each stage seed derives the expected stage + next field.
{
  const expectedField: Record<GenesisStage, GenesisField> = {
    spark: 'spark', concept: 'concept', case: 'theCase', build: 'buildDirection',
  };
  for (const stage of GENESIS_STAGE_ORDER) {
    const seed = seedAt(stage);
    check(`seedAt(${stage}) → stage ${stage}`, currentStage(seed) === stage, currentStage(seed));
    check(`seedAt(${stage}) → next field ${expectedField[stage]}`, nextField(seed) === expectedField[stage], String(nextField(seed)));
  }
}

// 5) Fully filled seed → build stage, ready to scaffold, no next field.
{
  const full: GenesisSeed = { ...seedAt('build'), buildDirection: 'Node + a tiny TUI; reuse lsof scanning; first step is the port scanner.' };
  check('full seed → build stage', currentStage(full) === 'build');
  const r = assessGenesisReadiness(full);
  check('full seed ready to scaffold', r.readyToScaffold === true && r.isFinalStage === true);
  check('full seed has no next field', nextField(full) === null, String(nextField(full)));
  check('full seed next prompt mentions scaffold', /scaffold/i.test(nextFieldPrompt(full)));
}

// 6) Explicit stage holds a later rung open but never moves behind the derived floor.
{
  const aheadOfFloor: GenesisSeed = { ...emptyGenesisSeed(), spark: SPARK, stage: 'build' };
  check('explicit later stage is honored', currentStage(aheadOfFloor) === 'build', currentStage(aheadOfFloor));
  const behindFloor: GenesisSeed = { ...seedAt('build'), stage: 'spark' };
  check('explicit earlier stage cannot move behind floor', currentStage(behindFloor) === 'build', currentStage(behindFloor));
}

// 7) Assembled system block carries the load-bearing rules + stage-appropriate text.
{
  const sparkSeed = emptyGenesisSeed();
  const block = buildGenesisSystemBlock(sparkSeed);
  check('block has genesis role', /Genesis: project ideation/.test(block));
  check('block has anti-hallucination rule', /Treat every empty field below as genuinely unknown/.test(block));
  check('block has grounding rules header', /Grounding rules/.test(block));
  check('spark-stage block has Spark personality', /Stage personality: Spark/.test(block));
  check('block carries the seed context', /Current seed/.test(block) && /The Spark \(raw idea/.test(block));
  check('block has this-turn anchor for spark', /This turn/.test(block) && /capture The Spark/.test(block));

  // Case-stage block anchors to the Concept as source-of-truth.
  const caseSeed = seedAt('case');
  const caseBlock = buildGenesisSystemBlock(caseSeed);
  check('case-stage block has Case personality', /Stage personality: The Case/.test(caseBlock));
  check('case-stage block anchors to the Concept', /Treat the Concept as the source-of-truth/.test(caseBlock));

  // opts.base is appended (the workflow's base system prompt fold).
  const withBase = buildGenesisSystemBlock(caseSeed, { base: 'PROJECT_BASE_SENTINEL' });
  check('opts.base is folded into the block', withBase.includes('PROJECT_BASE_SENTINEL'));

  // M3 Creative mode: seed.projectContext is folded in only when seed.creative.
  const creativeSeed: GenesisSeed = { ...caseSeed, creative: true, projectContext: 'PROJECT_CONTEXT_SENTINEL' };
  const creativeBlock = buildGenesisSystemBlock(creativeSeed);
  check('creative block folds in projectContext', creativeBlock.includes('PROJECT_CONTEXT_SENTINEL'));
  // A non-creative seed never leaks projectContext (defensive — should not be set).
  const nonCreative: GenesisSeed = { ...caseSeed, creative: false, projectContext: 'LEAKED' };
  check('non-creative block omits projectContext', !buildGenesisSystemBlock(nonCreative).includes('LEAKED'));
}

// 8) next-field prompts are distinct, non-empty questions per field.
{
  const prompts = new Set([
    nextFieldPrompt(emptyGenesisSeed()),                                  // spark
    nextFieldPrompt({ ...emptyGenesisSeed(), spark: SPARK }),             // concept
    nextFieldPrompt({ ...seedAt('case'), title: '' }),                   // title
    nextFieldPrompt(seedAt('case')),                                     // theCase
    nextFieldPrompt(seedAt('build')),                                    // buildDirection
  ]);
  check('five distinct next-field prompts', prompts.size === 5, `got ${prompts.size}`);
  check('all next-field prompts non-empty', [...prompts].every((p) => p.trim().length > 0));
}

console.log(`\n${fails === 0 ? 'OK' : 'FAIL'} — ${passes} passed, ${fails} failed`);
if (fails > 0) {
  console.log('Failures:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
