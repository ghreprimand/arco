// Apply IPv4-first DNS behavior inside this server process before network
// clients are initialized. Some runtime environments have incomplete IPv6
// routing; default lookups therefore request IPv4 while explicit family
// requests remain intact. This patch affects the server process only, not
// separately spawned CLI processes.

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
