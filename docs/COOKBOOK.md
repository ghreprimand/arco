# Cookbook — intelligent local-LLM management

> Workbench Expansion **Part G**. Origin: operator request 2026-05-31 (Cookbook
> screenshots). Supersedes the descoped D6.

The Cookbook is a *discover → fit-score → download → run → configure* pipeline for
local models, built in the spirit of Odysseus's Cookbook (which is built on
**llmfit**, MIT). It answers "what can I even run on this box?" and then closes the
loop to "it's selectable in CONFIG."

**Phases.** G1 (shipped): hardware profile + fit/scoring engine. G2 (shipped):
catalog search (HF Hub + Ollama library) + the fit table. G3 (shipped):
agent-driven recommendation (a top-tier agent reasons over the fit-filtered
shortlist for a task). G4 (shipped): download + run + auto-register into
`llamacppCatalog`. **The Cookbook loop is now complete end-to-end** — discover →
fit-score → recommend → download → register → selectable in CONFIG.

## Grounding (load-bearing)

1. **Port, don't reinvent the scoring engine.** `llmfit` (MIT) already does the
   hard part — VRAM / KV-cache estimation, throughput (t/s) and gpu/cpu-offload
   mode heuristics, the FIT verdict + numeric SCORE. G1's `fit.ts` ports/adapts
   that math in TypeScript rather than deriving it from scratch. The file header
   documents exactly what was adapted.
2. **The operator's rig.** ONE NVIDIA **5090 (32 GB VRAM)**, served locally via
   **llama.cpp (GGUF)** + **Ollama** — *not* vLLM/AWQ. So fit sizes everything for
   GGUF/llama.cpp (all weights resident; `-ngl all`, or spill to system RAM).
   vLLM/AWQ paged-attention paths from llmfit were deliberately not ported. The fit
   engine sizes off the **detected** hardware automatically.

**Four-question test.** Operator-initiated (you scan/score/recommend — nothing
auto-pulls); deterministic (fit scores are pure functions of hardware + model
metadata); visible (G2–G4 downloads/registrations emit `events.jsonl`); reversible
(delete a model, remove an entry). No API-billing surface.

## G1 — Hardware profile + fit/scoring engine

### Files

- `shared/src/protocol/cookbook.ts` — types/consts only: `HardwareProfile`,
  `GpuInfo`, `HardwareSimPreset` (+ `HARDWARE_SIM_PRESETS`), `ModelSpec`,
  `FitResult` (`FitVerdict` / `FitMode`). Exported from the protocol barrel.
- `server/src/cookbook/hardware.ts` — `probeHardware()` (cached), `rescanHardware()`
  (the RESCAN — clears the cache + re-probes), `simulatedProfile(preset)`.
- `server/src/cookbook/fit.ts` — pure scoring math: `scoreFit()` + helpers,
  `estimateVram()`, the `QUANT_BPW` table.

### Hardware profile

`probeHardware()` is **read-only** — it never writes or mutates the system. On
Linux it shells out to `nvidia-smi` via **execFile with an argv array** (a fixed
binary + fixed literal args, never a shell string, never interpolation):

```
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits
```

It parses each `name, MiB` line into `GpuInfo`, sums VRAM, and reads system RAM
(`os.totalmem()`) and cores (`os.cpus().length`), with `backend: 'cuda'`. On macOS
(or any box without nvidia-smi — ENOENT, non-zero exit, no GPUs) it **falls back**
without throwing to a `backend: 'metal'` (darwin) or `'cpu'` profile with empty
`gpus`, a `note`, and RAM/cores still populated. The result is **cached** in-module;
`rescanHardware()` clears the cache and re-probes.

**Simulation presets** (`simulatedProfile`) let the operator preview a fit against a
hypothetical rig without owning it: `ram` (CPU/system-RAM only), `gpu1`/`gpu2`/
`gpu4`/`gpu8` (N × a 5090-class 32 GB CUDA card).

### Fit / scoring (pure, deterministic)

`scoreFit(model, hw, targetContext?)` — no `Date.now`, no `Math.random`, no system
reads; every output derives from the arguments. Core formula:

```
VRAM(ctx) = weights + KV-cache(ctx) + overhead
  weights   = sizeBytes (if known) else params(B) × 1e9 × (bpw(quant) / 8)
  KV-cache  = 2 (K,V) × layers × ctx × kvDim × 2 bytes (fp16 cache)
  overhead  = ~700 MB CUDA fixed + 6% of weights (scratch/activations)

maxContextThatFits = floor((VRAM_available − weights − overhead) / KV-bytes-per-token),
                     capped at model.contextMax
throughput (t/s)   ≈ memory-bandwidth / bytes-touched-per-token   (memory-bound decode)
```

`layers` / `kvDim` are coarse per-family heuristics keyed on parameter count (GQA
already folded into `kvDim`). G2 can refine them from real GGUF metadata.

**Quant → bits-per-weight** (`QUANT_BPW`, "effective bits per weight"; the weight
estimate divides by 8 to get bytes; K-quants carry ~0.5 bit of block-scale
overhead above nominal):

| Quant | bpw | | Quant | bpw |
|---|---|---|---|---|
| Q2_K | 2.6 | | Q5_0 | 5.5 |
| Q3_K_S | 3.4 | | Q5_K_S | 5.4 |
| Q3_K_M | 3.9 | | Q5_K_M | 5.5 |
| Q3_K_L | 4.3 | | Q6_K | 6.6 |
| Q4_0 | 4.5 | | Q8_0 | 8.5 |
| Q4_K_S | 4.4 | | F16 / BF16 | 16 |
| Q4_K_M | 4.5 | | F32 | 32 |

An unlisted tag falls back to `Q<n> + 0.5` (so `Q4_K_XL` ≈ 4.5), else Q4_K_M.

### Verdict + score semantics

- **`mode`** — `gpu` (fully VRAM-resident) vs `cpu-offload` (spills to system RAM;
  slow). cpu-offload always implies verdict `NO`.
- **`verdict`** (the green/amber/red badge):
  - `PERFECT` — fits on GPU with comfortable headroom (≥1.6× the needed VRAM) at a
    useful context.
  - `GOOD` — fits on GPU (≥1.15× headroom) at a useful context.
  - `TIGHT` — fits but with little headroom.
  - `NO` — doesn't fit on GPU at any useful context (cpu-offload at best), or the
    max context that fits is below ~4k.
- **`score`** — 0–100 sort key for the catalog table. Folds the verdict tier
  (PERFECT 70 / GOOD 55 / TIGHT 40 base) + VRAM headroom (+12) + available context
  (+10) + throughput (+8); `NO` rows score 0–15 by throughput so a usable
  cpu-offload still outranks the truly impossible.

### Smoke

`scripts/smoke/cookbook-fit.ts` (`npm run smoke:cookbook-fit`) — pure import, no
server. Asserts a qwen-coder 32B Q4_K_M fits the 5090 (GOOD/PERFECT, gpu, plausible
ctx), a ~200B model returns NO/cpu-offload on one 5090 but fits the simulated
8×5090 rig, the bpw table values, that VRAM grows with context, that Q8 > Q4, and
that `scoreFit` is deterministic across identical calls.

## G2 — Catalog search (HF + Ollama) + fit table

### Files

- `server/src/cookbook/catalog.ts` — the two source fetchers + the **pure**
  `normalizeAndScore` + the `searchCatalog` wrapper (fetch + TTL cache + assemble).
- `server/src/http/cookbookRoutes.ts` — `GET /api/cookbook/catalog`,
  `GET /api/cookbook/hardware`, `POST /api/cookbook/hardware/rescan`.
- `shared/src/protocol/cookbook.ts` — `CatalogSource`, `CatalogModel`,
  `CatalogRow`, `CatalogQuery`, `CatalogResponse` (types only).
- `client/src/components/Cookbook/` — `CookbookModal` + `CatalogFilters` +
  `CatalogTable` + `fmt.ts`; `client/src/stores/cookbookStore.ts`.

### Sources (public, keyless GET)

- **Hugging Face Hub** — `https://huggingface.co/api/models?library=gguf&full=true&limit=40`
  (+ `search=` for a text query, else `sort=downloads` for the trending feed; +
  `pipeline_tag=` for a task facet). Read fields: `id`/`modelId`, `pipeline_tag`,
  `siblings[].rfilename`/`.size` (the GGUF quant variants + per-variant size),
  `downloads`. Served via **llama.cpp**.
- **Ollama library** — a **curated, bundled manifest** (`server/src/cookbook/ollamaLibrary.ts`),
  **not a live fetch**. Ollama has no official keyless catalog API, and depending on
  a third-party community mirror would be a silent external dependency the operator
  can't audit — so the Ollama side is an in-repo, operator-readable/-extensible list
  of canonical `ollama pull <name>` targets that fit a single-GPU GGUF rig. Each
  entry carries an **explicit total `params`** (correct for MoE, where the name tag
  understates the total — e.g. `mixtral:8x7b` is ~47B, not 7B) and a `moe` flag.
  Text-filtered to the query; scoring it is fully deterministic. Served via **Ollama**.

### Normalized shape

Both sources normalize to a `CatalogModel`:
`{ repo, name, params, quantVariants[], sizeByQuant?, source: 'hf'|'ollama', task?, moe? }`.
For HF, `params` is parsed from the name (`32b` → 32) and quant variants come from
the `*.gguf` sibling filenames; `sizeByQuant` is **per-variant** (keying by quant so
a Q4 row isn't scored with the Q8 file's bytes); MoE is detected from the name
(`moe`, `8x7b`, `235B-A22B`, mixtral). For Ollama, `params`/`moe` come from the
manifest's **explicit** fields (the name heuristic is only a fallback), and quant is
Ollama's `Q4_K_M` default.

### Scoring + the table

`normalizeAndScore(raw, hw, query)` is the **pure** half — `(raw HF + raw Ollama +
HardwareProfile + query) → CatalogRow[]`. It crosses every quant variant with G1's
`scoreFit`, applies the quant (family-prefix) + task filters, and **sorts by SCORE
desc** (stable: score → params → repo → quant). Identical inputs → byte-identical
rows; the smoke feeds fixtures and asserts on this with no network. `searchCatalog`
wraps it with the live fetch + cache.

Each `CatalogRow` drives the screenshot columns: **FIT** (verdict) · **MODEL**
(+MoE badge) · **PARAM** · **QUANT** · **VRAM** · **CTX** · **SPEED** · **SCORE** ·
**MODE**. FIT is coloured green (PERFECT/GOOD) / amber (TIGHT) / red (NO) client-side.

### Caching + trending + failure

The **raw** source payloads are cached for 5 min keyed by the query text/task (so
re-scoring against a different `sim` preset or after a rescan is free). The
**trending-that-fits** feed (HF trending filtered to a non-NO verdict, capped 12)
is returned when the operator hasn't typed a text query — the default "what can I
run?" view. **Graceful failure:** each source fetch is independently
`Promise.allSettled` + an 8s `AbortController` timeout; a down/slow source degrades
to `sources.<src> = false` + a human-readable `note`, never a throw or a 500. The
worst case is an empty `rows` with both flags false. A double-failure is **not**
cached (so it doesn't pin an empty catalog for the TTL).

### Read-only in G2

G2 is **read-only search**. `catalog.ts` and `cookbookRoutes.ts` are HTTP-fetch
only — **no** `execFile` / `child_process`, no path use, no disk write, no model
registration. The expand-row **DOWNLOAD** action (the live `DownloadActions`
component) is wired in **G4**; downloading/serving/registering lives there, not in
this read-only search path.

### Smoke

`scripts/smoke/cookbook-catalog.ts` (`npm run smoke:cookbook-catalog`) — pure
import, NO network. Feeds fixture HF (a qwen-coder GGUF with Q4/Q5/Q8 variants + a
235B MoE) + Ollama payloads + the fixed 5090 profile into `normalizeAndScore` and
asserts: rows normalized (repo/name/params/quant/source), one scored row per quant
variant, qwen Q4 fits (GOOD/PERFECT, gpu), the 235B flagged NO + MoE, sorted by
SCORE desc, the quant filter narrows, and determinism.

## G3 — Agent-driven recommendation (the layer beyond Odysseus)

A top-tier agent (Claude / Codex, picked via **RUN AS**) reasons over the G1
hardware profile + the G2 fit-filtered candidate set + the operator's task profile
and recommends a **specific** model + quant + context — with a rationale grounded
in the fit numbers and a ready-to-apply Arco config block. This is the one thing
Odysseus's heuristic score table can't do: "given my 5090 and that I want a fast TS
coding assistant, *this* model, *this* quant, *this* context, because…".

### Reuses B2 — does NOT fork it

The recommendation is **one bounded Deep-Research turn** (B2). G3 does NOT spawn
its own worker, add a new bounded-turn mechanism, or touch `runResearch.ts`. The
server builds a rich grounding **topic** (`server/src/cookbook/recommend.ts`,
`buildRecommendationTopic`, PURE) and hands it to the existing `runResearch()`,
which already enforces the round ceiling (web-tool `max_uses` on Claude Native),
writes a `research-<ts>.md` artifact, broadcasts `research_started/_progress/
_complete`, and is cancellable via the existing `cancel_research` path. The
recommendation artifact **is** a research report — it lands in the active tab's
RESEARCH tab through the exact same surface. Only the prompt differs. See
`docs/PRIMITIVES.md § Deep Research` for the shared bounded-turn contract.

### Files

- `server/src/cookbook/recommend.ts` — PURE `buildRecommendationTopic(profile,
  candidates, taskProfile, maxRounds)` (the grounding + instruction text) and the
  PURE `filterCandidatesForProfile(rows, taskProfile)` fit-filter. No I/O, no clock.
- WS handler `handleCookbookRecommendRequest` in `server/src/ws/workflowHandlers.ts`
  — resolves the RUN AS account (like the researcher), fetches the G2 fit-scored
  catalog against the G1 profile (detected or `sim`), fit-filters, builds the topic,
  and calls `runResearch`. Wired in `server/src/index.ts` at
  `cookbook_recommend_request`.
- Protocol: `CookbookRecommendRequestMessage` + `CookbookTaskProfile` /
  `COOKBOOK_TASK_PROFILES` in `shared/src/protocol/cookbook.ts`. NO dedicated result
  message — the lifecycle reuses the `research_*` events.
- Client: `client/src/components/Cookbook/RecommendDialog.tsx` (task-profile select
  + RUN AS picker + round cap; the rec is free text, so it points the operator at
  the per-row **DOWNLOAD** in the catalog table rather than auto-applying a winner),
  launched from the **RECOMMEND** button in `CookbookModal`'s header. Dispatch goes
  through `sendCookbookRecommend` (registered into `cookbookStore` by `useWebSocket`,
  mirroring `docEditStore`).

### Task profiles + their fit-filters

Five profiles bias both the candidate shortlist and the prompt. Every filter first
drops `NO`-verdict rows (the rig can't run them) and falls back to the fitting set
if a strict filter would empty the list:

- **coding** — keep coder-tuned models (Qwen-Coder / DeepSeek / CodeLlama /
  Codestral / starcoder name match).
- **fast-autocomplete** — drop big models (>14B), then sort by throughput desc.
- **long-context** — sort by `maxContextThatFits` desc (largest usable context first).
- **vision** — keep only vision-capable / multimodal rows (name or task facet).
- **general** — the fitting set as-is (score-sorted).

### Recommendation structure + config block

The prompt asks for `## Recommendation` (model + quant), `## Configuration`
(recommended context ≤ MAX CTX, expected t/s + mode, backend), `## Rationale`
(grounded in the fit numbers, naming a runner-up), and `## Apply` — a ready-to-paste
config block: a **llama.cpp catalog entry** (`{ alias, ggufPath, ctxSize, ngl,
capabilities }` — the `~/.arco/llamacpp.json` "models" shape) for a HF/GGUF pick,
or an `ollama pull <model:tag>` line for an Ollama pick. Web search is allowed ONLY
to confirm current facts about a candidate already in the set — never to discover
models outside it.

### Fence (clears the four-question test)

Operator-armed, **not** an orchestrator. The agent RECOMMENDS; it does not route,
decide "is this done?", select-and-apply, or auto-download. It is **one bounded
turn** — not an agent loop, not a second-LLM judge, no "keep researching until
satisfied". The operator picks the profile + agent, reviews the artifact, and
applies the config themselves: there is no auto-download of "the winner" — the
operator downloads the recommended row via the per-row **DOWNLOAD** action (G4). The
agent runs on the operator's Claude/Codex subscription via RUN AS — no API billing.

### Smoke

`scripts/smoke/cookbook-recommend.ts` (`npm run smoke:cookbook-recommend`) — pure
import, NO network/server/WS (the bounded turn itself is covered by
`smoke:research`). Feeds a fixed 5090 profile + a stubbed fit-scored `CatalogRow[]`
into `buildRecommendationTopic` + `filterCandidatesForProfile` and asserts: the
hardware + candidates + task profile are embedded; the required output structure is
requested (model+quant, context, t/s+mode, rationale, a config block for both
backends); the bounded-rounds + recommend-only/no-download framing is present;
determinism; and the per-profile fit-filters narrow correctly (NO rows always
dropped, fast-autocomplete drops the big/slow row and sorts by throughput, vision
keeps only vision rows, coding keeps only coder models, long-context leads with the
largest-context row).

---

## G4 — Download + run + auto-register

Closes the loop: take a chosen catalog pick and, on an **explicit operator click**
(DOWNLOAD on a row, or a confirmed G3 recommendation), fetch the weights, surface
live progress, and — for a GGUF pick — auto-register a `llamacppCatalog` entry so
the model is selectable in CONFIG immediately.

### Files

- `server/src/cookbook/install.ts` — the download + register logic. Pure cores
  (`preflight`, `sanitizeModelFilename`, `resolveWithinModelsDir`, `deriveAlias`,
  `uniqueAlias`, `buildCatalogEntry`) + the streamed pulls (`pullHfGguf`,
  `pullOllama`) + the HF quant-filename resolver (`resolveHfQuantFilename`).
- `shared/src/protocol/cookbook.ts` — the download lifecycle protocol
  (`CookbookDownloadRequestMessage` / `CookbookCancelDownloadMessage` /
  `CookbookDownloadProgressMessage`).
- `server/src/ws/workflowHandlers.ts` — `handleCookbookDownloadRequest` +
  `handleCancelCookbookDownload` (wired into the WS router in `index.ts` next to
  `research_request` / `cancel_research`).
- `client/src/components/Cookbook/DownloadActions.tsx` — the wired per-row action
  (pre-flight panel, progress bar, CANCEL, success/refusal); replaces G2's inert
  placeholders in `CatalogTable`'s expand-row. `cookbookStore` carries the active
  download projection; `useWebSocket` registers the download / cancel senders.

### Download backends (exec-free)

- **Ollama** — POST to `` `${getOllamaBase()}/api/pull` `` with
  `{ name, stream: true }` and parse the streaming NDJSON (`status` / `total` /
  `completed`) into progress events. **No `ollama pull` subprocess** — the HTTP API
  honours the operator's configurable / remote base URL (Tailscale) and gives
  progress natively. On success Ollama **auto-discovers** the tag via `/api/tags`,
  so there is **no catalog write**.
- **Hugging Face GGUF** — re-query the repo's sibling list
  (`/api/models/<repo>?full=true`) to resolve the exact quant filename + its size,
  then **stream-download** `` `https://huggingface.co/<repo>/resolve/main/<file>` ``
  via `fetch` into the models dir, emitting byte progress. An `AbortController`
  drives cancel.

Both are keyless public endpoints. There is **no `execFile` / `child_process` /
shell string anywhere in `install.ts`** — the entire file is HTTP-`fetch` + `fs`.

### Models dir + path confinement (load-bearing)

HF weights land **only** in `~/.arco/models/` (created on demand). The target
filename is sanitized to a **basename** (`sanitizeModelFilename` rejects empty, a
path separator `/`\\`, NUL, `.` / `..` / any `..` substring, a leading `-`, and a
non-`.gguf` extension). The final write path is then `path.join`ed onto the models
dir and `resolveWithinModelsDir` **resolves both and prefix-checks** that the target
still sits inside the (resolved) models dir — with a trailing-separator prefix so a
sibling like `…/models-evil` isn't accepted as "inside". A malicious repo / filename
can neither escape the dir nor smuggle a flag. The download streams to a `.part`
temp and is `fs.rename`d into place only on full completion.

### Disk pre-flight (refuse before downloading)

Before a single byte: compute the model size (HF sibling `.size`, or the Ollama
`/api/pull` total) and the **free disk** on the models-dir filesystem via
`fs.statfs` (`freeBytesOn`; works on Linux + macOS). `preflight(size, free, margin)`
**refuses** when `size + margin > free` (2 GB margin) and returns a structured
refusal with `sizeBytes` / `freeBytes` / `neededBytes` so the client shows "model
size vs free disk" up front. The refusal happens **before** the download starts —
the disk is never filled.

### Cancel + error cleanup

A cancel (operator CANCEL → `cookbook_cancel_download` → `AbortController.abort()`)
or any error aborts the fetch **and deletes the partial `.part` file** — no corrupt
`.gguf` is left behind, and **no catalog entry is written for an incomplete pull**.
The catalog is touched only after a fully successful download.

### Register (only after a fully successful download)

For an HF/GGUF pick, `buildCatalogEntry` builds a validated `LlamacppModelDef`
(alias derived from repo + quant, sanitized, and made **unique** vs the existing
catalog via `uniqueAlias`; `ggufPath` = the absolute downloaded path, asserted
absolute; `ctxSize` from the row's max-context / G1·G3; `ngl: 999`). It is persisted
with the existing **atomic** `writeCatalog` (`.tmp.<pid>` + rename, 64 KB cap) — the
write is never hand-rolled. The model is selectable in CONFIG immediately. For an
Ollama pick there's no catalog write (Ollama auto-discovers).

### Fence (clears the four-question test)

**Operator-initiated** — the handler runs only on an explicit
`cookbook_download_request`; there is no timer / hook / orchestrator path that pulls
weights (the only caller is the WS router's `cookbook_download_request` case).
**Bounded** — one fetch, a hard cancel. **Visible** — start / progress / done /
refused / cancelled all broadcast with the `workflowId`, so `send()` persists them
to `events.jsonl` (audit trail; refusals logged too). **Reversible** — the operator
deletes the file from `~/.arco/models/` and removes the catalog entry. **No
API-billing surface** — HF + Ollama are keyless; weights are artifacts (not system
packages, so the distribution packaging rule doesn't apply — but G4 surfaces
size + free disk before pulling).

### Smoke

`scripts/smoke/cookbook-install.ts` (`npm run smoke:cookbook-install`) — pure
import, NO network / server / WS, and it **never** touches the real
`~/.arco/llamacpp.json` or `~/.arco/models/` (injected paths / fixtures).
Asserts: (a) `preflight` rejects an oversized pull and accepts one that fits; (b)
the sanitizer rejects `../escape`, leading-dash, NUL, separators, `.` / `..`, and
non-`.gguf`, and `resolveWithinModelsDir` confines a clean basename to the models
dir; (c) `buildCatalogEntry` produces a correct `LlamacppModelDef` (alias unique vs
an existing-catalog fixture, absolute `ggufPath`, ctx carried, rejects a relative
path); (d) `freeBytesOn` returns a positive number and wires into `preflight`.
**Omission (noted):** no live streamed-download / partial-cancel-cleanup assertion —
that needs a local HTTP stub + temp dir; the cancel/cleanup invariant (delete the
`.part`, no catalog entry) is covered by code review + the documented rule.
