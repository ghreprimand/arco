import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

export const PORT = parseInt(process.env.ARCHON_PORT || '3001', 10);
export const DIRECTORY_NAME_COLLATOR = new Intl.Collator(undefined, {
  sensitivity: 'base',
  numeric: true,
});
// Bind loopback by default. The HTTP/WS surface has no auth and exposes
// filesystem + GitHub-token-adjacent endpoints; binding 0.0.0.0 would expose
// them to the LAN. Operators who genuinely need a different bind (containers,
// custom forwarding) can set ARCHON_HOST=0.0.0.0 explicitly.
export const HOST = process.env.ARCHON_HOST || '127.0.0.1';
// ARCHON_UPLOADS_DIR relocates uploads (the Docker image keeps them on the data
// volume); the default stays the server's working directory.
export const UPLOADS_DIR = process.env.ARCHON_UPLOADS_DIR || join(process.cwd(), 'uploads');
export const UPLOAD_IMAGE_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// Repo root, used to scope cleanup kills to our own dev processes.
// Depth note: this file lives at server/src/server/, one directory deeper
// than the original index.ts (server/src/). The original used ('..','..')
// to climb from server/src → repo root; from server/src/server we need
// one more level, hence ('..','..','..').
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function compareDirectoryNames(a: string, b: string): number {
  return DIRECTORY_NAME_COLLATOR.compare(a, b) || a.localeCompare(b);
}

// How long after a foreign (non-sdk-cli) JSONL write we keep blocking new
// Archon turns. Picked to cover brief TUI pokes while still unblocking the
// operator soon after they close the terminal.
export const FOREIGN_WRITE_BLOCK_MS = 60_000;
// Debounce window for the in-chat concurrent-session warning.
export const FOREIGN_WARN_DEBOUNCE_MS = 30_000;
// Tail-first hydration page size. Initial session-watcher emit ships the last
// N raw JSONL entries; each `load_earlier_messages` pops another N. Chat feels
// responsive on huge sessions (single-MB JSONL) while still letting the
// operator walk back through the whole history if they want to.
export const SESSION_HISTORY_PAGE_SIZE = 200;

export const MAX_TEXT_SIZE = 2 * 1024 * 1024;
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The early turns contain `event_msg{type:"user_message"}` entries we read to
// synthesize a name preview. We walk the last N days of directories to keep
// the scan bounded.
export const CODEX_SCAN_DAYS = 30;

// Per-socket WS backpressure threshold. When ws.bufferedAmount exceeds
// this, lossy event types (currently just worker_thinking, which streams
// reasoning tokens at high rate from local thinking models) are dropped
// rather than queued. Without this, a runaway llama.cpp turn pumping
// 30+ reasoning tokens/sec at hundreds of bytes per delta blows the
// Node heap and the browser flags Archon as slowing the system.
//
// 1MB is generous: even on a slow link, queue drains in <1s at typical
// WS throughput. Past that we're almost certainly in a runaway and the
// operator-visible cost (some thinking tokens missing from the live view)
// is far cheaper than the alternative (browser lockup). Persistence to
// events.jsonl still happens — the dropped events appear on the next
// page reload via replay.
export const WS_BACKPRESSURE_DROP_BYTES = 1_000_000;

// Cap on preview history entries per workflow. Five fits in the tab header
// without scrolling and covers a realistic working set (operator flips
// between a couple of dev servers across the lifetime of a workflow).
export const PREVIEW_HISTORY_MAX = 5;

export const PERIODIC_PROBE_INTERVAL_MS = 4 * 60 * 60 * 1000;
