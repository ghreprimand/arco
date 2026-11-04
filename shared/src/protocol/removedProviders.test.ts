import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRIMARY_PROVIDERS, removedProviderReason, retiredProviderReason } from './providers.js';

test('every removed provider gets a removal notice instead of a generic error', () => {
  for (const provider of ['gemini', 'antigravity', 'zai']) {
    assert.match(removedProviderReason(provider)!, /support has been removed.*choose a supported provider explicitly/i, provider);
  }
  assert.match(removedProviderReason('zai')!, /^Z\.ai support has been removed/);
  for (const provider of [...PRIMARY_PROVIDERS, 'unknown-provider', '', null, undefined, 42]) {
    assert.equal(removedProviderReason(provider), undefined, String(provider));
  }
});

test('Z.ai is not retained like Gemini and Antigravity: its saved identity is discarded', () => {
  assert.equal(retiredProviderReason('zai'), undefined);
  assert.equal(removedProviderReason('gemini'), retiredProviderReason('gemini'));
  assert.equal(removedProviderReason('antigravity'), retiredProviderReason('antigravity'));
});
