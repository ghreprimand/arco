import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { homedir } from 'os';
import type { ToolboxEntry, ToolboxResponse } from '@arco/shared';
import { JsonRpcClient } from './providers/codex-appserver/jsonRpc.js';
import type { InitializeResponse } from './providers/codex-appserver/bindings/InitializeResponse.js';
import type { SkillsListResponse } from './providers/codex-appserver/bindings/v2/SkillsListResponse.js';
import type { PluginListResponse } from './providers/codex-appserver/bindings/v2/PluginListResponse.js';

// Provider-native skill catalogs. This is intentionally separate from
// skills.ts: `.arco/skills` are Arco-owned prompt attachments, while this
// module asks each agent runtime what it can actually invoke.

const USER_SKILLS = join(homedir(), '.claude', 'skills');
const PROBE_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: ToolboxResponse }>();

function parseFrontmatter(text: string): { name?: string; description?: string } {
  // Frontmatter is `---` ... `---` at file head.
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  const block = text.slice(3, end);
  const out: Record<string, string> = {};
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    // Strip surrounding quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

async function scanSkillsRoot(
  root: string,
  source: ToolboxEntry['source'],
  provider: ToolboxEntry['provider'],
  pluginName?: string,
): Promise<ToolboxEntry[]> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const results: ToolboxEntry[] = [];
  for (const name of entries) {
    const dir = join(root, name);
    try {
      const st = await stat(dir);
      if (!st.isDirectory()) continue;
      const skillPath = join(dir, 'SKILL.md');
      const text = await readFile(skillPath, 'utf-8');
      const fm = parseFrontmatter(text);
      const skillName = fm.name || name;
      const invocationName = pluginName ? `${pluginName}:${name}` : name;
      results.push({
        name: invocationName,
        ...(skillName !== invocationName ? { displayName: skillName } : {}),
        description: fm.description || '',
        provider,
        source,
        invocation: provider === 'claude' ? `/${invocationName}` : `$${invocationName}`,
        path: skillPath,
        ...(pluginName && { pluginName }),
      });
    } catch {
      // no SKILL.md or unreadable — skip
    }
  }
  return results;
}

async function scanPluginSkills(plugins: Array<{ name: string; path?: string }>): Promise<ToolboxEntry[]> {
  // The init event reports the exact enabled install path. Do not walk the
  // cache: it may contain disabled plugins and stale versions.
  const groups = await Promise.all(plugins.map(async (plugin) => {
    if (!plugin.path) return [];
    const entries = await scanSkillsRoot(join(plugin.path, 'skills'), 'plugin', 'claude', plugin.name);
    try {
      const skillPath = join(plugin.path, 'SKILL.md');
      const fm = parseFrontmatter(await readFile(skillPath, 'utf8'));
      const leaf = fm.name || plugin.name;
      entries.push({
        name: `${plugin.name}:${leaf}`,
        ...(fm.name ? { displayName: fm.name } : {}),
        description: fm.description || '',
        provider: 'claude',
        source: 'plugin',
        invocation: `/${plugin.name}:${leaf}`,
        path: skillPath,
        pluginName: plugin.name,
      });
    } catch {
      // Most plugins use skills/<name>/SKILL.md; a root skill is optional.
    }
    return entries;
  }));
  return groups.flat();
}

interface ClaudeInit {
  type: 'system';
  subtype: 'init';
  skills?: string[];
  plugins?: Array<{ name: string; path?: string }>;
}

export function parseClaudeInitLine(line: string): ClaudeInit | null {
  try {
    const value = JSON.parse(line) as Partial<ClaudeInit>;
    return value.type === 'system' && value.subtype === 'init' ? value as ClaudeInit : null;
  } catch {
    return null;
  }
}

async function claudeSkillRoots(cwd: string): Promise<Array<{ root: string; source: 'project' | 'user' }>> {
  const roots: Array<{ root: string; source: 'project' | 'user' }> = [{ root: USER_SKILLS, source: 'user' }];
  let cursor = resolve(cwd);
  const fsRoot = parse(cursor).root;
  while (true) {
    roots.push({ root: join(cursor, '.claude', 'skills'), source: 'project' });
    if (cursor === fsRoot || cursor === dirname(cursor)) break;
    cursor = dirname(cursor);
  }
  return roots;
}

async function probeClaudeInit(cwd: string): Promise<ClaudeInit> {
  return await new Promise<ClaudeInit>((resolveProbe, reject) => {
    const proc = spawn('claude', ['-p', '--output-format', 'stream-json', '--verbose', '--max-turns', '1', '/help'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Claude skill probe timed out'));
    }, PROBE_TIMEOUT_MS);
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        const init = parseClaudeInitLine(line);
        if (init) {
          clearTimeout(timer);
          proc.kill('SIGTERM');
          resolveProbe(init);
          return;
        }
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-16 * 1024);
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', () => {
      clearTimeout(timer);
      const init = parseClaudeInitLine(stdout);
      if (init) resolveProbe(init);
      else reject(new Error(stderr.trim() || 'Claude did not report skill metadata'));
    });
  });
}

async function discoverClaudeSkills(cwd: string): Promise<ToolboxResponse> {
  const init = await probeClaudeInit(cwd);
  const roots = await claudeSkillRoots(cwd);
  const scanned = (await Promise.all([
    scanPluginSkills(init.plugins ?? []),
    ...roots.map(({ root, source }) => scanSkillsRoot(root, source, 'claude')),
  ])).flat();
  const entries = mergeClaudeSkillCatalog(init, scanned);
  return { provider: 'claude', transport: 'cli', supported: true, entries };
}

export function mergeClaudeSkillCatalog(init: ClaudeInit, scanned: ToolboxEntry[]): ToolboxEntry[] {
  // scan order is precedence order: personal before project, then cwd before
  // parent directories. Keep the first match rather than letting a lower
  // precedence parent overwrite its metadata.
  const byName = new Map<string, ToolboxEntry>();
  for (const entry of scanned) {
    if (!byName.has(entry.name)) byName.set(entry.name, entry);
  }
  const entries = (init.skills ?? []).map<ToolboxEntry>((name) => byName.get(name) ?? {
    name,
    description: '',
    provider: 'claude',
    source: 'builtin',
    invocation: `/${name}`,
  });
  return sortEntries(entries);
}

async function discoverCodexSkills(cwd: string, codexHome?: string): Promise<ToolboxResponse> {
  const proc = spawn('codex', ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
    detached: true,
  });
  let stderr = '';
  proc.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16 * 1024); });
  if (!proc.stdin || !proc.stdout) {
    proc.kill('SIGKILL');
    throw new Error('Codex app-server stdio not available');
  }
  const rpc = new JsonRpcClient(proc.stdin, proc.stdout);
  const cleanup = () => {
    rpc.close('skill catalog probe done');
    try { proc.kill('SIGTERM'); } catch { /* gone */ }
  };
  const timer = setTimeout(cleanup, PROBE_TIMEOUT_MS);
  try {
    await rpc.request<InitializeResponse>('initialize', {
      clientInfo: { name: 'arco', title: 'Arco', version: '0.1.0' },
      capabilities: { experimentalApi: true, optOutNotificationMethods: null },
    });
    rpc.notify('initialized');
    // Plugin synchronization is asynchronous at app-server startup. Asking
    // for the plugin catalog is the protocol-owned readiness barrier; without
    // it an immediate skills/list intermittently returns system skills only.
    await rpc.request<PluginListResponse>('plugin/list', { cwds: [cwd] });
    const result = await rpc.request<SkillsListResponse>('skills/list', {
      cwds: [cwd],
      forceReload: true,
      perCwdExtraUserRoots: null,
    });
    const entries = normalizeCodexSkillCatalog(result, cwd);
    return { provider: 'codex', transport: 'native', supported: true, entries };
  } catch (err) {
    const suffix = stderr.trim() ? `: ${stderr.trim()}` : '';
    throw new Error(`${err instanceof Error ? err.message : String(err)}${suffix}`);
  } finally {
    clearTimeout(timer);
    cleanup();
  }
}

export function normalizeCodexSkillCatalog(result: SkillsListResponse, cwd: string): ToolboxEntry[] {
  const row = result.data.find((entry) => entry.cwd === cwd) ?? result.data[0];
  const entries = (row?.skills ?? []).filter((skill) => skill.enabled).map<ToolboxEntry>((skill) => {
    const normalizedPath = skill.path.replace(/\\/g, '/');
    // CODEX_HOME is account-specific in Arco, so never key this to
    // ~/.codex. Installed plugins always live below <CODEX_HOME>/plugins/cache.
    const pluginSkill = normalizedPath.includes('/plugins/cache/');
    return {
      name: skill.name,
      ...(skill.interface?.displayName ? { displayName: skill.interface.displayName } : {}),
      description: skill.description || skill.shortDescription || skill.interface?.shortDescription || '',
      provider: 'codex',
      source: skill.scope === 'repo'
        ? 'project'
        : pluginSkill
          ? 'plugin'
          : skill.scope,
      invocation: `$${skill.name}`,
      path: skill.path,
      enabled: skill.enabled,
      ...(pluginSkill && skill.name.includes(':')
        ? { pluginName: skill.name.split(':', 1)[0] }
        : {}),
    };
  });
  return sortEntries(entries);
}

function sortEntries(entries: ToolboxEntry[]): ToolboxEntry[] {
  const rank: Record<ToolboxEntry['source'], number> = {
    project: 0, user: 1, plugin: 2, admin: 3, system: 4, builtin: 4,
  };
  return entries.sort((a, b) => (rank[a.source] - rank[b.source]) || a.name.localeCompare(b.name));
}

export async function discoverToolbox(input: {
  provider: string;
  transport?: string;
  cwd: string;
  codexHome?: string;
  force?: boolean;
}): Promise<ToolboxResponse> {
  const { provider, transport, cwd, codexHome, force } = input;
  if (provider === 'claude' && transport !== 'cli') {
    return {
      provider: 'claude', transport: transport ?? 'native', supported: false, entries: [],
      reason: 'Claude Native does not run the Claude Code skill runtime. Use +SKILL for an Arco attachment or switch this tab to CLI.',
    };
  }
  if (provider !== 'claude' && provider !== 'codex') {
    return {
      provider: null, transport: transport ?? null, supported: false, entries: [],
      reason: 'This provider does not expose a native skill catalog. Use +SKILL to attach an Arco-managed playbook.',
    };
  }
  const key = `${provider}:${transport ?? ''}:${cwd}:${codexHome ?? ''}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = provider === 'claude'
    ? await discoverClaudeSkills(cwd)
    : await discoverCodexSkills(cwd, codexHome);
  cache.set(key, { at: Date.now(), value });
  return value;
}
