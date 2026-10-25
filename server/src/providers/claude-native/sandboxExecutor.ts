// EFFICIENCY_PLAN.md Phase E §9a — sandbox subprocess executor.
//
// Runs operator-opted-in `ctx_execute(language, code)` calls. Same shape
// as context-mode's PolyglotExecutor but WITHOUT the self-heal mutation
// block (that's the rejected pattern — auto-config-mutation hard fence).
//
// Hard caps that make this safe to ship:
//   - 256 KB stdout cap; overflow truncates with a `[...truncated]` marker.
//   - 10 s wall-clock timeout (override via ARCHON_SANDBOX_TIMEOUT_MS).
//   - Spawn with `detached: true` so child + grandchildren share a
//     process group; on timeout we kill the whole group with
//     `process.kill(-pid, 'SIGTERM')`. A python script that forks workers
//     would otherwise leak.
//   - 1 s SIGKILL escalation after SIGTERM for stubborn children.
//   - Each invocation gets a fresh tmp working directory under
//     `<archonHome>/.archon/workflows/<wfid>/sandbox-tmp/<id>` so a script
//     that writes ./out.txt doesn't pollute the operator's repo.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const DEFAULT_TIMEOUT_MS = (() => {
  const env = process.env.ARCHON_SANDBOX_TIMEOUT_MS;
  if (env) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n >= 1000 && n <= 600_000) return n;
  }
  return 10_000;
})();
const STDOUT_BYTE_CAP = 256 * 1024;
const STDERR_BYTE_CAP = 32 * 1024;

export type SupportedLanguage = 'node' | 'python' | 'shell';

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncatedStdout: boolean;
  truncatedStderr: boolean;
  durationMs: number;
}

const LANG_ALIASES: Record<string, SupportedLanguage> = {
  node: 'node',
  js: 'node',
  javascript: 'node',
  python: 'python',
  python3: 'python',
  py: 'python',
  shell: 'shell',
  sh: 'shell',
  bash: 'shell',
};

export function normalizeLanguage(input: string): SupportedLanguage | null {
  const key = input.toLowerCase().trim();
  return LANG_ALIASES[key] ?? null;
}

function buildCommand(language: SupportedLanguage, scriptPath: string): { cmd: string; args: string[] } {
  switch (language) {
    case 'node':
      return { cmd: 'node', args: [scriptPath] };
    case 'python':
      return { cmd: 'python3', args: [scriptPath] };
    case 'shell':
      return { cmd: 'bash', args: [scriptPath] };
  }
}

function extensionFor(language: SupportedLanguage): string {
  return language === 'node' ? '.mjs' : language === 'python' ? '.py' : '.sh';
}

export async function executeSandboxed(
  language: SupportedLanguage,
  code: string,
  opts?: { workflowCwd?: string; workflowId?: string; timeoutMs?: number },
): Promise<SandboxExecResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Per-call tmpdir, ideally next to the workflow's sandbox.db so an
  // operator who wants to inspect a script can find it. Falls back to
  // OS tmpdir when the caller didn't supply a workflow scope.
  const baseDir = opts?.workflowCwd && opts?.workflowId
    ? join(opts.workflowCwd, '.archon', 'workflows', opts.workflowId, 'sandbox-tmp')
    : tmpdir();
  mkdirSync(baseDir, { recursive: true });
  const workdir = mkdtempSync(join(baseDir, 'run-'));
  const scriptPath = join(workdir, `script${extensionFor(language)}`);
  writeFileSync(scriptPath, code, { encoding: 'utf8', mode: 0o600 });

  const { cmd, args } = buildCommand(language, scriptPath);
  const startedAt = Date.now();

  return new Promise<SandboxExecResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let truncatedStdout = false;
    let truncatedStderr = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(cmd, args, {
      cwd: workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, ARCHON_SANDBOX: '1' },
    });

    const killGroup = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        // Negative PID targets the process group (we passed detached:true
        // so the child is the leader of its own group).
        process.kill(-child.pid, signal);
      } catch {
        // Group already gone or never had peer processes — fall back to
        // killing the direct child.
        try { child.kill(signal); } catch { /* gone */ }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      // Escalate to SIGKILL if the child hasn't exited within 1 s.
      setTimeout(() => {
        if (!settled) killGroup('SIGKILL');
      }, 1000).unref();
    }, timeoutMs);

    // DD2 — stream-decode so a multibyte char split across pipe-chunk
    // boundaries isn't mangled (the old per-chunk `buf.toString('utf8')`
    // produced mojibake on UTF-8 output).
    const outDec = new TextDecoder('utf-8');
    const errDec = new TextDecoder('utf-8');
    child.stdout?.on('data', (buf: Buffer) => {
      if (truncatedStdout) return;
      if (stdout.length + buf.length > STDOUT_BYTE_CAP) {
        const room = STDOUT_BYTE_CAP - stdout.length;
        if (room > 0) stdout += outDec.decode(buf.subarray(0, room), { stream: true });
        stdout += '\n[...truncated by sandbox stdout cap]';
        truncatedStdout = true;
        return;
      }
      stdout += outDec.decode(buf, { stream: true });
    });
    child.stderr?.on('data', (buf: Buffer) => {
      if (truncatedStderr) return;
      if (stderr.length + buf.length > STDERR_BYTE_CAP) {
        const room = STDERR_BYTE_CAP - stderr.length;
        if (room > 0) stderr += errDec.decode(buf.subarray(0, room), { stream: true });
        stderr += '\n[...truncated by sandbox stderr cap]';
        truncatedStderr = true;
        return;
      }
      stderr += errDec.decode(buf, { stream: true });
    });

    const finalize = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { rmSync(dirname(scriptPath), { recursive: true, force: true }); } catch { /* ignore */ }
      resolve({
        stdout,
        stderr,
        exitCode,
        timedOut,
        truncatedStdout,
        truncatedStderr,
        durationMs: Date.now() - startedAt,
      });
    };

    child.on('error', (err) => {
      stderr += `\n[spawn error] ${err instanceof Error ? err.message : String(err)}`;
      finalize(127);
    });
    child.on('close', (code) => finalize(code));
  });
}
