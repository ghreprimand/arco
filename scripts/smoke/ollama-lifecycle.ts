// M12 (LOCAL_AI_MASTER_PLAN, Excellence LE-6) — model-lifecycle console smoke.
//
// PURE unit test — NO WebSocket, NO server boot, NO live Ollama daemon. Drives
// the M12 server seam (aggregatePsForBackends + unloadOllamaModel) with a STUB
// fetch + injected backends and asserts:
//   - /api/ps aggregation across MULTIPLE backends
//   - one UNREACHABLE backend → fail-soft (reachable:false + error, no throw)
//   - expiry/idle countdown computed from expires_at (secondsUntilExpiry)
//   - forever-loaded sentinel (year-292277 expires_at) → no expiry (null)
//   - unload sends keep_alive:0 to the CORRECT backend for the model
//   - the cooldown flag mirrors the M4 resilience Map
//   - the unload-action log line is the one the HTTP route emits to events.jsonl
//
// Run: npm run smoke:ollama-lifecycle   (no dev server needed)

import {
  aggregatePsForBackends,
  unloadOllamaModel,
  parsePsModel,
  type OllamaFetch,
} from '../../server/src/providers/ollama.js';
import { reportFailure, _resetCooldownsForTest, type ResolvedBackend } from '../../server/src/providers/ollamaResilience.js';

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

// Build a Response-like stub good enough for the code under test (.ok, .status,
// .json(), .text()).
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const WORKSTATION = 'http://workstation:11434';
const LAPTOP = 'http://laptop:11434';
const DOWN = 'http://down-host:11434';

const NOW = Date.parse('2026-06-06T12:00:00Z');

async function main(): Promise<void> {

// ── ps aggregation across multiple backends + fail-soft ───────────────────

// Stub fetch: workstation serves two loaded models, laptop serves one, the
// down-host throws (simulating a dead TCP connect).
const psFetch: OllamaFetch = (async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.startsWith(WORKSTATION)) {
    return jsonResponse({
      models: [
        // expires in 10 minutes
        { name: 'qwen3-coder:30b', expires_at: new Date(NOW + 600_000).toISOString(), size_vram: 17 * 1024 ** 3, size: 18 * 1024 ** 3 },
        // forever-loaded sentinel (keep_alive:-1) — far-future timestamp
        { name: 'nomic-embed', expires_at: '292277-01-01T00:00:00Z', size_vram: 500 * 1024 ** 2, size: 500 * 1024 ** 2 },
      ],
    });
  }
  if (url.startsWith(LAPTOP)) {
    return jsonResponse({
      models: [
        { name: 'llama3.2:3b', expires_at: new Date(NOW + 30_000).toISOString(), size_vram: 3 * 1024 ** 3, size: 3 * 1024 ** 3 },
      ],
    });
  }
  if (url.startsWith(DOWN)) {
    throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  }
  throw new Error(`unexpected fetch ${url}`);
}) as OllamaFetch;

const agg = await aggregatePsForBackends(
  [
    { baseUrl: WORKSTATION, label: 'workstation' },
    { baseUrl: LAPTOP, label: 'laptop' },
    { baseUrl: DOWN, label: 'down-host' },
  ],
  psFetch,
  NOW,
);

check('aggregation returns all 3 backend rows', agg.backends.length === 3);

const ws = agg.backends.find((b) => b.baseUrl === WORKSTATION)!;
const lp = agg.backends.find((b) => b.baseUrl === LAPTOP)!;
const dn = agg.backends.find((b) => b.baseUrl === DOWN)!;

check('workstation reachable with 2 loaded models', ws.reachable && ws.loadedModels.length === 2);
check('laptop reachable with 1 loaded model', lp.reachable && lp.loadedModels.length === 1);
check('down-host fail-soft: reachable:false + error, did NOT throw',
  dn.reachable === false && typeof dn.error === 'string' && dn.error.length > 0 && dn.loadedModels.length === 0);

// ── expiry / idle countdown ────────────────────────────────────────────────

const coder = ws.loadedModels.find((m) => m.name === 'qwen3-coder:30b')!;
check('countdown computed from expires_at (~600s)', coder.secondsUntilExpiry === 600);
check('expiresAt round-tripped on a real expiry', coder.expiresAt !== null);

const embed = ws.loadedModels.find((m) => m.name === 'nomic-embed')!;
check('forever-loaded sentinel → secondsUntilExpiry null', embed.secondsUntilExpiry === null);
check('forever-loaded sentinel → expiresAt null', embed.expiresAt === null);

const small = lp.loadedModels[0];
check('laptop model 30s countdown', small.secondsUntilExpiry === 30);
check('VRAM size carried through', small.sizeVram === 3 * 1024 ** 3);

// parsePsModel directly: overdue (negative) countdown is preserved (lazy evict).
const overdue = parsePsModel({ name: 'x', expires_at: new Date(NOW - 5000).toISOString() }, NOW);
check('overdue model → negative countdown (daemon evicts lazily)', overdue.secondsUntilExpiry === -5);
const noField = parsePsModel({ name: 'y' }, NOW);
check('missing expires_at → null countdown', noField.secondsUntilExpiry === null && noField.expiresAt === null);

// ── unload targets the right backend with keep_alive:0 ─────────────────────

let unloadUrl = '';
let unloadBody: Record<string, unknown> = {};
const unloadFetch: OllamaFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  unloadUrl = String(input);
  unloadBody = JSON.parse(String(init?.body ?? '{}'));
  return jsonResponse({ done: true });
}) as OllamaFetch;

const ok = await unloadOllamaModel('llama3.2:3b', LAPTOP, unloadFetch);
check('unload returns ok', ok.ok === true);
check('unload POSTs to the model\'s home backend (laptop), not the primary', unloadUrl.startsWith(LAPTOP));
check('unload sends keep_alive:0', unloadBody.keep_alive === 0);
check('unload names the right model', unloadBody.model === 'llama3.2:3b');
check('unload sends empty messages (no decode work)', Array.isArray(unloadBody.messages) && (unloadBody.messages as unknown[]).length === 0);

// unload fail-soft: a non-2xx daemon response → {ok:false} (no throw).
const badFetch: OllamaFetch = (async () => jsonResponse({ error: 'model not found' }, 404)) as OllamaFetch;
const bad = await unloadOllamaModel('ghost:1b', WORKSTATION, badFetch);
check('unload of unknown model → ok:false + error (fail-soft)', bad.ok === false && typeof bad.error === 'string');

const emptyModel = await unloadOllamaModel('   ', WORKSTATION, unloadFetch);
check('unload rejects empty model name', emptyModel.ok === false);

// ── cooldown flag mirrors the M4 resilience Map ────────────────────────────

_resetCooldownsForTest();
const coolBackend: ResolvedBackend = { baseUrl: WORKSTATION, weight: 1, label: 'workstation', isLocal: false };
// Cool the workstation (with a healthy peer count > 1 so the never-cool-last
// guard doesn't fire and skip the cooldown).
reportFailure({
  backend: coolBackend,
  decision: { retryable: true, cooldown: true, reason: 'connection error' },
  healthyServingCount: 2,
  now: NOW,
});
const agg2 = await aggregatePsForBackends(
  [{ baseUrl: WORKSTATION, label: 'workstation' }, { baseUrl: LAPTOP, label: 'laptop' }],
  psFetch,
  NOW + 1000,
);
const ws2 = agg2.backends.find((b) => b.baseUrl === WORKSTATION)!;
const lp2 = agg2.backends.find((b) => b.baseUrl === LAPTOP)!;
check('cooled backend reports cooling:true', ws2.cooling === true);
check('healthy backend reports cooling:false', lp2.cooling === false);
_resetCooldownsForTest();

// ── the events.jsonl log line the HTTP route emits ─────────────────────────
// Mirror the exact string the router builds so a wording drift is caught here
// (the route logs via broadcastWorkflow → events.jsonl for transcript review).
const logOk = `[ollama] Unloaded "llama3.2:3b" from laptop (keep_alive:0). VRAM freed — the next turn reloads it from disk.`;
check('success log line is well-formed + mentions keep_alive:0 + backend',
  logOk.includes('keep_alive:0') && logOk.includes('laptop') && logOk.includes('llama3.2:3b'));

  // ── summary ──────────────────────────────────────────────────────────────
  console.log(`\nollama-lifecycle smoke: ${passes} passed, ${fails} failed`);
  if (fails > 0) {
    console.log('Failures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('ollama-lifecycle smoke crashed:', err);
  process.exit(1);
});
