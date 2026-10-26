# Genesis: staged project ideation

Genesis turns a vague idea into a defined, scaffoldable project through a short staged
conversation. Genesis uses a staged ideation lifecycle, anchored anti-hallucination field prompts, readiness checks, and (in M2) a scaffold writer. It does not add a separate agent loop. Genesis uses Arco's existing primary agent, assembling its system blocks plus a next-field prompt. **No new loop, no second model, no separate orchestration layer, no new database.** It follows the operator-reviewed scaffolding and scope rules in `CLAUDE.md`: operator-initiated, deterministic, visible in `events.jsonl`, and reversible.

## The seed

A `GenesisSeed` (`shared/src/protocol/genesis.ts`) is the whole state - folded into a
workflow's metadata in M2, never a separate store. It compresses the source ideation model into
a **4-rung narrative ladder**, one primary field per rung:

| Stage | Field | What it captures |
|---|---|---|
| **Spark** | `spark` | The raw idea in the operator's own words. Source-of-truth for everything below. |
| **Concept** | `concept` (+ `title`) | What the thing *is*, in plain language - the core mechanism. Built from the Spark. |
| **The Case** | `theCase` | Why building *this* concept is worth it; who it's for; where scope ends. Argues for the Concept. |
| **Build-direction** | `buildDirection` | Stack direction, scope boundaries, first concrete steps. Serves the Concept + the Case. |

`stack` / `scope` / `github` are late structured refinements the M2 form collects for
scaffolding - they do **not** gate the ladder.

## The engine (M1)

Two server modules, both pure (no I/O, no model) and covered by `npm run smoke:genesis-engine`:

- **`server/src/genesis/stages.ts`** - the ladder + lightweight, *non-blocking* readiness.
  - `currentStage(seed)` - derives the working stage from which fields are filled (the lowest
    unsatisfied rung). An explicit `seed.stage` may hold a *later* rung open but never moves the
    seed behind the derived floor.
  - `nextField(seed)` - the single most important field to ask for next (first unmet check in
    ladder order), or `null` when the seed is ready to scaffold.
  - `assessGenesisReadiness(seed)` - `{ stage, ready, met, missing, nextStage, isFinalStage,
    readyToScaffold }`. Advisory only: the operator drives transitions; Genesis never blocks a
    turn on readiness. The Spark threshold is 40 chars.

- **`server/src/genesis/prompts.ts`** - prompt assembly, same labeled-block shape as
  `buildLocalClusterSystemPrompt` (`server/src/server/prompts.ts`).
  - `buildGenesisSystemBlock(seed, { base? })` - composes the genesis role, the **grounding /
    anti-hallucination rule** (*"treat every empty field as genuinely unknown - never invent
    audiences, markets, tech, scope, deadlines, or constraints"*), the **stage-aware
    personality** (generative early -> practical late), a stage-status line, the labeled **seed
    context** (filled fields first, empties marked so the grounding rule can treat them as
    unknown), and the **anchoring contract** for the field being prompted (each downstream field
    cites its upstream source-of-truth). `base`, when given, is the workflow's existing system
    prompt and is appended last so the genesis framing takes precedence - M2/M3 pass it for the
    Creative-mode project fold. Returns one string ready to be a forced first system block
    (Native) or an `appendSystemPrompt` fold (CLI/Codex).
  - `nextFieldPrompt(seed)` - the operator-facing question for the next field (a ready-to-
    scaffold message when nothing is left). Surfaced as a composer suggestion in M2 - never
    auto-sent.

### Anchoring & anti-hallucination

The load-bearing safety property. Empty fields stay empty (`emptyGenesisSeed()` never
placeholders them) so the grounding rule can treat them as genuinely unknown. Every downstream
field is anchored to its upstream source-of-truth, so the model can't silently redefine the
project when filling a later field. Both rules are baked into **every** assembled block
regardless of stage.

## The from-nothing flow (M2)

A Genesis workflow starts with **no project folder**. But the turn engine requires a cwd, so
the workflow is created in a **hidden scratch ideation dir** (`~/.arco/genesis/<wfid>`,
`genesisScratchDir()`); the staged conversation runs there while the genesis system block is
injected each turn (`turnEngine.ts`, gated on the cwd being a scratch dir). The seed's durable
home is `WorkflowConfig.genesisSeed` - it rides the client-persisted config and is re-sent on
`rehydrate_workflows`, so a restart mid-ideation restores it.

**Surfaces (client):**
- **New-workflow `GENESIS` mode** (`WorkflowCreator`) - a third mode toggle. Collects a working
  name + the Spark only; launches a cwd-less workflow with `genesisSeed` set.
- **`GENESIS` right-panel tab** (`RightPanel/GenesisTab.tsx`) - the seed editor (the five
  narrative fields + stack/scope/GitHub), the advisory readiness + next-field prompt, the
  staged field assistant controls, and the **CREATE & SCAFFOLD** action. Shown only
  while the workflow is in its scratch dir; it disappears once a real cwd is bound. Field edits
  debounce a `genesis_seed_update`.

**Field assist (`genesis_assist_request`):** the Genesis tab can ask the workflow's current
primary agent to propose one field at a time. Narrative fields get **IMPROVE / WRITE / EXPAND**;
stack and scope get targeted recommenders plus improve. The working name is a small naming
workbench: **NAME / IMPROVE** returns multiple candidates with rationale, and the operator can
**USE**, **SHORTLIST**, or **REJECT** each candidate. Shortlisted/rejected names persist on the
seed as `nameWorkbench`, so refinement prompts avoid looping through rejected names and can build
from shortlisted ones. Assist runs as a bounded, read-only, text-only worker (`tools: []`,
read-only sandbox) and emits `genesis_assist_started` then `genesis_assist_proposed`. It never
mutates the seed or writes files on its own; the operator applies suggestions or name-history
actions through the ordinary `genesis_seed_update` path. Covered by `npm run smoke:genesis-assist`.

**Scaffold + rebind (`server/src/ws/genesisHandlers.ts`):** operator-confirmed `genesis_scaffold`
-> pick a unique dir under the chosen root (configured project root) -> **flush + move** the on-disk
store (`.arco/workflows/<wfid>`) scratch->real and re-init it (recovering the seq from the moved
`events.jsonl`, so the **transcript + monotonic seq carry over**) -> repoint `workflowCwds` +
`config.workingDirectory` -> write the seed docs (`README.md`, `SPEC.md`, `TODO.md`), `.gitignore`,
and local gitignored agent notes (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`) with the Appendix-D
hardened writer -> `git init` + initial commit -> optional `gh repo create` (best-effort,
non-fatal) -> seed + attach a plan -> rename the workflow to the final seed title -> rewrite
`meta.json` (real cwd + seed mirror + planId) -> remove the scratch dir -> broadcast
`workflow_cwd_bound` + `workflow_renamed` + `genesis_scaffolded`.

The GitHub checkbox uses the operator's local `gh` CLI auth and runs
`gh repo create <repo> --private|--public --source <dir> --remote origin --push`. The UI collects
visibility (private by default, public optional) and an optional repo name; when omitted, the
repo name follows the slugged project folder. A `gh` failure is reported as `repoError` but does
not undo the local scaffold. When public visibility is selected, the choice is persisted on the
Genesis seed, a public-repo safety block is injected into future turns, and the generated local
agent notes tell agents to stop before committing or pushing anything sensitive.

**Scaffold safety (Appendix D):** `writeScaffold` rejects absolute / `..`-traversal / backslash /
NUL / hidden-dotfile paths (except the deterministic root `.gitignore`), refuses to write through
a symlinked ancestor, never overwrites an existing file, and caps the file count. The seed docs
are generated deterministically from the seed - no model call. Covered by
`npm run smoke:genesis-scaffold` (path-safety rejections) and `npm run smoke:genesis-rebind`
(seq continuity + transcript carry-over across the move).

**WS messages** (`shared/src/protocol/genesis.ts`): client->server `genesis_seed_update` /
`genesis_assist_request` / `genesis_scaffold`; server->client `genesis_seed_updated` (seed +
readiness + next prompt) / `genesis_assist_started` / `genesis_assist_proposed` /
`workflow_cwd_bound` / `genesis_scaffolded`.

## In-workflow Creative mode (M3)

Creative mode runs the **same M1 process inside an existing project** to explore an alternative
direction - without the from-nothing scratch dir, and without ever editing the project. The
distinguishing state is **`GenesisSeed.creative === true`** (durable on `config.genesisSeed`,
mirrored to `meta.json`); the turn engine injects the genesis block on that flag instead of the
scratch-dir test.

**Arm / disarm (`genesis_creative_arm` -> `genesis_creative_armed`, `genesisHandlers.ts`):** the
operator arms Creative mode on a real-cwd workflow. Arming runs two **deterministic, model-free
disk reads** (`server/src/genesis/creative.ts`):
- `gatherProjectContext(cwd)` - a labeled snapshot (name from `package.json`/dir, description,
  README heading + summary, detected stack markers, CLAUDE.md presence). Stored as
  `seed.projectContext` and folded into the genesis system block **before** the seed so the model
  anchors to what is really on disk; the grounding rule forbids inventing past it. Opaque to the
  client.
- `assessCodebase(cwd)` - `git ls-files` count (or a capped walk that skips heavy/generated dirs)
  + an **established** flag (git history OR at least 40 source files) + an advisory **warning** string.
  This is the operator's stated late-stage guardrail; it gates nothing, it just cautions.

Arming seeds a `creative` seed (preserving prior creative-seed fields on re-arm; a working title
defaults to the project name). Disarming clears `creative` + `projectContext` but keeps the idea
fields, so the engine stops injecting the block.

**Creative scaffold (`handleCreativeScaffold`):** the `genesis_scaffold` handler branches on
`seed.creative`. Instead of creating + rebinding a new project dir, it writes the seed docs into a
**sibling `ALTERNATIVE/<slug>/`** dir inside the existing cwd (the hardened writer's in-tree /
no-overwrite guards keep it confined) and seeds a **separate plan** (fresh id - never overwrites
the existing one; attached so it shows in the Plans tab, but `wf.planId` is **not** repointed). No
store move, no cwd rebind, no `git init`, no `gh`. Broadcasts `genesis_scaffolded` with
`creative: true` + `suggestSpawn: true`; the client surfaces a Spawn-from-here hint so a sharply
diverging direction forks into a fresh tab rather than continuing in the populated workflow.

**Surface (client):** the `GENESIS` tab is shown for any real-cwd workflow. Unarmed it shows the
**ARM CREATIVE MODE** panel; armed it shows the established-codebase warning + a **DISARM** button
+ the seed editor + **CREATE ALTERNATIVE** (writes into `ALTERNATIVE/`, no parent-folder / GitHub
inputs). Covered by `npm run smoke:genesis-scaffold` (codebase assessment, context snapshot,
sibling-dir write leaves the project untouched) and `npm run smoke:genesis-engine` (projectContext
folds in only when `creative`).

**WS messages** (M3): client->server `genesis_creative_arm` (`{ workflowId, disarm? }`);
server->client `genesis_creative_armed` (`{ armed, seed, readiness, nextPrompt, codebase? }`). The
`genesis_scaffolded` message gains optional `creative` + `suggestSpawn` flags.
