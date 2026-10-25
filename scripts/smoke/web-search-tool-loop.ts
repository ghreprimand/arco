// Regression smoke for the Native tool-loop stop_reason bug (2026-05-30).
//
// Bug: the Claude Native worker's tool loop decided whether to run tools from
// `stop_reason` (continue only on 'tool_use'). Opus 4.8 returns
// stop_reason 'end_turn' for a response that STILL contains an unexecuted
// client tool_use (e.g. Read) alongside a server_tool_use (web_search) — Opus
// 4.7 returned 'tool_use' for the byte-identical block shape. So the loop broke
// on 'end_turn', the client tool never dispatched (its tool_use orphaned →
// pruned next turn), and the server-side web_search never resolved. Symptom:
// the model narrates "I'll research X", Activity shows the tool calls, but
// `tools 0B` and the turn ends in ~6s. Surfaced by Opus 4.8.
//
// Fix (worker.ts): continue the loop based on the WORK Archon must do in the
// response (any client tool_use, OR the documented pause_turn server-tool
// continuation), not on stop_reason. Anthropic server tools resolve inside the
// assistant turn; do not treat a bare server_tool_use under end_turn as pending
// Archon work.
//
// This scenario reproduces the screenshot exactly — a prompt that forces BOTH a
// local client tool (Read of a seeded file) AND a server-side web_search — then
// asserts the turn ran to completion with client tool_result bytes > 0 (the
// "tools 0B" field from the token-usage panel becomes non-zero) and that
// web_search was actually invoked (so we genuinely exercised the mixed
// client+server tool path that triggers the 4.8 mislabel).
//
// NOTE: unlike most smokes this one spends REAL Anthropic + web quota (a single
// research turn). There is no way to exercise the server-tool path without a
// real round-trip. Not wired into any default/CI bundle — run it by hand when
// touching the Native tool loop:
//   npm run dev:server &
//   npm run smoke:web-search-tool-loop
//
// Exits 0 on all-pass, 1 on any failure.

import { connect, step, assert, summary, type AnyMessage } from './lib.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Web-search turns are slow (server-side fetch + multiple round-trips). Give
// the whole turn a generous ceiling.
const TURN_TIMEOUT_MS = 120_000;

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), 'archon-smoke-toolloop-'));
  // Unique marker the model can only know by Read-ing the file — guards against
  // it answering the local half from priors instead of dispatching a client tool.
  const marker = 'ARCHON-PAUSETURN-MARKER-7Q2';
  writeFileSync(join(cwd, 'NOTES.md'), `# Local notes\n\nProject codename: ${marker}\n`);

  console.log(`web_search tool-loop smoke — cwd ${cwd}`);
  console.log('');

  const c = await connect();
  let wfid = '';

  await step('create Native Opus 4.8 workflow', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        name: 'web-search tool-loop regression',
        primaryProvider: 'claude',
        primaryModel: 'claude-opus-4-8',
        primaryEffort: 'high',
        skipPermissions: true,
        workingDirectory: cwd,
        claudeTransport: 'native',
      },
    });
    const m = await c.waitFor((x) => x.type === 'workflow_created', 8000, 'workflow_created');
    wfid = m.workflowId as string;
    assert(typeof wfid === 'string' && wfid.length > 0, 'workflowId returned');
  });

  await step('research turn (local Read + server web_search) runs to completion', async () => {
    c.send({
      type: 'user_message',
      workflowId: wfid,
      content:
        'Two things, and you MUST use tools for both:\n' +
        '1. Read the file NOTES.md in the current directory and tell me the project codename it contains.\n' +
        '2. Use the web_search tool to find the current latest stable Node.js LTS major version, and state the version number.\n' +
        'Keep the final answer to two short lines.',
    });

    // Wait for the per-turn token-usage broadcast — fires once the turn settles.
    // This is the same message that feeds the "TOKEN USAGE … tools NB" panel.
    const usage = (await c.waitFor(
      (x) => x.type === 'primary_turn_token_usage' && (x as { workflowId?: string }).workflowId === wfid,
      TURN_TIMEOUT_MS,
      'primary_turn_token_usage',
    )) as AnyMessage & { toolResultBytes: number };

    // Pre-fix this was 0 ("tools 0B"): the client Read was orphaned, never
    // producing a tool_result. Post-fix the turn continues despite end_turn,
    // dispatches the Read, and its tool_result bytes land here.
    assert(
      typeof usage.toolResultBytes === 'number' && usage.toolResultBytes > 0,
      `client tool_result bytes > 0 (got ${usage.toolResultBytes}) — turn continued despite end_turn and dispatched the local Read`,
    );

    // Confirm we actually exercised the bug: web_search (the server tool that
    // triggers the 4.8 stop_reason mislabel) must have been invoked this turn. Tool-use events are
    // non-matching messages that accumulated in the buffer while we waited.
    const sawWebSearch = c
      .peekMessages()
      .some(
        (m) =>
          m.type === 'primary_tool_use' &&
          (m as { workflowId?: string }).workflowId === wfid &&
          typeof (m as { tool?: string }).tool === 'string' &&
          ((m as { tool: string }).tool === 'web_search' ||
            (m as { tool: string }).tool.includes('web_search')),
      );
    assert(sawWebSearch, 'web_search tool was invoked this turn (genuinely exercised the mixed client+server tool path)');

    const toolUses = c
      .peekMessages()
      .filter((m) => m.type === 'primary_tool_use' && (m as { workflowId?: string }).workflowId === wfid);
    const readCount = toolUses.filter((m) => (m as { tool?: string }).tool === 'Read').length;
    const webSearchCount = toolUses.filter((m) => (m as { tool?: string }).tool === 'web_search').length;
    assert(readCount === 1, `exactly one Read tool_use (got ${readCount}) — Native should not queue duplicate local tools before seeing results`);
    assert(webSearchCount <= 3, `web_search count is bounded (got ${webSearchCount}) — Native should not emit a repeated parallel search burst`);

    // The turn must actually produce a FINAL ANSWER, not just narrate and die.
    // The seeded codename is only knowable via the local Read, and the prompt
    // asks the model to state it — so its presence in the streamed assistant
    // text proves the turn ran through to a real answer.
    const answerText = c
      .peekMessages()
      .filter(
        (m) => m.type === 'primary_text' && (m as { workflowId?: string }).workflowId === wfid,
      )
      .map((m) => (m as { text?: string }).text ?? '')
      .join('');
    assert(
      answerText.includes(marker),
      `final answer includes the seeded codename (proves the turn completed instead of ending on interim narration); got ${answerText.length} chars of assistant text`,
    );

    assert(
      !answerText.includes('Search result was cleared'),
      'final answer does not expose cleared server-tool evidence (clear_tool_uses must not fire during the research turn)',
    );

    const notices = c
      .peekMessages()
      .filter((m) => m.type === 'system_notice' && (m as { workflowId?: string }).workflowId === wfid)
      .map((m) => (m as { content?: string }).content ?? '')
      .join('\n');
    assert(!/max_tokens/i.test(notices), 'turn did not truncate at max_tokens');
  });

  await step('teardown: remove_workflow + rm cwd', async () => {
    c.send({ type: 'remove_workflow', workflowId: wfid });
    await c.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  summary('web_search tool-loop smoke');
}

main().catch((err) => {
  console.error('web_search tool-loop smoke crashed:', err);
  process.exit(2);
});
