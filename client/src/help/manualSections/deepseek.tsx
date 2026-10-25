import type { Section } from '../../components/UserManual/manualTypes';
import { Table, Note } from '../../components/UserManual/components';
import { DocRef } from '../../components/help/DocRef';

export const deepseekGuide: Section[] = [{
  id: 'deepseek', group: 'Providers', title: 'DeepSeek via Xolotl — Exact, Light and memory',
  body: <>
    <p><strong>Xolotl is the inference runtime; DeepSeek is the model.</strong>
      Xolotl was formerly called Strata-DSV4.1 and is a separately maintained,
      extended fork of Strata. It distributes model data across GPU VRAM,
      pinned host RAM and NVMe storage. Upstream also supports other model
      families; Arco currently registers only your two prepared DeepSeek profiles.</p>
    <p><strong>XOLOTL</strong> connects to the prepared Xolotl runtime on port
      <strong> 8150</strong>. It is separate from Ollama and Qwen/Strata on 8081.
      No weights are downloaded or imported when selecting this provider.</p>
    <Table headers={['Profile', 'Meaning']} rows={[
      ['Exact', 'Preserves expert routing; uses the installed mixed two-bit weights.'],
      ['Light', 'Routing biases 0.25 / 0.15 favor cached experts. Faster in local short tests, but changes expert selection and can change answers.'],
    ]} />
    <p>The primary-agent selector reads XOLOTL — DeepSeek · Exact / Light.
      Both prepared choices stay visible with their services stopped. Choose one
      in an Agent or saved Chat; sending the next message loads it through the
      guarded launcher. The dropdown itself does not load anything. Settings →
      <strong> XOLOTL · DEEPSEEK</strong> also has explicit LOAD and UNLOAD controls,
      live service/loaded state, refresh, and cancellation during loading.</p>
    <p>Only one profile can run at a time. Switching preserves Arco conversation
      history but loses the old engine's warm cache. Arco serializes whole
      DeepSeek turns including tool round trips. Switching refuses other active
      local turns or external DeepSeek requests; failed/cancelled switches try
      to restore the previously loaded profile through the same guard.</p>
    <Table headers={['Limit', 'Prepared setting']} rows={[
      ['Context', '262,144 tokens shared by input, history, thinking and output.'],
      ['Thinking', 'None, low, medium or high. Medium defaults to an 8K thinking budget.'],
      ['Output', '16K total allowance, including thinking; it consumes context too.'],
      ['Host expert arena', '48 GiB; this is not the entire service memory footprint.'],
      ['Service limits', 'MemoryHigh 60 GiB; MemoryMax 64 GiB; no swap.'],
      ['Modalities', 'Text, images and tools when the matching vision encoder is prepared. Text-only profiles reject images before loading.'],
      ['JSON', 'Prompt and validate. No constrained-decoding guarantee.'],
    ]} />
    <p>Both installed profiles can use the same DeepSeek image encoder. It starts
      on the CPU with the first image and stops after 60 seconds without an image,
      keeping GPU memory available for language-model experts. Attach screenshots
      or pictures normally; Settings shows VISION only for prepared profiles.
      Image tokens also consume the shared context window. Inspect small text in
      cropped screenshots when a whole desktop makes it unreadable.</p>
    <p>GPU utilization varies by phase: prompt processing can saturate the card,
      while generation waits for experts moving between SSD, RAM and VRAM.
      A loaded model occupying GPU memory does not imply full compute utilization.
      Light changes routing for speed; None thinking reduces hidden reasoning work.
      Neither control guarantees low latency for long inputs or tool loops.</p>
    <Note>Stop mining yourself and unload competing models before loading.
      Arco never stops your miner or bypasses the launcher. A refused load
      reports its reason. Do not raise service limits to conceal a guard failure.</Note>
    <p>UNLOAD stops the managed service, including its engine children, and verifies
      that it is inactive and the endpoint has gone away. Header FREE VRAM does
      the same for DeepSeek alongside the other local runtimes. Five-minute idle
      unloading can leave a service running with its engine unloaded; this is
      displayed separately. Stop the service before resuming mining.</p>
    <p>Saved Chat exposes only its armed WebSearch/WebFetch pair. Agent exposes
      normal project tools. Strict Incognito and cluster membership are not
      enabled for this standalone runtime.</p>
    <p>PROVIDERS → <strong>XOLOTL</strong> tracks the installed source
      checkout revision even when stopped and compares it with upstream HEAD.
      Click opens source history inside Arco, with an UP TO DATE message when
      the revisions match and explicit GitHub links. A difference does not mean a newer
      release, prove that your binary matches the checkout, rebuild, or update
      anything. STRATA tracks its engine version separately, including while stopped.</p>
    <p>Runtime background: <a href="https://github.com/Indras-Mirror/Xolotl" target="_blank" rel="noopener noreferrer">Xolotl upstream</a>.
      Installed revision: <code>c3324f8998040a9247d22137e9bfb3ff2c5da361</code>.
      Upstream performance claims describe its own test setups; use the local
      acceptance results below for this workstation.</p>
    <p>Prior installation tests covered tools and synthetic recall, including
      239,999 input tokens on Exact. They do not establish dense full-window
      reasoning quality or equivalence to full precision. Cold input can take
      minutes; keeping the conversation prefix helps cache reuse.</p>
    <p>Setup, guards, recovery and verification: <DocRef>docs/DEEPSEEK.md</DocRef>.</p>
  </>,
}];
