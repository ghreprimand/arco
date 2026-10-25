// System-wide listening-port enumeration. Used by the PREVIEW tab's
// "service no longer running" modal to show the operator what IS currently
// listening so they can pick one to rebind to.
//
// Distinct from procListening.ts (which scopes to a single process tree —
// used by the auto-detect path to attribute a port to a specific Bash bg).
// Here we want everything regardless of who started it, minus our own
// Arco server's PID so we don't list the proxy itself as a candidate.
//
// Linux-only via /proc. macOS would need an `lsof -iTCP -sTCP:LISTEN -P -n`
// path; not implemented because the operator's box is Linux. Returns [] on non-Linux,
// which makes the modal degrade gracefully (the "no longer running" message
// still shows but the picker is empty).

import { promises as fs } from 'fs';
import { existsSync } from 'fs';

const TCP_LISTEN_HEX = '0A';

export interface ListeningEntry {
  port: number;
  pid: number;
  command: string;
}

// Parse /proc/net/tcp{,6} once into a Map<inode, port>. Cheaper than the
// procListening.ts approach when we want every listener: instead of walking
// every PID's fd dir to build an inode set first, we walk /proc once and
// then ask "does this inode belong to anyone?" by reverse-walking PIDs.
async function inodeToPortMap(file: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return out;
  }
  const lines = raw.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 10) continue;
    if (fields[3] !== TCP_LISTEN_HEX) continue;
    const inode = fields[9];
    const local = fields[1];
    const colon = local.lastIndexOf(':');
    if (colon < 0) continue;
    const portHex = local.slice(colon + 1);
    const port = parseInt(portHex, 16);
    if (Number.isFinite(port) && port > 0 && port < 65536) out.set(inode, port);
  }
  return out;
}

// Read /proc/<pid>/comm — the kernel-truncated 15-char process name. cmdline
// would give the full argv but it's null-separated and often empty for
// kernel threads or processes with mangled cmdline; comm is reliable. Good
// enough for a "what's this?" hint in the picker.
async function commForPid(pid: number): Promise<string> {
  try {
    const raw = await fs.readFile(`/proc/${pid}/comm`, 'utf8');
    return raw.trim();
  } catch {
    return '';
  }
}

// Find which PID owns a listening socket inode by scanning every /proc/<pid>/fd.
// Stops early once a match is found (a listening socket has exactly one
// owning process). Could be made faster with a per-pid socket-inode cache,
// but the picker is invoked on a click — single-shot — so a 50ms scan is fine.
async function findOwnerPids(inodes: Set<string>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (inodes.size === 0) return out;
  const entries = await fs.readdir('/proc').catch(() => [] as string[]);
  for (const entry of entries) {
    if (out.size === inodes.size) break;
    if (!/^\d+$/.test(entry)) continue;
    const pid = parseInt(entry, 10);
    let fdEntries: string[];
    try {
      fdEntries = await fs.readdir(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fdEntries) {
      try {
        const link = await fs.readlink(`/proc/${pid}/fd/${fd}`);
        const m = link.match(/^socket:\[(\d+)\]$/);
        if (!m) continue;
        const inode = m[1];
        if (inodes.has(inode) && !out.has(inode)) {
          out.set(inode, pid);
        }
      } catch {
        // fd closed between readdir and readlink — race, ignore.
      }
    }
  }
  return out;
}

export async function listAllListeningProcesses(excludePid?: number): Promise<ListeningEntry[]> {
  if (!existsSync('/proc')) return [];

  const v4 = await inodeToPortMap('/proc/net/tcp');
  const v6 = await inodeToPortMap('/proc/net/tcp6');
  // Merge — same inode on v4 and v6 (dual-stack listener) collapses to one
  // entry, which is what we want.
  const inodeToPort = new Map<string, number>();
  for (const [k, v] of v4) inodeToPort.set(k, v);
  for (const [k, v] of v6) if (!inodeToPort.has(k)) inodeToPort.set(k, v);

  if (inodeToPort.size === 0) return [];

  const inodeOwner = await findOwnerPids(new Set(inodeToPort.keys()));

  // Group by port — a single port has one listening socket so this is
  // mostly 1:1, but if two processes ever share an inode (SO_REUSEPORT
  // edge case, fork-without-exec) we'd dedupe to the first PID seen.
  const seenPorts = new Set<number>();
  const out: ListeningEntry[] = [];
  for (const [inode, port] of inodeToPort) {
    if (seenPorts.has(port)) continue;
    const pid = inodeOwner.get(inode);
    if (pid === undefined) continue;
    if (excludePid !== undefined && pid === excludePid) continue;
    seenPorts.add(port);
    const command = await commForPid(pid);
    out.push({ port, pid, command });
  }
  out.sort((a, b) => a.port - b.port);
  return out;
}
