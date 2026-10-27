// docs/ARCHITECTURE.md - operator->agent output bridge smoke.
//
// NO WS, NO LLM. Pure-core assertions on the formatter + append logic:
//   1. buildQuotedTerminalBlock wraps a selection in a header + fenced block,
//      verbatim, and grows the fence past any backtick run inside the body
//      (so embedded ``` can't break out of the block).
//   2. appendToDraft APPENDS to existing draft text — it never clobbers what
//      the operator was already typing — and stands alone when the draft is
//      empty.
// THE load-bearing fence is upstream/UI (operator-action-only; the block is
// INSERTED into a draft, never auto-sent); this asserts the format + append.
//
// Run: npm run smoke:terminal-bridge  (no dev server needed)

import { step, assert, assertEq, summary } from './lib.js';
import { buildQuotedTerminalBlock, appendToDraft } from '../../client/src/components/Terminal/composerBridge.js';

async function main() {
  await step('buildQuotedTerminalBlock: header + fenced verbatim body', () => {
    const sel = 'Traceback (most recent call last):\n  File "x.py", line 3\nValueError: boom';
    const block = buildQuotedTerminalBlock(sel);
    assert(block.startsWith('Terminal output:\n```'), 'leads with the header + opening fence');
    assert(block.includes(sel), 'body is included verbatim');
    assert(block.endsWith('```'), 'closes with a fence');
  });

  await step('buildQuotedTerminalBlock: fence grows past embedded backtick runs', () => {
    // A selection containing a ``` run must not be allowed to close the block.
    const sel = 'see ```code``` here';
    const block = buildQuotedTerminalBlock(sel);
    assert(block.includes('````'), 'uses a >=4-backtick fence so the embedded ``` cannot break out');
    assert(block.includes(sel), 'embedded backticks preserved verbatim');
  });

  await step('appendToDraft: APPENDS to existing draft (never clobbers)', () => {
    const draft = 'can you look at this:';
    const out = appendToDraft(draft, 'npm test failed');
    assert(out.startsWith('can you look at this:'), 'operator-typed text is preserved at the front');
    assert(out.includes('Terminal output:'), 'quoted block is appended after it');
    assert(out.indexOf('can you look at this:') < out.indexOf('Terminal output:'), 'draft comes before the block');
  });

  await step('appendToDraft: empty draft yields just the block (no leading newlines)', () => {
    const out = appendToDraft('', 'some output');
    assertEq(out, buildQuotedTerminalBlock('some output'), 'empty draft → bare block');
  });

  summary('terminal-bridge');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
