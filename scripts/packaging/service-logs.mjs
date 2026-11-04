// Raw stdout/stderr capture for the windowless Windows service, and the tail
// readers behind `arco service logs`. The structured log (arco.log) is written
// by the server; these files catch what happens before it starts and anything
// that writes straight to the streams, so nothing depends on a console window.
import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const SERVICE_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const SERVICE_STDIO_FILES = { stdout: 'service.stdout.log', stderr: 'service.stderr.log' };

function open(file, max) {
  let size = 0;
  try { size = statSync(file).size; } catch { /* new file */ }
  if (size >= max) { try { rmSync(`${file}.1`, { force: true }); renameSync(file, `${file}.1`); size = 0; } catch { /* keep appending */ } }
  return { fd: openSync(file, 'a', 0o600), size };
}

// Sends everything written to process.stdout / process.stderr to size-bounded
// files in `dir` (one rotated copy kept). Returns a function that restores the
// streams. Write failures never throw into the server.
export function redirectServiceStdio(dir, { max = SERVICE_LOG_MAX_BYTES, streams = process } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const restore = [];
  for (const [name, fileName] of Object.entries(SERVICE_STDIO_FILES)) {
    const file = join(dir, fileName);
    let state = open(file, max);
    const stream = streams[name], original = stream.write;
    stream.write = (chunk, encoding, callback) => {
      const cb = typeof encoding === 'function' ? encoding : callback;
      try {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
        if (state.size + data.length > max) { closeSync(state.fd); state = open(file, 0); }
        writeSync(state.fd, data); state.size += data.length;
      } catch { /* logging must not stop the service */ }
      if (cb) cb();
      return true;
    };
    restore.push(() => { stream.write = original; try { closeSync(state.fd); } catch { /* already closed */ } });
  }
  return () => restore.forEach((fn) => fn());
}

export function tailText(file, { bytes = 128 * 1024, lines = 200 } = {}) {
  if (!existsSync(file)) return null;
  const size = statSync(file).size, length = Math.min(size, bytes), buffer = Buffer.alloc(length), fd = openSync(file, 'r');
  try { readSync(fd, buffer, 0, length, size - length); } finally { closeSync(fd); }
  return buffer.toString('utf8').split('\n').slice(-lines).join('\n');
}

// What `arco service logs` prints: the structured log, plus on Windows the raw
// stdout/stderr files when they hold anything.
export function serviceLogReport(logDir, platform = process.platform) {
  const parts = [];
  const main = tailText(join(logDir, 'arco.log'));
  if (main !== null) parts.push(platform === 'win32' ? `== arco.log ==\n${main}` : main);
  if (platform === 'win32') {
    for (const fileName of Object.values(SERVICE_STDIO_FILES)) {
      const text = tailText(join(logDir, fileName));
      if (text && text.trim()) parts.push(`== ${fileName} ==\n${text}`);
    }
  }
  return parts.length ? parts.join('\n') : 'No service log file is available.';
}
