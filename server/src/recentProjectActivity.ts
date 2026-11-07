import { readdir, realpath, stat } from 'fs/promises';
import path from 'path';
import { readMeta, WFID_PATTERN } from './workflowMeta.js';

type CachedMeta = { signature: string; lastActiveAt: number | undefined };
const MAX_METADATA_ENTRIES = 20000;

// Reuse unchanged metadata, but retry every failed read on the next request.
export class RecentProjectActivityCache {
  private readonly entries = new Map<string, CachedMeta>();
  private readonly pending = new Map<string, Promise<number>>();

  constructor(private readonly load: (cwd: string, workflowId: string) => Promise<{ lastActiveAt?: number } | null> = readMeta) {}

  async get(cwd: string): Promise<number> {
    const key = await realpath(cwd).catch(() => path.resolve(cwd));
    const existing = this.pending.get(key);
    if (existing) return existing;
    const work = this.read(key);
    this.pending.set(key, work);
    try { return await work; }
    finally { if (this.pending.get(key) === work) this.pending.delete(key); }
  }

  private async read(cwd: string): Promise<number> {
    const folder = path.join(cwd, '.arco', 'workflows');
    let names: string[];
    try { names = (await readdir(folder)).filter(name => WFID_PATTERN.test(name)); }
    catch { return 0; }
    const values = await Promise.all(names.map(async name => {
      const key = `${cwd}\0${name}`;
      try {
        const info = await stat(path.join(folder, name, 'meta.json'), { bigint: true });
        const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
        const prior = this.entries.get(key);
        if (prior?.signature === signature) return prior;
        const meta = await this.load(cwd, name);
        if (!meta) { this.entries.delete(key); return null; }
        const entry = { signature, lastActiveAt: meta.lastActiveAt };
        this.entries.delete(key);
        this.entries.set(key, entry);
        if (this.entries.size > MAX_METADATA_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
        return entry;
      } catch {
        this.entries.delete(key);
        return null;
      }
    }));
    const present = values.filter((entry): entry is CachedMeta => entry !== null);
    // Match the history reader's stable ordering for legacy metadata too.
    present.sort((a, b) => (b.lastActiveAt as number) - (a.lastActiveAt as number));
    return present[0]?.lastActiveAt ?? 0;
  }
}

export const recentProjectActivity = new RecentProjectActivityCache();
