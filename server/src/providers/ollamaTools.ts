// Server-side tool runtime for the Ollama primary path (plan §5.4 / §8.1
// Path A). The Ollama HTTP API is stateless: the model emits `tool_calls`
// and the *caller* is responsible for executing them and feeding results
// back. Subprocess providers (Claude/Codex/Gemini) own their own tool
// runtimes inside the CLI; for Ollama, Archon is the runtime.
//
// Security model — every tool path is resolved against the workflow cwd
// and rejected if the resolved path escapes. The Ollama branch is the only
// way a local model can touch the filesystem in Archon, and a model trained
// on adversarial corpora is not assumed safe — without this guard, a single
// `Read {file_path: "/etc/shadow"}` call would succeed. Path validation
// happens here (not in the loop layer) so a future allowlist expansion
// can't accidentally bypass it.
//
// v1 allowlist: Read / Grep / Glob / Write. Bash lands in Phase B (plan
// suggested-execution-order §1–2). WebFetch and anything network-touching
// are explicitly out of scope for v1 (plan §8.1).

import { promises as fs } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { spawn } from 'node:child_process';
import dns from 'node:dns/promises';

// Per-tool output cap. Larger than a single-line tool result needs to be,
// smaller than anything that could meaningfully bloat a turn's input
// tokens. Read/Grep results above this get truncated with a notice; the
// model can re-narrow the query rather than swallowing 5MB of node_modules.
const TOOL_OUTPUT_CAP = 64 * 1024;

// Read byte cap. Tighter than Claude's 256KB because local-model context
// windows are smaller (qwen3.6-coder: 96K total at our Modelfile setting)
// and a single Read can blow context on its own. 32KB ≈ 8K tokens,
// comfortable for any single-file ask. Models that genuinely need more
// can chunk via `offset` + `limit` (line-addressed, Claude-compatible
// shape) — §9 verification surfaced this as a real footgun when the model
// fired 5 parallel Reads of design docs and overflowed the context window.
const READ_BYTE_CAP = 32 * 1024;

// Grep walk cap — bound the worst-case "no glob, recurse the whole repo"
// case. Files past this limit get skipped with a notice.
const GREP_WALK_FILE_CAP = 5000;

// Bash timeouts. Default chosen to be long enough for typical builds /
// test runs but short enough that a wedged tool call doesn't block the
// operator turn for ages. Max matches Claude's bash tool ceiling.
const BASH_TIMEOUT_DEFAULT_MS = 60_000;
const BASH_TIMEOUT_MAX_MS = 10 * 60_000;
const BASH_TIMEOUT_MIN_MS = 1_000;

// Web tool timeouts.
const WEBSEARCH_TIMEOUT_MS = 10_000;
const WEBFETCH_FAST_TIMEOUT_MS = 10_000;
const WEBFETCH_STEALTH_TIMEOUT_MS = 30_000;

// SearXNG endpoint — operator's local meta-search instance. Hardcoded
// rather than env-var because the SSRF guard below blocks the model from
// calling 127.0.0.1 directly via WebFetch; this is the *internal* call
// from the WebSearch executor, which bypasses the guard intentionally.
const SEARXNG_URL = process.env.ARCHON_SEARXNG_URL ?? 'http://127.0.0.1:8888';

// Camoufox interpreter path. Configurable in case the operator moves the
// venv; defaults to /opt/camoufox.
const CAMOUFOX_PYTHON = process.env.ARCHON_CAMOUFOX_PYTHON ?? '/opt/camoufox/bin/python';

// Default skip-directories for Grep recursion. Mirrors the safety footer's
// "skip node_modules / .git / .cache" guidance.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.archon',
  'dist',
  'build',
  '.next',
  '.cache',
  'target',
  '.venv',
  'venv',
]);

export interface OllamaToolContext {
  cwd: string;
  abortSignal?: AbortSignal;
  workflowId?: string;
  clusterId?: string;
}

export interface OllamaToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

type OllamaToolExecutor = (
  args: Record<string, unknown>,
  ctx: OllamaToolContext,
) => Promise<string>;

interface OllamaToolEntry {
  def: OllamaToolDefinition;
  execute: OllamaToolExecutor;
  clusterOnly?: boolean;
}

// Resolve `p` against `cwd` and refuse anything that escapes. Both relative
// (`../foo`) and absolute (`/etc/passwd`) escapes get caught — `relative()`
// returns a `..`-prefixed string for both, which is the canonical "not under
// base" signal in Node's path module.
export function resolveWithinCwd(cwd: string, p: string): string {
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error('path must be a non-empty string');
  }
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  const rel = relative(resolve(cwd), abs);
  if (rel === '' || rel === '.') return abs;
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path "${p}" escapes workflow cwd`);
  }
  return abs;
}

function asString(v: unknown, name: string): string {
  if (typeof v !== 'string') throw new Error(`argument "${name}" must be a string`);
  return v;
}

function asOptionalString(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`argument "${name}" must be a string`);
  return v;
}

function asOptionalBool(v: unknown, name: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new Error(`argument "${name}" must be a boolean`);
  return v;
}

function truncate(text: string, cap: number, what: string): string {
  if (text.length <= cap) return text;
  return text.slice(0, cap) + `\n\n[truncated — ${what} exceeded ${cap} bytes]`;
}

// ── Read ──────────────────────────────────────────────────────────────────

const ReadTool: OllamaToolEntry = {
  def: {
    type: 'function',
    function: {
      name: 'Read',
      description:
        'Read the contents of a file at the given path. The path must be inside the workflow cwd (relative paths are resolved against cwd). Default returns up to 32 KB; for larger files use `offset` + `limit` to read a specific line range. Don\'t fire many parallel Reads of large files — the local context window is finite and 5 large Reads will overflow it.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Path to the file. Relative paths resolve against cwd; absolute paths must still resolve to a location inside cwd.',
          },
          offset: {
            type: 'number',
            description: 'Optional 1-based starting line number. Default 1.',
          },
          limit: {
            type: 'number',
            description: 'Optional max lines to return. Output is also byte-capped at 32 KB regardless of line count.',
          },
        },
        required: ['file_path'],
      },
    },
  },
  execute: async (args, ctx) => {
    const filePath = asString(args.file_path, 'file_path');
    const rawOffset = args.offset;
    const rawLimit = args.limit;
    const offset = typeof rawOffset === 'number' && Number.isFinite(rawOffset) && rawOffset >= 1
      ? Math.floor(rawOffset)
      : 1;
    const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit >= 1
      ? Math.floor(rawLimit)
      : undefined;
    const abs = resolveWithinCwd(ctx.cwd, filePath);
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) {
      throw new Error(`"${filePath}" is a directory; use Glob to list contents`);
    }
    const buf = await fs.readFile(abs);
    const text = buf.toString('utf8');
    // Line-slice when offset/limit given. Otherwise return whole file but cap.
    let body = text;
    let totalLines = -1;
    if (offset > 1 || limit !== undefined) {
      const lines = text.split('\n');
      totalLines = lines.length;
      const start = Math.min(offset - 1, lines.length);
      const end = limit === undefined ? lines.length : Math.min(start + limit, lines.length);
      body = lines.slice(start, end).join('\n');
    }
    // Hard byte cap regardless of line params.
    if (body.length > READ_BYTE_CAP) {
      const note = totalLines > 0
        ? `\n\n[truncated at ${READ_BYTE_CAP} bytes — file has ${totalLines} lines; use offset+limit to read a smaller range]`
        : `\n\n[truncated at ${READ_BYTE_CAP} bytes — pass offset+limit to read a specific line range]`;
      body = body.slice(0, READ_BYTE_CAP) + note;
    }
    return body;
  },
};

// ── Glob ──────────────────────────────────────────────────────────────────

const GlobTool: OllamaToolEntry = {
  def: {
    type: 'function',
    function: {
      name: 'Glob',
      description:
        'List files matching a glob pattern (e.g. "**/*.ts", "src/**/*.{ts,tsx}"). Searches under the workflow cwd unless `path` narrows the base.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob pattern. Supports `**`, `*`, `?`, `{a,b}`.',
          },
          path: {
            type: 'string',
            description: 'Optional base directory inside cwd to search under. Defaults to cwd.',
          },
        },
        required: ['pattern'],
      },
    },
  },
  execute: async (args, ctx) => {
    const pattern = asString(args.pattern, 'pattern');
    const basePath = asOptionalString(args.path, 'path');
    const baseAbs = basePath ? resolveWithinCwd(ctx.cwd, basePath) : resolve(ctx.cwd);
    const out: string[] = [];
    // Node 22 fs.promises.glob lives on the namespace import. Pattern is
    // resolved relative to `cwd: baseAbs`, so absolute-style patterns are
    // not allowed (which is what we want — keeps results inside the base).
    for await (const entry of (fs as unknown as { glob: (p: string, o: { cwd: string }) => AsyncIterable<string> }).glob(pattern, { cwd: baseAbs })) {
      // Each entry is relative to baseAbs. Re-validate to catch any escape
      // (e.g. a symlink that resolves outside cwd is still caught here).
      try {
        resolveWithinCwd(ctx.cwd, join(baseAbs, entry));
      } catch {
        continue;
      }
      out.push(entry);
      if (out.length >= 1000) break;
    }
    if (out.length === 0) return '(no matches)';
    return truncate(out.join('\n'), TOOL_OUTPUT_CAP, 'Glob result');
  },
};

// ── Grep ──────────────────────────────────────────────────────────────────

// Walk a directory yielding file paths, skipping known-noisy directories.
// We don't shell out to ripgrep — it's not guaranteed installed (the
// operator's box doesn't have it as of 2026-04-26). POSIX walk is fine for
// the v1 use case and avoids a system dep flag.
async function* walkFiles(dir: string, skip: Set<string>, fileCap: number, counter: { n: number }): AsyncGenerator<string> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (counter.n >= fileCap) return;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (skip.has(ent.name)) continue;
      yield* walkFiles(full, skip, fileCap, counter);
    } else if (ent.isFile()) {
      counter.n++;
      yield full;
    }
  }
}

const GrepTool: OllamaToolEntry = {
  def: {
    type: 'function',
    function: {
      name: 'Grep',
      description:
        'Search file contents for a regular expression. Results are matched lines (with file:line: prefix) unless `files_only` is true. Recurses under the workflow cwd, skipping node_modules, .git, dist, etc.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regular expression (JavaScript flavor) to match against file lines.',
          },
          path: {
            type: 'string',
            description: 'Optional base path inside cwd. Defaults to cwd.',
          },
          case_insensitive: {
            type: 'boolean',
            description: 'Case-insensitive match. Defaults to false.',
          },
          files_only: {
            type: 'boolean',
            description: 'If true, return only the file paths that contain a match (no line content).',
          },
        },
        required: ['pattern'],
      },
    },
  },
  execute: async (args, ctx) => {
    const pattern = asString(args.pattern, 'pattern');
    const basePath = asOptionalString(args.path, 'path');
    const ci = asOptionalBool(args.case_insensitive, 'case_insensitive') ?? false;
    const filesOnly = asOptionalBool(args.files_only, 'files_only') ?? false;
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, ci ? 'i' : '');
    } catch (err) {
      throw new Error(`invalid regex: ${err instanceof Error ? err.message : String(err)}`);
    }
    const baseAbs = basePath ? resolveWithinCwd(ctx.cwd, basePath) : resolve(ctx.cwd);
    const out: string[] = [];
    let bytes = 0;
    const counter = { n: 0 };
    for await (const filePath of walkFiles(baseAbs, SKIP_DIRS, GREP_WALK_FILE_CAP, counter)) {
      let buf: Buffer;
      try {
        buf = await fs.readFile(filePath);
      } catch {
        continue;
      }
      // Skip likely-binary files (NUL byte in first 1KB).
      if (buf.subarray(0, 1024).includes(0)) continue;
      const text = buf.toString('utf8');
      const rel = relative(ctx.cwd, filePath);
      if (filesOnly) {
        if (regex.test(text)) {
          out.push(rel);
          bytes += rel.length + 1;
        }
      } else {
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            const entry = `${rel}:${i + 1}: ${lines[i]}`;
            out.push(entry);
            bytes += entry.length + 1;
            if (bytes >= TOOL_OUTPUT_CAP) break;
          }
        }
      }
      if (bytes >= TOOL_OUTPUT_CAP) break;
    }
    if (out.length === 0) return '(no matches)';
    const joined = out.join('\n');
    let suffix = '';
    if (counter.n >= GREP_WALK_FILE_CAP) {
      suffix = `\n\n[walk capped at ${GREP_WALK_FILE_CAP} files — narrow the search with \`path\` to see more]`;
    }
    return truncate(joined + suffix, TOOL_OUTPUT_CAP, 'Grep result');
  },
};

// ── Write ─────────────────────────────────────────────────────────────────

const WriteTool: OllamaToolEntry = {
  def: {
    type: 'function',
    function: {
      name: 'Write',
      description:
        'Write `content` to a file at `file_path`, replacing any existing contents. Creates parent directories as needed. Path must resolve inside the workflow cwd.',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Target path. Relative paths resolve against cwd.',
          },
          content: {
            type: 'string',
            description: 'New file contents.',
          },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  execute: async (args, ctx) => {
    const filePath = asString(args.file_path, 'file_path');
    const content = asString(args.content, 'content');
    const abs = resolveWithinCwd(ctx.cwd, filePath);
    // Refuse to clobber a directory with a file write.
    try {
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) {
        throw new Error(`"${filePath}" is an existing directory`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    // mkdir -p the parent. join + dirname avoid resolving outside cwd
    // because resolveWithinCwd already validated `abs`.
    const parent = abs.slice(0, abs.lastIndexOf('/'));
    if (parent && parent !== resolve(ctx.cwd)) {
      await fs.mkdir(parent, { recursive: true });
    }
    await fs.writeFile(abs, content, 'utf8');
    return `wrote ${content.length} bytes to ${relative(ctx.cwd, abs)}`;
  },
};

// ── WebSearch ─────────────────────────────────────────────────────────────

interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
  engine?: string;
}

const WebSearchTool: OllamaToolEntry = {
  def: {
    type: 'function',
    function: {
      name: 'WebSearch',
      description:
        'Search the web via the operator\'s local SearXNG meta-search instance. Returns the top results as a markdown list of "title — url\\n  snippet". Use this to find URLs to fetch with WebFetch; the snippets are too short for a real answer.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query. Supports SearXNG bang syntax (e.g. `!g foo` forces Google, `!ddg foo` forces DuckDuckGo).',
          },
          max_results: {
            type: 'number',
            description: 'How many top results to return. Default 5, max 10.',
          },
        },
        required: ['query'],
      },
    },
  },
  execute: async (args, ctx) => {
    const query = asString(args.query, 'query');
    const rawMax = args.max_results;
    const maxResults = typeof rawMax === 'number' && Number.isFinite(rawMax)
      ? Math.max(1, Math.min(10, Math.round(rawMax)))
      : 5;
    const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBSEARCH_TIMEOUT_MS);
    const onAbort = (): void => controller.abort();
    ctx.abortSignal?.addEventListener('abort', onAbort, { once: true });
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted && !ctx.abortSignal?.aborted) {
        return `[error] WebSearch timed out after ${WEBSEARCH_TIMEOUT_MS}ms — is SearXNG running on ${SEARXNG_URL}?`;
      }
      return `[error] WebSearch request failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      clearTimeout(timer);
      ctx.abortSignal?.removeEventListener('abort', onAbort);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return `[error] WebSearch HTTP ${res.status}: ${detail.slice(0, 200)}`;
    }
    const data = await res.json() as { results?: SearxngResult[] };
    const results = (data.results ?? []).slice(0, maxResults);
    if (results.length === 0) {
      return `(no results for "${query}")`;
    }
    const lines: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const title = (r.title ?? '(untitled)').replace(/\s+/g, ' ').trim();
      const url = r.url ?? '';
      const snippet = (r.content ?? '').replace(/\s+/g, ' ').trim();
      lines.push(`${i + 1}. **${title}** — ${url}`);
      if (snippet) lines.push(`   ${snippet}`);
    }
    return truncate(lines.join('\n'), TOOL_OUTPUT_CAP, 'WebSearch result');
  },
};

// ── WebFetch ──────────────────────────────────────────────────────────────

// SSRF guard — refuse private/loopback/link-local targets so the model
// can't poke the local Ollama daemon, the SearXNG instance, the dev
// server, or cloud-metadata endpoints. Models trained on adversarial
// data have no business reaching internal services. Operators who *want*
// to fetch a localhost URL can do it via Bash + curl in AUTO mode (their
// own choice, explicitly).
function isPrivateOrLoopbackHost(host: string): boolean {
  const lc = host.toLowerCase();
  if (lc === 'localhost' || lc.endsWith('.localhost')) return true;
  // IPv4 literal
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lc);
  if (v4) {
    const [a, b] = [parseInt(v4[1], 10), parseInt(v4[2], 10)];
    if (a === 127) return true;                                   // 127/8 loopback
    if (a === 10) return true;                                    // 10/8 private
    if (a === 172 && b >= 16 && b <= 31) return true;             // 172.16/12 private
    if (a === 192 && b === 168) return true;                      // 192.168/16 private
    if (a === 169 && b === 254) return true;                      // 169.254/16 link-local (incl. cloud metadata)
    if (a === 0) return true;                                     // 0/8 unspecified
    return false;
  }
  // IPv6 literal — quick checks for the most common private forms.
  if (lc === '::1' || lc.startsWith('::1')) return true;          // loopback
  if (lc.startsWith('fc') || lc.startsWith('fd')) return true;    // fc00::/7 unique-local
  if (lc.startsWith('fe80')) return true;                         // fe80::/10 link-local
  return false;
}

interface FetchOutcome {
  ok: boolean;
  status?: number;
  contentType?: string;
  text: string;
  reason?: string;
}

async function fastFetch(targetUrl: string, signal: AbortSignal): Promise<FetchOutcome> {
  let res: Response;
  try {
    res = await fetch(targetUrl, {
      signal,
      redirect: 'follow',
      headers: {
        // Pretend to be a normal browser for sites that 403 on default
        // node fetch UA. Stealth path covers the harder cases.
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });
  } catch (err) {
    return { ok: false, text: '', reason: err instanceof Error ? err.message : String(err) };
  }
  const contentType = res.headers.get('content-type') ?? '';
  // Read up to 2x the cap so post-strip we still have a shot at filling
  // the budget. Beyond that we truncate.
  const buf = await res.arrayBuffer();
  const raw = new TextDecoder('utf-8', { fatal: false }).decode(buf).slice(0, TOOL_OUTPUT_CAP * 2);
  return { ok: res.ok, status: res.status, contentType, text: raw };
}

// Cheap HTML→text. Strips <script> and <style> blocks, replaces line-
// breaking tags with newlines, decodes the most common entities, and
// strips remaining tags. Not a real DOM extractor — but good enough for
// the model to read the page's prose, and zero deps.
function stripHtml(html: string): string {
  let s = html;
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<!--([\s\S]*?)-->/g, ' ');
  s = s.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/table|hr)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/gi, ' ')
       .replace(/&amp;/gi, '&')
       .replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>')
       .replace(/&quot;/gi, '"')
       .replace(/&#39;/g, "'")
       .replace(/&apos;/gi, "'")
       .replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(parseInt(n, 10)))
       .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function looksBlocked(outcome: FetchOutcome): boolean {
  if (!outcome.ok) return true;
  if (outcome.text.length < 200) return true;
  const lc = outcome.text.toLowerCase().slice(0, 4096);
  if (lc.includes('cf-chl-bypass') || lc.includes('cloudflare') && lc.includes('challenge')) return true;
  if (lc.includes('checking your browser') || lc.includes('verify you are human')) return true;
  if (lc.includes('captcha') && lc.includes('challenge')) return true;
  return false;
}

async function stealthFetch(targetUrl: string, abortSignal: AbortSignal | undefined): Promise<FetchOutcome> {
  // Inline Python launches Camoufox, navigates, prints inner_text. URL is
  // passed via env var so we never interpolate it into the script body
  // (no Python-injection surface). The script runs under the camoufox
  // venv's interpreter; if /opt/camoufox isn't installed we surface that
  // explicitly rather than letting the model see a confusing ENOENT.
  const script = [
    'import os, sys',
    'from camoufox.sync_api import Camoufox',
    'url = os.environ["CAMOUFOX_URL"]',
    'with Camoufox(headless=True) as browser:',
    '    page = browser.new_page()',
    '    page.goto(url, wait_until="domcontentloaded", timeout=20000)',
    '    page.wait_for_timeout(1500)',
    '    sys.stdout.write(page.inner_text("body"))',
  ].join('\n');

  return new Promise<FetchOutcome>((resolveResult) => {
    const child = spawn(CAMOUFOX_PYTHON, ['-c', script], {
      env: { ...process.env, CAMOUFOX_URL: targetUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    const killTree = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, WEBFETCH_STEALTH_TIMEOUT_MS);
    const onAbort = (): void => { aborted = true; killTree(); };
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout?.on('data', (b: Buffer) => {
      if (stdout.length < TOOL_OUTPUT_CAP * 2) stdout += b.toString('utf8');
    });
    child.stderr?.on('data', (b: Buffer) => {
      if (stderr.length < 16 * 1024) stderr += b.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (abortSignal && onAbort) abortSignal.removeEventListener('abort', onAbort);
      const msg = err.message.includes('ENOENT')
        ? `Camoufox not installed at ${CAMOUFOX_PYTHON}. Stealth mode unavailable.`
        : err.message;
      resolveResult({ ok: false, text: '', reason: msg });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (abortSignal && onAbort) abortSignal.removeEventListener('abort', onAbort);
      if (timedOut) {
        resolveResult({ ok: false, text: stdout, reason: `stealth fetch timed out after ${WEBFETCH_STEALTH_TIMEOUT_MS}ms` });
        return;
      }
      if (aborted) {
        resolveResult({ ok: false, text: '', reason: 'aborted' });
        return;
      }
      if (code !== 0) {
        const tail = stderr.slice(-800).trim();
        resolveResult({ ok: false, text: stdout, reason: `camoufox exited ${code}${tail ? `: ${tail}` : ''}` });
        return;
      }
      resolveResult({ ok: true, status: 200, text: stdout });
    });
  });
}

const WebFetchTool: OllamaToolEntry = {
  def: {
    type: 'function',
    function: {
      name: 'WebFetch',
      description:
        'Fetch a URL and return its text content. Default mode is "auto": tries a fast HTTP fetch first, falls back to a real browser (Camoufox) if the page returns 403, looks Cloudflare-blocked, or comes back empty. Use "fast" for sites you know respond to plain HTTP, "stealth" for sites you know are bot-protected. Output is capped at 64 KB. Loopback / private / link-local hosts are refused — those are operator-internal services, not fair game for the model.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'http:// or https:// URL to fetch.',
          },
          mode: {
            type: 'string',
            enum: ['auto', 'fast', 'stealth'],
            description: 'Fetch strategy. Default "auto": try fast, fall back to stealth on bot-protection signals.',
          },
        },
        required: ['url'],
      },
    },
  },
  execute: async (args, ctx) => {
    const url = asString(args.url, 'url');
    const mode = (asOptionalString(args.mode, 'mode') ?? 'auto') as 'auto' | 'fast' | 'stealth';
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return `[error] invalid URL "${url}"`;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `[error] WebFetch only supports http(s); got ${parsed.protocol}`;
    }
    if (isPrivateOrLoopbackHost(parsed.hostname)) {
      return `[error] WebFetch refuses loopback / private / link-local hosts ("${parsed.hostname}"). Use WebSearch for general web search; use Bash + curl if you genuinely need an internal URL (and the operator has AUTO on).`;
    }
    // Resolve the hostname ourselves and re-validate the resolved IPs.
    // Without this, a DNS server returning a public IP to our hostname-
    // string check and a loopback IP to fetch()'s lookup (DNS rebinding)
    // would slip past the guard above. There's a residual TOCTOU window
    // (the kernel resolver re-queries when fetch runs) but this catches
    // the common case where DNS gives consistent stable answers.
    if (!/^\[?[0-9a-f.:]+\]?$/i.test(parsed.hostname)) {
      try {
        const records = await dns.lookup(parsed.hostname, { all: true });
        for (const r of records) {
          if (isPrivateOrLoopbackHost(r.address)) {
            return `[error] WebFetch refuses "${parsed.hostname}" — resolves to private/loopback IP ${r.address}.`;
          }
        }
      } catch (err) {
        return `[error] WebFetch could not resolve "${parsed.hostname}": ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const fastSignal = AbortSignal.any([
      AbortSignal.timeout(WEBFETCH_FAST_TIMEOUT_MS),
      ...(ctx.abortSignal ? [ctx.abortSignal] : []),
    ]);

    let outcome: FetchOutcome | null = null;
    let usedMode = mode;

    if (mode === 'fast' || mode === 'auto') {
      outcome = await fastFetch(parsed.toString(), fastSignal);
      usedMode = 'fast';
      if (mode === 'auto' && looksBlocked(outcome)) {
        // Fall through to stealth.
        outcome = null;
      }
    }

    if (!outcome && (mode === 'stealth' || mode === 'auto')) {
      outcome = await stealthFetch(parsed.toString(), ctx.abortSignal);
      usedMode = 'stealth';
    }

    if (!outcome) {
      return '[error] WebFetch produced no result (unreachable mode branch)';
    }
    if (!outcome.ok && !outcome.text) {
      return `[error] WebFetch (${usedMode}) failed: ${outcome.reason ?? `HTTP ${outcome.status ?? '?'}`}`;
    }
    // HTML strip only for fast-mode HTML responses; stealth's inner_text
    // is already plain text, and JSON / markdown bodies should pass
    // through verbatim.
    let body = outcome.text;
    if (usedMode === 'fast' && outcome.contentType && /html|xml/i.test(outcome.contentType)) {
      body = stripHtml(body);
    }
    const header = `[${usedMode}${outcome.status ? ` ${outcome.status}` : ''}] ${parsed.toString()}`;
    return truncate(`${header}\n\n${body}`, TOOL_OUTPUT_CAP, 'WebFetch result');
  },
};

// ── Bash ──────────────────────────────────────────────────────────────────

// Run `command` under /bin/sh -c with the workflow cwd. Capped output (64
// KB combined stdout+stderr), capped wall time (default 60s, hard ceiling
// 10min), no stdin (so accidental `read` calls don't hang). The child is
// spawned `detached:true` and killed via `process.kill(-pid, SIGKILL)` on
// timeout / abort / output-cap so the entire process tree dies — same
// pattern WorkerManager uses for its primary CLIs.
//
// Threat model: the operator opted into this when they enabled AUTO mode.
// We do NOT try to parse the command for `find /` etc. — the safety
// footer's prompt-side "please don't" plus the hard runtime caps (timeout,
// output, kernel-level RSS guard from WorkerManager) are the layered
// answer. A model intent on running `rm -rf ~` could already do it through
// Write; the right primary defense is operator awareness of AUTO mode.
async function runBashCommand(
  command: string,
  timeoutMs: number,
  ctx: OllamaToolContext,
): Promise<string> {
  return new Promise<string>((resolveResult) => {
    let stdout = '';
    let stderr = '';
    let totalBytes = 0;
    let outputCapped = false;
    let timedOut = false;
    let aborted = false;

    const child = spawn('/bin/sh', ['-c', command], {
      cwd: ctx.cwd,
      env: { ...process.env },
      // ignore stdin so commands that read from stdin don't hang waiting.
      stdio: ['ignore', 'pipe', 'pipe'],
      // session leader → process.kill(-pid) reaches all descendants.
      detached: true,
    });

    const killTree = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* already gone */ }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    let onAbort: (() => void) | null = null;
    if (ctx.abortSignal) {
      if (ctx.abortSignal.aborted) {
        aborted = true;
        killTree();
      } else {
        onAbort = (): void => {
          aborted = true;
          killTree();
        };
        ctx.abortSignal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const append = (which: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (outputCapped) return;
      const text = chunk.toString('utf8');
      const remaining = TOOL_OUTPUT_CAP - totalBytes;
      if (text.length <= remaining) {
        if (which === 'stdout') stdout += text;
        else stderr += text;
        totalBytes += text.length;
        return;
      }
      const fit = remaining > 0 ? text.slice(0, remaining) : '';
      if (fit) {
        if (which === 'stdout') stdout += fit;
        else stderr += fit;
        totalBytes += fit.length;
      }
      outputCapped = true;
      killTree();
    };

    child.stdout?.on('data', (b: Buffer) => append('stdout', b));
    child.stderr?.on('data', (b: Buffer) => append('stderr', b));

    const finish = (exitDescription: string): void => {
      clearTimeout(timer);
      if (onAbort && ctx.abortSignal) ctx.abortSignal.removeEventListener('abort', onAbort);
      const parts: string[] = [];
      if (timedOut) parts.push(`[timed out after ${timeoutMs}ms]`);
      if (aborted) parts.push('[aborted]');
      if (outputCapped) parts.push(`[output truncated at ${TOOL_OUTPUT_CAP} bytes]`);
      parts.push(exitDescription);
      const trimmedStdout = stdout.trimEnd();
      const trimmedStderr = stderr.trimEnd();
      if (trimmedStdout) parts.push('--- stdout ---', trimmedStdout);
      if (trimmedStderr) parts.push('--- stderr ---', trimmedStderr);
      if (!trimmedStdout && !trimmedStderr) parts.push('(no output)');
      resolveResult(parts.join('\n'));
    };

    child.on('error', (err) => {
      finish(`[error] failed to spawn shell: ${err.message}`);
    });

    child.on('close', (code, signal) => {
      const exitDesc = code === null
        ? `exit signal: ${signal ?? 'unknown'}`
        : `exit code: ${code}`;
      finish(exitDesc);
    });
  });
}

const BashTool: OllamaToolEntry = {
  def: {
    type: 'function',
    function: {
      name: 'Bash',
      description:
        'Run a shell command in the workflow cwd via /bin/sh -c. Captures stdout + stderr (combined cap 64 KB) and an exit code. Default timeout 60s; max 600s. Stdin is closed — commands that read stdin will not hang. Honor the safety reminders in your prompt: cap unknown-size output, no `find /` without `-maxdepth`, no unbounded journalctl, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command. Pipes, redirects, and shell builtins are supported (passed verbatim to /bin/sh -c).',
          },
          description: {
            type: 'string',
            description: 'Optional one-line description of what the command does. Surfaced to the operator in the activity tab.',
          },
          timeout: {
            type: 'number',
            description: `Override timeout in ms. Clamped to [${BASH_TIMEOUT_MIN_MS}, ${BASH_TIMEOUT_MAX_MS}]. Default ${BASH_TIMEOUT_DEFAULT_MS}.`,
          },
        },
        required: ['command'],
      },
    },
  },
  execute: async (args, ctx) => {
    const command = asString(args.command, 'command');
    const rawTimeout = args.timeout;
    let timeoutMs = BASH_TIMEOUT_DEFAULT_MS;
    if (typeof rawTimeout === 'number' && Number.isFinite(rawTimeout)) {
      timeoutMs = Math.max(BASH_TIMEOUT_MIN_MS, Math.min(BASH_TIMEOUT_MAX_MS, Math.round(rawTimeout)));
    }
    return runBashCommand(command, timeoutMs, ctx);
  },
};

// ── Cluster Peer Tools ────────────────────────────────────────────────────

function archonClusterPeerBase(ctx: OllamaToolContext): string {
  if (!ctx.clusterId || !ctx.workflowId) {
    throw new Error('cluster tool requires this workflow to be a cluster member');
  }
  const port = parseInt(process.env.ARCHON_PORT ?? '3001', 10);
  return `http://127.0.0.1:${port}/api/clusters/${encodeURIComponent(ctx.clusterId)}/peer`;
}

async function clusterFetch(ctx: OllamaToolContext, op: string, init: RequestInit): Promise<string> {
  const url = `${archonClusterPeerBase(ctx)}/${op}`;
  const res = await fetch(url, { ...init, signal: ctx.abortSignal });
  const text = await res.text();
  if (!res.ok) {
    return `[error] ${op} failed: ${text}`;
  }
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

const PeerListTool: OllamaToolEntry = {
  clusterOnly: true,
  def: {
    type: 'function',
    function: {
      name: 'peer_list',
      description:
        'List the other members of your Arco cluster, including workflowId, display name, pending mailbox depth, role, tier, and focus hints. Use this before choosing a peer.',
      parameters: { type: 'object', properties: {} },
    },
  },
  execute: async (_args, ctx) => {
    const base = archonClusterPeerBase(ctx);
    const res = await fetch(`${base}/list?workflowId=${encodeURIComponent(ctx.workflowId!)}`, {
      method: 'GET',
      signal: ctx.abortSignal,
    });
    const text = await res.text();
    if (!res.ok) return `[error] peer_list failed: ${text}`;
    return JSON.stringify(JSON.parse(text), null, 2);
  },
};

const PeerReadTool: OllamaToolEntry = {
  clusterOnly: true,
  def: {
    type: 'function',
    function: {
      name: 'peer_read',
      description:
        'Drain and read pending peer messages from your Arco cluster mailbox. Call this when the system says you have pending peer messages.',
      parameters: { type: 'object', properties: {} },
    },
  },
  execute: async (_args, ctx) => clusterFetch(ctx, 'read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflowId: ctx.workflowId }),
  }),
};

const PeerSendTool: OllamaToolEntry = {
  clusterOnly: true,
  def: {
    type: 'function',
    function: {
      name: 'peer_send',
      description:
        'Send a short note to a peer in your Arco cluster. `to` accepts full workflowId, unique 8-char prefix, unique displayName, or unique role text such as "Coordinator" when only one peer has that role. Prefer peer_list first, then use displayName/workflowId when possible. Use this for concise DONE/BLOCKED/progress reports. Do not direct other peers unless the operator assigned you a coordinator role.',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Peer workflowId, unique 8-char prefix, unique display name, or unique role text.',
          },
          content: {
            type: 'string',
            description: 'Message body, up to 16 KB.',
          },
        },
        required: ['to', 'content'],
      },
    },
  },
  execute: async (args, ctx) => clusterFetch(ctx, 'send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: ctx.workflowId,
      to: asString(args.to, 'to'),
      content: asString(args.content, 'content'),
    }),
  }),
};

const ClusterPlanReadTool: OllamaToolEntry = {
  clusterOnly: true,
  def: {
    type: 'function',
    function: {
      name: 'cluster_plan_read',
      description:
        'Read the full shared cluster plan (markdown body + title). The plan copy injected into your context may be an OUTLINE (headings + checkbox lines only) when the full plan is large - call this when you need the complete text, e.g. before cluster_plan_write. Read-only.',
      parameters: { type: 'object', properties: {} },
    },
  },
  execute: async (_args, ctx) => clusterFetch(ctx, 'plan-read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflowId: ctx.workflowId }),
  }),
};

const ClusterPlanTickTool: OllamaToolEntry = {
  clusterOnly: true,
  def: {
    type: 'function',
    function: {
      name: 'cluster_plan_tick',
      description:
        'Toggle one checkbox in the shared cluster plan. Prefer taskText as a unique substring of the item. Use only after you actually complete or un-complete the item.',
      parameters: {
        type: 'object',
        properties: {
          lineIndex: {
            type: 'number',
            description: '0-based line offset in the current plan. Mutually exclusive with taskText.',
          },
          taskText: {
            type: 'string',
            description: 'Unique case-insensitive substring of the checkbox item. Mutually exclusive with lineIndex.',
          },
        },
      },
    },
  },
  execute: async (args, ctx) => {
    const body: Record<string, unknown> = { workflowId: ctx.workflowId };
    if (typeof args.lineIndex === 'number') body.lineIndex = args.lineIndex;
    if (typeof args.taskText === 'string') body.taskText = args.taskText;
    return clusterFetch(ctx, 'plan-tick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  },
};

const ClusterPlanWriteTool: OllamaToolEntry = {
  clusterOnly: true,
  def: {
    type: 'function',
    function: {
      name: 'cluster_plan_write',
      description:
        'Write the shared cluster plan. Convention: only the director should use this. Model-driven writes are additive: preserve existing checkbox tasks and their [ ]/[x] status. Use cluster_plan_tick for status changes; ask the operator for destructive replace/clear edits. Other members should propose changes via peer_send.',
      parameters: {
        type: 'object',
        properties: {
          body: {
            type: 'string',
            description: 'New markdown plan body, non-empty and capped by Arco.',
          },
        },
        required: ['body'],
      },
    },
  },
  execute: async (args, ctx) => clusterFetch(ctx, 'plan-write', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workflowId: ctx.workflowId, body: asString(args.body, 'body') }),
  }),
};

// ── Registry ──────────────────────────────────────────────────────────────

const REGISTRY: Record<string, OllamaToolEntry> = {
  Read: ReadTool,
  Glob: GlobTool,
  Grep: GrepTool,
  Write: WriteTool,
  Bash: BashTool,
  WebSearch: WebSearchTool,
  WebFetch: WebFetchTool,
  peer_list: PeerListTool,
  peer_read: PeerReadTool,
  peer_send: PeerSendTool,
  cluster_plan_read: ClusterPlanReadTool,
  cluster_plan_tick: ClusterPlanTickTool,
  cluster_plan_write: ClusterPlanWriteTool,
};

export function getOllamaToolDefinitions(opts?: { clusterEnabled?: boolean; mailboxOnly?: boolean }): OllamaToolDefinition[] {
  return Object.values(REGISTRY)
    .filter((entry) => !entry.clusterOnly || opts?.clusterEnabled === true)
    .filter((entry) => !opts?.mailboxOnly || !entry.clusterOnly || entry.def.function.name === 'peer_send' || entry.def.function.name === 'peer_read')
    .map((entry) => entry.def);
}

export function isKnownOllamaTool(name: string): boolean {
  return name in REGISTRY;
}

// Execute a single tool call. Returns the result text. Errors (unknown tool,
// invalid args, path escape, fs failure) are stringified and returned as the
// tool result so the model can see and recover. The loop layer is dumb —
// it just appends whatever string we return as a `role:'tool'` message.
export async function executeOllamaTool(
  name: string,
  args: Record<string, unknown>,
  ctx: OllamaToolContext,
): Promise<string> {
  const entry = REGISTRY[name];
  if (!entry) {
    return `[error] unknown tool "${name}". Available: ${Object.keys(REGISTRY).join(', ')}`;
  }
  try {
    return await entry.execute(args, ctx);
  } catch (err) {
    return `[error] ${err instanceof Error ? err.message : String(err)}`;
  }
}

// Per-turn loop detector. Local thinking models (Qwen3.6, Heretic, etc.)
// occasionally fall into a "preparation loop": call Read on the same file,
// narrate "let me make the edit" in reasoning, never emit the Edit, repeat.
// Without intervention the loop runs until MAX_TOOL_TURNS aborts the worker
// — wasted tokens, no result, operator gets a failure card.
//
// The detector tracks (tool, args) calls per operator turn. When the same
// pair has been dispatched DEDUP_THRESHOLD times, the next call is intercepted
// before reaching executeOllamaTool: instead of running the tool again, the
// dispatcher returns a coaching message as the tool result. The model sees
// it on its next turn and (usually) breaks out of the loop.
//
// Threshold pick: 2 successful dispatches, coach on the 3rd attempt. First
// re-call is sometimes legit (model wants to verify after a write); a third
// identical call almost never is. Set ARCHON_LOOP_COACH_THRESHOLD to tune.
const DEFAULT_DEDUP_THRESHOLD = 2;

// After this many coaching attempts on the same (name, args) key, stop
// coaching and request termination. Coaching nudges a stuck model off a
// fence; if it ignores three nudges, more coaching just burns the
// recovery budget. Termination routes to the final-summary path in run().
const MAX_COACHED_REPEATS = 3;

function loopThreshold(): number {
  const env = process.env.ARCHON_LOOP_COACH_THRESHOLD;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 20) return n;
  }
  return DEFAULT_DEDUP_THRESHOLD;
}

export class ToolLoopDetector {
  private counts = new Map<string, number>();
  private threshold = loopThreshold();
  private terminationRequestedFlag = false;

  // Returns the dispatcher's decision for this (name, args) call:
  // - terminate=true: caller should signal the run loop to abort the turn
  //   and route to the final-summary path. Set after MAX_COACHED_REPEATS
  //   coaching attempts on the same key fail to change behavior.
  // - coach=true, terminate=false: caller should return a coaching string
  //   in place of the tool result.
  // - both false: caller should execute the tool normally.
  // Always increments the per-key counter so coach/terminate transitions
  // happen on the right attempt.
  shouldCoach(name: string, args: Record<string, unknown>): { coach: boolean; terminate: boolean; previousCount: number } {
    const key = `${name} ${JSON.stringify(args)}`;
    const prev = this.counts.get(key) ?? 0;
    this.counts.set(key, prev + 1);
    const coach = prev >= this.threshold;
    const terminate = prev >= this.threshold + MAX_COACHED_REPEATS;
    if (terminate) this.terminationRequestedFlag = true;
    return { coach, terminate, previousCount: prev };
  }

  // The run loop checks this after dispatch; true means "coaching has been
  // ignored beyond MAX_COACHED_REPEATS times, end the turn now."
  terminationRequested(): boolean {
    return this.terminationRequestedFlag;
  }

  // Stand-in tool result emitted when termination fires. The model sees a
  // clear "we are ending the loop" message; the run loop then routes to
  // the final-summary path on its next iteration check.
  terminationMessage(name: string, attemptNumber: number): string {
    return (
      `[Archon loop termination] You have called "${name}" with these exact arguments ${attemptNumber} times this turn. ` +
      `Coaching has been ignored. The tool loop is ending now and a handoff summary will be requested. ` +
      `Do not call any more tools.`
    );
  }

  // The text returned in place of the tool result. Worded so the model
  // (a) understands what's happening, (b) sees a concrete next-action menu.
  // Mentioning "your reasoning" is intentional: thinking models often have
  // already decided what to do but won't commit; pointing at their own
  // narration nudges them off the fence.
  coachingMessage(name: string, attemptNumber: number): string {
    return (
      `[Archon loop detection] You have called "${name}" with these exact arguments ${attemptNumber} times this turn. ` +
      `The tool result is unchanged and will not change on re-execution. ` +
      `Looking at your reasoning above, you have already decided what to do — execute it now. ` +
      `Choose ONE: ` +
      `(a) call a DIFFERENT tool that makes concrete progress (e.g. Edit, Write, Bash), or ` +
      `(b) produce a final text answer to the operator describing what you found and what you would do next. ` +
      `Do not call "${name}" again with the same arguments.`
    );
  }
}
