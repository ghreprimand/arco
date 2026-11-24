import test from 'node:test';
import assert from 'node:assert/strict';
import { codexModelForTurn, codexModelFallbackNotice, codexVersionOf, readableCodexModelError } from './modelAvailability.js';

// Codex 0.150.1 on a ChatGPT account lists only the 5.6 models; a member saved
// with gpt-6.2-sol by a newer Codex failed every turn with
// model_not_in_accessible_catalog.
const OFFERED_BY_0_150 = [
  { id: 'gpt-reserve', hidden: true },
  { id: 'gpt-5.6-sol', isDefault: true },
  { id: 'gpt-5.6-terra' },
  { id: 'gpt-5.6-luna' },
];

test('a saved model this Codex does not offer runs on its default model and is named in the notice', () => {
  const choice = codexModelForTurn('gpt-6.2-sol', OFFERED_BY_0_150);
  assert.deepEqual(choice, { model: 'gpt-5.6-sol', unavailable: 'gpt-6.2-sol' });
  assert.equal(codexVersionOf('arco/0.150.1 (Linux Unknown; x86_64) unknown (arco; 0.1.0)'), '0.150.1');
  assert.equal(codexModelFallbackNotice({ model: 'gpt-5.6-sol', unavailable: 'gpt-6.2-sol' }, '0.150.1'),
    'Codex 0.150.1 does not offer gpt-6.2-sol for this account, so this conversation is using gpt-5.6-sol. Choose a model in the model picker, or update Codex to use gpt-6.2-sol.');
  assert.deepEqual(codexModelForTurn('gpt-5.6-terra', OFFERED_BY_0_150), { model: 'gpt-5.6-terra' });
  assert.deepEqual(codexModelForTurn('gpt-6.2-sol', []), { model: 'gpt-6.2-sol' });
  const raw = '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6.2-sol\' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found","subreason":"model_not_in_accessible_catalog"}}';
  assert.equal(readableCodexModelError(raw, 'gpt-6.2-sol', null), 'This Codex does not offer gpt-6.2-sol for this account. Choose another model in the model picker, or update Codex to use gpt-6.2-sol.');
  assert.equal(readableCodexModelError('rate limited', 'gpt-6.2-sol', null), null);
});
