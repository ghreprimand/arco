// AI-collaborative document editing — WORKBENCH_EXPANSION_PLAN.md §A7.
//
// Mirrors runReviewer.ts / runResearch.ts: spawns a SHORT-LIVED, READ-ONLY
// worker for ONE bounded turn. CRITICALLY DIFFERENT from those two: this worker
// produces NO artifact file and has NO Write/Edit tool. Its ENTIRE output is
// the replacement text for the operator's selection, returned verbatim in the
// `doc_edit_proposed` event. The client previews it as an A3 diff and the
// operator Accepts (splice into the editor buffer — buffer only) or Rejects;
// the existing A6 Save is the only path that touches disk, through the
// `resolveWithinCwd`-guarded write endpoint.
//
// Fence note (CLAUDE.md "hard fences"): the agent PROPOSES text, the operator
// APPROVES twice (into the buffer, then on the guarded Save). The agent never
// writes to disk. NO orchestrator LLM, NO second-LLM judge, ONE bounded turn.
// Operator-initiated + bounded + reversible at both levels ⇒ clears the
// four-question test.

import { WorkerManager } from '../workers/WorkerManager.js';
import { DOC_EDIT_CONTEXT_LIMIT } from '@archon/shared';
import type {
  ServerMessage,
  ProviderName,
  ModelName,
  EffortLevel,
} from '@archon/shared';

export interface DocEditorConfig {
  provider: ProviderName;
  model: ModelName;
  effort: EffortLevel;
  providerAccountRef?: string;
  codexHome?: string;
}

export interface DocEditContext {
  workflowId: string;
  cwd: string;
  manager: WorkerManager;
  broadcast: (msg: ServerMessage) => void;
}

export interface DocEditHandle {
  docEditId: string;
  settled: Promise<{ replacement: string; error?: string }>;
}

// Read-only LOCAL tool sets. The agent gets NO Write/Edit/Bash — text output
// only. Local read tools let it inspect referenced files for context if it
// wants, but it never mutates anything.
const READ_ONLY_CLAUDE_TOOLS = ['Read', 'Grep', 'Glob'];
const READ_ONLY_OLLAMA_TOOLS = ['Read', 'Grep', 'Glob'];
const READ_ONLY_LLAMACPP_TOOLS = ['Read', 'Grep', 'Glob'];
const READ_ONLY_LMSTUDIO_TOOLS = ['Read', 'Grep', 'Glob'];

function toolsFor(provider: ProviderName): string[] | undefined {
  if (provider === 'claude') return READ_ONLY_CLAUDE_TOOLS;
  if (provider === 'ollama') return READ_ONLY_OLLAMA_TOOLS;
  if (provider === 'llamacpp') return READ_ONLY_LLAMACPP_TOOLS;
  if (provider === 'lmstudio' || (provider === 'strata' || provider === 'deepseek')) return READ_ONLY_LMSTUDIO_TOOLS;
  return undefined;
}

function clampContext(s: string): string {
  if (s.length <= DOC_EDIT_CONTEXT_LIMIT) return s;
  return s.slice(0, DOC_EDIT_CONTEXT_LIMIT);
}

function buildFraming(args: {
  filePath: string;
  selectionText: string;
  contextBefore: string;
  contextAfter: string;
  instruction: string;
  wholeDoc: boolean;
}): string {
  const before = clampContext(args.contextBefore);
  const after = clampContext(args.contextAfter);
  const scope = args.wholeDoc
    ? 'the ENTIRE document (a whole-document edit)'
    : 'the SELECTED REGION below (only that region — not the whole file)';

  return `You are a scoped document-editing assistant. The operator has selected ${scope} in the file \`${args.filePath}\` and asked you to apply the instruction below.

Return ONLY the replacement text for the selected region. Hard rules:
- Output the replacement TEXT ONLY — no explanation, no preamble, no commentary, no markdown code fences around it.
- Do NOT return the whole file (unless this is a whole-document edit, in which case the "selection" IS the whole file).
- Your output replaces EXACTLY the selected region, spliced in between the surrounding context. Preserve the surrounding context's formatting (indentation, trailing newline conventions) so the splice is seamless.
- You have read-only local tools (Read / Grep / Glob) for any context the file references. You CANNOT and MUST NOT write or edit any file — your output is the proposal; the operator reviews and applies it.

--- CONTEXT BEFORE SELECTION (read-only, do NOT include in your output) ---
${before}

--- SELECTED REGION (replace this) ---
${args.selectionText}

--- CONTEXT AFTER SELECTION (read-only, do NOT include in your output) ---
${after}

--- INSTRUCTION ---
${args.instruction}

Now output ONLY the replacement for the selected region.`;
}

// Defensive unwrap: if the model wraps its output in a single fenced code block
// despite the instruction, strip the outer fence. Conservative — only strips
// when the WHOLE output is one fence (opening ``` line + closing ``` line).
function unwrapFence(text: string): string {
  const trimmed = text.trim();
  const fenceOpen = /^```[^\n]*\n/;
  if (!fenceOpen.test(trimmed) || !trimmed.endsWith('```')) return text;
  const withoutOpen = trimmed.replace(fenceOpen, '');
  const withoutClose = withoutOpen.replace(/\n?```$/, '');
  return withoutClose;
}

export function runDocEdit(
  ctx: DocEditContext,
  args: {
    editor: DocEditorConfig;
    filePath: string;
    selectionText: string;
    selectionFrom: number;
    selectionTo: number;
    contextBefore: string;
    contextAfter: string;
    instruction: string;
    wholeDoc: boolean;
  },
): DocEditHandle {
  const docEditId = `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = Date.now();

  ctx.broadcast({
    type: 'doc_edit_started',
    workflowId: ctx.workflowId,
    docEditId,
    filePath: args.filePath,
    editor: args.editor,
    startedAt,
  });

  const task = buildFraming({
    filePath: args.filePath,
    selectionText: args.selectionText,
    contextBefore: args.contextBefore,
    contextAfter: args.contextAfter,
    instruction: args.instruction,
    wholeDoc: args.wholeDoc,
  });

  const spec = {
    id: docEditId,
    task,
    model: args.editor.model,
    effort: args.editor.effort,
    provider: args.editor.provider,
    // NO Write/Edit — read-only local tools only. Text output IS the proposal.
    tools: toolsFor(args.editor.provider),
  };

  let collected = '';

  const settled = ctx.manager.spawn(
    spec,
    (ev) => {
      if (ev.type === 'worker_text') {
        collected += ev.text;
      } else if (ev.type === 'worker_system_notice') {
        ctx.broadcast({
          type: 'system_notice',
          workflowId: ctx.workflowId,
          content: ev.notice,
        });
      }
    },
    {
      cwd: ctx.cwd,
      workflowId: ctx.workflowId,
      // Read-only edit-proposal run. Claude gates via the `tools` allowlist;
      // Codex gates via `-s read-only` (sandbox); Ollama gates via its
      // allowlist (no Write/Bash). skipPermissions=true for Ollama so its SAFE
      // mode doesn't refuse the read tools (same rationale as runReviewer).
      skipPermissions: args.editor.provider === 'ollama',
      sandbox: 'read-only',
      // §A7 proposals are read carefully as a diff — never caveman/lite.
      outputStyle: 'normal',
      ...(args.editor.provider === 'codex' && args.editor.codexHome
        ? { providerAccountRef: args.editor.providerAccountRef, codexHome: args.editor.codexHome }
        : {}),
    },
  ).then((r) => {
    const completedAt = Date.now();
    if (r.error) {
      ctx.broadcast({
        type: 'doc_edit_proposed',
        workflowId: ctx.workflowId,
        docEditId,
        filePath: args.filePath,
        selectionFrom: args.selectionFrom,
        selectionTo: args.selectionTo,
        replacement: '',
        error: r.error,
        completedAt,
      });
      return { replacement: '', error: r.error };
    }

    const raw = (collected || r.text || '');
    const replacement = unwrapFence(raw);
    ctx.broadcast({
      type: 'doc_edit_proposed',
      workflowId: ctx.workflowId,
      docEditId,
      filePath: args.filePath,
      selectionFrom: args.selectionFrom,
      selectionTo: args.selectionTo,
      replacement,
      completedAt,
    });
    return { replacement };
  });

  return { docEditId, settled };
}
