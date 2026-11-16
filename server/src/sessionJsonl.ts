import { watch, statSync } from 'fs';
import { open, readFile } from 'fs/promises';
import { basename, dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { jsonlLines } from './jsonlLines.js';

export interface SessionJsonlEntry {
  type: string;
  // 'sdk-cli' when Arco's primary/worker spawned the turn; 'cli' when a
  // native `claude --resume` terminal wrote the entry. Used to detect a
  // concurrent native session writing to the same JSONL.
  entrypoint?: string;
  // Claude sets this on bookkeeping user rows it writes itself — notably the
  // `<local-command-caveat>` row that precedes any `/slash-command` echo.
  isMeta?: boolean;
  // Assistant rows the CLI fabricates (no model call) carry model:"<synthetic>"
  // — e.g. the "No response requested." reply written for a resumed
  // `--print "/<cmd>"` run. Real model output never has this value.
  message?: { content: unknown; model?: string };
  timestamp?: string;
  uuid?: string;
}

export function resolveSessionJsonlPath(cwd: string, sessionId: string): string {
  // Claude's CLI encodes cwd by replacing any non-[A-Za-z0-9-] char with '-',
  // not just '/'. So `/home/operator/Projects/Sample_Project` becomes
  // `-home-operator-Projects-Sample-Project`. Earlier versions only replaced
  // `/`, which made Arco look up the wrong directory for any project whose
  // path contained `_`, `.`, or whitespace — JSONL reads returned ENOENT and
  // context-usage broadcasts silently disappeared.
  const encoded = resolve(cwd).replace(/[^A-Za-z0-9-]/g, '-');
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', encoded, `${sessionId}.jsonl`);
}

// docs/PROVIDERS.md - the directory the CLI's WorkflowTool writes background
// subagent runs into: `<projects>/<encoded-cwd>/<sessionId>/subagents/workflows/`,
// holding one `wf_*` dir per Workflow() call (each with a `journal.jsonl` +
// `agent-*.jsonl` transcripts). Same cwd-encoding as resolveSessionJsonlPath.
export function resolveSubagentsWorkflowsDir(cwd: string, sessionId: string): string {
  const encoded = resolve(cwd).replace(/[^A-Za-z0-9-]/g, '-');
  return join(homedir(), '.claude', 'projects', encoded, sessionId, 'subagents', 'workflows');
}

export async function loadSessionJsonl(
  path: string,
): Promise<{ entries: SessionJsonlEntry[]; byteLength: number }> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch {
    return { entries: [], byteLength: 0 };
  }
  const entries: SessionJsonlEntry[] = [];
  const complete = buf.lastIndexOf(10) + 1;
  for (const line of buf.subarray(0, complete).toString('utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as SessionJsonlEntry;
      if (e && typeof e.type === 'string') entries.push(e);
    } catch { /* skip malformed lines */ }
  }
  return { entries, byteLength: complete };
}

// Tail the session JSONL for new entries, emitting each one via `onEntry`.
// `initialOffset` should be the byteLength from loadSessionJsonl so we
// don't re-emit history. Returns a dispose function.
export function watchSessionJsonl(
  path: string,
  initialOffset: number,
  onEntry: (entry: SessionJsonlEntry) => void,
): () => void {
  let lastOffset = initialOffset;
  let active = true;
  let watcher: ReturnType<typeof watch> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;

  let reading = false;
  let requested = false;
  let identity: string | undefined;
  try { const st = statSync(path); identity = `${st.dev}:${st.ino}`; } catch { /* not created yet */ }
  const readNew = async () => {
    if (!active) return;
    requested = true;
    if (reading) return;
    reading = true;
    try {
      while (active && requested) {
        requested = false;
        try {
          const fh = await open(path, 'r');
          try {
            if (!active) return;
            const st = await fh.stat();
            const nextIdentity = `${st.dev}:${st.ino}`;
            if ((identity !== undefined && identity !== nextIdentity) || st.size < lastOffset) lastOffset = 0;
            identity = nextIdentity;
            let completeOffset = lastOffset;
            // Read only the appended range. An unfinished record is left at
            // lastOffset and completed by the next notification, as before.
            async function* chunks(): AsyncGenerator<Buffer> {
              for (let position = lastOffset; active && position < st.size;) {
                const buffer = Buffer.alloc(Math.min(64 * 1024, st.size - position));
                const { bytesRead } = await fh.read(buffer, 0, buffer.length, position);
                if (!bytesRead) break;
                const chunk = buffer.subarray(0, bytesRead);
                const newline = chunk.lastIndexOf(0x0a);
                if (newline >= 0) completeOffset = position + newline + 1;
                position += bytesRead;
                yield chunk;
              }
            }
            for await (const line of jsonlLines(chunks(), path, { finalLine: false, carriageReturns: false })) {
              if (!active) return;
              if (!line.trim()) continue;
              let e: SessionJsonlEntry;
              try { e = JSON.parse(line); } catch { continue; }
              if (e && typeof e.type === 'string') onEntry(e);
            }
            lastOffset = completeOffset;
          } finally { await fh.close(); }
        } catch { /* file unavailable; retry at the next notification */ }
      }
    } finally { reading = false; }
  };

  const scheduleRestart = () => {
    // Dedup pending restarts: an error event on a stale watcher instance
    // (after we already set `watcher = null`) and a new failure path can
    // both fire scheduleRestart, stacking timers and producing fan-out
    // restarts when the underlying file is flapping.
    if (!active || restartTimer) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      startWatcher();
    }, 2000);
  };

  const startWatcher = () => {
    if (!active || watcher) return;
    try {
      // Watching the directory survives replacement of the session file;
      // an inode-bound watcher would keep watching the removed file.
      watcher = watch(dirname(path), { persistent: false }, (_event, name) => {
        if (name === null || name === basename(path)) void readNew();
      });
      void readNew();
      watcher.on('error', () => {
        watcher = null;
        scheduleRestart();
      });
    } catch {
      // Session directory not yet created — retry after 2s (happens for brand-new sessions)
      scheduleRestart();
    }
  };

  startWatcher();

  return () => {
    active = false;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (watcher) {
      try { watcher.close(); } catch { /* already closed */ }
      watcher = null;
    }
  };
}
