import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewindUnavailableReason } from './rewindSupport';

test('REWIND CONVERSATION is available for Claude Native only, with a reason otherwise', () => {
  assert.equal(rewindUnavailableReason({ primaryProvider: 'claude', claudeTransport: 'native' }), null);
  // No tab override: the Settings transport decides (Native when unset).
  assert.equal(rewindUnavailableReason({ primaryProvider: 'claude' }, 'native'), null);
  assert.equal(rewindUnavailableReason({ primaryProvider: 'claude' }), null);
  assert.match(rewindUnavailableReason({ primaryProvider: 'claude' }, 'cli') ?? '', /Claude CLI/);
  assert.match(rewindUnavailableReason({ primaryProvider: 'claude', claudeTransport: 'native', ultracode: true }) ?? '', /Claude CLI/);
  for (const provider of ['codex', 'ollama', 'cursor', 'llamacpp'] as const) {
    assert.equal(rewindUnavailableReason({ primaryProvider: provider }), 'Available for Claude Native workers only.');
  }
});
