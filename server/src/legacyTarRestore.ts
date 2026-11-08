import { constants, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, lstat, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openCheckedFile } from './checkedFile.js';
import { assertSpellingSafe, safeDirectory } from './fileAccessPolicy.js';
import { managedPath } from './managedPath.js';

const MAX_ARCHIVE = 512 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const MAX_METADATA = 64 * 1024;
const bad = () => new Error('Legacy checkpoint contains an unsafe or unsupported archive entry');
function text(bytes: Buffer): string { return bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)).toString('utf8'); }
function octal(bytes: Buffer): number {
  const value = text(bytes).trim();
  if (value && !/^[0-7]+$/.test(value)) throw bad();
  const number = value ? Number.parseInt(value, 8) : 0;
  if (!Number.isSafeInteger(number) || number < 0) throw bad();
  return number;
}
function relativeName(raw: string): string {
  const name = raw.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (!name || name === '.') return '';
  if (name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw bad();
  const parts = name.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || ['.git', '.arco'].includes(p.toLowerCase()))) throw bad();
  // Apply the portable Windows name restrictions even while unpacking on
  // another platform: a checkpoint must not introduce stream/device names.
  if (parts.some(p => /[. ]$/.test(p) || p.includes(':'))) throw bad();
  return name;
}
function pax(bytes: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (let at = 0; at < bytes.length;) {
    const space = bytes.indexOf(32, at);
    if (space < at) throw bad();
    const lengthText = bytes.subarray(at, space).toString('ascii');
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw bad();
    const length = Number(lengthText), end = at + length;
    if (!Number.isSafeInteger(length) || end > bytes.length || end <= space + 2 || bytes[end - 1] !== 10) throw bad();
    const record = bytes.subarray(space + 1, end - 1).toString('utf8'), equals = record.indexOf('=');
    if (equals < 1) throw bad();
    const key = record.slice(0, equals), value = record.slice(equals + 1);
    if (key === 'linkpath' || key === 'size' || key.toLowerCase().includes('sparse')) throw bad();
    if (key === 'path') out.path = value;
    else if (!['mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname', 'comment', 'charset'].includes(key)) throw bad();
    at = end;
  }
  return out;
}

// Legacy archives are read into a private staging tree, never extracted by a
// shell command into the project. Every entry and destination is checked before
// the first project write. Links and special files are refused as a whole.
export async function restoreLegacyTar(archive: string, cwd: string): Promise<number> {
  const project = safeDirectory(cwd);
  const archivePath = path.join(realpathSync(path.dirname(archive)), path.basename(archive));
  const input = await openCheckedFile(archivePath);
  let stage = '';
  try {
    const info = await input.stat();
    if (info.size > MAX_ARCHIVE || info.size % 512 !== 0) throw bad();
    stage = await mkdtemp(path.join(realpathSync(tmpdir()), 'arco-legacy-restore-'));
    const entries: Array<{ name: string; directory: boolean; mode: number }> = [];
    const seen = new Set<string>();
    let position = 0, ended = false, nextPath: string | undefined;
    async function read(size: number): Promise<Buffer> {
      if (position + size > info.size) throw bad();
      const buffer = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const result = await input.read(buffer, offset, size - offset, position + offset);
        if (!result.bytesRead) throw bad();
        offset += result.bytesRead;
      }
      position += size;
      return buffer;
    }
    while (position < info.size) {
      const header = await read(512);
      if (header.every(byte => byte === 0)) { ended = true; continue; }
      if (ended) throw bad();
      const storedChecksum = octal(header.subarray(148, 156));
      const checksum = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
      if (storedChecksum !== checksum) throw bad();
      const size = octal(header.subarray(124, 136));
      if (size > MAX_ARCHIVE || position + Math.ceil(size / 512) * 512 > info.size) throw bad();
      const type = header[156] ? String.fromCharCode(header[156]) : '0';
      if (['x', 'g', 'L'].includes(type)) {
        if (size > MAX_METADATA) throw bad();
        const data = await read(size);
        if (type === 'L') nextPath = text(data);
        else {
          const attributes = pax(data);
          if (type === 'g' && attributes.path !== undefined) throw bad();
          if (attributes.path !== undefined) nextPath = attributes.path;
        }
        await read((512 - size % 512) % 512);
        continue;
      }
      if (type !== '0' && type !== '5') throw bad();
      const prefix = text(header.subarray(345, 500));
      const name = relativeName(nextPath ?? [prefix, text(header.subarray(0, 100))].filter(Boolean).join('/'));
      nextPath = undefined;
      if (!name && type !== '5') throw bad();
      if (type === '5' && size !== 0) throw bad();
      if (!name) continue;
      if (seen.has(name) || entries.length >= MAX_ENTRIES) throw bad();
      seen.add(name);
      const destination = managedPath(stage, ...name.split('/'));
      assertSpellingSafe(path.join(project, ...name.split('/')));
      const mode = octal(header.subarray(100, 108)) & 0o777;
      entries.push({ name, directory: type === '5', mode });
      if (type === '5') await mkdir(destination, { recursive: true, mode: 0o700 });
      else {
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        const output = await openCheckedFile(destination, 'create');
        try {
          let remaining = size;
          while (remaining) { const count = Math.min(64 * 1024, remaining); await output.writeFile(await read(count)); remaining -= count; }
        } finally { await output.close(); }
        await read((512 - size % 512) % 512);
      }
    }
    if (!ended || nextPath !== undefined) throw bad();
    // Preflight ALL existing destination components before changing any file.
    for (const entry of entries) {
      const destination = managedPath(project, ...entry.name.split('/'));
      try {
        const current = await lstat(destination);
        if (entry.directory ? !current.isDirectory() : !current.isFile()) throw bad();
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const directories: Array<{ destination: string; mode: number; dev: number; ino: number }> = [];
    let files = 0;
    for (const entry of entries) {
      const destination = managedPath(project, ...entry.name.split('/'));
      if (entry.directory) {
        await mkdir(destination, { recursive: true, mode: 0o700 });
        const info = await lstat(destination);
        if (!info.isDirectory() || info.isSymbolicLink()) throw bad();
        directories.push({ destination, mode: entry.mode, dev: info.dev, ino: info.ino });
        continue;
      }
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      const source = await openCheckedFile(managedPath(stage, ...entry.name.split('/')));
      let output: Awaited<ReturnType<typeof openCheckedFile>> | undefined;
      try {
        output = await openCheckedFile(destination, 'replace', entry.mode);
        await output.truncate(0);
        const buffer = Buffer.alloc(64 * 1024);
        for (;;) { const { bytesRead } = await source.read(buffer, 0, buffer.length, null); if (!bytesRead) break; await output.writeFile(buffer.subarray(0, bytesRead)); }
        await output.chmod(entry.mode);
      } finally { await source.close(); await output?.close(); }
      files++;
    }
    // Populate first, then restore directory modes from the leaves upward.
    // Keep new parents private during extraction and retain traversal until
    // every child is complete. Windows does not implement POSIX directory modes.
    if (process.platform !== 'win32') {
      directories.sort((a, b) => b.destination.split(path.sep).length - a.destination.split(path.sep).length);
      for (const directory of directories) {
        const target = managedPath(project, path.relative(project, directory.destination));
        const handle = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const opened = await handle.stat(), current = await lstat(target);
          if (!opened.isDirectory() || current.isSymbolicLink() || !current.isDirectory()
            || opened.dev !== directory.dev || opened.ino !== directory.ino
            || opened.dev !== current.dev || opened.ino !== current.ino
            || realpathSync(target) !== target) throw bad();
          await handle.chmod(directory.mode);
        } finally { await handle.close(); }
      }
    }
    return files;
  } finally { await input.close(); if (stage) await rm(stage, { recursive: true, force: true }); }
}
