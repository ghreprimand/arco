# Strata and large MoE models

Operator runbook for the Arco integration and the operator's prepared Qwen3.8 Flash
Next installation. Configuration snapshot: **2026-10-15**. Values below describe
this installation, not requirements for every Strata host. Provider internals
are in [PROVIDERS.md § Strata](PROVIDERS.md#strata); start with this page for
model selection, memory, assets, troubleshooting and validation.

Installed engine versions in PROVIDERS refresh when the popover opens, including
updates made outside Arco. For a managed local profile the full package version
comes from `BUILD.json`; the live server can report a shorter build version.
Discovery reads metadata without starting a model. The periodic capability probe
also broadcasts Strata and Xolotl version changes to connected clients.

The engine is registered with Strata's signed component updater. Existing profile
paths stay stable through `<strata-checkout>/engine`, a link to the selected
package in `~/.local/share/strata/components/engine/`. Use
`python3 <local-llm-tools>/scripts/strata-trial.py update-check` to inspect
updates, `update` to apply one, and `rollback` to return to a retained previous
component. Updates run under the same memory caps as serving and refuse mining
or competing inference; they do not stop those workloads. The guarded launcher
keeps the engine link aligned with the component manager. This updates the
engine; the source checkout and Python environment are maintained separately.

## Use it in Arco

1. Enable **STRATA** in Settings and keep **STRATA ENDPOINT** at
   `http://127.0.0.1:8081/v1`. Settings override `STRATA_URL_BASE`; a missing `/v1`
   suffix is added automatically. Strata is separate from Ollama and LM Studio.
2. Choose a prepared model in the creator. In an existing Agent tab, click the
   composer model chip or use CONFIG → MODEL. In saved Chat, use the model dropdown.
3. Send a message. Selection applies to that next message and keeps the
   conversation. Loading can take tens of seconds; switch/ready notices appear
   in the transcript. The dropdown alone does not start inference.
4. Use Agent for project tools. In saved Chat, arm **WEB** for WebSearch/WebFetch;
   those are the only Chat tools. Attach an image to ask a vision question.
5. To release model memory, finish or cancel active local turns/reviewers, then
   click the header **FREE VRAM**. The next request reloads the selected model.

The configured choices are:

| Picker label | Exact model ID | Service profile |
| --- | --- | --- |
| Qwen3.8 Flash Next · Original · 262K | `qwen3.8-flash-next-iq3_xxs-262k` | `262k` |
| Qwen3.8 Flash Next · SC117 Abliterated · 262K | `qwen3.8-flash-next-sc117-abliterated-iq3_xxs-262k` | `sc117-262k` |

Both use IQ3_XXS, 262144 configured tokens and CPU vision. A separate original
`128k` service profile exists for manual comparisons; it is text-only and is not
registered in Arco's two-model picker. **262K** is the display label for
262144 tokens; some capability badges use **256k** (262144 ÷ 1024).

One Strata profile is resident at a time. Arco serializes entire Strata turns,
including tool round trips, even when `ARCO_LOCAL_PROVIDER_SERIAL_QUEUE=0`.
Alternating tabs with different selections reloads their respective weights.
Conversation history survives; the old engine's warm caches do not. This is not
simultaneous residency or automatic model routing.

## Upstream 0.2 beta: app, Terminal and engine

The [0.2.0-beta release](https://github.com/Niko1221/Strata/releases/tag/v0.2.0-beta)
splits the desktop app, Terminal/Control and engine packages into separately
versioned components. Its engine package is **0.1.45.3**; **0.2.0-beta** identifies
the broader application release. The signed component feed supports verified,
staged engine updates and rollback. The [updater contract](https://github.com/Niko1221/Strata/blob/v0.2.0-beta/packaging/UPDATES.md)
describes the separate component versions and explicit update steps.

Arco's integration continues to use the HTTP engine endpoint and guarded user
services. Its version row compares installed **engine** metadata with upstream
engine package metadata, using release-note/legacy-tag fallbacks if the feed is
unavailable. It opens release history inside Arco, like Ollama; GitHub is an
explicit external link. A new app tag alone is not reported as an engine update.

This workstation remains on engine **0.1.44.1**. No Strata engine, app, model or
service configuration was upgraded in the version-view change. Before adopting
0.2's packaging or defaults, check the existing native packs, prepared profile
flags, 32/36 GiB service limits and explicit CPU vision configuration. Upstream
also changes runtime defaults and memory/I/O behavior; repeat actual model,
tool/vision and resource tests for this installation instead of assuming the
release's results on other configurations apply to it.

## What the MoE setup puts in each memory tier

Mixture of experts (MoE) means each token uses a selected subset of routed expert
weights. The full model can exceed GPU memory because Strata distributes its
components across the GPU, host RAM and storage. Sparse activation reduces
computation; the rest of the weights still need storage and an access path.
The memory layout matters more than the GGUF download total alone.

| Component | This installation | Consequence |
| --- | --- | --- |
| Dense computation and hot routed experts | GPU, with hybrid CPU/GPU expert execution | Leave room for desktop and compute buffers. More GPU cache can reduce transfers. |
| Host expert complement/cache | Bounded RAM budget; remaining expert weights read from model files | A smaller RAM budget can increase SSD reads, especially on cold prefill. |
| PLE / n-gram lookup table | Second GGUF shard on NVMe, `--ple-io direct` | This learned lookup table is separate from conversation history and expert caching. |
| Conversation KV cache | INT8 host-backed storage, 32768 cells resident on GPU | GPU residency is a working set; it does not truncate the 262144-token context to 32K. |
| MTP draft component | Prepared stock MTP assets, runtime-managed allocations | Drafts propose tokens that the target verifies; MTP is not a second selectable model. |
| Image encoder | Separate CPU executable, 8 threads, 1024 image-token cap | Image work adds host memory/latency without using a GPU encoder. |

These are different optimizations: moving unchanged data to another tier does
not change its precision; quantization does. The installed IQ3_XXS weights and
INT8 KV are precision choices. Abliteration changes model behavior. No claim
of equivalence to full precision or of universally best quality follows from a
successful load. See the pinned [Strata architecture](https://github.com/Niko1221/Strata/blob/296b59d2f73c8f04a805df29c2fa97655adace78/docs/HOW_IT_WORKS.md)
and [memory/format guide](https://github.com/Niko1221/Strata/blob/296b59d2f73c8f04a805df29c2fa97655adace78/docs/MODELS.md).

## RAM, VRAM and context limits

The workstation has 96 GB installed RAM (about 93.8 GiB usable) and an RTX 5090
reporting 32607 MiB VRAM. Installed capacity is not the amount available after
the desktop, VMs, other services and caches. Measure headroom before tuning.

| Limit / setting | Current value | What it controls |
| --- | --- | --- |
| `MemoryHigh` | `32G` = 32 GiB | systemd memory-pressure/throttling threshold for the entire Strata service cgroup |
| `MemoryMax` | `36G` = 36 GiB | Hard cgroup ceiling, including children and charged file cache; crossing it can OOM-kill the service |
| `MemorySwapMax` | `0` | Strata's cgroup cannot expand into swap |
| `--memory-limit-mib` and `STRATA_MEMORY_LIMIT_MIB` | `36864` | Engine's declared RAM ceiling; keep aligned with the service hard limit |
| `--resident-budget-gib` | `24` | Host expert budget, not total service memory; runtime can choose a smaller complement |
| `STRATA_RESIDENT_HEADROOM_GIB` | `12` | Headroom used by the resident-budget selection logic |
| `--vram-reserve-mib` | `2048` | GPU reserve requested from the engine for desktop headroom |
| `--max-context` | `262144` | Native/configured conversation token window for both registered profiles |
| `--kv-resident` | `32768` | GPU-resident KV working set, not the conversation limit |
| `--conversation-cache-mib` | `0` | No extra parked-conversation cache budget |
| Parallel requests | `1` | One serving request per engine |

**How large can RAM use grow?** With these settings the service is capped at
36 GiB, regardless of the machine's 96 GB. The 24 GiB expert budget does not mean
24 GiB total use: KV, dense staging, encoder, runtime overhead and charged file
cache share the cgroup. An accepted SC117 run selected a 17.77 GiB host expert
complement; that observation is not a fixed allocation or a worst-case peak.

A larger expert cache or higher-precision quant may use more host RAM if you
explicitly increase the corresponding budgets and service limits. There is no
single useful maximum based on installed RAM alone. Budget for the rest of the
machine, KV, image encoding, runtime overhead and GPU residency. Do not allocate
the whole machine to the expert cache. No limits were raised for this integration.

Arco's own Node/worker memory guards are separate. `ARCO_RSS_KILL_BYTES`
controls Arco-managed process-tree workers; Strata is an independently started
HTTP service, outside that tree. Raising Arco's limit does not lift Strata's
systemd ceiling. Changing limits requires coordinated edits to the unit/drop-in
and profile engine limit, fresh headroom checks, then a guarded Strata restart
between turns. Validate one change at a time; this page is not a tuning preset.

The launcher requires at least **32 GiB available RAM**, **20 GiB free VRAM**, no
recognized miner, no loaded model in local Ollama, no competing Strata profile
and a free port 8081 before a full start. `check-switch` tests miner/Ollama and
prepared config/engine before stopping the old service; the target repeats the
complete preflight after the old service stops. It never stops mining or unloads
Ollama automatically.

## Context, tool-result sizes and speed

The following bounds are independent:

- **262144 tokens** is the configured model window. The CTX meter uses discovered
  `meta.n_ctx` and engine prompt usage; image tokens and instructions also use context.
- **32768 resident KV cells** bounds GPU residency. Older history remains in the
  host-backed cache; changing this number does not extend native context.
- **Read: 32K; other tool results: 64K** are Arco's shared per-result text caps.
  They are character/string-length bounds in the local tool runtime, despite
  notices referring to bytes. Multibyte text can have a different byte count.
  They are not a 64K-token model limit. Strata skips LM Studio's additional
  6K/200-line compacting pass. If a result is trimmed, ask for a narrower file
  range, query or section; increasing model context alone does not lift that cap.
- **1024 image tokens** is the prepared encoder cap, not a claim of unlimited
  image detail or batch support. Vision/OCR can still make recognition mistakes.

After a completed turn the composer shows **tok/s** for decode and **PP** for
fresh prompt prefill, when engine timings are present. Hover for token counts
and durations. Rates sum engine tokens/time across tool rounds; cached prompt
prefix is excluded from fresh prefill. Loading, tool/web/network time is not
included, so these rates are not end-to-end task speed. No timing means no
readout; it is not synthesized from browser elapsed time.

Effort is **none / low / medium / high**. None disables reasoning; high maps to
Qwen's xhigh inside Strata. Arco forwards these native Strata levels rather
than applying Ollama's low-means-off convention. Effort changes apply to the
next message. More reasoning can lengthen a task even at the same decode rate.

## Web, images and privacy

Agent uses Arco's local tool runtime, including SearXNG-backed **WebSearch**
and **WebFetch**, subject to AUTO/SAFE and primitive allowlists. Search defaults
to `ARCO_SEARXNG_URL=http://127.0.0.1:8888`. WebFetch uses the shared fetch
implementation/fallbacks. These tools run in Arco; the inference engine does
not need built-in web browsing.

Saved Chat's **WEB** switch defaults on and exposes/dispatches only those two
tools. Turning it off removes tools for the next message. Chat never acquires
filesystem, shell, project skills or MCP access through Strata. A successful
search has an actual completed tool result; a URL written from memory is not
proof of browsing. Local inference still sends web queries to the search stack.

Both registered profiles have `--vision` and readable matching encoder/projector
assets. Arco sends image data URLs. Runtime `/v1/models` image modalities
are authoritative for the served profile; prepared inactive profiles derive
capabilities from their checked config/files. Model names alone never enable vision.

CPU vision was chosen after observing about **1.7 GiB free VRAM** and **36 GiB
available RAM** at initial setup, with the service near its 32 GiB soft limit.
The GPU encoder would consume additional scarce VRAM beside the 2048 MiB reserve.
Those are historical measurements, not current reservations. Both configs use
`gpu:false`, `threads:8`, `max_tokens:1024`; changing to GPU encoding needs a new
headroom assessment and a guarded restart, not just an Arco badge change.

Strata is unavailable in **Incognito** because its standalone service writes
request logs and image caches. It is also outside the cluster-member fence.
Saved Arco conversations retain normal metadata/events. FREE VRAM unloads
model allocations without deleting GGUFs, saved conversations or disk caches.

## Files and provenance on this workstation

| Asset | Location |
| --- | --- |
| Runtime and private Python | `<strata-checkout>/`, `.venv/bin/python` |
| Engine | `<strata-checkout>/engine/strata` |
| CPU image encoder | `<strata-checkout>/build-vision-cpu/bin/strata-vision` |
| Original GGUFs | `<strata-data>/models/iq3_xxs/` |
| SC117 GGUFs | `<strata-data>/models/sc117-iq3_xxs/` |
| Native packs/tokenizers | `<strata-data>/packs/iq3_xxs/`, `packs/sc117-iq3_xxs/` |
| Stock MTP assets | `<strata-data>/mtp/rt/` |
| Shared projector | `models/iq3_xxs/mmproj-Qwen3.8-Flash-Next-BF16.gguf` under the data root |
| Profiles | `<strata-data>/config/iq3_xxs-{262k,sc117-262k}.json` |
| Guarded launcher | `<local-llm-tools>/scripts/strata-trial.py` |
| User service template | `~/.config/systemd/user/strata-flash-next@.service` |
| Arco profile registry | `~/.arco/strata-profiles.json` |
| Runtime logs | `<strata-data>/logs/` and the user journal |

Installed engine: **0.1.44.1**, source commit
`296b59d2f73c8f04a805df29c2fa97655adace78`. Provenance:

| Weights | Repository | Pinned revision |
| --- | --- | --- |
| Original GSQ-RCO IQ3_XXS | [ISTA-DASLab](https://huggingface.co/ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF) | `ed59f92082b1e93c0e96d60a8b11aab089b52f09` |
| Abliterated GSQ-RCO IQ3_XXS | [SC117](https://huggingface.co/SC117/Qwen3.8-Flash-Next-GSQ-RCO-abliterated-GGUF) | `eec4e10a2c29b440a2ae85591fa11569ce752963` |

SC117 was selected for compatibility with the calibrated GSQ-RCO layout and
current memory budget, not as a measured universal quality winner. There is no
reliable record of whether Blackfrost or OrcaRouter won the earlier **27B**
comparison. That comparison does not establish a Flash Next winner.

The abliterated first shard is 47342144896 bytes, SHA256
`03b11926b41a3d7f7a008882b1bc7a6330a3c9c43d3cad4598d31dc73042fdc5`.
Its second shard is 28800138432 bytes, SHA256
`316b46f3a2dbd68c900f43136ab9449f9dcc3725dfd8c794847c204bc161e113`;
it is byte-identical to and hardlinked with the original PLE shard. Both hashes
were checked in full. Shared files mean logical download totals differ from
physical additional disk use. Keep space for native packs, conversion/temp files,
MTP, projector and logs as well as GGUFs.

The original first shard is 47039860096 bytes, SHA256
`219ea929900dfa9ef091f3aa473fdba6874b65fcb36526d7d851ac9e95856d15`.
The shared BF16 projector is 907543008 bytes, SHA256
`b1a82259702816a5330d7bd7607cd9676b11780e79ff7348c21103ff3ce49bd0`.

Each model has its **own native pack**: never reuse original offsets for modified
weights. SC117's trusted local packing produced 1079 indexed tensors, 302 native
and a 1.43 GiB dense arena; `--compat-bf16` converted zero tensors. Stock MTP and
the BF16 projector are shared; MTP itself is not abliterated. CPU vision's model
path points to the selected model's first shard. Records live in
`models/iq3_xxs/download-manifest.json`, verified markers,
`models/sc117-iq3_xxs/preparation.json`, pack metadata and `engine/BUILD.json`.
Back these up with the registry, profile JSONs, service unit and launcher. `/tmp`
acceptance evidence is temporary, not durable backup.

## Prepared engine and encoder configuration

The CUDA engine was built in the private Strata environment for the 5090
(SM 120), using private CUDA 13.4.92 wheels. The system driver was not replaced.
`engine/BUILD.json` records the engine build; its `vision: none` describes that
build's bundled encoder state, not the separate CPU encoder subsequently added.
Check live `/status.vision` and the profile's `vision` object for actual support.
Keep the source/submodule revisions and Python lockfile with build records.

Both registered profiles have these common arguments (model-specific absolute
paths differ as listed above):

```text
--pack <own-native-pack> --native <own-first-GGUF> --ple-gguf <own-second-GGUF>
--expert-profile <strata-checkout>/data/expert-profile.bin
--expert-cache auto --prefill auto --spec 4 --spec-min-p 0.5
--mtp <strata-data>/mtp/rt
--max-context 262144 --kv int8 --kv-resident 32768 --vram-reserve-mib 2048
--resident-budget-gib 24 --ple-io direct --pool-workers 8
--conversation-cache-mib 0 --memory-limit-mib 36864 --vision
```

Common environment: `STRATA_ROUTE_TAIL_SKIP=0` (expert contribution skipping
disabled), `STRATA_RESIDENT_HEADROOM_GIB=12`,
`STRATA_MEMORY_LIMIT_MIB=36864`. Experimental speed projection is off. Profile
JSON sets `parallel:1`, host `127.0.0.1`, port `8081`, GPU index `0`,
`open_browser:false`, and a default `reasoning_effort:high`; Arco sends the
tab's chosen effort per request. Profile `exe`, `tokenizer`, `log`, library
paths and the `vision` section must remain valid absolute paths.

The CPU encoder can be rebuilt from the prepared/pinned Strata checkout without
loading a model (native CPU build, not a portable artifact):

```bash
cd <strata-checkout>
cmake -S tools/vision -B build-vision-cpu -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DLLAMA_DIR=<strata-checkout>/third_party/llama.cpp \
  -DSTRATA_VISION_CUDA=OFF -DSTRATA_PORTABLE=OFF
cmake --build build-vision-cpu --target strata-vision --parallel 8
```

The profile's `vision` object points `exe` at that build's `bin/strata-vision`,
`mmproj` at the verified stock projector, `model` at its own first GGUF, and sets
`gpu:false`, `threads:8`, `max_tokens:1024`. The original pre-vision backup is
`config/iq3_xxs-262k.before-arco-vision.json`. Restoring it affects Original
only and needs a guarded restart plus fresh capability discovery. Do not point
SC117 at Original's weights or reuse an old pack to undo an encoder change.

The service template runs the launcher's full `check %i` before `serve %i`,
uses `KillMode=control-group`, `TimeoutStartSec=900`, `TimeoutStopSec=90`,
`LimitMEMLOCK=infinity`, `Nice=5`, `IOWeight=25`, and `Restart=no`, beside the
32/36 GiB memory limits. `serve` requires a systemd invocation so direct Python
startup cannot bypass its cgroup. Arco's switch has its own readiness timeout;
the unit's longer startup allowance does not make Arco wait indefinitely.

## Register another prepared profile

This is an operator-managed local catalog, not an automatic downloader or a
Cookbook/Ollama import. Prepare and verify the weights, matching native pack,
tokenizer, encoder assets and memory-limited user unit before registration.
The launcher must accept that profile ID for `check-switch`, `check` and `serve`.
Preserve the existing profiles. The working registry is:

```json
{
  "baseUrl": "http://127.0.0.1:8081/v1",
  "launcher": {
    "python": "<strata-checkout>/.venv/bin/python",
    "script": "<local-llm-tools>/scripts/strata-trial.py"
  },
  "profiles": [
    {
      "id": "262k",
      "model": "qwen3.8-flash-next-iq3_xxs-262k",
      "label": "Qwen3.8 Flash Next · Original · 262K",
      "unit": "strata-flash-next@262k.service",
      "config": "<strata-data>/config/iq3_xxs-262k.json"
    },
    {
      "id": "sc117-262k",
      "model": "qwen3.8-flash-next-sc117-abliterated-iq3_xxs-262k",
      "label": "Qwen3.8 Flash Next · SC117 Abliterated · 262K",
      "unit": "strata-flash-next@sc117-262k.service",
      "config": "<strata-data>/config/iq3_xxs-sc117-262k.json"
    }
  ]
}
```

Use `ARCO_STRATA_PROFILES` to override the registry path. Managed endpoints
must be loopback HTTP and match `baseUrl` exactly after Arco's endpoint
normalization. IDs/models/units must be unique; `config.model_name` must match
`model`. Registry/config/asset paths are local to the Arco server host. File
existence checks do not replace model hash or compatibility verification.

Arco merges this catalog with live discovery and includes prepared profiles
while the service is stopped/unloaded. An available registered profile does not
prove an engine is currently loaded. Remote/unregistered endpoints use normal
HTTP discovery/inference; Arco does not control their services. Configuring an
endpoint or registering a profile never resizes it.

A different model starts only after Arco owns the serial turn slot and local
operation guard. Other active local providers/reviewers or an external Strata
request cause a refusal. Arco checks registered unit states and served identity,
runs preflight, stops the old unit, starts the target and verifies its model ID
and loaded state (up to 180 seconds for readiness). Failure/cancel attempts to
restore the previous profile and its prior unloaded state. A rollback failure
is reported; consult the journal. New local turns and FREE VRAM are refused
while switching/rollback holds the guard. Cloud turns are independent.

## Inspect, recover and return to Ollama

Read-only checks (substitute `sc117-262k` to inspect that profile):

```bash
curl --fail --max-time 10 http://127.0.0.1:8081/v1/models
curl --fail --max-time 10 http://127.0.0.1:8081/v1/status
systemctl --user status strata-flash-next@262k.service --no-pager
systemctl --user show strata-flash-next@262k.service \
  -p MemoryCurrent -p MemoryPeak -p MemoryHigh -p MemoryMax -p MemorySwapMax
journalctl --user -u strata-flash-next@262k.service -n 80 --no-pager
python3 <local-llm-tools>/scripts/strata-trial.py status
free -h
nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader,nounits
```

| Symptom | What to check / do |
| --- | --- |
| Only one model appears | Confirm the local registry path/base URL and both prepared config/asset sets. `/models` alone normally describes the one served profile. Refresh provider discovery/reload the browser. |
| Model selectable, engine unloaded | Normal after FREE VRAM. Send a message; the engine reloads on demand. |
| Service stopped | Prepared registered profiles can start on the next turn. For HTTP-only setups, start the service manually. |
| Switch refused as busy | Finish or cancel local turns/reviewers or external Strata requests; retry. Nothing is automatically cancelled. |
| Preflight refused | Resolve the named miner/Ollama/RAM/VRAM/port/peer conflict. Do not bypass the guarded launcher or start a second large model beside it. |
| Wrong/unready endpoint or unmanaged service | Inspect `/status`, active units and registry. Arco refuses to stop a service whose identity it cannot verify. |
| Failed load / restored previous profile | Read target journal and memory counters before retrying. Rollback may itself fail if headroom changed. |
| No vision badge / rejected image | Check `--vision`, encoder/projector/model paths and live image modalities. Restart Strata between turns after changing encoder config. |
| Search errors / no real search | Check SearXNG at port 8888, Chat WEB state and actual completed tool results. A model can still answer without using a tool. |
| Trimmed tool result | Request narrower ranges/sections. The shared text cap is independent of the model token window. |
| High memory / slow cold prompt | Inspect cgroup pressure, available RAM, NVMe reads and fresh prefill, not just decode tok/s. Avoid raising context/cache/encoder budgets together. |
| Newer Strata version | PROVIDERS refreshes the prepared engine's `BUILD.json` when opened, falling back to `/v1/status.engine` for unmanaged endpoints. Upstream engine package versions refresh at boot/every four hours; click opens in-app release notes. It does not install an engine update. |

FREE VRAM targets loopback Ollama, Strata, Arco-managed llama.cpp and LM Studio
LLMs (even hidden providers), skips remote endpoints and embedding instances,
and reports unloaded/idle/unavailable/failure per runtime. It refuses active
local primaries/reviewers and a concurrent profile switch. It is an immediate
action with a busy refusal, not a scheduled unload. It leaves the Strata Python
service up and lets subsequent requests reload it; it does not promise zero GPU
use from the desktop or other applications.

To return to an existing Ollama model, finish/cancel local work, use FREE VRAM
and choose an Ollama workflow. For maximum headroom or to resume mining, stop
the active Strata unit too, after local turns settle:

```bash
python3 <local-llm-tools>/scripts/strata-trial.py stop sc117-262k
```

Use `stop 262k` instead if Original is active. The guarded manual start is
`python3 <local-llm-tools>/scripts/strata-trial.py start 262k` (or
`start sc117-262k`); it refuses a running peer, so manually stop the old profile
first. Neither prepared service is enabled at login. Unload Ollama before
returning to Strata. Existing Ollama models/providers are preserved.

**Restart warning:** restarting a Strata unit interrupts its requests.
Restarting live **Arco** interrupts active workers across tabs. Announce it
and wait for work to settle before deploying. Repo Markdown needs no build;
in-app help changes require a client build and the normal deployment process.
Engine updates, profile changes and CPU/GPU encoder changes are separate from
an Arco application update.

## Verification and limits of the evidence

`npm run test:strata-provider`, `test:strata-profiles`, `test:local-model-unload`
and `test:strata-ui` cover transport, capabilities, tools/Chat boundaries,
refusal, rollback, cancel, rates and effort. `smoke:strata-profiles` boots a
throwaway server with fake runtimes/systemd control; it checks exact model
identity, serial turns, labels, context/vision and retained conversation.
`smoke:strata-controls` covers versions and unload through the actual routes.
`npm run test:help-docs` checks manual/help assembly and links.

Opt-in `smoke:strata-live` needs real Strata, SearXNG, `STRATA_SMOKE_IMAGE` and a
throwaway Arco (`ARCO_SMOKE_WS_URL`, optional `STRATA_SMOKE_MODEL` and
`STRATA_SMOKE_ARTIFACTS`). Isolate `os.homedir()` for that server, including PID
registries, persistence and workspace; changing only the port or `HOME` is
insufficient. Never point an auth-off smoke server at production state.

Accepted on 2026-10-14/15: real Chat search/fetch, Agent search, streaming
reasoning/tool round trips, image questions, native timings, and Original →
SC117 switching in one conversation with prior-message recall. Production
catalog and built browser selection were checked. Short decode observations
were roughly 56–113 tok/s, not sustained long-context throughput guarantees.
Full 262K prompt quality, worst-case image batches and worst-case RAM peaks
remain unvalidated. Temporary evidence directories:
`/tmp/arco-strata-acceptance/`, `/tmp/arco-strata-sc117-live/`, and
`/tmp/arco-strata-switch-live/`.

Machine preparation/history also lives in
`<local-llm-tools>/docs/usage/strata.md`; Arco's runbook and help are
self-contained so that external checkout is not required to understand the UI.

DeepSeek uses a separate Xolotl provider and guarded registry on port 8150;
see [DEEPSEEK.md](DEEPSEEK.md). Do not put its profiles in the Qwen registry.
