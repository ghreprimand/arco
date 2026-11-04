import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { ensureProjectStateIgnore } from './projectStateIgnore.js';

// Content-addressed plan history (P7.2, docs/STORAGE_PLAN.md). Each distinct
// cluster plan body is written once to <cwd>/.arco/plans/.history/<sha256>.md
// so the per-member audit copy of `cluster_plan_changed` can carry the hash
// instead of the whole body. The folder sits inside plans/, which no cleanup,
// archive or delete ever touches. Plan listing reads index.json and the plans
// watcher only reacts to top-level <id>.md files, so history files never show
// up as plans.
export function planHistoryDir(cwd: string): string {
  return path.join(cwd, '.arco', 'plans', '.history');
}

export function planBodyHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

// Write the body once (temporary file, flush, rename) and return its hash.
// Returns null for an empty body (a cleared plan) or when the write fails;
// callers then keep the body in the logged event so nothing is lost.
export function rememberPlanBody(cwd: string, body: string): string | null {
  if (!cwd || !body) return null;
  const hash = planBodyHash(body);
  const dir = planHistoryDir(cwd);
  const file = path.join(dir, `${hash}.md`);
  try {
    const st = lstatSync(file);
    if (st.isFile()) return hash;
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
  }
  const tmp = path.join(dir, `.${hash}.${randomUUID()}.tmp`);
  try {
    ensureProjectStateIgnore(cwd);
    mkdirSync(dir, { recursive: true });
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeSync(fd, body, null, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
    return hash;
  } catch {
    try { unlinkSync(tmp); } catch { /* not created */ }
    return null;
  }
}
