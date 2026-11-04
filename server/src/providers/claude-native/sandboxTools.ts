// docs/PROVIDERS.md - three tools registered into the
// Anthropic tools[] array when WorkflowConfig.efficiencySandbox === 'on'.
//
// Wire shape mirrors peerTools.ts: bare names (no MCP namespace prefix —
// these tools are in-process, not MCP-spawned), `getSandboxToolDefinitions()`
// returns the descriptors, `isSandboxTool()` is the routing predicate the
// worker's dispatchTool uses, and `executeSandboxTool()` does the work
// and returns a string the worker wraps into a tool_result.
//
// Trust model: the model knows when it's calling ctx_execute vs Read.
// No silent redirection. Per-tab opt-in. Operator can disable mid-session;
// the next turn rebuilds tools[] without these descriptors.

import type { ClaudeToolDef } from './tools.js';
import { getSandboxStore, type SandboxStore } from './sandboxStore.js';
import { executeSandboxed, normalizeLanguage } from './sandboxExecutor.js';

export const SANDBOX_TOOL_NAMES = new Set<string>(['ctx_execute', 'ctx_search', 'ctx_fetch']);

export function isSandboxTool(name: string): boolean {
  return SANDBOX_TOOL_NAMES.has(name);
}

export function getSandboxToolDefinitions(): ClaudeToolDef[] {
  return [
    {
      name: 'ctx_execute',
      description:
        'Run a short script in a sandbox subprocess and return ONLY what it writes to stdout. ' +
        'Use for: reading large files where you only need a small slice, running shell ' +
        'commands whose output is mostly noise (grep/jq inside the script and console.log ' +
        'only the relevant section), computing summaries over data without paging it into ' +
        'context. The script runs in a per-call temp directory; cwd writes do not affect ' +
        'the operator repo. 10 s timeout, 256 KB stdout cap, process-group killed on ' +
        'timeout. Supported languages: node (also "js"), python (also "py", "python3"), ' +
        'shell (also "sh", "bash"). The full Read / Bash tools are still available — use ' +
        'them when the operator explicitly asked for full output or the section is small.',
      input_schema: {
        type: 'object',
        properties: {
          language: {
            type: 'string',
            description: 'Script language: "node" | "python" | "shell" (aliases accepted).',
          },
          code: { type: 'string', description: 'Source to execute.' },
        },
        required: ['language', 'code'],
      },
    },
    {
      name: 'ctx_search',
      description:
        'BM25 full-text search over chunks that prior ctx_execute calls stored in this ' +
        "tab's sandbox index. Returns the top hits with chunk IDs and short snippets. " +
        "To store a chunk for later retrieval, have your ctx_execute script print " +
        "lines of the form `[chunk] <text>` to stdout — they are extracted and indexed. " +
        'Use ctx_fetch with a returned chunkId to read the full chunk.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'FTS5 MATCH query (terms ANDed by default).' },
          limit: { type: 'number', description: 'Max hits (default 5).' },
        },
        required: ['query'],
      },
    },
    {
      name: 'ctx_fetch',
      description:
        'Return the full content of a stored chunk by chunkId (as returned from ctx_search ' +
        'or the ctx_execute chunk-store result).',
      input_schema: {
        type: 'object',
        properties: {
          chunkId: { type: 'number', description: 'Numeric chunk id.' },
        },
        required: ['chunkId'],
      },
    },
  ];
}

export interface SandboxToolContext {
  workflowId: string;
  cwd: string;
  onChunkStored?: (chunkId: number, byteLen: number, language: string) => void;
}

// Extract `[chunk] ...` lines from stdout and persist each as its own chunk.
// Returns the chunk ids that were stored. The leftover stdout (lines that
// did NOT start with `[chunk]`) is what the tool surfaces to the model.
function extractChunks(stdout: string, store: SandboxStore, language: string): {
  remaining: string;
  storedIds: Array<{ chunkId: number; byteLen: number }>;
} {
  const lines = stdout.split('\n');
  const kept: string[] = [];
  const storedIds: Array<{ chunkId: number; byteLen: number }> = [];
  // Multi-line chunk support: a `[chunk]` opens, `[/chunk]` closes. Single-
  // line shorthand: `[chunk] <text>` stores the rest of the line.
  let buffering: string[] | null = null;
  for (const line of lines) {
    if (buffering !== null) {
      if (line.trim() === '[/chunk]') {
        const content = buffering.join('\n');
        const info = store.insertChunk(language, content);
        storedIds.push(info);
        buffering = null;
        continue;
      }
      buffering.push(line);
      continue;
    }
    if (line.startsWith('[chunk]')) {
      const rest = line.slice('[chunk]'.length).trim();
      if (rest === '') {
        // Open multi-line block on the next iteration.
        buffering = [];
      } else {
        const info = store.insertChunk(language, rest);
        storedIds.push(info);
      }
      continue;
    }
    kept.push(line);
  }
  // Unterminated multi-line block: flush anyway so chunks don't leak.
  if (buffering !== null) {
    const content = buffering.join('\n');
    const info = store.insertChunk(language, content);
    storedIds.push(info);
  }
  return { remaining: kept.join('\n').replace(/\n+$/, ''), storedIds };
}

export async function executeSandboxTool(
  name: string,
  input: Record<string, unknown>,
  ctx: SandboxToolContext,
): Promise<string> {
  if (name === 'ctx_execute') {
    const langRaw = typeof input.language === 'string' ? input.language : '';
    const code = typeof input.code === 'string' ? input.code : '';
    if (!langRaw || !code) return '[error] ctx_execute requires { language, code }';
    const language = normalizeLanguage(langRaw);
    if (!language) return `[error] ctx_execute: unsupported language ${JSON.stringify(langRaw)}. Use node | python | shell.`;
    const result = await executeSandboxed(language, code, { workflowCwd: ctx.cwd, workflowId: ctx.workflowId });
    const store = getSandboxStore(ctx.cwd, ctx.workflowId);
    const { remaining, storedIds } = extractChunks(result.stdout, store, language);
    if (ctx.onChunkStored) {
      for (const { chunkId, byteLen } of storedIds) {
        try { ctx.onChunkStored(chunkId, byteLen, language); } catch { /* best-effort */ }
      }
    }
    const lines: string[] = [];
    lines.push(remaining || '[no stdout]');
    if (storedIds.length > 0) {
      lines.push('');
      lines.push(`[stored ${storedIds.length} chunk(s)] ids: ${storedIds.map((s) => s.chunkId).join(', ')}`);
    }
    if (result.stderr.trim().length > 0) {
      lines.push('');
      lines.push('--- stderr ---');
      lines.push(result.stderr.trim());
    }
    if (result.timedOut) lines.push('[timed out — process group killed]');
    if (result.exitCode !== 0 && result.exitCode !== null) lines.push(`[exit ${result.exitCode}]`);
    return lines.join('\n');
  }
  if (name === 'ctx_search') {
    const query = typeof input.query === 'string' ? input.query : '';
    const limit = typeof input.limit === 'number' ? Math.max(1, Math.min(50, Math.floor(input.limit))) : 5;
    if (!query) return '[error] ctx_search requires { query }';
    const store = getSandboxStore(ctx.cwd, ctx.workflowId);
    const hits = store.search(query, limit);
    if (hits.length === 0) return '[no matches]';
    return hits
      .map((h) => `#${h.chunkId} [${h.language}, ${h.byteLen}B, score=${h.score.toFixed(3)}] ${h.snippet}`)
      .join('\n');
  }
  if (name === 'ctx_fetch') {
    const id = typeof input.chunkId === 'number' ? input.chunkId : NaN;
    if (!Number.isFinite(id)) return '[error] ctx_fetch requires { chunkId: number }';
    const store = getSandboxStore(ctx.cwd, ctx.workflowId);
    const row = store.fetch(id);
    if (!row) return `[error] chunk ${id} not found`;
    return row.content;
  }
  return `[error] unknown sandbox tool ${JSON.stringify(name)}`;
}
