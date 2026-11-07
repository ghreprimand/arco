import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Table, Note, Sub } from '../../components/UserManual/components';
import { DocRef } from '../../components/help/DocRef';

export const deepseekGuide: Section[] = [{
  id: 'deepseek', group: 'Providers', title: 'DeepSeek via Xolotl - Exact, Light and memory',
  body: <>
  <p>
  <strong>XOLOTL</strong> runs the DeepSeek model locally. Pick Exact for
  unchanged answers or Light for speed, then send a message to load it.
  </p>
  <p>Saving unrelated settings preserves the configured DeepSeek endpoint. An explicit endpoint reset still restores the environment or default address.</p>
  <Sub>Runtime and model</Sub>
  <p>
  <strong>Xolotl is the inference runtime; DeepSeek is the model.</strong>
  </p>
  <ul>
  <li>Xolotl was formerly called Strata-DSV4.1. It is a separately maintained, extended fork of Strata.</li>
  <li>It spreads model data across GPU VRAM, pinned host RAM and NVMe storage.</li>
  <li>It listens on port <strong>8150</strong>, separate from Ollama and Qwen/Strata on 8081.</li>
  <li>Selecting the provider downloads or imports no weights.</li>
  <li>Upstream supports other model families; Arco registers only the two prepared DeepSeek profiles.</li>
  </ul>
  <Sub>Profiles</Sub>
  <Table headers={['Profile', 'Meaning']} rows={[
  ['Exact', 'Preserves expert routing; uses the installed mixed two-bit weights.'],
  ['Light', 'Routing biases 0.25 / 0.15 favor cached experts. Faster in local short tests, but changes expert selection and can change answers.'],
  ]} />
  <p>
  The primary-agent selector reads <Code>XOLOTL: DeepSeek · Exact / Light</Code>. Both
  choices stay visible while their services are stopped.
  </p>
  <ol>
  <li>Choose Exact or Light in an Agent or saved Chat.</li>
  <li>Send the next message so the guarded launcher loads it. The dropdown itself does not load anything.</li>
  </ol>
  <p>
  Settings &gt; <strong>XOLOTL · DEEPSEEK</strong> also has LOAD and UNLOAD
  controls, live service and loaded state, refresh, and cancellation during
  loading.
  </p>
  <Sub>Switching</Sub>
  <ul>
  <li>Only one profile runs at a time.</li>
  <li>Switching keeps Arco conversation history but loses the old engine&apos;s warm cache.</li>
  <li>Arco serializes whole DeepSeek turns, including tool round trips.</li>
  <li>A switch is refused while other local turns or external DeepSeek requests are active.</li>
  <li>A failed or cancelled switch tries to restore the previously loaded profile through the same guard.</li>
  </ul>
  <Sub>Limits</Sub>
  <Table headers={['Limit', 'Prepared setting']} rows={[
  ['Context', '262,144 tokens shared by input, history, thinking and output.'],
  ['Thinking', 'None, low, medium or high. Medium defaults to an 8K thinking budget.'],
  ['Output', '16K total allowance, including thinking; it consumes context too.'],
  ['Host expert arena', 'Set in the DeepSeek service configuration; it is not the entire service memory footprint.'],
  ['Service limits', 'MemoryHigh, MemoryMax and swap are set in the service\'s own configuration. Size them to the host.'],
  ['Modalities', 'Text, images and tools when the matching vision encoder is prepared. Text-only profiles reject images before loading.'],
  ['JSON', 'Prompt and validate. No constrained-decoding guarantee.'],
  ]} />
  <Sub>Images</Sub>
  <p>
  Attach screenshots or pictures normally. Settings shows VISION only for
  prepared profiles.
  </p>
  <ul>
  <li>Both installed profiles share the same DeepSeek image encoder.</li>
  <li>The encoder starts on the CPU with the first image and stops after 60 seconds without one, leaving GPU memory for language-model experts.</li>
  <li>Image tokens also consume the shared context window.</li>
  <li>Crop screenshots when small text is unreadable in a whole-desktop capture.</li>
  </ul>
  <Sub>Speed</Sub>
  <p>
  GPU utilization varies by phase. Prompt processing can saturate the card,
  while generation waits for experts moving between SSD, RAM and VRAM. A
  loaded model occupying GPU memory does not imply full compute use.
  </p>
  <p>
  Light changes routing for speed; None thinking reduces hidden reasoning.
  Neither guarantees low latency for long inputs or tool loops.
  </p>
  <Sub>Loading and unloading</Sub>
  <Note>Stop other GPU workloads yourself and unload competing models before loading.
  Arco never stops external GPU workloads or bypasses the launcher. A refused load
  reports its reason. Do not raise service limits to conceal a guard failure.</Note>
  <ul>
  <li>UNLOAD stops the managed service, including its engine children, and verifies that it is inactive and the endpoint has gone away.</li>
  <li>Header FREE VRAM does the same for DeepSeek alongside the other local runtimes.</li>
  <li>Five-minute idle unloading can leave the service running with its engine unloaded; this is shown separately.</li>
  <li>Stop the service before resuming other GPU workloads.</li>
  </ul>
  <Sub>Tools</Sub>
  <p>
  Saved Chat exposes only its armed WebSearch/WebFetch pair. Agent exposes
  normal project tools. Strict Incognito and cluster membership are not
  enabled for this standalone runtime.
  </p>
  <Sub>Version tracking</Sub>
  <p>
  PROVIDERS &gt; <strong>XOLOTL</strong> compares the installed source checkout
  revision with upstream HEAD, even while stopped.
  </p>
  <ul>
  <li>Clicking it opens source history inside Arco, with GitHub links and an UP TO DATE message when the revisions match.</li>
  <li>A difference does not mean a newer release and does not prove that the binary matches the checkout.</li>
  <li>Nothing is rebuilt or updated from this view.</li>
  <li>STRATA tracks its engine version separately, including while stopped.</li>
  </ul>
  <Sub>Background and acceptance</Sub>
  <p>
  Runtime background:{' '}
  <a href="https://github.com/Indras-Mirror/Xolotl" target="_blank" rel="noopener noreferrer">Xolotl upstream</a>.
  Xolotl is installed separately; Arco does not distribute it, and the linked
  documentation is pinned to one upstream revision.
  </p>
  <p>
  Upstream performance claims describe its own test setups; run your own
  acceptance checks on your hardware.
  </p>
  <ul>
  <li>Installation checks cover tools and synthetic recall.</li>
  <li>They do not establish dense full-window reasoning quality or equivalence to full precision.</li>
  <li>Cold input can take minutes; keeping the conversation prefix helps cache reuse.</li>
  </ul>
  <p>Setup, guards, recovery and verification: <DocRef>docs/DEEPSEEK.md</DocRef>.</p>
  </>,
}];
