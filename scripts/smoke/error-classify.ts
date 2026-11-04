// Workbench Expansion C1 — error-classifier taxonomy unit smoke.
//
// PURE unit test — NO WebSocket, NO server boot, NO live providers. Feeds
// representative provider error payloads (raw strings, Error objects, and
// nested {status, error:{type,message}} shapes) into classifyError and asserts
// the resulting {reason, action, permanent} triple.
//
// Run: npm run smoke:error-classify  (no dev server needed)

import { classifyError } from '../../server/src/providers/errorClassifier.js';
import type { FailoverReason, FailoverAction } from '../../server/src/providers/errorClassifier.js';
import type { ProviderName } from '@arco/shared';

let passes = 0;
let fails = 0;
const failures: string[] = [];

function check(
  label: string,
  provider: ProviderName,
  err: unknown,
  reason: FailoverReason,
  action: FailoverAction,
  permanent?: boolean,
): void {
  const got = classifyError(provider, err);
  const okReason = got.reason === reason;
  const okAction = got.action === action;
  const okPerm = permanent === undefined ? true : got.permanent === permanent;
  if (okReason && okAction && okPerm) {
    console.log(`  PASS  ${label}  → ${got.reason}/${got.action}${got.permanent ? '/permanent' : ''}`);
    passes++;
  } else {
    const expPerm = permanent === undefined ? '' : `/perm=${permanent}`;
    const msg = `${label}: expected ${reason}/${action}${expPerm}, got ${got.reason}/${got.action}/perm=${got.permanent}`;
    console.log(`  FAIL  ${msg}`);
    failures.push(msg);
    fails++;
  }
}

// ── Auth: transient (401, refreshable token) vs permanent (invalid key) ──
check('401 status only', 'claude', { status: 401, error: { message: 'Unauthorized' } }, 'auth', 'rotate');
check('"Unauthorized" string', 'codex', 'Unauthorized', 'auth', 'rotate');
check('expired token → transient auth', 'strata', { status: 401, error: { message: 'token expired, please reauthenticate' } }, 'auth', 'rotate');
check(
  'invalid_api_key → permanent auth',
  'claude',
  { status: 401, error: { type: 'authentication_error', message: 'invalid_api_key' } },
  'auth_permanent',
  'fail',
  true,
);
check('403 permission_error → permanent auth', 'codex', { status: 403, error: { type: 'permission_error', message: 'permission denied' } }, 'auth_permanent', 'fail', true);

// ── Billing → rotate ──
check('billing/payment 402', 'codex', { status: 402, error: { message: 'Payment required' } }, 'billing', 'rotate', true);
check('insufficient_quota string', 'codex', new Error('You exceeded your current quota: insufficient_quota'), 'billing', 'rotate', true);
check('credit balance too low', 'claude', { error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the API.' } }, 'billing', 'rotate', true);

// ── Rate limit (429 / usage limit) → backoff_then_rotate ──
check('429 status', 'codex', { status: 429, error: { message: 'Too Many Requests' } }, 'rate_limit', 'backoff_then_rotate');
check('Anthropic rate_limit_error', 'claude', { status: 429, error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit' } }, 'rate_limit', 'backoff_then_rotate');
check('CLI "usage limit reached" string', 'claude', 'Claude AI usage limit reached. Try again at 7:00pm.', 'rate_limit', 'backoff_then_rotate');

// ── Overloaded (503/529 / overloaded_error) → backoff ──
check('Anthropic overloaded_error', 'claude', { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'overloaded', 'backoff');
check('503 service unavailable', 'strata', { status: 503, error: { message: 'Service Unavailable' } }, 'overloaded', 'backoff');
check('529 capacity status', 'claude', { status: 529, error: { message: 'Overloaded' } }, 'overloaded', 'backoff');

// ── Context overflow → compress (NOT failover) ──
check('Anthropic "prompt is too long"', 'claude', { status: 400, error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens > 200000 maximum' } }, 'context_overflow', 'compress');
check('OpenAI context_length_exceeded', 'codex', { status: 400, error: { code: 'context_length_exceeded', message: "This model's maximum context length is exceeded" } }, 'context_overflow', 'compress');
check('413 payload too large', 'claude', { status: 413, error: { message: 'request too large' } }, 'context_overflow', 'compress');

// ── Model not found → fallback ──
check('OpenAI model_not_found', 'codex', { status: 404, error: { code: 'model_not_found', message: 'The model `gpt-9` does not exist' } }, 'model_not_found', 'fallback');
check('deprecated model string', 'claude', new Error('The model has been deprecated'), 'model_not_found', 'fallback');

// ── Content policy → no_retry ──
check('content_policy block', 'claude', { error: { type: 'invalid_request_error', message: 'Output blocked by content policy' } }, 'content_policy_blocked', 'no_retry', true);
check('provider content safety block', 'strata', { error: { message: 'blocked by content safety filter (responsible AI)' } }, 'content_policy_blocked', 'no_retry', true);

// ── Anthropic OAuth long-context beta forbidden (specific) ──
check(
  'oauth_long_context_beta forbidden',
  'claude',
  { status: 403, error: { type: 'permission_error', message: 'The oauth_long_context_beta beta is not available for this account' } },
  'oauth_long_context_beta_forbidden',
  'fail',
  true,
);

// ── Network / transient → backoff ──
check('ECONNRESET', 'strata', new Error('read ECONNRESET'), 'network', 'backoff');
check('fetch failed', 'ollama', new Error('fetch failed'), 'network', 'backoff');

// ── Generic 5xx → server_error backoff ──
check('500 internal error', 'codex', { status: 500, error: { message: 'Internal server error' } }, 'server_error', 'backoff');

// ── Unknown → conservative backoff ──
check('empty/unknown', 'claude', null, 'unknown', 'backoff');
check('gibberish string', 'claude', 'something weird happened', 'unknown', 'backoff');

// ── Summary ──
const total = passes + fails;
console.log('');
console.log(`error-classify: ${passes}/${total} checks passed`);
if (fails > 0) {
  console.log('');
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
