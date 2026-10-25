// Linux-specific helper: given a root PID, walk its descendant tree and
// return every TCP port that any process in the family is listening on.
//
// Used by previewAutoDetect.ts to deterministically attribute a dev-server
// port to the Bash bg call that started it — solves the cross-workflow race
// where two `npm run dev` invocations would otherwise grab each other's
// ports via candidate-list probing.
//
// How it works:
//   1. Walk descendants via snapshotDescendantPids.
//   2. For each PID (root + descendants) read /proc/<pid>/fd/* symlinks. A
//      socket fd's link target looks like `socket:[<inode>]`.
//   3. Parse /proc/net/tcp + /proc/net/tcp6 (system-wide listing of all TCP
//      sockets). Filter by state == 0A (LISTEN) and inode in the family's
//      socket-inode set.
//   4. Decode local_address column — last 4 hex digits after `:` are the
//      port (network byte order is already accounted for in the kernel's
//      hex rendering).
//
// Linux-only. Returns an empty array on non-Linux or when /proc is missing.
// macOS path would use `lsof -p <pid> -i -P -n` — left unimplemented (the reference
// workstation is Linux; macOS support is portability work).

import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { snapshotDescendantPids } from './processActivity.js';

const TCP_LISTEN_HEX = '0A';

async function socketInodesForPid(pid: number): Promise<string[]> {
  const dir = `/proc/${pid}/fd`;
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  // Bound the fd scan: a runaway process with hundreds of thousands of fds
  // would otherwise stall the probe. Dev servers in practice keep well under
  // a few hundred; if we hit the cap we miss new ports for one tick and
  // catch them on the next.
  const MAX_FDS = 4096;
  let scanned = 0;
  for (const entry of entries) {
    if (scanned++ >= MAX_FDS) break;
    try {
      const link = await fs.readlink(`${dir}/${entry}`);
      const m = link.match(/^socket:\[(\d+)\]$/);
      if (m) out.push(m[1]);
    } catch {
      // fd closed between readdir and readlink — race, ignore.
    }
  }
  return out;
}

async function parseListeningPorts(file: string, inodes: Set<string>): Promise<number[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return [];
  }
  const ports = new Set<number>();
  const lines = raw.split('\n');
  // First line is the header. Each subsequent non-empty line:
  //   sl  local_address  rem_address  st  tx_queue:rx_queue  tr:tm->when  retrnsmt  uid  timeout  inode
  // local_address is "<ip-hex>:<port-hex>" — port is what we want, in big-endian hex.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 10) continue;
    if (fields[3] !== TCP_LISTEN_HEX) continue;
    const inode = fields[9];
    if (!inodes.has(inode)) continue;
    const local = fields[1];
    const colon = local.lastIndexOf(':');
    if (colon < 0) continue;
    const portHex = local.slice(colon + 1);
    const port = parseInt(portHex, 16);
    if (Number.isFinite(port) && port > 0 && port < 65536) ports.add(port);
  }
  return Array.from(ports);
}

// Return every TCP port in LISTEN state owned by `rootPid` or any of its
// descendants. Empty array on non-Linux or when the root pid is gone.
export async function listeningPortsForPidFamily(rootPid: number): Promise<number[]> {
  if (!existsSync('/proc')) return [];
  if (!existsSync(`/proc/${rootPid}`)) return [];

  const descendants = await snapshotDescendantPids(rootPid);
  const allPids = [rootPid, ...descendants];

  const inodes = new Set<string>();
  for (const pid of allPids) {
    const pidInodes = await socketInodesForPid(pid);
    for (const ino of pidInodes) inodes.add(ino);
  }
  if (inodes.size === 0) return [];

  const v4 = await parseListeningPorts('/proc/net/tcp', inodes);
  const v6 = await parseListeningPorts('/proc/net/tcp6', inodes);
  const merged = new Set<number>([...v4, ...v6]);
  return Array.from(merged);
}
