import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { checkRequestOrigin } from './originGuard.js';

function address(value: string): string {
  return value.trim().replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '').toLowerCase();
}

function trustedProxy(req: IncomingMessage): boolean {
  const peer = address(req.socket?.remoteAddress ?? '');
  if (peer === '::1' || (isIP(peer) === 4 && peer.startsWith('127.'))) return true;
  return (process.env.ARCO_TRUSTED_PROXIES ?? '').split(',').map(address)
    .some(candidate => isIP(candidate) !== 0 && candidate === peer);
}

// Forwarded protocol alone is not TLS proof. Minting behind a proxy also
// requires a trusted peer and an approved HTTPS browser authority.
export function sessionUsesHttps(req?: IncomingMessage): boolean {
  if (!req) return false;
  if ((req.socket as { encrypted?: boolean } | undefined)?.encrypted === true) return true;
  if (req.headers['x-forwarded-proto'] !== 'https' || !req.headers.host || !trustedProxy(req)) return false;
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  try {
    return new URL(origin).protocol === 'https:' && checkRequestOrigin(req).ok;
  } catch { return false; }
}
