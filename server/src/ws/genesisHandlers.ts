// ── Genesis WS handlers (ARCHON_OPS_PLAN.md M2) ──
//
// Two operator-driven messages for a from-nothing genesis workflow:
//   genesis_seed_update  → store the seed (config + meta mirror), echo readiness.
//   genesis_scaffold     → create the project folder + seed docs, optionally a
//                          GitHub repo, bind the cwd, seed a plan, then broadcast.
//
// No orchestrator, no second model: the seed is operator-maintained and the docs
// are generated deterministically (server/src/genesis/scaffold.ts). Every mutation
// broadcasts so reconnects/other windows stay in sync. The scaffold is irreversible
// folder creation — the client confirms before sending it.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WebSocket } from 'ws';
import type {
  GenesisAssistField,
  GenesisAssistIntent,
  GenesisAssistRequestMessage,
  GenesisCreativeArmMessage,
  GenesisGithubParams,
  GenesisNameOption,
  GenesisScaffoldMessage,
  GenesisSeed,
  GenesisSeedUpdateMessage,
} from '@archon/shared';
import { emptyGenesisSeed } from '@archon/shared';
import { workflows, workflowCwds } from '../server/state.js';
import { send, broadcastWorkflow } from '../server/broadcast.js';
import { updateMeta } from '../workflowMeta.js';
import { persistInitialMeta } from './turnEngine.js';
import { initWorkflowStore, flushWorkflowBuffer, forgetWorkflowBuffer } from '../workflowStore.js';
import { rememberCwd } from '../crashRecovery.js';
import { createPlan, recordAttachment } from '../planStore.js';
import { resolveProviderAccount } from '../providerAccounts.js';
import { readSettings } from '../settings.js';
import { assessGenesisReadiness } from '../genesis/stages.js';
import { nextFieldPrompt } from '../genesis/prompts.js';
import {
  buildSeedDocs,
  expandHome,
  uniqueProjectDir,
  writeScaffold,
} from '../genesis/scaffold.js';
import { ALTERNATIVE_DIR, assessCodebase, gatherProjectContext } from '../genesis/creative.js';

const execFileAsync = promisify(execFile);

const GENESIS_ASSIST_FIELDS = new Set<GenesisAssistField>([
  'title',
  'spark',
  'concept',
  'theCase',
  'buildDirection',
  'stack',
  'scope',
]);
const GENESIS_ASSIST_INTENTS = new Set<GenesisAssistIntent>([
  'improve',
  'fresh',
  'expand',
  'name',
  'stack',
  'scope',
]);

function fail(ws: WebSocket, message: string): void {
  send(ws, { type: 'error', message });
}

function fieldLabel(field: GenesisAssistField): string {
  switch (field) {
    case 'title': return 'Working name';
    case 'spark': return 'The Spark';
    case 'concept': return 'Concept';
    case 'theCase': return 'The Case';
    case 'buildDirection': return 'Build-direction';
    case 'stack': return 'Stack';
    case 'scope': return 'Scope';
  }
}

function fieldPurpose(field: GenesisAssistField): string {
  switch (field) {
    case 'title':
      return 'Suggest a short project name drawn from the full seed, including downstream Concept, Case, Build-direction, Stack, and Scope fields. Prefer clear, memorable, filesystem-friendly names. Do not invent a product category the seed does not support.';
    case 'spark':
      return 'Improve or expand the raw idea while preserving uncertainty, rough edges, and the operator\'s own framing.';
    case 'concept':
      return 'State what this thing is in one or two plain sentences. Name the core mechanism, workflow, or experience. Do not turn it into a marketing pitch.';
    case 'theCase':
      return 'Explain why building this specific concept is worth it, who it is for, what friction it removes, and where scope should stop. For personal tools, center the operator\'s own workflow payoff.';
    case 'buildDirection':
      return 'Propose practical build direction: architecture, first slice, boundaries, and open technical decisions. Name technologies only when justified by the seed.';
    case 'stack':
      return 'Suggest a concise early stack direction with tradeoffs. Include concrete technologies only where they fit the concept and operator constraints; call out uncertainty.';
    case 'scope':
      return 'Suggest a tight v0 scope boundary: what is in, what is out, and the smallest useful end-to-end slice.';
  }
}

function intentInstruction(intent: GenesisAssistIntent, field: GenesisAssistField): string {
  if (intent === 'fresh') return 'Write the field from scratch using the rest of the seed as source material. Ignore the current field value.';
  if (intent === 'expand') return 'Expand and deepen the current field while preserving its direction. Add concrete useful detail without changing the project.';
  if (intent === 'name' || field === 'title') return 'Generate a shortlist of strong working-name candidates from all available filled fields, including fields after Working name. Return multiple distinct options with rationale.';
  if (intent === 'stack' || field === 'stack') return 'Recommend an early stack direction with concise reasoning.';
  if (intent === 'scope' || field === 'scope') return 'Recommend a practical v0 scope boundary.';
  return 'Improve the current field while preserving the operator\'s intent and factual meaning.';
}

function seedValue(seed: GenesisSeed, field: GenesisAssistField): string {
  switch (field) {
    case 'title': return seed.title;
    case 'spark': return seed.spark;
    case 'concept': return seed.concept;
    case 'theCase': return seed.theCase;
    case 'buildDirection': return seed.buildDirection;
    case 'stack': return seed.stack ?? '';
    case 'scope': return seed.scope ?? '';
  }
}

export function buildGenesisAssistPrompt(seed: GenesisSeed, field: GenesisAssistField, intent: GenesisAssistIntent, instruction?: string): string {
  const current = seedValue(seed, field).trim();
  const nameMode = field === 'title' || intent === 'name';
  const shortlisted = seed.nameWorkbench?.shortlisted ?? [];
  const rejected = seed.nameWorkbench?.rejected ?? [];
  return [
    'You are Arco Genesis field assistance. Propose text for exactly one project-ideation field.',
    '',
    'Hard rules:',
    nameMode
      ? '- Output only a compact JSON object: {"options":[{"name":"...","rationale":"..."}],"rationale":"..."}'
      : '- Output only a compact JSON object with string keys: {"suggestion":"...","rationale":"..."}',
    nameMode
      ? '- Return 6-10 distinct name options. Each name must be directly usable as the Working name.'
      : '- The suggestion must be directly usable as the field value.',
    '- Do not include markdown fences, preambles, headings outside the JSON, or multiple alternatives unless the field itself needs bullets.',
    '- Treat empty fields as unknown. Never invent audiences, markets, users, deadlines, technologies, or constraints not grounded in the seed.',
    '- Keep downstream fields faithful to upstream fields: Concept from Spark; The Case argues for Concept; Build-direction/Stack/Scope serve Concept and The Case.',
    ...(nameMode ? [
      '- Do not repeat rejected names or near-identical variants.',
      '- Prefer names that are pronounceable, searchable, and filesystem-friendly.',
      '- Include a mix of literal, evocative, and technical options.',
    ] : []),
    '',
    `Target field: ${fieldLabel(field)}`,
    `Field purpose: ${fieldPurpose(field)}`,
    `Mode: ${intentInstruction(intent, field)}`,
    ...(instruction?.trim() ? [`Operator refinement: ${instruction.trim()}`] : []),
    '',
    'Current seed:',
    `Working name: ${seed.title || '(empty)'}`,
    '',
    'The Spark:',
    seed.spark || '(empty)',
    '',
    'Concept:',
    seed.concept || '(empty)',
    '',
    'The Case:',
    seed.theCase || '(empty)',
    '',
    'Build-direction:',
    seed.buildDirection || '(empty)',
    '',
    `Stack: ${seed.stack || '(empty)'}`,
    `Scope: ${seed.scope || '(empty)'}`,
    ...(nameMode ? [
      '',
      `Shortlisted names: ${shortlisted.length ? shortlisted.join(', ') : '(none)'}`,
      `Rejected names: ${rejected.length ? rejected.join(', ') : '(none)'}`,
    ] : []),
    '',
    `Current ${fieldLabel(field)} value:`,
    current || '(empty)',
    '',
    nameMode ? 'Return the JSON object with options now.' : 'Return the JSON object now.',
  ].join('\n');
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return m ? m[1]!.trim() : trimmed;
}

function normalizeNameOption(input: unknown): GenesisNameOption | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as { name?: unknown; suggestion?: unknown; rationale?: unknown };
  const rawName = typeof obj.name === 'string' ? obj.name : typeof obj.suggestion === 'string' ? obj.suggestion : '';
  const name = rawName.trim();
  if (!name) return null;
  return {
    name,
    ...(typeof obj.rationale === 'string' && obj.rationale.trim() ? { rationale: obj.rationale.trim() } : {}),
  };
}

function extractJsonObject(text: string): { suggestion: string; rationale?: string; options?: GenesisNameOption[] } | null {
  const raw = stripFence(text);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
  try {
    const parsed = JSON.parse(candidate) as { suggestion?: unknown; rationale?: unknown; options?: unknown; names?: unknown };
    const optionSource = Array.isArray(parsed.options) ? parsed.options : Array.isArray(parsed.names) ? parsed.names : [];
    const options = optionSource.map(normalizeNameOption).filter((x): x is GenesisNameOption => !!x);
    if (options.length > 0) {
      return {
        suggestion: options[0]!.name,
        options,
        ...(typeof parsed.rationale === 'string' && parsed.rationale.trim() ? { rationale: parsed.rationale.trim() } : {}),
      };
    }
    if (typeof parsed.suggestion === 'string' && parsed.suggestion.trim()) {
      return {
        suggestion: parsed.suggestion.trim(),
        ...(typeof parsed.rationale === 'string' && parsed.rationale.trim() ? { rationale: parsed.rationale.trim() } : {}),
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function parseAssistOutput(text: string): { suggestion: string; rationale?: string; options?: GenesisNameOption[] } {
  const parsed = extractJsonObject(text);
  if (parsed) return parsed;
  return { suggestion: stripFence(text).trim() };
}

function effectiveScaffoldSeed(seed: GenesisSeed, github?: GenesisGithubParams): GenesisSeed {
  return github ? { ...seed, github } : seed;
}

// Broadcast the seed + the engine's advisory readiness + the next-field prompt.
function broadcastSeed(workflowId: string, seed: GenesisSeed): void {
  broadcastWorkflow(workflowId, {
    type: 'genesis_seed_updated',
    workflowId,
    seed,
    readiness: assessGenesisReadiness(seed),
    nextPrompt: nextFieldPrompt(seed),
  });
}

export async function handleGenesisSeedUpdate(ws: WebSocket, msg: GenesisSeedUpdateMessage): Promise<void> {
  const wf = workflows.get(msg.workflowId);
  if (!wf) {
    fail(ws, 'Cannot update a genesis seed for an unknown workflow.');
    return;
  }
  if (!msg.seed || typeof msg.seed !== 'object') {
    fail(ws, 'genesis_seed_update requires a seed object.');
    return;
  }
  // The config is the durable home (rides the client-persisted config on
  // rehydrate). Store it there first.
  wf.config.genesisSeed = msg.seed;
  // If a cwd already exists (the seed is being edited after scaffold, e.g. M3
  // Creative-mode), mirror it into meta.json too.
  const cwd = workflowCwds.get(msg.workflowId) ?? wf.config.workingDirectory ?? '';
  if (cwd) {
    const seed = msg.seed;
    await updateMeta(cwd, msg.workflowId, (meta) => {
      meta.genesisSeed = seed;
    }).catch((err) => {
      console.error('[archon] genesis seed meta write failed:', err);
    });
  }
  broadcastSeed(msg.workflowId, msg.seed);
}

// Separator-agnostic test for the hidden from-nothing scratch ideation dir. A
// Creative-mode workflow must NOT be one of these (it runs in a real project cwd).
function isScratchCwd(cwd: string): boolean {
  return /[\\/]\.archon[\\/]genesis[\\/]/.test(cwd);
}

// Mirror the (possibly creative) seed into meta.json when a cwd exists. Best-effort.
async function mirrorSeedToMeta(cwd: string, workflowId: string, seed: GenesisSeed): Promise<void> {
  if (!cwd) return;
  await updateMeta(cwd, workflowId, (meta) => {
    meta.genesisSeed = seed;
  }).catch((err) => {
    console.error('[archon] genesis creative seed meta write failed:', err);
  });
}

// M3 — arm (or disarm) Creative mode on an EXISTING real-cwd workflow. Arming reads
// a project-context snapshot + a codebase assessment off disk (no model, no writes)
// and seeds a `creative` GenesisSeed, preserving any prior creative-seed fields so
// re-arming refreshes context without discarding the operator's idea. Disarming
// clears `creative` (keeping the fields). The turn engine injects the staged block
// while `seed.creative` is set; the scaffold lands in a sibling ALTERNATIVE/ dir.
export async function handleGenesisCreativeArm(ws: WebSocket, msg: GenesisCreativeArmMessage): Promise<void> {
  const wf = workflows.get(msg.workflowId);
  if (!wf) {
    fail(ws, 'Cannot arm Creative mode for an unknown workflow.');
    return;
  }
  const cwd = workflowCwds.get(msg.workflowId) ?? wf.config.workingDirectory ?? '';
  if (!cwd) {
    fail(ws, 'Creative mode needs a working directory — this workflow has none yet.');
    return;
  }
  if (isScratchCwd(cwd)) {
    fail(ws, 'This is a from-nothing genesis already; Creative mode is for exploring an alternative inside an existing project.');
    return;
  }

  const prev = wf.config.genesisSeed;

  if (msg.disarm) {
    // Keep the operator's idea fields; just drop the creative flag + stale context
    // so the turn engine stops injecting the staged block.
    const seed: GenesisSeed = prev
      ? { ...prev, creative: false, projectContext: undefined }
      : emptyGenesisSeed();
    wf.config.genesisSeed = seed;
    await mirrorSeedToMeta(cwd, msg.workflowId, seed);
    broadcastWorkflow(msg.workflowId, {
      type: 'genesis_creative_armed',
      workflowId: msg.workflowId,
      armed: false,
      seed,
      readiness: assessGenesisReadiness(seed),
      nextPrompt: nextFieldPrompt(seed),
    });
    return;
  }

  let context;
  let codebase;
  try {
    context = await gatherProjectContext(cwd);
    codebase = await assessCodebase(cwd);
  } catch (err) {
    fail(ws, `Creative mode could not read the project: ${(err as Error).message}`);
    return;
  }

  // Preserve a prior creative seed's idea fields; otherwise start empty. Always
  // refresh creative + projectContext, and supply a working title only when absent.
  const base = prev?.creative ? prev : emptyGenesisSeed();
  const seed: GenesisSeed = {
    ...base,
    creative: true,
    projectContext: context.block,
    title: base.title && base.title.trim() ? base.title : context.suggestedTitle,
  };
  wf.config.genesisSeed = seed;
  await mirrorSeedToMeta(cwd, msg.workflowId, seed);

  broadcastWorkflow(msg.workflowId, {
    type: 'genesis_creative_armed',
    workflowId: msg.workflowId,
    armed: true,
    seed,
    readiness: assessGenesisReadiness(seed),
    nextPrompt: nextFieldPrompt(seed),
    codebase,
  });
}

export async function handleGenesisAssistRequest(ws: WebSocket, msg: GenesisAssistRequestMessage): Promise<void> {
  const wf = workflows.get(msg.workflowId);
  if (!wf) {
    fail(ws, 'Cannot run Genesis assist for an unknown workflow.');
    return;
  }
  if (wf.busy) {
    fail(ws, 'Cannot run Genesis assist while a primary turn is running.');
    return;
  }
  if (!GENESIS_ASSIST_FIELDS.has(msg.field)) {
    fail(ws, 'Genesis assist requested an unknown field.');
    return;
  }
  if (!GENESIS_ASSIST_INTENTS.has(msg.intent)) {
    fail(ws, 'Genesis assist requested an unknown intent.');
    return;
  }
  if (!msg.seed || typeof msg.seed !== 'object') {
    fail(ws, 'Genesis assist requires a seed object.');
    return;
  }

  const cwd = workflowCwds.get(msg.workflowId) ?? wf.config.workingDirectory ?? process.cwd();
  const requestId = msg.requestId || `gen-${Date.now().toString(36)}`;
  broadcastWorkflow(msg.workflowId, {
    type: 'genesis_assist_started',
    workflowId: msg.workflowId,
    requestId,
    field: msg.field,
    intent: msg.intent,
  });

  const account = wf.primary.provider === 'codex'
    ? await resolveProviderAccount('codex', wf.config.providerAccountRef, cwd).catch(() => null)
    : null;
  const cascade = await readSettings(cwd).catch(() => null);
  const claudeTransport: 'cli' | 'native' =
    wf.config.claudeTransport === 'native' || wf.config.claudeTransport === 'cli'
      ? wf.config.claudeTransport
      : cascade?.claude?.transport === 'native' ? 'native' : 'cli';
  const codexTransport: 'exec' | 'appserver' =
    wf.config.codexTransport === 'appserver' || wf.config.codexTransport === 'exec'
      ? wf.config.codexTransport
      : cascade?.codex?.transport === 'appserver' ? 'appserver' : 'exec';
  const task = buildGenesisAssistPrompt(msg.seed, msg.field, msg.intent, msg.instruction);
  let collected = '';
  wf.manager.spawn(
    {
      id: requestId,
      task,
      provider: wf.primary.provider,
      model: wf.primary.model,
      effort: wf.primary.effort,
      tools: [],
    },
    (ev) => {
      if (ev.type === 'worker_text') collected += ev.text;
      else if (ev.type === 'worker_system_notice') {
        send(ws, { type: 'system_notice', workflowId: msg.workflowId, content: ev.notice });
      }
    },
    {
      cwd,
      workflowId: msg.workflowId,
      sandbox: 'read-only',
      skipPermissions: wf.primary.provider === 'ollama',
      outputStyle: 'normal',
      ...(wf.primary.provider === 'claude' ? { claudeTransport } : {}),
      ...(wf.primary.provider === 'codex' ? { codexTransport, codexContextPolicy: wf.config.codexContextPolicy } : {}),
      ...(wf.primary.provider === 'codex' && account
        ? { providerAccountRef: account.profile.id, codexHome: account.codexHome }
        : {}),
    },
  ).then((r) => {
    if (r.error) {
      broadcastWorkflow(msg.workflowId, {
        type: 'genesis_assist_proposed',
        workflowId: msg.workflowId,
        requestId,
        field: msg.field,
        intent: msg.intent,
        suggestion: '',
        error: r.error,
      });
      return;
    }
    const parsed = parseAssistOutput(collected || r.text || '');
    broadcastWorkflow(msg.workflowId, {
      type: 'genesis_assist_proposed',
      workflowId: msg.workflowId,
      requestId,
      field: msg.field,
      intent: msg.intent,
      suggestion: parsed.suggestion,
      ...(parsed.rationale ? { rationale: parsed.rationale } : {}),
      ...(parsed.options ? { options: parsed.options } : {}),
    });
  }).catch((err) => {
    broadcastWorkflow(msg.workflowId, {
      type: 'genesis_assist_proposed',
      workflowId: msg.workflowId,
      requestId,
      field: msg.field,
      intent: msg.intent,
      suggestion: '',
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

// Best-effort local git init + initial commit so the scaffolded folder is a repo.
// Non-fatal — a git failure (e.g. git not installed) must not fail the scaffold.
async function gitInitCommit(dir: string): Promise<void> {
  await execFileAsync('git', ['init', '-q'], { cwd: dir });
  await execFileAsync('git', ['add', '-A'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'Initial scaffold (Arco Genesis)'], {
    cwd: dir,
    // git needs identity; rely on the operator's global config. If unset the
    // commit throws and the caller logs it — repo still inits.
  });
}

// Best-effort GitHub repo create + push via `gh` (the operator's existing auth
// path). Returns the repo URL on success; throws on failure (caller treats it as
// non-fatal `repoError`).
async function ghCreateRepo(dir: string, name: string, visibility: 'private' | 'public'): Promise<string> {
  const { stdout } = await execFileAsync(
    'gh',
    ['repo', 'create', name, `--${visibility}`, '--source', dir, '--remote', 'origin', '--push'],
    { cwd: dir },
  );
  // `gh repo create` prints the repo URL on stdout.
  const url = stdout.trim().split(/\s+/).find((t) => /^https?:\/\//.test(t));
  return url ?? stdout.trim();
}

// Build the seeded plan body from the seed — the SPEC sections + a first-steps
// checklist. Deterministic; no model.
function planBodyFor(seed: GenesisSeed): string {
  const orEmpty = (v: string | undefined, f: string) => (v && v.trim() ? v.trim() : f);
  return [
    `# ${orEmpty(seed.title, 'Untitled Project')} — plan`,
    '',
    'Seeded by Arco Genesis. Refine into concrete tasks.',
    '',
    '## Concept',
    '',
    orEmpty(seed.concept, '_See SPEC.md._'),
    '',
    '## Build direction',
    '',
    orEmpty(seed.buildDirection, '_See SPEC.md._'),
    '',
    '## First steps',
    '',
    '- [ ] Confirm the stack and scope boundaries',
    '- [ ] Stand up the minimal runnable skeleton',
    '- [ ] Build the smallest end-to-end slice of the core concept',
    '',
  ].join('\n');
}

// Move the on-disk workflow store dir (.archon/workflows/<wfid>, holding
// events.jsonl + artifacts) from the scratch ideation cwd to the real project
// cwd. Prefer an atomic rename; fall back to recursive copy + remove across
// filesystems (EXDEV). The caller flushes the scratch buffer first and re-inits
// the store at the destination afterward (which recovers the seq from the moved
// events.jsonl), so transcript continuity + monotonic seq survive the move.
async function moveWorkflowStoreDir(scratchCwd: string, realCwd: string, wfid: string): Promise<void> {
  const fromDir = path.join(scratchCwd, '.archon', 'workflows', wfid);
  const toDir = path.join(realCwd, '.archon', 'workflows', wfid);
  const fromExists = await fs.lstat(fromDir).then(() => true).catch(() => false);
  if (!fromExists) return; // nothing ran yet — no store to carry over
  await fs.mkdir(path.dirname(toDir), { recursive: true });
  try {
    await fs.rename(fromDir, toDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await fs.cp(fromDir, toDir, { recursive: true });
    await fs.rm(fromDir, { recursive: true, force: true });
  }
}

// M3 Creative-mode scaffold: write the seed docs into a sibling
// `<cwd>/ALTERNATIVE/<slug>/` dir and seed a SEPARATE plan, leaving the existing
// project — its files, its active plan, its cwd — entirely untouched. No store move,
// no cwd rebind, no git init (it lives inside the existing repo), no `gh`. The
// scaffold writer's in-tree/no-overwrite guards make the write safe; confining it to
// ALTERNATIVE/ is the operator's stated guardrail.
async function handleCreativeScaffold(
  ws: WebSocket,
  msg: GenesisScaffoldMessage,
  wf: NonNullable<ReturnType<typeof workflows.get>>,
  seed: GenesisSeed,
): Promise<void> {
  const cwd = workflowCwds.get(msg.workflowId) ?? wf.config.workingDirectory ?? '';
  if (!cwd || isScratchCwd(cwd)) {
    fail(ws, 'Creative-mode scaffold needs an existing project working directory.');
    return;
  }

  const altRoot = path.join(cwd, ALTERNATIVE_DIR);
  let targetDir: string;
  try {
    targetDir = await uniqueProjectDir(altRoot, seed.title);
    await fs.mkdir(targetDir, { recursive: true });
  } catch (err) {
    fail(ws, `Creative-mode scaffold could not create the alternative folder: ${(err as Error).message}`);
    return;
  }

  let written: string[];
  try {
    const result = await writeScaffold(targetDir, buildSeedDocs(seed));
    // Report paths relative to the existing cwd (e.g. ALTERNATIVE/<slug>/README.md)
    // so the operator sees where the output landed inside their project.
    const rel = path.relative(cwd, targetDir);
    written = result.written.map((p) => path.join(rel, p).split(path.sep).join('/'));
  } catch (err) {
    fail(ws, `Creative-mode scaffold failed while writing seed docs: ${(err as Error).message}`);
    return;
  }

  // Seed a SEPARATE plan beside the existing one (fresh id — never overwrites). It is
  // attached so it shows in the Plans tab, but we do NOT set wf.planId: the existing
  // active plan stays the workflow's plan; the alternative is discoverable, not
  // imposed. Best-effort — a plan failure must not undo the scaffold.
  let planId: string | undefined;
  try {
    const plan = await createPlan(cwd, {
      title: `${seed.title.trim()} — alternative direction`,
      body: planBodyFor(seed),
    });
    planId = plan.id;
    await recordAttachment(cwd, plan.id, msg.workflowId, wf.config.name).catch(() => { /* best-effort */ });
  } catch (err) {
    console.error('[archon] genesis creative plan seed failed (non-fatal):', err);
  }

  broadcastWorkflow(msg.workflowId, {
    type: 'genesis_scaffolded',
    workflowId: msg.workflowId,
    cwd,
    written,
    creative: true,
    suggestSpawn: true,
    ...(planId ? { planId } : {}),
  });
}

export async function handleGenesisScaffold(ws: WebSocket, msg: GenesisScaffoldMessage): Promise<void> {
  const wf = workflows.get(msg.workflowId);
  if (!wf) {
    fail(ws, 'Cannot scaffold an unknown workflow.');
    return;
  }
  const seed = wf.config.genesisSeed;
  if (!seed || !seed.title.trim()) {
    fail(ws, 'Cannot scaffold without a genesis seed that has at least a working name.');
    return;
  }
  if (wf.busy) {
    fail(ws, 'Cannot scaffold while a turn is running — wait for it to finish, then try again.');
    return;
  }

  // M3 Creative mode: scaffold a sibling alternative inside the existing project
  // instead of creating + rebinding a new project dir. Branch before the scratch-dir
  // guard (a creative workflow lives in a real cwd, which that guard would reject).
  if (seed.creative) {
    await handleCreativeScaffold(ws, msg, wf, seed);
    return;
  }

  // The from-nothing genesis workflow currently lives in its scratch ideation
  // dir (assigned at creation). Anything else means it was already scaffolded or
  // created with a real cwd.
  const scratchCwd = workflowCwds.get(msg.workflowId) ?? wf.config.workingDirectory ?? '';
  if (!scratchCwd || !/[\\/]\.archon[\\/]genesis[\\/]/.test(scratchCwd)) {
    fail(ws, 'This workflow is not a from-nothing genesis (no scratch ideation dir to rebind).');
    return;
  }

  const root = expandHome((msg.root && msg.root.trim()) || '~/Projects');
  let targetDir: string;
  try {
    targetDir = await uniqueProjectDir(root, seed.title);
    await fs.mkdir(targetDir, { recursive: true });
  } catch (err) {
    fail(ws, `Genesis scaffold could not create the project folder: ${(err as Error).message}`);
    return;
  }

  // Carry the ideation transcript over: flush + move the scratch store dir, then
  // re-point the cwd and re-init the store at the destination (recovers seq).
  try {
    await flushWorkflowBuffer(scratchCwd, msg.workflowId);
    await moveWorkflowStoreDir(scratchCwd, targetDir, msg.workflowId);
  } catch (err) {
    fail(ws, `Genesis scaffold could not move the workflow store: ${(err as Error).message}`);
    return;
  }
  forgetWorkflowBuffer(scratchCwd, msg.workflowId);
  wf.config.workingDirectory = targetDir;
  workflowCwds.set(msg.workflowId, targetDir);
  rememberCwd(targetDir).catch(() => { /* best-effort */ });
  try {
    await initWorkflowStore(targetDir, msg.workflowId);
  } catch (err) {
    console.error('[archon] genesis workflowStore init failed:', err);
  }

  // Write the seed docs (hardened writer — Appendix D). targetDir is freshly
  // created; the moved .archon/ lives beside the docs without collision.
  const gh = msg.github ?? seed.github;
  const scaffoldSeed = effectiveScaffoldSeed(seed, gh);
  wf.config.genesisSeed = scaffoldSeed;
  const scaffoldName = scaffoldSeed.title.trim();
  if (scaffoldName) {
    wf.config.name = scaffoldName;
  }

  let written: string[];
  try {
    const result = await writeScaffold(targetDir, buildSeedDocs(scaffoldSeed));
    written = result.written;
  } catch (err) {
    fail(ws, `Genesis scaffold failed while writing seed docs: ${(err as Error).message}`);
    return;
  }

  // Local git init + initial commit (best-effort, non-fatal).
  await gitInitCommit(targetDir).catch((err) => {
    console.error('[archon] genesis git init/commit failed (non-fatal):', err);
  });

  // Optional GitHub repo (best-effort, non-fatal). `msg.github` overrides the seed.
  let repoUrl: string | undefined;
  let repoError: string | undefined;
  if (gh?.create) {
    const repoName = gh.repoName?.trim() || targetDir.split(path.sep).pop() || seed.title;
    try {
      repoUrl = await ghCreateRepo(targetDir, repoName, gh.visibility);
    } catch (err) {
      repoError = (err as Error).message;
      console.error('[archon] genesis gh repo create failed (non-fatal):', err);
    }
  }

  // Write the initial meta.json (the move carried the scratch meta if any, but
  // its cwd field is stale; persistInitialMeta no-ops when meta already exists, so
  // we always rewrite cwd + seed + plan below). Seed + attach a plan.
  await persistInitialMeta(targetDir, msg.workflowId, wf.config, wf.primary).catch((err) => {
    console.error('[archon] genesis persistInitialMeta failed:', err);
  });
  let planId: string | undefined;
  try {
    const plan = await createPlan(targetDir, { title: `${scaffoldSeed.title.trim()} — plan`, body: planBodyFor(scaffoldSeed) });
    planId = plan.id;
    await recordAttachment(targetDir, plan.id, msg.workflowId, wf.config.name).catch(() => { /* best-effort */ });
  } catch (err) {
    console.error('[archon] genesis plan seed failed (non-fatal):', err);
  }

  // Rewrite meta.json: stamp the real cwd, the seed mirror, and the plan id.
  await updateMeta(targetDir, msg.workflowId, (meta) => {
    meta.cwd = targetDir;
    if (scaffoldName) meta.name = scaffoldName;
    meta.genesisSeed = scaffoldSeed;
    if (planId) meta.planId = planId;
  }).catch((err) => {
    console.error('[archon] genesis final meta write failed:', err);
  });
  if (planId) wf.planId = planId;

  // Remove the now-empty scratch ideation dir (best-effort).
  fs.rm(scratchCwd, { recursive: true, force: true }).catch(() => { /* best-effort */ });

  // Broadcast: cwd bound first (so the client repoints its persisted config +
  // refreshes cwd-scoped panels), then the scaffold result.
  broadcastWorkflow(msg.workflowId, { type: 'workflow_cwd_bound', workflowId: msg.workflowId, cwd: targetDir });
  if (scaffoldName) {
    broadcastWorkflow(msg.workflowId, { type: 'workflow_renamed', workflowId: msg.workflowId, name: scaffoldName });
  }
  broadcastWorkflow(msg.workflowId, {
    type: 'genesis_scaffolded',
    workflowId: msg.workflowId,
    cwd: targetDir,
    written,
    ...(planId ? { planId } : {}),
    ...(repoUrl ? { repoUrl } : {}),
    ...(repoError ? { repoError } : {}),
  });
}
