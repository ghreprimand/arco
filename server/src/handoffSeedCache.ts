export function isHandoffSeed(content: string): boolean {
 return content.startsWith('[HANDOFF: new session initialized for this tab.')
  || content.startsWith('[HANDOFF \u2014 new session initialized for this tab.')
  || content.includes('\n\n---\n\nNew direction: ')
  || content.includes('\n\n---\n\nRead the handoff above. Acknowledge with "READY"');
}
// Cached only for a live workflow object. Durable events remain authoritative on
// first access after restart/reopen; writing a new seed invalidates the entry.
const cache = new Map<string, { owner: object; value: Promise<string | undefined> }>();
const key = (cwd: string, id: string) => JSON.stringify([cwd, id]);
export function invalidateHandoffSeed(cwd: string, id: string): void {
 cache.delete(key(cwd, id));
}
export function cachedHandoffSeed(cwd: string, id: string, owner: object, scan: () => Promise<string | undefined>): Promise<string | undefined> {
 const k = key(cwd, id), old = cache.get(k);
 if (old?.owner === owner) return old.value;
 if (cache.size >= 1024) cache.delete(cache.keys().next().value!);
 const value = scan();
 cache.set(k, { owner, value });
 void value.catch(() => { if (cache.get(k)?.value === value) cache.delete(k); });
 return value;
}
