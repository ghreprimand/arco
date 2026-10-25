const SERVER_TOOL_RESULT_TYPES = new Set([
  'web_search_tool_result',
  'web_fetch_tool_result',
  'tool_search_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'container_upload',
]);

export type ServerToolResultType =
  | 'web_search_tool_result'
  | 'web_fetch_tool_result'
  | 'tool_search_tool_result'
  | 'code_execution_tool_result'
  | 'bash_code_execution_tool_result'
  | 'text_editor_code_execution_tool_result'
  | 'container_upload';

export function isServerToolResultType(type: string): type is ServerToolResultType {
  return SERVER_TOOL_RESULT_TYPES.has(type);
}

export function isClaudeServerToolDef(tool: unknown): boolean {
  const type = (tool as { type?: unknown }).type;
  return typeof type === 'string' && (
    type.startsWith('web_search_') ||
    type.startsWith('web_fetch_') ||
    type.startsWith('code_execution_')
  );
}

// Drops Anthropic server-tool evidence (web_search / web_fetch / code-exec
// results + their server_tool_use calls + citations) from the turn's messages
// once the final answer has absorbed the findings. Thinking blocks are KEPT
// (FABLE_51_APPEND_ONLY_PLAN.md §1.3): earlier builds deleted them here too,
// which meant no reasoning ever crossed a turn boundary and, on Fable 5.1,
// would invalidate the turn's later blocks. `keepThinking:false` is the legacy
// shape, retained only for tests that pin the old byte counts.
//
// The LATEST assistant message is never touched (`protectLatestAssistant`).
// Anthropic refuses any edit to it — "`thinking` or `redacted_thinking` blocks
// in the latest assistant message cannot be modified. These blocks must remain
// as they were in the original response" — and server tools return their
// evidence INSIDE the same assistant message that carries the final answer, so
// pruning it rewrote the one message the API freezes. That wedged a tab
// permanently on 2026-09-05 (workflows 1f308e4c / b27a3dce on opus-4-8: the
// prune landed, count_tokens 400'd 150ms later, and every later turn replayed
// the same broken history). Unlike the whole-prefix binding that
// `enforcesPreservedThinking` gates on, this rule is enforced far more widely,
// so protection is unconditional rather than model-keyed — the cost is one
// message's worth of retained evidence, the alternative is a dead tab.
//
// Protecting that message is not enough on its own: a `pause_turn` splits a
// server-tool call from its result across TWO assistant messages (the paused
// message ends on the bare `server_tool_use`; the continuation opens with the
// `*_tool_result` carrying that id). Pruning the paused message while the
// protected one keeps the result left a dangling result — Anthropic's mirror
// 400, "unexpected `tool_use_id` found in `web_search_tool_result` blocks …
// must have a corresponding `server_tool_use` block before it" — which wedges
// the tab exactly as permanently (2026-09-05, workflow NEO on the same day the
// protection landed). So the call blocks the protected message's results point
// at are kept wherever they live; everything else still goes.
export function pruneServerToolEvidenceAfterTurn(
  messages: Array<{ role?: string; content?: unknown }>,
  startMessageIndex: number,
  opts: { keepThinking?: boolean; protectLatestAssistant?: boolean } = {},
): { blocks: number; bytes: number } {
  const keepThinking = opts.keepThinking !== false;
  let protectedIndex = -1;
  if (opts.protectLatestAssistant !== false) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'assistant') { protectedIndex = i; break; }
    }
  }
  // Ids the protected message's server-tool RESULTS answer. Their calls stay,
  // wherever they live, or the protected result dangles (see above).
  const protectedCallIds = new Set<string>();
  if (protectedIndex >= 0) {
    const protectedContent = messages[protectedIndex]?.content;
    if (Array.isArray(protectedContent)) {
      for (const block of protectedContent as Array<Record<string, unknown>>) {
        const t = typeof block?.type === 'string' ? block.type : '';
        if (isServerToolResultType(t) && typeof block.tool_use_id === 'string') {
          protectedCallIds.add(block.tool_use_id);
        }
      }
    }
  }
  let prunedBlocks = 0;
  let prunedBytes = 0;
  for (let i = Math.max(0, startMessageIndex); i < messages.length; i++) {
    if (i === protectedIndex) continue;
    const msg = messages[i];
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    const next: Array<Record<string, unknown>> = [];
    let removedInMessage = 0;
    for (const block of content as Array<Record<string, unknown>>) {
      const t = typeof block?.type === 'string' ? block.type : '';
      const isThinking = t === 'thinking' || t === 'redacted_thinking';
      if (t === 'server_tool_use' && typeof block.id === 'string' && protectedCallIds.has(block.id)) {
        next.push(block);
        continue;
      }
      if ((isThinking && !keepThinking) || t === 'server_tool_use' || isServerToolResultType(t)) {
        prunedBlocks++;
        removedInMessage++;
        prunedBytes += Buffer.byteLength(JSON.stringify(block), 'utf8');
        continue;
      }
      if (t === 'text' && Array.isArray(block.citations)) {
        prunedBlocks++;
        removedInMessage++;
        prunedBytes += Buffer.byteLength(JSON.stringify(block.citations), 'utf8');
        const { citations: _citations, ...withoutCitations } = block;
        next.push(withoutCitations);
        continue;
      }
      next.push(block);
    }
    if (removedInMessage > 0) {
      next.push({
        type: 'text',
        text:
          `\n\n[Arco retained-history note: ${removedInMessage} server-side web/code tool evidence block(s) ` +
          'from this completed turn were omitted from future prompt context. The final answer above preserved the relevant findings; search/fetch again if raw evidence is needed.]',
      });
      msg.content = next.length > 0 ? next : [{ type: 'text', text: '[server-tool evidence omitted after completed turn]' }];
    }
  }
  return { blocks: prunedBlocks, bytes: prunedBytes };
}

// Mirror of the orphan detectors in contentBlocks.ts (`orphanToolUseIds` /
// `fullListOrphanToolUseIds`), which only ever looked for a CALL with no
// result. This looks for the other direction: a `*_tool_result` whose
// `server_tool_use` is nowhere earlier in the history. Anthropic 400s it with
// "unexpected `tool_use_id` found in `web_search_tool_result` blocks … must
// have a corresponding `server_tool_use` block before it" on EVERY later
// request, so a live worker in that state is dead until it replays from disk.
// Dropping the block is the only in-memory recovery — including from the
// protected latest assistant message, where a normal edit is forbidden but a
// message the API already rejects has nothing left to preserve.
//
// Pure over the whole array (a wedge outlives the turn that made it, so the
// turn window is the wrong scope). Returns 0 blocks on well-formed history.
export function stripDanglingServerToolResults(
  messages: Array<{ role?: string; content?: unknown }>,
): { blocks: number; ids: string[] } {
  const seenCallIds = new Set<string>();
  const ids: string[] = [];
  let blocks = 0;
  for (const msg of messages) {
    const content = msg?.content;
    if (!Array.isArray(content)) continue;
    const next: Array<Record<string, unknown>> = [];
    let removed = 0;
    for (const block of content as Array<Record<string, unknown>>) {
      const t = typeof block?.type === 'string' ? block.type : '';
      if (t === 'server_tool_use') {
        if (typeof block.id === 'string') seenCallIds.add(block.id);
        next.push(block);
        continue;
      }
      if (isServerToolResultType(t)) {
        const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
        if (!seenCallIds.has(callId)) {
          removed++;
          blocks++;
          ids.push(callId);
          continue;
        }
      }
      next.push(block);
    }
    if (removed > 0) {
      msg.content = next.length > 0
        ? next
        : [{ type: 'text', text: '[orphaned server-tool result dropped by Arco]' }];
    }
  }
  return { blocks, ids };
}
