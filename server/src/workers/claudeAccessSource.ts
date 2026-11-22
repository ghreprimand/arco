import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Read the normal CLI sign-in for trusted server use; never return errors containing its contents. */
export async function readClaudeAccessSource(): Promise<unknown> {
  const root = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  let handle;
  try {
    handle = await open(join(root, '.credentials.json'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 65536 || (process.getuid && metadata.uid !== process.getuid())) throw new Error();
    const bytes = Buffer.alloc(65537);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 65536) throw new Error();
    return JSON.parse(bytes.toString('utf8', 0, bytesRead)) as unknown;
  } catch { throw new Error('Claude sign-in needs renewing.'); }
  finally { await handle?.close(); }
}
