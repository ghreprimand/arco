// First-class Chat mode protocol smoke. No model turn is dispatched, so this
// is safe against the live service and spends no provider quota.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, step, assert, assertEq, summary } from './lib.js';

async function main() {
  const c = await connect();
  const smokeWsUrl = process.env.ARCHON_SMOKE_WS_URL || 'ws://localhost:3001/ws';
  const smokeHttpBase = smokeWsUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:').replace(/\/ws$/, '');
  let workflowId = '';
  let storageCwd = '';
  let incognitoWorkflowId = '';

  await step('reject unsupported Gemini Chat create', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        kind: 'chat', name: 'Unsupported chat', primaryProvider: 'gemini',
        primaryModel: 'gemini-test', primaryEffort: 'medium',
        skipPermissions: false, workingDirectory: '',
      },
    });
    const msg = await c.waitFor((m) => m.type === 'error' && String(m.message).includes('not available in Chat mode'), 3000, 'unsupported-provider error');
    assert(String(msg.message).includes('gemini'), 'error identifies Gemini');
  });

  await step('reject non-private Incognito providers and provider-session resume', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        kind: 'chat', incognito: true, name: 'Unsupported incognito', primaryProvider: 'cursor',
        primaryModel: 'auto', primaryEffort: 'medium', skipPermissions: false, workingDirectory: '',
      },
    });
    await c.waitFor((m) => m.type === 'error' && String(m.message).includes('non-persistent CLI session'), 3000, 'Cursor incognito rejection');
    c.send({
      type: 'create_workflow',
      config: {
        kind: 'chat', incognito: true, name: 'Logged daemon incognito', primaryProvider: 'llamacpp',
        primaryModel: 'unused-smoke-model', primaryEffort: 'medium', skipPermissions: false, workingDirectory: '',
      },
    });
    await c.waitFor((m) => m.type === 'error' && String(m.message).includes('non-persistent CLI session'), 3000, 'llama.cpp incognito rejection');
    c.send({
      type: 'create_workflow',
      config: {
        kind: 'chat', incognito: true, name: 'Resume incognito', primaryProvider: 'claude',
        primaryModel: 'opus', primaryEffort: 'medium', skipPermissions: false, workingDirectory: '',
        resumeSessionId: 'aaaaaaaa-1234-1234-1234-123456789abc',
      },
    });
    await c.waitFor((m) => m.type === 'error' && String(m.message).includes('cannot resume'), 3000, 'incognito resume rejection');
  });

  await step('create projectless Chat with server-owned storage cwd', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        kind: 'chat', name: 'Chat smoke', primaryProvider: 'claude',
        primaryModel: 'opus', primaryEffort: 'medium',
        skipPermissions: true, workingDirectory: '/must/not/be-used',
      },
    });
    const msg = await c.waitFor((m) => m.type === 'workflow_created', 5000, 'workflow_created');
    workflowId = String(msg.workflowId);
    const config = msg.config as { kind?: string; workingDirectory?: string; skipPermissions?: boolean };
    storageCwd = String(config.workingDirectory);
    assertEq(config.kind, 'chat', 'kind echoed');
    assertEq(config.skipPermissions, false, 'AUTO permissions cannot leak into Chat');
    assertEq(storageCwd, join(homedir(), '.archon', 'chats', workflowId), 'server replaces caller cwd');
  });

  await step('persist Chat kind in meta.json', () => {
    const meta = JSON.parse(readFileSync(join(storageCwd, '.archon', 'workflows', workflowId, 'meta.json'), 'utf8')) as { kind?: string; cwd?: string };
    assertEq(meta.kind, 'chat', 'meta kind');
    assertEq(meta.cwd, storageCwd, 'meta cwd');
  });

  await step('persist the Chat web-access toggle', async () => {
    // Default is armed for a saved Chat (chatWebArmed), so the meaningful
    // assertion is that turning it OFF survives to disk — an absent field
    // would read as "armed" on rehydrate.
    c.send({ type: 'update_primary_config', workflowId, chatWebAccess: false });
    const metaPath = join(storageCwd, '.archon', 'workflows', workflowId, 'meta.json');
    let persisted: boolean | undefined;
    for (let i = 0; i < 20 && persisted !== false; i++) {
      await new Promise((r) => setTimeout(r, 100));
      persisted = (JSON.parse(readFileSync(metaPath, 'utf8')) as { chatWebAccess?: boolean }).chatWebAccess;
    }
    assertEq(persisted, false, 'chatWebAccess:false written to meta.json');
    c.send({ type: 'update_primary_config', workflowId, chatWebAccess: true });
  });

  await step('list saved Chat for reopening', async () => {
    const res = await fetch(`${smokeHttpBase}/api/chats`);
    const body = await res.json() as { chats?: Array<{ workflowId: string; config: { resumeWorkflowId?: string } }> };
    const saved = body.chats?.find((chat) => chat.workflowId === workflowId);
    assert(Boolean(saved), 'new Chat appears in Past Chats');
    assertEq(saved?.config.resumeWorkflowId, workflowId, 'reopen config targets original workflow');
  });

  await step('create Incognito Chat without Arco disk state', async () => {
    c.send({
      type: 'create_workflow',
      config: {
        kind: 'chat', incognito: true, name: 'Incognito smoke', primaryProvider: 'ollama',
        primaryModel: 'unused-smoke-model', primaryEffort: 'medium',
        skipPermissions: false, workingDirectory: '/must/not/be-used',
      },
    });
    const msg = await c.waitFor((m) => m.type === 'workflow_created' && (m.config as { incognito?: boolean }).incognito === true, 5000, 'incognito workflow_created');
    incognitoWorkflowId = String(msg.workflowId);
    assertEq((msg.config as { workingDirectory?: string }).workingDirectory, tmpdir(), 'incognito uses no per-chat cwd');
    assertEq(existsSync(join(tmpdir(), '.archon', 'workflows', incognitoWorkflowId)), false, 'no Arco workflow directory created');
  });

  await step('strict Incognito rejects disk-capable workbench surfaces', async () => {
    c.send({ type: 'update_primary_config', workflowId: incognitoWorkflowId, remoteEnabled: true });
    const configError = await c.waitFor(
      (m) => m.type === 'error' && m.workflowId === incognitoWorkflowId && String(m.message).includes('strict Incognito Chat'),
      3000,
      'incognito protocol fence',
    );
    assert(String(configError.message).includes('unavailable'), 'config mutation was rejected');
    c.send({
      type: 'user_message', workflowId: incognitoWorkflowId, content: 'must not dispatch',
      attachments: ['/tmp/private-attachment.txt'], clientMessageId: 'private-attachment-smoke',
    });
    await c.waitFor(
      (m) => m.type === 'error' && m.workflowId === incognitoWorkflowId && String(m.message).includes('Attachments'),
      3000,
      'incognito attachment fence',
    );
  });

  await step('strict Incognito still allows the three memory-only config edits', async () => {
    // The fence rejects config surfaces because they are how a stale client
    // would make an incognito chat touch disk or the hub. Model, effort and
    // chatWebAccess do neither — they only choose what the next turn spawns —
    // so an incognito chat can still swap model and arm web search.
    c.send({ type: 'update_primary_config', workflowId: incognitoWorkflowId, chatWebAccess: true, model: 'opus', effort: 'high' });
    await new Promise((r) => setTimeout(r, 400));
    const rejected = c.peekMessages().some(
      (m) => m.type === 'error' && m.workflowId === incognitoWorkflowId && String(m.message).includes('strict Incognito Chat'),
    );
    assertEq(rejected, false, 'model / effort / web edit accepted in incognito');
    assertEq(existsSync(join(tmpdir(), '.archon', 'workflows', incognitoWorkflowId)), false, 'still no Arco workflow directory');
  });

  await step('teardown', async () => {
    c.send({ type: 'remove_workflow', workflowId });
    c.send({ type: 'remove_workflow', workflowId: incognitoWorkflowId });
    await c.close();
    const expectedRoot = join(homedir(), '.archon', 'chats', workflowId);
    assertEq(storageCwd, expectedRoot, 'cleanup target remains exact');
    rmSync(expectedRoot, { recursive: true, force: true });
  });

  summary('Chat mode smoke');
}

main().catch((err) => {
  console.error('Chat mode smoke crashed:', err);
  process.exit(2);
});
