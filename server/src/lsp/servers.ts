// Per-language LSP server registry (docs/ARCHITECTURE.md).
//
// Maps a file extension → an LSP languageId → candidate server command(s).
// Detection is a cross-platform PATH lookup (no `which` shell-out): we walk
// the PATH dirs and check for the binary, honoring `.cmd`/`.exe`/`PATHEXT` on
// win32. The FIRST candidate whose binary resolves on PATH wins.
//
// Graceful degradation: when NO candidate resolves for a language, `resolveServer`
// returns null and the caller no-ops — no error, no crash, no diagnostics.
// The operator installs the language server themselves (same "bring your own
// upstream tool" pattern as the caveman output style). In particular, TS
// diagnostics require `typescript-language-server` (the LSP wrapper) on PATH —
// the bare `tsserver` binary speaks the TSServer protocol, NOT LSP, so it is
// deliberately NOT a candidate here.

import { promises as fs } from 'node:fs';
import { join, delimiter, extname } from 'node:path';

// A resolved server: the absolute (or PATH-relative) command + its argv array.
// argv is passed verbatim to spawn() — NEVER a shell string.
export interface ResolvedServer {
  languageId: string;
  // The command as found on PATH (may be the bare name; spawn resolves it
  // again, but we keep the looked-up form for logging).
  cmd: string;
  args: string[];
}

// One candidate definition: a command name to look up + the args to launch the
// LSP stdio server, plus the LSP languageId for didOpen.
interface ServerCandidate {
  languageId: string;
  bin: string;
  args: string[];
}

// Extension → languageId. Drives both detection and the didOpen languageId.
const EXT_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
};

// languageId → ordered candidate servers. First one resolvable on PATH wins.
// All TS/JS variants share the typescript-language-server candidate.
const CANDIDATES: Record<string, ServerCandidate[]> = {
  typescript: [{ languageId: 'typescript', bin: 'typescript-language-server', args: ['--stdio'] }],
  typescriptreact: [{ languageId: 'typescriptreact', bin: 'typescript-language-server', args: ['--stdio'] }],
  javascript: [{ languageId: 'javascript', bin: 'typescript-language-server', args: ['--stdio'] }],
  javascriptreact: [{ languageId: 'javascriptreact', bin: 'typescript-language-server', args: ['--stdio'] }],
  python: [
    { languageId: 'python', bin: 'pyright-langserver', args: ['--stdio'] },
    { languageId: 'python', bin: 'pylsp', args: [] },
  ],
  go: [{ languageId: 'go', bin: 'gopls', args: [] }],
  rust: [{ languageId: 'rust', bin: 'rust-analyzer', args: [] }],
};

// Map a file path to its LSP languageId, or null if unsupported.
export function languageIdForPath(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  return EXT_TO_LANGUAGE[ext] ?? null;
}

// Cross-platform "is `name` an executable on PATH?". Walks PATH dirs; on win32
// also tries each PATHEXT suffix (.exe/.cmd/.bat). Returns the resolved path or
// null. Async (fs.access) so we don't block the event loop on a cold FS.
// Cached per process: PATH doesn't change under us, and a re-detect on every
// write would defeat the point.
const detectCache = new Map<string, string | null>();

async function findOnPath(name: string): Promise<string | null> {
  const cached = detectCache.get(name);
  if (cached !== undefined) return cached;

  const pathEnv = process.env.PATH ?? '';
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const isWin = process.platform === 'win32';
  // On win32, a bare name like "gopls" needs a suffix to be executable; try the
  // suffixes from PATHEXT (lowercased) plus an empty suffix for names that
  // already carry an extension.
  const exts = isWin
    ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase()).filter(Boolean)]
    : [''];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        // X_OK is meaningless on win32 (everything reports executable), so on
        // win32 a plain existence check via F_OK is the right gate; POSIX uses
        // X_OK to reject non-executable matches.
        await fs.access(candidate, isWin ? fs.constants.F_OK : fs.constants.X_OK);
        detectCache.set(name, candidate);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  detectCache.set(name, null);
  return null;
}

// Resolve the LSP server for a file: returns the first candidate whose binary
// is on PATH, or null when the language is unsupported OR no candidate is
// installed. Null ⇒ caller no-ops (graceful degradation).
export async function resolveServer(filePath: string): Promise<ResolvedServer | null> {
  const languageId = languageIdForPath(filePath);
  if (!languageId) return null;
  const candidates = CANDIDATES[languageId];
  if (!candidates) return null;
  for (const c of candidates) {
    const resolved = await findOnPath(c.bin);
    if (resolved) {
      return { languageId: c.languageId, cmd: c.bin, args: c.args };
    }
  }
  return null;
}

// Test/diagnostic seam: clear the detection cache (used by smoke so a freshly
// installed server is re-detected without a process restart).
export function _clearDetectCache(): void {
  detectCache.clear();
}
