import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Private parent for Unix sockets, with room for the nested bridge names. */
export async function makeWorkerSocketDirectory(prefix: string): Promise<string> {
  if (!/^[a-z0-9-]{1,40}$/.test(prefix)) throw new Error('Invalid worker socket prefix.');
  let base = await realpath(tmpdir());
  const longest = join(base, `${prefix}XXXXXX`, 'worker-mail-XXXXXX', 'mail.sock');
  if (process.platform === 'linux' && Buffer.byteLength(longest) > 107) base = await realpath('/tmp');
  if (Buffer.byteLength(join(base, `${prefix}XXXXXX`, 'worker-mail-XXXXXX', 'mail.sock')) > 107) throw new Error('No short temporary path is available for the worker socket.');
  return mkdtemp(join(base, prefix));
}
