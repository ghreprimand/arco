import type { RecentRecord } from './types';

function pathKey(path: string): string {
  // Windows paths are case-insensitive and accept both separators. Preserve
  // case and backslashes in POSIX paths, where they can be significant.
  if (/^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\')) {
    return path.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
  }
  return path.replace(/\/{2,}/g, '/');
}

export function changedAttribution(path: string, mtime: number, records: RecentRecord[]): string | undefined {
  const key = pathKey(path);
  let newest: RecentRecord | undefined;
  for (const record of records) {
    if (pathKey(record.path) === key && (!newest || record.ts > newest.ts)) newest = record;
  }
  return newest && newest.ts >= mtime - 2000 ? `${newest.tabTitle} · ${newest.provider}` : undefined;
}
