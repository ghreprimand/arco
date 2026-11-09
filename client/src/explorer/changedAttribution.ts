import type { RecentRecord } from './types';

function pathKey(path: string): string {
  // Keep UNC, Windows drive and POSIX identities in separate namespaces.
  // POSIX case and backslashes are significant.
  if (/^[\\/]{2}/.test(path)) {
    const body = path.slice(2).replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
    return `unc://${body}`;
  }
  if (/^[a-z]:[\\/]/i.test(path)) {
    return `drive:${path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase()}`;
  }
  return `posix:${path}`;
}

export function changedAttribution(path: string, mtime: number, records: RecentRecord[]): string | undefined {
  const key = pathKey(path);
  let newest: RecentRecord | undefined;
  for (const record of records) {
    if (pathKey(record.path) === key && (!newest || record.ts > newest.ts)) newest = record;
  }
  return newest && newest.ts >= mtime - 2000 ? `${newest.tabTitle} · ${newest.provider}` : undefined;
}
