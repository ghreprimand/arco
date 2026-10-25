import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  executeOllamaTool,
  getOllamaToolDefinitions,
  resolveWithinCwd,
  type OllamaToolContext,
  type OllamaToolDefinition,
} from '../ollamaTools.js';

export type ZaiToolDefinition = OllamaToolDefinition;

// WebSearch/WebFetch are already implemented in the shared ollama tool runtime
// (executeOllamaTool handles them); GLM just wasn't offered them. WebFetch is
// keyless + SSRF-guarded; WebSearch routes through the operator's local SearXNG
// (same as the ollama/llama.cpp/Claude-native primaries) and errors gracefully
// if it isn't running. Giving GLM a way to look things up matters for research
// and doc-driven tasks.
const CORE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash', 'Write', 'WebSearch', 'WebFetch']);
const CLUSTER_TOOLS = new Set(['peer_list', 'peer_send', 'peer_read', 'cluster_plan_read', 'cluster_plan_tick', 'cluster_plan_write']);

const EditTool: ZaiToolDefinition = {
  type: 'function',
  function: {
    name: 'Edit',
    description:
      'Replace text in one file. Path must resolve inside the workflow cwd. Fails if old_string is absent or ambiguous. Use Read first when unsure.',
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Target file path, relative to cwd or absolute inside cwd.' },
        old_string: { type: 'string', description: 'Exact existing text to replace.' },
        new_string: { type: 'string', description: 'Replacement text.' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
};

export function getZaiNativeToolDefinitions(opts?: { clusterEnabled?: boolean; mailboxOnly?: boolean }): ZaiToolDefinition[] {
  const base = getOllamaToolDefinitions({ clusterEnabled: opts?.clusterEnabled, mailboxOnly: opts?.mailboxOnly })
    .filter((tool) => CORE_TOOLS.has(tool.function.name) || (opts?.clusterEnabled && CLUSTER_TOOLS.has(tool.function.name)));
  return [...base, EditTool];
}

function asString(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new Error(`argument "${name}" must be a string`);
  return v;
}

async function executeEdit(args: Record<string, unknown>, ctx: OllamaToolContext): Promise<string> {
  const filePath = asString(args.file_path, 'file_path');
  const oldString = asString(args.old_string, 'old_string');
  const newString = asString(args.new_string, 'new_string');
  if (!oldString) return '[error] old_string must be non-empty';
  const abs = resolveWithinCwd(ctx.cwd, filePath);
  const original = await fs.readFile(abs, 'utf8');
  const first = original.indexOf(oldString);
  if (first === -1) return `[error] old_string not found in ${filePath}`;
  const second = original.indexOf(oldString, first + oldString.length);
  if (second !== -1) return `[error] old_string appears multiple times in ${filePath}; provide a more specific span`;
  const updated = original.slice(0, first) + newString + original.slice(first + oldString.length);
  await fs.writeFile(abs, updated, 'utf8');
  return `edited ${path.relative(ctx.cwd, abs)} (${oldString.length} bytes replaced with ${newString.length})`;
}

export async function executeZaiNativeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: OllamaToolContext,
): Promise<string> {
  if (name === 'Edit') {
    try {
      return await executeEdit(args, ctx);
    } catch (err) {
      return `[error] ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return executeOllamaTool(name, args, ctx);
}
