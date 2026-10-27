# DeepSeek V4.1 Flash via Xolotl

DeepSeek through Xolotl is an optional external-service integration. Arco can
connect to a separately installed Xolotl runtime serving DeepSeek V4.1 Flash.
Arco does not distribute Xolotl or model weights and does not download or
import model weights into Ollama. Xolotl uses a separate provider registry and
guarded service lifecycle; existing provider defaults remain unchanged.

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
- Engine-specific details should be checked against the installed Xolotl release documentation.

Keep upstream benchmarks distinct from measurements of the installed quantization, routing, memory budget, and GPU power limit. The pinned checkout
revision is source provenance; rebuild records establish binary provenance.

The saved provider key remains `deepseek` for compatibility with existing
workflows, settings and API routes; its user-facing provider name is Xolotl.

## Select, load and unload

Enable XOLOTL in Settings. The primary-agent selector reads
`XOLOTL, DeepSeek · Exact / Light`: runtime first, then the model family. Both registered profiles appear even when stopped.
Select a profile in the Agent creator, composer model picker, CONFIG, saved
Chat, or a primitive's RUN AS picker. Selection applies on the next message;
changing a dropdown alone does not load a model. Settings -> XOLOTL · DEEPSEEK
also provides explicit LOAD EXACT, LOAD LIGHT, UNLOAD · STOP SERVICE, refresh,
and cancel-load controls. Failed operations show the guarded launcher's reason.

| Profile | Model ID | Managed service | Meaning |
| --- | --- | --- | --- |
| Exact | `deepseek-v4.1-flash-1017-exact` | configured exact-profile service | Preserves expert routing |
| Light | `deepseek-v4.1-flash-1017-light` | configured light-profile service | Routing biases 0.25 / 0.15 favor cached experts and change expert selection |

Both use compressed weights; neither is equivalent to the full-precision
checkpoint. Their routing behavior differs, and model quality must be evaluated
for the intended workload. The service endpoint is configured in Settings;
model assets remain in user-managed storage.

| Resource / capability | Profile behavior |
| --- | --- |
| Context | Configured by the selected model profile; includes input, history, thinking, and output |
| Reasoning | None / low / medium / high when supported by the profile |
| Output allowance | Profile-configured; thinking and visible output share the limit |
| Host expert arena | Configured per service; not the entire process or cgroup footprint |
| Service limits | Set by the operating system and service configuration |
| Modalities | Text, images, and tools when matching assets are prepared; text-only profiles remain supported |
| Tools | Arco's bounded tool loop; restricted primitives keep their allowlist |
| JSON | Prompt and validate; no constrained-decoding guarantee |
| Idle unload | Configurable; the service can remain active with its engine unloaded |

Only one profile can run because both share the endpoint. Whole DeepSeek turns,
including tool rounds, are serialized even if the optional local queue setting
is disabled. Alternating profiles retains Arco's conversation but loses the
old engine's warm cache. Fresh long prompts can take minutes; the transport
accepts the runtime's SSE heartbeats during prefill. Output and thinking share
the context and output limits.
Cancellation closes Arco's request immediately. The native engine may finish its
current prefill batch before becoming idle. Loading, switching, and unloading
remain blocked while that request is settling; do not bypass the busy guard.

Saved Chat exposes only its armed WebSearch/WebFetch pair. Strict Incognito is
not offered: this standalone runtime is not proven diskless. Cluster membership
and Computer voice selection are not enabled for DeepSeek in this integration.
The existing Ollama and Qwen/Strata paths remain independent.

## Images and vision support

Vision support requires a matching encoder and companion assets in the selected
profile. The profile's optional `vision` section identifies the encoder,
companion model, matching text model, and resource limits. Arco checks that the
assets exist and that the live service reports compatible modalities before
sending an image. CPU encoding can preserve GPU space but may add host-memory use
and latency. Image tokens share the model context; they do not have a separate
context window.

Attach images normally in Agent or saved Chat. Offline discovery advertises
vision only after the referenced assets exist. The worker refuses images for
text-only configs before starting a model, and readiness requires the live
service's vision flag to match the selected prepared profile. Missing or stale
vision preparation refuses startup; a dropdown label alone never enables it.
For dense text in an image, use a focused crop rather than a full-screen capture.

## Guards and service ownership

Arco never spawns the large engine itself. It invokes only the registered
guarded launcher, which delegates to the installed systemd units and preserves
their cgroup limits and control-group cleanup:

Do not invoke the engine directly or bypass its guarded launcher. The launcher
checks model asset availability, competing local model services, resource
headroom, and service ownership before a profile switch. It repeats those checks
when the engine reloads. Arco does not stop unrelated local workloads.

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

The server reads `~/.arco/deepseek-profiles.json` (override with
`ARCO_DEEPSEEK_PROFILES`). This is a user-maintained registry, not a model
discovery command. Register profiles only after preparation and testing:

```json
{
  "baseUrl": "http://127.0.0.1:<port>/v1",
  "runtime": "<runtime-root>",
  "launcher": {
    "python": "<python-executable>",
    "script": "<guarded-launcher>"
  },
  "profiles": [
    {
      "id": "exact",
      "model": "deepseek-v4.1-flash-1017-exact",
      "label": "DeepSeek V4.1 Flash - Exact - Xolotl",
      "config": "<asset-root>/config/exact.json"
    },
    {
      "id": "light",
      "model": "deepseek-v4.1-flash-1017-light",
      "label": "DeepSeek V4.1 Flash - Light - Xolotl",
      "config": "<asset-root>/config/light.json"
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

PROVIDERS -> STRATA reads the live engine version, falling back to the prepared
engine's adjacent `BUILD.json` while stopped. This fixes the stopped-service row
disappearing as "unknown." Upstream engine versions come from the release's
component feed, with release-note/legacy-tag fallbacks. The 0.2 app version is
not an engine version. Both Strata and Xolotl version rows open themed history
inside Arco, like Ollama; GitHub is an explicit external link.

PROVIDERS -> XOLOTL reads the registered checkout's Git HEAD without
running an engine. It compares with `Indras-Mirror/Xolotl` upstream HEAD at boot
and every four hours; yellow means different revisions, with a link to compare
source changes. The in-app view reads recent commits and compares only distinct
revisions; equal revisions display "UP TO DATE" without a self-comparison link.
This is source tracking, not a semver ordering or a claim that
the built engine matches checkout HEAD. Neither row installs updates, rebuilds,
changes profiles or loads weights. Preserve preparation/build records when
updating either runtime.

## Performance considerations

Response time depends on quantization, routing, context length, hardware, and
resource limits. Prompt processing, expert transfers, image encoding, tools, and
reasoning all contribute to total time. Short decode measurements are not
sustained-throughput or answer-quality guarantees. Compare profiles under the
same prompt and generation settings, and change one resource setting at a time.
Arco does not change selected profiles or defaults automatically.

## Diagnostics and recovery

Check the configured endpoint's health, model-list, and status routes. Inspect
the service manager's status, resource limits, and recent logs. The registry and
selected profile identify the endpoint and managed service.

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
loading weights or touching a user's service manager or workspace. Existing
Strata provider/profile/control and unload tests remain regression gates.
`smoke:deepseek-ui` checks actual browser version rows and lifecycle controls
against an isolated Vite fixture (`ARCO_CLIENT_PORT=5197 ARCO_PORT=6197
npm run dev:client`); every API and WebSocket is intercepted.
Live GPU acceptance requires suitable hardware and model assets. Release both
profiles afterward; the guarded flow does not stop unrelated workloads.

`smoke:deepseek-live` requires `ARCO_DEEPSEEK_LIVE=1` and an explicit
`ARCO_SMOKE_WS_URL` for a throwaway Arco with an isolated home directory.
Point that server's `ARCO_DEEPSEEK_PROFILES` at a test registry and keep its
workspace and process stores isolated from production. The test exercises both profiles, actual Read
round trips, reasoning, native context accounting, streaming, cancellation and
guarded service release. Set `ARCO_DEEPSEEK_VISION_IMAGE` to a synthetic image fixture to exercise OCR
through Arco on both profiles. Keep fixture markers out of the filename and
text prompt. It refuses to run without opt-in and requires both
profiles stopped initially. It never uses Ollama, downloads weights, stops a
miner, or overrides an external request's busy refusal. Inspect GPU/cgroup
counters before/after for actual resource-release evidence.

Unit and smoke tests use fake services, isolated state, and synthetic fixtures.
They do not validate a full-context workload, worst-case image batches, coding
quality, or peak memory on a user's hardware. Live acceptance requires the
intended runtime, model assets, and host. Release all profiles after acceptance;
the guarded flow does not stop unrelated local workloads.
