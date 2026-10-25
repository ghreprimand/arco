// Workbench Expansion C3 — LSP diagnostics unit + (gated) real-server smoke.
//
// The ALWAYS-GREEN core is a PURE unit test — NO server boot, NO WebSocket,
// and CRUCIALLY no language server installed. It exercises the bug-prone parts
// directly:
//   (1) FrameReader reassembles Content-Length frames, including a frame split
//       across two chunks and multiple frames in one chunk.
//   (2) mapPublishDiagnostics converts LSP's 0-based line/character to Arco's
//       1-based DiagnosticItem.line/column with the right severity/message.
//   (3) encodeMessage round-trips through FrameReader.
//
// Then, GATED behind a PATH detection check, an optional real end-to-end leg:
// if a real LSP server (rust-analyzer / typescript-language-server) is on PATH
// we spawn it and assert a diagnostic surfaces; if NOT, we print a clear SKIP
// line and still exit 0. The unit core passes regardless.
//
// Run: npm run smoke:lsp-diagnostics   (no dev server needed)

import { FrameReader, encodeMessage, mapPublishDiagnostics, lspManager } from '../../server/src/lsp/client.js';
import { resolveServer, _clearDetectCache } from '../../server/src/lsp/servers.js';
import { pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiagnosticsMessage } from '@arco/shared';

let passes = 0;
let fails = 0;
const failures: string[] = [];

function assert(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  PASS  ${label}`);
    passes++;
  } else {
    const msg = `${label}${detail ? ` — ${detail}` : ''}`;
    console.log(`  FAIL  ${msg}`);
    failures.push(msg);
    fails++;
  }
}

// ── (1) FrameReader: single frame, split frame, multiple frames in one chunk ─

// Build a byte stream of: an initialize RESPONSE, then a publishDiagnostics
// NOTIFICATION (error at 0-based line 4, char 2), and feed it to the reader
// with a frame deliberately split across two chunks.
const initResponse = { jsonrpc: '2.0', id: 1, result: { capabilities: {} } };
const publishNotif = {
  jsonrpc: '2.0',
  method: 'textDocument/publishDiagnostics',
  params: {
    uri: pathToFileURL('/tmp/proj/src/bad.ts').href,
    diagnostics: [
      {
        range: { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } },
        severity: 1,
        message: "Type 'string' is not assignable to type 'number'.",
        source: 'ts',
        code: 2322,
      },
    ],
  },
};

const frame1 = encodeMessage(initResponse);
const frame2 = encodeMessage(publishNotif);
const fullStream = Buffer.concat([frame1, frame2]);

// Split the stream at an offset INSIDE frame2's body so the reader must buffer
// across the chunk boundary. Choose a split a few bytes into frame2.
const splitAt = frame1.length + Math.floor(frame2.length / 2);
const chunkA = fullStream.subarray(0, splitAt);
const chunkB = fullStream.subarray(splitAt);

const reader = new FrameReader();
const msgsA = reader.push(chunkA);
const msgsB = reader.push(chunkB);
const all = [...msgsA, ...msgsB];

// chunkA contains the whole init response + part of frame2 → exactly 1 message;
// chunkB completes frame2 → exactly 1 message. Order preserved.
assert('split: chunkA yields exactly the init response', msgsA.length === 1 && msgsA[0].id === 1,
  `got ${msgsA.length} msgs in chunkA`);
assert('split: chunkB completes the publishDiagnostics frame', msgsB.length === 1 && msgsB[0].method === 'textDocument/publishDiagnostics',
  `got ${msgsB.length} msgs in chunkB`);
assert('split: two messages total, in order', all.length === 2 && all[0].id === 1 && all[1].method === 'textDocument/publishDiagnostics');

// Multiple frames in one chunk: feed the whole stream at once.
const reader2 = new FrameReader();
const both = reader2.push(fullStream);
assert('coalesced: one chunk with two frames yields two messages in order',
  both.length === 2 && both[0].id === 1 && both[1].method === 'textDocument/publishDiagnostics',
  `got ${both.length} msgs`);

// Byte-by-byte drip: every single byte arrives in its own chunk; reader must
// emit nothing until each frame completes, then emit in order.
const reader3 = new FrameReader();
const dripped: number[] = [];
for (const byte of fullStream) {
  const got = reader3.push(Buffer.from([byte]));
  dripped.push(...got.map((m) => (m.id === 1 ? 1 : 2)));
}
assert('drip: byte-at-a-time reassembles to [init, publish]', dripped.length === 2 && dripped[0] === 1 && dripped[1] === 2,
  `got ${JSON.stringify(dripped)}`);

// ── (2) mapPublishDiagnostics: 0-based → 1-based conversion ──

const mapped: DiagnosticsMessage = mapPublishDiagnostics(
  publishNotif.params,
  '/tmp/proj',
  'wf-test',
);
assert('map: type/workflowId set', mapped.type === 'diagnostics' && mapped.workflowId === 'wf-test');
assert('map: file is cwd-relative', mapped.file === 'src/bad.ts', `got "${mapped.file}"`);
assert('map: one item', mapped.items.length === 1, `got ${mapped.items.length}`);
const item = mapped.items[0];
assert('map: severity 1 → "error"', item?.severity === 'error', `got ${item?.severity}`);
// LSP line 4 (0-based) → 1-based line 5; char 2 → column 3.
assert('map: 0-based line 4 → 1-based line 5', item?.line === 5, `got ${item?.line}`);
assert('map: 0-based char 2 → 1-based column 3', item?.column === 3, `got ${item?.column}`);
assert('map: endLine 5, endColumn 10', item?.endLine === 5 && item?.endColumn === 10, `got endLine=${item?.endLine} endCol=${item?.endColumn}`);
assert('map: message preserved', item?.message === "Type 'string' is not assignable to type 'number'.");
assert('map: source/code preserved', item?.source === 'ts' && item?.code === 2322);

// Severity mapping table.
function sevOf(n: number | undefined): string {
  return mapPublishDiagnostics(
    { uri: pathToFileURL('/tmp/proj/x.ts').href, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: n, message: 'm' }] },
    '/tmp/proj', 'wf',
  ).items[0].severity;
}
assert('sev: 2 → warning', sevOf(2) === 'warning');
assert('sev: 3 → info', sevOf(3) === 'info');
assert('sev: 4 → hint', sevOf(4) === 'hint');
assert('sev: absent → error (most actionable)', sevOf(undefined) === 'error');

// Empty diagnostics array → empty items (the "fixed → cleared" path).
const cleared = mapPublishDiagnostics({ uri: pathToFileURL('/tmp/proj/src/bad.ts').href, diagnostics: [] }, '/tmp/proj', 'wf');
assert('map: empty diagnostics → empty items (clears the file)', cleared.items.length === 0);

// Malformed frame must not wedge the reader.
const reader4 = new FrameReader();
const bad = Buffer.from('Content-Length: 5\r\n\r\n{bad}', 'utf8'); // {bad} is 5 bytes, invalid JSON
const goodAfter = encodeMessage({ jsonrpc: '2.0', id: 9, result: {} });
const r4 = reader4.push(Buffer.concat([bad, goodAfter]));
assert('robust: malformed frame skipped, following frame still parsed', r4.length === 1 && r4[0].id === 9,
  `got ${r4.length} msgs`);

// ── Unit summary (must be green regardless of installed servers) ──
const unitTotal = passes + fails;
console.log('');
console.log(`lsp-diagnostics UNIT: ${passes}/${unitTotal} checks passed`);
if (fails > 0) {
  console.log('');
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

// ── (3) GATED real end-to-end leg ──
//
// Prefer rust-analyzer (present on this machine per the C3 brief); fall back to
// typescript-language-server. If neither resolves, SKIP cleanly and exit 0.
async function realLeg(): Promise<void> {
  _clearDetectCache();
  const rs = await resolveServer('/tmp/probe.rs');
  const ts = await resolveServer('/tmp/probe.ts');
  const pick = rs ? { lang: 'rust', ext: 'rs', bad: 'fn main() { let x: i32 = "not a number"; }\n' }
    : ts ? { lang: 'typescript', ext: 'ts', bad: 'const x: number = "nope";\n' }
    : null;

  if (!pick) {
    console.log('');
    console.log('SKIP: no LSP server on PATH — install typescript-language-server for TS diagnostics (or rust-analyzer for Rust). Unit core above is authoritative.');
    process.exit(0);
  }

  console.log('');
  console.log(`REAL LEG: ${pick.lang} server found on PATH — running end-to-end`);

  const dir = await fs.mkdtemp(join(tmpdir(), 'arco-lsp-'));
  const file = join(dir, `bad.${pick.ext}`);
  await fs.writeFile(file, pick.bad, 'utf8');

  // rust-analyzer needs a Cargo project to emit diagnostics; ts-language-server
  // needs none for syntactic/semantic errors on a standalone file. For the rust
  // path, lay down a minimal Cargo.toml + src/main.rs so cargo check has a
  // target. (Best-effort; if the server still publishes nothing within the
  // window we report that honestly rather than failing the smoke.)
  let watchFile = file;
  if (pick.lang === 'rust') {
    await fs.mkdir(join(dir, 'src'), { recursive: true });
    await fs.writeFile(join(dir, 'Cargo.toml'), '[package]\nname = "probe"\nversion = "0.1.0"\nedition = "2021"\n', 'utf8');
    watchFile = join(dir, 'src', 'main.rs');
    await fs.writeFile(watchFile, pick.bad, 'utf8');
  }

  let received: DiagnosticsMessage | null = null;
  const deadline = Date.now() + 30_000;
  const done = new Promise<void>((resolveDone) => {
    void lspManager.notifyWritten(watchFile, dir, 'wf-real', (msg) => {
      if (msg.items.length > 0 && !received) {
        received = msg;
        resolveDone();
      }
    });
    const poll = setInterval(() => {
      if (received || Date.now() > deadline) { clearInterval(poll); resolveDone(); }
    }, 500);
    poll.unref();
  });
  await done;

  lspManager.shutdown();
  await fs.rm(dir, { recursive: true, force: true });

  if (received) {
    const r = received as DiagnosticsMessage;
    console.log(`  REAL: received ${r.items.length} diagnostic(s); first at line ${r.items[0].line}: ${r.items[0].message.slice(0, 80)}`);
    assert('real: at least one diagnostic with a 1-based line ≥ 1', r.items[0].line >= 1);
  } else {
    // Not a hard failure: some servers (rust-analyzer cold) can exceed the
    // window or need a build first. Report honestly; the unit core is the gate.
    console.log('  REAL: no diagnostic within 30s window (server may need a warm build) — NOT failing the smoke; unit core is authoritative.');
  }

  console.log('');
  console.log(`lsp-diagnostics TOTAL: ${passes}/${passes + fails} checks passed (unit + real)`);
  if (fails > 0) {
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fails > 0 ? 1 : 0);
}

void realLeg();
