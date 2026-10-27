// -- Genesis: staged project-ideation seed model (docs/ARCHITECTURE.md) --
//
// Genesis adapts the *process* (not the agent loop) from the Seedbank project: a
// staged, collaborative "vague idea → defined, scaffolded project" flow that rides
// Arco's existing primary-agent interaction via forced/appended system blocks.
// There is NO new DB and NO orchestrator — the `GenesisSeed` is folded into a
// workflow's metadata (M2) and the engine (server/src/genesis/) only assembles the
// system block(s) Arco already sends plus the next field prompt.
//
// The seed compresses Seedbank's 8-field idea into a 4-rung narrative ladder:
//   Spark → Concept → Case → Build-direction
// Each rung has one primary narrative field. `stack`/`scope`/`github` are late
// structured refinements the M2 new-workflow form collects for scaffolding; they
// are not part of the ladder readiness gate.

// The four ordered stages. `spark` is generative/exploratory; `build` is practical
// and implementation-focused (personality slides exploratory→practical, see
// server/src/genesis/prompts.ts).
export type GenesisStage = 'spark' | 'concept' | 'case' | 'build';

// The narrative fields the staged conversation fills, one primary field per stage.
// (Distinct from the scaffold refinements below — these drive stage readiness.)
export type GenesisField = 'title' | 'spark' | 'concept' | 'theCase' | 'buildDirection';

// Field-assist intents adapted from Seedbank's Ask AI modal. Genesis does not
// auto-apply them: the server proposes text, the operator reviews, then the
// normal genesis_seed_update path persists the chosen field value.
export type GenesisAssistIntent = 'improve' | 'fresh' | 'expand' | 'name' | 'stack' | 'scope';

// Fields the Genesis tab can ask AI to help draft. `stack` / `scope` are late
// scaffold refinements rather than ladder stages, but they use the same review
// and apply flow.
export type GenesisAssistField = GenesisField | 'stack' | 'scope';

// Optional GitHub scaffold parameters, collected late (M2). Never acted on by the
// M1 engine — carried so the scaffold writer / GIT primitive can create a repo.
export interface GenesisGithubParams {
  create: boolean;
  visibility: 'private' | 'public';
  // Desired repo name; defaults to the slugified title when absent.
  repoName?: string;
}

export interface GenesisNameOption {
  name: string;
  rationale?: string;
}

export interface GenesisNameWorkbench {
  // Operator-curated names worth keeping in play for future refinement.
  shortlisted: string[];
  // Names explicitly rejected so name-assist prompts avoid loops.
  rejected: string[];
}

// The seed. Every field optional/empty-tolerant: the anti-hallucination rule
// ("treat empty fields as unknown — never invent audiences/tech/scope") depends on
// empties staying empty rather than being pre-filled with placeholders.
export interface GenesisSeed {
  // Working name for the project. Required before the Case stage advances.
  title: string;
  // The Spark — the raw idea / unfiltered notes. Source-of-truth for everything
  // downstream.
  spark: string;
  // The Concept — what this thing is, in plain language. Built from the Spark.
  concept: string;
  // The Case — why building this specific concept is worth the effort.
  theCase: string;
  // Build-direction — stack direction, scope boundaries, first concrete steps.
  buildDirection: string;
  // Late scaffold refinements (M2). Short structured echoes of buildDirection /
  // the Case; optional and never gate the ladder.
  stack?: string;
  scope?: string;
  github?: GenesisGithubParams;
  // Operator-curated naming workbench. Optional and backward-compatible: older
  // Genesis seeds have no history; new name-assist turns use it to avoid
  // cycling through rejected names and to refine from shortlisted ones.
  nameWorkbench?: GenesisNameWorkbench;
  // Explicit operator/engine-tracked stage. When absent the engine derives the
  // current stage from which narrative fields are filled (see currentStage()).
  // An explicit value never moves *behind* the derived floor — it only lets the
  // operator hold a later stage open.
  stage?: GenesisStage;
  // ── M3 in-workflow Creative mode ──
  // When true the seed belongs to an EXISTING workflow (real cwd) exploring an
  // alternative direction, not a from-nothing genesis. The turn engine injects the
  // staged block on `creative` (instead of the scratch-dir test), and the scaffold
  // lands in a sibling `ALTERNATIVE/` dir + a sibling plan — it never moves the
  // store or rebinds the cwd. Operator-armed; cleared on disarm.
  creative?: boolean;
  // Creative-mode only: a deterministic read-from-disk snapshot of the existing
  // project (name, description, README summary, stack/size hints), captured at arm
  // time. Grounds the alternative-direction conversation so the model anchors to
  // what is really there instead of inventing it. Opaque to the client. Never set
  // for a from-nothing genesis.
  projectContext?: string;
}

// Output of assessGenesisReadiness(): a non-blocking snapshot of how close the seed
// is to advancing past its current stage. `ready` is advisory only — Genesis never
// blocks a turn on it; the operator drives stage transitions.
export interface GenesisReadiness {
  stage: GenesisStage;          // the stage being assessed (the current stage)
  ready: boolean;               // all of this stage's checks pass
  met: string[];                // human-readable labels of passing checks
  missing: string[];            // human-readable labels of failing checks
  nextStage: GenesisStage;      // stage advanced to once ready (== stage at the top rung)
  isFinalStage: boolean;        // true when stage === 'build' (no rung above)
  readyToScaffold: boolean;     // build-stage checks pass → M2 may offer Create scaffold
}

// An empty seed — the starting point for a from-nothing genesis (M2).
export function emptyGenesisSeed(): GenesisSeed {
  return { title: '', spark: '', concept: '', theCase: '', buildDirection: '' };
}

// ── M2 WebSocket messages ──

// Client → Server. Replace the workflow's working seed. The server stores it on
// the workflow config (the durable home while the workflow has no cwd — it rides
// the client-persisted config back on rehydrate) and mirrors it into meta.json once
// a cwd is bound. Echoed back as `genesis_seed_updated`.
export interface GenesisSeedUpdateMessage {
  type: 'genesis_seed_update';
  workflowId: string;
  seed: GenesisSeed;
}

// Client → Server. Operator-confirmed scaffold: create the project folder under
// `root` (default ~/Projects), write the seed docs, optionally create a GitHub repo,
// bind the cwd, and seed a plan. Irreversible folder creation — the client confirms
// before sending. `github` overrides any github params already on the seed.
export interface GenesisScaffoldMessage {
  type: 'genesis_scaffold';
  workflowId: string;
  // Parent directory the new project folder is created under. Optional; the server
  // defaults to ~/Projects. Tilde-expanded server-side.
  root?: string;
  github?: GenesisGithubParams;
}

// Client → Server. Ask the workflow's current primary agent to propose text for
// one Genesis field. Bounded, read-only, text-only: it does not mutate the seed
// and does not write files. The client applies the suggestion by sending the
// usual genesis_seed_update after operator review.
export interface GenesisAssistRequestMessage {
  type: 'genesis_assist_request';
  workflowId: string;
  requestId: string;
  field: GenesisAssistField;
  intent: GenesisAssistIntent;
  seed: GenesisSeed;
  instruction?: string;
}

// Server → Client. The seed after a successful update, with the engine's advisory
// readiness + the next-field prompt so the UI can render guidance without
// re-deriving it. Fans out to the workflow's observers.
export interface GenesisSeedUpdatedMessage {
  type: 'genesis_seed_updated';
  workflowId: string;
  seed: GenesisSeed;
  readiness: GenesisReadiness;
  nextPrompt: string;
}

export interface GenesisAssistStartedMessage {
  type: 'genesis_assist_started';
  workflowId: string;
  requestId: string;
  field: GenesisAssistField;
  intent: GenesisAssistIntent;
}

export interface GenesisAssistProposedMessage {
  type: 'genesis_assist_proposed';
  workflowId: string;
  requestId: string;
  field: GenesisAssistField;
  intent: GenesisAssistIntent;
  suggestion: string;
  rationale?: string;
  // Working-name assists can return a batch of candidates. For non-name fields
  // this is omitted and `suggestion` is the single field value.
  options?: GenesisNameOption[];
  error?: string;
}

// Server → Client. A workflow's working directory was bound (after a cwd-less
// genesis was scaffolded). The client folds `cwd` into its persisted config so a
// later rehydrate resumes the real project, and refreshes cwd-scoped panels.
export interface WorkflowCwdBoundMessage {
  type: 'workflow_cwd_bound';
  workflowId: string;
  cwd: string;
}

// Server → Client. The scaffold completed: the project dir, the relative paths
// written, the seeded plan id, and the repo URL when one was created. `repoError`
// is set (non-fatal) when repo creation was requested but failed — the scaffold +
// cwd bind still succeeded.
export interface GenesisScaffoldedMessage {
  type: 'genesis_scaffolded';
  workflowId: string;
  cwd: string;
  written: string[];
  planId?: string;
  repoUrl?: string;
  repoError?: string;
  // M3 Creative mode: true when this was a sibling scaffold into `cwd/ALTERNATIVE/…`
  // (the cwd was NOT rebound — `written` paths are relative to the existing cwd).
  creative?: boolean;
  // M3: hint the client to offer Spawn-from-here so the operator can fork the new
  // direction into a fresh tab rather than continuing in the populated workflow.
  suggestSpawn?: boolean;
}

// ── M3 in-workflow Creative-mode messages ──

// A deterministic, point-in-time read of how large/established the existing project
// is, computed at arm time. Advisory only — it gates nothing; it powers the
// late-stage "you are exploring an alternative for a real, established codebase"
// warning the operator asked for.
export interface GenesisCodebaseInfo {
  fileCount: number;       // git-tracked files when in a repo, else a capped walk
  established: boolean;    // git history present OR fileCount over the threshold
  warning?: string;        // human-readable caution, set when established/large
}

// Client → Server. Arm (or, with `disarm`, un-arm) Creative mode on an EXISTING
// real-cwd workflow. Arming captures a project-context snapshot, assesses codebase
// size, and seeds a `creative` GenesisSeed (preserving any prior creative-seed
// fields); disarming clears `creative` but keeps the seed fields. Echoed back as
// `genesis_creative_armed`. Rejected for a from-nothing (scratch-dir) genesis.
export interface GenesisCreativeArmMessage {
  type: 'genesis_creative_arm';
  workflowId: string;
  disarm?: boolean;
}

// Server → Client. The result of arming/disarming Creative mode: the (possibly
// prefilled) seed with advisory readiness + next prompt, plus the codebase
// assessment (present only while armed). Fans out to the workflow's observers.
export interface GenesisCreativeArmedMessage {
  type: 'genesis_creative_armed';
  workflowId: string;
  armed: boolean;
  seed: GenesisSeed;
  readiness: GenesisReadiness;
  nextPrompt: string;
  codebase?: GenesisCodebaseInfo;
}
