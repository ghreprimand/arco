# DeepSeek V4.1 Flash via Xolotl

Arco uses the already prepared Xolotl installation for DeepSeek V4.1 Flash
1017. It neither downloads weights nor imports the mixed two-bit quantization
into Ollama. Qwen/Strata remains on port 8081; DeepSeek has its own provider,
registry, guarded launcher and systemd services on port 8150. Existing provider
defaults are unchanged.

## Xolotl and DeepSeek are different things

Xolotl is the runtime, formerly named Strata-DSV4.1: an independently maintained
extended fork of Strata. DeepSeek V4.1 Flash is the model served by this
installation. The runtime distributes model data across GPU VRAM, pinned host
RAM and NVMe. Upstream supports other model families too; Arco's current
registry deliberately describes only the prepared DeepSeek Exact/Light pair.
Adding another family requires its own validated assets/configuration and
launcher support, not merely another name in the picker.

Upstream references at the installed revision:

- [Xolotl overview](https://github.com/Indras-Mirror/Xolotl/blob/c3324f8998040a9247d22137e9bfb3ff2c5da361/README.md)
- [Runtime architecture](https://github.com/Indras-Mirror/Xolotl/blob/c3324f8998040a9247d22137e9bfb3ff2c5da361/docs/xolotl/HOW_IT_WORKS.md)
- [DeepSeek engine](https://github.com/Indras-Mirror/Xolotl/blob/c3324f8998040a9247d22137e9bfb3ff2c5da361/docs/DEEPSEEK_V41.md)

Keep upstream benchmarks distinct from measurements of the operator's installed
quantization, routing, memory budget and GPU power limit. The pinned checkout
revision is source provenance; rebuild records establish binary provenance.

The saved provider key remains `deepseek` for compatibility with existing
workflows, settings and API routes; its user-facing provider name is Xolotl.

## Select, load and unload

Enable XOLOTL in Settings. The primary-agent selector reads
`XOLOTL — DeepSeek · Exact / Light`: runtime first, then the model family. Both registered profiles appear even when stopped.
Select a profile in the Agent creator, composer model picker, CONFIG, saved
Chat, or a primitive's RUN AS picker. Selection applies on the next message;
changing a dropdown alone does not load a model. Settings → XOLOTL · DEEPSEEK
also provides explicit LOAD EXACT, LOAD LIGHT, UNLOAD · STOP SERVICE, refresh,
and cancel-load controls. Failed operations show the guarded launcher's reason.

| Profile | Model ID | Unit | Meaning |
| --- | --- | --- | --- |
| Exact | `deepseek-v4.1-flash-1017-exact` | `deepseek-flash@exact.service` | Preserves expert routing |
| Light | `deepseek-v4.1-flash-1017-light` | `deepseek-flash@light.service` | Routing biases 0.25 / 0.15 favor cached experts and change expert selection |

Both use compressed weights; neither is equivalent to the full precision
checkpoint. Light's speed advantage in short local tests does not establish
equivalent answer quality. Runtime checkout: `<xolotl-checkout>`.
Data: `/mnt/Data/LLM/DeepSeek-V4.1-Flash-1017/`. API:
`http://127.0.0.1:8150/v1`; browser: `http://localhost:8150/`.

| Resource / capability | Prepared value |
| --- | --- |
| Context | 262,144 tokens including input, history, thinking and output |
| Reasoning | None / low / medium / high; default medium, 8,192 thinking tokens |
| Total output allowance | 16,384 tokens, including thinking |
| Host expert arena | 48 GiB; not the entire process/cgroup footprint |
| Service limits | MemoryHigh=60G, MemoryMax=64G, MemorySwapMax=0 |
| Modalities | Text, images and tools when vision is prepared; legacy text-only configs remain supported |
| Tools | Arco's normal bounded tool loop; restricted primitives keep their allowlist |
| JSON | Prompt and validate; no constrained-decoding guarantee |
| Idle unload | Five minutes; a service can remain active with its engine unloaded |

Only one profile can run because both share the endpoint. Whole DeepSeek turns,
including tool rounds, are serialized even if the optional local queue setting
is disabled. Alternating profiles retains Arco's conversation but loses the
old engine's warm cache. Fresh long prompts can take minutes; the transport
accepts the runtime's SSE heartbeats during prefill. Output and thinking share
the context and output limits.
Cancellation closes Arco’s request immediately, but the native engine may finish
its current prefill batch before becoming idle (about 15 seconds in one live
cancellation test). Loading/switching/unloading continues to refuse while that
request is settling; do not bypass the busy guard.

Saved Chat exposes only its armed WebSearch/WebFetch pair. Strict Incognito is
not offered: this standalone runtime is not proven diskless. Cluster membership
and Computer voice selection are not enabled for DeepSeek in this integration.
The existing Ollama and Qwen/Strata paths remain independent.

## Images and screenshots

Both installed profiles use the same DeepSeek encoder and a byte-preserving
BF16 companion GGUF repacked from the already verified `quant/vision.safetensors`.
The helper `<local-llm-tools>/scripts/prepare-deepseek-vision.py` prepares this companion
and two small reference Python sources pinned to the official model revision;
it never downloads model weights or starts inference. `vision-preparation.json`
records source/output SHA256, file size/mtime, and reference-code hashes. All 266
tensor payloads were compared byte for byte with the source.

The config's optional `vision` section names the encoder, its Python executable,
companion GGUF, matching text model and reference directory. The installed
encoder uses `/usr/bin/python3` and its existing PyTorch/NumPy/Pillow packages;
the server itself keeps using Xolotl's venv. It runs on CPU with eight threads,
up to 1024 image tokens, starts lazily on the first uncached image, and stops
60 seconds after its last image. This preserves GPU expert-cache space. Cold
image requests include encoder startup and image processing time. Images and
text share the same context allocation; image tokens are not a separate budget.
The 60G/64G service limits and 48 GiB expert arena remain enforced.

Attach images normally in Agent or saved Chat. Offline discovery advertises
vision only after the referenced assets exist. The worker refuses images for
text-only configs before starting a model, and readiness requires the live
service's vision flag to match the selected prepared profile. Missing or stale
vision preparation refuses startup; a dropdown label alone never enables it.
For dense screenshot text, use a focused crop rather than a whole desktop.

## Guards and service ownership

Arco never spawns the large engine itself. It invokes only the registered
guarded launcher, which delegates to the installed systemd units and preserves
their cgroup limits and control-group cleanup:

```bash
python3 <local-llm-tools>/scripts/deepseek-trial.py status
python3 <local-llm-tools>/scripts/deepseek-trial.py start exact
python3 <local-llm-tools>/scripts/deepseek-trial.py stop exact
```

Substitute `light` for the alternative. Do not call `serve`, invoke the engine,
or bypass the launcher. It verifies the Data mount, preparation/verification,
miners, competing loaded Ollama/Qwen models and available RAM/VRAM. It repeats
those guards when the engine reloads. **Stop mining yourself before loading;
Arco never stops the miner.** Unload competing models explicitly first.

Before switching Arco owns the shared local-operation guard, refuses active
other local turns/reviewers, checks the managed service states and endpoint
identity, refuses external in-flight/queued DeepSeek requests, and checks mining
before stopping the old service. The target's guarded start runs the full
resource check after the old allocations are released. Arco verifies exact
served identity and loaded state, with a 15-minute readiness limit. A load
failure or cancellation stops a partially started target and tries to restore
the previously loaded profile using the guarded launcher. A previously unloaded
profile stays stopped; a recovery failure is reported. The guard stays held
through cleanup/recovery. A cancelled startup command can take time to settle
before cleanup; refresh service status before retrying.

UNLOAD stops the active managed unit and confirms inactive state and loss of
the endpoint. Header FREE VRAM includes the same DeepSeek stop alongside the
other local runtimes, even if the provider is hidden. It refuses active local
work or a managed switch. An active service with unloaded engine is displayed
separately from loaded. Stop the service before resuming mining. No model files
are deleted; future requests start through the same guard.

## Prepared profile registration

The server reads `~/.archon/deepseek-profiles.json` (override with
`ARCHON_DEEPSEEK_PROFILES`). This is an operator-maintained registry, not a model
discovery command. Register both profiles only after preparation and testing:

```json
{
  "baseUrl": "http://127.0.0.1:8150/v1",
  "runtime": "<xolotl-checkout>",
  "launcher": {
    "python": "/usr/bin/python3",
    "script": "<local-llm-tools>/scripts/deepseek-trial.py"
  },
  "profiles": [
    {
      "id": "exact",
      "model": "deepseek-v4.1-flash-1017-exact",
      "label": "DeepSeek V4.1 Flash · Exact · Xolotl · 262K",
      "config": "/mnt/Data/LLM/DeepSeek-V4.1-Flash-1017/config/exact-256k.json"
    },
    {
      "id": "light",
      "model": "deepseek-v4.1-flash-1017-light",
      "label": "DeepSeek V4.1 Flash · Light · Xolotl · 262K",
      "config": "/mnt/Data/LLM/DeepSeek-V4.1-Flash-1017/config/light-256k.json"
    }
  ]
}
```

`settings.deepseek.baseUrl` overrides `DEEPSEEK_URL_BASE`, then the default above;
missing `/v1` is normalized. Managed operation requires a loopback HTTP endpoint
matching the registry. Config `cwd`/model/context/routing must match the registry;
the engine wrapper, tokenizer, GGUF, Engram directory and ranking must exist.
These metadata checks do not replace the launcher's verification. Never add
these profiles to `strata-profiles.json`: Qwen's `--max-context`, `--pack`,
`--native` and `--ple-gguf` schema is different from Xolotl's `--ctx`/Engram assets.

## Version tracking

PROVIDERS → STRATA reads the live engine version, falling back to the prepared
engine's adjacent `BUILD.json` while stopped. This fixes the stopped-service row
disappearing as “unknown.” Upstream engine versions come from the release's
component feed, with release-note/legacy-tag fallbacks. The 0.2 app version is
not an engine version. Both Strata and Xolotl version rows open themed history
inside Arco, like Ollama; GitHub is an explicit external link.

PROVIDERS → XOLOTL reads the registered checkout's Git HEAD without
running an engine. It compares with `Indras-Mirror/Xolotl` upstream HEAD at boot
and every four hours; yellow means different revisions, with a link to compare
source changes. The in-app view reads recent commits and compares only distinct
revisions; equal revisions display “UP TO DATE” without a self-comparison link.
This is source tracking, not a semver ordering or a claim that
the built engine matches checkout HEAD. Neither row installs updates, rebuilds,
changes profiles or loads weights. Preserve preparation/build records when
updating either runtime.

## Interactive performance measured on this workstation

During the operator's October 19 investigation, Exact used the CUDA backend,
about 27 GiB of GPU process memory, a 48 GiB pinned expert arena, and a 450 W
GPU power limit. Prompt processing reached 98–100% GPU utilization; generation
samples were commonly 23–43%, with substantial PCIe traffic and service I/O
pressure. The main GGUF alone is 148.1 GB (137.9 GiB), so it cannot reside in
32 GiB VRAM. Low compute utilization during expert transfers is not evidence
of a CPU-only fallback. The runtime reused the conversation prefix correctly.
MemoryHigh events occurred, but the sampled memory stall average was much
smaller than I/O stalls; these counters do not prove that raising limits helps.

A controlled short test used a fresh 617-token prompt, 128 output tokens per
turn, two cached follow-ups, temperature 0, thinking off, and the existing
transfer settings (0.75). These are individual samples, not broad benchmarks:

| Profile | Fresh prompt processing | Fresh generation | Cached generation | Cached wall time |
| --- | --- | --- | --- | --- |
| Exact | 5.75 s | 12.9 tokens/s | 17.9 / 18.1 tokens/s | 8.34 / 8.23 s |
| Light | 5.70 s | 20.2 tokens/s | 27.5 / 30.1 tokens/s | 5.75 / 5.12 s |

Light improves generation here; it still changes expert routing and does not
remove input-processing latency. Large tool results require another prefill,
and thinking also consumes generation time before a visible answer. Choose
Light and None thinking for the speed/quality tradeoff when appropriate;
Arco does not silently change existing selections or defaults.

Testing `STRATA_TIER_BATCH_PCIE=1.0` and separately `--pcie 1` produced only
small, inconclusive differences on Exact. The original defaults were restored.
No runtime rebuild, extra speculative weights, memory-limit increase or power
change was applied. See the retained [validation evidence](validation/deepseek-2026-10-19.json).

## Diagnostics and recovery

```bash
curl --fail http://127.0.0.1:8150/health
curl --fail http://127.0.0.1:8150/v1/models
curl --fail http://127.0.0.1:8150/v1/status
systemctl --user status deepseek-flash@exact.service --no-pager
systemctl --user show deepseek-flash@exact.service \
  -p MemoryCurrent -p MemoryHigh -p MemoryMax -p MemorySwapMax
journalctl --user -u deepseek-flash@exact.service -n 60 --no-pager
```

A stopped service has no endpoint; prepared profiles should still be listed.
For missing profiles inspect the registry, mount, config and assets. For a
guard refusal resolve the named mining/model/memory conflict. For a failed
switch read both service journals and refresh status; do not start a second
profile or raise limits to force a load. Runtime updates and Arco updates are
separate. Arco production deployment uses build, deploy preflight, and restart;
restart terminates active Arco turns and must wait for them to settle.

## Verification

`test:deepseek` covers registry validation, guarded lifecycle/refusals/recovery,
reasoning/tool streaming, context, cancellation, prepared image forwarding,
text-only fallback and Chat boundaries.
`smoke:deepseek` exercises the HTTP/WS integration against fake services without
loading weights or touching the operator's systemd units or workspace. Existing
Strata provider/profile/control and unload tests remain regression gates.
`smoke:deepseek-ui` checks actual browser version rows and lifecycle controls
against an isolated Vite fixture (`ARCHON_CLIENT_PORT=5197 ARCHON_PORT=6197
npm run dev:client`); every API and WebSocket is intercepted.
Live GPU acceptance must be coordinated with the operator and must release both
profiles afterward; it never stops a miner automatically.

`smoke:deepseek-live` requires `ARCHON_DEEPSEEK_LIVE=1` and an explicit
`ARCHON_SMOKE_WS_URL` for a throwaway Arco with an isolated `os.homedir()`
(see the preload in `scripts/smoke/deepseek.ts`). Point that server's
`ARCHON_DEEPSEEK_PROFILES` at the real prepared registry; keep its workspace/PID
stores isolated from production. The test exercises both profiles, actual Read
round trips, reasoning, native context accounting, streaming, cancellation and
guarded service release. Set `ARCHON_DEEPSEEK_VISION_IMAGE` to a screenshot
containing the numeric code `48263` to exercise real image OCR through Arco
on both profiles; the code must not appear in its filename or text prompt. It refuses to run without opt-in and requires both
profiles stopped initially. It never uses Ollama, downloads weights, stops a
miner, or overrides an external request's busy refusal. Inspect GPU/cgroup
counters before/after for actual resource-release evidence.

Installation evidence (local tools repository, 2026-10-19) includes tools and synthetic recall
over 14,931 input tokens on both profiles and 239,999 tokens on Exact. Exact's
near-full fresh input took about six minutes; its cached follow-up took 1.5 s.
Short-context samples were about 16 tokens/s Exact and 26 Light with thinking
off and the existing 450 W GPU limit. These establish basic runtime/recall
operation, not broad coding quality, dense full-window reasoning, or equivalence
to full precision. Arco integration results are recorded in DEVLOG separately.

The October 19 Arco acceptance run used the compiled server on an isolated
port/homedir. Both profiles passed real Read tool calls, screenshot OCR with
the code absent from the prompt/filename, reasoning and text streaming, native
262144 context accounting, confirmed in-flight cancellation, guarded profile
switching and service/resource release. Native cancellation settled after a
prefill batch (~15 s); both units ended inactive and GPU memory returned to
2665 MiB. See [retained results](validation/deepseek-2026-10-19.json).
