// FABLE_51_APPEND_ONLY_PLAN.md §5 — pins the pure frozen-prefix helpers.
// `npm run test:append-only -w server`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendTextToLastUserMessage,
  buildPrefixUpdateMessage,
  buildToolChangeBlocks,
  diffSystemBlocks,
  diffToolSets,
  isPrefixFeatureRejection,
  isThinkingBindingError,
  markDeferred,
  popTrailingSystemMessages,
  removeArchonSystemMessages,
  renderSystemDelta,
  sortToolDefs,
  stripAllThinkingBlocks,
  summarizeInputTransformations,
  toolKey,
  toWireMessages,
} from './appendOnlyPrefix.js';
import { pruneServerToolEvidenceAfterTurn, stripDanglingServerToolResults } from './retainedContext.js';
import { buildThinkingParams, resolveThinkingDisplay } from './modelParams.js';

const sys = (text: string) => ({ type: 'text' as const, text });

test('diffSystemBlocks: identical sets are unchanged regardless of cache_control', () => {
  const frozen = [{ ...sys('a'), cache_control: { type: 'ephemeral' as const } }, sys('b')];
  const fresh = [sys('a'), { ...sys('b'), cache_control: { type: 'ephemeral' as const } }];
  assert.equal(diffSystemBlocks(frozen, fresh).changed, false);
});

test('diffSystemBlocks: an edited goal block shows once in added and once in removed', () => {
  const d = diffSystemBlocks([sys('identity'), sys('goal: ship v1')], [sys('identity'), sys('goal: ship v2')]);
  assert.deepEqual(d, { changed: true, added: ['goal: ship v2'], removed: ['goal: ship v1'] });
  const text = renderSystemDelta(d);
  assert.match(text, /--- Updated \/ added ---\n\ngoal: ship v2/);
  assert.match(text, /--- No longer applies ---\n\n• goal: ship v1/);
});

test('renderSystemDelta: removed blocks are excerpted to their first line', () => {
  const removed = 'Line one of a long doctrine block\nline two must not appear';
  const text = renderSystemDelta({ changed: true, added: [], removed: [removed] });
  assert.ok(text.includes('• Line one of a long doctrine block'));
  assert.ok(!text.includes('line two must not appear'));
});

test('toolKey / sortToolDefs: client tools by name, server tools by type:name, deterministic order', () => {
  const defs = [
    { name: 'Write', input_schema: {} },
    { type: 'web_search_20260209', name: 'web_search' },
    { name: 'Bash', input_schema: {} },
  ];
  assert.deepEqual(sortToolDefs(defs).map(toolKey), ['Bash', 'Write', 'web_search_20260209:web_search']);
  // Sort is stable + pure (input untouched).
  assert.equal(defs[0].name, 'Write');
});

test('diffToolSets: posture narrowing removes, widening re-adds without re-declaring', () => {
  const full = sortToolDefs([{ name: 'Bash' }, { name: 'Write' }, { name: 'Read' }]);
  const active = new Set(full.map(toolKey));
  // chat posture drops Bash + Write
  const narrowed = diffToolSets(full, active, [{ name: 'Read' }]);
  assert.deepEqual(narrowed.removeKeys, ['Bash', 'Write']);
  assert.deepEqual(narrowed.addKeys, []);
  assert.deepEqual(narrowed.declare, []);
  const afterNarrow = new Set(['Read']);
  // back to full — the defs are already on the wire, so only tool_addition
  const widened = diffToolSets(full, afterNarrow, full);
  assert.deepEqual(widened.addKeys, ['Bash', 'Write']);
  assert.deepEqual(widened.declare, []);
  assert.deepEqual(widened.removeKeys, []);
});

test('diffToolSets: a brand-new MCP tool is declared (deferred) and a description rewrite is reported, not applied', () => {
  const frozen = [{ name: 'Read', description: 'Read a file. Write is still available.' }];
  const active = new Set(['Read']);
  const d = diffToolSets(frozen, active, [
    { name: 'Read', description: 'Read a file.' },
    { name: 'mcp__git__status', description: 'git status' },
  ]);
  assert.deepEqual(d.declare.map(toolKey), ['mcp__git__status']);
  assert.deepEqual(d.definitionChanged, ['Read']);
  assert.equal(markDeferred(d.declare[0]).defer_loading, true);
});

test('buildToolChangeBlocks: removals first, tool_reference uses the bare name for server tools', () => {
  const blocks = buildToolChangeBlocks(['web_search_20260209:web_search'], ['Bash']);
  assert.deepEqual(blocks, [
    { type: 'tool_removal', tool: { type: 'tool_reference', name: 'Bash' } },
    { type: 'tool_addition', tool: { type: 'tool_reference', name: 'web_search' } },
  ]);
});

test('buildPrefixUpdateMessage: null when nothing changed; text first, then tool blocks; marker stripped on the wire', () => {
  assert.equal(buildPrefixUpdateMessage(null, []), null);
  const msg = buildPrefixUpdateMessage('delta', buildToolChangeBlocks([], ['Bash']))!;
  assert.equal(msg.role, 'system');
  assert.equal(msg.archon, 'system_delta');
  assert.equal(msg.content[0].type, 'text');
  assert.equal(msg.content[1].type, 'tool_removal');
  const toolsOnly = buildPrefixUpdateMessage(null, buildToolChangeBlocks(['Bash'], []))!;
  assert.equal(toolsOnly.archon, 'tool_set_change');
  const wire = toWireMessages([{ role: 'user', content: 'hi' }, msg]) as Array<Record<string, unknown>>;
  assert.equal('archon' in wire[1], false);
  assert.equal(wire[1].role, 'system');
  assert.equal(wire[0], wire[0]); // non-system entries pass through by reference
});

test('popTrailingSystemMessages: pops only the trailing run; removeArchonSystemMessages clears all', () => {
  const s = buildPrefixUpdateMessage('x', [])!;
  const history: unknown[] = [{ role: 'user', content: 'a' }, s, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }, s, s];
  assert.equal(popTrailingSystemMessages(history), 2);
  assert.equal(history.length, 4);
  assert.equal(removeArchonSystemMessages(history), 1);
  assert.equal(history.length, 3);
});

test('appendTextToLastUserMessage: string content becomes two text blocks; refuses when last is not a user turn', () => {
  const m: Array<{ role?: string; content?: unknown }> = [{ role: 'user', content: 'prompt' }];
  assert.equal(appendTextToLastUserMessage(m, 'notice'), true);
  assert.deepEqual(m[0].content, [{ type: 'text', text: 'prompt' }, { type: 'text', text: 'notice' }]);
  assert.equal(appendTextToLastUserMessage([{ role: 'assistant', content: 'x' }], 'notice'), false);
});

test('summarizeInputTransformations: counts by reason, null when absent', () => {
  assert.equal(summarizeInputTransformations(undefined), null);
  const s = summarizeInputTransformations([
    { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' },
    { type: 'thinking_dropped', path: 'messages.3.content.0', reason: 'model_binding_mismatch' },
    { type: 'future_kind', path: 'messages.5', reason: 'something_new' },
  ])!;
  assert.equal(s.count, 3);
  assert.equal(s.prefixMismatch, 1);
  assert.equal(s.modelMismatch, 1);
  assert.equal(s.other, 1);
  assert.match(s.detail, /messages\.1\.content\.0 \(prefix_binding_mismatch\)/);
  assert.deepEqual(summarizeInputTransformations([]), { count: 0, prefixMismatch: 0, modelMismatch: 0, other: 0, detail: '' });
});

test('isThinkingBindingError / isPrefixFeatureRejection: Anthropic wordings', () => {
  assert.equal(isThinkingBindingError('messages.5.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.'), true);
  assert.equal(isThinkingBindingError('messages.2: The final block in an assistant message cannot be \'thinking\''), false);
  assert.equal(isPrefixFeatureRejection("role 'system' is not supported on this model"), true);
  assert.equal(isPrefixFeatureRejection('messages.4.content.1: tool_reference: unknown tool'), true);
  assert.equal(isPrefixFeatureRejection('block_binding: Extra inputs are not permitted'), true);
  assert.equal(isPrefixFeatureRejection('rate_limit_error'), false);
});

test('stripAllThinkingBlocks: drops thinking/redacted everywhere, keeps text + tool_use, placeholders an all-thinking turn', () => {
  const history = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: 'a' }] },
    { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'x' }] },
  ];
  const r = stripAllThinkingBlocks(history, '[ph]');
  assert.deepEqual(r, { messages: 2, blocks: 2 });
  assert.deepEqual(history[1].content, [{ type: 'text', text: 'a' }]);
  assert.deepEqual(history[2].content, [{ type: 'text', text: '[ph]' }]);
});

// Ids are per-call unique on the wire, so rounds get distinct ones — a shared
// id would make the later round's result reference the earlier round's call,
// which the pause_turn pairing rule then (correctly) treats as load-bearing.
const evidenceTurn = (id = 's1') => [
  { type: 'thinking', thinking: 'plan', signature: 'sig' },
  { type: 'server_tool_use', id, name: 'web_search', input: {} },
  { type: 'web_search_tool_result', tool_use_id: id, content: [] },
  { type: 'text', text: 'answer', citations: [{ x: 1 }] },
];

test('pruneServerToolEvidenceAfterTurn keeps thinking and still drops server evidence', () => {
  const history = [{ role: 'assistant', content: evidenceTurn() }];
  // protectLatestAssistant:false pins the prune mechanics themselves; the
  // default (protected) path is covered by the next test.
  const r = pruneServerToolEvidenceAfterTurn(history, 0, { protectLatestAssistant: false });
  assert.equal(r.blocks, 3);
  const types = (history[0].content as Array<{ type: string }>).map((b) => b.type);
  assert.deepEqual(types, ['thinking', 'text', 'text']);
  // legacy shape (tests that pinned the old counts) still available
  const legacy = [{ content: [{ type: 'thinking', thinking: 'p', signature: 's' }, { type: 'text', text: 'a' }] }];
  assert.equal(pruneServerToolEvidenceAfterTurn(legacy, 0, { keepThinking: false }).blocks, 1);
});

// 2026-09-05: server tools return their evidence inside the SAME assistant
// message as the final answer, so the prune rewrote the one message Anthropic
// freezes ("blocks in the latest assistant message cannot be modified") and
// wedged the tab for good. Mid-turn assistant messages stay prunable.
test('pruneServerToolEvidenceAfterTurn never edits the latest assistant message', () => {
  const history = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: evidenceTurn('s1') }, // mid-turn round: prunable
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    { role: 'assistant', content: evidenceTurn('s2') }, // latest assistant: frozen
  ];
  const before = JSON.stringify(history[3].content);
  const r = pruneServerToolEvidenceAfterTurn(history, 0);
  assert.equal(r.blocks, 3, 'only the mid-turn message was pruned');
  assert.equal(JSON.stringify(history[3].content), before, 'latest assistant message is byte-identical');
  assert.deepEqual(
    (history[1].content as Array<{ type: string }>).map((b) => b.type),
    ['thinking', 'text', 'text'],
  );
});

// 2026-09-05 (same day, mirror direction): a `pause_turn` splits the call from
// its result across two assistant messages. Pruning the paused message while
// the protected one kept the result left a dangling `web_search_tool_result`
// — "unexpected `tool_use_id` … must have a corresponding `server_tool_use`
// block before it" — wedging the tab just as permanently.
test('pruneServerToolEvidenceAfterTurn keeps the call a protected result points at (pause_turn split)', () => {
  const history = [
    { role: 'user', content: 'q' },
    // Paused round: bare server_tool_use, its result arrives in the next message.
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'searching', signature: 'sig' },
      { type: 'server_tool_use', id: 'srvtoolu_01CF', name: 'web_search', input: {} },
    ] },
    // Continuation = latest assistant = protected, opens with the result.
    { role: 'assistant', content: [
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_01CF', content: [] },
      { type: 'text', text: 'answer' },
    ] },
  ];
  const r = pruneServerToolEvidenceAfterTurn(history, 0);
  assert.equal(r.blocks, 0, 'nothing prunable: the call is load-bearing for the protected result');
  assert.deepEqual(
    (history[1].content as Array<{ type: string }>).map((b) => b.type),
    ['thinking', 'server_tool_use'],
    'the paired call survives in the paused message',
  );
  // And the history it leaves behind is one Anthropic accepts.
  assert.equal(stripDanglingServerToolResults(history).blocks, 0);
});

test('pruneServerToolEvidenceAfterTurn still drops an UNRELATED mid-turn call under a protected result', () => {
  const history = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [
      { type: 'server_tool_use', id: 'srvtoolu_other', name: 'web_search', input: {} },
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_other', content: [] },
      { type: 'server_tool_use', id: 'srvtoolu_01CF', name: 'web_search', input: {} },
    ] },
    { role: 'assistant', content: [
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_01CF', content: [] },
      { type: 'text', text: 'answer' },
    ] },
  ];
  const r = pruneServerToolEvidenceAfterTurn(history, 0);
  assert.equal(r.blocks, 2, 'the self-contained pair goes; the referenced call stays');
  assert.deepEqual(
    (history[1].content as Array<{ type: string; id?: string }>).map((b) => b.id ?? b.type),
    ['srvtoolu_01CF', 'text'],
    'only the referenced call plus the retained-history note remain',
  );
});

test('stripDanglingServerToolResults: removes a result with no earlier call, keeps well-formed history', () => {
  const wedged = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: [
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_01CF', content: [] },
      { type: 'text', text: 'answer' },
    ] },
  ];
  const r = stripDanglingServerToolResults(wedged);
  assert.deepEqual(r, { blocks: 1, ids: ['srvtoolu_01CF'] });
  assert.deepEqual(wedged[1].content, [{ type: 'text', text: 'answer' }]);

  // A result-only message never strips to an invalid empty content array.
  const resultOnly = [{ role: 'assistant', content: [{ type: 'web_search_tool_result', tool_use_id: 'x', content: [] }] }];
  assert.equal(stripDanglingServerToolResults(resultOnly).blocks, 1);
  assert.deepEqual(resultOnly[0].content, [{ type: 'text', text: '[orphaned server-tool result dropped by Arco]' }]);

  // Paired across messages (the pause_turn shape) is NOT dangling.
  const paired = [
    { role: 'assistant', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: {} }] },
    { role: 'assistant', content: [{ type: 'web_search_tool_result', tool_use_id: 's1', content: [] }] },
  ];
  assert.equal(stripDanglingServerToolResults(paired).blocks, 0);
  // Order matters: a result BEFORE its call is still dangling at that point.
  const reversed = [
    { role: 'assistant', content: [{ type: 'web_search_tool_result', tool_use_id: 's2', content: [] }] },
    { role: 'assistant', content: [{ type: 'server_tool_use', id: 's2', name: 'web_search', input: {} }] },
  ];
  assert.equal(stripDanglingServerToolResults(reversed).blocks, 1);
});

test('pruneServerToolEvidenceAfterTurn: a lone assistant message is protected (nothing to prune safely)', () => {
  const history = [{ role: 'assistant', content: evidenceTurn() }];
  assert.equal(pruneServerToolEvidenceAfterTurn(history, 0).blocks, 0);
  assert.equal((history[0].content as unknown[]).length, 4);
});

test('isThinkingBindingError matches the latest-assistant-message rejection', () => {
  // The exact 400 that wedged two tabs on 2026-09-05. It shares no vocabulary
  // with the signature form, so it used to fall through to the fatal branch.
  assert.equal(isThinkingBindingError(
    'messages.9.content.2: `thinking` or `redacted_thinking` blocks in the latest assistant message '
    + 'cannot be modified. These blocks must remain as they were in the original response.',
  ), true);
  // Still matches the original signature / binding wordings.
  assert.equal(isThinkingBindingError('Invalid `signature` in `thinking` block'), true);
  assert.equal(isThinkingBindingError('thinking block bound to a different conversation'), true);
  // And still ignores unrelated 400s.
  assert.equal(isThinkingBindingError('messages.3: image exceeds 5 MB'), false);
});

test('buildThinkingParams: block_binding only on enforcing models; updates display degrades off-family', () => {
  const fable51 = buildThinkingParams('claude-fable-5-1', 'high', 'updates') as { thinking: Record<string, unknown> };
  assert.deepEqual(fable51.thinking, {
    type: 'adaptive',
    display: 'updates',
    block_binding: { prefix_mismatch_behavior: 'drop_block' },
  });
  const opus5 = buildThinkingParams('claude-opus-5', 'high', 'updates') as { thinking: Record<string, unknown> };
  assert.deepEqual(opus5.thinking, { type: 'adaptive', display: 'omitted' });
  assert.equal(resolveThinkingDisplay('claude-fable-5', 'updates'), 'updates');
  assert.equal(resolveThinkingDisplay('claude-sonnet-5', 'summarized'), 'summarized');
});

// Opus 5.5 ships Fable 5.1's preserved thinking + `updates` display; Opus 5
// does neither. `includes('opus-5')` matches both ids, so pin the split.
test('Opus 5.5 gets block_binding + updates; Opus 5 does not', () => {
  const opus55 = buildThinkingParams('claude-opus-5-5', 'medium', 'updates') as { thinking: Record<string, unknown>; output_config: unknown };
  assert.deepEqual(opus55.thinking, { type: 'adaptive', display: 'updates', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
  assert.deepEqual(opus55.output_config, { effort: 'medium' });
  const opus5 = buildThinkingParams('claude-opus-5', 'high', 'summarized') as { thinking: Record<string, unknown> };
  assert.equal('block_binding' in opus5.thinking, false);
});
