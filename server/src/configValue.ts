// DD12 — config-value interpolation. Lets an operator store a secret / base URL
// indirectly instead of pasting a literal:
//   • `!cmd args…`  — run a command at resolve time, use its stdout (e.g.
//                     `!op read op://vault/zai/key` for a 1Password-backed key).
//   • `${ENV_VAR}`  — expand a process env var (with `$$`→`$`, `$!`→`!` escapes
//                     so a literal `$` or leading `!` can still be written).
//   • anything else — a literal value, returned verbatim.
//
// Two halves, kept apart on purpose:
//   • describeConfigValue() — INTROSPECTION WITHOUT RESOLVING. Classifies the
//     raw string for the {configured, source} badge WITHOUT spawning a command
//     or reading the env var's value. The UI can say "command" / "env:FOO" /
//     "literal" without ever touching the secret.
//   • resolveConfigValue()  — the real resolution (spawn / env-read / passthrough),
//     called only where the value is actually needed.
//
// Safety: resolved values are SECRETS — they are NEVER logged (only the kind and,
// for env, the var NAME). A command failure / missing env var returns an error
// string, never the partial value. Results are cached by raw string; pass
// `noCache` for a fresh re-check (e.g. after the operator rotates a vault item).

import { spawn } from 'node:child_process';

export type ConfigValueKind = 'literal' | 'command' | 'env' | 'empty';

export interface ConfigValueDescription {
  kind: ConfigValueKind;
  // True when the raw value is non-empty (a command/env-ref counts as configured
  // even though we haven't resolved it — that's the whole point of not leaking).
  configured: boolean;
  // For 'env', the referenced variable name(s) — safe to surface (not the value).
  envVars?: string[];
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// Classify a raw config value without resolving it. No spawn, no env value read.
export function describeConfigValue(raw: string | undefined | null): ConfigValueDescription {
  const v = (raw ?? '').trim();
  if (!v) return { kind: 'empty', configured: false };
  if (v.startsWith('!')) return { kind: 'command', configured: true };
  const vars: string[] = [];
  let m: RegExpExecArray | null;
  ENV_REF.lastIndex = 0;
  while ((m = ENV_REF.exec(v)) !== null) vars.push(m[1]);
  if (vars.length > 0) return { kind: 'env', configured: true, envVars: [...new Set(vars)] };
  return { kind: 'literal', configured: true };
}

export interface ResolveResult {
  value?: string;
  error?: string;
}

const cache = new Map<string, ResolveResult>();

// Split a `!cmd args…` string into argv. Honors single/double quotes so a quoted
// argument with spaces stays one token; everything else splits on whitespace. We
// spawn WITHOUT a shell (argv only) — no shell metacharacter expansion, matching
// the argv-only discipline used elsewhere (DD15 / the MCP safe-env work).
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else { cur += ch; }
      has = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch; has = true;
    } else if (ch === ' ' || ch === '\t') {
      if (has) { out.push(cur); cur = ''; has = false; }
    } else {
      cur += ch; has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

function expandEnv(raw: string): ResolveResult {
  const missing: string[] = [];
  const substituted = raw.replace(ENV_REF, (_full, name: string) => {
    const val = process.env[name];
    if (val === undefined) { missing.push(name); return ''; }
    return val;
  });
  if (missing.length > 0) {
    return { error: `env var${missing.length === 1 ? '' : 's'} not set: ${[...new Set(missing)].join(', ')}` };
  }
  // Escapes after substitution so `$$`/`$!` in the literal survive: `$$`→`$`,
  // `$!`→`!`. Ordering is safe — env refs were already consumed above.
  const escaped = substituted.replace(/\$\$/g, '$').replace(/\$!/g, '!');
  return { value: escaped };
}

async function runCommand(cmd: string, timeoutMs: number): Promise<ResolveResult> {
  const argv = splitArgs(cmd);
  if (argv.length === 0) return { error: 'empty command' };
  const [program, ...args] = argv;
  return new Promise<ResolveResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: ResolveResult) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return done({ error: `spawn failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      done({ error: `command timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); done({ error: `command error: ${err.message}` }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // stderr can contain the secret in pathological cases; surface only a
        // short, non-value diagnostic.
        const hint = stderr.trim().split('\n')[0]?.slice(0, 120) ?? '';
        return done({ error: `command exited ${code}${hint ? `: ${hint}` : ''}` });
      }
      const value = stdout.replace(/\r?\n$/, ''); // strip a single trailing newline
      done({ value });
    });
  });
}

// Resolve a raw config value. Cached by raw string unless `noCache`. NEVER logs
// or returns partial secrets. Empty input → { value: undefined }.
export async function resolveConfigValue(
  raw: string | undefined | null,
  opts?: { timeoutMs?: number; noCache?: boolean },
): Promise<ResolveResult> {
  const v = (raw ?? '').trim();
  if (!v) return { value: undefined };
  if (!opts?.noCache) {
    const hit = cache.get(v);
    if (hit) return hit;
  }
  let result: ResolveResult;
  if (v.startsWith('!')) {
    result = await runCommand(v.slice(1).trim(), opts?.timeoutMs ?? 10_000);
  } else {
    // Non-command: env-expand `${VAR}` then apply the `$$`→`$` / `$!`→`!`
    // escapes. A plain literal with none of these passes through unchanged.
    result = expandEnv(v);
  }
  // Only cache successes — a transient command failure / missing env shouldn't
  // stick until the operator manually re-checks.
  if (!result.error) cache.set(v, result);
  return result;
}

// Test/maintenance hook — drop the resolve cache.
export function clearConfigValueCache(): void {
  cache.clear();
}
