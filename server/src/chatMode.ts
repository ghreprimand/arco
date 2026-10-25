import { homedir, tmpdir } from 'os';
import { promises as fs, mkdtempSync, rmSync } from 'fs';
import path from 'path';
import type { ProviderName, SavedChatSummary, WorkflowConfig } from '@arco/shared';
import { readMeta, workflowConfigFromMeta } from './workflowMeta.js';
import { arcoHome } from './arcoHome.js';

export const CHAT_PROVIDERS = new Set<ProviderName>([
  'claude', 'codex', 'zai', 'cursor', 'ollama', 'llamacpp', 'lmstudio', 'strata', 'deepseek',
]);

// Cursor's CLI has no ephemeral-session switch. llama.cpp is served by a
// shared Arco-managed daemon whose stdout/stderr always lands in
// ~/.arco/llamacpp.log. Neither can meet strict incognito's zero-Arco-log
// contract. Strata also has standalone request logs and an image cache.
// Reject these rather than show a misleading privacy label.
export const INCOGNITO_CHAT_PROVIDERS = new Set<ProviderName>([
  'claude', 'codex', 'zai', 'ollama', 'lmstudio',
]);

// Providers whose Chat transport can honor the web-access toggle. Claude and
// Codex use their provider web surfaces; Ollama gets only Arco's local
// SearXNG-backed WebSearch/WebFetch pair, also used by Strata. Other
// transports stay offline and the UI says so.
export const CHAT_WEB_PROVIDERS = new Set<ProviderName>(['claude', 'codex', 'ollama', 'strata', 'deepseek']);

// Is web access armed for this chat? Absent `chatWebAccess` means armed for a
// saved Chat and disarmed for an Incognito one: a search query leaves the
// machine, so incognito makes the operator opt in explicitly. Agent tabs never
// reach here — they carry the full toolset already.
export function chatWebArmed(
  config: Pick<WorkflowConfig, 'kind' | 'incognito' | 'chatWebAccess'>,
  provider: ProviderName,
): boolean {
  if (!isChatWorkflow(config)) return false;
  if (!CHAT_WEB_PROVIDERS.has(provider)) return false;
  if (typeof config.chatWebAccess === 'boolean') return config.chatWebAccess;
  return config.incognito !== true;
}

const CHAT_PROMPT_BASE = [
  'You are in Arco Chat, a general-purpose conversation with the operator.',
  'Respond naturally, directly, and conversationally. Match the level of detail the operator wants.',
].join(' ');

const CHAT_PROMPT_OFFLINE = [
  'This chat has no attached project workspace. Do not use backend tools or claim to inspect files, run commands, browse, or change the machine.',
  'When outside information or project context is required, say what is missing and ask the operator to provide it or continue in an Agent tab.',
].join(' ');

const CHAT_PROMPT_WEB = [
  'This chat has no attached project workspace: no file access, no shell, no machine changes.',
  'You DO have web search and web fetch. Use them whenever the answer depends on current or external information instead of telling the operator to move to an Agent tab.',
  'When project context is required, say what is missing and ask the operator to provide it or continue in an Agent tab.',
].join(' ');

// The offline prompt is the default so a caller that never learned about the
// web toggle keeps the original boundary text verbatim.
export const CHAT_SYSTEM_PROMPT = `${CHAT_PROMPT_BASE} ${CHAT_PROMPT_OFFLINE}`;

export function chatSystemPrompt(webArmed: boolean): string {
  return webArmed ? `${CHAT_PROMPT_BASE} ${CHAT_PROMPT_WEB}` : CHAT_SYSTEM_PROMPT;
}

export function isChatWorkflow(config: Pick<WorkflowConfig, 'kind'>): boolean {
  return config.kind === 'chat';
}

export function chatStorageDir(workflowId: string): string {
  return path.join(chatRootDir(), workflowId);
}

// Incognito Chat's process cwd. Providers need an existing directory, and it
// must never be a persistence cwd. It used to be the bare os.tmpdir() — shared
// and world-writable, so any local user's /tmp/CLAUDE.md, /tmp/AGENTS.md or
// /tmp/.claude/settings.json was picked up by the provider CLI as project
// instructions/settings for a "private" chat. mkdtemp gives a 0700 dir only
// this uid can populate; one per server process (created lazily, removed on
// exit). Arco itself writes nothing into it. A rehydrated incognito tab
// re-assigns it (handoffHandlers enforceIncognitoOnRehydrate), so a stale
// path from a previous process never survives a restart.
let incognitoCwd: string | null = null;

export function incognitoChatCwd(): string {
  if (incognitoCwd) return incognitoCwd;
  const dir = mkdtempSync(path.join(tmpdir(), 'arco-incognito-'));
  incognitoCwd = dir;
  process.once('exit', () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
  return dir;
}

export function chatRootDir(): string {
  return path.join(arcoHome(), 'chats');
}

export async function listSavedChats(root = chatRootDir()): Promise<SavedChatSummary[]> {
  const names = await fs.readdir(root).catch(() => []);
  const chats: SavedChatSummary[] = [];
  for (const workflowId of names) {
    const cwd = path.join(root, workflowId);
    const meta = await readMeta(cwd, workflowId).catch(() => null);
    if (!meta || meta.kind !== 'chat') continue;
    chats.push({
      workflowId,
      name: meta.name,
      createdAt: meta.createdAt,
      lastActiveAt: meta.lastActiveAt,
      primaryProvider: meta.primaryProvider,
      primaryModel: meta.primaryModel,
      primaryEffort: meta.primaryEffort,
      ...(meta.lastUserPreview ? { lastUserPreview: meta.lastUserPreview } : {}),
      config: {
        ...workflowConfigFromMeta(meta, cwd),
        kind: 'chat',
        skipPermissions: false,
        resumeWorkflowId: workflowId,
      },
    });
  }
  return chats.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}
