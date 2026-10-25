import { C } from './shared';
import type { HelpEntry } from './shared';

// Workbench Expansion G2 — contextual help for the Cookbook catalog modal.
// Keyed by the data-help attributes on the header COOKBOOK button +
// CookbookModal / CatalogFilters / CatalogTable. All link to the
// 'cookbook-catalog' manual section.

const S = 'cookbook-catalog';

export const cookbookHelp: Record<string, HelpEntry> = {
  'header.cookbook': {
    title: 'Cookbook',
    body: (
      <p>
        Opens the <strong>Cookbook</strong> — a fit-scored catalog of local-LLM
        candidates from Hugging Face (GGUF) and the Ollama library, each scored
        against your serving hardware. Answers "what can I even run on this box?"
      </p>
    ),
    manualSection: S,
  },
  'cookbook.close': {
    title: 'Close',
    body: <p>Close the Cookbook (or press <C>Esc</C>).</p>,
    manualSection: S,
  },
  'cookbook.hardware': {
    title: 'Detected hardware',
    body: (
      <p>
        The serving box's GPU(s) / VRAM (or the CPU / Metal fallback) that the
        catalog scores against. When a simulation preset is active, a <C>[SIM]</C>
        marker shows you're scoring a hypothetical rig instead.
      </p>
    ),
    manualSection: S,
  },
  'cookbook.rescan': {
    title: 'Rescan hardware',
    body: (
      <p>
        Re-probe the serving box's GPU / VRAM / RAM (clears the cached profile and
        re-reads <C>nvidia-smi</C>). Use after changing hardware.
      </p>
    ),
    manualSection: S,
  },
  'cookbook.filter.search': {
    title: 'Search models',
    body: (
      <p>
        Free-text search over both sources (e.g. <C>qwen coder</C>). An empty box
        shows the "trending models that fit your hardware" feed.
      </p>
    ),
    manualSection: S,
  },
  'cookbook.filter.task': {
    title: 'Type / task filter',
    body: <p>Narrow to a task facet (text generation, vision, …) from the Hugging Face pipeline tags.</p>,
    manualSection: S,
  },
  'cookbook.filter.quant': {
    title: 'Quant preference',
    body: (
      <p>
        Keep only rows of a quant family (<C>Q4</C> keeps Q4_0 / Q4_K_S / Q4_K_M,
        etc.). Lower quants run faster and fit more context; higher quants are more
        accurate.
      </p>
    ),
    manualSection: S,
  },
  'cookbook.filter.sim': {
    title: 'Hardware simulation',
    body: (
      <p>
        Score the catalog against a hypothetical rig — RAM-only, or 1 / 2 / 4 / 8 ×
        a 32 GB GPU — instead of your detected box. "What could I run if I added a
        card?"
      </p>
    ),
    manualSection: S,
  },
  'cookbook.table': {
    title: 'Fit table',
    body: (
      <p>
        Every (model, quant) pair scored against your hardware, sorted by SCORE.
        Columns: FIT verdict, model (+MoE), params, quant, estimated VRAM, max
        context, speed (t/s), score, and serving mode.
      </p>
    ),
    manualSection: S,
  },
  'cookbook.row': {
    title: 'Catalog row',
    body: <p>One scored model variant. Click to expand for the source link, backend badge, and actions.</p>,
    manualSection: S,
  },
  'cookbook.row.backend': {
    title: 'Serving backend',
    body: <p>Which Arco backend would serve this model — llama.cpp (GGUF from Hugging Face) or Ollama.</p>,
    manualSection: S,
  },
  'cookbook.row.link': {
    title: 'Source link',
    body: <p>Open the model's page on Hugging Face or the Ollama library in a new tab.</p>,
    manualSection: S,
  },
  'cookbook.action.download': {
    title: 'Download',
    body: (
      <p>
        Fetch this model's weights. For a <strong>Hugging Face GGUF</strong> the
        file streams into <C>~/.arco/models/</C> and Arco auto-registers a
        llama.cpp catalog entry — selectable in CONFIG immediately. For{' '}
        <strong>Ollama</strong>, it runs <C>ollama pull</C> over the HTTP{' '}
        <C>/api/pull</C> endpoint (Ollama auto-discovers the tag). A disk
        pre-flight refuses an oversized pull before any byte downloads. Open a
        workflow first — the download runs against the active tab so it lands in{' '}
        <C>events.jsonl</C>.
      </p>
    ),
    manualSection: S,
  },
  'cookbook.download.progress': {
    title: 'Download progress',
    body: <p>Live progress for the running download — pre-flight (size vs free disk), bytes received / total, then registering. Cancel anytime; the partial file is deleted.</p>,
    manualSection: S,
  },
  'cookbook.download.cancel': {
    title: 'Cancel download',
    body: <p>Abort the running download. The partial file is deleted (no corrupt <C>.gguf</C>) and no catalog entry is written.</p>,
    manualSection: S,
  },
  'cookbook.download.done': {
    title: 'Download complete',
    body: <p>The model finished downloading. A GGUF is now registered in CONFIG under the shown alias; an Ollama pull is auto-discovered via <C>/api/tags</C>.</p>,
    manualSection: S,
  },
  'cookbook.download.error': {
    title: 'Download failed',
    body: <p>The download failed or was refused (e.g. not enough free disk). Nothing was registered; any partial file was deleted.</p>,
    manualSection: S,
  },
  'cookbook.download.dismiss': {
    title: 'Dismiss',
    body: <p>Clear this finished/failed download from the row so you can start another.</p>,
    manualSection: S,
  },
  'cookbook.recommend': {
    title: 'Recommend a model (G3)',
    body: (
      <p>
        Have a top-tier agent (Claude / Codex) reason over your detected hardware
        and the fit-scored candidates and recommend a <strong>specific</strong>{' '}
        model + quant + context for a task — with a rationale and a ready-to-apply
        config. Runs as <strong>one bounded research turn</strong>; the report lands
        in the active tab's RESEARCH tab. The agent recommends only — nothing is
        downloaded or configured.
      </p>
    ),
    manualSection: S,
  },
  'cookbook.recommend.profile': {
    title: 'Task profile',
    body: (
      <p>
        Biases both the candidate shortlist and the prompt: <C>coding</C> (coder
        models), <C>fast-autocomplete</C> (small + high t/s), <C>long-context</C>{' '}
        (max context that fits), <C>vision</C> (multimodal only), or{' '}
        <C>general</C>.
      </p>
    ),
    manualSection: S,
  },
  'cookbook.recommend.rounds': {
    title: 'Round cap',
    body: (
      <p>
        Hard ceiling on confirm-the-facts web-search rounds for the bounded turn
        (same ceiling as Deep Research). The agent recommends from the provided
        candidates; web search only confirms current facts.
      </p>
    ),
    manualSection: S,
  },
  'cookbook.recommend.runas': {
    title: 'Run as',
    body: <p>Which agent runs the recommendation turn (on your Claude / Codex subscription — no API billing).</p>,
    manualSection: S,
  },
  'cookbook.recommend.browse': {
    title: 'Browse candidates',
    body: (
      <p>
        Close the recommendation dialog and return to the catalog table. The
        recommendation is a free-text report — read it, then click{' '}
        <strong>DOWNLOAD</strong> on the recommended row to fetch + register it.
        Nothing auto-downloads from the dialog.
      </p>
    ),
    manualSection: S,
  },
};
