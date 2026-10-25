import { IncomingMessage, ServerResponse } from 'http';
import type { GitOpResult, GitOpResultMessage } from '@archon/shared';
import {
  isGitRepo,
  stageFiles, stageAll, unstageFiles, unstageAll,
  commit,
  fetch as gitFetch, pull, push,
  stashSave, stashPop, stashList,
  createBranch, deleteBranch, createTag, deleteTag,
} from '../gitOps.js';
import { broadcastWorkflow } from '../server/broadcast.js';
import { PORT } from '../server/constants.js';
import { workflowCwds } from '../server/state.js';

// Workbench Expansion I3 — Direct local git operations endpoints.
//
//   POST /api/git/op/stage    { wfid, path?, action:'files'|'all', paths? }
//   POST /api/git/op/unstage  { wfid, path?, action:'files'|'all', paths? }
//   POST /api/git/op/commit   { wfid, path?, message, amend? }
//   POST /api/git/op/fetch    { wfid, path?, remote? }
//   POST /api/git/op/pull     { wfid, path?, remote?, branch? }
//   POST /api/git/op/push     { wfid, path?, remote?, branch?, force?, setUpstream?, confirm? }
//   POST /api/git/op/stash    { wfid, path?, action:'save'|'pop'|'list', message?, ref? }
//   POST /api/git/op/branch   { wfid, path?, action:'create'|'delete', name, checkout?, force? }
//   POST /api/git/op/tag      { wfid, path?, action:'create'|'delete', name, message? }
//
// Each: validate the cwd is a git repo, run the op (gitOps.ts — argv-only,
// validated inputs, `--` before pathspecs), broadcast a git_op_result event so
// the op + outcome lands in events.jsonl and the Changes view refreshes, and
// answer HTTP 200 with the structured GitOpResult body (expected git failures
// are ok:false, not a 500). Wired AFTER /api/git/status|checkout|diff|compare|
// fetch in router.ts so its `/api/git/op/` prefix can't shadow them.
//
// ⚠ These INTENTIONALLY mutate the operator's real index/working tree/refs —
// the opposite of A2 checkpoints. See docs/GOTCHAS.md § A2-vs-I3.

// Mirrors gitDiffRoutes.isValidWfid — UUID-ish ids only.
function isValidWfid(wfid: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(wfid);
}

interface OpBody {
  wfid?: string;
  path?: string;
  action?: string;
  paths?: unknown;
  message?: string;
  amend?: boolean;
  remote?: string;
  branch?: string;
  force?: boolean;
  setUpstream?: boolean;
  confirm?: boolean;
  name?: string;
  checkout?: boolean;
  ref?: string;
}

// One-line Activity summary for the broadcast event.
function summarize(family: string, result: GitOpResult): string {
  if (!result.ok) {
    if (result.needsConfirm) return `${family} refused: ${result.reason ?? 'confirmation required'}`;
    return `${family} failed: ${result.stderr ?? 'error'}`;
  }
  if (family === 'commit') return `commit ${result.commitHash ?? 'created'}`;
  if (family === 'stash' && result.stashes) return `stash list (${result.stashes.length})`;
  return `${family} ok`;
}

export async function tryHandleGitOpRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!(req.url?.startsWith('/api/git/op/') && req.method === 'POST')) return false;

  const send = (code: number, body: unknown): true => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return true;
  };

  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const family = url.pathname.slice('/api/git/op/'.length);

    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}') as OpBody;

    const wfid = typeof body.wfid === 'string' ? body.wfid : '';
    if (wfid && !isValidWfid(wfid)) {
      return send(400, { ok: false, op: family, stderr: 'invalid wfid' });
    }
    const cwd = (typeof body.path === 'string' && body.path)
      || (wfid ? workflowCwds.get(wfid) : '')
      || '';
    if (!cwd) {
      return send(200, { ok: false, op: family, stderr: 'no working directory' });
    }
    if (!(await isGitRepo(cwd))) {
      return send(200, { ok: false, op: family, stderr: 'not a git repository' });
    }

    const paths = Array.isArray(body.paths)
      ? body.paths.filter((p): p is string => typeof p === 'string')
      : [];

    let result: GitOpResult;
    switch (family) {
      case 'stage':
        result = body.action === 'all' ? await stageAll(cwd) : await stageFiles(cwd, paths);
        break;
      case 'unstage':
        result = body.action === 'all' ? await unstageAll(cwd) : await unstageFiles(cwd, paths);
        break;
      case 'commit':
        result = await commit(cwd, body.message ?? '', { amend: !!body.amend });
        break;
      case 'fetch':
        result = await gitFetch(cwd, body.remote);
        break;
      case 'pull':
        result = await pull(cwd, body.remote, body.branch);
        break;
      case 'push':
        result = await push(cwd, {
          remote: body.remote,
          branch: body.branch,
          force: !!body.force,
          setUpstream: !!body.setUpstream,
          confirm: !!body.confirm,
        });
        break;
      case 'stash':
        if (body.action === 'pop') result = await stashPop(cwd, body.ref);
        else if (body.action === 'list') result = await stashList(cwd);
        else result = await stashSave(cwd, body.message);
        break;
      case 'branch':
        if (body.action === 'delete') result = await deleteBranch(cwd, body.name ?? '', { force: !!body.force });
        else result = await createBranch(cwd, body.name ?? '', { checkout: !!body.checkout });
        break;
      case 'tag':
        if (body.action === 'delete') result = await deleteTag(cwd, body.name ?? '');
        else result = await createTag(cwd, body.name ?? '', { message: body.message });
        break;
      default:
        return send(404, { ok: false, op: family, stderr: `unknown git op: ${family}` });
    }

    // Broadcast the op + outcome to the workflow channel — persisted to
    // events.jsonl via broadcastWorkflow's persistAndStampSeq path so HISTORY
    // / Activity render a marker and any open Changes view refreshes. A
    // needsConfirm refusal is also logged (operator-visible audit trail).
    if (wfid) {
      const event: GitOpResultMessage = {
        type: 'git_op_result',
        workflowId: wfid,
        op: family,
        ok: result.ok,
        summary: summarize(family, result),
        ...(result.stderr ? { stderr: result.stderr } : {}),
        ts: Date.now(),
      };
      broadcastWorkflow(wfid, event);
    }

    // Always HTTP 200 with the structured body — expected git failures and
    // needsConfirm refusals are operator-visible conditions, not server bugs.
    return send(200, result);
  } catch (err) {
    return send(500, { ok: false, op: 'git_op', stderr: err instanceof Error ? err.message : String(err) });
  }
}
