// -- Local services discovery (docs/ARCHITECTURE.md) --
//
// The shared response contract for GET /api/services — "what local web/dev
// services am I running right now, and where?". The server enumerates listening
// TCP sockets (server/src/services/discover.ts) and maps each to its process /
// cwd / framework; the Services tab (L2) renders the result.
//
// Ported from an earlier LocalWebManager prototype (Python/psutil) — the framework
// signature table + friendly-name heuristics are carried over verbatim; the
// socket enumeration is rewritten in TS (lsof + /proc / ps fallback) since there
// is no psutil in Node. READ-ONLY: L1 only reads sockets/processes (kill is L2).

export interface LocalService {
  pid: number | null;
  processName: string;           // e.g. "node", "python3"
  cmdline: string;               // full command line (empty string if unreadable)
  cwd: string | null;            // working directory, null if unreadable
  appName: string;               // cwd basename (project folder), '' if no cwd
  host: string;                  // bind address: 127.0.0.1 / 0.0.0.0 / ::1 / ::
  port: number;
  url: string;                   // http://localhost:<port>/
  framework: string | null;      // detected label, e.g. "Vite"
  frameworkEmoji: string | null; // the ported emoji
  friendlyName: string;          // "Seedbank · Vite" or fallback
  likelyWeb: boolean;
}

export interface ServicesResponse {
  services: LocalService[]; // sorted by port, then processName, then pid
  generatedAt: number;      // ms epoch
  // Set when discovery couldn't run fully (e.g. lsof missing). UI shows it; the
  // list may be empty. Absent on a clean scan.
  detail?: string;
}
