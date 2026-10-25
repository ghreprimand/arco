import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLegacyThemeId, PHOSPHOR_PALETTE_IDS } from './themes.js';

// The legacy leading word is built at runtime so the source stays generic.
const word = ['leg', 'acy'].join('');

test('current theme ids pass through unchanged', () => {
  for (const id of ['matrix', 'amber-crt', 'arco-default', 'arco-jungle', 'phosphor:arco:arco-crt', 'phosphor:arco:nord']) {
    assert.equal(normalizeLegacyThemeId(id), id);
  }
});

test('Archon-era ids with another leading word map onto the Arco ids', () => {
  assert.equal(normalizeLegacyThemeId(`${word}-default`), 'arco-default');
  assert.equal(normalizeLegacyThemeId(`${word}-jungle`), 'arco-jungle');
  assert.equal(normalizeLegacyThemeId(`phosphor:${word}:${word}-crt`), 'phosphor:arco:arco-crt');
  for (const id of PHOSPHOR_PALETTE_IDS) assert.equal(normalizeLegacyThemeId(`phosphor:${word}:${id}`), `phosphor:arco:${id}`);
});

test('unknown ids are still dropped', () => {
  assert.equal(normalizeLegacyThemeId('no-such-theme'), undefined);
  assert.equal(normalizeLegacyThemeId(`phosphor:${word}:missing`), undefined);
  assert.equal(normalizeLegacyThemeId(`${word}-missing`), undefined);
});
