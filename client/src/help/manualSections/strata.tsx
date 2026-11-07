import type { Section } from '../../components/UserManual/manualTypes';
import { Note, Table, Sub} from '../../components/UserManual/components';
import { DocRef } from '../../components/help/DocRef';

export const strataGuide: Section[] = [
  {
  id: 'strata-memory', group: 'Providers', title: 'Strata MoE - RAM, VRAM and context',
  body: <>
  <p>
  Strata runs a model larger than VRAM by spreading it across GPU, system
  RAM and NVMe. This page explains which limit is which.
  </p>
  <Sub>Where the model lives</Sub>
  <p>
  Strata runs a <strong>mixture of experts (MoE)</strong> model: only a
  selected subset of experts runs for each token. Download size, host expert
  budget and total process memory are different quantities.
  </p>
  <Table headers={['Component', 'Strata MoE setup']} rows={[
  ['Dense work / hot experts', 'GPU plus hybrid CPU/GPU expert execution'],
  ['Host experts', 'A budget in host RAM set in the Strata service configuration; uncached experts read from files'],
  ['PLE / n-gram table', 'Second GGUF shard on NVMe; distinct from conversation KV'],
  ['Conversation KV', 'INT8 in host memory, with 32768 cells resident on GPU'],
  ['Image encoder', 'CPU, 8 threads, up to 1024 image tokens'],
  ]} />
  <Sub>Memory limits</Sub>
  <p>
  The host needs enough RAM for the expert budget and the service ceiling.
  Strata&apos;s service is capped separately from Arco.
  </p>
  <ul>
  <li>The <strong>soft threshold, hard ceiling and swap allowance</strong> are set in the Strata service&apos;s own configuration. Size them to the host.</li>
  <li>Child processes and charged file cache count toward that ceiling.</li>
  <li>The expert budget is only one part of it; the runtime may choose less.</li>
  <li>Arco&apos;s own memory guard does not resize this independent service.</li>
  </ul>
  <Sub>Context and tool caps</Sub>
  <Table headers={['Value', 'Meaning']} rows={[
  [<strong key="w">262144 tokens</strong>, 'The model window. The 262K label and a 256k capability badge refer to the same count.'],
  [<strong key="k">32768 resident KV cells</strong>, 'The GPU working set, not a 32K conversation cutoff.'],
  [<strong key="c">Read 32K / other tool results 64K</strong>, 'Arco text caps on tool output, separate from both of the above.'],
  ]} />
  <p>
  A trimmed tool result needs a narrower query or range. Raising model
  context alone does not restore omitted text.
  </p>
  <Sub>Vision</Sub>
  <p>
  Both registered profiles support images. The encoder runs on the CPU
  because GPU headroom is usually scarce beside the desktop. OCR and small
  details can still be wrong.
  </p>
  <p>
  Moving the encoder to GPU or raising RAM or cache budgets needs fresh
  headroom measurements and a guarded Strata restart between turns.
  </p>
  <Sub>Speed readouts</Sub>
  <ul>
  <li><strong>tok/s</strong> is decode speed for the last completed turn.</li>
  <li><strong>PP</strong> is fresh-prefill speed.</li>
  <li>Hover for counts and durations.</li>
  </ul>
  <p>
  Engine timings sum across tool rounds. They exclude cached prompt prefixes
  from prefill, and exclude loading, tool and network time. Missing engine
  timing means no readout. Short requests do not establish full-window speed
  or memory safety.
  </p>
  <p>
  Complete settings, asset paths, provenance, registry example and measured
  acceptance limits: <DocRef>docs/STRATA.md</DocRef>.
  </p>
  </>,
  },
  {
  id: 'strata-recovery', group: 'Troubleshooting', title: 'Strata - switching, FREE VRAM and recovery',
  body: <>
  <p>
  Use this page when Strata model discovery, switching, FREE VRAM, or return
  to Ollama does not behave as expected.
  </p>
  <Sub>Only one model in the list</Sub>
  <p>
  The service normally advertises one served model. Arco&apos;s optional local
  profile registry adds every prepared profile it lists,
  even while unloaded or stopped.
  </p>
  <ol>
  <li>Check the registry, endpoint match and prepared files.</li>
  <li>Refresh provider discovery/reload.</li>
  <li>Follow registration instructions in <DocRef>docs/STRATA.md</DocRef>.</li>
  </ol>
  <Sub>Model switch</Sub>
  <ol>
  <li>Choose a model in Agent&apos;s composer/CONFIG or Chat&apos;s dropdown.</li>
  <li>Send the next message. Selection alone does not load a model.</li>
  </ol>
  <ul>
  <li>One Strata turn runs at a time, including its tools. Queued Strata turns wait.</li>
  <li>Alternating tabs between profiles may reload weights.</li>
  <li>A failed or cancelled switch attempts to restore the previous profile and its prior unloaded state. Read the visible switch and restore notices.</li>
  </ul>
  <Sub>Busy or preflight refusal</Sub>
  <ol>
  <li>Finish or cancel other active local turns/reviewers and external Strata requests.</li>
  <li>Do not start a second large model alongside it to work around a refusal.</li>
  </ol>
  <p>
  The launcher checks other GPU workloads, loaded Ollama models, RAM, VRAM,
  port and competing profiles. It does not stop those workloads or unload
  another model.
  </p>
  <Sub>FREE VRAM</Sub>
  <p>
  <strong>FREE VRAM</strong> unloads loopback Ollama, Strata, DeepSeek through
  Xolotl, managed llama.cpp and LM Studio LLMs, including hidden providers. It skips remote
  endpoints and embeddings.
  </p>
  <ol>
  <li>Finish/cancel active local work first; the action refuses while busy or switching.</li>
  <li>Read each runtime&apos;s result. Model files and conversations stay; the next request reloads.</li>
  </ol>
  <p>
  An unloaded Strata engine with its Python service still running is normal.
  </p>
  <Sub>Return to Ollama</Sub>
  <ol>
  <li>After local work settles, use FREE VRAM.</li>
  <li>Choose the preserved Ollama provider/model.</li>
  <li>Stop the active Strata user service too if it should be fully stopped or another GPU workload should resume.</li>
  <li>Unload Ollama before returning to Strata. No model deletion is needed.</li>
  </ol>
  <Sub>No web or image response</Sub>
  <p>Check each of these:</p>
  <ul>
  <li>Chat&apos;s WEB switch</li>
  <li>SearXNG reachability</li>
  <li>Completed WebSearch/WebFetch results</li>
  <li>The encoder&apos;s live image capability</li>
  </ul>
  <p>
  A model writing a URL is not proof of search. High RAM or slow cold prompts
  call for inspecting cgroup pressure and NVMe/prefill, not just decode tok/s.
  </p>
  <p>Commands and recovery cases: <DocRef>docs/STRATA.md</DocRef>.</p>
  <Note kind="warn">Restarting Strata interrupts its requests. Restarting live
  Arco interrupts active workers across tabs. Wait for turns to finish or
  cancel them first. A yellow Strata version opens release notes; it does
  not install an engine update.</Note>
  </>,
  },
];
