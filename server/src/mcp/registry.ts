// ARCO_OPS_PLAN.md §E1 — global MCP server registry.
//
// Stores operator-registered MCP server defs at `~/.arco/mcp/registry.json`
// (override base via $ARCO_HOME, else $HOME/.arco — same convention as the
// rest of ~/.arco state). The registry is GLOBAL (one machine-wide list);
// per-workflow enablement + dangerous-tool ticks live in each workflow's
// meta.json (workflowMeta.mcpAllow), keyed by serverId.
//
// Atomic temp+rename writes (matches taskLedger / planStore / workflowMeta).
// SECURITY: `env` values are secret-bearing — they are persisted to the
// registry file but NEVER logged. The registry layer logs ids/names only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { McpServerDef } from '@arco/shared';
import { atomicWriteFile } from '../atomicFile.js';
import { arcoHome } from '../arcoHome.js';

const ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;
const NAME_MAX = 200;

// arcoHome() resolves per call (not at module load) so the smoke can point
// HOME/ARCO_HOME at a temp dir before driving the registry.
function registryDir(): string {
  return path.join(arcoHome(), 'mcp');
}

function registryPath(): string {
  return path.join(registryDir(), 'registry.json');
}

interface RegistryFile {
  servers: McpServerDef[];
}

// Defensive normalize: tolerate a hand-edited / older file. Drops malformed
// entries rather than throwing so one bad entry can't brick the registry.
function normalize(raw: unknown): McpServerDef[] {
  const servers = (raw as RegistryFile | undefined)?.servers;
  if (!Array.isArray(servers)) return [];
  const out: McpServerDef[] = [];
  for (const s of servers) {
    if (!s || typeof s !== 'object') continue;
    const def = s as Partial<McpServerDef>;
    if (typeof def.id !== 'string' || !ID_PATTERN.test(def.id)) continue;
    if (typeof def.command !== 'string' || def.command.length === 0) continue;
    out.push({
      id: def.id,
      name: typeof def.name === 'string' ? def.name : def.id,
      command: def.command,
      args: Array.isArray(def.args) ? def.args.filter((a): a is string => typeof a === 'string') : [],
      env: isStringRecord(def.env) ? def.env : {},
      enabled: def.enabled === true,
      createdAt: typeof def.createdAt === 'number' ? def.createdAt : Date.now(),
    });
  }
  return out;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object') return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string');
}

export async function load(): Promise<McpServerDef[]> {
  try {
    const rawText = await fs.readFile(registryPath(), 'utf8');
    return normalize(JSON.parse(rawText));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function save(servers: McpServerDef[]): Promise<void> {
  await atomicWriteFile(registryPath(), JSON.stringify({ servers }, null, 2) + '\n');
}

export async function list(): Promise<McpServerDef[]> {
  return load();
}

export async function get(id: string): Promise<McpServerDef | undefined> {
  return (await load()).find((s) => s.id === id);
}

export interface CreateInput {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

export async function create(input: CreateInput): Promise<McpServerDef> {
  const def: McpServerDef = {
    id: randomUUID(),
    name: (input.name || 'unnamed').slice(0, NAME_MAX),
    command: input.command,
    args: input.args ?? [],
    env: input.env ?? {},
    enabled: input.enabled ?? false,
    createdAt: Date.now(),
  };
  if (!def.command) throw new Error('mcp registry: command is required');
  const servers = await load();
  servers.push(def);
  await save(servers);
  return def;
}

export interface UpdateInput {
  name?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

// Patch in place. Returns the updated def, or undefined if id not found.
export async function upsert(id: string, patch: UpdateInput): Promise<McpServerDef | undefined> {
  const servers = await load();
  const idx = servers.findIndex((s) => s.id === id);
  if (idx === -1) return undefined;
  const cur = servers[idx];
  const next: McpServerDef = {
    ...cur,
    ...(patch.name !== undefined ? { name: patch.name.slice(0, NAME_MAX) } : {}),
    ...(patch.command !== undefined ? { command: patch.command } : {}),
    ...(patch.args !== undefined ? { args: patch.args } : {}),
    ...(patch.env !== undefined ? { env: patch.env } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
  };
  servers[idx] = next;
  await save(servers);
  return next;
}

export async function remove(id: string): Promise<boolean> {
  const servers = await load();
  const next = servers.filter((s) => s.id !== id);
  if (next.length === servers.length) return false;
  await save(next);
  return true;
}
