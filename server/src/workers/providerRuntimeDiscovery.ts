import { access, lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';

type CliProvider = 'claude' | 'codex' | 'cursor';
type RuntimeMount = { source: string; target: string };
export interface ProviderRuntime {
  executable: string;
  argsPrefix: string[];
  mounts: RuntimeMount[];
}
const MAX_FILES = 1024;
const MAX_ENTRIES = 4096;
const MAX_PATH_BYTES = 256 * 1024;
const RUNTIME_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.json', '.node', '.wasm', '.scm']);
const RUNTIME_JSON = new Set(['package.json', 'codex-package.json', 'grammar.json', 'node-types.json', 'manifest.json', 'runtime.json', 'sources.json']);

async function packageName(path: string): Promise<string> {
  const metadata = join(path, 'package.json');
  const entry = await lstat(metadata);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.size > 64 * 1024) throw new Error('Unrecognized provider runtime.');
  const handle = await open(metadata, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size > 64 * 1024) throw new Error('Unrecognized provider runtime.');
    const parsed = JSON.parse(await handle.readFile('utf8')) as { name?: unknown };
    if (typeof parsed.name !== 'string') throw new Error('Unrecognized provider runtime.');
    return parsed.name;
  } finally { await handle.close(); }
}

async function isElf(path: string): Promise<boolean> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const bytes = Buffer.alloc(4);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    return read.bytesRead === 4 && bytes.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } finally { await handle.close(); }
}

async function runtimeFiles(root: string, targetRoot: string): Promise<RuntimeMount[]> {
  const files: RuntimeMount[] = [];
  let pathBytes = 0;
  let entries = 0;
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 12) throw new Error('Provider runtime nesting exceeds the safe limit.');
    for await (const entry of await opendir(directory)) {
      if (++entries > MAX_ENTRIES) throw new Error('Provider runtime contains too many entries.');
      if (entry.name.startsWith('.')) continue;
      if (!/^[a-zA-Z0-9._@+-]+$/.test(entry.name) || entry.isSymbolicLink()) throw new Error('Provider runtime has an unsupported entry.');
      const source = join(directory, entry.name);
      if (entry.isDirectory()) { await visit(source, depth + 1); continue; }
      if (!entry.isFile()) throw new Error('Provider runtime has an unsupported entry.');
      const metadata = await lstat(source);
      if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error('Provider runtime changed during discovery.');
      const name = basename(source);
      if (extname(name) === '.json' && !RUNTIME_JSON.has(name)) throw new Error('Provider runtime contains unrecognized JSON state.');
      const executable = (metadata.mode & 0o111) !== 0 && !extname(name);
      if (!executable && !RUNTIME_EXTENSIONS.has(extname(name)) && !/\.so(?:\.\d+)+$/.test(name)) continue;
      const part = relative(root, source);
      if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new Error('Provider runtime escaped its root.');
      const target = `${targetRoot}/${part.split(sep).join('/')}`;
      pathBytes += Buffer.byteLength(source) + Buffer.byteLength(target);
      if (files.length >= MAX_FILES || pathBytes > MAX_PATH_BYTES) throw new Error('Provider runtime exceeds the safe mount limit.');
      files.push({ source, target });
    }
  }
  await visit(root, 0);
  return files.sort((a, b) => a.target.localeCompare(b.target));
}

/** Resolve only recognized Linux CLI layouts; unknown installations fail closed. */
export async function discoverProviderRuntime(provider: CliProvider, binary: string): Promise<ProviderRuntime> {
  if (process.platform !== 'linux' || !isAbsolute(binary)) throw new Error('Provider runtime discovery is unavailable.');
  const executable = await realpath(binary);
  const entry = await stat(executable);
  if (!entry.isFile()) throw new Error('Provider executable must be a file.');
  await access(executable, constants.X_OK);
  if (provider === 'claude' && await isElf(executable)) {
    const target = '/opt/arco-runtime/claude';
    return { executable: target, argsPrefix: [], mounts: [{ source: executable, target }] };
  }
  if (provider === 'codex' && basename(executable) === 'codex.js' && basename(dirname(executable)) === 'bin') {
    const root = dirname(dirname(executable));
    if (await packageName(root) !== '@openai/codex' || !process.execPath.startsWith('/usr/')) throw new Error('Unrecognized Codex runtime.');
    const target = '/opt/arco-runtime/codex';
    const mounts = await runtimeFiles(root, target);
    if (!mounts.some((mount) => mount.target === `${target}/bin/codex.js`)) throw new Error('Codex runtime is incomplete.');
    return { executable: process.execPath, argsPrefix: [`${target}/bin/codex.js`], mounts };
  }
  if (provider === 'cursor' && basename(executable) === 'cursor-agent') {
    const root = dirname(executable);
    if (await packageName(root) !== '@anysphere/agent-cli-runtime') throw new Error('Unrecognized Cursor runtime.');
    const target = '/opt/arco-runtime/cursor';
    const mounts = await runtimeFiles(root, target);
    for (const required of ['cursor-agent', 'node', 'index.js']) {
      if (!mounts.some((mount) => mount.target === `${target}/${required}`)) throw new Error('Cursor runtime is incomplete.');
    }
    return { executable: `${target}/cursor-agent`, argsPrefix: [], mounts };
  }
  throw new Error('This provider installation does not have a recognized isolated runtime.');
}
