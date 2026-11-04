// H1 — Arco session index smoke.
//
// PURE — NO Arco WebSocket / server boot / live model / recall db. Exercises
// the project-local session-index module (server/src/workflows/sessionIndex.ts)
// directly against a throwaway .arco tree under the OS temp dir:
//   - upsertSessionIndexFromMeta builds <cwd>/.arco/session-index.json from a
//     workflow's meta.json + events.jsonl (entry key = (provider, sessionId);
//     title = first operator message; lastSeq / sourceHash mirror meta).
//   - idempotent: re-upsert with no material change leaves the entry untouched.
//   - title-refresh rule (§H3-forward): an operator/H2 title carrying the same
//     sourceHash survives a re-upsert; a material change (new lastEventSeq)
//     refreshes the deterministic title.
//   - arco-internal continuity (no cliSessions) keys on the workflow id with
//     the primary provider.
//   - backfillSessionIndex indexes every workflow under a cwd.
//   - recordSessionSummary sets the "where this left off" subtitle.
//   - ACCEPTANCE (§H1): building the index touches ONLY
//     .arco/session-index.json — provider session files (and everything else)
//     are left byte-for-byte unchanged.
//
// Run: npm run smoke:session-index   (no dev server needed)

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkflowMeta } from '../../server/src/workflowMeta.js';
import {
  readSessionIndex,
  upsertSessionIndexFromMeta,
  backfillSessionIndex,
  recordSessionSummary,
  renameSession,
  setSessionPinned,
  setSessionArchived,
} from '../../server/src/workflows/sessionIndex.js';

let passes = 0;
let fails = 0;
const failures: string[] = [];

function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`  PASS  ${label}`); passes++; }
  else { const m = `${label}${detail ? `: ${detail}` : ''}`; console.log(`  FAIL  ${m}`); failures.push(m); fails++; }
}

function makeMeta(cwd: string, over: Partial<WorkflowMeta> & Pick<WorkflowMeta, 'workflowId'>): WorkflowMeta {
  return {
    name: over.workflowId,
    cwd,
    createdAt: 1_000,
    lastActiveAt: 2_000,
    primaryProvider: 'claude',
    primaryModel: 'claude-opus-4-8' as WorkflowMeta['primaryModel'],
    primaryEffort: 'medium' as WorkflowMeta['primaryEffort'],
    cliSessions: [],
    operator: 'smoke',
    lastEventSeq: null,
    lastTranscriptSeq: null,
    compactedAt: null,
    ...over,
  };
}

// Write a workflow's meta.json + events.jsonl under <cwd>/.arco/workflows/<wfid>/.
async function seedWorkflow(cwd: string, meta: WorkflowMeta, firstMessages: string[]): Promise<void> {
  const dir = path.join(cwd, '.arco', 'workflows', meta.workflowId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  const lines = firstMessages.map((content, i) => JSON.stringify({ seq: i + 1, type: 'user_message_echo', content }));
  await fs.writeFile(path.join(dir, 'events.jsonl'), lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
}

// Recursive snapshot of relative path → byte content, for the no-mutation assert.
async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(abs);
      else out.set(path.relative(root, abs), await fs.readFile(abs, 'utf8'));
    }
  }
  await walk(root);
  return out;
}

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-session-index-'));
  try {
    // ── 1. Build from a single workflow with a native (claude) session ──
    const metaA = makeMeta(tmp, {
      workflowId: 'wf-aaaa1111',
      cliSessions: [{ provider: 'claude', sessionId: 'sess-claude-1', createdAt: 1_000 }],
      lastEventSeq: 5,
    });
    await seedWorkflow(tmp, metaA, ['Fix the login redirect bug', 'and add a test']);
    await upsertSessionIndexFromMeta(metaA);

    let idx = await readSessionIndex(tmp);
    check('one entry after first upsert', idx.entries.length === 1, `got ${idx.entries.length}`);
    const e = idx.entries[0];
    check('entry keys on the native (provider, sessionId)', e?.provider === 'claude' && e?.sessionId === 'sess-claude-1', JSON.stringify(e));
    check('workflowId recorded', e?.workflowId === 'wf-aaaa1111');
    check('title = first operator message', e?.title === 'Fix the login redirect bug', e?.title);
    check('lastSeq mirrors meta.lastEventSeq', e?.lastSeq === 5);
    check('sourceHash mirrors lastEventSeq', e?.sourceHash === '5', e?.sourceHash);

    // ── 2. Idempotent re-upsert (no material change) ──
    await upsertSessionIndexFromMeta(metaA);
    idx = await readSessionIndex(tmp);
    check('re-upsert keeps a single entry', idx.entries.length === 1, `got ${idx.entries.length}`);

    // ── 3. Title-refresh rule: operator title survives same-sourceHash upsert ──
    idx.entries[0] = { ...idx.entries[0], title: 'Operator renamed this' };
    await fs.writeFile(path.join(tmp, '.arco', 'session-index.json'), JSON.stringify(idx, null, 2) + '\n', 'utf8');
    await upsertSessionIndexFromMeta(metaA); // same lastEventSeq=5 → no material change
    idx = await readSessionIndex(tmp);
    check('operator title survives a no-material-change re-upsert', idx.entries[0].title === 'Operator renamed this', idx.entries[0].title);

    // …and a material change (new lastEventSeq) refreshes the deterministic title.
    await upsertSessionIndexFromMeta(makeMeta(tmp, {
      workflowId: 'wf-aaaa1111',
      cliSessions: metaA.cliSessions,
      lastEventSeq: 9,
    }));
    idx = await readSessionIndex(tmp);
    check('material change refreshes deterministic title', idx.entries[0].title === 'Fix the login redirect bug', idx.entries[0].title);
    check('sourceHash advanced with the material change', idx.entries[0].sourceHash === '9', idx.entries[0].sourceHash);

    // ── 4. Arco-internal continuity: no cliSessions → key on workflow id ──
    const metaB = makeMeta(tmp, { workflowId: 'wf-bbbb2222', primaryProvider: 'antigravity', lastEventSeq: 3 });
    await seedWorkflow(tmp, metaB, ['Wire the CDP bridge']);
    await upsertSessionIndexFromMeta(metaB);
    idx = await readSessionIndex(tmp);
    const eb = idx.entries.find((x) => x.workflowId === 'wf-bbbb2222');
    check('arco-internal entry keys on (primaryProvider, workflowId)', eb?.provider === 'antigravity' && eb?.sessionId === 'wf-bbbb2222', JSON.stringify(eb));

    // ── 5. recordSessionSummary sets the subtitle ──
    await recordSessionSummary(tmp, 'wf-bbbb2222', '\n  Left off mid-bridge; CDP attach works, send path TODO.\nmore detail');
    idx = await readSessionIndex(tmp);
    const eb2 = idx.entries.find((x) => x.workflowId === 'wf-bbbb2222');
    check('subtitle = first non-empty summary line', eb2?.subtitle === 'Left off mid-bridge; CDP attach works, send path TODO.', eb2?.subtitle);

    // ── 6. backfillSessionIndex indexes every workflow under the cwd ──
    // Fresh cwd so the backfill is the sole builder. Inline reader (no recall).
    const cwd2 = await fs.mkdtemp(path.join(os.tmpdir(), 'arco-session-index-bf-'));
    try {
      await seedWorkflow(cwd2, makeMeta(cwd2, { workflowId: 'wf-cccc3333', cliSessions: [{ provider: 'codex', sessionId: 'sess-codex-9', createdAt: 1 }], lastEventSeq: 2 }), ['one']);
      await seedWorkflow(cwd2, makeMeta(cwd2, { workflowId: 'wf-dddd4444', cliSessions: [{ provider: 'claude', sessionId: 'sess-claude-x', createdAt: 1 }], lastEventSeq: 4 }), ['two']);
      const readMetaInline = async (c: string, wfid: string): Promise<WorkflowMeta | null> => {
        try { return JSON.parse(await fs.readFile(path.join(c, '.arco', 'workflows', wfid, 'meta.json'), 'utf8')); }
        catch { return null; }
      };
      await backfillSessionIndex(cwd2, readMetaInline);
      const bf = await readSessionIndex(cwd2);
      check('backfill indexed both workflows', bf.entries.length === 2, `got ${bf.entries.length}`);
      check('backfill carried distinct providers', new Set(bf.entries.map((x) => x.provider)).size === 2);
    } finally {
      await fs.rm(cwd2, { recursive: true, force: true });
    }

    // ── 6b. §H3 operator ops — rename / pin / archive ──
    // wf-aaaa1111 is native (claude, sess-claude-1). Rename → operator title.
    const renamed = await renameSession(tmp, { provider: 'claude', sessionId: 'sess-claude-1' }, 'Login redirect — operator title');
    check('renameSession returns the updated entry', renamed?.title === 'Login redirect — operator title' && renamed?.titleSource === 'operator', JSON.stringify(renamed));
    idx = await readSessionIndex(tmp);
    let ea = idx.entries.find((x) => x.workflowId === 'wf-aaaa1111')!;
    check('operator title persisted', ea?.title === 'Login redirect — operator title' && ea?.titleSource === 'operator', `${ea?.title}/${ea?.titleSource}`);

    // …and SURVIVES a material-change upsert (the §H3 acceptance: rename
    // persists and survives a title refresh).
    await upsertSessionIndexFromMeta(makeMeta(tmp, { workflowId: 'wf-aaaa1111', cliSessions: metaA.cliSessions, lastEventSeq: 42 }));
    idx = await readSessionIndex(tmp);
    ea = idx.entries.find((x) => x.workflowId === 'wf-aaaa1111')!;
    check('operator rename survives a title refresh', ea?.title === 'Login redirect — operator title' && ea?.titleSource === 'operator', `${ea?.title}/${ea?.titleSource}`);

    // rename → an 'operator' title-event was logged.
    const titleEvents = JSON.parse('[' + (await fs.readFile(path.join(tmp, '.arco', 'title-events.jsonl'), 'utf8')).trim().split('\n').join(',') + ']');
    check('rename logged an operator title-event', titleEvents.some((e: any) => e.source === 'operator' && e.to === 'Login redirect — operator title'), JSON.stringify(titleEvents));

    // Pin + unpin.
    await setSessionPinned(tmp, { provider: 'claude', sessionId: 'sess-claude-1' }, true);
    idx = await readSessionIndex(tmp);
    check('pin sets pinned=true', idx.entries.find((x) => x.workflowId === 'wf-aaaa1111')?.pinned === true);
    // …and survives an upsert.
    await upsertSessionIndexFromMeta(makeMeta(tmp, { workflowId: 'wf-aaaa1111', cliSessions: metaA.cliSessions, lastEventSeq: 43 }));
    idx = await readSessionIndex(tmp);
    check('pin survives an upsert', idx.entries.find((x) => x.workflowId === 'wf-aaaa1111')?.pinned === true);
    await setSessionPinned(tmp, { provider: 'claude', sessionId: 'sess-claude-1' }, false);
    idx = await readSessionIndex(tmp);
    check('unpin clears pinned', idx.entries.find((x) => x.workflowId === 'wf-aaaa1111')?.pinned === undefined);

    // Archive + unarchive.
    await setSessionArchived(tmp, { provider: 'claude', sessionId: 'sess-claude-1' }, true);
    idx = await readSessionIndex(tmp);
    check('archive sets archived=true', idx.entries.find((x) => x.workflowId === 'wf-aaaa1111')?.archived === true);
    await setSessionArchived(tmp, { provider: 'claude', sessionId: 'sess-claude-1' }, false);
    idx = await readSessionIndex(tmp);
    check('unarchive clears archived', idx.entries.find((x) => x.workflowId === 'wf-aaaa1111')?.archived === undefined);

    // A mutation against an unknown key → null (the picker just refetches).
    const miss = await setSessionPinned(tmp, { provider: 'claude', sessionId: 'nope' }, true);
    check('mutation on unknown key returns null', miss === null);

    // ── 7. ACCEPTANCE: building the index touches ONLY session-index.json ──
    // Drop a sentinel "provider session file" + an unrelated workflow file, snapshot
    // everything, run an upsert, and assert nothing but session-index.json changed.
    const sentinel = path.join(tmp, '.arco', 'workflows', 'wf-aaaa1111', 'provider-session.jsonl');
    await fs.writeFile(sentinel, '{"provider":"do-not-touch"}\n', 'utf8');
    const before = await snapshot(tmp);
    await upsertSessionIndexFromMeta(metaA);
    const after = await snapshot(tmp);
    const changed: string[] = [];
    for (const [rel, content] of after) {
      if (before.get(rel) !== content) changed.push(rel);
    }
    for (const rel of before.keys()) if (!after.has(rel)) changed.push(`-${rel}`);
    const indexRel = path.join('.arco', 'session-index.json');
    check('only session-index.json was written (no provider/other-file mutation)',
      changed.length === 1 && changed[0] === indexRel, `changed: ${JSON.stringify(changed)}`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }

  console.log(`\nsession-index: ${fails === 0 ? 'OK' : 'FAILED'} — ${passes} passed, ${fails} failed`);
  if (fails > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
}

main().catch((err) => { console.error(err); process.exit(1); });
