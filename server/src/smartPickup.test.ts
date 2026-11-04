import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SMART_PICKUP_LIMITS, resolveAutoPickupMode, sanitizeSmartPickupLimits, sanitizeSmartPickupEvaluator, SMART_PICKUP_LIMIT_SPECS } from '@arco/shared';

const sandbox = await fs.mkdtemp(join(tmpdir(), 'arco-smart-pickup-'));
process.env.ARCO_HOME = join(sandbox, 'home');
const store = await import('./clusterStore.js');
const ledger = await import('./smartPickupLedger.js');
const smart = await import('./smartPickup.js');
const adapters = await import('./smartPickupAdapters.js');
after(async () => { await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const make = async () => store.createCluster({ cwd: await fs.mkdtemp(join(sandbox, 'project-')), memberWorkflowIds: [randomUUID(), randomUUID()] });
const enabled = () => true;
const evaluator = { provider: 'cursor', model: 'auto' } as const;
const T0 = 1_800_000_000_000;

test('limits and evaluator are sanitized; legacy boolean maps to Rule-based', () => {
  assert.deepEqual(sanitizeSmartPickupLimits(undefined), DEFAULT_SMART_PICKUP_LIMITS);
  const raw = { callsPerClusterHour: 30, wakesPerSession: 0, sessionMinutes: 1000, timeoutSeconds: 12.5, maxOutputTokens: '64' };
  const s = sanitizeSmartPickupLimits(raw);
  assert.equal(s.callsPerClusterHour, 30);
  assert.equal(s.wakesPerSession, SMART_PICKUP_LIMIT_SPECS.wakesPerSession.default, 'below min reads as default');
  assert.equal(s.sessionMinutes, 30, 'above max reads as default');
  assert.equal(s.timeoutSeconds, 30, 'fractions rejected');
  assert.equal(s.maxOutputTokens, 64);
  assert.equal(sanitizeSmartPickupEvaluator({ provider: 'cursor', model: ' auto ' })?.model, 'auto');
  assert.deepEqual(sanitizeSmartPickupEvaluator({ provider: 'deepseek', model: 'x' }), { provider: 'deepseek', model: 'x' });
  assert.equal(sanitizeSmartPickupEvaluator({ provider: 'codex', model: '' }), null);
  assert.equal(resolveAutoPickupMode(undefined, true), 'rule');
  assert.equal(resolveAutoPickupMode(undefined, undefined), 'off');
  assert.equal(resolveAutoPickupMode('smart-observe', undefined), 'smart-observe');
});

test('an existing enabled cluster keeps Rule-based; the legacy toggle maps to rule/off', async () => {
  const c = await make();
  assert.equal(store.getAutoPickupMode(c.clusterId), 'off');
  await store.setAutoTurnOnMailbox(c.clusterId, true);
  assert.equal(store.getAutoPickupMode(c.clusterId), 'rule');
  assert.equal(store.isAutoTurnOnMailboxEnabled(c.clusterId), true);
  assert.equal(store.isAutoPickupWaking(c.clusterId), true);
  // A meta saved before modes existed has only the boolean.
  const legacy = { ...(await store.readCluster(c.clusterId))!, autoPickupMode: undefined, autoTurnOnMailboxEnabled: true };
  assert.equal(store.autoPickupModeOf(legacy), 'rule');
  await store.setAutoTurnOnMailbox(c.clusterId, false);
  assert.equal(store.getAutoPickupMode(c.clusterId), 'off');
});

test('Smart refuses an evaluator its adapter cannot run, before any session or reservation', async () => {
  const c = await make();
  // Codex that is off or signed out is refused; nothing is armed and no decision is recorded.
  const codexOff = adapters.setEvaluatorAdaptersForTest({
    codex: { provider: 'codex', capability: async () => ({ provider: 'codex', available: false, reason: 'Codex is not signed in.' }), evaluate: async () => { throw new Error('must not be called'); } },
  });
  try {
    assert.deepEqual(await smart.applyAutoPickup(c.clusterId, { mode: 'smart-auto', evaluator: { provider: 'codex', model: 'gpt-6-luna' } }, enabled, T0), { ok: false, problem: 'evaluator_unavailable' });
  } finally { codexOff(); }
  // A provider whose capability reports unavailable, or throws, is refused the same way.
  const restore = adapters.setEvaluatorAdaptersForTest({
    cursor: { provider: 'cursor', capability: async () => ({ provider: 'cursor', available: false, reason: 'not signed in' }), evaluate: async () => { throw new Error('must not be called'); } },
    ollama: { provider: 'ollama', capability: async () => { throw new Error('probe failed'); }, evaluate: async () => { throw new Error('must not be called'); } },
  });
  try {
    assert.deepEqual(await smart.applyAutoPickup(c.clusterId, { mode: 'smart-observe', evaluator }, enabled, T0), { ok: false, problem: 'evaluator_unavailable' });
    assert.deepEqual(await smart.applyAutoPickup(c.clusterId, { mode: 'smart-observe', evaluator: { provider: 'ollama', model: 'local-small' } }, enabled, T0), { ok: false, problem: 'evaluator_unavailable' });
  } finally { restore(); }
  const state = (await store.readCluster(c.clusterId))!;
  assert.equal(store.autoPickupModeOf(state), 'off');
  assert.equal(state.smartPickup?.session, undefined);
  const snap = await ledger.smartPickupSnapshot(c.clusterId, undefined, T0);
  assert.equal(snap.counters.inFlight, 0);
  assert.equal(snap.counters.callsLastHour, 0);
  assert.deepEqual(snap.decisions, []);
  // Off and Rule-based never consult an adapter.
  assert.deepEqual(await smart.applyAutoPickup(c.clusterId, { mode: 'rule' }, enabled, T0), { ok: true, mode: 'rule' });
});

test('Smart needs an enabled evaluator; arming starts a session, disarm ends it and keeps the choice', async () => {
  const c = await make();
  assert.deepEqual(await smart.applyAutoPickup(c.clusterId, { mode: 'smart-observe' }, enabled, T0), { ok: false, problem: 'evaluator_required' });
  assert.deepEqual(await smart.applyAutoPickup(c.clusterId, { mode: 'smart-auto', evaluator }, () => false, T0), { ok: false, problem: 'evaluator_provider_disabled' });
  assert.deepEqual(await smart.applyAutoPickup(c.clusterId, { mode: 'nonsense' }, enabled, T0), { ok: false, problem: 'invalid_mode' });
  assert.deepEqual(await smart.applyAutoPickup(randomUUID(), { mode: 'off' }, enabled, T0), { ok: false, problem: 'unknown_cluster' });
  const armed = await smart.applyAutoPickup(c.clusterId, { mode: 'smart-observe', evaluator, limits: { sessionMinutes: 10, callsPerMemberHour: 999 } }, enabled, T0);
  assert.deepEqual(armed, { ok: true, mode: 'smart-observe' });
  let state = (await store.readCluster(c.clusterId))!;
  assert.equal(store.isAutoTurnOnMailboxEnabled(c.clusterId), false, 'Smart does not use the rule detector');
  assert.equal(store.isAutoPickupWaking(c.clusterId), false, 'Observe-only never wakes');
  const first = state.smartPickup!.session!;
  assert.equal(first.expiresAt - first.armedAt, 10 * 60_000);
  let echo = await smart.autoPickupStateFor(state, T0);
  assert.equal(echo.mode, 'smart-observe');
  assert.deepEqual(echo.evaluator, evaluator);
  assert.equal(echo.limits.sessionMinutes, 10);
  assert.equal(echo.limits.callsPerMemberHour, DEFAULT_SMART_PICKUP_LIMITS.callsPerMemberHour, 'out-of-range limit ignored');
  assert.equal(echo.lastDecision?.reason, 'armed_smart-observe');
  assert.deepEqual(echo.counters, { inFlight: 0, callsLastHour: 0, callsThisSession: 0, wakesLastHour: 0, wakesThisSession: 0 });

  await smart.applyAutoPickup(c.clusterId, { mode: 'smart-auto', evaluator }, enabled, T0 + 1000);
  state = (await store.readCluster(c.clusterId))!;
  assert.notEqual(state.smartPickup!.session!.id, first.id, 're-arming starts a new session');
  assert.equal(store.isAutoPickupWaking(c.clusterId), true);

  await smart.applyAutoPickup(c.clusterId, { mode: 'off' }, enabled, T0 + 2000);
  state = (await store.readCluster(c.clusterId))!;
  assert.equal(state.smartPickup?.session, undefined);
  assert.equal(state.smartPickup?.evaluator, undefined);
  echo = await smart.autoPickupStateFor(state, T0 + 2000);
  assert.equal(echo.mode, 'off');
  assert.deepEqual(echo.lastEvaluator, evaluator, 'last explicit choice kept for the next arming');
  assert.equal(echo.limits.sessionMinutes, 10, 'adjusted limits kept');
  assert.equal(echo.session, undefined);
});

test('reservations enforce every limit, count when spent and survive a restart as uncertain', async () => {
  const c = await make();
  const [a, b] = c.members;
  const limits = { ...DEFAULT_SMART_PICKUP_LIMITS, maxInFlight: 1, callsPerClusterHour: 3, callsPerMemberHour: 2, wakesPerMemberHour: 1, wakesPerSession: 2 };
  const reserve = (kind: 'evaluator' | 'wake', memberId: string, now: number, sessionId = 's1') => ledger.reserveSmartPickup(c.clusterId, { kind, memberId, sessionId, limits, now });
  const r1 = await reserve('evaluator', a, T0);
  assert.equal(r1.ok, true);
  assert.deepEqual(await reserve('evaluator', b, T0 + 1), { ok: false, reason: 'limit_in_flight' });
  await ledger.settleSmartPickup(c.clusterId, (r1 as { id: string }).id, 'completed', T0 + 2);
  assert.equal((await reserve('evaluator', a, T0 + 3)).ok, true);
  await ledger.recoverSmartPickupLedger(c.clusterId, T0 + 4);
  assert.deepEqual(await reserve('evaluator', a, T0 + 5), { ok: false, reason: 'limit_calls_member_hour' }, 'uncertain counts as spent');
  assert.equal((await reserve('evaluator', b, T0 + 6)).ok, true);
  await ledger.recoverSmartPickupLedger(c.clusterId, T0 + 7);
  assert.deepEqual(await reserve('evaluator', b, T0 + 8), { ok: false, reason: 'limit_calls_cluster_hour' });
  assert.equal((await reserve('evaluator', b, T0 + 3_600_001)).ok, true, 'the hour window rolls');

  assert.equal((await reserve('wake', a, T0)).ok, true);
  assert.deepEqual(await reserve('wake', a, T0 + 10), { ok: false, reason: 'limit_wakes_member_hour' });
  assert.equal((await reserve('wake', b, T0 + 11)).ok, true);
  assert.deepEqual(await reserve('wake', a, T0 + 3_700_000), { ok: false, reason: 'limit_wakes_session' }, 'session cap ignores the hour window');
  assert.equal((await reserve('wake', a, T0 + 3_700_001, 's2')).ok, true, 'a new session has its own cap');

  const snap = await ledger.smartPickupSnapshot(c.clusterId, 's1', T0 + 20);
  assert.equal(snap.counters.wakesThisSession, 2);
  assert.equal(snap.counters.inFlight, 1, 'the last evaluator reservation is still open');
});

test('expired sessions and unreadable ledgers disarm instead of resetting budgets', async () => {
  const changed: string[] = [];
  smart.startSmartPickupSupervisor((id) => changed.push(id));
  smart.stopSmartPickupSupervisor();
  const c = await make();
  await smart.applyAutoPickup(c.clusterId, { mode: 'smart-observe', evaluator, limits: { sessionMinutes: 5 } }, enabled, T0);
  await smart.sweepSmartPickup(T0 + 4 * 60_000);
  assert.equal(store.getAutoPickupMode(c.clusterId), 'smart-observe');
  await smart.sweepSmartPickup(T0 + 5 * 60_000);
  assert.equal(store.getAutoPickupMode(c.clusterId), 'off');
  assert.ok(changed.includes(c.clusterId));
  assert.equal((await ledger.smartPickupSnapshot(c.clusterId, undefined)).lastDecision?.reason, 'session_expired');

  const d = await make();
  await smart.applyAutoPickup(d.clusterId, { mode: 'smart-auto', evaluator }, enabled, T0);
  await fs.writeFile(ledger.ledgerPath(d.clusterId), '{not json');
  assert.deepEqual(await smart.applyAutoPickup(d.clusterId, { mode: 'smart-auto', evaluator }, enabled, T0), { ok: false, problem: 'ledger_unreadable' });
  await smart.recoverSmartPickupOnBoot(T0 + 1000);
  assert.equal(store.getAutoPickupMode(d.clusterId), 'off');
  assert.equal(store.isAutoPickupWaking(d.clusterId), false);

  const e = await make();
  await store.setAutoTurnOnMailbox(e.clusterId, true);
  await smart.recoverSmartPickupOnBoot(T0 + 1000);
  assert.equal(store.getAutoPickupMode(e.clusterId), 'rule', 'Rule-based is untouched by recovery');
});

test('Rule-based limits persist across off and updates, while explicit resume resets only the arming budget', async () => {
  const c = await make();
  assert.deepEqual(await smart.applyAutoPickup(c.clusterId, { mode: 'rule', ruleLimits: { pingPongWakes: 7, wakesPerArming: 55 } }, enabled, T0), { ok: true, mode: 'rule' });
  await smart.applyAutoPickup(c.clusterId, { mode: 'rule', ruleLimits: { pingPongWakes: 99 } }, enabled, T0 + 0.5);
  await smart.applyAutoPickup(c.clusterId, { mode: 'off' }, enabled, T0 + 1);
  await smart.applyAutoPickup(c.clusterId, { mode: 'rule' }, enabled, T0 + 2);
  const state = await store.readCluster(c.clusterId);
  const echo = await smart.autoPickupStateFor(state!, T0 + 2);
  assert.equal(echo.ruleLimits?.pingPongWakes, 7);
  assert.equal(echo.ruleLimits?.wakesPerArming, 55);
  assert.equal(echo.ruleLimits?.maxChainDepth, 8);
});

test('turning pickup off works even if the Rule-based ledger is unreadable', async () => {
  const c = await make();
  await store.setAutoTurnOnMailbox(c.clusterId, true);
  await fs.writeFile(join(store.clusterDir(c.clusterId), 'rule-pickup-ledger.json'), '{invalid');
  assert.deepEqual(await smart.applyAutoPickup(c.clusterId, { mode: 'off' }, enabled, T0), { ok: true, mode: 'off' });
  assert.equal(store.getAutoPickupMode(c.clusterId), 'off');
});
