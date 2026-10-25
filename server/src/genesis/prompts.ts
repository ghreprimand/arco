// ── Genesis prompt assembly: anchored field prompts + staged system blocks (M1) ──
//
// Server-side prompt assembly ONLY. This module composes the system block(s) Archon
// already sends (the same labeled-block shape as buildLocalClusterSystemPrompt in
// server/src/server/prompts.ts) plus the next field prompt. It introduces no loop,
// no second model, no orchestrator — M2/M3 fold buildGenesisSystemBlock() into the
// forced first system block (Native) or an appendSystemPrompt fold (CLI/Codex), and
// surface nextFieldPrompt() as a composer suggestion.
//
// Adapted from Seedbank's server/src/ai/prompts.ts: the thinking-partner role, the
// anti-hallucination rule ("treat empty fields as unknown"), the stage-aware
// personality, and the per-field "cite upstream fields as source-of-truth" anchoring
// all carry over. Seedbank's JSON suggestion/landscape/draft-parsing machinery does
// NOT — Genesis rides Archon's normal chat agent, so the output is conversational,
// not a parsed JSON field write.

import type { GenesisField, GenesisSeed, GenesisStage } from '@archon/shared';
import {
  GENESIS_STAGE_LABELS,
  assessGenesisReadiness,
  currentStage,
  nextField,
} from './stages.js';

// Human-facing field labels, shown in the seed-context block and field prompts.
const FIELD_LABELS: Record<GenesisField, string> = {
  title: 'Working name',
  spark: 'The Spark',
  concept: 'Concept',
  theCase: 'The Case',
  buildDirection: 'Build-direction',
};

// The genesis thinking-partner role. Static — keeps the prefix cache warm across
// turns within a workflow. Mirrors Seedbank's THINKING_PARTNER_PROMPT, retargeted
// from "refine an idea field" to "shape a vague idea into a scaffoldable project".
const GENESIS_ROLE = [
  '--- Genesis: project ideation ---',
  'You are a creative thinking partner helping the operator take a vague idea and shape it into a defined, buildable project.',
  'Your job is to draw out what the operator already intuitively knows, one stage at a time, not to generate the project for them.',
  'Work the current stage: ask one or two high-leverage questions grounded in the concrete details the operator has already given, then stop and let them answer.',
  'Do not race ahead to later stages or propose a full plan, scaffold, or file tree until the seed reaches the Build-direction stage and the operator asks to scaffold.',
  'Write in plain, concrete prose. Avoid decorative headings, labeled sections, and generic product-coaching language.',
].join(' ');

// The shared anti-hallucination rule — the load-bearing safety property. Baked into
// every assembled system block regardless of stage.
const ANTI_HALLUCINATION = [
  '--- Grounding rules ---',
  'Treat every empty field below as genuinely unknown. Never invent audiences, markets, users, technologies, scope, deadlines, or constraints the operator has not stated.',
  'Anchor each reply to one or two concrete details already present in the seed; if the seed is too sparse to do that, ask for the single most important missing detail instead of guessing.',
  'Do not imply the project has been built, used, launched, tested, or measured unless the seed explicitly says so. Treat all of it as planned, not done.',
  'Each downstream field must stay faithful to its upstream source-of-truth (Concept is built from the Spark; the Case argues for the Concept; Build-direction serves the Concept and the Case) — do not silently redefine the project when filling a later field.',
].join(' ');

// Stage-aware personality: exploratory early, practical late.
export function genesisStagePersonality(stage: GenesisStage): string {
  switch (stage) {
    case 'spark':
      return [
        'Stage personality: Spark — generative and exploratory.',
        'Help the operator expand and externalize the raw idea. Ask "what if" and "what is the smallest version" questions in future-tense planning language.',
        'Focus on what to build first and which assumption is riskiest. Keep critique light unless the operator explicitly asks for the devil\'s advocate.',
      ].join(' ');
    case 'concept':
      return [
        'Stage personality: Concept — clarifying and sharpening.',
        'Help the operator state plainly what this thing actually is: the core mechanism, workflow, or experience, in one or two sentences a stranger would understand.',
        'Push for a clear working name. Resist turning the concept into a marketing pitch.',
      ].join(' ');
    case 'case':
      return [
        'Stage personality: The Case — critical and honest.',
        'Help the operator argue why building this specific concept is worth the effort: who it is for (which may be just the operator), what makes it worth their time, and where the scope ends.',
        'Name the assumption you are testing when you challenge it. For a personal daily-driver or learning project, center the operator\'s own friction and validation criteria, not market or growth framing.',
      ].join(' ');
    case 'build':
      return [
        'Stage personality: Build-direction — practical and implementation-focused.',
        'Help the operator commit to a stack direction, architecture choices, explicit scope boundaries, and the first concrete build steps.',
        'Name concrete technologies only when the seed supports them; surface open decisions and tradeoffs instead of pretending every choice is settled.',
      ].join(' ');
  }
}

// Per-field anchoring contract: what the next field is for and which upstream field
// is its source-of-truth. Returned only for the field currently being prompted.
function fieldAnchorContract(field: GenesisField): string {
  switch (field) {
    case 'title':
      return [
        `Next, help name the project (${FIELD_LABELS.title}).`,
        'Draw a short, plain working name from the Spark and Concept. Do not invent a brand or scope the operator has not implied.',
      ].join(' ');
    case 'spark':
      return [
        `Next, capture ${FIELD_LABELS.spark} — the raw idea in the operator\'s own words.`,
        'There is no upstream field yet; help the operator get the unfiltered thinking down. Preserve uncertainty and rough edges instead of polishing them away.',
      ].join(' ');
    case 'concept':
      return [
        `Next, shape the ${FIELD_LABELS.concept}: a plain-language explanation of what this thing is.`,
        'Build it from the Spark (fall back to the working name only if the Spark is thin). Name the core mechanism or experience; do not turn it into a pitch.',
      ].join(' ');
    case 'theCase':
      return [
        `Next, build ${FIELD_LABELS.theCase}: why building this specific concept is worth it.`,
        'Treat the Concept as the source-of-truth for what the project is — argue for building that, do not redefine it. Ground the case in the operator\'s stated friction and goals, not invented market demand.',
      ].join(' ');
    case 'buildDirection':
      return [
        `Next, define the ${FIELD_LABELS.buildDirection}: stack direction, scope boundaries, and first concrete steps.`,
        'Ground every choice in the Concept and the Case. Name concrete technologies only where the seed supports them; flag the open decisions rather than settling them silently.',
      ].join(' ');
  }
}

const fieldValue = (value: string | undefined): string => (value && value.trim() ? value.trim() : '(empty)');

// The seed-context block: the operator's current material, labeled, with empties
// marked so the grounding rule can treat them as unknown. Listed source-of-truth
// first (Spark) so the model reads upstream before downstream.
function seedContext(seed: GenesisSeed): string {
  const filled = (['title', 'spark', 'concept', 'theCase', 'buildDirection'] as GenesisField[])
    .filter((f) => fieldValue(seedFieldValue(seed, f)) !== '(empty)')
    .map((f) => FIELD_LABELS[f]);
  return [
    '--- Current seed ---',
    'Use this seed as the source of truth over earlier conversation turns.',
    `Filled so far: ${filled.length > 0 ? filled.join(', ') : 'nothing yet — start from the Spark'}`,
    '',
    `Working name: ${fieldValue(seed.title)}`,
    '',
    'The Spark (raw idea, verbatim):',
    fieldValue(seed.spark),
    '',
    'Concept (what it is):',
    fieldValue(seed.concept),
    '',
    'The Case (why build it):',
    fieldValue(seed.theCase),
    '',
    'Build-direction (stack / scope / first steps):',
    fieldValue(seed.buildDirection),
    ...(seed.stack || seed.scope || seed.github
      ? [
          '',
          `Stack note: ${fieldValue(seed.stack)}`,
          `Scope note: ${fieldValue(seed.scope)}`,
          `GitHub: ${seed.github ? `${seed.github.create ? 'create' : 'no repo'}${seed.github.create ? ` (${seed.github.visibility})` : ''}` : '(undecided)'}`,
        ]
      : []),
  ].join('\n');
}

function seedFieldValue(seed: GenesisSeed, field: GenesisField): string {
  switch (field) {
    case 'title': return seed.title;
    case 'spark': return seed.spark;
    case 'concept': return seed.concept;
    case 'theCase': return seed.theCase;
    case 'buildDirection': return seed.buildDirection;
  }
}

// Assemble the full Genesis system block. Composes the labeled sub-blocks and joins
// with blank lines (same shape as buildLocalClusterSystemPrompt). `opts.base`, when
// given, is the workflow's existing base system prompt and is appended last so the
// genesis framing takes precedence (M2/M3 pass the project base here for Creative
// mode). Returns one string ready to be a forced system block / appendSystemPrompt.
export function buildGenesisSystemBlock(seed: GenesisSeed, opts: { base?: string } = {}): string {
  const stage = currentStage(seed);
  const readiness = assessGenesisReadiness(seed);
  const field = nextField(seed);

  const blocks: string[] = [GENESIS_ROLE, ANTI_HALLUCINATION, genesisStagePersonality(stage)];

  // M3 Creative mode: ground the conversation in the existing project read from
  // disk at arm time. Placed before the seed so the model reads "what exists" before
  // "the alternative the operator is shaping". The grounding rule above already
  // forbids inventing beyond it.
  if (seed.creative && seed.projectContext && seed.projectContext.trim().length > 0) {
    blocks.push(seed.projectContext.trim());
  }

  const readinessLine = readiness.readyToScaffold
    ? 'This seed has reached the Build-direction stage and every readiness check passes. If the operator asks to scaffold, summarize the project and propose the scaffold; otherwise keep refining the build direction.'
    : `Current stage: ${GENESIS_STAGE_LABELS[stage]}. Toward "${GENESIS_STAGE_LABELS[readiness.nextStage]}": ${readiness.missing.length > 0 ? `still missing — ${readiness.missing.join('; ')}` : 'ready to advance when the operator is'}.`;
  blocks.push(`--- Stage status ---\n${readinessLine} Readiness is advisory; the operator decides when to advance.`);

  blocks.push(seedContext(seed));

  if (field) blocks.push(`--- This turn ---\n${fieldAnchorContract(field)}`);

  if (opts.base && opts.base.trim().length > 0) blocks.push(opts.base);

  return blocks.join('\n\n');
}

// The operator-facing next-step prompt — a single concrete question for the field
// the engine wants next. Surfaced as a composer suggestion (M2) rather than
// auto-sent. Returns a ready-to-scaffold message when nothing is left to ask.
export function nextFieldPrompt(seed: GenesisSeed): string {
  const field = nextField(seed);
  if (!field) {
    return 'The seed covers the Spark, Concept, the Case, and a Build-direction. When you are ready, ask to create the scaffold — or keep refining any field.';
  }
  switch (field) {
    case 'spark':
      return 'What is the idea? Put down the raw version in your own words — what sparked it, what it might do, what feels unresolved.';
    case 'concept':
      return 'In one or two plain sentences, what is this thing? Name the core mechanism or experience that makes it what it is.';
    case 'title':
      return 'What should we call it for now? A short working name is enough — we can change it later.';
    case 'theCase':
      return 'Why is this worth building, and who is it for? What friction does it remove, and where does the scope stop?';
    case 'buildDirection':
      return 'How would you build the first version? Rough stack direction, the scope you would cut to, and the first concrete step.';
  }
}
