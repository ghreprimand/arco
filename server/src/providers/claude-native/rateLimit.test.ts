// Unit tests for H10 — Claude-native rate-limit header parsing.
//
// Contracts:
//  • getHeader is case-insensitive across Headers/Map/record shapes;
//  • retry-after parses both delta-seconds and an absolute date, never negative;
//  • resolveRateLimitWait prefers retry-after, else the soonest *-reset;
//  • the wait is capped at MAX_RATE_LIMIT_WAIT_MS;
//  • classifyRateLimit splits genuine (429) from transient (529).
//
// Run: node --conditions development --import tsx --test src/providers/claude-native/rateLimit.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getHeader,
  retryAfterMs,
  resolveRateLimitWait,
  classifyRateLimit,
  MAX_RATE_LIMIT_WAIT_MS,
} from './rateLimit.js';

const NOW = 1_700_000_000_000;

test('getHeader: case-insensitive on a plain record', () => {
  const h = { 'Retry-After': '12', 'X-Other': 'z' };
  assert.equal(getHeader(h, 'retry-after'), '12');
  assert.equal(getHeader(h, 'RETRY-AFTER'), '12');
  assert.equal(getHeader(h, 'missing'), null);
});

test('getHeader: web Headers object via .get', () => {
  const h = new Headers({ 'retry-after': '7' });
  assert.equal(getHeader(h, 'Retry-After'), '7');
});

test('getHeader: Map shape', () => {
  const h = new Map([['Retry-After', '5']]);
  assert.equal(getHeader(h, 'retry-after'), '5');
});

test('getHeader: array value takes the first element', () => {
  const h = { 'retry-after': ['9', '99'] };
  assert.equal(getHeader(h, 'retry-after'), '9');
});

test('retryAfterMs: delta-seconds → ms', () => {
  assert.equal(retryAfterMs('30', NOW), 30_000);
  assert.equal(retryAfterMs('0', NOW), 0);
});

test('retryAfterMs: absolute RFC-3339 date → ms-from-now, never negative', () => {
  const future = new Date(NOW + 45_000).toISOString();
  assert.equal(retryAfterMs(future, NOW), 45_000);
  const past = new Date(NOW - 60_000).toISOString();
  assert.equal(retryAfterMs(past, NOW), 0);
});

test('retryAfterMs: null/empty/garbage → null', () => {
  assert.equal(retryAfterMs(null, NOW), null);
  assert.equal(retryAfterMs('   ', NOW), null);
  assert.equal(retryAfterMs('not-a-date', NOW), null);
});

test('resolveRateLimitWait: retry-after wins over reset headers', () => {
  const h = {
    'retry-after': '10',
    'anthropic-ratelimit-tokens-reset': new Date(NOW + 99_000).toISOString(),
  };
  const r = resolveRateLimitWait(h, NOW);
  assert.equal(r.waitMs, 10_000);
  assert.equal(r.source, 'retry-after');
  assert.equal(r.capped, false);
});

test('resolveRateLimitWait: falls back to the soonest *-reset', () => {
  const h = {
    'anthropic-ratelimit-requests-reset': new Date(NOW + 80_000).toISOString(),
    'anthropic-ratelimit-tokens-reset': new Date(NOW + 20_000).toISOString(),
  };
  const r = resolveRateLimitWait(h, NOW);
  assert.equal(r.waitMs, 20_000);
  assert.equal(r.source, 'anthropic-ratelimit-tokens-reset');
});

test('resolveRateLimitWait: no usable header → null wait', () => {
  const r = resolveRateLimitWait({ 'x-unrelated': '1' }, NOW);
  assert.equal(r.waitMs, null);
  assert.equal(r.source, null);
});

test('resolveRateLimitWait: clamps to the cap', () => {
  const h = { 'retry-after': String(60 * 60) }; // 1h in seconds
  const r = resolveRateLimitWait(h, NOW);
  assert.equal(r.waitMs, MAX_RATE_LIMIT_WAIT_MS);
  assert.equal(r.capped, true);
});

test('classifyRateLimit: 529 / overloaded → transient', () => {
  assert.equal(classifyRateLimit(529, '', {}), 'transient');
  assert.equal(classifyRateLimit(0, 'overloaded_error', {}), 'transient');
});

test('classifyRateLimit: 429 → genuine', () => {
  assert.equal(classifyRateLimit(429, '', { 'anthropic-ratelimit-requests-remaining': '0' }), 'genuine');
  assert.equal(classifyRateLimit(0, 'rate_limit_error', {}), 'genuine');
});
