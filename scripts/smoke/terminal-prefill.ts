// WORKBENCH_EXPANSION_PLAN.md §K3 — "Run in terminal" prefill smoke.
//
// NO WS, NO LLM. Two assertions:
//   1. Detector unit test — detectCommand() classifies fenced blocks: shell
//      langs (bash/sh/shell/console/zsh) qualify with the right extracted
//      command; non-shell (js/python/ts/no-info-string/prose) do not.
//   2. No-auto-exec — drive PtyManager directly through the channel's prefill
//      transform (stripLineTerminator → ptyManager.write) and assert the bytes
//      the PTY received carry NO newline AND the command did NOT execute
//      (scrollback never shows its output). THE load-bearing fence.
//
// Run: npm run smoke:terminal-prefill  (no dev server needed)

import { step, assert, assertEq, summary } from './lib.js';
import { detectCommand } from '../../client/src/components/Terminal/detectCommand.js';
import { PtyManager } from '../../server/src/terminal/ptyManager.js';
import { stripLineTerminator, wrapPrefillForPty } from '../../server/src/terminal/terminalChannel.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function waitUntil(pred: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

async function main() {
  await step('detector: shell blocks qualify with extracted command', () => {
    // ReactMarkdown hands `language-xxx`; the detector also accepts bare info-strings.
    const bash = detectCommand('language-bash', 'npm test\n');
    assert(bash.isShell, 'bash block should qualify');
    assertEq(bash.command, 'npm test', 'bash command extracted, trailing newline dropped');

    const sh = detectCommand('language-sh', 'ls -la\n');
    assert(sh.isShell, 'sh block should qualify');
    assertEq(sh.command, 'ls -la', 'sh command extracted');

    const shell = detectCommand('shell', 'echo hi');
    assert(shell.isShell, 'shell (bare info-string) should qualify');
    assertEq(shell.command, 'echo hi', 'shell command extracted');

    const zsh = detectCommand('language-zsh', 'pwd\n');
    assert(zsh.isShell, 'zsh block should qualify');
    assertEq(zsh.command, 'pwd', 'zsh command extracted');

    // console single-line: strip a leading `$ ` prompt.
    const consoleOne = detectCommand('language-console', '$ npm run build\n');
    assert(consoleOne.isShell, 'console block should qualify');
    assertEq(consoleOne.command, 'npm run build', 'console single-line strips the `$ ` prompt');

    // console multi-line: keep verbatim (commands + output — operator edits).
    const consoleMulti = detectCommand('console', '$ ls\nfile.txt\n');
    assert(consoleMulti.isShell, 'multi-line console qualifies');
    assertEq(consoleMulti.command, '$ ls\nfile.txt', 'multi-line console kept verbatim');

    // Multi-line bash: whole block pre-filled.
    const multi = detectCommand('language-bash', 'cd src\nnpm test\n');
    assertEq(multi.command, 'cd src\nnpm test', 'multi-line bash kept whole');
  });

  await step('detector: non-shell blocks do NOT qualify', () => {
    for (const [info, body] of [
      ['language-js', 'const x = 1;'],
      ['language-python', 'print("hi")'],
      ['language-ts', 'let n: number = 2;'],
      ['language-json', '{"a":1}'],
      [undefined, 'just some prose with no info-string'],
      ['', 'plain text'],
      ['language-bash', '\n'], // empty bash block — not worth a chip
      ['language-bash', '   '], // whitespace-only — not worth a chip
    ] as [string | undefined, string][]) {
      const r = detectCommand(info, body);
      assert(!r.isShell, `block (${info ?? 'no-info'}) should NOT qualify, got command=${JSON.stringify(r.command)}`);
      assertEq(r.command, '', `non-qualifying block extracts no command (${info ?? 'no-info'})`);
    }
  });

  await step('prefill transform: strips ALL trailing terminators, no newline survives', () => {
    // Even if a client sends a trailing newline, the fence strips it.
    assertEq(stripLineTerminator('npm test\n'), 'npm test', 'trailing \\n stripped');
    assertEq(stripLineTerminator('npm test\r\n'), 'npm test', 'trailing \\r\\n stripped');
    assertEq(stripLineTerminator('npm test'), 'npm test', 'no terminator left untouched');
    assertEq(stripLineTerminator('a\nb\n'), 'a\nb', 'only the TRAILING terminator stripped (interior \\n kept)');
    const out = stripLineTerminator('npm test\n');
    assert(!/[\r\n]$/.test(out), 'prefill output must not end in a newline');
  });

  await step('prefill transform: multi-line block wrapped in bracketed paste, no trailing terminator', () => {
    // THE production transform for the multi-line fence (the K3 fence gap fix).
    // A multi-line command carries INTERIOR newlines; wrapPrefillForPty must
    // wrap the (terminator-stripped) body in \x1b[200~…\x1b[201~ so a paste-aware
    // shell holds it on the edit line instead of executing the first line.
    const multi = wrapPrefillForPty('npm install\nnpm test\n');
    assert(multi.startsWith('\x1b[200~'), 'wrapped payload starts with bracketed-paste START');
    assert(multi.endsWith('\x1b[201~'), 'wrapped payload ends with bracketed-paste END');
    const body = multi.slice('\x1b[200~'.length, -'\x1b[201~'.length);
    assertEq(body, 'npm install\nnpm test', 'body keeps interior \\n, trailing terminator stripped');
    assert(!/[\r\n]$/.test(body), 'wrapped body must not end in a newline');
  });

  // No-auto-exec end-to-end: spawn a real PTY, run the prefill path, and assert
  // the command sat on the prompt WITHOUT executing.
  const root = mkdtempSync(join(tmpdir(), 'arco-prefill-'));
  const mgr = new PtyManager();

  await step('no-auto-exec: single-line prefilled command does NOT run', async () => {
    const session = mgr.spawn('wf-prefill', root);
    let buf = '';
    mgr.attach(session.id, (d) => { buf += d; });

    // Settle the prompt first.
    await new Promise((r) => setTimeout(r, 300));
    const before = buf;

    // The channel's PRODUCTION prefill path: wrapPrefillForPty → ptyManager.write.
    // A sentinel token that would only ever appear in OUTPUT if the shell ran it.
    const SENTINEL = 'ARCO_PREFILL_SENTINEL_42';
    const command = `echo ${SENTINEL}`;
    const written = wrapPrefillForPty(`${command}\n`); // simulate a client that appended \n
    assert(written.startsWith('\x1b[200~') && written.endsWith('\x1b[201~'), 'production transform wraps in bracketed paste');
    mgr.write(session.id, written);

    // Give the shell a beat. If prefill (wrongly) executed, the echo output
    // (the sentinel ON ITS OWN LINE) would show up. The typed command itself
    // echoes back as terminal input — so we must distinguish the typed echo
    // from command OUTPUT. Executed output = the sentinel appearing AGAIN
    // (a second occurrence beyond the single typed echo).
    await new Promise((r) => setTimeout(r, 400));
    const added = buf.slice(before.length);
    const occurrences = added.split(SENTINEL).length - 1;
    assert(
      occurrences <= 1,
      `prefill must NOT execute: sentinel should appear at most once (typed echo), saw ${occurrences} occurrences — command ran`,
    );

    // Now press Enter ourselves (the operator action) and confirm it DOES run —
    // proving the prefill was a real command sitting on the prompt.
    mgr.write(session.id, '\n');
    const ran = await waitUntil(() => (buf.slice(before.length).split(SENTINEL).length - 1) >= 2);
    assert(ran, 'after the operator presses Enter, the prefilled command runs (sentinel echoed as output)');

    mgr.kill(session.id);
  });

  await step('no-auto-exec: MULTI-LINE prefill — first line does NOT execute (K3 fence gap fix)', async () => {
    // The bug: a multi-line block (interior \n) written bare lets the PTY line
    // discipline execute the first line immediately. bracketed paste prevents it.
    const session = mgr.spawn('wf-prefill-multi', root);
    let buf = '';
    mgr.attach(session.id, (d) => { buf += d; });

    await new Promise((r) => setTimeout(r, 300));
    const before = buf;

    // Two sentinels: the FIRST line's sentinel must never appear as OUTPUT until
    // Enter. If the interior \n auto-submitted line 1, FIRST would echo twice.
    const FIRST = 'ARCO_MULTI_FIRST_77';
    const SECOND = 'ARCO_MULTI_SECOND_88';
    const block = `echo ${FIRST}\necho ${SECOND}`; // interior newline between the two
    const written = wrapPrefillForPty(block);
    assert(written.startsWith('\x1b[200~') && written.endsWith('\x1b[201~'), 'multi-line payload is bracketed-paste wrapped');
    assert(written.includes(`echo ${FIRST}\necho ${SECOND}`), 'interior newline preserved inside the markers');
    mgr.write(session.id, written);

    // Give the shell time to (wrongly) run line 1 if the fence were broken.
    await new Promise((r) => setTimeout(r, 500));
    const added = buf.slice(before.length);
    const firstRuns = added.split(FIRST).length - 1;
    assert(
      firstRuns <= 1,
      `multi-line prefill must NOT execute line 1: FIRST sentinel should appear at most once (paste echo), saw ${firstRuns} — line 1 auto-ran on the interior newline`,
    );

    // Operator presses Enter → the whole pasted block submits and both run.
    mgr.write(session.id, '\n');
    const bothRan = await waitUntil(() =>
      (buf.slice(before.length).split(FIRST).length - 1) >= 2 &&
      (buf.slice(before.length).split(SECOND).length - 1) >= 2,
    );
    assert(bothRan, 'after the operator presses Enter, the multi-line block runs (both sentinels echoed as output)');

    mgr.kill(session.id);
  });

  rmSync(root, { recursive: true, force: true });
  summary('terminal-prefill');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
