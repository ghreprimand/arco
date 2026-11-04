// Read-only discovery for sessions created by the provider CLIs. Only bounded
// portions of transcript files are read, and parsed metadata is cached by mtime.
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, win32 } from 'node:path';
import type { SessionInfo } from '@arco/shared';
import { UUID_PATTERN } from '../server/constants.js';
import { encodeProjectDir } from '../http/fileRead.js';
import { extractUserText } from './transcripts.js';

const WINDOW = 64 * 1024;
const LIMIT = 50;
const MAX_FILES = 10000;
const cache = new Map<string, { size: number; mtimeMs: number; provider: 'claude' | 'codex'; info: Parsed | null }>();
type Parsed = { id: string; cwd?: string; name: string };
type Candidate = { path: string; size: number; mtimeMs: number };

export function sameTerminalProject(a: string, b: string): boolean {
  const windows = /^[a-z]:[\\/]/i.test(a) || /^\\\\/.test(a) || /^[a-z]:[\\/]/i.test(b) || /^\\\\/.test(b);
  return windows ? win32.normalize(a).replace(/[\\/]+$/, '').toLowerCase() === win32.normalize(b).replace(/[\\/]+$/, '').toLowerCase()
    : resolve(a) === resolve(b);
}

async function entries(path: string) {
  try { return await readdir(path, { withFileTypes: true }); } catch { return []; }
}
async function candidate(path: string): Promise<Candidate | null> {
  try { const s = await stat(path); return s.isFile() && s.size ? { path, size: s.size, mtimeMs: s.mtimeMs } : null; } catch { return null; }
}
async function sample(file: Candidate): Promise<string[]> {
  const h = await open(file.path, 'r');
  try {
    const head = Buffer.alloc(Math.min(file.size, WINDOW));
    const hread = await h.read(head, 0, head.length, 0);
    const chunks = [head.subarray(0, hread.bytesRead).toString('utf8')];
    if (file.size > WINDOW) {
      const tail = Buffer.alloc(Math.min(file.size - WINDOW, WINDOW));
      const tread = await h.read(tail, 0, tail.length, file.size - tail.length);
      const text = tail.subarray(0, tread.bytesRead).toString('utf8');
      chunks.push(text.slice(text.indexOf('\n') + 1));
    }
    return chunks;
  } finally { await h.close(); }
}
const pendingParses = new Map<string, Promise<Parsed | null>>();
async function parse(file: Candidate, provider: 'claude' | 'codex'): Promise<Parsed | null> {
  const previous = cache.get(file.path);
  if (previous && previous.size === file.size && previous.mtimeMs === file.mtimeMs && previous.provider === provider) return previous.info;
  const key = `${provider}:${file.path}:${file.size}:${file.mtimeMs}`;
  const pending = pendingParses.get(key);
  if (pending) return pending;
  const request = parseSample(file, provider);
  pendingParses.set(key, request);
  try { return await request; } finally { if (pendingParses.get(key) === request) pendingParses.delete(key); }
}

async function parseSample(file: Candidate, provider: 'claude' | 'codex'): Promise<Parsed | null> {
  let id = '', cwd: string | undefined, name = '', title = '';
  try {
    const chunks = await sample(file);
    for (const line of chunks.flatMap(chunk => chunk.split('\n'))) {
      if (!line) continue;
      let e: any; try { e = JSON.parse(line); } catch { continue; }
      if (provider === 'codex' && e.type === 'session_meta') { id = typeof e.payload?.id === 'string' ? e.payload.id : id; cwd = typeof e.payload?.cwd === 'string' ? e.payload.cwd : undefined; }
      if (provider === 'codex' && !name && e.type === 'event_msg' && e.payload?.type === 'user_message' && typeof e.payload.message === 'string') name = e.payload.message;
      if (provider === 'claude' && !name && e.type === 'user') name = extractUserText(e.message?.content) || '';
      if (provider === 'claude' && e.type === 'ai-title' && typeof e.aiTitle === 'string') title = e.aiTitle;
    }
    if (provider === 'claude') id = file.path.split(/[\\/]/).at(-1)?.replace(/\.jsonl$/, '') ?? '';
  } catch { return null; }
  const info = UUID_PATTERN.test(id) ? { id, cwd, name: (title || name).trim().replace(/\s+/g, ' ').slice(0, 120) } : null;
  if (cache.size >= MAX_FILES) cache.clear();
  cache.set(file.path, { size: file.size, mtimeMs: file.mtimeMs, provider, info });
  return info;
}

// Coalesce simultaneous project cards so each Codex history tree is walked once.
const codexScans = new Map<string, Promise<Candidate[]>>();
async function codexCandidates(home: string): Promise<Candidate[]> {
  const prior = codexScans.get(home);
  if (prior) return prior;
  const scan = (async () => {
    const found: Candidate[] = [];
    const root = join(home, 'sessions');
    let seen = 0;
    for (const year of (await entries(root)).filter(e => e.isDirectory() && /^\d{4}$/.test(e.name)).sort((a,b) => b.name.localeCompare(a.name))) {
      for (const month of (await entries(join(root, year.name))).filter(e => e.isDirectory() && /^\d{2}$/.test(e.name)).sort((a,b) => b.name.localeCompare(a.name))) {
        for (const day of (await entries(join(root, year.name, month.name))).filter(e => e.isDirectory() && /^\d{2}$/.test(e.name)).sort((a,b) => b.name.localeCompare(a.name))) {
          const dir = join(root, year.name, month.name, day.name);
          for (const ent of (await entries(dir)).filter(e => e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)).sort((a,b) => b.name.localeCompare(a.name))) {
            if (++seen > MAX_FILES) break;
            const c = await candidate(join(dir, ent.name)); if (c) found.push(c);
          }
          if (seen > MAX_FILES) break;
        }
        if (seen > MAX_FILES) break;
      }
      if (seen > MAX_FILES) break;
    }
    return found;
  })();
  codexScans.set(home, scan);
  try { return await scan; } finally { if (codexScans.get(home) === scan) codexScans.delete(home); }
}

export async function discoverTerminalSessions(cwd: string, homes: { claude: string; codex: string } = {
  claude: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
  codex: process.env.CODEX_HOME || join(homedir(), '.codex'),
}): Promise<SessionInfo[]> {
  if (!cwd || (!isAbsolute(cwd) && !win32.isAbsolute(cwd))) return [];
  const claudeFiles: Candidate[] = [], codexFiles: Candidate[] = [];
  const claudeDir = join(homes.claude, 'projects', encodeProjectDir(cwd));
  for (const ent of (await entries(claudeDir)).slice(0, MAX_FILES)) {
    if (!ent.isFile() || !UUID_PATTERN.test(ent.name.replace(/\.jsonl$/, '')) || !ent.name.endsWith('.jsonl')) continue;
    const c = await candidate(join(claudeDir, ent.name)); if (c) claudeFiles.push(c);
  }
  codexFiles.push(...await codexCandidates(homes.codex));
  const result: SessionInfo[] = [];
  for (const [provider, files] of [['claude', claudeFiles], ['codex', codexFiles]] as const) {
    let count = 0;
    for (const file of files.sort((a,b) => b.mtimeMs - a.mtimeMs)) {
      const parsed = await parse(file, provider);
      if (!parsed || (provider === 'codex' && (!parsed.cwd || !sameTerminalProject(parsed.cwd, cwd)))) continue;
      result.push({ sessionId: parsed.id, cwd, name: parsed.name, startedAt: file.mtimeMs, provider });
      if (++count === LIMIT) break;
    }
  }
  return result.sort((a,b) => b.startedAt - a.startedAt);
}
