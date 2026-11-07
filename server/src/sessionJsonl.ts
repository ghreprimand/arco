import { watch } from 'fs';
import { readFile } from 'fs/promises';
import { join, resolve } from 'path';
import { homedir } from 'os';

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
  const readNew = async () => {
    if (!active) return;
    requested = true;
    if (reading) return;
    reading = true;
    try {
      while (active && requested) {
        requested = false;
        try {
          const buf = await readFile(path);
          if (!active) return;
          if (buf.length < lastOffset) lastOffset = 0;
          const end = buf.lastIndexOf(10) + 1;
          if (end <= lastOffset) continue;
          const slice = buf.subarray(lastOffset, end).toString('utf-8');
          lastOffset = end;
          for (const line of slice.split('\n')) {
            if (!active) return;
            if (!line.trim()) continue;
            let e: SessionJsonlEntry;
            try { e = JSON.parse(line); } catch { continue; }
            if (e && typeof e.type === 'string') onEntry(e);
          }
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
      watcher = watch(path, { persistent: false }, () => { void readNew(); });
      void readNew();
      watcher.on('error', () => {
        watcher = null;
        scheduleRestart();
      });
    } catch {
      // File not yet created — retry after 2s (happens for brand-new sessions)
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
