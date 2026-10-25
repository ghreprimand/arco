// ── Local service discovery engine (ARCO_OPS_PLAN.md §L1, Part L) ──
//
// Enumerates local listening TCP sockets and resolves each to its process /
// cwd / framework, behind GET /api/services. READ-ONLY: this module only reads
// sockets and process metadata — no kill, no mutation, no writes (kill is L2).
//
// Ported from an earlier LocalWebManager prototype (scanner.py) (Python +
// psutil). The framework signature table, web-process markers, web-port set, and
// friendly-name-from-cwd logic are carried over VERBATIM (same substrings,
// labels, emojis, order) — that fidelity is the value of the port. What is NOT
// ported is psutil itself: there is no psutil in Node, so socket enumeration is
// rewritten on top of OS tools.
//
// DISCOVERY MECHANISM (cross-platform — Linux AND macOS):
//   1. `lsof -nP -iTCP -sTCP:LISTEN` lists every listening TCP socket with its
//      pid + bind host:port. We use lsof, NOT Linux-only `ss` / /proc/net/tcp
//      parsing, because Arco must also run on macOS where those don't exist.
//   2. Per pid, resolve name/cmdline via /proc/<pid>/cmdline (NUL-separated) on
//      Linux — a fast no-spawn path — falling back to `ps -p <pid> -o
//      comm=,args=` on macOS / when /proc is absent.
//   3. Per pid, resolve cwd via the /proc/<pid>/cwd symlink readlink on Linux,
//      falling back to `lsof -a -p <pid> -d cwd -Fn` elsewhere.
//
// All subprocess calls go through execFile (argv array, NO shell:true) with a
// timeout + bounded maxBuffer (mirrors server/src/diagnostics/checks.ts and
// endpointDiscovery.ts). A missing lsof binary (ENOENT) degrades to an empty
// list + an explanatory `detail` — the endpoint NEVER throws. A single
// unreadable/exited process degrades to partial info (unknown cmdline/cwd, name
// from lsof's COMMAND column) — never fails the whole scan.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { basename } from 'node:path';
import { existsSync } from 'node:fs';

import type { LocalService, ServicesResponse } from '@arco/shared';

const execFileAsync = promisify(execFile);

// Per-spawn ceilings. lsof is the one call that can be large (every socket on
// the box); the per-pid resolvers are tiny.
const EXEC_TIMEOUT_MS = 5000;
const EXEC_MAX_BUFFER = 4 * 1024 * 1024;

// /proc exists on Linux (the fast no-spawn path); macOS has neither, so we
// branch on process.platform AND the actual presence of /proc to stay correct
// under odd mounts.
const HAS_PROC = process.platform === 'linux' && existsSync('/proc');

// LOCAL_HOSTS — ported verbatim from scanner.py line ~11. We LIST these bind
// addresses (do not filter out 0.0.0.0 / private); the source accepts them too.
const LOCAL_HOSTS = new Set(['127.0.0.1', '::1', '0.0.0.0', '::', 'localhost']);

// ── Ported framework table (scanner.py line ~79) ─────────────────────────────
// 27 entries, VERBATIM: same substrings, labels, emojis, and order. First-match
// substring search wins (_detect_framework). DO NOT reorder or relabel — the
// order is load-bearing (e.g. "next" before "nuxt" doesn't apply here, but
// "vite"/"next"/etc. order mirrors the source so behavior matches 1:1).
const FRAMEWORK_SIGNATURES: ReadonlyArray<readonly [string, string, string]> = [
  ['vite', 'Vite', '⚡'],
  ['next', 'Next.js', '▲'],
  ['nuxt', 'Nuxt', '💚'],
  ['astro', 'Astro', '🚀'],
  ['svelte', 'SvelteKit', '🔥'],
  ['remix', 'Remix', '💿'],
  ['webpack', 'Webpack', '📦'],
  ['parcel', 'Parcel', '📦'],
  ['react-scripts', 'Create React App', '⚛️'],
  ['ng serve', 'Angular CLI', '🅰️'],
  ['flask', 'Flask', '🐍'],
  ['django', 'Django', '🐍'],
  ['uvicorn', 'Uvicorn', '🦄'],
  ['gunicorn', 'Gunicorn', '🦄'],
  ['fastapi', 'FastAPI', '⚡'],
  ['http.server', 'Python HTTP', '🐍'],
  ['rails server', 'Rails', '💎'],
  ['hugo', 'Hugo', '📝'],
  ['php -s', 'PHP Built-in', '🐘'],
  ['gatsby', 'Gatsby', '💜'],
  ['express', 'Express', '🟢'],
  ['fastify', 'Fastify', '🟢'],
  ['hono', 'Hono', '🔥'],
  ['elysia', 'Elysia', '🦊'],
  ['bun', 'Bun', '🍞'],
  ['deno', 'Deno', '🦕'],
  ['tsx', 'TSX', '📘'],
];

// Web-process markers (scanner.py line ~45, _is_likely_web_process) — VERBATIM.
const WEB_PROCESS_MARKERS: readonly string[] = [
  'vite',
  'next',
  'astro',
  'webpack',
  'parcel',
  'react-scripts',
  'ng serve',
  'nuxt',
  'svelte',
  'flask',
  'django',
  'uvicorn',
  'gunicorn',
  'http.server',
  'php -s',
  'rails server',
  'hugo',
];

// Common web-port set (scanner.py line ~146, _is_likely_web_service) — VERBATIM.
const COMMON_WEB_PORTS = new Set([
  3000, 3001, 4173, 4321, 5000, 5173, 5174, 5180, 5181, 5182, 8000, 8080, 8081,
  8088, 8787, 8888, 9000,
]);

// Web keyword set (scanner.py line ~171) — VERBATIM.
const WEB_KEYWORDS: readonly string[] = ['server', 'dev', 'preview', 'start'];

// ── Ported pure helpers ──────────────────────────────────────────────────────

// scanner.py _detect_framework (line ~110): first-match substring search over
// "{procName} {cmdline}".toLowerCase().
function detectFramework(cmdline: string, processName: string): [string | null, string | null] {
  const haystack = `${processName} ${cmdline}`.toLowerCase();
  for (const [marker, label, emoji] of FRAMEWORK_SIGNATURES) {
    if (haystack.includes(marker)) return [label, emoji];
  }
  return [null, null];
}

// scanner.py _is_likely_web_process (line ~45).
function isLikelyWebProcess(cmdline: string, processName: string): boolean {
  const haystack = `${processName} ${cmdline}`.toLowerCase();
  return WEB_PROCESS_MARKERS.some((m) => haystack.includes(m));
}

// scanner.py _is_likely_web_service (line ~146): web-process OR a known web port
// OR an unprivileged registered port whose cmdline carries a web keyword.
function isLikelyWebService(processName: string, cmdline: string, port: number): boolean {
  if (isLikelyWebProcess(cmdline, processName)) return true;
  if (COMMON_WEB_PORTS.has(port)) return true;
  const lower = cmdline.toLowerCase();
  return port >= 1024 && port <= 49151 && WEB_KEYWORDS.some((t) => lower.includes(t));
}

// scanner.py _app_name_from_cwd (line ~69), adapted to the LocalService.appName
// contract: '' (not "unknown") when there's no usable cwd.
function appNameFromCwd(cwd: string | null): string {
  if (!cwd) return '';
  const name = basename(cwd);
  if (!name || name === '/') return '';
  return name;
}

// scanner.py _make_friendly_name (line ~119): title-cased project folder +
// framework label, with a process-name middle ground and a port fallback.
function makeFriendlyName(
  appName: string,
  framework: string | null,
  port: number,
  processName: string,
): string {
  const parts: string[] = [];

  if (appName && appName !== 'unknown') {
    // Slug → Title Case: '-'/'_' → space, capitalize each word (Python .title()).
    const pretty = appName
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
    parts.push(pretty);
  }

  if (framework) {
    parts.push(framework);
  } else if (!['unknown', 'node', 'python3', 'python', 'ruby', ''].includes(processName)) {
    parts.push(processName);
  }

  if (parts.length === 0) return `Service on port ${port}`;
  return parts.join(' · ');
}

// scanner.py _is_local_address (line ~30): keep loopback / wildcard / private.
// We LIST every local LISTEN socket (do not drop 0.0.0.0 / ::) per the spec.
function isLocalAddress(host: string): boolean {
  if (!host) return true;
  if (LOCAL_HOSTS.has(host)) return true;
  if (host.startsWith('127.')) return true;
  return false;
}

// ── Socket enumeration ───────────────────────────────────────────────────────

interface RawSocket {
  pid: number | null;
  command: string; // lsof COMMAND column — a name fallback when cmdline is unreadable
  host: string;
  port: number;
}

// Parse `lsof -nP -iTCP -sTCP:LISTEN` default tabular output. Columns:
//   COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
// where NAME is e.g. "127.0.0.1:5173 (LISTEN)" or "*:8080 (LISTEN)" or
// "[::1]:3001 (LISTEN)". We split the host:port off NAME, normalizing "*" → the
// IPv4 wildcard 0.0.0.0 to match the source's LOCAL_HOSTS handling.
function parseLsof(stdout: string): RawSocket[] {
  const out: RawSocket[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('COMMAND')) continue;
    const cols = trimmed.split(/\s+/);
    if (cols.length < 9) continue;
    const command = cols[0];
    const pid = Number.parseInt(cols[1], 10);
    // NAME may contain spaces ("(LISTEN)"); the address is the first NAME token.
    const name = cols.slice(8).join(' ');
    const addr = name.split(/\s+/)[0]; // strip "(LISTEN)"
    // Split host:port from the right — IPv6 hosts contain colons, so rsplit once.
    const lastColon = addr.lastIndexOf(':');
    if (lastColon < 0) continue;
    let host = addr.slice(0, lastColon);
    const port = Number.parseInt(addr.slice(lastColon + 1), 10);
    if (!Number.isFinite(port)) continue;
    // Strip [..] off bracketed IPv6 literals; map wildcards to a concrete host.
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    if (host === '*' || host === '') host = '0.0.0.0';
    out.push({ pid: Number.isFinite(pid) ? pid : null, command, host, port });
  }
  return out;
}

// ── Per-pid resolvers (cross-platform) ───────────────────────────────────────

// cmdline: /proc fast-path on Linux (NUL-separated argv), `ps` fallback
// elsewhere. Returns '' when unreadable (exited / permission denied) so a single
// dead process degrades to partial info rather than failing the scan.
async function resolveCmdline(pid: number): Promise<string> {
  if (HAS_PROC) {
    try {
      const raw = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8');
      // argv is NUL-separated with a trailing NUL; join with spaces.
      const parts = raw.split('\0').filter((p) => p.length > 0);
      if (parts.length > 0) return parts.join(' ');
      // Empty cmdline (kernel threads) — fall through to ps for an args= guess.
    } catch {
      // Process gone or unreadable — fall through to ps (it may still answer).
    }
  }
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'args='], {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
    });
    return stdout.split('\n')[0]?.trim() ?? '';
  } catch {
    return '';
  }
}

// processName: `ps -o comm=` (works on Linux + macOS). lsof's COMMAND column is
// the ultimate fallback (passed in), so this only needs to refine it.
async function resolveProcessName(pid: number, fallback: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'comm='], {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
    });
    const name = stdout.split('\n')[0]?.trim();
    // ps comm= may be a full path on some systems; take the basename.
    return name ? basename(name) : fallback || 'unknown';
  } catch {
    return fallback || 'unknown';
  }
}

// cwd: /proc/<pid>/cwd symlink readlink on Linux; `lsof -a -p <pid> -d cwd -Fn`
// fallback (macOS / no /proc). The -Fn lsof output emits the cwd path on a line
// prefixed 'n'. Returns null when unreadable.
async function resolveCwd(pid: number): Promise<string | null> {
  if (HAS_PROC) {
    try {
      return await fs.readlink(`/proc/${pid}/cwd`);
    } catch {
      // Permission denied / gone — fall through to lsof.
    }
  }
  try {
    const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
    });
    for (const line of stdout.split('\n')) {
      if (line.startsWith('n')) return line.slice(1).trim() || null;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Top-level discovery ──────────────────────────────────────────────────────

export async function discoverServices(): Promise<ServicesResponse> {
  const generatedAt = Date.now();

  let stdout: string;
  try {
    const r = await execFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: EXEC_MAX_BUFFER,
    });
    stdout = r.stdout;
  } catch (err: unknown) {
    // ENOENT = no lsof on PATH. Degrade to an empty list + explanatory detail;
    // NEVER throw out of the endpoint. lsof also exits non-zero when it has
    // nothing to report on some systems, but it still prints to stdout in that
    // case — a true spawn failure (ENOENT/timeout) is what lands here.
    const code = (err as NodeJS.ErrnoException)?.code;
    const detail =
      code === 'ENOENT'
        ? 'lsof not found on PATH — cannot enumerate listening sockets. Install lsof to list local services.'
        : `lsof failed (${code ?? 'unknown'}): ${err instanceof Error ? err.message : String(err)}`;
    return { services: [], generatedAt, detail };
  }

  const sockets = parseLsof(stdout);

  // Dedup by (pid, host, port) — mirrors the source's key. A pid may resolve
  // many sockets; we resolve process metadata once per unique pid.
  const byKey = new Map<string, RawSocket>();
  for (const s of sockets) {
    if (!isLocalAddress(s.host)) continue;
    // <1024 privileged-port skip (scanner.py line ~230).
    if (s.port < 1024) continue;
    byKey.set(`${s.pid}|${s.host}|${s.port}`, s);
  }

  // Resolve metadata per unique pid (not per socket) to bound spawns.
  const pidMeta = new Map<number, { name: string; cmdline: string; cwd: string | null }>();
  const uniquePids = new Set<number>();
  for (const s of byKey.values()) if (s.pid != null) uniquePids.add(s.pid);

  await Promise.all(
    [...uniquePids].map(async (pid) => {
      // lsof COMMAND column is a name fallback; resolve in parallel per pid.
      const command = [...byKey.values()].find((s) => s.pid === pid)?.command ?? 'unknown';
      const [name, cmdline, cwd] = await Promise.all([
        resolveProcessName(pid, command),
        resolveCmdline(pid),
        resolveCwd(pid),
      ]);
      pidMeta.set(pid, { name, cmdline, cwd });
    }),
  );

  const services: LocalService[] = [];
  for (const s of byKey.values()) {
    const meta = s.pid != null ? pidMeta.get(s.pid) : undefined;
    const processName = meta?.name ?? (s.command || 'unknown');
    const cmdline = meta?.cmdline ?? '';
    const cwd = meta?.cwd ?? null;
    const appName = appNameFromCwd(cwd);
    const [framework, frameworkEmoji] = detectFramework(cmdline, processName);
    const friendlyName = makeFriendlyName(appName, framework, s.port, processName);
    services.push({
      pid: s.pid,
      processName,
      cmdline,
      cwd,
      appName,
      host: s.host,
      port: s.port,
      url: `http://localhost:${s.port}/`,
      framework,
      frameworkEmoji,
      friendlyName,
      likelyWeb: isLikelyWebService(processName, cmdline, s.port),
    });
  }

  // Sort: port asc, then processName, then pid (scanner.py final sort).
  services.sort((a, b) => {
    if (a.port !== b.port) return a.port - b.port;
    const n = a.processName.toLowerCase().localeCompare(b.processName.toLowerCase());
    if (n !== 0) return n;
    return (a.pid ?? 0) - (b.pid ?? 0);
  });

  return { services, generatedAt };
}
