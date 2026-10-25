# Diagnostics

> Part A of `docs/ARCHON_OPS_PLAN.md`. A1 ships the Diagnostics tab + grouped
> status checks. A2 (support bundle, see below) extends it with a redacted
> copyable snapshot. A3 (model health panel, see below) adds a third System-modal
> tab. A4 (security posture) extends the same surface and lands here as it ships.

A single read-only surface answering **"what's actually working on this
machine?"** — for the operator and for future contributors. Lives in the
**System** modal (the ⏻ menu in the header). Three tabs: **Actions**
(RESTART / QUIT), **Diagnostics** (A1/A2 status checks + support bundle), and
**Models** (A3 local model health).

## Where it lives

| Layer | File |
|---|---|
| Pure check registry (probe logic) | `server/src/diagnostics/checks.ts` |
| Support-bundle builder + redaction | `server/src/diagnostics/supportBundle.ts` (A2) |
| HTTP route | `server/src/http/diagnosticsRoutes.ts` (`GET /api/diagnostics` + `…/support-bundle` + `…/model-health`) |
| Shared response types | `shared/src/protocol/opsDiagnostics.ts` |
| Client tab | `client/src/components/DiagnosticsTab.tsx` |
| Tab machinery | `client/src/components/SystemModal.tsx` |
| Smoke | `scripts/smoke/diagnostics.ts` (`npm run smoke:diagnostics`), `scripts/smoke/support-bundle.ts` (`npm run smoke:support-bundle`) |

The registry is the **single source of probe logic**. The route is a thin
wrapper (mirrors `endpointDiscoveryRoutes.ts`); the client just renders.

## Design fences (four-question test)

1. **Operator-initiated** — the tab calls `/api/diagnostics` on open and on the
   `↻ REFRESH` button. No daemon, no `setInterval`.
2. **Deterministic rules the operator can read** — each probe is a fixed action
   with a fixed status mapping (a version flag, a directory round-trip, a daemon
   ping). No heuristics, no model in the loop.
3. **Read-only** — nothing mutates settings, catalogs, or workflow state. The
   single write is a throwaway temp-file `events.jsonl` round-trip under
   `tmpdir()`, removed immediately — **never** a real workflow log.
4. **Reversible** — it's a readout; there's nothing to undo.

## Status model

Each check returns `{ id, group, label, status, detail, hint? }`:

| Status | Meaning | UI colour |
|---|---|---|
| `ok` | The probe ran and the thing works. | green (`--color-success`) |
| `warn` | Degraded, or an **optional** dependency is absent (ffmpeg missing, the TS language server not on PATH). Arco still functions; the operator loses a capability. | amber (`--color-warning`) |
| `error` | Something that **should** work doesn't (data dir not writable). A probe that **throws** also lands here, with `detail` prefixed `probe threw:`. | red (`--color-danger`) |
| `skipped` | Not probed on this platform/config (Antigravity CDP; per-cwd `.archon` from a machine-global call). Distinct from `warn` — nothing is wrong, we just didn't look. | grey (`--color-fg-muted`) |

## Resilience

- Every probe is wrapped by `safeProbe()` — a thrown probe becomes an `error`
  result carrying the message, **never** a crashed endpoint.
- Subprocess probes go through existing helpers (`capabilities.ts`,
  `media/ffmpeg.ts`, `github.ts`) which use `execFile` with an **argv array (no
  `shell: true`)**, a timeout, and resolve the missing-binary path to a benign
  value instead of throwing.
- Probes run **concurrently** (`Promise.all` across all groups) and each binary
  probe is individually time-bounded, so one slow binary can't hang the call.
- Cross-platform (Linux + macOS): POSIX only. The lone platform-specific probe
  is the Cookbook GPU probe (already degrades to a CPU/Metal profile without
  `nvidia-smi`). No hardcoded `/usr` paths, no Linux-only binaries.

## Groups + checks

### Core
| id | Probes |
|---|---|
| `core.data-dir-rw` | `~/.archon` read+write — writes a throwaway probe file and reads it back. |
| `core.events-log-roundtrip` | `events.jsonl` append+read round-trip against a **temp** path under `tmpdir()` (proves the append-then-read pattern; does not touch a real log). |
| `core.settings-cascade` | `readSettings()` parses the defaults → global cascade without throwing. |
| `core.recovery-registry` | `~/.archon/known-cwds.json` is readable / valid JSON. Absent = ok (no workflows yet). |
| `core.readiness` | Read-only snapshot of the `/readyz` gate. not-ready → `warn` (transient boot state, not a fault). |
| `core.logs` | Structured file logging: `getLogFilePath()` non-null (set by `ARCHON_LOG_FILE=1`) → `ok` with path + size; off → `skipped`. |

### Providers
| id | Probes |
|---|---|
| `providers.claude-cli` | `claude --version`. Absent → warn. |
| `providers.claude-native` | OAuth tokens present + unexpired at `~/.archon/auth.json`. |
| `providers.codex` | `codex --version`. |
| `providers.gemini` | `gemini --version`. |
| `providers.ollama` | base-URL `/api/tags` reachable + installed-model count. |
| `providers.llamacpp` | `llamacppManager.getStatus()` + catalog readable + registered-model count. |
| `providers.antigravity` | **`skipped`** — CDP presence has no cheap side-effect-free check. |

### Local Tools
| id | Probes |
|---|---|
| `local-tools.gh` | `gh` on PATH + `gh auth token` (token never logged). |
| `local-tools.ffmpeg` | `ffmpegAvailable()`. |
| `local-tools.ffprobe` | `ffprobeAvailable()`. |
| `local-tools.lsp` | PATH lookup for `typescript-language-server` / `pyright-langserver` / `gopls` / `rust-analyzer`. **Partial detection degrades to `warn`, never `error`** (this box has `rust-analyzer` but not `typescript-language-server`). |
| `local-tools.pty` | `node-pty` importable + `spawn()` present (integrated terminal). |

### Workbench
| id | Probes |
|---|---|
| `workbench.preview-proxy` | proxy route mounted (per-workflow targets bind on demand). |
| `workbench.recall-index` | `~/.archon/recall/recall.db` present/readable (absent = ok, builds on first indexed turn). |
| `workbench.knowledge-index` | **`skipped`** — knowledge bases are per-cwd, no machine-global index. |
| `workbench.cookbook-hardware` | `probeHardware()` — backend, RAM, cores, VRAM. |

### Storage
| id | Probes |
|---|---|
| `storage.archon-home` | `~/.archon` size (recursive byte sum). |
| `storage.project-archon` | **`skipped`** — per-cwd `<cwd>/.archon` is workflow-scoped, not a global path. |

### Security & Exposure (A4)

A read-only exposure-posture readout: when is Arco reachable beyond this
machine, and what does that imply? Informational only — **not** a multi-user
admin system.

The unifying rationale: Arco's HTTP/WS surface has **no auth** and exposes a
shell (the PTY terminal), git/GitHub ops, filesystem read+write under cwd roots,
and provider credentials. So **severity is conditioned on the bind address**:
bound to loopback, only this machine can reach those powers (`ok`, informational
detail); bound to a non-loopback address, the same powers are reachable by the
LAN/tailnet (`warn`). The bind default is loopback (`ARCHON_HOST` →
`127.0.0.1`); that default is why every capability check below is `ok` on a
normal box.

Every probe is a pure read of config / env / settings / manager-state — no
mutation, no network connection, and the lone subprocess reuses `gh auth token`
(boolean only). Per the shareable support bundle, **no `detail`/`hint` ever
echoes a token, env value, baseUrl, or absolute path** — only booleans and
classifications.

| id | Probes |
|---|---|
| `security.bind-address` | Classifies `HOST` via the pure exported `classifyBindAddress(host)`. Loopback → `ok`; `0.0.0.0`/`::` → `warn` (+ hint to set `ARCHON_HOST=127.0.0.1`); other private → `warn` (LAN/tailnet); other non-private → `warn` (potentially public). **Phase acceptance: `0.0.0.0` flips to a clear warning.** |
| `security.remote-access` | Honest + deterministic: an external SSH/Vite tunnel is a documented manual workflow Arco can't auto-detect. Loopback → `ok`; non-loopback → `warn`. |
| `security.terminal` | Integrated PTY terminal (arbitrary shell in your cwds). Loopback → `ok` (local only); exposed → `warn`. |
| `security.git-ops` | Git + GIT/GitHub primitives (commit/push). Boolean `gh` token presence enriches the detail (never the token). Loopback → `ok`; exposed + gh-authed → `warn`. |
| `security.writable-cwd-roots` | Counts entries in `~/.archon/known-cwds.json` (mirrors `core.recovery-registry`; **count only, never lists paths**). Loopback → `ok`; exposed → `warn`. |
| `security.provider-auth` | Boolean presence of Claude Native OAuth tokens + `gh` token. Loopback → `ok` (spendable by local clients only); exposed + any creds → `warn`. |
| `security.preview-proxy` | The proxy forwards to per-workflow loopback dev servers. Loopback → `ok`; exposed → `warn` (can forward LAN clients to your loopback dev servers). |
| `security.local-model-endpoints` | llama.cpp host (`ARCHON_LLAMACPP_HOST`) + resolved Ollama base-URL host. `0.0.0.0` llama-server → `warn`. A non-loopback **private** Ollama daemon is a deliberate remote (e.g. workstation over Tailscale) → `ok`; non-private Ollama → `warn`. Both loopback → `ok`. **Prints the classification, never the URL.** |
| `security.risky-env-config` | A small documented allowlist of risky env keys, reporting **names only** when set to a risky value: `ARCHON_HOST` (non-loopback), `NODE_TLS_REJECT_UNAUTHORIZED=0`, and any key matching `/DANGEROUS\|UNSAFE\|SKIP_PERMISSION\|NO_AUTH\|YOLO/i`. None → `ok`. |

Smoke: `scripts/smoke/posture.ts` (`npm run smoke:posture`) — unit-asserts
`classifyBindAddress` directly, then hits the live endpoint to confirm the
`security` group, all 9 ids, and a loopback `ok` on `security.bind-address`.

## Running the smoke

```bash
npm run dev               # in one terminal — needs the server on :3001
npm run smoke:diagnostics # in another
```

The smoke hits the live `GET /api/diagnostics` and asserts: 200; all six
groups present; every check has a valid `status` / `id` / `label` / `detail`;
the Core group has at least one `ok`; the TS-LSP-absent check degrades to
`warn`/`skipped` (not `error`); and no probe surfaced a `probe threw:` error.
Override the base with `ARCHON_SMOKE_HTTP_BASE`.

## Support bundle (A2)

The **⧉ COPY SUPPORT BUNDLE** button beside `↻ REFRESH` copies a paste-ready,
**redacted** text snapshot of this machine — the A1 diagnostics report plus
Arco version, git rev, platform, and runtime (node version + best-effort
service mode) — suitable for an issue or another agent. Operator-triggered only
(a button click; never a daemon).

| Layer | File |
|---|---|
| Builder + redaction + text render | `server/src/diagnostics/supportBundle.ts` |
| Route | `GET /api/diagnostics/support-bundle` (`server/src/http/diagnosticsRoutes.ts`) |
| Shared types | `SupportBundle` / `SupportBundleRuntime` / `SupportBundleResponse` (`shared/src/protocol/opsDiagnostics.ts`) |
| Client button + copy | `client/src/components/DiagnosticsTab.tsx` |

### Shape

`buildSupportBundle()` returns `{ json: SupportBundle, text }`. The endpoint
returns both; the client copies `text`. `SupportBundle` is an **explicit
allowlist** of safe fields — we never serialize raw settings, raw env, or raw
token objects:

```
{ generatedAt, archonVersion, gitRev, platform,
  runtime: { node, serviceMode },
  diagnostics: DiagnosticsReport (path-redacted),
  notes? }
```

- `gitRev` — `git rev-parse --short HEAD` against the Arco checkout (execFile,
  argv array, no shell, 4s timeout; missing git / non-repo → `unknown`).
- `runtime.serviceMode` — best-effort. Service mode proper lands in **Part B**;
  for now this is `dev (tsx watch)` when running under tsx, else `unknown`. It
  never claims a production mode Arco doesn't have yet.

### Redaction (Appendix D — allowlist, not denylist)

The bundle must contain **no** tokens, secrets, auth material, env secrets, or
private paths. Three layers stack:

1. **Safe-field allowlist** — `SupportBundle` is assembled from hand-picked
   fields only. There is no path that serializes a raw settings/env/token object.
2. **`redactPaths(str)`** — applied to every free-text `detail`/`hint` of the
   embedded diagnostics report. The user's home dir collapses to `~`; any
   remaining absolute path is reduced to a `<path>/<basename>` placeholder so a
   private directory layout never leaks (the basename stays so the message is
   still useful, e.g. `…/events.jsonl`).
3. **`scrubSecrets(text)`** — a defense-in-depth regex pass over the serialized
   bundle (both the `text` and the re-serialized JSON) replacing any token-shaped
   string with `<redacted>`. Patterns: GitHub tokens (`gh[pousr]_…`),
   OpenAI/Anthropic keys (`sk-…` / `sk-ant-…`), `Bearer …` headers, JWT-ish
   triples (`eyJ….….…`), long hex runs (40+) and long mixed base64-ish runs
   (32+). A 7-char short git rev is deliberately **not** matched. The A1 probes
   are written never to emit a token, so this is normally a no-op — it guards
   against a future probe that accidentally includes one.

`scrubSecrets` is exported and unit-tested directly by the smoke on crafted
strings carrying fake tokens; the live half asserts no `/home/<user>` path and no
secret pattern survives (the scrub is a fixed point over the returned text).

## Local model health panel (A3)

A model-operator-focused readout answering **"what can I run now / what's running
/ what failed last time / is my config stale?"**. A richer, *structured* sibling
of the A1 tab (one-line status per dep): three subsystems, each a typed
sub-report carrying concrete fields **plus a roll-up `DiagnosticStatus`**. Lives
in the **Models** tab of the System modal. Operator-triggered only (fetch on
open + `↻ REFRESH`); **never spawns a model**.

| Layer | File |
|---|---|
| Report builder (reuses ollama / llamacppManager / cookbook probes) | `server/src/diagnostics/modelHealth.ts` |
| Route | `GET /api/diagnostics/model-health` (`server/src/http/diagnosticsRoutes.ts`) — matched **before** the bare `/api/diagnostics` |
| Shared types | `ModelHealthReport` + `OllamaHealth` / `LlamacppHealth` / `CookbookHealth` / `ModelHealthModel` / `ModelFitWarning` (`shared/src/protocol/opsDiagnostics.ts`) |
| Client panel | `client/src/components/ModelHealthPanel.tsx` |
| Smoke | `scripts/smoke/model-health.ts` (`npm run smoke:model-health`) |

### Status framing (model-operator lens)

Reuses the A1 `ok|warn|error|skipped` vocabulary, but the fences differ for a
*model operator*:

- A **missing/unreachable subsystem is `warn`/`skipped`**, not `error` — the
  operator may simply not use it (Ollama daemon down, `llama-server` not on PATH).
- A **stale config or a fit mismatch is a `warn`** with an actionable hint.
- **`error` is reserved** for "configured and should work but its last launch
  failed" — i.e. the llama.cpp lifecycle manager state is `failed`.

Each sub-report builder is wrapped server-side (`safe()`) so one subsystem's
thrown probe degrades to a `warn` sub-report rather than failing the whole call;
`buildModelHealthReport()` never throws.

### Shape

```
ModelHealthReport {
  ollama:   OllamaHealth   { status, baseUrl, reachable, modelCount, models[], version?, detail, hint? }
  llamacpp: LlamacppHealth { status, binaryPath, modelCount, models[], managerState,
                             loadedAlias?, port?, pid?, loadedAt?, lastUsedAt?,
                             lastLaunchArgs?, lastStderrTail?, portReachable?, error?, detail, hint? }
  cookbook: CookbookHealth { status, hardware, downloadedModelCount, downloadedModels[],
                             fitWarnings[], detail, hint? }
  generatedAt, platform
}
```

### Subsystem fields

- **Ollama** — resolved base URL (`settings.ollama.baseUrl` / `OLLAMA_URL_BASE`
  via `getOllamaBase()`), reachability + installed models (count + names +
  tools/vision/thinking capability hints) from the existing `probeOllama()`, and
  the daemon `version` from a cheap `/api/version` GET.
- **llama.cpp** — `llama-server` binary path (`which`), registered loadouts from
  `readCatalog()` (alias + GGUF basename), the lifecycle-manager snapshot
  (`llamacppManager.getStatus()`: state / alias / port / pid / loadedAt /
  lastUsedAt / error), **last launch args**, **last stderr tail**, and the
  reachable-port probe.
  - **Last launch args** are retained *in-process* by the manager: a new additive
    `lastLaunchArgs?: string[]` field on `LlamacppManagerStatus`, captured on the
    existing `doLoad()` spawn path. It is **read-only forensics** — nothing in
    spawn/keepalive/reap reads it back. Chosen over re-deriving from the log
    because the argv is already computed at the one spawn site.
  - **Last stderr** is the tail (~40 lines, last 64 KB) of the existing
    `~/.archon/llamacpp.log` — the manager already pipes child stdout/stderr
    there. Reading the log tail is strictly less invasive than buffering stderr
    in-process, so per the spec's "prefer the least invasive option" we read the
    log (no lifecycle change for stderr at all).
- **Cookbook** — the detected `HardwareProfile` from `probeHardware()` (backend /
  VRAM / RAM / cores / GPUs), GGUFs downloaded under `~/.archon/models`
  (`modelsDir()`), and **fit-score mismatch warnings**: each registered llama.cpp
  loadout is scored against the detected hardware with the **same pure
  `scoreFit()`** the Cookbook catalog uses (no new fit logic) — a `NO` verdict
  (won't fit on GPU at a useful context → CPU offload) or a `TIGHT` verdict
  surfaces as an actionable warning. The `ModelSpec` per loadout is derived from
  the GGUF basename (`parseParams` + a local quant/arch parse).

### Running the smoke

```
npm run dev          # in one shell
npm run smoke:model-health
```

Asserts: 200; all three subsystems present with valid roll-up statuses; Ollama
reports its model count; llama.cpp reports its registered-model count + a valid
manager state; Cookbook reports the hardware profile (backend + VRAM); and a
degraded subsystem surfaces `warn`/`skipped`, not `error` (the only legitimate
`error` being a real llama.cpp last-launch failure).

## Adding a new check

1. Write a `check…(): Promise<DiagnosticCheck>` in `checks.ts` returning
   `mk(id, group, label, status, detail, hint?)`. **Reuse an existing probe
   helper** rather than shelling out fresh; if you must shell out, use
   `execFile` with an argv array + timeout and resolve the missing-binary path
   to a benign value (see `onPath` / `probeVersion`). Don't throw for an
   expected-missing dependency — return `warn`/`skipped`.
2. Add it to the matching `GROUPS[].probes` entry (the `id`/`label` there must
   match what the function returns).
3. Bump the smoke's count assertion if the registry grew, and add a row to the
   relevant group table above.

The `safeProbe` wrapper guarantees a thrown probe degrades to an `error`
result, so a new check can't take down the endpoint — but a clean `warn`/
`skipped`/`error` return is always better than a throw.
