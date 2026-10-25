// Force every outbound connection in this process onto IPv4. Imported for its
// side effect as the very first line of server/src/index.ts so it runs before
// any module can open a socket.
//
// WHY (2026-06-05 incident): this box has working IPv4 egress but no usable IPv6
// route. api.anthropic.com publishes AAAA records, so Node resolved an IPv6
// address, tried to connect, and got `connect ENETUNREACH 2607:6bc0::10:443`.
// That rejection escaped getUsage() (one unguarded `fetch`) and — with no global
// unhandledRejection handler at the time — exited the process. systemd restarted
// it, the client immediately re-polled /api/usage, and it crash-looped 6× in 60s
// into StartLimitBurst → a permanent `failed` / "SERVER DOWN" the RE-PROBE button
// could not recover. usage.ts now degrades gracefully and index.ts has a global
// safety net, but the operator's standing rule is "no IPv6 in any way shape or
// form" — so we remove the failure mode at the source.
//
// `--dns-result-order=ipv4first` (set in the systemd unit) only *orders* results;
// Happy Eyeballs can still open a v6 socket. The hard block is to force the dns
// resolution family to 4, so AAAA records are never returned to anything. Every
// outbound path — net.connect, node:http(s), and undici (global `fetch`) — routes
// through dns.lookup, so this one patch covers them all. Literal IPv4 addresses
// (the tailnet 100.x hub, 127.0.0.1 local services) still resolve fine under
// family 4; nothing in Arco dials an IPv6-only host.
//
// NB: this patches THIS process only. Spawned provider CLIs (claude/codex/gemini)
// are separate Node processes — they inherit the unit's NODE_OPTIONS=ipv4first
// instead. Keep both.
import dns from 'node:dns';

// Belt-and-suspenders for any code that resolves addresses directly rather than
// via the connect path below.
dns.setDefaultResultOrder('ipv4first');

const originalLookup = dns.lookup;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(dns as any).lookup = function forcedIpv4Lookup(hostname: any, options: any, callback?: any) {
  // dns.lookup(hostname[, options], callback): options may be omitted, a number
  // (family), or an options object. Normalize all three, then pin family to 4.
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const opts = typeof options === 'number' ? { family: options } : { ...(options ?? {}) };
  // family 0/undefined means "either" — force IPv4. An explicit `family: 6` is
  // left intact so a future deliberate IPv6 call isn't silently broken; nothing
  // in Arco asks for one today.
  if (!opts.family) opts.family = 4;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (originalLookup as any).call(dns, hostname, opts, callback);
};
