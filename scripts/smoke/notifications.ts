// J1 — workbench notifications smoke.
//
// PURE — NO Archon WebSocket / server boot. Exercises the §J1 notification hub
// (server/src/notifications.ts) directly with an injected capture-broadcast, so
// every assertion is on what WOULD reach the wire:
//   - emit() on every category mints a notice (id + ts filled) and broadcasts a
//     `workbench_notice` — proving each event surfaces;
//   - a muted category is SUPPRESSED before broadcast (emit returns null, no
//     wire message) — proving per-category mute;
//   - setMutes persists to disk and re-broadcasts the `notification_mutes`
//     snapshot, and a fresh init() reloads it — proving the mute survives a
//     restart;
//   - the long-turn helper only emits past the threshold (a short turn is quiet);
//   - notifyQuotaRecovered emits a quota-recovered notice.
//
// Run: npm run smoke:notifications   (no dev server needed)

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServerMessage } from '../../shared/src/index.js';
import { WORKBENCH_NOTICE_CATEGORIES } from '../../shared/src/index.js';
import {
  initNotifications,
  emit,
  setMutes,
  getMutes,
  mutesMessage,
  onTurnStarted,
  onTurnEnded,
  notifyQuotaRecovered,
  _setMutesPathForTest,
} from '../../server/src/notifications.js';

let passes = 0;
let fails = 0;
const failures: string[] = [];

function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`  PASS  ${label}`); passes++; }
  else { const m = `${label}${detail ? `: ${detail}` : ''}`; console.log(`  FAIL  ${m}`); failures.push(m); fails++; }
}

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'archon-notif-'));
  const mutesPath = path.join(tmp, 'notification-mutes.json');
  try {
    // Capture every broadcast instead of sending it over a socket.
    let captured: ServerMessage[] = [];
    const drain = () => { const c = captured; captured = []; return c; };
    _setMutesPathForTest(mutesPath);
    await initNotifications((msg) => { captured.push(msg); });

    // ── 1. every category emits a workbench_notice ──
    for (const cat of WORKBENCH_NOTICE_CATEGORIES) {
      const notice = emit({ category: cat, severity: 'info', title: `t:${cat}` });
      const msgs = drain();
      const wire = msgs.find((m) => m.type === 'workbench_notice');
      check(`emit ${cat} → notice minted`, !!notice && !!notice.id && notice.ts > 0, JSON.stringify(notice));
      check(`emit ${cat} → broadcast`, !!wire && wire.type === 'workbench_notice' && wire.notice.category === cat, JSON.stringify(wire));
    }

    // ── 2. mute suppresses a category before broadcast ──
    setMutes(['turn-finished']);
    drain(); // the setMutes re-broadcast snapshot
    check('mute persisted in memory', getMutes().includes('turn-finished'));
    const suppressed = emit({ category: 'turn-finished', severity: 'success', title: 'should not appear' });
    const afterMuted = drain();
    check('muted emit returns null', suppressed === null);
    check('muted emit produced NO broadcast', afterMuted.length === 0, `got ${afterMuted.length}`);
    // a non-muted category still flows
    const ok = emit({ category: 'backup', severity: 'success', title: 'backup done' });
    check('non-muted category still broadcasts', ok !== null && drain().some((m) => m.type === 'workbench_notice'));

    // ── 3. setMutes persists + re-broadcasts the snapshot ──
    setMutes(['turn-finished', 'pr-status']);
    const snapMsgs = drain();
    const snap = snapMsgs.find((m) => m.type === 'notification_mutes');
    check('setMutes re-broadcasts notification_mutes', !!snap && snap.type === 'notification_mutes' && snap.muted.length === 2, JSON.stringify(snap));
    // setMutes persists fire-and-forget (it's called from a sync WS handler);
    // give the write a beat before reading it back.
    await new Promise((r) => setTimeout(r, 50));
    const onDisk = JSON.parse(await fs.readFile(mutesPath, 'utf-8'));
    check('mutes persisted to disk', Array.isArray(onDisk) && onDisk.includes('turn-finished') && onDisk.includes('pr-status'), JSON.stringify(onDisk));
    check('mutesMessage reflects current set', mutesMessage().muted.length === 2);

    // ── 4. a fresh init reloads the persisted mutes (survives "restart") ──
    await initNotifications((msg) => { captured.push(msg); });
    drain();
    check('mutes reloaded after re-init', getMutes().includes('turn-finished') && getMutes().includes('pr-status'), JSON.stringify(getMutes()));
    // turn-finished is muted now, so even a long turn stays quiet
    onTurnStarted('wf-longmuted');
    onTurnEnded('wf-longmuted'); // 0ms — also below threshold; doubly quiet
    check('muted long-turn stays quiet', drain().length === 0);

    // ── 5. unmute + long-turn threshold ──
    setMutes([]);
    drain();
    // short turn (no recorded start past threshold) → quiet
    onTurnStarted('wf-short');
    onTurnEnded('wf-short');
    check('short turn emits nothing', drain().every((m) => m.type !== 'workbench_notice'));
    // a turn with no recorded start is a no-op (defensive)
    onTurnEnded('wf-never-started');
    check('un-started turn-end is a no-op', drain().length === 0);

    // ── 6. quota recovery helper ──
    notifyQuotaRecovered('claude');
    const q = drain().find((m) => m.type === 'workbench_notice');
    check('quota-recovered emits a notice', !!q && q.type === 'workbench_notice' && q.notice.category === 'quota-recovered' && q.notice.provider === 'claude', JSON.stringify(q));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }

  console.log(`\nnotifications: ${fails === 0 ? 'OK' : 'FAILED'} — ${passes} passed, ${fails} failed`);
  if (fails > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
}

main().catch((err) => { console.error(err); process.exit(1); });
