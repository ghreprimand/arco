import { IncomingMessage, ServerResponse } from 'http';
import { writeFile, stat, mkdir } from 'fs/promises';
import { basename, dirname, relative, resolve } from 'path';
import { boundCwdError, confineRealPath, resolveBoundCwd } from './writeConfinement.js';
import { PORT } from '../server/constants.js';
import { workflows } from '../server/state.js';
import { appendRecord } from '../recentFilesLedger.js';

// Workbench Expansion A6 — Manual file-write endpoint.
//
//   POST /api/files/write   { wfid?, cwd?, path, content }
//
// Powers the FileViewerModal's Edit/Lock toggle: the operator flips a file to
// Edit, hand-tweaks it in the CodeMirror buffer, and Save POSTs here. This is
// the *only* operator-driven write path that bypasses an agent turn, so the
// path-escape guard is load-bearing — a fat-fingered or agent-suggested `path`
// must NEVER land outside the workflow cwd.
//
// The guard is `resolveWithinCwd` (server/src/providers/ollamaTools.ts) — the
// exact same function the Write/Edit tools use. It resolves `path` against
// `cwd` and throws when the canonical result escapes (both `../` traversal and
// absolute paths produce a `..`-prefixed `relative()`, the canonical
// not-under-base signal). Mirroring the tool guard verbatim means there's one
// place to reason about path-escape semantics, not two that can drift. On top
// of it, writeConfinement.ts § confineRealPath re-checks the realpath (symlink
// escapes) and resolveBoundCwd pins which cwd the path is confined against.

// Mirrors diffRoutes/searchRoutes — UUID-ish ids only, no namespace escapes.
function isValidWfid(wfid: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(wfid);
}

export interface FileWriteResult {
  ok: boolean;
  /** Repo-relative path actually written (only on success). */
  relPath?: string;
  bytes?: number;
  error?: string;
  /** HTTP status to surface. 400 on rejected escapes / bad input, 200 on ok. */
  status: number;
}

// Pure write-with-guard core, separated from the HTTP plumbing so the smoke
// can exercise the escape-rejection cases directly (no server, no WS). Returns
// a structured result instead of throwing for the expected rejection paths;
// only truly unexpected fs errors bubble up to the caller's catch.
export async function writeFileWithinCwd(
  cwd: string,
  path: string,
  content: string,
): Promise<FileWriteResult> {
  if (!cwd) return { ok: false, status: 400, error: 'no cwd resolved for this write' };
  if (typeof path !== 'string' || path.length === 0) {
    return { ok: false, status: 400, error: 'path must be a non-empty string' };
  }
  if (typeof content !== 'string') {
    return { ok: false, status: 400, error: 'content must be a string' };
  }
  let abs: string;
  try {
    // The load-bearing guard. Throws on any path escaping cwd. We catch and
    // turn it into a 400 so a rejected escape is a clean client error, never a
    // write and never an opaque 500.
    // resolveWithinCwd + a realpath re-check (writeConfinement.ts) so a
    // symlink inside cwd pointing out of it is refused too.
    abs = await confineRealPath(cwd, path);
  } catch (err) {
    return { ok: false, status: 400, error: err instanceof Error ? err.message : String(err) };
  }
  // Refuse to clobber a directory with file content.
  try {
    const st = await stat(abs);
    if (st.isDirectory()) {
      return { ok: false, status: 400, error: `"${path}" is an existing directory` };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  // Create the parent dir if the operator is saving into a fresh subdir. The
  // parent is guaranteed inside cwd because `abs` already passed the guard.
  const parent = dirname(abs);
  if (parent && parent !== resolve(cwd)) {
    await mkdir(parent, { recursive: true });
  }
  await writeFile(abs, content, 'utf8');
  return {
    ok: true,
    status: 200,
    relPath: relative(cwd, abs) || '.',
    bytes: Buffer.byteLength(content, 'utf8'),
  };
}

export async function tryHandleFileWriteRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!(req.url?.startsWith('/api/files/write') && req.method === 'POST')) {
    return false;
  }
  const send = (code: number, body: unknown): true => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return true;
  };
  try {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const parsed = JSON.parse(raw || '{}') as {
      wfid?: string;
      cwd?: string;
      path?: string;
      content?: string;
    };
    // A wfid binds to the server's registered cwd — the body's cwd is ignored
    // (it used to win, and `cwd: "/"` made every path "inside"). With no wfid
    // the cwd must be a root the server already knows. writeConfinement.ts.
    const wfid = parsed.wfid || '';
    if (wfid && !isValidWfid(wfid)) {
      return send(400, { ok: false, error: 'invalid wfid' });
    }
    const bound = await resolveBoundCwd(parsed.cwd, wfid || undefined);
    if (!bound.ok) {
      return send(400, { ok: false, error: boundCwdError(bound.reason) });
    }
    const cwd = bound.cwd;
    const result = await writeFileWithinCwd(cwd, parsed.path ?? '', parsed.content ?? '');
    // ARCHIVE (docs/ARCHIVE_PLAN.md §4.2) — record the manual operator write in
    // the agent-writes ledger so it surfaces in RECENTS. `result.relPath` is
    // cwd-relative and already path-escape-verified; resolve to absolute.
    if (result.ok && result.relPath) {
      const wf = wfid ? workflows.get(wfid) : undefined;
      void appendRecord({
        ts: Date.now(),
        path: resolve(cwd, result.relPath),
        op: 'modified',
        workflowId: wfid,
        tabTitle: wf?.config.name || (wfid ? wfid.slice(0, 8) : 'operator'),
        provider: wf?.config.primaryProvider || 'operator',
        tool: 'file-write',
        project: basename(cwd),
      });
    }
    return send(result.status, {
      ok: result.ok,
      ...(result.relPath !== undefined ? { path: result.relPath } : {}),
      ...(result.bytes !== undefined ? { bytes: result.bytes } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (err) {
    return send(500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
