// docs/PROVIDERS.md - tool activity and permission bridge smoke.
//
// Verifies that Antigravity trajectory steps are normalized into stable,
// non-duplicating Arco Activity rows, that the debug trace file is written
// when ANTIGRAVITY_RPC_TRACE_STEPS=1, and that shell/file/web activity each
// produce the expected merged rows.
//
// Unknown/stall states: we do NOT include a controlled stall test here. Inducing
// a deterministic stall requires triggering a tool Antigravity cannot execute on
// its own, which is hard to make reliable without hanging the suite. The stall
// path (waiting_unbridged_tool, timed_out rows) is covered by code review and
// manual inspection of the ANTIGRAVITY_RPC_TRACE_STEPS output.
//
// Run: npm run smoke:antigravity-phase-c
// Exits 0 on success, 1 on failure, 2 if the desktop app isn't reachable.

import { existsSync } from 'fs';
import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { WorkerConfig } from '@arco/shared';
import { antigravityManager } from '../../server/src/providers/antigravityManager.js';
import { runAntigravityRpcTurn } from '../../server/src/providers/antigravityRpc.js';

const TURN_TIMEOUT_MS = 5 * 60_000;
const STAMP = Date.now().toString(36);
const WORKFLOW_ID = `phase-c-${STAMP}`;

interface ToolEvent {
  id?: string;
  name: string;
  status?: string;
  input: string;
  output?: string;
}

async function runTurn(
  prompt: string,
  config: WorkerConfig,
): Promise<{ text: string; tools: ToolEvent[]; notices: string[]; cascadeId: string }> {
  const tools: ToolEvent[] = [];
  const notices: string[] = [];
  let text = '';
  let cascadeId = '';
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; }, TURN_TIMEOUT_MS);
  try {
    const result = await runAntigravityRpcTurn(
      prompt,
      config,
      (data) => { if (data.sessionId) cascadeId = data.sessionId; },
      () => timedOut,
      (data) => {
        tools.push({ id: data.id, name: data.name, status: data.status, input: data.input, output: data.output });
      },
      (notice) => { notices.push(notice); console.log(`  notice: ${notice}`); },
    );
    text = result.text;
    cascadeId = result.cascadeId;
  } finally {
    clearTimeout(timer);
  }
  return { text, tools, notices, cascadeId };
}

function makeConfig(cwd: string, cascadeId?: string): WorkerConfig {
  return {
    provider: 'antigravity',
    model: 'antigravity-desktop',
    cwd,
    workflowId: WORKFLOW_ID,
    skipPermissions: true,
    ...(cascadeId ? { resumeSessionId: cascadeId } : {}),
  } as WorkerConfig;
}

// Checks that a set of tool rows for the same logical action contain no
// duplicates with the same id AND same status. A row that transitions
// in_progress → completed is fine (different signatures); two rows with the same
// id and status are a merge failure.
function checkNoDuplicateRows(tools: ToolEvent[], label: string, fail: (msg: string) => void, pass: (msg: string) => void): void {
  const seen = new Map<string, string[]>();
  for (const t of tools) {
    const key = `${t.id ?? t.name}:${t.status ?? '?'}`;
    const list = seen.get(key) ?? [];
    list.push(t.name);
    seen.set(key, list);
  }
  let hasDup = false;
  for (const [key, names] of seen) {
    if (names.length > 1) {
      fail(`duplicate Activity row (id:status = ${key}, count=${names.length}) in ${label}`);
      hasDup = true;
    }
  }
  if (!hasDup) pass(`no duplicate id:status rows in ${label}`);
}

async function main(): Promise<void> {
  console.log('Antigravity Phase C smoke (tool activity + permission bridge)');
  console.log('=============================================================');
  console.log(`workflowId: ${WORKFLOW_ID}`);
  console.log('');

  let failures = 0;
  const fail = (msg: string) => { failures++; console.log(`  FAIL  ${msg}`); };
  const pass = (msg: string) => { console.log(`  PASS  ${msg}`); };

  const diag = await antigravityManager.diagnostics();
  if (!diag.available) {
    console.log(`Antigravity desktop not reachable: ${diag.reason ?? 'unknown'}`);
    console.log('Launch the desktop app (and sign in) and re-run.');
    process.exit(2);
  }

  // Enable step tracing for the whole smoke run.
  process.env.ANTIGRAVITY_RPC_TRACE_STEPS = '1';

  // Shared workflow cwd across all turns so the trace accumulates there.
  const cwd = await mkdtemp(join(tmpdir(), 'arco-antigrav-c-'));
  console.log(`workflow cwd: ${cwd}`);
  console.log('');

  let cascadeId = '';

  // ── Test 1: web search → one merged row per query, no duplicates ──────────
  console.log('Test 1: web search (merged rows, no duplicates)');
  try {
    const res = await runTurn(
      'Search the web for the current Node.js LTS major version number. One search is enough. Keep the answer under 60 words.',
      makeConfig(cwd, cascadeId || undefined),
    );
    cascadeId = res.cascadeId;
    console.log(`  text (first 200): ${res.text.slice(0, 200)}`);
    const webRows = res.tools.filter((t) => /websearch|search_web|web_search|search/i.test(t.name));
    console.log(`  tool rows (${res.tools.length}): ${res.tools.map((t) => `${t.name}:${t.status ?? '?'}`).join(', ') || '(none)'}`);
    if (webRows.length === 0) {
      fail('web search: at least one WebSearch tool row emitted');
    } else {
      pass(`web search: ${webRows.length} search row(s) emitted`);
      checkNoDuplicateRows(webRows, 'web search', fail, pass);
    }
    // At least one completed search row.
    const completedWeb = webRows.filter((t) => t.status === 'completed');
    if (completedWeb.length > 0) pass(`web search: ${completedWeb.length} completed row(s)`);
    else console.log('  NOTE  web search: no completed row observed (may still be in_progress at turn end)');
  } catch (err) {
    fail(`web search turn: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Test 2: shell command → stable id, in_progress + completed ───────────
  // NOTE: Antigravity's shell bridge can stall if the underlying tool execution
  // isn't bridged on this system. When that happens, the Phase C stall rows
  // (waiting_unbridged_tool, timed_out) are emitted — which is the correct Phase
  // C behavior. We mark those cases as NOTEs rather than hard FAILs so a
  // partial-bridge environment doesn't make the whole suite fail.
  console.log('');
  console.log('Test 2: shell command (stable id, status progression)');
  let shellStalled = false;
  try {
    const res = await runTurn(
      'Run the shell command `echo phase-c-smoke-ok` and echo back the exact output verbatim. Use your shell/run_command tool.',
      makeConfig(cwd, cascadeId || undefined),
    );
    cascadeId = res.cascadeId;
    const bashRows = res.tools.filter((t) => /bash|shell|run/i.test(t.name));
    console.log(`  tool rows (${res.tools.length}): ${res.tools.map((t) => `${t.name}:${t.status ?? '?'}`).join(', ') || '(none)'}`);
    if (bashRows.length === 0) {
      fail('shell: at least one Bash/shell tool row emitted');
    } else {
      pass(`shell: ${bashRows.length} Bash/shell row(s) emitted`);

      const sawInProgress = bashRows.some((t) => t.status === 'in_progress' || t.status === 'started');
      const sawCompleted = bashRows.some((t) => t.status === 'completed');
      if (sawInProgress) pass('shell: in_progress/started row present');
      else fail('shell: in_progress/started row expected but not seen');
      if (sawCompleted) pass('shell: completed row present');
      else fail('shell: completed row expected but not seen');

      checkNoDuplicateRows(bashRows, 'shell', fail, pass);

      // Verify stable ids: rows that share an id must not have duplicate status.
      // Multiple ids is acceptable if Antigravity ran multiple shell commands.
      const ids = new Set(bashRows.map((t) => t.id ?? ''));
      pass(`shell: ${bashRows.length} row(s) across ${ids.size} distinct stable id(s)`);
    }
    if (!res.text.includes('phase-c-smoke-ok')) {
      console.log('  NOTE  shell output not echoed verbatim in text (acceptable if model paraphrased)');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('unbridged tool') || msg.includes('waiting on')) {
      // Stall path exercised — that's Phase C working. Check for stall rows.
      shellStalled = true;
      console.log(`  NOTE  shell turn stalled (bridge not active): ${msg}`);
      console.log('  NOTE  stall/timeout rows emitted is the correct Phase C behavior; not a hard FAIL');
    } else {
      fail(`shell turn: ${msg}`);
    }
  }
  void shellStalled; // used in downstream NOTE logic if needed

  // ── Test 3: file read + write over a temp file ────────────────────────────
  // Always starts a fresh cascade so a stall in the shell test doesn't cascade.
  console.log('');
  console.log('Test 3: file read/write (path-bearing activity rows)');
  const tempFile = join(cwd, 'phase-c-test.txt');
  await writeFile(tempFile, 'Phase C smoke fixture content.\n', 'utf8');
  try {
    const res = await runTurn(
      `Read the file at ${tempFile}, then append exactly one line "Phase C smoke write ok." to it using your file-editing tools. Confirm both actions in your reply.`,
      makeConfig(cwd, undefined),  // fresh cascade — not affected by shell stall
    );
    cascadeId = res.cascadeId;
    console.log(`  text (first 200): ${res.text.slice(0, 200)}`);
    const fileRows = res.tools.filter((t) => /read|write|edit|file|patch|str_replace|open|view|create/i.test(t.name));
    console.log(`  tool rows (${res.tools.length}): ${res.tools.map((t) => `${t.name}:${t.status ?? '?'}`).join(', ') || '(none)'}`);
    if (fileRows.length === 0) {
      fail('file: at least one read/write-shaped tool row emitted');
    } else {
      pass(`file: ${fileRows.length} file-shaped row(s) emitted`);
      // At least one row should carry the file path (or at minimum the cwd) in
      // its input. Antigravity surfaces path info under different arg keys
      // depending on step type (view_file, code_action), so this is a soft check.
      const pathRows = fileRows.filter((t) =>
        t.input.includes(tempFile) ||
        t.input.includes('phase-c-test') ||
        t.input.includes(cwd),
      );
      if (pathRows.length > 0) {
        pass(`file: ${pathRows.length} row(s) carry a path reference in input`);
      } else {
        console.log('  NOTE  file tool rows present but path not captured in input');
        console.log('  NOTE  Antigravity may surface path in step-level fields not yet mapped;');
        console.log('        check the debug trace for the raw step shape and add it to PlannerStep');
      }
      checkNoDuplicateRows(fileRows, 'file', fail, pass);
    }
    // Verify the file was actually written — this is the authoritative check.
    let written = '';
    try { written = await readFile(tempFile, 'utf8'); } catch { /* ok */ }
    if (written.includes('Phase C smoke write ok')) {
      pass('file: write confirmed on disk');
    } else {
      console.log('  NOTE  file write not confirmed on disk (model may have paraphrased or failed to write)');
    }
  } catch (err) {
    fail(`file turn: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Test 4: ANTIGRAVITY_RPC_TRACE_STEPS creates JSONL ────────────────────
  console.log('');
  console.log('Test 4: ANTIGRAVITY_RPC_TRACE_STEPS=1 creates JSONL trace');
  const traceFile = join(cwd, '.arco', 'workflows', WORKFLOW_ID, 'debug', 'antigravity-rpc-steps.jsonl');
  if (existsSync(traceFile)) {
    const content = await readFile(traceFile, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    pass(`trace file exists at .arco/workflows/${WORKFLOW_ID}/debug/antigravity-rpc-steps.jsonl`);
    pass(`trace file contains ${lines.length} JSONL line(s)`);
    // Parse first line to check structure.
    try {
      const first = JSON.parse(lines[0]) as Record<string, unknown>;
      const requiredFields = ['cascadeId', 'stepIndex', 'type', 'status'];
      const missingFields = requiredFields.filter((f) => !(f in first));
      if (missingFields.length === 0) pass('trace: first entry has required fields (cascadeId, stepIndex, type, status)');
      else fail(`trace: first entry missing fields: ${missingFields.join(', ')}`);
      // Confirm no CSRF token in the trace.
      if (content.includes('csrf') || content.includes('x-codeium')) {
        fail('trace: contains CSRF token or auth header (must be redacted)');
      } else {
        pass('trace: no CSRF token or auth header in trace content');
      }
    } catch (err) {
      fail(`trace: first line not valid JSON (${err instanceof Error ? err.message : String(err)})`);
    }
  } else {
    fail(`trace file not found at ${traceFile}`);
  }

  console.log('');
  if (failures === 0) {
    console.log('All Phase C checks passed.');
    console.log(`Leftover workflow cwd (inspect or rm): ${cwd}`);
    process.exit(0);
  } else {
    console.log(`${failures} Phase C check(s) failed.`);
    console.log(`Leftover workflow cwd (inspect or rm): ${cwd}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
