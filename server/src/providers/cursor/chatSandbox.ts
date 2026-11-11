import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { arcoHome } from '../../arcoHome.js';
import { ensureStorageRoot } from '../../storageRoot.js';
import { commandArgs } from '../../windowsCommand.js';
import type { PreparedAttachments } from '../providerFileContent.js';

export const CHAT_DENY = ['Read(**)', 'Read(/**)', 'Write(**)', 'Write(/**)', 'Shell(*)', 'WebFetch(*)', 'Mcp(*:*)'];
// An empty tool allowlist also removes directory listing (which does not use
// Cursor's Read permission check), subagents, browser and future tool families.
// Read/MCP denies remain in force even when a server was previously approved.
export const CHAT_FLAGS = ['--allowed-tools', '', '--disable-indexing', '--disable-codebase-ref'];
export const CHAT_GUIDANCE = 'This is a Chat tab. Only the text and attachments in this message are available. Do not read computer files, follow local paths or links, or call tools. If an attached image is unavailable, say "Cursor Chat could not receive this image. Please use another provider." Never try Read or another tool to recover it.';

function accepts(args: string[], cwd: string, signal?: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    const [command, argv] = commandArgs('cursor-agent', [...args, '--arco-chat-capability-probe', 'help']);
    execFile(command, argv, { cwd, timeout: 10_000, maxBuffer: 128 * 1024, windowsHide: true, signal }, (error, _stdout, stderr) => resolve(error?.code === 1 && stderr.trim() === "error: unknown option '--arco-chat-capability-probe'"));
  });
}

export async function createChatSandbox(prepared?: PreparedAttachments, signal?: AbortSignal) {
  const root = await ensureStorageRoot(join(arcoHome(), 'cursor-chat-turns'));
  const cwd = await mkdtemp(join(root, 'turn-'));
  const close = () => rm(cwd, { recursive: true, force: true });
  try {
    signal?.throwIfAborted();
    const configDir = join(cwd, '.cursor');
    await mkdir(configDir, { mode: 0o700 });
    await writeFile(join(configDir, 'cli.json'), JSON.stringify({ permissions: { allow: [], deny: CHAT_DENY } }), { flag: 'wx', mode: 0o600 });
    if (!await accepts(CHAT_FLAGS, cwd, signal)) throw new Error('Cursor Chat is unavailable: update Cursor to a version that supports attachment-only Chat.');
    signal?.throwIfAborted();
    const imagePaths: string[] = [];
    if (prepared?.images.length) {
      // Probe the parser only: a deliberate unknown option must be the first
      // error. `help` is a second safeguard against starting a model session.
      // --help alone is unsuitable: Cursor ignores unknown flags with it.
      // Unsupported image inputs fail closed and never become Read path refs.
      if (!await accepts([...CHAT_FLAGS, '--image', join(cwd, 'probe.png')], cwd, signal)) throw new Error('Cursor Chat cannot send images with this Cursor version. Please use another provider.');
      signal?.throwIfAborted();
      for (const [index, image] of prepared.images.entries()) {
        const path = join(cwd, `attachment-${index + 1}.${image.mediaType === 'image/jpeg' ? 'jpg' : 'png'}`);
        await writeFile(path, Buffer.from(image.data, 'base64'), { flag: 'wx', mode: 0o600 });
        imagePaths.push(path);
      }
    }
    signal?.throwIfAborted();
    return { cwd, imagePaths, close };
  } catch (error) { await close(); throw error; }
}

// Startup only, before listening or restoring workflows. Never sweep during a
// live turn. fs.rm unlinks symlinks rather than traversing their targets.
export async function cleanupChatSandboxes(): Promise<void> {
  let root: string;
  try { root = await ensureStorageRoot(join(arcoHome(), 'cursor-chat-turns'), false); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.name.startsWith('turn-')) continue;
    if (entry.isDirectory() || entry.isSymbolicLink()) await rm(join(root, entry.name), { recursive: true, force: true });
  }
}

export async function cleanupChatSandboxesOnStartup(): Promise<void> {
  try { await cleanupChatSandboxes(); }
  catch { console.warn('[arco] Could not remove abandoned Cursor Chat attachments. Startup will continue.'); }
}
