import type { Section } from '../../components/UserManual/manualTypes';
import { Note, Table } from '../../components/UserManual/components';
import { DocRef } from '../../components/help/DocRef';

export const strataGuide: Section[] = [
  {
    id: 'strata-memory', group: 'Providers', title: 'Strata MoE — RAM, VRAM and context',
    body: <>
      <p>A large <strong>mixture of experts (MoE)</strong> model uses a selected
        subset of experts for each token. Strata distributes its weights and
        caches across GPU, system RAM and NVMe. A model larger than VRAM can run,
        but its full download size, host expert budget and total process memory
        are different quantities.</p>
      <Table headers={['Component', 'Prepared Flash Next setup']} rows={[
        ['Dense work / hot experts', 'GPU plus hybrid CPU/GPU expert execution'],
        ['Host experts', 'Up to 24 GiB budget; uncached experts read from files'],
        ['PLE / n-gram table', 'Second GGUF shard on NVMe; distinct from conversation KV'],
        ['Conversation KV', 'INT8 in host memory, with 32768 cells resident on GPU'],
        ['Image encoder', 'CPU, 8 threads, up to 1024 image tokens'],
      ]} />
      <p>The prepared workstation has <strong>96 GB installed RAM</strong>
        (about 93.8 GiB usable). Strata's service still has a <strong>32 GiB soft
        threshold and 36 GiB hard ceiling</strong>, with no swap allowance.
        Children and charged file cache count toward that ceiling. The 24 GiB
        expert budget is only one part of it; the runtime may choose less.
        Arco's own memory guard does not resize this independent service.</p>
      <p>The model window is <strong>262144 tokens</strong>. The <strong>32768
        resident KV cells</strong> are the GPU working set, not a 32K conversation
        cutoff. Arco's <strong>Read 32K / other tool results 64K</strong> text
        caps are separate again. A trimmed tool result needs a narrower query or
        range; increasing model context alone does not restore omitted text.
        The 262K label and a 256k capability badge refer to the same token count.</p>
      <p>CPU vision was chosen because GPU headroom was scarce beside the desktop
        reserve. Both registered profiles support images, but OCR and small details
        can still be wrong. Moving the encoder to GPU or increasing RAM/cache
        budgets requires fresh headroom measurements and a guarded Strata restart
        between turns. No limits were raised for this setup.</p>
      <p><strong>tok/s</strong> is decode speed for the last completed turn;
        <strong> PP</strong> is fresh-prefill speed. Hover for counts/durations.
        Engine timings sum across tool rounds, exclude cached prompt prefixes
        from prefill, and exclude loading, tool and network time. Missing engine
        timing means no readout. Short requests do not establish full-window speed
        or memory safety.</p>
      <p>Complete settings, asset paths, provenance, registry example and measured
        acceptance limits: <DocRef>docs/STRATA.md</DocRef>.</p>
    </>,
  },
  {
    id: 'strata-recovery', group: 'Troubleshooting', title: 'Strata — switching, FREE VRAM and recovery',
    body: <>
      <p><strong>Only one model in the list?</strong> The service normally advertises
        one served model. Arco's optional local profile registry adds prepared
        Original and SC117 Abliterated choices, including while unloaded/stopped.
        Check the registry, endpoint match and prepared files, then refresh provider
        discovery/reload. Registration instructions: <DocRef>docs/STRATA.md</DocRef>.</p>
      <p><strong>Model switch:</strong> choose a model in Agent's composer/CONFIG
        or Chat's dropdown and send the next message. One Strata turn runs at a
        time, including its tools. Queued Strata turns wait; alternating tabs may
        reload weights. Selection alone does not load a model. A failed/cancelled
        switch attempts to restore the previous profile and its prior unloaded
        state. Read the visible switch/restore notices.</p>
      <p><strong>Busy or preflight refusal:</strong> finish or cancel other active
        local turns/reviewers and external Strata requests. The launcher checks
        miners, loaded Ollama models, RAM, VRAM, port and competing profiles; it
        does not stop mining or unload another model for you. Do not start a second
        large model alongside it to work around a refusal.</p>
      <p><strong>FREE VRAM</strong> unloads loopback Ollama, Strata, managed
        llama.cpp and LM Studio LLMs, including hidden providers. It skips remote
        endpoints and embeddings. Finish/cancel active local work first; the action
        refuses while busy or switching. It reports each runtime's result, keeps
        model files and conversations, and lets the next request reload. An
        unloaded Strata engine with its Python service still running is normal.</p>
      <p><strong>Return to Ollama:</strong> after local work settles, use FREE VRAM
        and choose the preserved Ollama provider/model. Stop the active Strata user
        service too if you want it fully stopped or want to resume mining. Unload
        Ollama before returning to Strata. No model deletion is needed.</p>
      <p><strong>No web/image response:</strong> check Chat's WEB switch, SearXNG
        reachability, completed WebSearch/WebFetch results, and the encoder's live
        image capability. A model writing a URL is not proof of search. High RAM or
        slow cold prompts call for inspecting cgroup pressure and NVMe/prefill, not
        just decode tok/s. Commands and recovery cases: <DocRef>docs/STRATA.md</DocRef>.</p>
      <Note kind="warn">Restarting Strata interrupts its requests. Restarting live
        Arco interrupts active workers across tabs. Wait for turns to finish or
        cancel them first. A yellow Strata version opens release notes; it does
        not install an engine update.</Note>
    </>,
  },
];
