// Conversation purge — irreversibly delete every on-disk artifact of a workflow.
// Two tiers (REMOTE_MANAGEMENT plan / HISTORY-tab action):
//   'arco'  — everything Arco wrote: the workflow dir tree (events.jsonl,
//               meta.json, artifacts, handoffs, sandbox, mcp-config, …),
//               repo + shadow checkpoints, legacy tars/sidecars, the recall
//               row, and the cluster mailbox.
//   'nuclear' — all of the above PLUS the bound provider session files
//               (~/.claude/projects/…, codex rollout) so the conversation is
//               gone from those CLIs too.
//
// In-memory teardown (kill workers, sandbox, pty, plan spans) runs first via the
// existing handleRemoveWorkflow, so a purge of an open tab is clean. Every step
// is best-effort and isolated — one failing path never blocks the rest; the
// caller logs what was removed. There is no undo; the type-to-confirm gate on the
// nuclear tier is the only guard (enforced at the route).

import { rm, readdir, unlink, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workflowDir, readMeta } from '../workflowMeta.js';
import { checkpointStoreRoot } from '../gitSnapshots.js';
import { getRecallIndex } from '../recall/index.js';
import { purgeMailboxForWorkflow } from '../clusterMailbox.js';
import { genesisScratchDir } from '../genesis/scaffold.js';
import { findCodexRolloutPath } from './transcripts.js';
import { encodeProjectDir } from '../http/fileRead.js';
import { handleRemoveWorkflow } from '../ws/workflowHandlers.js';
import { getClusterIdForWorkflow } from '../clusterStore.js';
import { handleClusterMemberRemove } from '../ws/clusterHandlers.js';

const execFileAsync = promisify(execFile);

export interface PurgeResult {
  ok: boolean;
  removed: string[]; // human-readable labels of what was deleted (for the log)
  error?: string;
}

// Delete every checkpoint ref `refs/arco/<wfid>/*` in the cwd and shadow
// repos, plus workflow sidecars / legacy tars. All best-effort.
async function deleteCheckpoints(cwd: string, wfid: string, removed: string[]): Promise<void> {
  // Git-backed: list then delete each ref. Silent when cwd isn't a git repo.
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'for-each-ref', '--format=%(refname)', `refs/arco/${wfid}/`]);
    const refs = stdout.split('\n').map((r) => r.trim()).filter(Boolean);
    for (const ref of refs) {
      await execFileAsync('git', ['-C', cwd, 'update-ref', '-d', ref]).catch(() => {});
    }
    if (refs.length) removed.push(`${refs.length} git checkpoint(s)`);
  } catch {
    /* not a git repo / git unavailable → shadow path below covers it */
  }
  // Shadow-git (non-git cwds): refs live in the per-cwd shadow repo under the
  // checkpoint store. Objects are left for the store's own gc.
  try {
    const shadow = join(checkpointStoreRoot(cwd), 'git');
    const { stdout } = await execFileAsync('git', ['--git-dir', shadow, 'for-each-ref', '--format=%(refname)', `refs/arco/${wfid}/`]);
    const refs = stdout.split('\n').map((r) => r.trim()).filter(Boolean);
    for (const ref of refs) {
      await execFileAsync('git', ['--git-dir', shadow, 'update-ref', '-d', ref]).catch(() => {});
    }
    if (refs.length) removed.push(`${refs.length} shadow checkpoint(s)`);
  } catch {
    /* no shadow store → nothing to do */
  }
  // Per-ref skipped-file manifests and legacy tar checkpoints live beside the
  // shadow repo. Both are workflow-scoped and must leave with the workflow.
  try {
    const root = checkpointStoreRoot(cwd);
    const names = await readdir(root).catch(() => [] as string[]);
    const mine = names.filter((n) =>
      n.startsWith(`${wfid}.`) && (n.endsWith('.tar') || n.endsWith('.skipped.json')));
    for (const n of mine) await unlink(join(root, n)).catch(() => {});
    if (mine.length) removed.push(`${mine.length} checkpoint sidecar(s)`);
  } catch {
    /* no checkpoint store → nothing to do */
  }
}

// Nuclear-only: delete the raw provider session files bound to this workflow,
// read from meta.cliSessions before the workflow dir is removed.
async function deleteProviderSessions(
  cwd: string,
  sessions: Array<{ provider: string; sessionId: string }>,
  removed: string[],
): Promise<void> {
  for (const s of sessions) {
    try {
      if (s.provider === 'claude') {
        const p = join(homedir(), '.claude', 'projects', encodeProjectDir(cwd), `${s.sessionId}.jsonl`);
        await unlink(p).then(() => removed.push(`claude session ${s.sessionId.slice(0, 8)}`)).catch(() => {});
      } else if (s.provider === 'codex') {
        const p = await findCodexRolloutPath(s.sessionId).catch(() => null);
        if (p) await unlink(p).then(() => removed.push(`codex rollout ${s.sessionId.slice(0, 8)}`)).catch(() => {});
      }
      // gemini raw-session deletion isn't wired in v1 (no stable locator); the
      // Arco-side data is still fully purged. Noted in HTTP_API / PERSISTENCE.
    } catch {
      /* best-effort per session */
    }
  }
}

export async function purgeWorkflow(
  cwd: string,
  wfid: string,
  opts: { nuclear: boolean },
): Promise<PurgeResult> {
  const removed: string[] = [];
  try {
    // For nuclear, capture the provider sessions BEFORE the dir (holding
    // meta.json) is deleted.
    let sessions: Array<{ provider: string; sessionId: string }> = [];
    if (opts.nuclear) {
      const meta = await readMeta(cwd, wfid).catch(() => null);
      if (meta) sessions = meta.cliSessions.map((s) => ({ provider: s.provider, sessionId: s.sessionId }));
    }

    // 0. Cluster membership. Without this a purged member stayed in the
    //    cluster's members[]: peer_send to it enqueued "successfully" into a
    //    mailbox nobody would ever drain. The operator-× path does the same
    //    detach (collapse-to-plain when <2 remain, observer/watcher/state
    //    teardown, cluster_member_removed | cluster_deleted broadcast) and
    //    also runs handleRemoveWorkflow — step 1 below is then a no-op.
    const clusterId = getClusterIdForWorkflow(wfid);
    if (clusterId) {
      try {
        await handleClusterMemberRemove(clusterId, wfid);
        removed.push(`cluster membership ${clusterId.slice(0, 8)}`);
      } catch (err) {
        console.error(`[arco] purge: cluster detach failed for ${wfid.slice(0, 8)}:`, err);
      }
    }

    // 1. In-memory teardown (no-op if the workflow isn't currently loaded).
    try {
      handleRemoveWorkflow(wfid);
    } catch (err) {
      console.error(`[arco] purge: in-memory teardown failed for ${wfid.slice(0, 8)}:`, err);
    }

    // 2. The workflow directory tree (events.jsonl, meta.json, artifacts,
    //    handoffs, sandbox.db, mcp-config, attachments, …).
    await rm(workflowDir(cwd, wfid), { recursive: true, force: true });
    removed.push('workflow dir');

    // 3. Checkpoints (git refs + tar files).
    await deleteCheckpoints(cwd, wfid, removed);

    // 4. Recall row (+ FTS mirror) so it leaves recall/search/resume at once.
    getRecallIndex().delete(wfid);
    removed.push('recall row');

    // 5. Cluster mailbox (undelivered peer messages addressed to this workflow).
    await purgeMailboxForWorkflow(wfid);

    // 6. Genesis scratch dir (only exists for an incomplete from-nothing run).
    await rm(genesisScratchDir(wfid), { recursive: true, force: true }).catch(() => {});

    // 7. Nuclear: raw provider session files.
    if (opts.nuclear) await deleteProviderSessions(cwd, sessions, removed);

    console.log(`[arco] purged workflow ${wfid.slice(0, 8)} (${opts.nuclear ? 'nuclear' : 'arco'}): ${removed.join(', ')}`);
    return { ok: true, removed };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[arco] purge failed for ${wfid.slice(0, 8)}:`, error);
    return { ok: false, removed, error };
  }
}
