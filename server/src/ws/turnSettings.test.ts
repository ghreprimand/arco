import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveTurnSettings, type TurnSettingsInput } from './turnSettings.js';

// Which value wins for each per-turn setting.

const input = (over: Partial<TurnSettingsInput> & { config?: TurnSettingsInput['config'] } = {}): TurnSettingsInput => ({ provider: 'claude', config: {}, cascade: null, isolatedMember: false, ...over });

test('transports: the tab choice, then the settings files, then the default; ultracode forces the Claude CLI', () => {
  assert.equal(resolveTurnSettings(input()).claudeTransport, 'cli');
  assert.equal(resolveTurnSettings(input({ cascade: { claude: { transport: 'native' } } })).claudeTransport, 'native');
  assert.equal(resolveTurnSettings(input({ config: { claudeTransport: 'cli' }, cascade: { claude: { transport: 'native' } } })).claudeTransport, 'cli');
  assert.equal(resolveTurnSettings(input({ config: { claudeTransport: 'native', ultracode: true } })).claudeTransport, 'cli');
  assert.equal(resolveTurnSettings(input({ provider: 'codex', config: { claudeTransport: 'native', ultracode: true } })).claudeTransport, 'native', 'ultracode is a Claude setting');
  assert.equal(resolveTurnSettings(input({ provider: 'codex', config: { claudeTransport: 'native', ultracode: true } })).ultracode, false);
  assert.equal(resolveTurnSettings(input()).codexTransport, 'exec');
  assert.equal(resolveTurnSettings(input({ cascade: { codex: { transport: 'appserver' } } })).codexTransport, 'appserver');
  assert.equal(resolveTurnSettings(input({ config: { codexTransport: 'exec' }, cascade: { codex: { transport: 'appserver' } } })).codexTransport, 'exec');
});

test('Native-only switches: their defaults on Native, off on every other transport', () => {
  const native = resolveTurnSettings(input({ config: { claudeTransport: 'native' } }));
  assert.deepEqual([native.claudeNativeCompact, native.claudeNativeForceInterleavedThinkingBeta, native.claudeNativeThinkingDisplay, native.efficiencyToolFilter, native.efficiencyFactForce, native.efficiencyConfigProtection, native.efficiencySandbox, native.reviewSafeMode],
    [false, false, undefined, 'off', 'off', 'on', 'off', 'off']);
  const on = { claudeTransport: 'native', claudeNativeCompact: true, claudeNativeForceInterleavedThinkingBeta: true, claudeNativeThinkingDisplay: 'summarized', efficiencyToolFilter: 'aggressive', efficiencyFactForce: 'on', efficiencyConfigProtection: 'off', efficiencySandbox: 'on', reviewSafeMode: 'on' } as TurnSettingsInput['config'];
  const armed = resolveTurnSettings(input({ config: on }));
  assert.deepEqual([armed.claudeNativeCompact, armed.claudeNativeForceInterleavedThinkingBeta, armed.claudeNativeThinkingDisplay, armed.efficiencyToolFilter, armed.efficiencyFactForce, armed.efficiencyConfigProtection, armed.efficiencySandbox, armed.reviewSafeMode],
    [true, true, 'summarized', 'aggressive', 'on', 'off', 'on', 'on']);
  const cli = resolveTurnSettings(input({ config: { ...on, claudeTransport: 'cli' } }));
  assert.deepEqual([cli.claudeNativeCompact, cli.claudeNativeForceInterleavedThinkingBeta, cli.claudeNativeThinkingDisplay, cli.efficiencyToolFilter, cli.efficiencyFactForce, cli.efficiencyConfigProtection, cli.efficiencySandbox, cli.reviewSafeMode],
    [false, false, undefined, 'off', 'off', 'off', 'off', 'off']);
  assert.equal(resolveTurnSettings(input({ config: on, isolatedMember: true })).efficiencySandbox, 'off', 'no sandbox for an isolated member');
});

test('output style, the north star and Ollama parameters', () => {
  // Every provider and transport applies the tab's style.
  assert.equal(resolveTurnSettings(input({ config: { claudeTransport: 'native', outputStyle: 'terse' } })).outputStyle, 'terse');
  assert.equal(resolveTurnSettings(input({ config: { claudeTransport: 'cli', outputStyle: 'terse' } })).outputStyle, 'terse');
  assert.equal(resolveTurnSettings(input({ provider: 'codex', config: { outputStyle: 'terse' } })).outputStyle, 'terse');
  for (const provider of ['claude', 'codex', 'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek']) {
    // Unset means the default (plain); an explicit normal is kept; legacy values are aliased.
    assert.equal(resolveTurnSettings(input({ provider, config: {} })).outputStyle, 'plain', provider);
    assert.equal(resolveTurnSettings(input({ provider, config: { outputStyle: 'normal' } })).outputStyle, 'normal', provider);
    assert.equal(resolveTurnSettings(input({ provider, config: { outputStyle: 'lite' as never } })).outputStyle, 'plain', provider);
    assert.equal(resolveTurnSettings(input({ provider, config: { outputStyle: 'caveman' as never } })).outputStyle, 'terse', provider);
  }
  // DOCS and GIT turns are forced to normal, whatever the tab says or leaves unset.
  for (const primitive of ['docs', 'git']) {
    assert.equal(resolveTurnSettings(input({ config: { claudeTransport: 'native', outputStyle: 'terse' }, primitive })).outputStyle, 'normal');
    assert.equal(resolveTurnSettings(input({ provider: 'cursor', config: {}, primitive })).outputStyle, 'normal');
  }
  assert.equal(resolveTurnSettings(input({ config: { goal: 'Ship it' }, primitive: 'docs' })).goal, 'Ship it');
  assert.equal(resolveTurnSettings(input({ config: { goal: 'Ship it' }, isolatedMember: true })).goal, undefined);
  assert.deepEqual(resolveTurnSettings(input({ provider: 'ollama', config: { ollamaParams: { temperature: 0.2 } } })).ollamaParams, { temperature: 0.2 });
  assert.equal(resolveTurnSettings(input({ provider: 'llamacpp', config: { ollamaParams: { temperature: 0.2 } } })).ollamaParams, undefined);
});

test('in-turn compaction follows the auto-compaction policy, 70% under Provider', async () => {
  const { resolveNativeInTurnCompactPercent, NATIVE_IN_TURN_COMPACT_DEFAULT_PERCENT } = await import('./turnSettings.js');
  const base = { native: true, chat: false, claudeNativeCompact: false, worker: undefined, cluster: undefined };
  assert.equal(NATIVE_IN_TURN_COMPACT_DEFAULT_PERCENT, 70);
  assert.equal(resolveNativeInTurnCompactPercent(base), 70, 'Provider');
  assert.equal(resolveNativeInTurnCompactPercent({ ...base, worker: { enabled: true, thresholdPercent: 82 } }), 82, 'the tab threshold');
  assert.equal(resolveNativeInTurnCompactPercent({ ...base, cluster: { enabled: true, thresholdPercent: 60 } }), 60, 'the cluster threshold');
  assert.equal(resolveNativeInTurnCompactPercent({ ...base, worker: { enabled: false, thresholdPercent: 80 }, cluster: { enabled: true, thresholdPercent: 60 } }), undefined, 'Off on the tab');
  assert.equal(resolveNativeInTurnCompactPercent({ ...base, cluster: { enabled: false, thresholdPercent: 60 } }), undefined, 'Off on the cluster');
  assert.equal(resolveNativeInTurnCompactPercent({ ...base, claudeNativeCompact: true }), undefined, 'the Claude API compaction beta');
  assert.equal(resolveNativeInTurnCompactPercent({ ...base, chat: true }), undefined, 'Chat');
  assert.equal(resolveNativeInTurnCompactPercent({ ...base, native: false }), undefined, 'Claude CLI');
});
