import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAT_PROVIDERS, CHAT_SYSTEM_PROMPT, CHAT_WEB_PROVIDERS, INCOGNITO_CHAT_PROVIDERS, chatStorageDir, chatSystemPrompt, chatWebArmed, incognitoChatCwd, isChatWorkflow, listSavedChats } from './chatMode.js';
import { workflowConfigFromMeta, type WorkflowMeta } from './workflowMeta.js';
import { ClaudeProvider } from './providers/claude.js';
import { CodexProvider } from './providers/codex.js';
import { ollamaChatWebReminder, ollamaToolCallAllowed, ollamaToolCandidates, ollamaToolsAutoExecute } from './providers/ollama.js';
import { createProviderProcess } from './providers/index.js';
import { registerPrivateLogToken, shouldSuppressOperationalLog, withoutOperationalLogging } from './server/logger.js';

test('chat support excludes Gemini and Antigravity', () => {
  assert.equal(CHAT_PROVIDERS.has('gemini'), false);
  assert.equal(CHAT_PROVIDERS.has('antigravity'), false);
  for (const provider of ['claude', 'codex', 'zai', 'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata'] as const) {
    assert.equal(CHAT_PROVIDERS.has(provider), true, provider);
  }
  assert.equal(INCOGNITO_CHAT_PROVIDERS.has('strata'), false);
  assert.equal(INCOGNITO_CHAT_PROVIDERS.has('cursor'), false);
  assert.equal(INCOGNITO_CHAT_PROVIDERS.has('llamacpp'), false);
  for (const provider of ['claude', 'codex', 'zai', 'ollama', 'lmstudio'] as const) {
    assert.equal(INCOGNITO_CHAT_PROVIDERS.has(provider), true, `incognito ${provider}`);
  }
});

test('chat web access defaults on for saved chats, off for incognito and tool-less providers', () => {
  const saved = { kind: 'chat' as const };
  assert.equal(chatWebArmed(saved, 'claude'), true);
  assert.equal(chatWebArmed(saved, 'codex'), true);
  assert.equal(chatWebArmed(saved, 'ollama'), true);
  assert.equal(chatWebArmed(saved, 'strata'), true);
  // No web tool we can arm on these transports — never claim otherwise.
  for (const provider of ['zai', 'cursor', 'llamacpp', 'lmstudio'] as const) {
    assert.equal(chatWebArmed(saved, provider), false, provider);
    assert.equal(CHAT_WEB_PROVIDERS.has(provider), false, provider);
  }
  // A search query leaves the machine, so incognito opts in explicitly.
  assert.equal(chatWebArmed({ kind: 'chat', incognito: true }, 'claude'), false);
  assert.equal(chatWebArmed({ kind: 'chat', incognito: true, chatWebAccess: true }, 'claude'), true);
  assert.equal(chatWebArmed({ kind: 'chat', chatWebAccess: false }, 'claude'), false);
  // Agent tabs never route through the chat web gate.
  assert.equal(chatWebArmed({ chatWebAccess: true }, 'claude'), false);
  // The prompt has to match the armed toolset or the model refuses lookups it
  // can actually do (2026-09-10: "Not in this Chat tab — I don't have web access here").
  assert.match(chatSystemPrompt(true), /web search and web fetch/i);
  assert.equal(chatSystemPrompt(false), CHAT_SYSTEM_PROMPT);
  assert.match(CHAT_SYSTEM_PROMPT, /Do not use backend tools/);
});

test('Ollama Chat gets only the armed web pair and executes it without Agent AUTO', () => {
  const base = {
    cwd: '/tmp/archon-chat-test', interactionMode: 'chat' as const,
    skipPermissions: false,
  };
  assert.equal(ollamaToolCandidates({ ...base, chatWebAccess: false }), undefined);
  const armed = ollamaToolCandidates({ ...base, chatWebAccess: true });
  assert.deepEqual(armed?.map((tool) => tool.function.name), ['WebSearch', 'WebFetch']);
  assert.equal(ollamaToolsAutoExecute({ ...base, chatWebAccess: true }), true);
  assert.equal(ollamaToolsAutoExecute({ ...base, chatWebAccess: false }), false);
  assert.equal(ollamaToolsAutoExecute({ ...base, interactionMode: 'agent', chatWebAccess: true }), false);
  assert.equal(ollamaToolCallAllowed({ ...base, chatWebAccess: true }, 'WebSearch'), true);
  assert.equal(ollamaToolCallAllowed({ ...base, chatWebAccess: true }, 'WebFetch'), true);
  assert.equal(ollamaToolCallAllowed({ ...base, chatWebAccess: true }, 'Bash'), false);
  assert.equal(ollamaToolCallAllowed({ ...base, chatWebAccess: true }, 'Read'), false);
  assert.equal(ollamaToolCallAllowed({ ...base, chatWebAccess: false }, 'WebSearch'), false);
  assert.match(ollamaChatWebReminder({ ...base, chatWebAccess: true }), /earlier message or reasoning.+obsolete/i);
  assert.equal(ollamaChatWebReminder({ ...base, chatWebAccess: false }), '');
});

test('chat web arming reaches each provider transport as an explicit flag', () => {
  const base = { model: 'test-model', effort: 'medium' as const, interactionMode: 'chat' as const, cwd: '/tmp/archon-chat-test' };
  const armed = ClaudeProvider.create('chat-claude-web', { ...base, provider: 'claude', chatWebAccess: true }) as unknown as { buildArgs(): string[] };
  const armedArgs = armed.buildArgs();
  assert.equal(armedArgs[armedArgs.indexOf('--tools') + 1], 'WebSearch,WebFetch');

  const codexArmed = CodexProvider.create('chat-codex-web', { ...base, provider: 'codex', sandbox: 'read-only', chatWebAccess: true }) as unknown as { buildArgs(): string[] };
  assert.equal(codexArmed.buildArgs().includes('web_search="live"'), true);
  const codexOff = CodexProvider.create('chat-codex-nb', { ...base, provider: 'codex', sandbox: 'read-only' }) as unknown as { buildArgs(): string[] };
  assert.equal(codexOff.buildArgs().includes('web_search="disabled"'), true);
});

test('strict incognito suppresses async operational logs and delayed id-bearing logs', async () => {
  assert.equal(shouldSuppressOperationalLog('ordinary log'), false);
  await withoutOperationalLogging(async () => {
    await Promise.resolve();
    assert.equal(shouldSuppressOperationalLog('provider emitted a generic error'), true);
  });
  registerPrivateLogToken('12345678-private-workflow');
  assert.equal(shouldSuppressOperationalLog('[archon] 12345678-private-workflow settled'), true);
  assert.equal(shouldSuppressOperationalLog('[archon] 12345678 removed'), true);
});

test('chat storage is isolated from a project and mode survives meta rehydrate', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const cwd = chatStorageDir(id);
  assert.match(cwd, /\.archon[\\/]chats[\\/]12345678-/);
  const meta: WorkflowMeta = {
    workflowId: id, name: 'Chat', cwd, kind: 'chat', createdAt: 1, lastActiveAt: 1,
    primaryProvider: 'ollama', primaryModel: 'local', primaryEffort: 'medium',
    cliSessions: [], operator: 'local', lastEventSeq: null, lastTranscriptSeq: null, compactedAt: null,
  };
  const config = workflowConfigFromMeta(meta, cwd);
  assert.equal(config.kind, 'chat');
  assert.equal(isChatWorkflow(config), true);
  assert.match(CHAT_SYSTEM_PROMPT, /no attached project workspace/i);
});

test('CLI chat workers keep the no-project boundary in their argv', () => {
  const base = { model: 'test-model', effort: 'medium' as const, interactionMode: 'chat' as const, cwd: '/tmp/archon-chat-test' };
  const claude = ClaudeProvider.create('chat-claude', { ...base, provider: 'claude' }) as unknown as { buildArgs(): string[] };
  const claudeArgs = claude.buildArgs();
  const toolsAt = claudeArgs.indexOf('--tools');
  assert.notEqual(toolsAt, -1);
  assert.equal(claudeArgs[toolsAt + 1], '');
  assert.equal(claudeArgs.includes('--strict-mcp-config'), true);

  const codex = CodexProvider.create('chat-codex', { ...base, provider: 'codex', sandbox: 'read-only' }) as unknown as { buildArgs(): string[] };
  const codexArgs = codex.buildArgs();
  assert.deepEqual(codexArgs.slice(codexArgs.indexOf('-s'), codexArgs.indexOf('-s') + 2), ['-s', 'read-only']);
  assert.equal(codexArgs.includes('--ignore-user-config'), true);
  assert.equal(codexArgs.includes('--ignore-rules'), true);
  assert.equal(codexArgs.some((arg) => arg.includes('mcp_servers.')), false);

  const cursor = createProviderProcess('chat-cursor', { ...base, provider: 'cursor', sandbox: 'read-only' });
  assert.equal(cursor.constructor.name, 'CursorPrintProcess');
});

test('incognito CLI workers disable provider session persistence', () => {
  const base = {
    model: 'test-model', effort: 'medium' as const, interactionMode: 'chat' as const,
    incognito: true, cwd: '/tmp', systemPrompt: 'private-system-marker',
    appendSystemPrompt: 'private-history-marker',
  };
  const claude = ClaudeProvider.create('incognito-claude', { ...base, provider: 'claude' }) as unknown as { buildArgs(): string[] };
  const claudeArgs = claude.buildArgs();
  assert.equal(claudeArgs.includes('--no-session-persistence'), true);
  assert.equal(claudeArgs.includes('--session-id'), false);
  assert.equal(claudeArgs.includes('--resume'), false);
  assert.equal(claudeArgs.includes('--system-prompt'), false);
  assert.equal(claudeArgs.some((arg) => arg.includes('private-system-marker') || arg.includes('private-history-marker')), false);

  const codex = CodexProvider.create('incognito-codex', { ...base, provider: 'codex', sandbox: 'read-only' }) as unknown as { buildArgs(): string[] };
  const codexArgs = codex.buildArgs();
  assert.equal(codexArgs.includes('--ephemeral'), true);
  assert.equal(codexArgs[1], '--json');
  assert.equal(codexArgs.includes('resume'), false);
});

test('saved Chat index reconstructs reopen config and ignores non-Chat meta', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archon-chat-index-'));
  const chatId = 'aaaaaaaa-1234-1234-1234-123456789abc';
  const workflowId = 'bbbbbbbb-1234-1234-1234-123456789abc';
  try {
    const chatCwd = join(root, chatId);
    const workflowCwd = join(root, workflowId);
    await mkdir(join(chatCwd, '.archon', 'workflows', chatId), { recursive: true });
    await mkdir(join(workflowCwd, '.archon', 'workflows', workflowId), { recursive: true });
    const baseMeta = {
      name: 'Saved chat', createdAt: 1, lastActiveAt: 2,
      primaryProvider: 'codex', primaryModel: 'gpt-test', primaryEffort: 'high',
      codexTransport: 'exec', cliSessions: [], operator: 'local',
      lastEventSeq: null, lastTranscriptSeq: null, compactedAt: null,
    };
    await writeFile(join(chatCwd, '.archon', 'workflows', chatId, 'meta.json'), JSON.stringify({ ...baseMeta, workflowId: chatId, cwd: chatCwd, kind: 'chat' }));
    await writeFile(join(workflowCwd, '.archon', 'workflows', workflowId, 'meta.json'), JSON.stringify({ ...baseMeta, workflowId, cwd: workflowCwd }));

    const chats = await listSavedChats(root);
    assert.equal(chats.length, 1);
    assert.equal(chats[0].workflowId, chatId);
    assert.equal(chats[0].config.kind, 'chat');
    assert.equal(chats[0].config.resumeWorkflowId, chatId);
    assert.equal(chats[0].config.workingDirectory, chatCwd);
    assert.equal(chats[0].config.codexTransport, 'exec');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('incognito cwd is a private per-process dir, not the shared temp root', async () => {
  const dir = incognitoChatCwd();
  assert.notEqual(dir, tmpdir());
  assert.equal(incognitoChatCwd(), dir, 'one dir per server process');
  const st = await stat(dir);
  assert.ok(st.isDirectory());
  // World-writable /tmp let another user plant CLAUDE.md / AGENTS.md /
  // .claude/settings.json that provider CLIs loaded for a "private" chat.
  assert.equal(st.mode & 0o777, 0o700);
  assert.deepEqual(await readdir(dir), [], 'Arco writes nothing into it');
});
