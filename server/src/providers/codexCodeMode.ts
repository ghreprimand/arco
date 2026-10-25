// Codex "code mode" detection + cluster-member prompt addendum.
//
// Background (docs/CODEX_GPT56_CLUSTER_INCOMPAT.md): catalog-marked models
// including gpt-5.6 sol/terra/luna and gpt-6-astra run inside OpenAI's own
// multi-agent harness — the
// model is told it is `/root` in a team of agents, given native spawn_agent /
// send_message tools, and its tool surface becomes a JS `exec` code cell.
// Archon's cluster MCP tools are NOT gone in that mode: they appear inside
// the exec cell's `tools` namespace under mangled names
// (`tools.mcp__archon_cluster__peer_send` — server dash → underscore, then
// `mcp__<server>__<tool>`). The 2026-07-09 incident member ignored the peer
// substrate because Archon's role text said "peer_send", a name that doesn't
// exist in its world, while the harness gave its own send_message top
// billing. Telling the model the real names fixes it — verified live on both
// `codex exec` and the app-server transport (terra ACKed the director via
// peer_send and disclaimed directorship, first try).
//
// Detection is catalog-driven, not name-regex: codex caches the server model
// catalog at `$CODEX_HOME/models_cache.json`, and the per-model `tool_mode`
// (`code_mode_only` / `code_mode`) + `multi_agent_version` fields are exactly
// what gates the harness client-side (proven: overriding them via
// `-c model_catalog_json` removes the /root prompt entirely). A future
// gpt-5.7 that ships the harness is caught automatically; a future 5.6 build
// that drops it stops matching.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WorkerConfig } from '@archon/shared';
import { buildClusterDirectorDoctrine } from '../clusterDirector.js';

interface CodeModeEntry {
  toolMode: string | null;
  multiAgentVersion: string | null;
}

interface CacheSlot {
  mtimeMs: number;
  models: Map<string, CodeModeEntry>;
}

// Keyed by resolved models_cache.json path; revalidated by mtime so a codex
// catalog refresh (hourly, or on CLI upgrade) is picked up next turn.
const cache = new Map<string, CacheSlot>();

function modelsCachePath(codexHome?: string): string {
  return path.join(codexHome ?? path.join(os.homedir(), '.codex'), 'models_cache.json');
}

function readModels(codexHome?: string): Map<string, CodeModeEntry> | null {
  const file = modelsCachePath(codexHome);
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const slot = cache.get(file);
  if (slot && slot.mtimeMs === mtimeMs) return slot.models;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      models?: Array<{ slug?: string; tool_mode?: string | null; multi_agent_version?: string | null }>;
    };
    if (!Array.isArray(parsed.models)) return null;
    const models = new Map<string, CodeModeEntry>();
    for (const m of parsed.models) {
      if (typeof m.slug !== 'string') continue;
      models.set(m.slug, {
        toolMode: typeof m.tool_mode === 'string' ? m.tool_mode : null,
        multiAgentVersion: typeof m.multi_agent_version === 'string' ? m.multi_agent_version : null,
      });
    }
    cache.set(file, { mtimeMs, models });
    return models;
  } catch {
    return null;
  }
}

// true — model runs the code-mode multi-agent harness; false — definitively
// not (catalog entry present, no code-mode fields); null — unknown (no
// cache file, parse failure, or model not in this account's catalog).
export function codexModelUsesCodeMode(modelId: string, codexHome?: string): boolean | null {
  const models = readModels(codexHome);
  if (!models) return null;
  const entry = models.get(modelId);
  if (!entry) return null;
  return entry.toolMode?.startsWith('code_mode') === true || entry.multiAgentVersion !== null;
}

// Folded into the string-form cluster blocks (after the role hint) for Codex
// members on code-mode models. Names the exec-cell tool namespace verbatim —
// the whole fix is that the model can't discover `peer_send` under the name
// Archon's generic role text uses. Phrased conditionally ("if your tool
// surface is an exec code cell") so a fail-open inclusion on an unknown
// model is harmless: a plain function-calling model reads it as inapplicable.
export function codexCodeModeClusterAddendum(): string {
  return [
    '--- Codex code-mode notice ---',
    'If your tool surface is an `exec` code cell and you have native collaboration tools (spawn_agent / send_message / followup_task, "you are /root"): those collaboration tools belong to Codex\'s own harness and do NOT reach this Arco cluster. Never use them for cluster coordination, and being "/root" of that harness does not make you this cluster\'s director — your cluster role is stated above.',
    'Your REAL Arco cluster tools live INSIDE the exec code cell\'s `tools` namespace, named `tools.mcp__archon_cluster__<tool>`:',
    '  await tools.mcp__archon_cluster__peer_read()          — drain your peer mailbox',
    '  await tools.mcp__archon_cluster__peer_send({to, content}) — message a peer (workflowId / 8-char prefix / displayName / role)',
    '  await tools.mcp__archon_cluster__peer_list()          — list peers',
    'All other archon-cluster tools (cluster_task_*, cluster_plan_*) follow the same `tools.mcp__archon_cluster__<tool>` naming. Call them from exec like any other tools.* function.',
  ].join('\n');
}

// app-server can place Archon's durable cluster identity at developer level
// when a thread starts/resumes. Per-turn plan content still rides in user
// input because it is mutable; the stable role and tool contract do not need
// to compete with Codex's own `/root` developer framing there.
export function codexClusterDeveloperInstructions(config: WorkerConfig): string | null {
  if (config.provider !== 'codex' || !config.clusterId) return null;
  const blocks = [
    '--- Arco cluster identity ---',
    config.clusterRole ? `Your operator-assigned role in the Arco cluster is: ${config.clusterRole.trim()}` : '',
    buildClusterDirectorDoctrine(config.clusterRole) ?? '',
  ];
  if (codexModelUsesCodeMode(config.model, config.codexHome) !== false) {
    blocks.push(codexCodeModeClusterAddendum());
  }
  return blocks.filter(Boolean).join('\n\n');
}
