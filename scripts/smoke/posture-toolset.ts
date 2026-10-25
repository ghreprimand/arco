// §4.1 — posture-based toolsets smoke.
//
// Headless / module-level (no live server, no API spend). buildToolDefs() runs
// inside a real Native turn, so we exercise the deterministic core it calls —
// filterToolDefsByPosture — against a representative tool union (core + server +
// dynamic opt-ins) and assert all three merged deltas: cross-ref scrub,
// non-empty fallback, and that dynamic opt-ins always survive.
//
// Run: npm run smoke:posture-toolset   (no server needed)

import { step, assert, assertEq, summary } from './lib.js';

async function main(): Promise<void> {
  const { filterToolDefsByPosture, keepTool, scrubCrossRefs } = await import(
    '../../server/src/providers/claude-native/toolPosture.js'
  );

  // A representative union: core, server tools, and operator-opted-in dynamic
  // tools (MCP registry / cluster peer / sandbox). The sandbox def carries the
  // live cross-ref ("Read / Bash ... still available") that delta 1 must scrub.
  const UNION = [
    { name: 'Read', description: 'Read a file.' },
    { name: 'Write', description: 'Write a file.' },
    { name: 'Edit', description: 'Edit a file.' },
    { name: 'Bash', description: 'Run a shell command.' },
    { name: 'Grep', description: 'Search.' },
    { name: 'Glob', description: 'List files.' },
    { name: 'Task', description: 'Spawn a child agent.' },
    { name: 'TodoWrite', description: 'Manage a todo list.' },
    { name: 'web_search', description: 'Search the web.' },
    { name: 'web_fetch', description: 'Fetch a URL.' },
    { name: 'code_execution', description: 'Run code in a sandbox.' },
    { name: 'mcp__reg-abc__query', description: 'An operator-added MCP tool.' },
    { name: 'peer_send', description: 'Send a message to a cluster peer.' },
    { name: 'ctx_execute', description: 'Run a script and capture chunks. The full Read / Bash tools are still available — use them for small reads.' },
  ];
  const names = (r: { tools: Array<{ name: string }> }) => r.tools.map((t) => t.name);

  await step('§4.1.0 full is a no-op — every tool kept', () => {
    const r = filterToolDefsByPosture(UNION, 'full');
    assertEq(r.tools.length, UNION.length, 'nothing dropped');
    assertEq(r.removed.length, 0, 'no removals');
    assertEq(r.fellBackToFull, false, 'full is not a fallback');
  });

  await step('§4.1.1 coding drops web research, keeps the local toolset', () => {
    const r = filterToolDefsByPosture(UNION, 'coding');
    const kept = names(r);
    assert(kept.includes('Write') && kept.includes('Edit') && kept.includes('Bash'), 'core coding tools kept');
    assert(!kept.includes('web_search') && !kept.includes('web_fetch') && !kept.includes('code_execution'), 'web/server tools dropped');
  });

  await step('§4.1.2 review is read/inspect/run only — no mutation, no fan-out, no web', () => {
    const r = filterToolDefsByPosture(UNION, 'review');
    const kept = names(r);
    assert(kept.includes('Read') && kept.includes('Grep') && kept.includes('Bash'), 'read+inspect+run kept');
    assert(!kept.includes('Write') && !kept.includes('Edit') && !kept.includes('Task'), 'mutation + fan-out dropped');
    assert(!kept.includes('web_search'), 'web dropped');
  });

  await step('§4.1.3 chat is read-only lookup — no shell, no mutation', () => {
    const r = filterToolDefsByPosture(UNION, 'chat');
    const kept = names(r);
    assert(kept.includes('Read') && kept.includes('Grep') && kept.includes('Glob'), 'read-only lookup kept');
    assert(!kept.includes('Bash') && !kept.includes('Write') && !kept.includes('Edit'), 'shell + mutation dropped');
  });

  await step('§4.1.4 dynamic opt-ins (mcp__/peer_/ctx_) survive every posture', () => {
    for (const p of ['coding', 'review', 'chat'] as const) {
      const kept = names(filterToolDefsByPosture(UNION, p));
      assert(kept.includes('mcp__reg-abc__query'), `mcp tool survives ${p}`);
      assert(kept.includes('peer_send'), `peer tool survives ${p}`);
      assert(kept.includes('ctx_execute'), `sandbox tool survives ${p}`);
    }
  });

  await step('§4.1.5 delta 1 — dangling "Read/Bash still available" cross-ref scrubbed', () => {
    // chat removes Bash → the sandbox ctx_execute clause naming Bash must go.
    const r = filterToolDefsByPosture(UNION, 'chat');
    const sandbox = r.tools.find((t) => t.name === 'ctx_execute')!;
    assert(!/still available/i.test(sandbox.description ?? ''), 'availability cross-ref removed');
    assert(/capture chunks/.test(sandbox.description ?? ''), 'the rest of the description survives');
  });

  await step('§4.1.5b scrubCrossRefs leaves descriptions alone when nothing removed', () => {
    const desc = 'The full Read / Bash tools are still available — use them.';
    assertEq(scrubCrossRefs(desc, new Set()), desc, 'no-op with empty removed set');
  });

  await step('§4.1.6 delta 2 — a bundle that empties the set falls back to full', () => {
    // A union of ONLY tools the chat bundle drops → empty → fallback.
    const onlyDropped = [
      { name: 'Write', description: 'w' },
      { name: 'Edit', description: 'e' },
      { name: 'Bash', description: 'b' },
    ];
    const r = filterToolDefsByPosture(onlyDropped, 'chat');
    assertEq(r.fellBackToFull, true, 'fell back to full');
    assertEq(r.tools.length, onlyDropped.length, 'kept everything rather than brick the turn');
  });

  await step('§4.1.7 determinism — same input yields identical output', () => {
    const a = names(filterToolDefsByPosture(UNION, 'review'));
    const b = names(filterToolDefsByPosture(UNION, 'review'));
    assertEq(JSON.stringify(a), JSON.stringify(b), 'deterministic');
  });

  await step('§4.1.8 keepTool predicate: known dropped vs dynamic pass-through', () => {
    assertEq(keepTool('Write', 'chat'), false, 'known dropped tool excluded');
    assertEq(keepTool('Read', 'chat'), true, 'known kept tool included');
    assertEq(keepTool('mcp__x__y', 'chat'), true, 'unknown dynamic tool passes through');
    assertEq(keepTool('Write', 'full'), true, 'full keeps everything');
  });

  summary('posture-toolset');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
