import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeProjectDir } from '../http/fileRead.js';
import { discoverTerminalSessions, sameTerminalProject } from './terminalSessions.js';
import { TERMINAL_CODEX_ACCOUNT } from '@arco/shared';
import { resolveProviderAccount } from '../providerAccounts.js';
import { extractSessionName, extractCodexSessionInfo } from './sessionDiscovery.js';
import { findCodexRolloutPath } from './transcripts.js';
import { resolveSessionJsonlPath } from '../sessionJsonl.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
test('terminal discovery is project-scoped, bounded, read-only and invalidates its mtime cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arco-terminal-fixture-'));
  const cwd = join(root, 'project'), claude = join(root, 'claude'), codex = join(root, 'codex');
  const project = join(claude, 'projects', encodeProjectDir(cwd));
  const day = join(codex, 'sessions', '2020', '01', '01');
  try {
    await mkdir(project, { recursive: true }); await mkdir(day, { recursive: true });
    for (let n = 1; n <= 52; n++) {
      const file = join(project, `${id(n)}.jsonl`);
      await writeFile(file, JSON.stringify({type:'user',message:{content:`Question ${n}`}}) + '\n');
      await utimes(file, n, n);
    }
    const codexFile = join(day, `rollout-2020-${id(60)}.jsonl`);
    await writeFile(codexFile, JSON.stringify({type:'session_meta',payload:{id:id(60),cwd}}) + '\n' + JSON.stringify({type:'event_msg',payload:{type:'user_message',message:'Terminal question'}}) + '\n');
    const wrong = join(day, `rollout-2020-${id(61)}.jsonl`);
    await writeFile(wrong, JSON.stringify({type:'session_meta',payload:{id:id(61),cwd:join(root,'other')}}) + '\n');
    const priorClaude = process.env.CLAUDE_CONFIG_DIR, priorCodex = process.env.CODEX_HOME;
    try {
      process.env.CLAUDE_CONFIG_DIR = claude; process.env.CODEX_HOME = codex;
      assert.equal(resolveSessionJsonlPath(cwd, id(52)), join(project, `${id(52)}.jsonl`));
      assert.equal(await findCodexRolloutPath(id(60)), codexFile);
    } finally {
      if (priorClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = priorClaude;
      if (priorCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = priorCodex;
    }
    const opts = { claude, codex };
    const first = await discoverTerminalSessions(cwd, opts);
    assert.equal(first.filter(s => s.provider === 'claude').length, 50);
    assert.ok(!first.some(s => s.sessionId === id(1) || s.sessionId === id(2) || s.sessionId === id(61)));
    assert.equal(first.find(s => s.sessionId === id(60))?.name, 'Terminal question');
    await writeFile(codexFile, JSON.stringify({type:'session_meta',payload:{id:id(60),cwd}}) + '\n' + JSON.stringify({type:'event_msg',payload:{type:'user_message',message:'Updated question'}}) + '\n');
    await utimes(codexFile, 1900000000, 1900000000);
    assert.equal((await discoverTerminalSessions(cwd, opts)).find(s => s.sessionId === id(60))?.name, 'Updated question');
    const giant = join(project, `${id(99)}.jsonl`);
    await writeFile(giant, '{}\n' + 'x'.repeat(150_000) + '\n' + JSON.stringify({type:'ai-title',aiTitle:'Tail title'}) + '\n');
    assert.equal((await discoverTerminalSessions(cwd, opts)).find(s => s.sessionId === id(99))?.name, 'Tail title');
    assert.equal((await extractSessionName(giant)).name, 'Tail title');
    assert.equal((await extractCodexSessionInfo(codexFile, cwd))?.name, 'Updated question');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('terminal Codex sessions use the ambient home even if other profiles exist', async () => {
  assert.equal(await resolveProviderAccount('codex', TERMINAL_CODEX_ACCOUNT), null);
});
test('terminal project matching respects Windows case and path separators', () => {
  assert.equal(sameTerminalProject('C:\\Work\\Example', 'c:/work/example/'), true);
  assert.equal(sameTerminalProject('C:\\Work\\Other', 'c:/work/example'), false);
  assert.equal(sameTerminalProject('/a/Project', '/a/project'), false);
});
