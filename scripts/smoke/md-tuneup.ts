// Smoke for the agent-instruction-file tune-up primitive — see
// shared/src/protocol/mdTuneup.ts. A live tune-up spends REAL provider quota; for
// a fast, hermetic check we drive the server-side primitive directly with a
// STUBBED WorkerManager (canned output) and exercise the deterministic
// accept-path file I/O for real. Asserts the load-bearing plumbing:
//   - the agent gets READ-ONLY tools and NO Write/Edit/Bash,
//   - the notes sentinel splits file-content from operator notes,
//   - a missing sentinel ⇒ whole output is the file, notes empty,
//   - an empty proposal is refused (never propose a blank CLAUDE.md),
//   - the error path broadcasts md_tuneup_proposed with `error`, no crash,
//   - accept BACKS UP the original (verbatim) BEFORE overwriting.
//
//   npm run smoke:md-tuneup
//
// Exits 0 on all-pass, 1 on any failure.

import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, assert, assertEq, summary, type AnyMessage } from './lib.js';
import { runMdTuneup, backupAndWriteInstructionFile, discoverInstructionFiles, type MdTuneupContext } from '../../server/src/primitives/runMdTuneup.js';
import { MD_TUNEUP_NOTES_SENTINEL, splitTuneupOutput, instructionFileKind } from '../../server/src/mdTuneupPrompt.js';

interface CapturedSpawn { spec: AnyMessage; opts: AnyMessage; }

function makeStubManager(output: string, captured: CapturedSpawn[], errored = false) {
  return {
    spawn(spec: AnyMessage, onEvent: (m: AnyMessage) => void, opts: AnyMessage) {
      captured.push({ spec, opts });
      if (errored) return Promise.resolve({ id: spec.id, text: '', costUsd: 0, durationMs: 5, error: 'worker exploded' });
      onEvent({ type: 'worker_text', workerId: spec.id as string, text: output });
      return Promise.resolve({ id: spec.id, text: '', costUsd: 0, durationMs: 11 });
    },
    kill() { return false; },
  };
}

const ORIGINAL = [
  '# Project',
  '',
  '## Architecture',
  'Durable stuff worth keeping.',
  '',
  '## 2026-05-12 session log',
  'Did X, then Y, then fixed Z. Should be cut.',
  '',
].join('\n');
const TUNED = '# Project\n\n## Architecture\nDurable stuff worth keeping.\n';
const NOTES = '- Removed the 2026-05-12 session log (belongs in DEVLOG)\n- Kept the Architecture section verbatim';

async function main() {
  const cwd = mkdtempSync(join(tmpdir(), 'arco-smoke-mdtuneup-'));
  const workflowId = 'smoke-mdtuneup-wf';
  console.log(`md-tuneup smoke — cwd ${cwd}`);
  console.log('');

  await step('pure: splitTuneupOutput separates file from notes on the sentinel', async () => {
    const raw = `${TUNED}\n${MD_TUNEUP_NOTES_SENTINEL}\n${NOTES}`;
    const { fileContent, notes } = splitTuneupOutput(raw);
    assertEq(fileContent.trimEnd(), TUNED.trimEnd(), 'file content is the pre-sentinel slice');
    assertEq(notes, NOTES, 'notes are the post-sentinel slice');
  });

  await step('pure: no sentinel ⇒ whole output is the file, notes empty', async () => {
    const { fileContent, notes } = splitTuneupOutput(TUNED);
    assertEq(fileContent.trimEnd(), TUNED.trimEnd(), 'whole output treated as file');
    assertEq(notes, '', 'no notes when sentinel absent');
    assertEq(instructionFileKind('AGENTS.md'), 'Codex / GPT', 'AGENTS.md → Codex/GPT label');
  });

  writeFileSync(join(cwd, 'CLAUDE.md'), ORIGINAL, 'utf8');

  await step('happy path: proposal carries split file + notes; agent is READ-ONLY', async () => {
    const captured: CapturedSpawn[] = [];
    const broadcasts: AnyMessage[] = [];
    const ctx: MdTuneupContext = {
      workflowId, cwd,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      manager: makeStubManager(`${TUNED}\n${MD_TUNEUP_NOTES_SENTINEL}\n${NOTES}`, captured) as any,
      broadcast: (m) => { broadcasts.push(m as AnyMessage); },
    };
    const result = await runMdTuneup(ctx, {
      editor: { provider: 'claude', model: 'opus' as never, effort: 'high' as never },
      filePath: 'CLAUDE.md',
    }).settled;
    assert(!result.error, `settled without error (got: ${result.error})`);
    assertEq(result.proposed, TUNED, 'returns the tuned file content');
    assertEq(result.notes, NOTES, 'returns the operator notes');

    const started = broadcasts.find((m) => m.type === 'md_tuneup_started');
    assert(started, 'md_tuneup_started present');
    assertEq(started!.baseName, 'CLAUDE.md', 'started carries baseName');
    assert((started!.originalBytes as number) > 0, 'started reports originalBytes');

    const proposed = broadcasts.find((m) => m.type === 'md_tuneup_proposed');
    assert(proposed, 'md_tuneup_proposed present');
    assert(!proposed!.error, 'no error on happy path');
    assertEq(proposed!.proposed, TUNED, 'event carries tuned content');
    assertEq(proposed!.notes, NOTES, 'event carries notes');
    assert(!(proposed!.proposed as string).includes('session log'), 'cruft removed from proposal');
    assert((proposed!.original as string).includes('session log'), 'original preserved for the diff');

    assertEq(captured.length, 1, 'exactly one spawn');
    assertEq(captured[0].opts.sandbox, 'read-only', 'read-only sandbox');
    assertEq(captured[0].opts.outputStyle, 'normal', 'outputStyle normal');
    const tools = captured[0].spec.tools as string[];
    assert(tools.includes('Read') && tools.includes('Grep') && tools.includes('Glob'), 'read-only local tools');
    assert(!tools.includes('Write') && !tools.includes('Edit') && !tools.includes('Bash'), 'NO Write/Edit/Bash');
  });

  await step('empty proposal is refused (never propose a blank instruction file)', async () => {
    const captured: CapturedSpawn[] = [];
    const broadcasts: AnyMessage[] = [];
    const ctx: MdTuneupContext = {
      workflowId, cwd,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      manager: makeStubManager(`   \n${MD_TUNEUP_NOTES_SENTINEL}\nall gone`, captured) as any,
      broadcast: (m) => { broadcasts.push(m as AnyMessage); },
    };
    const result = await runMdTuneup(ctx, {
      editor: { provider: 'claude', model: 'opus' as never, effort: 'high' as never },
      filePath: 'CLAUDE.md',
    }).settled;
    assert(result.error, 'settled with error on empty proposal');
    const proposed = broadcasts.find((m) => m.type === 'md_tuneup_proposed');
    assert(proposed!.error, 'proposal carries the empty-file error');
  });

  await step('error path: md_tuneup_proposed carries error, no crash', async () => {
    const captured: CapturedSpawn[] = [];
    const broadcasts: AnyMessage[] = [];
    const ctx: MdTuneupContext = {
      workflowId, cwd,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      manager: makeStubManager('', captured, true) as any,
      broadcast: (m) => { broadcasts.push(m as AnyMessage); },
    };
    const result = await runMdTuneup(ctx, {
      editor: { provider: 'claude', model: 'opus' as never, effort: 'high' as never },
      filePath: 'CLAUDE.md',
    }).settled;
    assert(result.error, 'settled with worker error');
    const proposed = broadcasts.find((m) => m.type === 'md_tuneup_proposed');
    assert(proposed!.error, 'proposal carries error');
    assert((proposed!.original as string).includes('Architecture'), 'original still attached on error');
  });

  await step('accept backs up the ORIGINAL verbatim BEFORE overwriting', async () => {
    const ts = 1_700_000_000_000;
    const { backupPath, bytesWritten } = await backupAndWriteInstructionFile(cwd, 'CLAUDE.md', TUNED, ts);
    assertEq(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), TUNED, 'file now holds the tuned content');
    assertEq(readFileSync(backupPath, 'utf8'), ORIGINAL, 'backup holds the ORIGINAL verbatim');
    assert(backupPath.includes('.arco/md-backups/'), 'backup lives under .arco/md-backups/');
    assert(backupPath.endsWith('.bak'), 'backup is .bak-suffixed (no agent auto-reads it)');
    assertEq(bytesWritten, Buffer.byteLength(TUNED, 'utf8'), 'reports bytes written');
  });

  await step('accept refuses to write an empty file', async () => {
    let threw = false;
    try { await backupAndWriteInstructionFile(cwd, 'CLAUDE.md', '   ', Date.now()); }
    catch { threw = true; }
    assert(threw, 'empty proposed content rejected');
  });

  await step('path guard: a target escaping cwd is rejected', async () => {
    let threw = false;
    try { await backupAndWriteInstructionFile(cwd, '../escape.md', TUNED, Date.now()); }
    catch { threw = true; }
    assert(threw, 'escaping path rejected by resolveWithinCwd');
    // sanity: backup dir exists and only holds .bak files
    mkdirSync(join(cwd, '.arco', 'md-backups'), { recursive: true });
    const baks = readdirSync(join(cwd, '.arco', 'md-backups'));
    assert(baks.every((f) => f.endsWith('.bak')), 'backup dir holds only .bak files');
  });

  await step('discovery: finds root + nested directive files, skips heavy dirs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'arco-smoke-mdtuneup-disc-'));
    writeFileSync(join(root, 'CLAUDE.md'), '# root claude', 'utf8');
    writeFileSync(join(root, 'AGENTS.md'), '# root agents', 'utf8');
    mkdirSync(join(root, 'packages', 'api'), { recursive: true });
    writeFileSync(join(root, 'packages', 'api', 'AGENTS.md'), '# nested agents', 'utf8');
    // A heavy dir that must be skipped even though it contains a directive file.
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', 'CLAUDE.md'), '# should be ignored', 'utf8');

    const found = await discoverInstructionFiles(root);
    const paths = found.map((c) => c.path);
    assert(paths.includes('CLAUDE.md'), 'finds root CLAUDE.md');
    assert(paths.includes('AGENTS.md'), 'finds root AGENTS.md');
    assert(paths.some((p) => p.endsWith('packages/api/AGENTS.md') || p.endsWith('packages\\api\\AGENTS.md')), 'finds nested AGENTS.md');
    assert(!paths.some((p) => p.includes('node_modules')), 'skips node_modules');
    // Root files sort before nested (shallowest-first).
    assert(paths.indexOf('CLAUDE.md') < paths.findIndex((p) => p.includes('api')), 'root files listed before nested');
    assert(found.every((c) => c.bytes > 0), 'every candidate reports a byte size');
    rmSync(root, { recursive: true, force: true });
  });

  rmSync(cwd, { recursive: true, force: true });
  summary('md-tuneup');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
