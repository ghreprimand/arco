// M4 (LOCAL_AI_MASTER_PLAN) — multi-backend Ollama resilience unit smoke.
//
// PURE unit test — NO WebSocket, NO server boot, NO live Ollama daemon. It
// drives the decision surface in server/src/providers/ollamaResilience.ts with
// injected fake backends + a deterministic RNG and asserts on the
// selection / cooldown / failover / never-cool-last decisions directly. This is
// the offline-runnable shape the M4 spec requires (no live daemon may be
// reachable in CI), exercising the resilience LOGIC rather than a real model
// response.
//
// Covers (the M4 acceptance list):
//   - weighted-shuffle selection across healthy backends
//   - a backend going "dead" (cooled) → failover to a healthy peer
//   - instant ZERO backoff when a healthy peer exists
//   - jittered backoff only when forced onto the last host
//   - cooldown start recorded (the events.jsonl line's source)
//   - NEVER-cool-the-last-backend guard
//   - error retryability table (5xx/conn = retryable+cool; 4xx/400 = neither)
//   - connect-timeout marker → retryable; operator abort → not
//
// Run: npm run smoke:ollama-resilience   (no dev server needed)

import {
  resolveBackends,
  singleBackend,
  selectBackend,
  reportFailure,
  classifyOllamaError,
  backoffMs,
  isBackendCooled,
  _resetCooldownsForTest,
  CONNECT_TIMEOUT_MARKER,
  type ResolvedBackend,
  type OllamaRoutingEvent,
} from '../../server/src/providers/ollamaResilience.js';

let passes = 0;
let fails = 0;
const failures: string[] = [];

function check(label: string, cond: unknown): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
    passes++;
  } else {
    console.log(`  FAIL  ${label}`);
    failures.push(label);
    fails++;
  }
}

// Deterministic RNG factory — returns a sequence so selection/backoff are
// reproducible (the spec: "no randomness that can't be reasoned about").
function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

const TWO_BACKENDS: ResolvedBackend[] = [
  { baseUrl: 'http://workstation:11434', weight: 3, label: 'workstation', isLocal: false },
  { baseUrl: 'http://localhost:11434', weight: 1, label: 'localhost', isLocal: true },
];

function noExclude(): Set<string> { return new Set(); }
const servesAll = (): boolean => true;

// ── resolveBackends / singleBackend ───────────────────────────────────────

check('resolveBackends: drops disabled + malformed, keeps good',
  resolveBackends([
    { baseUrl: 'http://workstation:11434', weight: 3 },
    { baseUrl: 'http://laptop:11434', enable: false }, // disabled → dropped
    { baseUrl: 'not-a-url' }, // malformed → dropped
    { baseUrl: 'http://workstation:11434' }, // dup → deduped
  ]).length === 1);

check('resolveBackends: non-positive weight normalizes to 1',
  resolveBackends([{ baseUrl: 'http://h:11434', weight: -5 }])[0].weight === 1);

check('resolveBackends: label defaults to host:port',
  resolveBackends([{ baseUrl: 'http://workstation:11434' }])[0].label === 'workstation:11434');

check('singleBackend: localhost flagged isLocal',
  singleBackend('http://localhost:11434').isLocal === true);

check('singleBackend: 127.0.0.1 flagged isLocal',
  singleBackend('http://127.0.0.1:11434').isLocal === true);

check('singleBackend: remote host not isLocal',
  singleBackend('http://workstation:11434').isLocal === false);

// ── classifyOllamaError (retryability table) ──────────────────────────────

check('classify: HTTP 503 → retryable + cooldown',
  (() => { const d = classifyOllamaError(new Error('x'), 503); return d.retryable && d.cooldown; })());

check('classify: HTTP 429 → retryable + cooldown',
  (() => { const d = classifyOllamaError(new Error('x'), 429); return d.retryable && d.cooldown; })());

check('classify: HTTP 400 → NOT retryable, NOT cooldown (context overflow is not a host fault)',
  (() => { const d = classifyOllamaError(new Error('x'), 400); return !d.retryable && !d.cooldown; })());

check('classify: HTTP 400 → contextOverflow=true (M9 ctx-fallback seam trigger)',
  (() => { const d = classifyOllamaError(new Error('x'), 400); return d.contextOverflow === true; })());

check('classify: HTTP 404 → NOT contextOverflow (genuine client error, no window escalation)',
  (() => { const d = classifyOllamaError(new Error('x'), 404); return !d.contextOverflow; })());

check('classify: HTTP 404 → NOT retryable',
  (() => { const d = classifyOllamaError(new Error('x'), 404); return !d.retryable; })());

check('classify: ECONNREFUSED → retryable + cooldown',
  (() => { const d = classifyOllamaError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }); return d.retryable && d.cooldown; })());

check('classify: ETIMEDOUT → retryable + cooldown',
  (() => { const d = classifyOllamaError({ code: 'ETIMEDOUT' }); return d.retryable && d.cooldown; })());

check('classify: ENOTFOUND (DNS) → retryable + cooldown + DNS reason (triggers Tailscale fallback)',
  (() => { const d = classifyOllamaError({ code: 'ENOTFOUND' }); return d.retryable && d.cooldown && d.reason === 'DNS resolution failed'; })());

check('classify: connect-timeout abort marker → retryable + cooldown',
  (() => {
    const e = new Error(`Ollama connect timeout ${CONNECT_TIMEOUT_MARKER}`);
    e.name = 'AbortError';
    const d = classifyOllamaError(e);
    return d.retryable && d.cooldown;
  })());

check('classify: stream-start timeout marker → retryable + cooldown',
  (() => {
    const e = new Error(`Ollama stream start timeout ${CONNECT_TIMEOUT_MARKER}`);
    e.name = 'AbortError';
    const d = classifyOllamaError(e);
    return d.retryable && d.cooldown && d.reason.includes('stream start timeout');
  })());

check('classify: plain operator abort → NOT retryable, NOT cooldown',
  (() => {
    const e = new Error('aborted by user');
    e.name = 'AbortError';
    const d = classifyOllamaError(e);
    return !d.retryable && !d.cooldown;
  })());

// ── weighted selection ────────────────────────────────────────────────────

(() => {
  _resetCooldownsForTest();
  // weight 3 (workstation) at cumulative roll 0.1*4=0.4 < 3 → workstation.
  const r = selectBackend({ backends: TWO_BACKENDS, exclude: noExclude(), servesModel: servesAll, now: Date.now(), rng: seq([0.1]) });
  check('select: weighted shuffle picks heavier backend on a low roll', r?.backend.label === 'workstation');
})();

(() => {
  _resetCooldownsForTest();
  // roll 0.95*4=3.8 → past workstation's weight(3) → localhost.
  const r = selectBackend({ backends: TWO_BACKENDS, exclude: noExclude(), servesModel: servesAll, now: Date.now(), rng: seq([0.95]) });
  check('select: high roll lands on the lighter backend', r?.backend.label === 'localhost');
})();

(() => {
  _resetCooldownsForTest();
  // servesModel false for workstation → only localhost is a candidate.
  const r = selectBackend({
    backends: TWO_BACKENDS,
    exclude: noExclude(),
    servesModel: (b) => b.label === 'localhost',
    now: Date.now(),
    rng: seq([0.5]),
  });
  check('select: excludes a backend that does not serve the model', r?.backend.label === 'localhost' && r?.candidateCount === 1);
})();

// ── cooldown → failover to a healthy peer ─────────────────────────────────

(() => {
  _resetCooldownsForTest();
  const events: OllamaRoutingEvent[] = [];
  const now = Date.now();
  // workstation fails with a 503. TWO healthy backends exist → cool it.
  reportFailure({
    backend: TWO_BACKENDS[0],
    decision: classifyOllamaError(new Error('boom'), 503),
    healthyServingCount: 2,
    now,
    emit: (e) => events.push(e),
  });
  check('cooldown: a 503 with a healthy peer COOLS the failing backend',
    isBackendCooled(TWO_BACKENDS[0].baseUrl, now + 100));
  check('cooldown: emits a cooldown_start event (events.jsonl source)',
    events.some((e) => e.kind === 'cooldown_start'));

  // Re-select excluding the failed host → must land on the healthy peer.
  const r = selectBackend({
    backends: TWO_BACKENDS,
    exclude: new Set([TWO_BACKENDS[0].baseUrl]),
    servesModel: servesAll,
    now: now + 100,
    rng: seq([0.5]),
  });
  check('failover: re-selection lands on the healthy peer (cooled host excluded)',
    r?.backend.label === 'localhost');
})();

// ── never-cool-the-last-backend guard ─────────────────────────────────────

(() => {
  _resetCooldownsForTest();
  const events: OllamaRoutingEvent[] = [];
  const now = Date.now();
  const solo = [TWO_BACKENDS[0]];
  // Only ONE healthy serving backend → cooling it would strand the operator.
  reportFailure({
    backend: solo[0],
    decision: classifyOllamaError(new Error('boom'), 503),
    healthyServingCount: 1,
    now,
    emit: (e) => events.push(e),
  });
  check('never-cool-last: the sole healthy backend is NOT cooled',
    !isBackendCooled(solo[0].baseUrl, now + 100));
  check('never-cool-last: emits the cooldown_skip_last guard event',
    events.some((e) => e.kind === 'cooldown_skip_last'));
  // It must stay selectable.
  const r = selectBackend({ backends: solo, exclude: noExclude(), servesModel: servesAll, now: now + 100, rng: seq([0.5]) });
  check('never-cool-last: the guarded backend stays selectable', r?.backend.label === 'workstation');
})();

(() => {
  _resetCooldownsForTest();
  // A 400 (non-cooling decision) must never cool, regardless of peer count.
  const now = Date.now();
  reportFailure({
    backend: TWO_BACKENDS[0],
    decision: classifyOllamaError(new Error('overflow'), 400),
    healthyServingCount: 2,
    now,
  });
  check('cooldown: a 400 (non-cooling error) does NOT cool the backend',
    !isBackendCooled(TWO_BACKENDS[0].baseUrl, now + 100));
})();

// ── backoff: instant with a peer, exponential without ─────────────────────

check('backoff: ZERO when a healthy peer exists (instant failover)',
  backoffMs(true, 0) === 0 && backoffMs(true, 5) === 0);

check('backoff: jittered exponential when forced onto the last host (attempt 0 ≈ 500–1250ms)',
  (() => { const ms = backoffMs(false, 0, seq([0])); return ms === 500; })());

check('backoff: grows with attempt (attempt 2 base = 2000ms, +jitter)',
  (() => { const ms = backoffMs(false, 2, seq([0])); return ms === 2000; })());

check('backoff: capped at 8s base',
  (() => { const ms = backoffMs(false, 20, seq([0])); return ms === 8000; })());

// ── cooldown lazy recovery ────────────────────────────────────────────────

(() => {
  _resetCooldownsForTest();
  const now = Date.now();
  reportFailure({
    backend: TWO_BACKENDS[0],
    decision: classifyOllamaError({ code: 'ECONNREFUSED' }),
    healthyServingCount: 2,
    now,
  });
  check('lazy recovery: cooled now', isBackendCooled(TWO_BACKENDS[0].baseUrl, now + 100));
  // Remote TTL is 12s — past that, lazily recovered.
  check('lazy recovery: selectable again after the TTL lapses (no background prober)',
    !isBackendCooled(TWO_BACKENDS[0].baseUrl, now + 20_000));
})();

// ── summary ────────────────────────────────────────────────────────────────

console.log('');
console.log(`ollama-resilience: ${passes}/${passes + fails} checks passed`);
if (fails > 0) {
  console.log('');
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
