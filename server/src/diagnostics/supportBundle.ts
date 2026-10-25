// ── Support bundle builder (ARCHON_OPS_PLAN.md §A2 + Appendix D) ──
//
// Produces a paste-ready, REDACTED snapshot of this machine: the A1 diagnostics
// report + Archon version + git rev + platform/runtime + best-effort service
// mode. Suitable for dropping into an issue or handing to another agent.
//
// Redaction is the load-bearing requirement (Appendix D): we build the bundle
// from an EXPLICIT ALLOWLIST of safe fields — never serialize raw settings, raw
// env, or raw token objects. Two redaction layers stack:
//
//   1. redactPaths() — every free-text detail/hint that flows into the bundle is
//      path-scrubbed: the user's home dir collapses to `~`, and any remaining
//      absolute path is reduced to its basename under a `<path>/` placeholder so
//      a private directory layout never leaks.
//   2. scrubSecrets() — a final defense-in-depth regex pass over the SERIALIZED
//      bundle that replaces anything matching a known secret shape (GitHub
//      tokens, OpenAI keys, Bearer headers, JWT-ish strings, long hex/base64
//      token runs) with `<redacted>`. The A1 probes are written to never emit a
//      token, so this should normally be a no-op — it's a belt-and-braces guard
//      against a future probe that accidentally includes one, and the smoke
//      asserts it works on a crafted string.
//
// Subprocess discipline (repo rule): the lone shell-out (git rev) uses execFile
// with an argv array (NO shell), a timeout, and resolves a missing binary / not
// a repo to "unknown" rather than throwing.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import type {
  DiagnosticCheck,
  DiagnosticGroup,
  DiagnosticsReport,
  SupportBundle,
  SupportBundleResponse,
} from '@archon/shared';

import { runDiagnostics } from './checks.js';

const execFileAsync = promisify(execFile);

// ── path redaction ────────────────────────────────────────────────────────────

// Collapse the user's home dir to `~` and reduce any other absolute path to a
// `<path>/<basename>` placeholder, so a private directory layout never leaks into
// a pasted bundle. Operates on free text — it scans for path-shaped tokens rather
// than assuming the whole string is one path (a detail line like
// "wrote /home/operator/.archon but readback mismatched" must redact only the path).
//
// Order matters: rewrite the home prefix to `~` FIRST, then reduce any remaining
// absolute path. `~/.archon/...` stays readable (the home prefix is gone) and is
// left intact; only genuine absolute (`/...`) paths get basename-reduced.
export function redactPaths(input: string): string {
  if (!input) return input;
  const home = homedir();
  let out = input;

  // 1. Home dir → `~`. Escape regex metachars in the home path.
  if (home) {
    const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), '~');
  }

  // 2. Any remaining absolute POSIX path (a `/` followed by at least one
  //    non-space path segment) → `<path>/<basename>`. This catches private cwds
  //    and other absolute paths that aren't under home. We keep the basename so
  //    the message stays useful ("…/events.jsonl") without exposing the tree.
  //    A bare "/" or a path with no further segment is left alone.
  //
  //    Crucially, a path immediately preceded by `~` (i.e. the home-collapsed
  //    `~/.archon/…` from step 1) is left INTACT — its private prefix is already
  //    gone, and reducing it would mangle `~/.archon` into `~<path>/…`. The
  //    `(?<![~\w])` lookbehind also skips a `/` that's part of a word like
  //    "and/or" — we only reduce a `/` that begins or follows whitespace/quotes.
  out = out.replace(/(?<![~\w])\/[^\s'"`)]*[^\s'"`)/]/g, (match) => {
    const base = match.slice(match.lastIndexOf('/') + 1);
    return base ? `<path>/${base}` : '<path>';
  });

  return out;
}

// Apply redactPaths to every free-text field of a diagnostics report, returning a
// fresh report (the original is left untouched). Only detail/hint carry free text;
// id/label/status/group are fixed enum-ish strings authored in checks.ts.
function redactReport(report: DiagnosticsReport): DiagnosticsReport {
  const groups: DiagnosticGroup[] = report.groups.map((g) => ({
    id: g.id,
    label: g.label,
    checks: g.checks.map((c): DiagnosticCheck => {
      const redacted: DiagnosticCheck = {
        id: c.id,
        group: c.group,
        label: c.label,
        status: c.status,
        detail: redactPaths(c.detail),
      };
      if (c.hint !== undefined) redacted.hint = redactPaths(c.hint);
      return redacted;
    }),
  }));
  // archonVersion / platform are safe constants; generatedAt is a number.
  return { ...report, groups };
}

// ── secret scrub (defense in depth) ─────────────────────────────────────────────

// Known secret SHAPES. Each is replaced wholesale with `<redacted>`. These run
// over the SERIALIZED bundle text (and the JSON is re-derived from the scrubbed
// text path-independently), so they catch a token regardless of which field a
// future probe might accidentally place it in.
const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // GitHub tokens: ghp_, gho_, ghs_, ghu_, ghr_ + 20+ base62.
  { name: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  // OpenAI-style keys: sk- / sk-proj- + a long body.
  { name: 'openai-key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g },
  // Anthropic keys.
  { name: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  // Bearer auth headers (the token after the scheme).
  { name: 'bearer', re: /Bearer\s+[A-Za-z0-9._-]{10,}/g },
  // JWT-ish: three base64url segments separated by dots, leading `eyJ`.
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // Long hex runs (40+) — SHA/token-ish. (A 7-char short git rev is safe.)
  { name: 'long-hex', re: /\b[0-9a-fA-F]{40,}\b/g },
  // Long base64-ish token runs (32+) with mixed case/digits — opaque secrets.
  // Anchored to require at least one digit and one lower + upper to avoid eating
  // ordinary prose words.
  { name: 'long-token', re: /\b(?=[A-Za-z0-9+/_-]*[0-9])(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[A-Z])[A-Za-z0-9+/_-]{32,}={0,2}\b/g },
];

// Replace every known secret shape in `text` with `<redacted>`. Returns the
// scrubbed string. Exported for the smoke's direct unit-check.
export function scrubSecrets(text: string): string {
  let out = text;
  for (const { re } of SECRET_PATTERNS) {
    out = out.replace(re, '<redacted>');
  }
  return out;
}

// ── metadata probes ──────────────────────────────────────────────────────────

// Short git rev of the Archon checkout. execFile, argv array, no shell, timeout.
// The repo root is two levels above this module's dir (server/src/diagnostics →
// repo root). A missing git / non-repo / error resolves to "unknown".
async function gitRev(): Promise<string> {
  try {
    const repoRoot = dirname(fileURLToPath(new URL('../../../package.json', import.meta.url)));
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot,
      timeout: 4000,
    });
    const rev = stdout.trim();
    return /^[0-9a-f]{4,40}$/i.test(rev) ? rev : 'unknown';
  } catch {
    return 'unknown';
  }
}

let archonVersionCache: string | undefined;
async function archonVersion(): Promise<string> {
  if (archonVersionCache !== undefined) return archonVersionCache;
  try {
    const url = new URL('../../../package.json', import.meta.url);
    const raw = await fs.readFile(url, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    archonVersionCache = typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    archonVersionCache = 'unknown';
  }
  return archonVersionCache;
}

// Best-effort service/transport mode. Service mode proper lands in Part B; for
// now we only distinguish the dev runtime (running under tsx watch — detectable
// because tsx registers a loader / sets the binary on argv) from "unknown".
// Deliberately conservative: never claims a production mode we don't have yet.
function serviceMode(): string {
  const underTsx =
    process.env.npm_lifecycle_event === 'dev:server' ||
    process.argv.some((a) => a.includes('tsx')) ||
    process.execArgv.some((a) => a.includes('tsx'));
  return underTsx ? 'dev (tsx watch)' : 'unknown';
}

// ── text rendering ─────────────────────────────────────────────────────────────

const GLYPH: Record<DiagnosticCheck['status'], string> = {
  ok: 'OK  ',
  warn: 'WARN',
  error: 'ERR ',
  skipped: 'SKIP',
};

// Compact markdown/plain rendering — what the Copy button actually copies. Built
// from the ALREADY-REDACTED bundle, so it inherits path redaction; scrubSecrets
// then runs over the whole string as the final layer.
function renderText(b: SupportBundle): string {
  const lines: string[] = [];
  lines.push('## Arco support bundle');
  lines.push('');
  lines.push(`- generated: ${new Date(b.generatedAt).toISOString()}`);
  lines.push(`- archon: v${b.archonVersion} (${b.gitRev})`);
  lines.push(`- platform: ${b.platform}`);
  lines.push(`- runtime: node ${b.runtime.node}, ${b.runtime.serviceMode}`);
  lines.push('');
  lines.push('### Diagnostics');
  for (const g of b.diagnostics.groups) {
    lines.push('');
    lines.push(`**${g.label}**`);
    for (const c of g.checks) {
      lines.push(`- [${GLYPH[c.status]}] ${c.label} — ${c.detail}`);
      if (c.hint) lines.push(`    hint: ${c.hint}`);
    }
  }
  if (b.notes) {
    lines.push('');
    lines.push(`> ${b.notes}`);
  }
  return lines.join('\n') + '\n';
}

// ── public builder ─────────────────────────────────────────────────────────────

const REDACTION_NOTE =
  'Redacted support bundle: built from a safe-field allowlist; paths home-collapsed and secret-scrubbed. No tokens, env secrets, or private paths included.';

// Build the full support bundle. Never throws on a probe-level failure
// (runDiagnostics is itself safe); a metadata probe failure degrades to
// "unknown". Returns both the typed JSON and the copy-ready text — both passed
// through the secret scrub as the final defense-in-depth layer.
export async function buildSupportBundle(): Promise<SupportBundleResponse> {
  const [report, version, rev] = await Promise.all([runDiagnostics(), archonVersion(), gitRev()]);

  const bundle: SupportBundle = {
    generatedAt: Date.now(),
    archonVersion: version,
    gitRev: rev,
    platform: report.platform,
    runtime: { node: process.version, serviceMode: serviceMode() },
    diagnostics: redactReport(report),
    notes: REDACTION_NOTE,
  };

  // Final scrub: render text, then scrub BOTH the text and the JSON. We scrub the
  // JSON by serialize → scrub → re-parse so the returned object is consistent with
  // the copied text and a secret can't survive in a structured field either.
  const text = scrubSecrets(renderText(bundle));
  const scrubbedJson = JSON.parse(scrubSecrets(JSON.stringify(bundle))) as SupportBundle;

  return { json: scrubbedJson, text };
}
