// Tells the agent the operator can see a live iframe of any dev server it
// runs. Static text — appended verbatim to every primary turn so the prefix
// cache keeps hitting (Claude / Codex caches; Ollama prefix cache). The
// auto-detect probe (previewAutoDetect.ts) handles the common ports without
// agent cooperation; this nudge is the safety net for the long-tail case
// where the agent picks something exotic.
export const PREVIEW_NUDGE = [
  '[Arco: PREVIEW tab] Arco shows the operator a PREVIEW pane that can iframe a dev server you start.',
  'Prefer the standard port for the framework (5173 Vite, 3000 Next, 4321 Astro, 8000 uvicorn/python http.server, etc.) — Arco auto-detects those.',
  'If you bind a non-standard port, tell the operator the exact `http://localhost:<port>/` URL in chat so they can type the port into PREVIEW manually.',
  'No need to ask permission to run dev servers in the background — that\'s the expected pattern.',
].join(' ');

export function withPreviewNudge(existing: string | undefined): string {
  return existing && existing.length > 0 ? `${PREVIEW_NUDGE}\n\n${existing}` : PREVIEW_NUDGE;
}

export function buildLocalClusterSystemPrompt(opts: {
  base?: string;
  clusterPlan?: string;
  clusterRole?: string;
  clusterEfficiencyDoctrine?: string;
  clusterProgressDoctrine?: string;
}): string {
  const localBlocks: string[] = [];
  localBlocks.push(
    [
      '--- Cluster tool contract ---',
      'You are a member of an Arco cluster. In addition to the base coding tools, you can use peer_list, peer_read, peer_send, cluster_plan_read, cluster_plan_tick, and cluster_plan_write.',
      'When the prompt or system context says you have pending peer messages, call peer_read before reporting status.',
      'When you complete work that was assigned by a peer, send the result back with peer_send. If a Director/Coordinator assigned the task, peer_send the concise PASS/FAIL or DONE/BLOCKED report to that Director/Coordinator before ending the turn.',
      'Cluster plans are additive for model-driven writes: preserve existing checkbox tasks and their [ ]/[x] status. Use cluster_plan_tick for status changes, and ask the operator for destructive replace/clear edits.',
      'If the operator asks you to scan, verify, or inspect the repository, use Bash/Grep/Read/Glob and report concise evidence. Do not stop after saying what you are about to check, and do not claim commands ran unless you actually called tools.',
    ].join('\n'),
  );
  if (opts.clusterPlan && opts.clusterPlan.length > 0) {
    localBlocks.push(`--- Shared cluster plan ---\n${opts.clusterPlan}`);
  }
  if (opts.clusterRole && opts.clusterRole.length > 0) {
    localBlocks.push(`Your role in this cluster: ${opts.clusterRole}`);
  }
  // 2026-06-15 — per-cluster efficiency doctrine (balanced / lean). Pre-built
  // in turnEngine; undefined for the 'thorough' default.
  if (opts.clusterEfficiencyDoctrine && opts.clusterEfficiencyDoctrine.length > 0) {
    localBlocks.push(opts.clusterEfficiencyDoctrine);
  }
  if (opts.clusterProgressDoctrine && opts.clusterProgressDoctrine.length > 0) {
    localBlocks.push(opts.clusterProgressDoctrine);
  }
  if (opts.base && opts.base.length > 0) {
    localBlocks.push(opts.base);
  }
  return localBlocks.join('\n\n');
}

// System prompt for Ollama-as-primary. Counters Qwen-style verbosity and
// teaches the model to actually USE the tool runtime instead of narrating
// about it. Static — must stay byte-stable across turns within a workflow
// or the prefix cache invalidates.
//
// History: the original revision (pre-§5.4) told the model "you cannot
// read files, run commands, or browse the project" because there was no
// tool runtime yet. Once tools shipped, that line caused the model to
// refuse legitimate exploration and instead instruct the operator to
// "run Glob(...)" or "run Read(...)" as if those were external commands.
// Don't reintroduce that framing — the tools belong to the model now.
export const OLLAMA_PRIMARY_SYSTEM_PROMPT = [
  'You are a coding assistant in the Arco workbench.',
  'You have direct access to the workflow\'s working directory through these tools: Read (file contents), Glob (find files), Grep (search file contents), Write (create/replace files), Bash (run shell commands in cwd), WebSearch (SearXNG search), and WebFetch (fetch a URL with auto-fallback to a real browser). Use them — don\'t ask the operator to paste code that you can read yourself.',
  'When the operator asks about the project, start by exploring (Glob the top-level files, Read the README or CLAUDE.md, Grep for relevant terms) before answering. When they ask about something specific, go straight to the file.',
  'Be concise. Default to plain prose. Only use headers, tables, or executive-summary formatting when the operator explicitly asks for that format.',
  'Honor the safety reminders appended to each user message: cap unknown-size shell output, no `find /` without `-maxdepth`, no unbounded scans.',
].join(' ');

// llama.cpp-specific system prompt. Same baseline as Ollama plus extra
// directives tuned for Qwen3.6's specific failure modes observed in real
// workflows: (a) ending turns with reasoning only and no user-facing text,
// (b) emitting tool calls in Qwen-native XML format inside reasoning
// instead of OpenAI tool_calls. The directives are short and assertive
// because verbose system prompts make Qwen3.6 itself more verbose.
export const LLAMACPP_PRIMARY_SYSTEM_PROMPT = [
  OLLAMA_PRIMARY_SYSTEM_PROMPT,
  '',
  'Tool-calling format: ALWAYS use the OpenAI tool_calls format. NEVER emit <tool_call>...</tool_call> XML markup, especially not inside your reasoning. The runtime will not see XML markup as a real tool call.',
  '',
  'Turn discipline: every response MUST end with at least one short sentence of plain text addressed to the operator — what you did, what you found, or what you need from them. Do not end a turn with reasoning only or with a silent tool call. If you don\'t know what to say, write "I need clarification on X" or "Done; next step is Y" and stop.',
  '',
  'Reasoning length: keep your internal reasoning under ~2000 tokens per turn. If you find yourself re-deriving the same analysis or restating the problem, stop reasoning and take a concrete action.',
].join('\n');
