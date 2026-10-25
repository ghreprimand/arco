// Smoke for the AI-collaborative document editing primitive —
// WORKBENCH_EXPANSION_PLAN.md §A7.
//
// A live edit turn spends REAL provider quota and needs a running server. For a
// fast, hermetic, CI-safe check we exercise the server-side primitive directly
// with a STUBBED WorkerManager: a fake spawn emits a canned replacement as
// `worker_text` and resolves. This asserts the load-bearing plumbing —
//   - the agent gets READ-ONLY tools and NO Write/Edit (text output only),
//   - the proposal targets ONLY the selection (the event carries just the
//     replacement, with the echoed selectionFrom/selectionTo — not the file),
//   - the error path broadcasts doc_edit_proposed with `error` and no crash,
//   - a leading/trailing code fence is defensively unwrapped,
// without a model round-trip.
//
//   npm run smoke:doc-edit
//
// Exits 0 on all-pass, 1 on any failure.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, assert, assertEq, summary, type AnyMessage } from './lib.js';
import { runDocEdit, type DocEditContext } from '../../server/src/primitives/runDocEdit.js';

interface CapturedSpawn {
  spec: AnyMessage;
  opts: AnyMessage;
}

// Stub of the bits of WorkerManager.spawn that runDocEdit touches. Records the
// spec + opts so we can assert the read-only / no-Write contract, then streams
// the canned replacement text. `errored` drives the error-path variant.
function makeStubManager(replacement: string, captured: CapturedSpawn[], errored = false) {
  return {
    spawn(spec: AnyMessage, onEvent: (m: AnyMessage) => void, opts: AnyMessage) {
      captured.push({ spec, opts });
      if (errored) {
        return Promise.resolve({ id: spec.id, text: '', costUsd: 0, durationMs: 7, error: 'worker exploded' });
      }
      onEvent({ type: 'worker_text', workerId: spec.id as string, text: replacement });
      return Promise.resolve({ id: spec.id, text: '', costUsd: 0, durationMs: 13 });
    },
    kill() { return false; },
  };
}

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), 'archon-smoke-docedit-'));
  const workflowId = 'smoke-docedit-wf';
  console.log(`doc-edit smoke — cwd ${cwd}`);
  console.log('');

  // A small markdown document. The operator selects the second paragraph (the
  // [from,to) offsets below) and asks the agent to tighten it. The WHOLE file is
  // never sent back — only the replacement for [from,to).
  const FILE = [
    '# Title',
    '',
    'This paragraph is fine and should be left completely alone.',
    '',
    'this paragraph is kind of rambly and could really be tightened up a lot honestly.',
    '',
    'And a closing paragraph that also stays put.',
  ].join('\n');
  // Offsets of the rambly fifth line within FILE.
  const SELECTION = 'this paragraph is kind of rambly and could really be tightened up a lot honestly.';
  const selectionFrom = FILE.indexOf(SELECTION);
  const selectionTo = selectionFrom + SELECTION.length;
  const REPLACEMENT = 'This paragraph is tighter now.';

  await step('happy path: proposal carries ONLY the selection replacement', async () => {
    const captured: CapturedSpawn[] = [];
    const broadcasts: AnyMessage[] = [];
    const ctx: DocEditContext = {
      workflowId,
      cwd,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      manager: makeStubManager(REPLACEMENT, captured) as any,
      broadcast: (m) => { broadcasts.push(m as AnyMessage); },
    };
    const handle = runDocEdit(ctx, {
      editor: { provider: 'claude', model: 'opus' as never, effort: 'high' as never },
      filePath: join(cwd, 'doc.md'),
      selectionText: SELECTION,
      selectionFrom,
      selectionTo,
      contextBefore: FILE.slice(0, selectionFrom),
      contextAfter: FILE.slice(selectionTo),
      instruction: 'Tighten this paragraph.',
      wholeDoc: false,
    });
    const result = await handle.settled;
    assert(!result.error, `settled without error (got: ${result.error})`);
    assertEq(result.replacement, REPLACEMENT, 'returns the canned replacement');

    const proposed = broadcasts.find((m) => m.type === 'doc_edit_proposed');
    assert(proposed, 'doc_edit_proposed broadcast present');
    assert(!proposed!.error, 'no error on happy-path proposal');
    assertEq(proposed!.replacement, REPLACEMENT, 'event carries the replacement text');
    // The proposal targets ONLY the selection: the replacement is the canned
    // selection text, NOT the whole file, and the echoed offsets bound exactly
    // the selected region the client will splice into.
    assert(!proposed!.replacement.includes('# Title'), 'replacement is NOT the whole file');
    assert(!proposed!.replacement.includes('should be left completely alone'), 'replacement excludes untouched paragraphs');
    assertEq(proposed!.selectionFrom, selectionFrom, 'echoes selectionFrom (splice start)');
    assertEq(proposed!.selectionTo, selectionTo, 'echoes selectionTo (splice end)');
    // Sanity: applying the splice client-side touches ONLY [from,to).
    const after = FILE.slice(0, selectionFrom) + proposed!.replacement + FILE.slice(selectionTo);
    assert(after.startsWith('# Title'), 'spliced buffer keeps the untouched head');
    assert(after.includes('And a closing paragraph that also stays put.'), 'spliced buffer keeps the untouched tail');
    assert(after.includes(REPLACEMENT), 'spliced buffer contains the replacement');

    const started = broadcasts.find((m) => m.type === 'doc_edit_started');
    assert(started, 'doc_edit_started broadcast present');
  });

  await step('agent is READ-ONLY with NO Write/Edit tool (text output only)', async () => {
    const captured: CapturedSpawn[] = [];
    const broadcasts: AnyMessage[] = [];
    const ctx: DocEditContext = {
      workflowId,
      cwd,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      manager: makeStubManager(REPLACEMENT, captured) as any,
      broadcast: (m) => { broadcasts.push(m as AnyMessage); },
    };
    await runDocEdit(ctx, {
      editor: { provider: 'claude', model: 'opus' as never, effort: 'high' as never },
      filePath: join(cwd, 'doc.md'),
      selectionText: SELECTION,
      selectionFrom,
      selectionTo,
      contextBefore: '',
      contextAfter: '',
      instruction: 'Tighten.',
      wholeDoc: false,
    }).settled;
    assertEq(captured.length, 1, 'exactly one spawn');
    assertEq(captured[0].opts.sandbox, 'read-only', 'read-only sandbox');
    assertEq(captured[0].opts.outputStyle, 'normal', 'outputStyle forced to normal');
    const tools = captured[0].spec.tools as string[];
    assert(Array.isArray(tools), 'claude tool allowlist present');
    assert(tools.includes('Read') && tools.includes('Grep') && tools.includes('Glob'), 'read-only local tools');
    assert(!tools.includes('Write') && !tools.includes('Edit') && !tools.includes('Bash'), 'NO Write/Edit/Bash — text output only');
  });

  await step('code-fence wrapping is defensively unwrapped', async () => {
    const captured: CapturedSpawn[] = [];
    const broadcasts: AnyMessage[] = [];
    const fenced = '```markdown\nThis paragraph is tighter now.\n```';
    const ctx: DocEditContext = {
      workflowId,
      cwd,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      manager: makeStubManager(fenced, captured) as any,
      broadcast: (m) => { broadcasts.push(m as AnyMessage); },
    };
    const result = await runDocEdit(ctx, {
      editor: { provider: 'claude', model: 'opus' as never, effort: 'high' as never },
      filePath: join(cwd, 'doc.md'),
      selectionText: SELECTION,
      selectionFrom,
      selectionTo,
      contextBefore: '',
      contextAfter: '',
      instruction: 'Tighten.',
      wholeDoc: false,
    }).settled;
    assertEq(result.replacement, 'This paragraph is tighter now.', 'outer fence stripped');
  });

  await step('error path: doc_edit_proposed carries error, no crash', async () => {
    const captured: CapturedSpawn[] = [];
    const broadcasts: AnyMessage[] = [];
    const ctx: DocEditContext = {
      workflowId,
      cwd,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      manager: makeStubManager('', captured, true) as any,
      broadcast: (m) => { broadcasts.push(m as AnyMessage); },
    };
    const result = await runDocEdit(ctx, {
      editor: { provider: 'claude', model: 'opus' as never, effort: 'high' as never },
      filePath: join(cwd, 'doc.md'),
      selectionText: SELECTION,
      selectionFrom,
      selectionTo,
      contextBefore: '',
      contextAfter: '',
      instruction: 'Tighten.',
      wholeDoc: false,
    }).settled;
    assert(result.error, 'settled with error');
    const proposed = broadcasts.find((m) => m.type === 'doc_edit_proposed');
    assert(proposed, 'doc_edit_proposed present on error path');
    assert(proposed!.error, 'proposal carries error');
    assertEq(proposed!.replacement, '', 'no replacement on error');
    assertEq(proposed!.selectionFrom, selectionFrom, 'still echoes selectionFrom on error');
  });

  rmSync(cwd, { recursive: true, force: true });
  summary('doc-edit');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
