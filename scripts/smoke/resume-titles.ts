// H2 — layered title generation smoke.
//
// PURE — NO Archon WebSocket / server boot / live model / recall db. Exercises
// the §H2 title layers in server/src/workflows/sessionIndex.ts directly against
// a throwaway .archon tree:
//   - the deterministic title SKIPS generic openers ("continue") and titles a
//     session by its first REAL ask → titles improve over the raw first message;
//   - a dynamic "where this left off" subtitle is derived from the last
//     non-trivial operator message (and a single-ask session gets none);
//   - applyModelTitle CACHES by sourceHash (no duplicate log line), respects
//     precedence (an operator title outranks it), and EVENT-LOGS each change to
//     title-events.jsonl;
//   - a Recall-summary subtitle is STICKY across a later opportunistic upsert;
//   - buildTitleFraming states the 5–8-word contract.
//
// Run: npm run smoke:resume-titles   (no dev server needed)

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkflowMeta } from '../../server/src/workflowMeta.js';
import {
  readSessionIndex,
  upsertSessionIndexFromMeta,
  recordSessionSummary,
  applyModelTitle,
  readTitleEvents,
  buildTitleFraming,
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
    cliSessions: [{ provider: 'claude', sessionId: `sess-${over.workflowId}`, createdAt: 1_000 }],
    operator: 'smoke',
    lastEventSeq: null,
    lastTranscriptSeq: null,
    compactedAt: null,
    ...over,
  };
}

async function seedWorkflow(cwd: string, meta: WorkflowMeta, messages: string[]): Promise<void> {
  const dir = path.join(cwd, '.archon', 'workflows', meta.workflowId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  const lines = messages.map((content, i) => JSON.stringify({ seq: i + 1, type: 'user_message_echo', content }));
  await fs.writeFile(path.join(dir, 'events.jsonl'), lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
}

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'archon-resume-titles-'));
  try {
    // ── 1. Generic opener is skipped; first REAL ask becomes the title ──
    const metaA = makeMeta(tmp, { workflowId: 'wf-aaaa1111', lastEventSeq: 5 });
    await seedWorkflow(tmp, metaA, ['continue', 'okay', 'Refactor the auth module to use JWT', 'and add tests']);
    await upsertSessionIndexFromMeta(metaA);
    let idx = await readSessionIndex(tmp);
    let e = idx.entries.find((x) => x.workflowId === 'wf-aaaa1111')!;
    check('generic opener skipped — title = first real ask', e?.title === 'Refactor the auth module to use JWT', e?.title);
    check('titleSource = deterministic', e?.titleSource === 'deterministic', e?.titleSource);
    // dynamic subtitle = last non-trivial message (differs from title)
    check('dynamic subtitle = last non-trivial message', e?.subtitle === 'and add tests', e?.subtitle);
    check('subtitleSource = dynamic', e?.subtitleSource === 'dynamic', e?.subtitleSource);

    // ── 2. All-generic session falls back, single-ask gets no subtitle ──
    const metaB = makeMeta(tmp, { workflowId: 'wf-bbbb2222', lastEventSeq: 1 });
    await seedWorkflow(tmp, metaB, ['Wire the CDP bridge']);
    await upsertSessionIndexFromMeta(metaB);
    idx = await readSessionIndex(tmp);
    const eb = idx.entries.find((x) => x.workflowId === 'wf-bbbb2222')!;
    check('single-ask title', eb?.title === 'Wire the CDP bridge', eb?.title);
    check('single-ask session has no dynamic subtitle (would equal title)', eb?.subtitle === undefined, eb?.subtitle);

    // ── 3. applyModelTitle — applies, caches, event-logs ──
    const r1 = await applyModelTitle(tmp, 'wf-aaaa1111', 'JWT auth migration with tests', { sourceHash: '5', now: 10_000 });
    check('model title applied', r1.status === 'applied', r1.status);
    idx = await readSessionIndex(tmp);
    e = idx.entries.find((x) => x.workflowId === 'wf-aaaa1111')!;
    check('title is now the model title', e?.title === 'JWT auth migration with tests', e?.title);
    check('titleSource = model', e?.titleSource === 'model', e?.titleSource);
    check('titleGeneratedAt stamped', e?.titleGeneratedAt === 10_000, String(e?.titleGeneratedAt));

    let events = await readTitleEvents(tmp);
    check('one title event logged', events.length === 1, `got ${events.length}`);
    check('event records from/to + source', events[0]?.from === 'Refactor the auth module to use JWT' && events[0]?.to === 'JWT auth migration with tests' && events[0]?.source === 'model', JSON.stringify(events[0]));

    // Cache: same sourceHash + same text → no-op, no second log line.
    const r2 = await applyModelTitle(tmp, 'wf-aaaa1111', 'JWT auth migration with tests', { sourceHash: '5', now: 11_000 });
    check('re-apply with same sourceHash+text is cached', r2.status === 'cached', r2.status);
    events = await readTitleEvents(tmp);
    check('cached re-apply did not append a log line', events.length === 1, `got ${events.length}`);

    // ── 4. Model title SURVIVES an opportunistic upsert (no material change) ──
    await upsertSessionIndexFromMeta(metaA); // same lastEventSeq=5
    idx = await readSessionIndex(tmp);
    e = idx.entries.find((x) => x.workflowId === 'wf-aaaa1111')!;
    check('model title survives a no-material-change upsert', e?.title === 'JWT auth migration with tests' && e?.titleSource === 'model', `${e?.title}/${e?.titleSource}`);

    // …and a material change marks the model title stale (sourceHash advances)
    // but keeps it shown until a regen.
    await upsertSessionIndexFromMeta(makeMeta(tmp, { workflowId: 'wf-aaaa1111', lastEventSeq: 9 }));
    idx = await readSessionIndex(tmp);
    e = idx.entries.find((x) => x.workflowId === 'wf-aaaa1111')!;
    check('material change keeps model title but advances sourceHash', e?.title === 'JWT auth migration with tests' && e?.sourceHash === '9', `${e?.title}/${e?.sourceHash}`);

    // ── 5. Operator title outranks a later model-title apply ──
    idx.entries = idx.entries.map((x) => x.workflowId === 'wf-aaaa1111' ? { ...x, title: 'My renamed session', titleSource: 'operator' as const } : x);
    await fs.writeFile(path.join(tmp, '.archon', 'session-index.json'), JSON.stringify(idx, null, 2) + '\n', 'utf8');
    const r3 = await applyModelTitle(tmp, 'wf-aaaa1111', 'Some model suggestion', { sourceHash: '9', now: 12_000 });
    check('operator title outranks model apply', r3.status === 'outranked', r3.status);
    idx = await readSessionIndex(tmp);
    e = idx.entries.find((x) => x.workflowId === 'wf-aaaa1111')!;
    check('operator title untouched', e?.title === 'My renamed session', e?.title);
    // …and survives an opportunistic upsert too.
    await upsertSessionIndexFromMeta(makeMeta(tmp, { workflowId: 'wf-aaaa1111', lastEventSeq: 20 }));
    idx = await readSessionIndex(tmp);
    e = idx.entries.find((x) => x.workflowId === 'wf-aaaa1111')!;
    check('operator title survives a material-change upsert', e?.title === 'My renamed session' && e?.titleSource === 'operator', `${e?.title}/${e?.titleSource}`);

    // ── 6. Recall-summary subtitle is sticky across a later upsert ──
    await recordSessionSummary(tmp, 'wf-bbbb2222', 'Left off mid-bridge; CDP attach works, send path TODO.\nmore');
    idx = await readSessionIndex(tmp);
    let eb2 = idx.entries.find((x) => x.workflowId === 'wf-bbbb2222')!;
    check('summary subtitle set', eb2?.subtitle === 'Left off mid-bridge; CDP attach works, send path TODO.' && eb2?.subtitleSource === 'summary', `${eb2?.subtitle}/${eb2?.subtitleSource}`);
    // A later upsert with new dynamic messages must NOT clobber the summary subtitle.
    await seedWorkflow(tmp, makeMeta(tmp, { workflowId: 'wf-bbbb2222', lastEventSeq: 2 }), ['Wire the CDP bridge', 'now handle the send path']);
    await upsertSessionIndexFromMeta(makeMeta(tmp, { workflowId: 'wf-bbbb2222', lastEventSeq: 2 }));
    idx = await readSessionIndex(tmp);
    eb2 = idx.entries.find((x) => x.workflowId === 'wf-bbbb2222')!;
    check('summary subtitle is sticky across upsert', eb2?.subtitle === 'Left off mid-bridge; CDP attach works, send path TODO.' && eb2?.subtitleSource === 'summary', `${eb2?.subtitle}/${eb2?.subtitleSource}`);

    // ── 7. buildTitleFraming states the contract ──
    const framing = buildTitleFraming('user: do a thing');
    check('framing states the 5–8 word contract', /5[–-]8 words/.test(framing) && framing.includes('do a thing'), framing.slice(0, 60));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }

  console.log(`\nresume-titles: ${fails === 0 ? 'OK' : 'FAILED'} — ${passes} passed, ${fails} failed`);
  if (fails > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
}

main().catch((err) => { console.error(err); process.exit(1); });
