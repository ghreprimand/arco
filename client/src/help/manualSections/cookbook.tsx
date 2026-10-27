import type { Section } from '../../components/UserManual/manualTypes';
import { Code, Note } from '../../components/UserManual/components';

// Cookbook manual section. Linked from every
// cookbook.* HELP_CONTENT entry (docs:check enforces the link resolves).

export const cookbook: Section[] = [
  {
    id: 'cookbook-catalog',
    group: 'Power features',
    title: 'The Cookbook — fit-scored model catalog',
    body: (
      <>
        <p>
          The <strong>COOKBOOK</strong> button in the header opens a browsable,
          fit-scored catalog of local-LLM candidates — the "what can I even run on
          this box?" view. It searches two public, keyless sources and scores every
          quant variant against your serving hardware:
        </p>
        <ul>
          <li><strong>Hugging Face Hub</strong> — GGUF repositories (served via llama.cpp).</li>
          <li><strong>Ollama library</strong> — pullable model names (served via Ollama).</li>
        </ul>
        <p>
          Each row is one (model, quant) pair scored by the G1 fit engine. The
          columns mirror the score table: <Code>FIT</Code> (a PERFECT/GOOD/TIGHT/NO
          verdict, coloured green→red) · <Code>MODEL</Code> (with a MoE badge for
          mixture-of-experts models) · <Code>PARAM</Code> · <Code>QUANT</Code> ·
          estimated <Code>VRAM</Code> · max <Code>CTX</Code> that fits ·{' '}
          <Code>SPEED</Code> (t/s estimate) · the 0–100 <Code>SCORE</Code> · and the
          serving <Code>MODE</Code> (gpu / cpu-offload). Rows are sorted by SCORE
          descending.
        </p>
        <p>
          <strong>Filters.</strong> A free-text search box, a Type/task select, a
          quant preference (Q4 / Q5 / Q8 / …), and a hardware-simulation preset —
          score the catalog against a hypothetical rig (RAM-only / 1 / 2 / 4 / 8
          GPUs) instead of your detected box. An empty search shows the
          "trending models that fit your hardware" feed.
        </p>
        <p>
          The header strip shows the detected rig — discrete GPUs + VRAM, or on
          Apple Silicon the GPU plus its unified-memory budget (the share of
          system RAM the Metal backend can wire: a size-scaled fraction of the
          box, or your <Code>sysctl iogpu.wired_limit_mb</Code> override when set),
          or a CPU-only fallback — with a <strong>RESCAN</strong> button that
          re-probes the hardware. On Apple Silicon the fit engine scores models
          against that unified-memory budget instead of scoring every model NO, so
          a Mac gets a real catalog rather than a degenerate fallback. Expanding a
          row reveals the Hugging Face / Ollama link and a backend badge.
        </p>
        <Note>
          No API keys, no paid endpoints — both sources are public. Catalog
          search itself never downloads or registers anything; that happens only
          when you click <strong>DOWNLOAD</strong> on a row (see below).
        </Note>

        <h4>Download + auto-register</h4>
        <p>
          Expand a row and click <strong>DOWNLOAD</strong> to fetch the model.
          Every download is an <strong>explicit operator click</strong> — nothing
          auto-pulls.
        </p>
        <ul>
          <li>
            <strong>Hugging Face GGUF</strong> — Arco re-queries the repo for the
            exact quant file, streams it into <Code>~/.arco/models/</Code>, and
            auto-registers a llama.cpp catalog entry (alias + context + backend).
            The model is <strong>selectable in CONFIG immediately</strong> — no
            manual <Code>llamacpp.json</Code> edit.
          </li>
          <li>
            <strong>Ollama</strong> — Arco runs the pull over the HTTP{' '}
            <Code>/api/pull</Code> endpoint (honouring your configured / remote
            Ollama base URL); Ollama auto-discovers the tag via{' '}
            <Code>/api/tags</Code>, so there's no catalog write.
          </li>
        </ul>
        <p>
          Before any byte downloads, a <strong>disk pre-flight</strong> shows the
          model size vs free disk and <strong>refuses</strong> a pull that won't
          fit (with a 2 GB safety margin). During the download a progress bar +{' '}
          <strong>CANCEL</strong> are shown; cancelling (or any failure) deletes
          the partial file — no corrupt <Code>.gguf</Code>, and no catalog entry
          for an incomplete pull.
        </p>
        <Note>
          Downloads are operator-initiated, visible in <Code>events.jsonl</Code>{' '}
          (start / progress / done / refused / cancelled), and reversible — delete
          the file from <Code>~/.arco/models/</Code> and remove the catalog
          entry to undo. HF GGUF weights land <strong>only</strong> in the models
          dir (path-confined, sanitized filename); a malicious repo/filename can't
          escape it.
        </Note>

        <h4>Recommend a model</h4>
        <p>
          The <strong>RECOMMEND</strong> button in the Cookbook header asks a
          top-tier agent (Claude / Codex, picked via <strong>RUN AS</strong>) to
          reason over your detected hardware and the fit-scored candidate set and
          recommend a <strong>specific</strong> model + quant + context for a task.
          You pick a <strong>task profile</strong>:
        </p>
        <ul>
          <li><strong>Coding</strong> — coder-tuned models at a quality-preserving quant with working headroom.</li>
          <li><strong>Fast autocomplete</strong> — small, highest-throughput models (latency dominates).</li>
          <li><strong>Long-context analysis</strong> — the largest context that still fits on the rig.</li>
          <li><strong>Vision</strong> — vision-capable / multimodal models only.</li>
          <li><strong>General-purpose</strong> — the best overall balance.</li>
        </ul>
        <p>
          The recommendation <strong>reuses the Deep Research bounded turn</strong>:
          the agent gets the hardware profile + the fit-filtered candidates as
          grounding, may run a few <em>confirm-the-facts</em> web searches up to the
          round cap, and writes a structured report — the single best pick, the
          recommended context, expected throughput + mode, a rationale grounded in
          the fit numbers, and a ready-to-paste Arco config block (a llama.cpp
          catalog entry for a GGUF pick, or an <Code>ollama pull</Code> line). The
          report lands in the active tab's RESEARCH tab.
        </p>
        <Note>
          The agent <strong>recommends only</strong> — one bounded turn, no
          orchestrator, no "keep going until satisfied" loop, no second-LLM judge.
          You review the report and either apply the suggested config yourself or
          click <strong>DOWNLOAD</strong> on the matching catalog row (G4, above) to
          fetch + auto-register it. The agent runs on your Claude / Codex
          subscription (no API billing). Cancel it like any research run.
        </Note>
      </>
    ),
  },
];
