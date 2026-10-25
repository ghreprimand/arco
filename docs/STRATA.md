# Strata and large MoE models

Reference for the Arco integration with a separately installed Strata HTTP
service. Arco does not bundle Strata or model weights. The provider registry
and runtime profiles are configurable per installation; model availability,
resource needs, and performance depend on the selected engine and host.

Installed engine versions appear in Providers when the information is available.
Discovery reads metadata without starting a model. Capability probes can report
version changes to connected clients. See [PROVIDERS.md](PROVIDERS.md#strata)
for provider internals and the settings reference.

## Use it in Arco

1. Enable **STRATA** in Settings and keep **STRATA ENDPOINT** at
   `http://127.0.0.1:8081/v1`. Settings override `STRATA_URL_BASE`; a missing `/v1`
   suffix is added automatically. Strata is separate from Ollama and LM Studio.
2. Choose a prepared model in the creator. In an existing Agent tab, click the
   composer model chip or use CONFIG -> MODEL. In saved Chat, use the model dropdown.
3. Send a message. Selection applies to that next message and keeps the
   conversation. Loading can take tens of seconds; switch/ready notices appear
   in the transcript. The dropdown alone does not start inference.
4. Use Agent for project tools. In saved Chat, arm **WEB** for WebSearch/WebFetch;
   those are the only Chat tools. Attach an image to ask a vision question.
5. To release model memory, finish or cancel active local turns/reviewers, then
   select **FREE VRAM** in the header. The next request reloads the selected model.

The following public model IDs illustrate profile naming; available choices come from configured Strata profiles:

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

## Engine and component updates

Strata may publish separately versioned app, terminal, and engine components.
Arco displays engine metadata from the installed component and can link to
upstream release information. A new app release does not necessarily mean that
an engine update is available. Updating the runtime, model assets, profiles,
and Arco are separate operations. Use the runtime's own signed update and
rollback procedures; Arco does not install engine updates.

## What the MoE setup puts in each memory tier

Mixture of experts (MoE) means each token uses a selected subset of routed expert
weights. The full model can exceed GPU memory because Strata distributes its
components across the GPU, host RAM and storage. Sparse activation reduces
computation; the rest of the weights still need storage and an access path.
The memory layout matters more than the GGUF download total alone.

| Component | Typical placement | Consequence |
| --- | --- | --- |
| Dense computation and hot routed experts | GPU, with hybrid CPU/GPU execution | Leave room for desktop and compute buffers. More GPU cache can reduce transfers. |
| Host expert complement/cache | Host RAM and model files | A smaller RAM budget can increase SSD reads, especially on cold prefill. |
| PLE / n-gram lookup table | Model asset storage, optionally read directly by the engine | This learned lookup table is separate from conversation history and expert caching. |
| Conversation KV cache | Host-backed or GPU-resident, depending on engine configuration | GPU residency is a working set; it does not extend or truncate the model context. |
| MTP draft component | Optional engine assets, runtime-managed allocations | Drafts propose tokens that the target verifies; MTP is not a second selectable model. |
| Image encoder | CPU or GPU component, depending on profile | Image work adds host memory/latency without using a GPU encoder. |

These are different optimizations: moving unchanged data to another tier does
not change its precision; quantization does. The installed IQ3_XXS weights and
INT8 KV are precision choices. Abliteration changes model behavior. No claim
of equivalence to full precision or of universally best quality follows from a
successful load. See the pinned [Strata architecture](https://github.com/Niko1221/Strata/blob/296b59d2f73c8f04a805df29c2fa97655adace78/docs/HOW_IT_WORKS.md)
and [memory/format guide](https://github.com/Niko1221/Strata/blob/296b59d2f73c8f04a805df29c2fa97655adace78/docs/MODELS.md).

## RAM, VRAM and context limits

## RAM, VRAM and context limits

Resource limits are profile- and host-specific. Installed RAM and VRAM are not
fully available to a model service; the desktop, other processes, caches, KV
storage, and image encoders also consume memory. Measure available headroom
before changing a profile.

| Setting | Purpose |
| --- | --- |
| `MemoryHigh`, `MemoryMax`, `MemorySwapMax` | Operating-system service limits; account for the full process and file-cache footprint. |
| `--memory-limit-mib`, `STRATA_MEMORY_LIMIT_MIB` | Engine memory ceiling; keep aligned with the service limit. |
| `--resident-budget-gib`, `STRATA_RESIDENT_HEADROOM_GIB` | Bound host memory used by resident experts. |
| `--vram-reserve-mib` | Reserve GPU memory for the desktop and other applications. |
| `--max-context` | Model context window; use only a value supported by the prepared model. |
| `--kv-resident` | GPU-resident KV working set; this does not change model context. |
| `--conversation-cache-mib` | Optional budget for cached conversations. |
| Parallel requests | Number of requests served at once; a single request reduces resource contention. |

The host expert budget is not total process use. KV, dense staging, encoders,
runtime overhead, and charged file cache share the service limit. Increasing
context, expert cache, or encoder budgets can increase memory use; change one
limit at a time and verify headroom before restarting the service.

Arco's process-tree memory guards are separate from an independently started
Strata HTTP service. Raising an Arco limit does not change the Strata service's
operating-system limits. The managed launcher performs preflight checks for
available memory, competing model services, and port ownership. It refuses a
switch when the target cannot be started safely; it does not stop other local
workloads automatically.

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

Vision encoding can run on CPU or GPU depending on the prepared profile. CPU encoding reduces GPU use but may add latency and host-memory pressure. Check the selected profile and live capability report before changing encoder settings; restart the service through its guarded controls.

Strata is unavailable in **Incognito** because its standalone service writes
request logs and image caches. It is also outside the cluster-member fence.
Saved Arco conversations retain normal metadata/events. FREE VRAM unloads
model allocations without deleting GGUFs, saved conversations or disk caches.

## Model assets and engine configuration

Strata, model weights, native packs, tokenizers, MTP components, and vision
assets are installed separately from Arco and are not redistributed by Arco.
Keep model assets in user-managed storage and follow the upstream project's
integrity and license guidance. Do not copy absolute paths from one host to
another. Arco stores its provider profile registry under the Arco home by
default and accepts `ARCO_STRATA_PROFILES` to select another registry path.

Profiles must identify the exact model served by the endpoint, its configuration,
and any required vision assets. The engine's `BUILD.json`, profile metadata,
and live `/status` response describe different layers; inspect all three when
troubleshooting a mismatch. Arco discovers capabilities from live metadata or
from a validated registered profile while the service is stopped. A profile
label alone does not enable vision or prove that a model is loaded.

## Register another prepared profile

The registry at `~/.arco/strata-profiles.json` can be moved with
`ARCO_STRATA_PROFILES`. It lists the loopback endpoint, a profile ID, model ID,
display label, service identifier, and model configuration path. IDs and model
IDs must be unique, and the configuration's model name must match the registry.
The runtime launcher, tokenizer, model assets, and optional vision files must
exist before registration. Arco checks metadata and endpoint identity, but those
checks do not replace the runtime's own asset verification.

Use a loopback HTTP endpoint for managed local profiles. Remote or unmanaged
endpoints use ordinary HTTP discovery and inference; Arco does not control their
services. Registering a profile does not resize the runtime. During a managed
switch Arco refuses active local work, checks the service state, starts the
selected profile, and verifies the served model identity. On failure it reports
whether the previous profile was restored. A previous unloaded profile remains
unloaded. Keep profiles separate when their model formats or engine arguments
differ.

## Inspect, recover and return to Ollama

Use the configured endpoint's read-only `/v1/models`, `/v1/status`, and health
routes. Inspect the service manager's status, memory limits, and recent logs.
The configured service and model profile determine the commands and paths.

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

To return to another local provider, finish or cancel active local work and use
FREE VRAM before selecting that provider. Stop the Strata service through its
configured service manager if additional host resources are needed. Arco leaves
existing provider models and conversation state intact.

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

Live acceptance requires the intended Strata runtime, model assets, and target
hardware. Unit and smoke tests use isolated homes and fake runtimes; they do not
validate a full 262K prompt, worst-case image batches, or peak memory on a user's
machine. Short-token rates are not sustained-throughput guarantees. Do not
assume a prepared profile's memory limits or encoder settings fit another host.
